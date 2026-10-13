import { createDecipheriv, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { type BeforeApplicationShutdown, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { PoolClient } from 'pg';
import { AFTER_RESPONSE_SHUTDOWN_GRACE_MS, AfterResponseTasks } from '../common/after-response-tasks';
import { publicClientNetwork } from '../common/client-network';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { RecoveryAudience, RecoveryOtpPurpose } from './dto/otp.dto';
import { NotificationOtpClient, type OtpDeliveryOutcome } from './notification-otp.client';
import { consumeRateLimit, lockRateLimitBucket, rateLimitBlocked } from './rate-limit';

interface AccountRow {
  id: string;
  email: string | null;
  email_verified: boolean;
  audience_matches: boolean;
  token_version: string;
  phone_enrollment_id: string | null;
  phone_ciphertext: Buffer | null;
  phone_key_version: string | null;
}
interface RecoveryRecipient { channel: 'email' | 'sms'; value: string }
interface ActiveChallengeRow { id: string; cooling: boolean }
interface StartCooldownRow { challenge_id: string; cooling: boolean }
interface ChallengeRow {
  id: string;
  account_id: string;
  recipient_hmac: string;
  verifier_hmac: string;
  expires_at: Date;
  failed_attempts: number;
  max_attempts: number;
}

interface VerifiedChallengeRow {
  id: string;
  account_id: string;
  completion_token_hmac: string;
  completion_expires_at: Date;
}

/** A completed OTP account recovery, after its transaction committed. */
export interface AccountRecoveryNotice {
  accountId: string;
  purpose: RecoveryOtpPurpose;
  correlationId: string;
}

/**
 * Where the owner notice of a completed recovery goes (REC-NOTIFY): a fixed
 * "your password was changed" message to every verified contact of the
 * account and an inbox entry. The sink is the notification route's to
 * provide; while none is bound, no notice is sent and the audit event
 * auth.otp.recovery.completed is the only record. A sink runs after the
 * response, like code delivery, and its failure never undoes the recovery.
 */
export interface AccountRecoveryNoticeSink {
  recoveryCompleted(notice: AccountRecoveryNotice): Promise<void>;
}
export const ACCOUNT_RECOVERY_NOTICE_SINK = Symbol('ACCOUNT_RECOVERY_NOTICE_SINK');

export function generateSixDigitOtp(draw: (minimum: number, maximum: number) => number = randomInt): string {
  return draw(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Recovery codes (POST /auth/otp/start, verify, complete). A start answers
 * every identifier alike (CODEX.md §27): the same 202 body, before any code is
 * delivered, and within the resend cooldown the challengeId it gave the same
 * purpose and identifier before, whether or not an account exists
 * (auth.otp_start_cooldowns, 0081). Wrong codes count against one budget per
 * account across all its challenges and purposes; once spent, every code is
 * refused and no code is sent until the window ends.
 *
 * A start reaches only the account kind of its page (RECOVERY_AUDIENCE_BY_ACTION)
 * and sends a patient's code only to a verified contact. Any other account is
 * answered and counted exactly like an unknown identifier, and sent nothing.
 */
@Injectable()
export class OtpService implements BeforeApplicationShutdown {
  private readonly environment = getEnvironment();
  private readonly key = this.environment.OTP_HMAC_KEY_B64
    ? Buffer.from(this.environment.OTP_HMAC_KEY_B64, 'base64') : undefined;
  private readonly deliveries = new AfterResponseTasks(new Logger(OtpService.name),
    'Recovery code delivery or its bookkeeping failed');
  private readonly notices = new AfterResponseTasks(new Logger(OtpService.name), 'Recovery owner notice failed');

  constructor(
    private readonly database: DatabaseService,
    private readonly notification: NotificationOtpClient,
    @Optional() @Inject(ACCOUNT_RECOVERY_NOTICE_SINK) private readonly recoveryNotices?: AccountRecoveryNoticeSink,
  ) {}

  /** Waits for the deliveries and owner notices started so far, and any started meanwhile. */
  async settleDeliveries(): Promise<void> {
    await Promise.all([this.deliveries.settle(), this.notices.settle()]);
  }

  /** Runs before DatabaseService ends the pool, so deliveries can record their outcome. */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.deliveries.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS),
      this.notices.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS)]);
  }

  async start(input: {
    identifier: string;
    purpose: RecoveryOtpPurpose;
    audience: RecoveryAudience;
    remoteIp?: string;
    correlationId: string;
  }): Promise<{
    accepted: true;
    challengeId: string;
    deliveryChannels: ['email', 'sms'];
    expiresInSeconds: number;
    resendAfterSeconds: number;
  }> {
    this.assertConfigured();
    const identifier = input.identifier.trim();
    // The client network (an IPv4 address or an IPv6 /64). Without one, or
    // with one of our own proxies in production, every client would share one
    // bucket, so recovery answers 503 instead, for every identifier alike (IP-1).
    const network = publicClientNetwork(input.remoteIp, this.environment);
    if (!network) {
      throw new DomainProblem(503, 'OTP_RATE_LIMIT_UNAVAILABLE', 'Verification codes are temporarily unavailable');
    }
    const ipHmac = this.hmac('ip', network);
    // Email addresses and HIDs are both matched without regard to case. Each
    // recovery page keeps its own cooldown, so a start on another page (which
    // reaches no account) never holds back the account's own page.
    const identifierHmac = this.hmac('otp-start', input.purpose, input.audience, identifier.toLowerCase());
    const cooldownSeconds = this.environment.OTP_RESEND_COOLDOWN_SECONDS;
    const code = generateSixDigitOtp();
    const candidateChallengeId = randomUUID();

    const challenge = await this.database.withSystemTransaction(input.correlationId, async (client): Promise<
      { kind: 'challenge'; id: string; recipient: RecoveryRecipient }
      | { kind: 'none' }
      | { kind: 'rate_limited' }
      | { kind: 'cooldown'; id: string }
    > => {
      const found = (await client.query<AccountRow>(
        `select account.id::text, lower(account.email)::text as email,
                account.email_verified_at is not null as email_verified,
                auth.recovery_account_audience(account.id, $2) as audience_matches,
                account.token_version::text,
                enrollment.id::text as phone_enrollment_id,
                enrollment.contact_ciphertext as phone_ciphertext,
                enrollment.key_version as phone_key_version
           from auth.accounts account
           left join identity.patients patient on patient.account_id = account.id
           left join identity.public_patient_enrollments enrollment
             on enrollment.account_id = account.id and enrollment.patient_id = patient.id
            and enrollment.state = 'active' and enrollment.contact_channel = 'phone'
            and enrollment.contact_verified_at is not null
            and patient.status = 'active'
            and patient.phone_lookup_hmac = enrollment.contact_lookup_hmac
            and patient.contact_key_version = enrollment.key_version
            and account.source_system = 'hid-public-qoreid-enrollment'
            and patient.source_system = 'hid-public-qoreid-enrollment'
          where account.status in ('active', 'pending_reset')
            and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
            and (lower(account.email) = lower($1) or upper(patient.hid_code) = upper($1))
          order by case when lower(account.email) = lower($1) then 0 else 1 end
          limit 1`,
        [identifier, input.audience],
      )).rows[0];
      // An account of another kind, or one with no contact a code may go to,
      // is answered and counted from here on exactly like an unknown identifier.
      const candidate = found?.audience_matches === true ? found : undefined;
      const recipient = candidate ? this.recoveryRecipient(candidate, input.audience) : null;
      const account = recipient ? candidate : undefined;
      const recipientHmac = this.hmac('recipient', recipient?.value ?? identifier.toLowerCase());
      const recipientLimited = await this.consumeRateLimit(client, 'recipient', recipientHmac);
      const ipLimited = await this.consumeRateLimit(client, 'ip', ipHmac);
      const accountLimited = account
        ? await this.consumeRateLimit(client, 'account', this.hmac('account', account.id)) : false;
      if (recipientLimited || ipLimited || accountLimited) return { kind: 'rate_limited' };

      // The cooldown of this purpose and identifier, kept whether or not an
      // account exists, so a repeat is answered alike. The recipient bucket's
      // transaction lock above already serializes the starts of one
      // identifier. Both cooldowns below use the database clock.
      const previous = (await client.query<StartCooldownRow>(
        `select challenge_id::text,
                started_at > clock_timestamp() - ($3 * interval '1 second') as cooling
           from auth.otp_start_cooldowns
          where purpose = $1 and identifier_hmac = $2`,
        [input.purpose, identifierHmac, cooldownSeconds],
      )).rows[0];
      if (previous?.cooling) return { kind: 'cooldown', id: previous.challenge_id };
      await client.query(
        `insert into auth.otp_start_cooldowns (purpose, identifier_hmac, challenge_id, started_at)
         values ($1, $2, $3, clock_timestamp())
         on conflict (purpose, identifier_hmac) do update
           set challenge_id = excluded.challenge_id, started_at = excluded.started_at`,
        [input.purpose, identifierHmac, candidateChallengeId],
      );

      // Run for unknown identifiers too (it finds nothing), as before.
      const active = (await client.query<ActiveChallengeRow>(
        `select id::text, created_at > clock_timestamp() - ($3 * interval '1 second') as cooling
           from auth.otp_challenges
          where account_id = $1 and purpose = $2
            and consumed_at is null and invalidated_at is null
          order by created_at desc limit 1 for update`,
        [account?.id ?? null, input.purpose, cooldownSeconds],
      )).rows[0];
      if (!account || !recipient) return { kind: 'none' };
      // An account whose code budget is spent is answered like an unknown
      // identifier and sent nothing. A read only: start never counts it.
      if (await rateLimitBlocked(client, 'account', this.verifyFailureBucket(account.id))) return { kind: 'none' };
      // A challenge still cooling that this identifier did not start (the
      // account's other identifier did) is not revealed and not resent. The
      // identifier's own challenge, written just after its cooldown row, does
      // not hold back its own retry once that cooldown has ended.
      if (active?.cooling && active.id !== previous?.challenge_id) return { kind: 'none' };
      await client.query(
        `update auth.otp_challenges set invalidated_at = clock_timestamp(),
            invalidation_reason = 'resend', row_version = row_version + 1
          where account_id = $1 and purpose = $2
            and consumed_at is null and invalidated_at is null`,
        [account.id, input.purpose],
      );
      const verifierHmac = this.hmac('otp', input.purpose, recipientHmac, code);
      await client.query(
        `insert into auth.otp_challenges (
           id, account_id, recipient_hmac, purpose, channel, verifier_hmac,
           verifier_key_version, expires_at, max_attempts, request_ip_hmac, account_token_version
         ) values ($1, $2, $3, $4, $5, $6, $7,
           clock_timestamp() + ($8 * interval '1 second'), $9, $10, $11)`,
        [candidateChallengeId, account.id, recipientHmac, input.purpose, recipient.channel, verifierHmac,
          this.environment.OTP_HMAC_KEY_VERSION, this.environment.OTP_EXPIRY_SECONDS,
          this.environment.OTP_MAX_ATTEMPTS, ipHmac, account.token_version],
      );
      return { kind: 'challenge', id: candidateChallengeId, recipient };
    });

    if (challenge.kind === 'rate_limited') throw this.rateLimited();
    if (challenge.kind === 'challenge') {
      // Only a real account has a code to deliver, so the response does not
      // wait for it: its timing would tell that the account exists. The
      // delivery request starts here, synchronously; its outcome is recorded
      // after the response.
      const { id, recipient } = challenge;
      this.deliveries.run(input.correlationId, async () => {
        const delivery = await this.notification.deliver({
          challengeId: id, recipient: recipient.value, code, purpose: input.purpose,
          channel: recipient.channel,
          correlationId: input.correlationId,
        });
        await this.recordDelivery(id, delivery);
      });
    }

    return {
      accepted: true,
      challengeId: challenge.kind === 'challenge' || challenge.kind === 'cooldown'
        ? challenge.id : candidateChallengeId,
      // This is the generic set of possible channels, not the chosen account
      // channel. Keep the public response identical for unknown identifiers.
      deliveryChannels: ['email', 'sms'],
      expiresInSeconds: this.environment.OTP_EXPIRY_SECONDS,
      resendAfterSeconds: this.environment.OTP_RESEND_COOLDOWN_SECONDS,
    };
  }

  async verify(input: {
    challengeId: string;
    purpose: RecoveryOtpPurpose;
    code: string;
    correlationId: string;
  }): Promise<{ verified: true; challengeId: string; verificationToken: string }> {
    this.assertConfigured();
    const verificationToken = randomBytes(32).toString('base64url');
    const completionTokenHmac = this.hmac('otp-completion', input.challengeId, verificationToken);
    const outcome = await this.database.withSystemTransaction(input.correlationId, async (client) => {
      const challenge = (await client.query<ChallengeRow>(
        `select challenge.id::text, challenge.account_id::text, challenge.recipient_hmac::text,
                challenge.verifier_hmac::text, challenge.expires_at,
                challenge.failed_attempts, challenge.max_attempts
           from auth.otp_challenges challenge
           join auth.accounts account on account.id = challenge.account_id
          where account.status in ('active', 'pending_reset')
            and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
            and challenge.account_token_version = account.token_version
            and challenge.id = $1 and challenge.purpose = $2
            and challenge.verified_at is null
            and challenge.consumed_at is null and challenge.invalidated_at is null
          limit 1 for update of challenge`,
        [input.challengeId, input.purpose],
      )).rows[0];
      if (!challenge) return 'invalid' as const;
      if (challenge.expires_at.getTime() <= Date.now()) {
        await this.invalidate(client, challenge.id, 'expired');
        return 'invalid' as const;
      }
      if (challenge.failed_attempts >= challenge.max_attempts) {
        await this.invalidate(client, challenge.id, 'attempts_exhausted');
        return 'invalid' as const;
      }
      // The account's failure budget, across all its challenges and purposes.
      // Lock order: this challenge row, then the budget's transaction lock.
      // Start only reads the budget and complete never touches it, and no
      // other challenge is locked here, so no cycle can form. A spent budget
      // refuses every code, a correct one too.
      const failureBucket = this.verifyFailureBucket(challenge.account_id);
      await lockRateLimitBucket(client, 'account', failureBucket);
      if (await rateLimitBlocked(client, 'account', failureBucket)) {
        await this.invalidate(client, challenge.id, 'attempts_exhausted');
        return 'invalid' as const;
      }
      const suppliedVerifier = this.hmac('otp', input.purpose, challenge.recipient_hmac, input.code);
      if (!this.equalHex(challenge.verifier_hmac, suppliedVerifier)) {
        await client.query(
          `update auth.otp_challenges
              set failed_attempts = failed_attempts + 1,
                  last_attempt_at = clock_timestamp(),
                  invalidated_at = case when failed_attempts + 1 >= max_attempts
                    then clock_timestamp() else null end,
                  invalidation_reason = case when failed_attempts + 1 >= max_attempts
                    then 'attempts_exhausted' else null end,
                  row_version = row_version + 1
            where id = $1`,
          [challenge.id],
        );
        // The OTP_VERIFY_FAILURE_MAX-th failure in the window blocks the
        // budget (a request window allows that many minus one).
        await consumeRateLimit(client, 'account', failureBucket, {
          windowSeconds: this.environment.OTP_VERIFY_FAILURE_WINDOW_SECONDS,
          maxRequests: this.environment.OTP_VERIFY_FAILURE_MAX - 1,
        });
        return 'invalid' as const;
      }

      await client.query(
        `update auth.otp_challenges
            set verified_at = clock_timestamp(), last_attempt_at = clock_timestamp(),
                completion_token_hmac = $2,
                completion_expires_at = clock_timestamp() + ($3 * interval '1 second'),
                row_version = row_version + 1
          where id = $1`,
        [challenge.id, completionTokenHmac, this.environment.OTP_EXPIRY_SECONDS],
      );
      return 'verified' as const;
    });
    if (outcome !== 'verified') throw this.invalid();
    return { verified: true, challengeId: input.challengeId, verificationToken };
  }

  async complete(input: {
    challengeId: string;
    purpose: RecoveryOtpPurpose;
    verificationToken: string;
    newPassword: string;
    correlationId: string;
  }): Promise<{ completed: true }> {
    this.assertConfigured();
    const suppliedTokenHmac = this.hmac('otp-completion', input.challengeId, input.verificationToken);
    const outcome = await this.database.withSystemTransaction(input.correlationId, async (client) => {
      const challenge = (await client.query<VerifiedChallengeRow>(
        `select challenge.id::text, challenge.account_id::text,
                challenge.completion_token_hmac::text, challenge.completion_expires_at
           from auth.otp_challenges challenge
           join auth.accounts account on account.id = challenge.account_id
          where challenge.id = $1 and challenge.purpose = $2 and challenge.verified_at is not null
            and challenge.consumed_at is null and challenge.invalidated_at is null
            and challenge.account_token_version = account.token_version
            and account.status in ('active', 'pending_reset')
            and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
          limit 1`,
        [input.challengeId, input.purpose],
      )).rows[0];
      if (!challenge || challenge.completion_expires_at.getTime() <= Date.now()
        || !this.equalHex(challenge.completion_token_hmac, suppliedTokenHmac)) return null;

      const passwordHash = await argon2.hash(input.newPassword, {
        type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1,
      });
      const completed = await client.query<{ completed: boolean }>(
        'select auth.complete_recovery_otp($1, $2, $3, $4) as completed',
        [input.challengeId, input.purpose, suppliedTokenHmac, passwordHash],
      );
      return completed.rows[0]?.completed === true ? challenge.account_id : null;
    });
    if (!outcome) throw this.invalid();
    const sink = this.recoveryNotices;
    if (sink) {
      this.notices.run(input.correlationId, () => sink.recoveryCompleted({
        accountId: outcome, purpose: input.purpose, correlationId: input.correlationId,
      }));
    }
    return { completed: true };
  }

  /** Its own HMAC domain, apart from the account's start bucket hmac('account', id). */
  private verifyFailureBucket(accountId: string): string {
    return this.hmac('otp-verify-failure', accountId);
  }

  private consumeRateLimit(client: PoolClient, scope: 'ip' | 'account' | 'recipient', bucket: string): Promise<boolean> {
    return consumeRateLimit(client, scope, bucket, {
      windowSeconds: this.environment.OTP_RATE_WINDOW_SECONDS,
      maxRequests: this.environment.OTP_RATE_MAX_REQUESTS,
    });
  }

  private async recordDelivery(challengeId: string, delivery: { outcome: OtpDeliveryOutcome; provider?: string }): Promise<void> {
    await this.database.query(
      `update auth.otp_challenges set delivery_outcome = $2, delivery_provider = $3,
          invalidated_at = case when $2 = 'definitive_failure' then clock_timestamp() else invalidated_at end,
          invalidation_reason = case when $2 = 'definitive_failure' then 'delivery_failed' else invalidation_reason end,
          row_version = row_version + 1 where id = $1 and consumed_at is null`,
      [challengeId, delivery.outcome, delivery.provider ?? null],
    );
  }

  /**
   * Where a recovery code may go. A patient's code goes only to a verified
   * contact: the account email once verified, else the verified phone of its
   * public enrollment (REC-UNVERIFIED-CONTACT). A staff or platform account's
   * email is the work address its provisioning set, which no flow marks
   * verified; the code itself proves that address.
   */
  private recoveryRecipient(account: AccountRow, audience: RecoveryAudience): RecoveryRecipient | null {
    if (account.email && (audience !== 'patient' || account.email_verified === true)) {
      return { channel: 'email', value: account.email };
    }
    return this.verifiedEnrollmentPhone(account);
  }

  private verifiedEnrollmentPhone(account: AccountRow): RecoveryRecipient | null {
    const { phone_enrollment_id: enrollmentId, phone_ciphertext: ciphertext,
      phone_key_version: keyVersion } = account;
    const encodedKey = this.environment.NIN_ENCRYPTION_KEY_B64;
    if (!enrollmentId || !ciphertext || !encodedKey || keyVersion !== this.environment.NIN_KEY_VERSION
      || ciphertext.length < 30 || ciphertext[0] !== 1) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(encodedKey, 'base64'),
        ciphertext.subarray(1, 13));
      decipher.setAAD(Buffer.from(`identity:public-patient-enrollment:${enrollmentId}:contact`));
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const phone = Buffer.concat([decipher.update(ciphertext.subarray(13, -16)),
        decipher.final()]).toString('utf8');
      return /^\+[1-9]\d{7,14}$/.test(phone) ? { channel: 'sms', value: phone } : null;
    } catch {
      // Missing or rotated encryption material cannot authorize recovery.
      return null;
    }
  }

  private invalidate(client: PoolClient, challengeId: string, reason: 'expired' | 'attempts_exhausted'): Promise<unknown> {
    return client.query(
      `update auth.otp_challenges set invalidated_at = clock_timestamp(),
          invalidation_reason = $2, row_version = row_version + 1 where id = $1`,
      [challengeId, reason],
    );
  }

  private hmac(...parts: string[]): string {
    this.assertConfigured();
    return createHmac('sha256', this.key!).update(parts.join('\u001f'), 'utf8').digest('hex');
  }

  private equalHex(expected: string, supplied: string): boolean {
    const left = Buffer.from(expected, 'hex');
    const right = Buffer.from(supplied, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private assertConfigured(): void {
    if (!this.key || this.key.length !== 32) {
      throw new DomainProblem(503, 'OTP_UNAVAILABLE', 'Verification codes are unavailable');
    }
  }

  private invalid(): DomainProblem {
    return new DomainProblem(403, 'OTP_INVALID_OR_EXPIRED', 'The verification code is invalid or expired');
  }

  private rateLimited(): DomainProblem {
    return new DomainProblem(429, 'OTP_RATE_LIMITED', 'Too many verification-code requests');
  }
}
