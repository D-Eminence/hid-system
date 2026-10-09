import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { platformAuditActor } from '../../admin/admin-context';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { PlatformAccessContext } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import type { LoginResult } from '../auth.types';
import { LocalAuthProvider } from '../local-auth.provider';
import { readPlatformAssurance, requirePlatformAssurance } from '../platform-assurance';
import { consumeRateLimit, rateLimitBlocked, type RateLimitWindow } from '../rate-limit';
import { TokenService, type SessionEventMetadata, type SessionEventType } from '../token.service';
import { MfaSecretProtector } from './mfa-secret-protector';
import {
  base32Encode, generateRecoveryCode, matchTotp, normalizeRecoveryCode, otpauthUri,
  RECOVERY_CODE_COUNT, TOTP_DIGITS, TOTP_PERIOD_SECONDS, TOTP_SECRET_BYTES,
} from './totp';

/**
 * Clock for TOTP time steps only (challenge and rate-limit windows use the
 * real clock). Production provides none; runtime verifiers supply one so they
 * can exercise many single-use time steps without waiting 30 seconds each.
 */
export const MFA_TOTP_CLOCK = Symbol('MFA_TOTP_CLOCK');

export type PlatformChallengePurpose = 'verify' | 'enroll';

export interface PlatformLoginChallenge {
  purpose: PlatformChallengePurpose;
  token: string;
  expiresAt: Date;
}

interface ChallengeRow {
  id: string;
  account_id: string;
  subject: string;
  email: string | null;
  failed_attempts: number;
  max_attempts: number;
  expires_at: Date;
}

interface FactorRow {
  id: string;
  secret_ciphertext: Buffer;
  secret_key_version: string;
  last_used_step: string | null;
}

/** The fifth failed second-factor attempt within 15 minutes blocks the account for 15 minutes. */
const FAILURE_PER_ACCOUNT: RateLimitWindow = { windowSeconds: 900, maxRequests: 4 };
const FAILURE_PER_IP: RateLimitWindow = { windowSeconds: 900, maxRequests: 19 };
/** Enrollment starts and recovery-code regenerations: five per 15 minutes. */
const REQUESTS_PER_ACCOUNT: RateLimitWindow = { windowSeconds: 900, maxRequests: 5 };
const CHALLENGE_TTL_SECONDS: Record<PlatformChallengePurpose, number> = { verify: 300, enroll: 600 };
const CHALLENGE_MAX_ATTEMPTS = 5;
const TOTP_ISSUER = 'HID Platform Admin';

type Failure = { kind: 'invalid' } | { kind: 'rate_limited' } | { kind: 'failed' };

/**
 * Platform administrator MFA (Phase 4 Stage 2A). TOTP (RFC 6238) and one-time
 * recovery codes are the only accepted second factors; email OTP is not one.
 * Every verification serializes on the factor row and accepts a time step
 * only once. Secrets never leave this service except once, at enrollment.
 *
 * Lock order (Stage 7A): every transaction here locks the account row
 * (auth.lock_account_for_mfa, 0076) before any other row lock or write; then
 * the challenge (sign-in, enrolment) or the session assurance (step-up), the
 * factor and the recovery codes; then it writes sessions and events. An
 * approved MFA reset (0070) locks the account before the factor, and every
 * session revocation (0073) locks it before the sessions, both FOR UPDATE. A
 * flow that locked the factor first and then reached the account through the
 * FOR KEY SHARE of its session event, session or recovery code insert could
 * deadlock with them. The lock is FOR KEY SHARE: it conflicts with theirs, but
 * not with a refresh rotation or a staff sign-in of the account.
 */
@Injectable()
export class MfaService {
  private readonly environment = getEnvironment();

  constructor(
    private readonly database: DatabaseService,
    private readonly protector: MfaSecretProtector,
    private readonly tokens: TokenService,
    private readonly localProvider: LocalAuthProvider,
    private readonly audit: AuditService,
    @Optional() @Inject(MFA_TOTP_CLOCK) private readonly totpClock?: () => number,
  ) {}

