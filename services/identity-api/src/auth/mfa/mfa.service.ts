import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { platformAuditActor } from '../../admin/admin-context';
import { AuditService } from '../../audit/audit.service';
import { AfterResponseTasks } from '../../common/after-response-tasks';
import { DomainProblem, RetryAfterProblem } from '../../common/problem';
import type { ActorContext, PlatformAccessContext } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import { ACTIVE_STAFF_VERIFICATION_STATUSES } from '../auth-policy';
import type { LoginResult } from '../auth.types';
import { eligibleStaffMembershipJoins } from '../current-staff-context.service';
import { LocalAuthProvider } from '../local-auth.provider';
import { NotificationOtpClient } from '../notification-otp.client';
import { readPlatformAssurance, requirePlatformAssurance } from '../platform-assurance';
import { consumeRateLimit, rateLimitBlocked, type RateLimitWindow } from '../rate-limit';
import { TokenService, type PlatformSessionAssurance, type SessionEventMetadata, type SessionEventType } from '../token.service';
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

/** The sign-in a challenge belongs to: platform administration (0069) or staff (MFA-1, 0088). */
export type MfaSessionKind = 'platform' | 'staff';

export interface PlatformLoginChallenge {
  purpose: PlatformChallengePurpose;
  token: string;
  expiresAt: Date;
}

/** A staff enrolment code delivery (POST /auth/mfa/enroll/email-code). */
export interface EnrollmentCodeDelivery {
  accepted: true;
  channel: 'email';
  expiresAt: Date;
}

/**
 * A completed second-factor event, after its transaction committed (MFA-1
 * notices). The sink is the notification route's to provide; while none is
 * bound no notice is sent and the audit event is the only record. A sink runs
 * after the response and its failure never undoes the event.
 */
export interface MfaNotice {
  accountId: string;
  /** The sign-in it happened in; absent for a factor reset, which concerns the account's one factor. */
  kind?: MfaSessionKind;
  event: 'factor_enrolled' | 'recovery_code_used' | 'factor_reset';
  correlationId: string;
  /** Unused recovery codes left, for recovery_code_used. */
  recoveryCodesRemaining?: number;
}
export interface MfaNoticeSink {
  notify(notice: MfaNotice): Promise<void>;
}
export const MFA_NOTICE_SINK = Symbol('MFA_NOTICE_SINK');

/**
 * A clinician applicant's 0088 staff challenge (ADR-064). Identity opens it
 * for the application capability with a token it derives itself and never
 * sends to the browser, so it can be presented at no /auth/mfa route, and it
 * never yields a session.
 */
export type ApplicantChallengeOutcome =
  | { kind: 'opened'; purpose: PlatformChallengePurpose; expiresAt: Date }
  | { kind: 'unproven' } | { kind: 'rate_limited' } | { kind: 'invalid' };

/** Verifies an applicant's authenticator on its challenge without a session; `onVerified` runs in the same transaction. */
export interface ApplicantVerifyOptions<R> {
  issue: 'none';
  onVerified(client: PoolClient, verified: { factorId: string; method: 'totp' | 'recovery_code' }): Promise<R>;
}
export interface ApplicantVerification<R> {
  factorId: string;
  method: 'totp' | 'recovery_code';
  result: R;
}

/** Activates an applicant's enrolment without a session; `onActivated` runs in the same transaction. */
export interface ApplicantActivateOptions<R> {
  issue: 'none';
  onActivated(client: PoolClient, factorId: string): Promise<R>;
}
export interface ApplicantActivation<R> {
  factorId: string;
  recoveryCodes: string[];
  result: R;
}

/** Step 1 of an application review: a code the applicant reads aloud, checked against their own factor. */
export type ApplicantFactorConfirmation =
  | { kind: 'confirmed'; factorId: string }
  | { kind: 'invalid' } | { kind: 'rate_limited' } | { kind: 'no_factor' };

/** The origin recorded on the 0088 session events and audit of a clinician application (ADR-064). */
const APPLICANT_ORIGIN = 'clinician_application';

interface ChallengeRow {
  id: string;
  account_id: string;
  subject: string;
  email: string | null;
  failed_attempts: number;
  max_attempts: number;
  expires_at: Date;
  proof_method: 'email_code' | 'provider_activation' | null;
  proof_verifier_hmac: string | null;
  proof_key_version: string | null;
  proof_verified_at: Date | null;
}

interface FactorRow {
  id: string;
  secret_ciphertext: Buffer;
  secret_key_version: string;
  last_used_step: string | null;
  /** The staff enrolment proof the factor records (0088); null when platform sign-in enrolled it. */
  enrollment_proof: 'email_code' | 'provider_activation' | null;
}

/** The fifth failed second-factor attempt within 15 minutes blocks the account for 15 minutes. */
const FAILURE_PER_ACCOUNT: RateLimitWindow = { windowSeconds: 900, maxRequests: 4 };
/**
 * Failed second-factor attempts per source address, in a bucket of each
 * sign-in's own (IP_BUCKET). Platform sign-in, used by a handful of
 * administrators, blocks the address at the 20th failure in 15 minutes.
 * Staff sign-in serves every clinician behind a facility's address, so its
 * bucket blocks at the 100th: mistyped codes at a shift change, or the
 * failure budgets of a few accounts, never lock a facility out.
 */
const FAILURE_PER_IP: Record<MfaSessionKind, RateLimitWindow> = {
  platform: { windowSeconds: 900, maxRequests: 19 },
  staff: { windowSeconds: 900, maxRequests: 99 },
};
const IP_BUCKET: Record<MfaSessionKind, string> = { platform: 'ip', staff: 'staff-ip' };
/** Enrollment starts and recovery-code regenerations: five per 15 minutes. */
const REQUESTS_PER_ACCOUNT: RateLimitWindow = { windowSeconds: 900, maxRequests: 5 };
/**
 * Retry-After of 429 MFA_RATE_LIMITED (A21): the longest MFA window (each is
 * 15 minutes), an upper bound whichever budget refused; a blocked bucket stays
 * blocked for one window. Never the time left in the blocked bucket.
 */
