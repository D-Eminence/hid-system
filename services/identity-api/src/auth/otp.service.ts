import { createDecipheriv, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { type BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { PoolClient } from 'pg';
import { AFTER_RESPONSE_SHUTDOWN_GRACE_MS, AfterResponseTasks } from '../common/after-response-tasks';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { RecoveryOtpPurpose } from './dto/otp.dto';
import { emailFirstName } from './email-first-name';
import { NotificationOtpClient, type OtpDeliveryOutcome } from './notification-otp.client';
import { consumeRateLimit, lockRateLimitBucket, rateLimitBlocked } from './rate-limit';

interface AccountRow {
  id: string;
  email: string | null;
  token_version: string;
  phone_enrollment_id: string | null;
  phone_ciphertext: Buffer | null;
  phone_key_version: string | null;
  /** The account's active patient, when this service may read it (RLS: patients from public enrollment). */
  patient_first_name: string | null;
  patient_hid_code: string | null;
}
interface RecoveryRecipient { channel: 'email' | 'sms'; value: string }
/** Who a patient email names: their first name (if any) and Health ID. */
interface PatientNaming { firstName?: string; healthId: string }
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
  email: string | null;
  patient_first_name: string | null;
  patient_hid_code: string | null;
}

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
 */
@Injectable()
export class OtpService implements BeforeApplicationShutdown {
  private readonly environment = getEnvironment();
  private readonly key = this.environment.OTP_HMAC_KEY_B64
    ? Buffer.from(this.environment.OTP_HMAC_KEY_B64, 'base64') : undefined;
  private readonly logger = new Logger(OtpService.name);
  private readonly deliveries = new AfterResponseTasks(this.logger,
    'Recovery code delivery or its bookkeeping failed');
  /** "Your Health ID password was updated": sent after a completed reset answers, never waited for. */
  private readonly confirmations = new AfterResponseTasks(this.logger,
    'Password-updated email could not be sent');

  constructor(
    private readonly database: DatabaseService,
    private readonly notification: NotificationOtpClient,
  ) {}

  /** Waits for the deliveries started so far, and any started meanwhile. */
  async settleDeliveries(): Promise<void> {
    await Promise.all([this.deliveries.settle(), this.confirmations.settle()]);
  }

  /** Runs before DatabaseService ends the pool, so deliveries can record their outcome. */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.deliveries.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS),
      this.confirmations.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS)]);
  }

  async start(input: {
    identifier: string;
    purpose: RecoveryOtpPurpose;
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
    const ipHmac = this.hmac('ip', input.remoteIp ?? 'unavailable');
    // Email addresses and HIDs are both matched without regard to case.
    const identifierHmac = this.hmac('otp-start', input.purpose, identifier.toLowerCase());
    const cooldownSeconds = this.environment.OTP_RESEND_COOLDOWN_SECONDS;
    const code = generateSixDigitOtp();
    const candidateChallengeId = randomUUID();

    const challenge = await this.database.withSystemTransaction(input.correlationId, async (client): Promise<
      { kind: 'challenge'; id: string; recipient: RecoveryRecipient; patient?: PatientNaming }
      | { kind: 'none' }
      | { kind: 'rate_limited' }
      | { kind: 'cooldown'; id: string }
    > => {
      const account = (await client.query<AccountRow>(
        `select account.id::text, lower(account.email)::text as email, account.token_version::text,
                enrollment.id::text as phone_enrollment_id,
                enrollment.contact_ciphertext as phone_ciphertext,
                enrollment.key_version as phone_key_version,
                case when patient.status = 'active' then patient.first_name end as patient_first_name,
                case when patient.status = 'active' then patient.hid_code end as patient_hid_code
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
        [identifier],
      )).rows[0];
      const recipient = account?.email
        ? { channel: 'email' as const, value: account.email }
        : account ? this.verifiedEnrollmentPhone(account) : null;
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
      // A patient's reset code by email names them and their Health ID
      // (owner decision of 2026-10-28, hid-1.0's design). Staff, admin and
      // legacy recovery, an SMS code, and a patient this service cannot read
      // keep the generic code message. Read in the same query, so the start
      // answers every identifier alike and in the same time.
      const patient = input.purpose === 'PASSWORD_RESET' && recipient.channel === 'email'
        ? this.patientNaming(account.patient_first_name, account.patient_hid_code) : undefined;
      return { kind: 'challenge', id: candidateChallengeId, recipient, ...(patient ? { patient } : {}) };
    });

    if (challenge.kind === 'rate_limited') throw this.rateLimited();
    if (challenge.kind === 'challenge') {
      // Only a real account has a code to deliver, so the response does not
      // wait for it: its timing would tell that the account exists. The
      // delivery request starts here, synchronously; its outcome is recorded
      // after the response.
      const { id, recipient, patient } = challenge;
      this.deliveries.run(input.correlationId, async () => {
        const delivery = patient
          ? await this.notification.deliverPasswordResetCode({
            challengeId: id, recipient: recipient.value, code,
            ...(patient.firstName ? { firstName: patient.firstName } : {}), healthId: patient.healthId,
            expiresInMinutes: Math.ceil(this.environment.OTP_EXPIRY_SECONDS / 60),
            correlationId: input.correlationId,
          })
          : await this.notification.deliver({
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
                challenge.completion_token_hmac::text, challenge.completion_expires_at,
                lower(account.email)::text as email,
                patient.first_name as patient_first_name, patient.hid_code as patient_hid_code
           from auth.otp_challenges challenge
           join auth.accounts account on account.id = challenge.account_id
           left join identity.patients patient
             on patient.account_id = account.id and patient.status = 'active'
          where challenge.id = $1 and challenge.purpose = $2 and challenge.verified_at is not null
            and challenge.consumed_at is null and challenge.invalidated_at is null
            and challenge.account_token_version = account.token_version
            and account.status in ('active', 'pending_reset')
            and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
          limit 1`,
        [input.challengeId, input.purpose],
      )).rows[0];
      if (!challenge || challenge.completion_expires_at.getTime() <= Date.now()
        || !this.equalHex(challenge.completion_token_hmac, suppliedTokenHmac)) return { kind: 'invalid' as const };

      const passwordHash = await argon2.hash(input.newPassword, {
        type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1,
      });
      const completed = await client.query<{ completed: boolean }>(
        'select auth.complete_recovery_otp($1, $2, $3, $4) as completed',
        [input.challengeId, input.purpose, suppliedTokenHmac, passwordHash],
      );
      return completed.rows[0]?.completed === true
        ? { kind: 'completed' as const, challenge } : { kind: 'invalid' as const };
    });
    if (outcome.kind !== 'completed') throw this.invalid();
    this.confirmPasswordUpdated(outcome.challenge, input.correlationId);
    return { completed: true };
  }

  /**
   * "Your Health ID password was updated" (owner decision of 2026-10-28,
   * hid-1.0's design), to the account's email after a completed reset. A
   * patient this service can read is named, with their Health ID; any other
   * account gets it without them. Best-effort: the reset has already
   * answered and never fails because of it; a failure is logged with the
   * correlation id and the outcome only. An account without an email gets
   * nothing (production delivers email only).
   */
  private confirmPasswordUpdated(challenge: VerifiedChallengeRow, correlationId: string): void {
    const recipient = challenge.email;
    if (!recipient) return;
    const patient = this.patientNaming(challenge.patient_first_name, challenge.patient_hid_code);
    this.confirmations.run(correlationId, async () => {
      const delivery = await this.notification.deliverPasswordUpdated({
        challengeId: challenge.id, recipient,
        ...(patient?.firstName ? { firstName: patient.firstName } : {}),
        ...(patient ? { healthId: patient.healthId } : {}),
        correlationId,
      });
      if (delivery.outcome !== 'accepted') {
        this.logger.warn(`Password-updated email was not accepted (correlation ${correlationId}, `
          + `outcome ${delivery.outcome}${delivery.safeCode ? `, code ${delivery.safeCode}` : ''})`);
      }
    });
  }

  /** A patient's first name and Health ID as an email names them, or undefined without a valid Health ID. */
  private patientNaming(firstName: string | null | undefined, hidCode: string | null | undefined): PatientNaming | undefined {
    if (!hidCode || !/^HID-[A-HJ-NP-Z2-9]{6,32}$/.test(hidCode)) return undefined;
    const name = emailFirstName(firstName);
    return { ...(name ? { firstName: name } : {}), healthId: hidCode };
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