  /**
   * Password step of platform sign-in. A valid password for an account with
   * platform.admin.access yields a short-lived challenge, never a session.
   */
  async beginLogin(principal: string, password: string, event: SessionEventMetadata): Promise<PlatformLoginChallenge> {
    this.protector.assertConfigured();
    const identity = await this.localProvider.authenticate(principal, password, 'staff', event.correlationId);
    if (!identity.accountId) throw new UnauthorizedException('Invalid credentials');
    const token = randomBytes(32).toString('base64url');
    const result = await this.database.withSystemTransaction(event.correlationId, async (client) => {
      await this.lockAccount(client, identity.accountId!);
      const account = (await client.query<{ eligible: boolean; enrolled: boolean; token_version: string; subject: string }>(
        `select auth.account_has_platform_permission(account.id, 'platform.admin.access') as eligible,
                auth.account_has_active_mfa(account.id) as enrolled,
                account.token_version::text, account.subject
           from auth.accounts account
          where account.id = $1 and account.status = 'active'
            and (account.disabled_until is null or account.disabled_until <= clock_timestamp())`,
        [identity.accountId],
      )).rows[0];
      // Not an administrator: the same answer as a wrong password.
      if (!account?.eligible) return null;
      if (identity.passwordUpgrade) {
        const upgraded = await client.query<{ upgraded: boolean }>(
          'select auth.upgrade_legacy_password($1, $2, $3, $4) as upgraded',
          [identity.accountId, identity.subject, identity.passwordUpgrade.expectedRowVersion, identity.passwordUpgrade.hash],
        );
        if (upgraded.rows[0]?.upgraded !== true) return null;
      }
      await client.query('delete from auth.login_attempts where principal_hmac = $1 and pepper_version = $2',
        [this.localProvider.principalHash(principal), this.environment.AUTH_LOGIN_PEPPER_VERSION]);
      const purpose: PlatformChallengePurpose = account.enrolled ? 'verify' : 'enroll';
      await client.query(
        `update auth.mfa_login_challenges set invalidated_at = clock_timestamp(),
            invalidation_reason = 'superseded', row_version = row_version + 1
          where account_id = $1 and consumed_at is null and invalidated_at is null`,
        [identity.accountId],
      );
      const inserted = await client.query<{ expires_at: Date }>(
        `insert into auth.mfa_login_challenges (
           id, account_id, purpose, token_sha256, account_token_version, created_at, expires_at,
           max_attempts, source_ip, user_agent_sha256
         ) select $1, $2, $3, $4, $5, issued.at, issued.at + ($6 * interval '1 second'), $7, $8, $9
             from (select clock_timestamp() as at) issued
         returning expires_at`,
        [randomUUID(), identity.accountId, purpose, this.protector.tokenDigest(token), account.token_version,
          CHALLENGE_TTL_SECONDS[purpose], CHALLENGE_MAX_ATTEMPTS, event.sourceIp ?? null,
          event.userAgent ? this.protector.tokenDigest(event.userAgent) : null],
      );
      await this.sessionEvent(client, 'mfa_challenge_issued', 'success', identity.accountId!, event, { purpose });
      return { purpose, expiresAt: inserted.rows[0]!.expires_at };
    });
    if (!result) throw new UnauthorizedException('Invalid credentials');
    return { ...result, token };
  }

