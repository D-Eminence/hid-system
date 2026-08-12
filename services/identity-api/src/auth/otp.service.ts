import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { RecoveryOtpPurpose } from './dto/otp.dto';
import { NotificationOtpClient, type OtpDeliveryOutcome } from './notification-otp.client';

interface AccountRow { id: string; email: string; }
interface ActiveChallengeRow { id: string; created_at: Date; }
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

export function generateSixDigitOtp(draw: (minimum: number, maximum: number) => number = randomInt): string {
  return draw(0, 1_000_000).toString().padStart(6, '0');
}

@Injectable()
export class OtpService {
  private readonly environment = getEnvironment();
  private readonly key = this.environment.OTP_HMAC_KEY_B64
    ? Buffer.from(this.environment.OTP_HMAC_KEY_B64, 'base64') : undefined;

  constructor(
    private readonly database: DatabaseService,
    private readonly notification: NotificationOtpClient,
  ) {}

  async start(input: {
    identifier: string;
    purpose: RecoveryOtpPurpose;
    remoteIp?: string;
    correlationId: string;
  }): Promise<{
    accepted: true;
    challengeId: string;
    deliveryChannels: ['email'];
    expiresInSeconds: number;
    resendAfterSeconds: number;
  }> {
    this.assertConfigured();
    const identifier = input.identifier.trim();
    const ipHmac = this.hmac('ip', input.remoteIp ?? 'unavailable');
    const code = generateSixDigitOtp();
    const candidateChallengeId = randomUUID();

    const challenge = await this.database.withSystemTransaction(input.correlationId, async (client): Promise<
      { kind: 'challenge'; id: string; email: string }
      | { kind: 'none' }
      | { kind: 'rate_limited' }
      | { kind: 'cooldown'; id: string }
    > => {
      const account = (await client.query<AccountRow>(
        `select account.id::text, lower(account.email)::text as email
           from auth.accounts account
           left join identity.patients patient on patient.account_id = account.id
          where account.status in ('active', 'pending_reset')
            and (lower(account.email) = lower($1) or upper(patient.hid_code) = upper($1))
          order by case when lower(account.email) = lower($1) then 0 else 1 end
          limit 1`,
        [identifier],
      )).rows[0];
      const recipientHmac = this.hmac('recipient', account?.email ?? identifier.toLowerCase());
      const recipientLimited = await this.consumeRateLimit(client, 'recipient', recipientHmac);
      const ipLimited = await this.consumeRateLimit(client, 'ip', ipHmac);
      const accountLimited = account
        ? await this.consumeRateLimit(client, 'account', this.hmac('account', account.id)) : false;
      if (recipientLimited || ipLimited || accountLimited) return { kind: 'rate_limited' };

      const active = (await client.query<ActiveChallengeRow>(
        `select id::text, created_at from auth.otp_challenges
          where account_id = $1 and purpose = $2
            and consumed_at is null and invalidated_at is null
          order by created_at desc limit 1 for update`,
        [account?.id ?? null, input.purpose],
      )).rows[0];
      if (active && active.created_at.getTime() + this.environment.OTP_RESEND_COOLDOWN_SECONDS * 1000 > Date.now()) {
        return { kind: 'cooldown', id: active.id };
      }
      if (!account) return { kind: 'none' };
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
           verifier_key_version, expires_at, max_attempts, request_ip_hmac
         ) values ($1, $2, $3, $4, 'email', $5, $6,
           clock_timestamp() + ($7 * interval '1 second'), $8, $9)`,
        [candidateChallengeId, account.id, recipientHmac, input.purpose, verifierHmac,
          this.environment.OTP_HMAC_KEY_VERSION, this.environment.OTP_EXPIRY_SECONDS,
          this.environment.OTP_MAX_ATTEMPTS, ipHmac],
      );
      return { kind: 'challenge', id: candidateChallengeId, email: account.email };
    });

    if (challenge.kind === 'rate_limited') throw this.rateLimited();
    if (challenge.kind === 'challenge') {
      const delivery = await this.notification.deliver({
        challengeId: challenge.id, recipient: challenge.email, code, purpose: input.purpose,
        correlationId: input.correlationId,
      });
      await this.recordDelivery(challenge.id, delivery);
    }

    return {
      accepted: true,
      challengeId: challenge.kind === 'challenge' || challenge.kind === 'cooldown'
        ? challenge.id : candidateChallengeId,
      deliveryChannels: ['email'],
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
          where challenge.id = $1 and challenge.purpose = $2
            and challenge.verified_at is null
            and challenge.consumed_at is null and challenge.invalidated_at is null
          limit 1 for update`,
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
        `select id::text, account_id::text, completion_token_hmac::text, completion_expires_at
           from auth.otp_challenges
          where id = $1 and purpose = $2 and verified_at is not null
            and consumed_at is null and invalidated_at is null
          limit 1 for update`,
        [input.challengeId, input.purpose],
      )).rows[0];
      if (!challenge || challenge.completion_expires_at.getTime() <= Date.now()
        || !this.equalHex(challenge.completion_token_hmac, suppliedTokenHmac)) return 'invalid' as const;