export const MFA_RETRY_AFTER_SECONDS = Math.max(FAILURE_PER_ACCOUNT.windowSeconds, REQUESTS_PER_ACCOUNT.windowSeconds,
  ...Object.values(FAILURE_PER_IP).map((window) => window.windowSeconds));
const CHALLENGE_TTL_SECONDS: Record<PlatformChallengePurpose, number> = { verify: 300, enroll: 600 };
const CHALLENGE_MAX_ATTEMPTS = 5;
const TOTP_ISSUER: Record<MfaSessionKind, string> = { platform: 'HID Platform Admin', staff: 'Health ID' };
/** The audit action prefix of each sign-in. */
const AUDIT_PREFIX: Record<MfaSessionKind, string> = { platform: 'auth.admin', staff: 'auth.staff' };

type Failure = { kind: 'invalid' } | { kind: 'rate_limited' } | { kind: 'failed' };

/**
 * Platform administrator MFA (Phase 4 Stage 2A) and staff MFA (MFA-1, 0088).
 * TOTP (RFC 6238) and one-time recovery codes are the only accepted second
 * factors; email OTP is not one. Every verification serializes on the factor
 * row and accepts a time step only once. Secrets never leave this service
 * except once, at enrollment. An account has one factor, which verifies both
 * its platform and its staff sign-ins; each challenge is accepted only by the
 * sign-in of its kind.
 *
 * A staff authenticator is enrolled only on a fresh proof bound to the
 * enrolment challenge: a six-digit code sent to the account's email address
 * (sendEnrollmentCode, then startEnrollment with the code), or the provider
 * activation that opened the challenge in the same request. The factor
 * records that proof, and only a factor that records one verifies a staff
 * sign-in: a factor a platform first enrolment created on the password alone
 * never does (403 STAFF_MFA_FACTOR_UNPROVEN until a governed reset), and a
 * platform first enrolment of an account with an eligible staff membership is
 * refused, so it enrols at staff sign-in. The database refuses to consume a
 * staff enrolment challenge that records no verified proof, to record a proof
 * on a factor without one, and to give a staff session assurance on a factor
 * without one (0088); it cannot check the emailed code itself.
 *
 * Lock order (Stage 7A): every transaction here locks the account row
 * (auth.lock_account_for_mfa, 0076) before any other row lock or write; then
 * the challenge (sign-in, enrolment) or the session assurance (step-up), the
 * factor and the recovery codes; then it writes sessions and events. An
 * approved MFA reset (0070) locks the account before the factor, and every
 * session revocation (0073) locks it before the sessions, both FOR UPDATE. A
 * flow that locked the factor first and then reached the account through the
 * FOR KEY SHARE of its session event, session or recovery code insert could
 * deadlock with them. The lock is FOR NO KEY UPDATE: it conflicts with theirs
 * and with itself, so MFA transactions of one account also run one at a time
 * (each sees the failures the one before it counted, and a password step
 * supersedes the challenge of the one before it), but not with the FOR KEY
 * SHARE of a refresh rotation.
 */
@Injectable()
export class MfaService {
  private readonly environment = getEnvironment();
  private readonly notices = new AfterResponseTasks(new Logger(MfaService.name), 'MFA owner notice failed');

  constructor(
    private readonly database: DatabaseService,
    private readonly protector: MfaSecretProtector,
    private readonly tokens: TokenService,
    private readonly localProvider: LocalAuthProvider,
    private readonly audit: AuditService,
    @Optional() @Inject(MFA_TOTP_CLOCK) private readonly totpClock?: () => number,
    @Optional() private readonly notification?: NotificationOtpClient,
    @Optional() @Inject(MFA_NOTICE_SINK) private readonly noticeSink?: MfaNoticeSink,
  ) {}

  /** Waits for the owner notices started so far. */
  settleNotices(): Promise<void> {
    return this.notices.settle();
  }