  /** Second-factor step of sign-in: a TOTP code or one unused recovery code. */
  async completeLogin(token: string, input: { code?: string; recoveryCode?: string },
    event: SessionEventMetadata): Promise<LoginResult> {
    this.protector.assertConfigured();
    if (Boolean(input.code) === Boolean(input.recoveryCode)) {
      throw new DomainProblem(400, 'MFA_CODE_REQUIRED', 'Provide either an authenticator code or a recovery code');
    }
    const outcome = await this.database.withSystemTransaction(event.correlationId, async (client) => {
      const challenge = await this.lockChallenge(client, token, 'verify');
      if (!challenge) return { kind: 'invalid' } as const;
      if (await this.blocked(client, challenge.account_id, event)) return { kind: 'rate_limited' } as const;
      const factor = await this.lockActiveFactor(client, challenge.account_id);
      if (!factor) return { kind: 'invalid' } as const;
      let method: 'totp' | 'recovery_code';
      let accepted: boolean;
      if (input.code) {
        method = 'totp';
        accepted = await this.acceptTotp(client, challenge.account_id, factor, input.code);
      } else {
        method = 'recovery_code';
        accepted = await this.consumeRecoveryCode(client, challenge.account_id, input.recoveryCode!);
      }
      if (!accepted) return this.recordChallengeFailure(client, challenge, event);
      await client.query(
        `update auth.mfa_login_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
          where id = $1`, [challenge.id]);
      await this.sessionEvent(client, method === 'totp' ? 'mfa_verified' : 'mfa_recovery_code_used', 'success',
        challenge.account_id, event, { method });
      const session = await this.tokens.issuePlatformSession(client,
        { accountId: challenge.account_id, subject: challenge.subject, factorId: factor.id, method }, event);
      await this.audit.recordWithClient(client, this.authAudit(challenge, session.actor.sessionId, event,
        'auth.admin.login', { mfaMethod: method }));
      return { kind: 'session', session } as const;
    });
    if (outcome.kind !== 'session') throw this.failure(outcome);
    return outcome.session;
  }

  /**
   * First sign-in of an administrator without a factor: creates a pending TOTP
   * factor and returns its secret once. The secret is never returned again.
   */
  async startEnrollment(token: string, event: SessionEventMetadata): Promise<{
    secret: string; otpauthUri: string; algorithm: 'SHA1'; digits: number; periodSeconds: number; expiresAt: Date;
  }> {
    this.protector.assertConfigured();
    const outcome = await this.database.withSystemTransaction(event.correlationId, async (client) => {
      const challenge = await this.lockChallenge(client, token, 'enroll');
      if (!challenge) return { kind: 'invalid' } as const;
      if (await this.lockActiveFactor(client, challenge.account_id)) return { kind: 'invalid' } as const;
      if (await consumeRateLimit(client, 'mfa_request_account',
        this.protector.rateBucket('enroll', challenge.account_id), REQUESTS_PER_ACCOUNT)) {
        await this.sessionEvent(client, 'mfa_rate_limited', 'denied', challenge.account_id, event, { operation: 'enroll' });
        return { kind: 'rate_limited' } as const;
      }
      await client.query(
        `update auth.mfa_factors set status = 'revoked', revoked_at = clock_timestamp(),
            revocation_reason = 'enrollment_replaced', row_version = row_version + 1
          where account_id = $1 and status = 'pending'`,
        [challenge.account_id],
      );
      const factorId = randomUUID();
      const secret = randomBytes(TOTP_SECRET_BYTES);
      const inserted = await client.query<{ enrollment_expires_at: Date }>(
        `insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, enrollment_expires_at)
         values ($1, $2, 'pending', $3, $4,
           greatest(least($5::timestamptz, now() + interval '590 seconds'), clock_timestamp() + interval '5 seconds'))
         returning enrollment_expires_at`,
        [factorId, challenge.account_id, this.protector.encryptSecret(factorId, challenge.account_id, secret),
          this.protector.keyVersion, challenge.expires_at],
      );
      await this.sessionEvent(client, 'mfa_enrollment_started', 'success', challenge.account_id, event, {});
      const encoded = base32Encode(secret);
      secret.fill(0);
      return {
        kind: 'started', secret: encoded, label: challenge.email ?? challenge.subject,
        expiresAt: inserted.rows[0]!.enrollment_expires_at,
      } as const;
    });
    if (outcome.kind !== 'started') throw this.failure(outcome);
    return {
      secret: outcome.secret,
      otpauthUri: otpauthUri(TOTP_ISSUER, outcome.label, outcome.secret),
      algorithm: 'SHA1', digits: TOTP_DIGITS, periodSeconds: TOTP_PERIOD_SECONDS, expiresAt: outcome.expiresAt,
    };
  }