      const passwordHash = await argon2.hash(input.newPassword, {
        type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1,
      });
      await client.query(
        `update auth.accounts
            set password_hash = $2, password_algorithm = 'argon2id',
                password_changed_at = clock_timestamp(), status = 'active',
                token_version = token_version + 1, row_version = row_version + 1,
                updated_at = clock_timestamp()
          where id = $1`,
        [challenge.account_id, passwordHash],
      );
      await client.query(
        `update auth.sessions set revoked_at = clock_timestamp(),
            revocation_reason = 'password_recovered_with_otp', row_version = row_version + 1
          where account_id = $1 and revoked_at is null`,
        [challenge.account_id],
      );
      await client.query(
        `update auth.otp_challenges
            set consumed_at = clock_timestamp(), invalidation_reason = null,
                row_version = row_version + 1
          where id = $1`,
        [challenge.id],
      );
      await client.query(
        `insert into identity.patient_assurance_states (
           patient_id, account_id, state, source_system, contact_verified_at
         ) select patient.id, account.id, 'CONTACT_VERIFIED', account.source_system, clock_timestamp()
             from auth.accounts account join identity.patients patient on patient.account_id = account.id
            where account.id = $1
         on conflict (patient_id) do update set
           state = case when identity.patient_assurance_states.state = 'NIN_VERIFIED'
             then 'NIN_VERIFIED' else 'CONTACT_VERIFIED' end,
           contact_verified_at = clock_timestamp(), updated_at = clock_timestamp(),
           row_version = identity.patient_assurance_states.row_version + 1`,
        [challenge.account_id],
      );
      return 'completed' as const;
    });
    if (outcome !== 'completed') throw this.invalid();
    return { completed: true };
  }

  private async consumeRateLimit(client: PoolClient, scope: 'ip' | 'account' | 'recipient', bucket: string): Promise<boolean> {
    const result = await client.query<{ request_count: number; window_started_at: Date; blocked_until: Date | null }>(
      `select request_count, window_started_at, blocked_until
         from auth.otp_rate_limits where scope = $1 and bucket_hmac = $2 for update`,
      [scope, bucket],
    );
    const current = result.rows[0];
    const now = Date.now();
    if (current?.blocked_until && current.blocked_until.getTime() > now) return true;
    const windowExpired = !current
      || current.window_started_at.getTime() + this.environment.OTP_RATE_WINDOW_SECONDS * 1000 <= now;
    const nextCount = windowExpired ? 1 : current.request_count + 1;
    const blocked = nextCount > this.environment.OTP_RATE_MAX_REQUESTS;
    await client.query(
      `insert into auth.otp_rate_limits (
         scope, bucket_hmac, window_started_at, request_count, blocked_until, updated_at
       ) values ($1, $2, clock_timestamp(), 1, null, clock_timestamp())
       on conflict (scope, bucket_hmac) do update set
         window_started_at = case when $3 then clock_timestamp()
           else auth.otp_rate_limits.window_started_at end,
         request_count = $4,
         blocked_until = case when $5 then clock_timestamp() + ($6 * interval '1 second')
           else null end,
         updated_at = clock_timestamp()`,
      [scope, bucket, windowExpired, nextCount, blocked, this.environment.OTP_RATE_WINDOW_SECONDS],
    );
    return blocked;
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