  /**
   * Password step of a platform or staff sign-in. A valid password for an
   * account eligible for that sign-in (platform.admin.access; an eligible
   * staff membership) yields a short-lived challenge, never a session.
   * `activationProof` is set only by provider activation, in the request that
   * set this password from a verified enrollment (ProviderEnrollmentController):
   * a staff enrolment challenge it opens carries that proof.
   */
  async beginLogin(principal: string, password: string, event: SessionEventMetadata,
    kind: MfaSessionKind = 'platform', options: { activationProof?: boolean } = {}): Promise<PlatformLoginChallenge> {
    this.protector.assertConfigured();
    const identity = await this.localProvider.authenticate(principal, password, 'staff', event.correlationId);
    if (!identity.accountId) throw new UnauthorizedException('Invalid credentials');
    const token = randomBytes(32).toString('base64url');
    const result = await this.database.withSystemTransaction(event.correlationId, async (client) => {
      await this.lockAccount(client, identity.accountId!);
      const eligible = kind === 'platform'
        ? `auth.account_has_platform_permission(account.id, 'platform.admin.access')`
        : `exists (select 1 from auth.accounts eligible ${eligibleStaffMembershipJoins('eligible', '$2')}
             where eligible.id = account.id)`;
      const account = (await client.query<{ eligible: boolean; enrolled: boolean; unproven: boolean;
        token_version: string; subject: string }>(
        `select ${eligible} as eligible,
                auth.account_has_active_mfa(account.id) as enrolled,
                exists (select 1 from auth.mfa_factors factor
                         where factor.account_id = account.id and factor.status = 'active'
                           and factor.enrollment_proof is null) as unproven,
                account.token_version::text, account.subject
           from auth.accounts account
          where account.id = $1 and account.status = 'active'
            and (account.disabled_until is null or account.disabled_until <= clock_timestamp())`,
        kind === 'platform' ? [identity.accountId] : [identity.accountId, [...ACTIVE_STAFF_VERIFICATION_STATUSES]],
      )).rows[0];
      // Not eligible for this sign-in: the same answer as a wrong password,
      // unless the account is an active staff account (a staff record or a
      // facility membership, none of them active): its password is correct,
      // and it is refused as having no active facility membership (A10). No
      // challenge is issued, nothing counts toward the sign-in lockout, and the
      // refusal is recorded against the account.
      if (!account?.eligible) {
        if (!account || kind !== 'staff' || !(await this.workforceRecord(client, identity.accountId!))) return null;
        await this.sessionEvent(client, 'login_failed', 'denied', identity.accountId!, event,
          { reason: 'no_active_membership', session_kind: kind });
        return { kind: 'no_membership' } as const;
      }
      if (identity.passwordUpgrade) {
        const upgraded = await client.query<{ upgraded: boolean }>(
          'select auth.upgrade_legacy_password($1, $2, $3, $4) as upgraded',
          [identity.accountId, identity.subject, identity.passwordUpgrade.expectedRowVersion, identity.passwordUpgrade.hash],
        );
        if (upgraded.rows[0]?.upgraded !== true) return null;
      }
      await client.query('delete from auth.login_attempts where principal_hmac = $1 and pepper_version = $2',
        [this.localProvider.principalHash(principal), this.environment.AUTH_LOGIN_PEPPER_VERSION]);
      // The account's factor was enrolled by platform sign-in, on the password
      // alone: it never verifies a staff sign-in (0088). No challenge is issued.
      if (kind === 'staff' && account.enrolled && account.unproven) {
        await this.sessionEvent(client, 'login_failed', 'denied', identity.accountId!, event,
          { reason: 'staff_mfa_factor_unproven', session_kind: kind });
        return { kind: 'unproven' } as const;
      }
      const purpose: PlatformChallengePurpose = account.enrolled ? 'verify' : 'enroll';
      const activationProof = kind === 'staff' && purpose === 'enroll' && options.activationProof === true;
      const expiresAt = await this.insertChallenge(client, { id: randomUUID(), accountId: identity.accountId!, purpose,
        token, tokenVersion: account.token_version, kind, activationProof }, event);
      await this.sessionEvent(client, 'mfa_challenge_issued', 'success', identity.accountId!, event,
        kind === 'platform' ? { purpose } : { purpose, session_kind: kind,
          ...(activationProof ? { proof: 'provider_activation' } : {}) });
      return { kind: 'challenge', purpose, expiresAt } as const;
    });
    if (!result) throw new UnauthorizedException('Invalid credentials');
    if (result.kind === 'unproven') throw this.unprovenFactor();
    if (result.kind === 'no_membership') {
      throw new DomainProblem(403, 'NO_ACTIVE_FACILITY_MEMBERSHIP',
        'Your account has no active facility membership. Ask your organization administrator for access.');
    }
    return { purpose: result.purpose, expiresAt: result.expiresAt, token };
  }

  /**
   * Second-factor step of sign-in: a TOTP code or one unused recovery code.
   * With `options` (a clinician applicant's challenge, ADR-064) no session is
   * issued: the code is checked and the challenge consumed exactly as for a
   * sign-in, then `onVerified` runs in the same transaction.
   */
  async completeLogin(token: string, input: { code?: string; recoveryCode?: string },
    event: SessionEventMetadata, kind?: MfaSessionKind): Promise<LoginResult>;
  async completeLogin<R>(token: string, input: { code?: string; recoveryCode?: string },
    event: SessionEventMetadata, kind: 'staff', options: ApplicantVerifyOptions<R>): Promise<ApplicantVerification<R>>;
  async completeLogin<R>(token: string, input: { code?: string; recoveryCode?: string },
    event: SessionEventMetadata, kind: MfaSessionKind = 'platform',
    options?: ApplicantVerifyOptions<R>): Promise<LoginResult | ApplicantVerification<R>> {
    this.protector.assertConfigured();
    if (options && kind !== 'staff') throw new Error('Only a staff challenge can be verified without a session');
    if (Boolean(input.code) === Boolean(input.recoveryCode)) {
      throw new DomainProblem(400, 'MFA_CODE_REQUIRED', 'Provide either an authenticator code or a recovery code');
    }
    const outcome = await this.database.withSystemTransaction(event.correlationId, async (client) => {
      const challenge = await this.lockChallenge(client, token, 'verify', kind);
      if (!challenge) return { kind: 'invalid' } as const;
      if (await this.blocked(client, challenge.account_id, event, kind)) return { kind: 'rate_limited' } as const;
      const factor = await this.lockActiveFactor(client, challenge.account_id);
      if (!factor) return { kind: 'invalid' } as const;
      if (kind === 'staff' && !factor.enrollment_proof) return { kind: 'unproven' } as const;
      let method: 'totp' | 'recovery_code';
      let accepted: boolean;
      if (input.code) {
        method = 'totp';
        accepted = await this.acceptTotp(client, challenge.account_id, factor, input.code);
      } else {
        method = 'recovery_code';
        accepted = await this.consumeRecoveryCode(client, challenge.account_id, input.recoveryCode!);
      }
      if (!accepted) return this.recordChallengeFailure(client, challenge, event, kind);
      await client.query(
        `update auth.mfa_login_challenges set consumed_at = clock_timestamp(), row_version = row_version + 1
          where id = $1`, [challenge.id]);
      if (options) {
        await this.sessionEvent(client, method === 'totp' ? 'mfa_verified' : 'mfa_recovery_code_used', 'success',
          challenge.account_id, event, { method, session_kind: kind, origin: APPLICANT_ORIGIN });
        let applicantRemaining: number | undefined;
        if (method === 'recovery_code') {
          applicantRemaining = await this.remainingRecoveryCodes(client, challenge.account_id, factor.id);
          await this.audit.recordWithClient(client, this.authAudit(kind, challenge, undefined, event,
            `${AUDIT_PREFIX[kind]}.mfa.recovery-code.used`,
            { recoveryCodesRemaining: applicantRemaining, origin: APPLICANT_ORIGIN }));
        }
        const result = await options.onVerified(client, { factorId: factor.id, method });
        return { kind: 'verified', accountId: challenge.account_id, factorId: factor.id, method, result,
          remaining: applicantRemaining } as const;
      }
      await this.sessionEvent(client, method === 'totp' ? 'mfa_verified' : 'mfa_recovery_code_used', 'success',
        challenge.account_id, event, { method });
      const session = await this.issueSession(client, kind,
        { accountId: challenge.account_id, subject: challenge.subject, factorId: factor.id, method }, event);
      let remaining: number | undefined;
      if (method === 'recovery_code') {
        remaining = await this.remainingRecoveryCodes(client, challenge.account_id, factor.id);
        await this.audit.recordWithClient(client, this.authAudit(kind, challenge, session, event,
          `${AUDIT_PREFIX[kind]}.mfa.recovery-code.used`, { recoveryCodesRemaining: remaining }));
      }
      await this.audit.recordWithClient(client, this.authAudit(kind, challenge, session, event,
        kind === 'platform' ? 'auth.admin.login' : 'auth.login', { mfaMethod: method }));
      return { kind: 'session', session, remaining } as const;
    });
    if (outcome.kind === 'unproven') throw this.unprovenFactor();
    if (outcome.kind === 'verified') {
      if (outcome.remaining !== undefined) {
        this.notify({ accountId: outcome.accountId, kind, event: 'recovery_code_used',
          correlationId: event.correlationId, recoveryCodesRemaining: outcome.remaining });
      }
      return { factorId: outcome.factorId, method: outcome.method, result: outcome.result };
    }
    if (outcome.kind !== 'session') throw this.failure(outcome);
    if (outcome.remaining !== undefined) {
      this.notify({ accountId: outcome.session.actor.accountId, kind, event: 'recovery_code_used',
        correlationId: event.correlationId, recoveryCodesRemaining: outcome.remaining });
    }
    return outcome.session;
  }