  /**
   * Confirms enrollment with a first TOTP code, activates the factor, issues
   * one-time recovery codes (returned once) and opens the platform session.
   */
  async activateEnrollment(token: string, code: string, event: SessionEventMetadata): Promise<{
    session: LoginResult; recoveryCodes: string[];
  }> {
    this.protector.assertConfigured();
    const recoveryCodes = this.newRecoveryCodes();
    const outcome = await this.database.withSystemTransaction(event.correlationId, async (client) => {
      const challenge = await this.lockChallenge(client, token, 'enroll');
      if (!challenge) return { kind: 'invalid' } as const;
      if (await this.blocked(client, challenge.account_id, event)) return { kind: 'rate_limited' } as const;
      const factor = (await client.query<FactorRow>(
        `select id::text, secret_ciphertext, secret_key_version, last_used_step::text
           from auth.mfa_factors
          where account_id = $1 and status = 'pending' and enrollment_expires_at > clock_timestamp()
          for update`,
        [challenge.account_id],
      )).rows[0];
      if (!factor) return { kind: 'invalid' } as const;
      const step = this.matchStep(challenge.account_id, factor, code);
      if (step === null) return this.recordChallengeFailure(client, challenge, event);
      const activated = await client.query(
        `update auth.mfa_factors set status = 'active', activated_at = clock_timestamp(),
            last_used_step = $2, last_used_at = clock_timestamp(), row_version = row_version + 1
          where id = $1 and status = 'pending'`,
        [factor.id, step],
      );
      if (activated.rowCount !== 1) return { kind: 'invalid' } as const;
      await this.insertRecoveryCodes(client, challenge.account_id, factor.id, recoveryCodes);
      await client.query(
        `update auth.mfa_login_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
          where id = $1`, [challenge.id]);
      await this.sessionEvent(client, 'mfa_enrolled', 'success', challenge.account_id, event,
        { recoveryCodes: recoveryCodes.length });
      const session = await this.tokens.issuePlatformSession(client,
        { accountId: challenge.account_id, subject: challenge.subject, factorId: factor.id, method: 'totp' }, event);
      await this.audit.recordWithClient(client, this.authAudit(challenge, session.actor.sessionId, event,
        'auth.admin.mfa.enrolled', { recoveryCodes: recoveryCodes.length }));
      return { kind: 'session', session } as const;
    });
    if (outcome.kind !== 'session') throw this.failure(outcome);
    return { session: outcome.session, recoveryCodes };
  }

  /**
   * Step-up re-authentication: a fresh TOTP code marks the current platform
   * session family as recently verified. Recovery codes cannot step up.
   */
  async stepUp(context: PlatformAccessContext, code: string, event: SessionEventMetadata): Promise<{
    stepUpExpiresAt: string;
  }> {
    this.protector.assertConfigured();
    const outcome = await this.database.withTransaction(context, async (client) => {
      await this.lockAccount(client, context.actor.accountId!);
      const state = await requirePlatformAssurance(client, context, 'platform.mfa.step-up');
      const accountId = context.actor.accountId;
      if (await this.blocked(client, accountId, event)) return { kind: 'rate_limited' } as const;
      const family = (await client.query<{ family_id: string; mfa_factor_id: string }>(
        `select assurance.family_id::text, assurance.mfa_factor_id::text
           from auth.sessions session_row
           join auth.session_assurance assurance
             on assurance.family_id = session_row.family_id and assurance.account_id = session_row.account_id
          where session_row.id = $1 and session_row.account_id = $2 and session_row.session_kind = 'platform'
            and session_row.revoked_at is null
          for update of assurance`,
        [context.actor.sessionId, accountId],
      )).rows[0];
      const factor = await this.lockActiveFactor(client, accountId);
      if (!family || !factor || factor.id !== family.mfa_factor_id) return { kind: 'invalid' } as const;
      if (!(await this.acceptTotp(client, accountId, factor, code))) {
        await this.recordFactorFailure(client, accountId, event, 'step_up_failed', context.actor.sessionId);
        return { kind: 'failed' } as const;
      }
      const updated = await client.query<{ step_up_expires_at: Date }>(
        `update auth.session_assurance
            set step_up_at = clock_timestamp(), step_up_count = step_up_count + 1,
                updated_at = clock_timestamp(), row_version = row_version + 1
          where family_id = $1
          returning step_up_at + ($2 * interval '1 second') as step_up_expires_at`,
        [family.family_id, this.environment.PLATFORM_STEP_UP_TTL_SECONDS],
      );
      await this.sessionEvent(client, 'step_up_verified', 'success', accountId, event, {}, context.actor.sessionId);
      await this.audit.recordWithClient(client, {
        ...platformAuditActor(context), action: 'admin.mfa.step-up', resourceType: 'session',
        resourceId: context.actor.sessionId, outcome: 'success', sourceIp: event.sourceIp, userAgent: event.userAgent,
        details: { mfaMethodAtSignIn: state.mfaMethod },
      });
      return { kind: 'verified', expiresAt: updated.rows[0]!.step_up_expires_at } as const;
    });
    if (outcome.kind !== 'verified') throw this.failure(outcome);
    return { stepUpExpiresAt: outcome.expiresAt.toISOString() };
  }

  /** Replaces every unused recovery code. Requires a fresh step-up; codes are returned once. */
  async regenerateRecoveryCodes(context: PlatformAccessContext, event: SessionEventMetadata): Promise<{
    recoveryCodes: string[];
  }> {
    this.protector.assertConfigured();
    const recoveryCodes = this.newRecoveryCodes();
    const outcome = await this.database.withTransaction(context, async (client) => {
      await this.lockAccount(client, context.actor.accountId!);
      await requirePlatformAssurance(client, context, 'platform.mfa.recovery-codes.regenerate');
      const accountId = context.actor.accountId;
      if (await consumeRateLimit(client, 'mfa_request_account',
        this.protector.rateBucket('recovery-codes', accountId), REQUESTS_PER_ACCOUNT)) {
        await this.sessionEvent(client, 'mfa_rate_limited', 'denied', accountId, event, { operation: 'recovery-codes' });
        return { kind: 'rate_limited' } as const;
      }
      const factor = await this.lockActiveFactor(client, accountId);
      if (!factor) return { kind: 'invalid' } as const;
      const invalidated = await client.query(
        `update auth.mfa_recovery_codes set invalidated_at = clock_timestamp(), invalidation_reason = 'regenerated'
          where account_id = $1 and used_at is null and invalidated_at is null`,
        [accountId],
      );
      await this.insertRecoveryCodes(client, accountId, factor.id, recoveryCodes);
      await this.sessionEvent(client, 'mfa_recovery_codes_regenerated', 'success', accountId, event,
        { invalidated: invalidated.rowCount ?? 0, issued: recoveryCodes.length }, context.actor.sessionId);
      await this.audit.recordWithClient(client, {
        ...platformAuditActor(context), action: 'admin.mfa.recovery-codes.regenerated', resourceType: 'mfa-factor',
        resourceId: factor.id, outcome: 'success', sourceIp: event.sourceIp, userAgent: event.userAgent,
        details: { invalidated: invalidated.rowCount ?? 0, issued: recoveryCodes.length },
      });
      return { kind: 'regenerated' } as const;
    });
    if (outcome.kind !== 'regenerated') throw this.failure(outcome);
    return { recoveryCodes };
  }

  /** Safe MFA status of the current administrator. Never includes the secret. */
  async status(context: PlatformAccessContext) {
    return this.database.withTransaction(context, async (client) => {
      const factor = (await client.query<{ id: string; activated_at: Date; last_used_at: Date | null; remaining: string }>(
        `select factor.id::text, factor.activated_at, factor.last_used_at,
                (select count(*) from auth.mfa_recovery_codes code
                  where code.account_id = factor.account_id and code.factor_id = factor.id
                    and code.used_at is null and code.invalidated_at is null)::text as remaining
           from auth.mfa_factors factor where factor.account_id = $1 and factor.status = 'active'`,
        [context.actor.accountId],
      )).rows[0];
      const assurance = await readPlatformAssurance(client, context.actor);
      return {
        enrolled: Boolean(factor),
        factorType: 'totp' as const,
        activatedAt: factor?.activated_at.toISOString() ?? null,
        lastUsedAt: factor?.last_used_at?.toISOString() ?? null,
        recoveryCodesRemaining: Number(factor?.remaining ?? 0),
        session: assurance ? {
          mfaVerifiedAt: assurance.mfaVerifiedAt.toISOString(),
          mfaMethod: assurance.mfaMethod,
          stepUpExpiresAt: assurance.stepUpExpiresAt?.toISOString() ?? null,
          idleExpiresAt: assurance.idleExpiresAt.toISOString(),
          absoluteExpiresAt: assurance.absoluteExpiresAt.toISOString(),
        } : null,
      };
    }, { readOnly: true });
  }