  /**
   * Sends the fresh proof of a staff enrolment: a six-digit code to the
   * account's email address, bound to this challenge (only its keyed digest is
   * stored). A resend replaces the code. Each send counts against the
   * account's enrolment request budget.
   */
  async sendEnrollmentCode(token: string, event: SessionEventMetadata): Promise<EnrollmentCodeDelivery> {
    this.protector.assertConfigured();
    if (!this.notification) {
      throw new DomainProblem(503, 'MFA_ENROLLMENT_CODE_UNDELIVERABLE', 'The enrolment code could not be sent; try again later');
    }
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const outcome = await this.database.withSystemTransaction(event.correlationId, async (client) => {
      const challenge = await this.lockChallenge(client, token, 'enroll', 'staff');
      if (!challenge) return { kind: 'invalid' } as const;
      if (await this.lockActiveFactor(client, challenge.account_id)) return { kind: 'invalid' } as const;
      if (challenge.proof_verified_at) return { kind: 'proof_complete' } as const;
      if (!challenge.email) return { kind: 'no_address' } as const;
      if (await consumeRateLimit(client, 'mfa_request_account',
        this.protector.rateBucket('enroll-proof', challenge.account_id), REQUESTS_PER_ACCOUNT)) {
        await this.sessionEvent(client, 'mfa_rate_limited', 'denied', challenge.account_id, event,
          { operation: 'enroll-proof' });
        return { kind: 'rate_limited' } as const;
      }
      await client.query(
        `update auth.mfa_login_challenges
            set proof_method = 'email_code', proof_verifier_hmac = $2, proof_key_version = $3,
                proof_sent_at = clock_timestamp(), row_version = row_version + 1
          where id = $1`,
        [challenge.id, this.protector.enrollmentCodeDigest(challenge.id, code), this.protector.keyVersion],
      );
      await this.sessionEvent(client, 'mfa_challenge_issued', 'success', challenge.account_id, event,
        { purpose: 'enroll', session_kind: 'staff', proof: 'email_code' });
      return { kind: 'sent', recipient: challenge.email, expiresAt: challenge.expires_at } as const;
    });
    if (outcome.kind === 'proof_complete') {
      throw new DomainProblem(409, 'MFA_ENROLLMENT_PROOF_COMPLETE', 'This enrolment is already confirmed; continue setting up your authenticator');
    }
    if (outcome.kind === 'no_address') {
      throw new DomainProblem(409, 'MFA_ENROLLMENT_PROOF_UNAVAILABLE',
        'This account has no email address to confirm the enrolment; contact your administrator');
    }
    if (outcome.kind !== 'sent') throw this.failure(outcome);
    // Each send has its own delivery id, so a resend is never deduplicated
    // with the code it replaces.
    const delivery = await this.notification.deliver({
      challengeId: randomUUID(), recipient: outcome.recipient, code, purpose: 'LOGIN_STEP_UP', channel: 'email',
      correlationId: event.correlationId,
    });
    if (delivery.outcome === 'definitive_failure') {
      throw new DomainProblem(503, 'MFA_ENROLLMENT_CODE_UNDELIVERABLE', 'The enrolment code could not be sent; try again later');
    }
    return { accepted: true, channel: 'email', expiresAt: outcome.expiresAt };
  }