  /**
   * Locks the challenge, after the account it belongs to. The account is found
   * without a lock first; the challenge is then read again, locked, for that
   * account only, so it reflects any MFA reset or token version change that
   * committed while this transaction waited for the account.
   */
  private async lockChallenge(client: PoolClient, token: string, purpose: PlatformChallengePurpose): Promise<ChallengeRow | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const digest = this.protector.tokenDigest(token);
    const owner = (await client.query<{ account_id: string }>(
      `select challenge.account_id::text from auth.mfa_login_challenges challenge
        where challenge.token_sha256 = $1 and challenge.purpose = $2
          and challenge.consumed_at is null and challenge.invalidated_at is null`,
      [digest, purpose],
    )).rows[0];
    if (!owner) return null;
    await this.lockAccount(client, owner.account_id);
    const challenge = (await client.query<ChallengeRow>(
      `select challenge.id::text, challenge.account_id::text, account.subject, account.email,
              challenge.failed_attempts, challenge.max_attempts, challenge.expires_at
         from auth.mfa_login_challenges challenge
         join auth.accounts account on account.id = challenge.account_id
        where challenge.token_sha256 = $1 and challenge.purpose = $2 and challenge.account_id = $3
          and challenge.consumed_at is null and challenge.invalidated_at is null
          and account.status = 'active'
          and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
          and account.token_version = challenge.account_token_version
        for update of challenge`,
      [digest, purpose, owner.account_id],
    )).rows[0];
    if (!challenge) return null;
    if (challenge.expires_at.getTime() <= Date.now()) {
      await client.query(
        `update auth.mfa_login_challenges set invalidated_at = clock_timestamp(), invalidation_reason = 'expired',
            row_version = row_version + 1 where id = $1`, [challenge.id]);
      return null;
    }
    return challenge;
  }

  /** The account row lock (0076, FOR KEY SHARE), taken before any other lock of the transaction. */
  private async lockAccount(client: PoolClient, accountId: string): Promise<void> {
    await client.query('select auth.lock_account_for_mfa($1)', [accountId]);
  }

  private async lockActiveFactor(client: PoolClient, accountId: string): Promise<FactorRow | null> {
    return (await client.query<FactorRow>(
      `select id::text, secret_ciphertext, secret_key_version, last_used_step::text
         from auth.mfa_factors where account_id = $1 and status = 'active' for update`,
      [accountId],
    )).rows[0] ?? null;
  }

  private matchStep(accountId: string, factor: FactorRow, code: string): number | null {
    const secret = this.protector.decryptSecret(factor.id, accountId, factor.secret_key_version, factor.secret_ciphertext);
    try {
      return matchTotp(secret, code, this.totpClock?.() ?? Date.now());
    } finally {
      secret.fill(0);
    }
  }

  /** Accepts a TOTP code once: its step must be later than any step accepted before. */
  private async acceptTotp(client: PoolClient, accountId: string, factor: FactorRow, code: string): Promise<boolean> {
    const step = this.matchStep(accountId, factor, code);
    if (step === null) return false;
    if (factor.last_used_step !== null && step <= Number(factor.last_used_step)) return false;
    const advanced = await client.query(
      `update auth.mfa_factors set last_used_step = $2, last_used_at = clock_timestamp(), row_version = row_version + 1
        where id = $1 and status = 'active' and (last_used_step is null or last_used_step < $2)`,
      [factor.id, step],
    );
    return advanced.rowCount === 1;
  }

  private async consumeRecoveryCode(client: PoolClient, accountId: string, supplied: string): Promise<boolean> {
    const normalized = normalizeRecoveryCode(supplied);
    if (!normalized) return false;
    const used = await client.query(
      `update auth.mfa_recovery_codes code set used_at = clock_timestamp()
        where code.account_id = $1 and code.code_hmac = $2 and code.used_at is null and code.invalidated_at is null
          and exists (select 1 from auth.mfa_factors factor
            where factor.id = code.factor_id and factor.status = 'active')`,
      [accountId, this.protector.recoveryCodeDigest(accountId, normalized)],
    );
    return used.rowCount === 1;
  }

  private newRecoveryCodes(): string[] {
    const codes = new Set<string>();
    while (codes.size < RECOVERY_CODE_COUNT) codes.add(generateRecoveryCode());
    return [...codes];
  }

  private async insertRecoveryCodes(client: PoolClient, accountId: string, factorId: string, codes: string[]): Promise<void> {
    const batchId = randomUUID();
    for (const code of codes) {
      await client.query(
        `insert into auth.mfa_recovery_codes (account_id, factor_id, batch_id, code_hmac, key_version)
         values ($1, $2, $3, $4, $5)`,
        [accountId, factorId, batchId, this.protector.recoveryCodeDigest(accountId, normalizeRecoveryCode(code)!),
          this.protector.keyVersion],
      );
    }
  }

  private async blocked(client: PoolClient, accountId: string, event: SessionEventMetadata): Promise<boolean> {
    const blocked = await rateLimitBlocked(client, 'mfa_failure_account', this.protector.rateBucket('account', accountId))
      || await rateLimitBlocked(client, 'mfa_failure_ip', this.protector.rateBucket('ip', event.sourceIp ?? 'unavailable'));
    if (blocked) await this.sessionEvent(client, 'mfa_rate_limited', 'denied', accountId, event, {});
    return blocked;
  }

  private async recordFactorFailure(client: PoolClient, accountId: string, event: SessionEventMetadata,
    eventType: 'mfa_failed' | 'step_up_failed', sessionId?: string): Promise<void> {
    await consumeRateLimit(client, 'mfa_failure_account', this.protector.rateBucket('account', accountId), FAILURE_PER_ACCOUNT);
    await consumeRateLimit(client, 'mfa_failure_ip', this.protector.rateBucket('ip', event.sourceIp ?? 'unavailable'),
      FAILURE_PER_IP);
    await this.sessionEvent(client, eventType, 'denied', accountId, event, {}, sessionId);
  }

  private async recordChallengeFailure(client: PoolClient, challenge: ChallengeRow,
    event: SessionEventMetadata): Promise<{ kind: 'failed' }> {
    await client.query(
      `update auth.mfa_login_challenges
          set failed_attempts = failed_attempts + 1,
              invalidated_at = case when failed_attempts + 1 >= max_attempts then clock_timestamp() end,
              invalidation_reason = case when failed_attempts + 1 >= max_attempts then 'attempts_exhausted' end,
              row_version = row_version + 1
        where id = $1`,
      [challenge.id],
    );
    await this.recordFactorFailure(client, challenge.account_id, event, 'mfa_failed');
    await this.audit.recordWithClient(client, { ...this.authAudit(challenge, undefined, event, 'auth.admin.mfa.failed', {}),
      outcome: 'denied' });
    return { kind: 'failed' };
  }

  private sessionEvent(client: PoolClient, eventType: SessionEventType, outcome: 'success' | 'denied',
    accountId: string, event: SessionEventMetadata, details: Record<string, unknown>, sessionId?: string): Promise<void> {
    return this.tokens.recordSessionEvent(client, { eventType, outcome, accountId, sessionId, event, details });
  }

  private authAudit(challenge: ChallengeRow, sessionId: string | undefined, event: SessionEventMetadata,
    action: string, details: Record<string, unknown>) {
    return {
      correlationId: event.correlationId, actorType: 'staff' as const, actorSubject: challenge.subject,
      actorAccountId: challenge.account_id, accessScope: 'platform' as const, action,
      resourceType: 'session', resourceId: sessionId, outcome: 'success' as const,
      sourceIp: event.sourceIp, userAgent: event.userAgent, details,
    };
  }

  private failure(outcome: Failure): DomainProblem {
    if (outcome.kind === 'rate_limited') {
      return new DomainProblem(429, 'MFA_RATE_LIMITED', 'Too many verification attempts; try again later');
    }
    if (outcome.kind === 'failed') return new DomainProblem(401, 'MFA_INVALID_CODE', 'The code is not valid');
    return new DomainProblem(401, 'MFA_CHALLENGE_INVALID', 'Sign in again to continue');
  }
}