  /**
   * First sign-in without a factor: creates a pending TOTP factor and returns
   * its secret once. The secret is never returned again. A staff enrolment
   * needs its fresh proof first: the email code (verified here, a wrong code
   * counted as a failed attempt) or the provider activation; the factor
   * records it. A platform enrolment records none, so it is refused for an
   * account with an eligible staff membership, which enrols at staff sign-in
   * instead and then uses that factor for both.
   */
  async startEnrollment(token: string, event: SessionEventMetadata, kind: MfaSessionKind = 'platform',
    proof: { emailCode?: string } = {}): Promise<{
    secret: string; otpauthUri: string; algorithm: 'SHA1'; digits: number; periodSeconds: number; expiresAt: Date;
  }> {
    this.protector.assertConfigured();
    const outcome = await this.database.withSystemTransaction(event.correlationId, async (client) => {
      const challenge = await this.lockChallenge(client, token, 'enroll', kind);
      if (!challenge) return { kind: 'invalid' } as const;
      if (await this.lockActiveFactor(client, challenge.account_id)) return { kind: 'invalid' } as const;
      if (kind === 'platform' && await this.staffEligible(client, challenge.account_id)) {
        return { kind: 'staff_sign_in_required' } as const;
      }
      if (kind === 'staff' && !challenge.proof_verified_at) {
        if (!proof.emailCode || challenge.proof_method !== 'email_code') return { kind: 'proof_required' } as const;
        if (await this.blocked(client, challenge.account_id, event, kind)) return { kind: 'rate_limited' } as const;
        if (!this.proofMatches(challenge, proof.emailCode)) return this.recordChallengeFailure(client, challenge, event, kind);
        await client.query(
          `update auth.mfa_login_challenges set proof_verified_at = clock_timestamp(), row_version = row_version + 1
            where id = $1`, [challenge.id]);
      }
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
      // A staff factor records the proof it is enrolled on, and its challenge.
      const inserted = await client.query<{ enrollment_expires_at: Date }>(
        `insert into auth.mfa_factors (id, account_id, status, secret_ciphertext, secret_key_version, enrollment_expires_at,
           enrollment_proof, enrollment_challenge_id)
         values ($1, $2, 'pending', $3, $4,
           greatest(least($5::timestamptz, now() + interval '590 seconds'), clock_timestamp() + interval '5 seconds'),
           $6, $7)
         returning enrollment_expires_at`,
        [factorId, challenge.account_id, this.protector.encryptSecret(factorId, challenge.account_id, secret),
          this.protector.keyVersion, challenge.expires_at,
          kind === 'staff' ? challenge.proof_method : null, kind === 'staff' ? challenge.id : null],
      );
      await this.sessionEvent(client, 'mfa_enrollment_started', 'success', challenge.account_id, event,
        kind === 'platform' ? {} : { session_kind: kind, proof: challenge.proof_method ?? 'email_code' });
      const encoded = base32Encode(secret);
      secret.fill(0);
      return {
        kind: 'started', secret: encoded, label: challenge.email ?? challenge.subject,
        expiresAt: inserted.rows[0]!.enrollment_expires_at,
      } as const;
    });
    if (outcome.kind === 'proof_required') {
      throw new DomainProblem(403, 'MFA_ENROLLMENT_PROOF_REQUIRED',
        'Enter the code sent to your email address to set up your authenticator');
    }
    if (outcome.kind === 'staff_sign_in_required') {
      throw new DomainProblem(409, 'MFA_ENROLLMENT_STAFF_SIGN_IN_REQUIRED',
        'This account also signs in as staff: set up your authenticator at staff sign-in, then use it here');
    }
    if (outcome.kind !== 'started') throw this.failure(outcome);
    return {
      secret: outcome.secret,
      otpauthUri: otpauthUri(TOTP_ISSUER[kind], outcome.label, outcome.secret),
      algorithm: 'SHA1', digits: TOTP_DIGITS, periodSeconds: TOTP_PERIOD_SECONDS, expiresAt: outcome.expiresAt,
    };
  }

  /**
   * Confirms enrollment with a first TOTP code, activates the factor, issues
   * one-time recovery codes (returned once) and opens the platform or staff
   * session. With `options` (a clinician applicant's challenge, ADR-064) no
   * session is issued: the factor, its recovery codes and the enrolment audit
   * are written exactly as for a sign-in, then `onActivated` runs in the same
   * transaction.
   */
  async activateEnrollment(token: string, code: string, event: SessionEventMetadata,
    kind?: MfaSessionKind): Promise<{ session: LoginResult; recoveryCodes: string[] }>;
  async activateEnrollment<R>(token: string, code: string, event: SessionEventMetadata,
    kind: 'staff', options: ApplicantActivateOptions<R>): Promise<ApplicantActivation<R>>;
  async activateEnrollment<R>(token: string, code: string, event: SessionEventMetadata,
    kind: MfaSessionKind = 'platform', options?: ApplicantActivateOptions<R>):
    Promise<{ session: LoginResult; recoveryCodes: string[] } | ApplicantActivation<R>> {
    this.protector.assertConfigured();
    if (options && kind !== 'staff') throw new Error('Only a staff enrolment can be activated without a session');
    const recoveryCodes = this.newRecoveryCodes();
    const outcome = await this.database.withSystemTransaction(event.correlationId, async (client) => {
      const challenge = await this.lockChallenge(client, token, 'enroll', kind);
      if (!challenge) return { kind: 'invalid' } as const;
      if (kind === 'staff' && !challenge.proof_verified_at) return { kind: 'proof_required' } as const;
      if (await this.blocked(client, challenge.account_id, event, kind)) return { kind: 'rate_limited' } as const;
      // A staff enrolment activates only the factor its own proven challenge created.
      const factor = (await client.query<FactorRow>(
        `select id::text, secret_ciphertext, secret_key_version, last_used_step::text, enrollment_proof
           from auth.mfa_factors
          where account_id = $1 and status = 'pending' and enrollment_expires_at > clock_timestamp()
            ${kind === 'staff' ? 'and enrollment_challenge_id = $2' : ''}
          for update`,
        kind === 'staff' ? [challenge.account_id, challenge.id] : [challenge.account_id],
      )).rows[0];
      if (!factor) return { kind: 'invalid' } as const;
      const step = this.matchStep(challenge.account_id, factor, code);
      if (step === null) return this.recordChallengeFailure(client, challenge, event, kind);
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
      if (options) {
        await this.sessionEvent(client, 'mfa_enrolled', 'success', challenge.account_id, event,
          { recoveryCodes: recoveryCodes.length, session_kind: kind, proof: challenge.proof_method,
            origin: APPLICANT_ORIGIN });
        await this.audit.recordWithClient(client, this.authAudit(kind, challenge, undefined, event,
          `${AUDIT_PREFIX[kind]}.mfa.enrolled`,
          { recoveryCodes: recoveryCodes.length, proofMethod: challenge.proof_method, origin: APPLICANT_ORIGIN }));
        const result = await options.onActivated(client, factor.id);
        return { kind: 'activated', accountId: challenge.account_id, factorId: factor.id, result } as const;
      }
      await this.sessionEvent(client, 'mfa_enrolled', 'success', challenge.account_id, event,
        kind === 'platform' ? { recoveryCodes: recoveryCodes.length }
          : { recoveryCodes: recoveryCodes.length, session_kind: kind, proof: challenge.proof_method });
      const session = await this.issueSession(client, kind,
        { accountId: challenge.account_id, subject: challenge.subject, factorId: factor.id, method: 'totp' }, event);
      await this.audit.recordWithClient(client, this.authAudit(kind, challenge, session, event,
        `${AUDIT_PREFIX[kind]}.mfa.enrolled`, kind === 'platform' ? { recoveryCodes: recoveryCodes.length }
          : { recoveryCodes: recoveryCodes.length, proofMethod: challenge.proof_method }));
      if (kind === 'staff') {
        await this.audit.recordWithClient(client, this.authAudit(kind, challenge, session, event, 'auth.login',
          { mfaMethod: 'totp', enrolled: true }));
      }
      return { kind: 'session', session } as const;
    });
    if (outcome.kind === 'proof_required') {
      throw new DomainProblem(403, 'MFA_ENROLLMENT_PROOF_REQUIRED',
        'Enter the code sent to your email address to set up your authenticator');
    }
    if (outcome.kind === 'activated') {
      this.notify({ accountId: outcome.accountId, kind, event: 'factor_enrolled', correlationId: event.correlationId });
      return { factorId: outcome.factorId, recoveryCodes, result: outcome.result };
    }
    if (outcome.kind !== 'session') throw this.failure(outcome);
    this.notify({ accountId: outcome.session.actor.accountId, kind, event: 'factor_enrolled',
      correlationId: event.correlationId });
    return { session: outcome.session, recoveryCodes };
  }

  /**
   * Opens the 0088 staff challenge a clinician application capability drives
   * (ADR-064), inside the caller's transaction and after the account lock, as
   * the password step opens one: an enrolment challenge for an account with
   * no factor, a verification challenge for one with a staff-proven factor.
   * There is no password step: the capability was opened by an emailed code.
   * Its token is derived by the caller and never leaves Identity. Each opening
   * counts against the account's request budget; over it, nothing is opened.
   * An account whose only factor platform sign-in enrolled opens none.
   */
  async openApplicantChallenge(client: PoolClient, accountId: string, challenge: { id: string; token: string },
    event: SessionEventMetadata): Promise<ApplicantChallengeOutcome> {
    this.protector.assertConfigured();
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge.token)) throw new Error('An applicant challenge token is malformed');
    await this.lockAccount(client, accountId);
    const account = (await client.query<{ enrolled: boolean; unproven: boolean; token_version: string }>(
      `select auth.account_has_active_mfa(account.id) as enrolled,
              exists (select 1 from auth.mfa_factors factor
                       where factor.account_id = account.id and factor.status = 'active'
                         and factor.enrollment_proof is null) as unproven,
              account.token_version::text
         from auth.accounts account
        where account.id = $1 and account.status = 'active'
          and (account.disabled_until is null or account.disabled_until <= clock_timestamp())`,
      [accountId],
    )).rows[0];
    if (!account) return { kind: 'invalid' };
    if (account.enrolled && account.unproven) return { kind: 'unproven' };
    if (await consumeRateLimit(client, 'mfa_request_account',
      this.protector.rateBucket('applicant-challenge', accountId), REQUESTS_PER_ACCOUNT)) {
      await this.sessionEvent(client, 'mfa_rate_limited', 'denied', accountId, event, { operation: 'applicant-challenge' });
      return { kind: 'rate_limited' };
    }
    const purpose: PlatformChallengePurpose = account.enrolled ? 'verify' : 'enroll';
    const expiresAt = await this.insertChallenge(client, { id: challenge.id, accountId, purpose, token: challenge.token,
      tokenVersion: account.token_version, kind: 'staff', activationProof: false }, event);
    await this.sessionEvent(client, 'mfa_challenge_issued', 'success', accountId, event,
      { purpose, session_kind: 'staff', origin: APPLICANT_ORIGIN });
    return { kind: 'opened', purpose, expiresAt };
  }

  /**
   * Step 1 of a clinician application review (ADR-064): during the identity
   * call the applicant reads a current code from their authenticator and a
   * Super Admin types it. It is checked against the applicant's active
   * staff-proven factor and accepted once (the factor's last step advances),
   * inside the administrator's transaction, after both account rows are
   * locked in id order (0073), before the factor. Recovery codes are not
   * accepted. A wrong code counts against the applicant's failure budget,
   * which the caller commits before it answers.
   */
  async confirmApplicantFactor(client: PoolClient, accounts: { applicantAccountId: string; actorAccountId: string },
    code: string, event: SessionEventMetadata): Promise<ApplicantFactorConfirmation> {
    this.protector.assertConfigured();
    for (const accountId of [...new Set([accounts.applicantAccountId, accounts.actorAccountId])].sort()) {
      await client.query('select auth.lock_account_sessions($1)', [accountId]);
    }
    const factor = await this.lockActiveFactor(client, accounts.applicantAccountId);
    if (!factor || !factor.enrollment_proof) return { kind: 'no_factor' };
    if (await this.blocked(client, accounts.applicantAccountId, event, 'staff')) return { kind: 'rate_limited' };
    if (!/^[0-9]{6}$/.test(code) || !(await this.acceptTotp(client, accounts.applicantAccountId, factor, code))) {
      await this.recordFactorFailure(client, accounts.applicantAccountId, event, 'mfa_failed', 'staff');
      return { kind: 'invalid' };
    }
    await this.sessionEvent(client, 'mfa_verified', 'success', accounts.applicantAccountId, event,
      { method: 'totp', session_kind: 'staff', origin: 'clinician_application_review' });
    return { kind: 'confirmed', factorId: factor.id };
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
      if (await this.blocked(client, accountId, event, 'platform')) return { kind: 'rate_limited' } as const;
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
        await this.recordFactorFailure(client, accountId, event, 'step_up_failed', 'platform', context.actor.sessionId);
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
    if (outcome.kind !== 'verified') throw this.sessionFailure(outcome);
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
    if (outcome.kind !== 'regenerated') throw this.sessionFailure(outcome);
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

  private issueSession(client: PoolClient, kind: MfaSessionKind, assurance: PlatformSessionAssurance,
    event: SessionEventMetadata): Promise<LoginResult> {
    return kind === 'platform'
      ? this.tokens.issuePlatformSession(client, assurance, event)
      : this.tokens.issueStaffSession(client, assurance, event);
  }

  private notify(notice: MfaNotice): void {
    const sink = this.noticeSink;
    if (sink) this.notices.run(notice.correlationId, () => sink.notify(notice));
  }

  /**
   * Locks the challenge, after the account it belongs to. The account is found
   * without a lock first; the challenge is then read again, locked, for that
   * account only, so it reflects any MFA reset or token version change that
   * committed while this transaction waited for the account. Only a challenge
   * of the sign-in's own kind is found.
   */
  private async lockChallenge(client: PoolClient, token: string, purpose: PlatformChallengePurpose,
    kind: MfaSessionKind): Promise<ChallengeRow | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const digest = this.protector.tokenDigest(token);
    const owner = (await client.query<{ account_id: string }>(
      `select challenge.account_id::text from auth.mfa_login_challenges challenge
        where challenge.token_sha256 = $1 and challenge.purpose = $2 and challenge.session_kind = $3
          and challenge.consumed_at is null and challenge.invalidated_at is null`,
      [digest, purpose, kind],
    )).rows[0];
    if (!owner) return null;
    await this.lockAccount(client, owner.account_id);
    const challenge = (await client.query<ChallengeRow>(
      `select challenge.id::text, challenge.account_id::text, account.subject, account.email,
              challenge.failed_attempts, challenge.max_attempts, challenge.expires_at,
              challenge.proof_method, challenge.proof_verifier_hmac::text, challenge.proof_key_version,
              challenge.proof_verified_at
         from auth.mfa_login_challenges challenge
         join auth.accounts account on account.id = challenge.account_id
        where challenge.token_sha256 = $1 and challenge.purpose = $2 and challenge.account_id = $3
          and challenge.session_kind = $4
          and challenge.consumed_at is null and challenge.invalidated_at is null
          and account.status = 'active'
          and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
          and account.token_version = challenge.account_token_version
        for update of challenge`,
      [digest, purpose, owner.account_id, kind],
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

  /**
   * Supersedes the account's live challenges of this sign-in kind and inserts
   * a new one (the password step's, and a clinician applicant's, ADR-064).
   * Only the token's digest is stored.
   */
  private async insertChallenge(client: PoolClient, challenge: { id: string; accountId: string;
    purpose: PlatformChallengePurpose; token: string; tokenVersion: string; kind: MfaSessionKind;
    activationProof: boolean }, event: SessionEventMetadata): Promise<Date> {
    await client.query(
      `update auth.mfa_login_challenges set invalidated_at = clock_timestamp(),
          invalidation_reason = 'superseded', row_version = row_version + 1
        where account_id = $1 and session_kind = $2 and consumed_at is null and invalidated_at is null`,
      [challenge.accountId, challenge.kind],
    );
    const inserted = await client.query<{ expires_at: Date }>(
      `insert into auth.mfa_login_challenges (
         id, account_id, purpose, token_sha256, account_token_version, created_at, expires_at,
         max_attempts, source_ip, user_agent_sha256, session_kind, proof_method, proof_verified_at
       ) select $1, $2, $3, $4, $5, issued.at, issued.at + ($6 * interval '1 second'), $7, $8, $9, $10,
           case when $11 then 'provider_activation' end, case when $11 then issued.at end
           from (select clock_timestamp() as at) issued
       returning expires_at`,
      [challenge.id, challenge.accountId, challenge.purpose, this.protector.tokenDigest(challenge.token),
        challenge.tokenVersion, CHALLENGE_TTL_SECONDS[challenge.purpose], CHALLENGE_MAX_ATTEMPTS,
        event.sourceIp ?? null, event.userAgent ? this.protector.tokenDigest(event.userAgent) : null, challenge.kind,
        challenge.activationProof],
    );
    return inserted.rows[0]!.expires_at;
  }

  /** The supplied enrolment email code matches the one sent for this challenge, under the current key. */
  private proofMatches(challenge: ChallengeRow, supplied: string): boolean {
    if (!/^[0-9]{6}$/.test(supplied) || !challenge.proof_verifier_hmac
      || challenge.proof_key_version !== this.protector.keyVersion) return false;
    const expected = Buffer.from(challenge.proof_verifier_hmac, 'hex');
    const actual = Buffer.from(this.protector.enrollmentCodeDigest(challenge.id, supplied), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** The account row lock (0076, FOR NO KEY UPDATE), taken before any other lock of the transaction. */
  private async lockAccount(client: PoolClient, accountId: string): Promise<void> {
    await client.query('select auth.lock_account_for_mfa($1)', [accountId]);
  }

  private async lockActiveFactor(client: PoolClient, accountId: string): Promise<FactorRow | null> {
    return (await client.query<FactorRow>(
      `select id::text, secret_ciphertext, secret_key_version, last_used_step::text, enrollment_proof
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

  private async remainingRecoveryCodes(client: PoolClient, accountId: string, factorId: string): Promise<number> {
    const result = await client.query<{ remaining: string }>(
      `select count(*)::text as remaining from auth.mfa_recovery_codes
        where account_id = $1 and factor_id = $2 and used_at is null and invalidated_at is null`,
      [accountId, factorId],
    );
    return Number(result.rows[0]?.remaining ?? 0);
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

  /** The account's failure budget (shared by both sign-ins) or the sign-in's own per-IP budget is used up. */
  private async blocked(client: PoolClient, accountId: string, event: SessionEventMetadata,
    kind: MfaSessionKind): Promise<boolean> {
    const blocked = await rateLimitBlocked(client, 'mfa_failure_account', this.protector.rateBucket('account', accountId))
      || await rateLimitBlocked(client, 'mfa_failure_ip', this.ipBucket(kind, event));
    if (blocked) await this.sessionEvent(client, 'mfa_rate_limited', 'denied', accountId, event, {});
    return blocked;
  }

  private async recordFactorFailure(client: PoolClient, accountId: string, event: SessionEventMetadata,
    eventType: 'mfa_failed' | 'step_up_failed', kind: MfaSessionKind, sessionId?: string): Promise<void> {
    await consumeRateLimit(client, 'mfa_failure_account', this.protector.rateBucket('account', accountId), FAILURE_PER_ACCOUNT);
    await consumeRateLimit(client, 'mfa_failure_ip', this.ipBucket(kind, event), FAILURE_PER_IP[kind]);
    await this.sessionEvent(client, eventType, 'denied', accountId, event, {}, sessionId);
  }

  private ipBucket(kind: MfaSessionKind, event: SessionEventMetadata): string {
    return this.protector.rateBucket(IP_BUCKET[kind], event.sourceIp ?? 'unavailable');
  }

  /**
   * The account holds a staff membership that staff sign-in accepts: the
   * same membership joins and verification statuses as staff beginLogin.
   */
  /** The account has a staff record or a facility membership, active or not (A10). */
  private async workforceRecord(client: PoolClient, accountId: string): Promise<boolean> {
    const result = await client.query<{ workforce_record: boolean }>(
      `select (exists (select 1 from identity.staff staff where staff.account_id = $1)
            or exists (select 1 from identity.staff_facility_memberships membership
                        where membership.account_id = $1)) as workforce_record`,
      [accountId],
    );
    return result.rows[0]?.workforce_record === true;
  }

  private async staffEligible(client: PoolClient, accountId: string): Promise<boolean> {
    const result = await client.query<{ staff_eligible: boolean }>(
      `select exists (select 1 from auth.accounts eligible ${eligibleStaffMembershipJoins('eligible', '$2')}
                       where eligible.id = $1) as staff_eligible`,
      [accountId, [...ACTIVE_STAFF_VERIFICATION_STATUSES]],
    );
    return result.rows[0]?.staff_eligible === true;
  }

  private async recordChallengeFailure(client: PoolClient, challenge: ChallengeRow,
    event: SessionEventMetadata, kind: MfaSessionKind): Promise<{ kind: 'failed' }> {
    await client.query(
      `update auth.mfa_login_challenges
          set failed_attempts = failed_attempts + 1,
              invalidated_at = case when failed_attempts + 1 >= max_attempts then clock_timestamp() end,
              invalidation_reason = case when failed_attempts + 1 >= max_attempts then 'attempts_exhausted' end,
              row_version = row_version + 1
        where id = $1`,
      [challenge.id],
    );
    await this.recordFactorFailure(client, challenge.account_id, event, 'mfa_failed', kind);
    await this.audit.recordWithClient(client, { ...this.authAudit(kind, challenge, undefined, event,
      `${AUDIT_PREFIX[kind]}.mfa.failed`, {}), outcome: 'denied' });
    return { kind: 'failed' };
  }

  private sessionEvent(client: PoolClient, eventType: SessionEventType, outcome: 'success' | 'denied',
    accountId: string, event: SessionEventMetadata, details: Record<string, unknown>, sessionId?: string): Promise<void> {
    return this.tokens.recordSessionEvent(client, { eventType, outcome, accountId, sessionId, event, details });
  }

  /**
   * A sign-in audit event. A platform one has no facility (accessScope
   * platform). A staff one names the session's default facility membership
   * when there is a session, as the staff sign-in audit always has.
   */
  private authAudit(kind: MfaSessionKind, challenge: ChallengeRow, session: LoginResult | undefined,
    event: SessionEventMetadata, action: string, details: Record<string, unknown>) {
    const facility: ActorContext['facility'] = kind === 'staff' ? session?.actor.facility : undefined;
    return {
      correlationId: event.correlationId, actorType: 'staff' as const, actorSubject: challenge.subject,
      actorAccountId: challenge.account_id,
      ...(kind === 'platform' ? { accessScope: 'platform' as const } : {}),
      ...(facility ? { actorMembershipId: facility.membershipId, organizationId: facility.organizationId,
        facilityId: facility.id } : {}),
      action, resourceType: 'session', resourceId: session?.actor.sessionId, outcome: 'success' as const,
      sourceIp: event.sourceIp, userAgent: event.userAgent, details,
    };
  }

  private unprovenFactor(): DomainProblem {
    return new DomainProblem(403, 'STAFF_MFA_FACTOR_UNPROVEN',
      'Your authenticator was set up at platform sign-in and cannot be used for staff sign-in; '
      + 'ask a platform administrator to reset it, then set it up again at staff sign-in');
  }

  private failure(outcome: Failure): DomainProblem {
    if (outcome.kind === 'rate_limited') {
      return new RetryAfterProblem(429, 'MFA_RATE_LIMITED', 'Too many verification attempts; try again later',
        MFA_RETRY_AFTER_SECONDS);
    }
    if (outcome.kind === 'failed') return new DomainProblem(401, 'MFA_INVALID_CODE', 'The code is not valid');
    return new DomainProblem(401, 'MFA_CHALLENGE_INVALID', 'Sign in again to continue');
  }

  /**
   * The refusal of step-up and recovery-code regeneration (A20). Both run on an
   * authenticated platform route, where 401 would read as an ended session: a
   * wrong or replayed code is 403 MFA_INVALID_CODE, and a session that lost its
   * MFA assurance while the request waited for the account lock is 403
   * PLATFORM_SESSION_REQUIRED, as requirePlatformAssurance answers it. It is
   * thrown after the transaction committed, so a counted failure stays counted.
   * The sign-in challenge steps are unauthenticated and keep failure() and 401.
   */
  private sessionFailure(outcome: Failure): DomainProblem {
    if (outcome.kind === 'failed') return new DomainProblem(403, 'MFA_INVALID_CODE', 'The code is not valid');
    if (outcome.kind === 'invalid') {
      return new DomainProblem(403, 'PLATFORM_SESSION_REQUIRED', 'An MFA-verified platform administration session is required');
    }
    return this.failure(outcome);
  }
}
