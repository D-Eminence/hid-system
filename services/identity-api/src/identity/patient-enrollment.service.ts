import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt,
  randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import * as argon2 from 'argon2';
import type { PoolClient, QueryResultRow } from 'pg';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { HidCodeGenerator } from './hid-code-generator.service';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { PUBLIC_PATIENT_IDENTITY_PROVIDER, type PublicPatientIdentityProvider,
  type VerifiedPublicPatientIdentity } from './patient-enrollment.provider';

interface EnrollmentRow extends QueryResultRow {
  id: string; nin_lookup_hmac: string; request_hmac: string; token_hmac: string;
  patient_id: string | null;
  state: 'verify_contact' | 'set_password' | 'active'; expires_at: Date;
  profile_ciphertext: Buffer; contact_ciphertext: Buffer | null;
  contact_hmac: string | null; contact_channel: 'phone' | 'email' | null;
  contact_verified_at: Date | null;
}
interface ChallengeRow extends QueryResultRow {
  id: string; verifier_hmac: string; expires_at: Date; created_at: Date;
  failed_attempts: number; max_attempts: number; channel: 'phone' | 'email';
  recipient_hmac: string; delivery_outcome: string;
}
type ContactChannel = 'phone' | 'email';
const localOtpKey = randomBytes(32);
const ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PatientEnrollmentService {
  private readonly env = getEnvironment();
  private readonly otpKey = this.env.OTP_HMAC_KEY_B64
    ? Buffer.from(this.env.OTP_HMAC_KEY_B64, 'base64') : localOtpKey;

  constructor(private readonly database: DatabaseService,
    private readonly ninProtector: NinIdentifierProtector,
    @Inject(PUBLIC_PATIENT_IDENTITY_PROVIDER) private readonly provider: PublicPatientIdentityProvider,
    private readonly notification: NotificationOtpClient,
    private readonly hidCodes: HidCodeGenerator) {}

  async start(nin: string, idempotencyKey: string, remoteIp: string | undefined,
    correlationId: string) {
    this.assertConfigured();
    if (!/^\d{11}$/.test(nin)) throw new DomainProblem(400, 'NIN_INVALID', 'An 11-digit NIN is required');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      throw new DomainProblem(400, 'IDEMPOTENCY_KEY_INVALID', 'A valid idempotency key is required');
    }
    const lookupHmac = this.ninProtector.lookup(nin);
    const requestHmac = this.hmac('patient-enrollment-request', idempotencyKey);
    const token = this.hmacBuffer('patient-enrollment-cookie', idempotencyKey).toString('base64url');
    const tokenHmac = this.hmac('patient-enrollment-token', token);
    const ipHmac = this.networkHmac(remoteIp);

    const preflight = await this.database.withSystemTransaction(correlationId, async (client) => {
      await client.query('select identity.prune_expired_public_patient_enrollments()');
      const limited = await this.consumeRate(client, 'ip', ipHmac, this.env.OTP_RATE_MAX_REQUESTS);
      const bound = await client.query<{ bound: boolean }>(
        'select identity.public_patient_nin_already_bound($1) as bound', [lookupHmac]);
      const query = await client.query<EnrollmentRow>(
        'select * from identity.public_patient_enrollments where nin_lookup_hmac = $1', [lookupHmac]);
      const keyed = await client.query<EnrollmentRow>(
        'select * from identity.public_patient_enrollments where request_hmac = $1', [requestHmac]);
      return { limited, bound: bound.rows[0]?.bound === true, existing: query.rows[0],
        keyed: keyed.rows[0] };
    });
    if (preflight.limited) throw this.rateLimited();
    if (preflight.keyed && !this.equalHex(preflight.keyed.nin_lookup_hmac, lookupHmac)) {
      throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED',
        'This enrollment retry key belongs to a different request');
    }
    if (preflight.bound) throw this.duplicate();
    const existing = preflight.existing;
    if (existing?.state === 'active') throw this.duplicate();
    if (existing && existing.expires_at.getTime() > Date.now()) {
      if (!this.equalHex(existing.request_hmac, requestHmac)) throw this.duplicate();
      return { cookie: `${existing.id}.${token}`, progress: await this.progress(existing, correlationId) };
    }

    // Verification is not retried after transport or result failures. The
    // adapter may replay once after an explicit 401 with a fresh access token.
    // Unique HMAC constraints settle concurrent starts.
    const verified = this.validateIdentity(await this.provider.verifyNin(nin), nin);
    const id = existing?.id ?? randomUUID();
    const profileJson = JSON.stringify(verified);
    const profileCiphertext = this.encrypt(id, 'profile', profileJson);
    const ninCiphertext = this.encrypt(id, 'nin', nin);
    const profileHash = createHash('sha256').update(profileJson).digest('hex');
    try {
      await this.database.withSystemTransaction(correlationId, async (client) => {
        const bound = await client.query<{ bound: boolean }>(
          'select identity.public_patient_nin_already_bound($1) as bound', [lookupHmac]);
        if (bound.rows[0]?.bound) throw this.duplicate();
        if (existing) {
          const updated = await client.query(
            `update identity.public_patient_enrollments set
               nin_ciphertext=$2, profile_ciphertext=$3, profile_sha256=$4,
               provider_reference=$5, request_hmac=$6, token_hmac=$7,
               state='verify_contact', contact_channel=null, contact_hmac=null,
               contact_ciphertext=null, contact_verified_at=null, verified_challenge_id=null,
               created_at=clock_timestamp(), updated_at=clock_timestamp(),
               expires_at=clock_timestamp()+interval '24 hours', row_version=row_version+1
             where id=$1 and state <> 'active' and expires_at <= clock_timestamp()`,
            [id, ninCiphertext, profileCiphertext, profileHash, verified.providerReference,
              requestHmac, tokenHmac]);
          if (updated.rowCount !== 1) throw this.duplicate();
          await client.query(
            `update identity.public_patient_enrollment_otps set invalidated_at=clock_timestamp(),
               invalidation_reason='expired' where enrollment_id=$1
               and consumed_at is null and invalidated_at is null`, [id]);
        } else {
          await client.query(
            `insert into identity.public_patient_enrollments
             (id,nin_lookup_hmac,nin_last4,nin_ciphertext,profile_ciphertext,profile_sha256,
              key_version,provider_reference,request_hmac,token_hmac)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [id, lookupHmac, nin.slice(-4), ninCiphertext, profileCiphertext, profileHash,
              this.env.NIN_KEY_VERSION, verified.providerReference, requestHmac, tokenHmac]);
        }
      });
    } catch (error) { throw this.mapDatabaseError(error); }
    return { cookie: `${id}.${token}`, progress: { stage: 'verify_contact' as const,
      expiresAt: new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString() } };
  }

  async current(cookie: string | undefined, correlationId: string) {
    const row = await this.requireEnrollment(cookie, correlationId);
    return this.progress(row, correlationId);
  }

  async startContact(cookie: string | undefined, channel: ContactChannel, rawContact: string,
    remoteIp: string | undefined, correlationId: string) {
    this.assertConfigured();
    const enrollment = await this.requireEnrollment(cookie, correlationId);
    if (enrollment.state !== 'verify_contact') throw new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID',
      'This enrollment is not waiting for contact verification');
    const contact = this.normalizeContact(channel, rawContact);
    const recipientHmac = this.hmac('patient-enrollment-recipient', channel, contact);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const challengeId = randomUUID();
    const limited = await this.database.withSystemTransaction(correlationId, async (client) => {
      const ipLimited = await this.consumeRate(client, 'ip', this.networkHmac(remoteIp),
        this.env.OTP_RATE_MAX_REQUESTS * 3);
      const recipientLimited = await this.consumeRate(client, 'recipient', recipientHmac,
        this.env.OTP_RATE_MAX_REQUESTS);
      const enrollmentLimited = await this.consumeRate(client, 'enrollment',
        this.hmac('patient-enrollment-id', enrollment.id),
        this.env.OTP_RATE_MAX_REQUESTS * 3);
      return ipLimited || recipientLimited || enrollmentLimited;
    });
    if (limited) throw this.rateLimited();
    const result = await this.withEnrollmentLock(cookie, correlationId, async (client, row) => {
      if (row.state !== 'verify_contact') throw new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID',
        'This enrollment is not waiting for contact verification');
      const active = (await client.query<ChallengeRow>(
        `select * from identity.public_patient_enrollment_otps where enrollment_id=$1
          and consumed_at is null and invalidated_at is null order by created_at desc limit 1 for update`,
        [row.id])).rows[0];
      if (active && active.created_at.getTime() + this.env.OTP_RESEND_COOLDOWN_SECONDS * 1000 > Date.now()) {
        throw new DomainProblem(429, 'OTP_RESEND_COOLDOWN', 'Wait before requesting another code');
      }
      if (active) await client.query(
        `update identity.public_patient_enrollment_otps set invalidated_at=clock_timestamp(),
           invalidation_reason='resend' where id=$1`, [active.id]);
      const verifierHmac = this.hmac('patient-enrollment-otp', row.id, challengeId, recipientHmac, code);
      await client.query(
        `update identity.public_patient_enrollments set contact_channel=$2, contact_hmac=$3,
          contact_ciphertext=$4, updated_at=clock_timestamp(), row_version=row_version+1 where id=$1`,
        [row.id, channel, recipientHmac, this.encrypt(row.id, 'contact', contact)]);
      await client.query(
        `insert into identity.public_patient_enrollment_otps
         (id,enrollment_id,recipient_hmac,channel,verifier_hmac,verifier_key_version,
          expires_at,max_attempts,request_ip_hmac)
         values($1,$2,$3,$4,$5,$6,clock_timestamp()+($7*interval '1 second'),$8,$9)`,
        [challengeId, row.id, recipientHmac, channel, verifierHmac,
          this.env.OTP_HMAC_KEY_VERSION, this.env.OTP_EXPIRY_SECONDS,
          this.env.OTP_MAX_ATTEMPTS, this.networkHmac(remoteIp)]);
      return { enrollmentId: row.id };
    });
    const delivered = await this.notification.deliver({ challengeId, recipient: contact, code,
      purpose: 'SIGNUP_VERIFY', channel: channel === 'phone' ? 'sms' : 'email', correlationId });
    await this.database.withSystemTransaction(correlationId, (client) => client.query(
      `update identity.public_patient_enrollment_otps set delivery_outcome=$2,
         delivery_provider=$3,
         invalidated_at=case when $2='definitive_failure' then clock_timestamp() else invalidated_at end,
         invalidation_reason=case when $2='definitive_failure' then 'delivery_failed' else invalidation_reason end
       where id=$1 and enrollment_id=$4 and consumed_at is null`,
      [challengeId, delivered.outcome, delivered.provider ?? null, result.enrollmentId]));
    if (delivered.outcome === 'definitive_failure') throw new DomainProblem(503, 'OTP_DELIVERY_UNAVAILABLE',
      'Verification code delivery is unavailable');
    return { challengeId, expiresInSeconds: this.env.OTP_EXPIRY_SECONDS,
      resendAfterSeconds: this.env.OTP_RESEND_COOLDOWN_SECONDS };
  }

  async verifyContact(cookie: string | undefined, challengeId: string, code: string,
    correlationId: string) {
    if (!/^\d{6}$/.test(code)) throw this.invalidCode();
    const result = await this.withEnrollmentLock(cookie, correlationId, async (client, row) => {
      if (row.state !== 'verify_contact') throw this.invalidCode();
      const challenge = (await client.query<ChallengeRow>(
        `select * from identity.public_patient_enrollment_otps where id=$1 and enrollment_id=$2
          and consumed_at is null and invalidated_at is null limit 1 for update`,
        [challengeId, row.id])).rows[0];
      if (!challenge || challenge.expires_at.getTime() <= Date.now()
        || challenge.failed_attempts >= challenge.max_attempts
        || challenge.delivery_outcome === 'definitive_failure'
        || challenge.channel !== row.contact_channel
        || challenge.recipient_hmac !== row.contact_hmac) throw this.invalidCode();
      const supplied = this.hmac('patient-enrollment-otp', row.id, challengeId, challenge.recipient_hmac, code);
      if (!this.equalHex(challenge.verifier_hmac, supplied)) {
        await client.query(
          `update identity.public_patient_enrollment_otps set failed_attempts=failed_attempts+1,
             invalidated_at=case when failed_attempts+1>=max_attempts then clock_timestamp() else null end,
             invalidation_reason=case when failed_attempts+1>=max_attempts then 'attempts_exhausted' else null end
           where id=$1`, [challenge.id]);
        return false;
      }
      await client.query(
        `update identity.public_patient_enrollment_otps set verified_at=clock_timestamp(),
           consumed_at=clock_timestamp() where id=$1`, [challenge.id]);
      await client.query(
        `update identity.public_patient_enrollments set state='set_password',
           contact_verified_at=clock_timestamp(), verified_challenge_id=$2,
           updated_at=clock_timestamp(), row_version=row_version+1 where id=$1`,
        [row.id, challenge.id]);
      return true;
    });
    if (!result) throw this.invalidCode();
    return { stage: 'set_password' as const };
  }

  async activate(cookie: string | undefined, password: string, correlationId: string) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new DomainProblem(400, 'PASSWORD_INVALID', 'Password must be 12–256 characters');
    }
    const row = await this.requireEnrollment(cookie, correlationId);
    if (row.state !== 'set_password' && row.state !== 'active') {
      throw new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID', 'Contact verification is required');
    }
    if (!row.contact_ciphertext) throw new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID',
      'Contact verification is required');
    const profileJson = this.decrypt(row.id, 'profile', row.profile_ciphertext);
    const contact = this.decrypt(row.id, 'contact', row.contact_ciphertext);
    const hash = await argon2.hash(password, { type: argon2.argon2id,
      memoryCost: 65_536, timeCost: 3, parallelism: 1 });
    const tokenHmac = this.cookieTokenHmac(cookie);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const hid = this.hidCodes.generate();
        const result = await this.database.withSystemTransaction(correlationId, (client) =>
          client.query<{ patient_id: string; hid_code: string; account_id: string; replayed: boolean }>(
            'select * from identity.activate_public_patient_enrollment($1,$2,$3,$4,$5,$6)',
            [row.id, tokenHmac, profileJson, contact, hid, hash]));
        const activated = result.rows[0];
        if (!activated) throw new DomainProblem(503, 'ENROLLMENT_ACTIVATION_UNAVAILABLE',
          'Health ID activation is unavailable');
        return { stage: 'active' as const, hidCode: activated.hid_code };
      } catch (error) {
        if (this.databaseErrorCode(error) === '23505'
          && this.databaseConstraint(error) === 'patients_hid_code_ci_uq') continue;
        throw this.mapDatabaseError(error);
      }
    }
    throw new DomainProblem(503, 'ENROLLMENT_ACTIVATION_UNAVAILABLE',
      'Health ID activation is unavailable');
  }

  private async progress(row: EnrollmentRow, correlationId: string) {
    if (row.state === 'active') {
      const result = await this.database.withSystemTransaction(correlationId, (client) =>
        client.query<{ hid_code: string }>(
          'select hid_code from identity.patients where id=$1 and source_system=$2',
          [row.patient_id, 'hid-public-qoreid-enrollment']));
      if (!result.rows[0]) throw new DomainProblem(503, 'ENROLLMENT_EVIDENCE_UNAVAILABLE',
        'Enrollment evidence is unavailable');
      return { stage: 'active' as const, hidCode: result.rows[0].hid_code };
    }
    const base = { stage: row.state, expiresAt: row.expires_at.toISOString(),
      ...(row.contact_channel ? { contactChannel: row.contact_channel } : {}) };
    if (row.state === 'set_password') return base;
    const active = await this.database.withSystemTransaction(correlationId, (client) =>
      client.query<ChallengeRow>(
        `select * from identity.public_patient_enrollment_otps where enrollment_id=$1
           and consumed_at is null and invalidated_at is null
           order by created_at desc limit 1`, [row.id]));
    const challenge = active.rows[0];
    if (!challenge || challenge.expires_at.getTime() <= Date.now()) return base;
    const maskedContact = row.contact_ciphertext
      ? this.mask(row.contact_channel, this.decrypt(row.id, 'contact', row.contact_ciphertext)) : undefined;
    return { ...base, ...(maskedContact ? { maskedContact } : {}), challengeId: challenge.id,
      expiresInSeconds: Math.max(0, Math.floor((challenge.expires_at.getTime() - Date.now()) / 1000)),
      resendAfterSeconds: Math.max(0, Math.floor((challenge.created_at.getTime()
        + this.env.OTP_RESEND_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000)) };
  }

  private async requireEnrollment(cookie: string | undefined, correlationId: string): Promise<EnrollmentRow> {
    const parsed = this.parseCookie(cookie);
    const result = await this.database.withSystemTransaction(correlationId, (client) =>
      client.query<EnrollmentRow>('select * from identity.public_patient_enrollments where id=$1', [parsed.id]));
    const row = result.rows[0];
    if (!row || row.expires_at.getTime() <= Date.now()
      || !this.equalHex(row.token_hmac, this.hmac('patient-enrollment-token', parsed.token))) {
      throw new DomainProblem(404, 'ENROLLMENT_NOT_FOUND', 'No pending enrollment was found');
    }
    return row;
  }

  private async withEnrollmentLock<T>(cookie: string | undefined, correlationId: string,
    operation: (client: PoolClient, row: EnrollmentRow) => Promise<T>): Promise<T> {
    const parsed = this.parseCookie(cookie);
    return this.database.withSystemTransaction(correlationId, async (client) => {
      const row = (await client.query<EnrollmentRow>(
        'select * from identity.public_patient_enrollments where id=$1 for update', [parsed.id])).rows[0];
      if (!row || row.expires_at.getTime() <= Date.now()
        || !this.equalHex(row.token_hmac, this.hmac('patient-enrollment-token', parsed.token))) {
        throw new DomainProblem(404, 'ENROLLMENT_NOT_FOUND', 'No pending enrollment was found');
      }
      return operation(client, row);
    });
  }

  private parseCookie(cookie: string | undefined) {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i
      .exec(cookie ?? '');
    if (!match) throw new DomainProblem(404, 'ENROLLMENT_NOT_FOUND', 'No pending enrollment was found');
    return { id: match[1]!, token: match[2]! };
  }

  private cookieTokenHmac(cookie: string | undefined) {
    return this.hmac('patient-enrollment-token', this.parseCookie(cookie).token);
  }

  private validateIdentity(identity: VerifiedPublicPatientIdentity, nin: string) {
    const validName = (value: unknown): value is string => typeof value === 'string'
      && value.trim().length >= 1 && value.trim().length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
    const validText = (value: unknown, limit: number) => value === undefined
      || (typeof value === 'string' && value.trim().length >= 1
        && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value));
    const residence = identity.residence;
    const validResidence = residence === undefined || (residence !== null
      && typeof residence === 'object' && !Array.isArray(residence)
      && validText(residence.address1, 1000) && residence.address1 !== undefined
      && identity.address === residence.address1
      && validText(residence.town, 120) && validText(residence.lga, 120)
      && validText(residence.state, 120));
    const date = typeof identity.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(identity.dateOfBirth)
      ? new Date(`${identity.dateOfBirth}T00:00:00Z`) : new Date(NaN);
    if (identity.nin !== nin || !validName(identity.firstName) || !validName(identity.lastName)
      || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== identity.dateOfBirth
      || date.getUTCFullYear() < 1900 || date.getTime() > Date.now()
      || !['female', 'male', 'intersex', 'other', 'unknown'].includes(identity.gender)
      || typeof identity.providerReference !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(identity.providerReference)
      || !validText(identity.middleName, 100) || !validText(identity.phoneNumber, 30)
      || !validText(identity.address, 1000) || !validResidence
      || !validText(identity.photo, 131_072)
      || (identity.photo !== undefined && !/^[A-Za-z0-9+/]+={0,2}$/.test(identity.photo))) {
      throw new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID',
        'External verification returned an invalid response');
    }
    return identity;
  }

  private normalizeContact(channel: ContactChannel, value: string) {
    const contact = value.trim();
    if (channel === 'email') {
      const email = contact.toLowerCase();
      if (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
    } else if (channel === 'phone') {
      const phone = /^0\d{10}$/.test(contact) ? `+234${contact.slice(1)}` : contact.replace(/[\s()-]/g, '');
      if (/^\+[1-9]\d{7,14}$/.test(phone)) return phone;
    }
    throw new DomainProblem(400, 'ENROLLMENT_CONTACT_INVALID', 'Enter a valid account contact');
  }

  private mask(channel: ContactChannel | null, value: string) {
    if (channel === 'email') {
      const [local, domain] = value.split('@');
      return `${local?.slice(0, 1) ?? ''}•••@${domain ?? ''}`;
    }
    return `••••${value.slice(-4)}`;
  }

  private async consumeRate(client: PoolClient, scope: 'ip' | 'recipient' | 'enrollment',
    bucket: string, limit: number) {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
      [`public-patient-enrollment-rate:${scope}:${bucket}`]);
    const current = (await client.query<{ window_started_at: Date; request_count: number }>(
      `select window_started_at,request_count from identity.public_patient_enrollment_rates
       where scope=$1 and bucket_hmac=$2 for update`, [scope, bucket])).rows[0];
    const expired = !current || current.window_started_at.getTime()
      + this.env.OTP_RATE_WINDOW_SECONDS * 1000 <= Date.now();
    const next = expired ? 1 : current.request_count + 1;
    await client.query(
      `insert into identity.public_patient_enrollment_rates(scope,bucket_hmac,window_started_at,request_count)
       values($1,$2,clock_timestamp(),$3) on conflict(scope,bucket_hmac) do update set
       window_started_at=case when $4 then clock_timestamp()
         else identity.public_patient_enrollment_rates.window_started_at end,
       request_count=$3`, [scope, bucket, next, expired]);
    return next > limit;
  }

  private networkHmac(remoteIp: string | undefined) {
    if (!remoteIp || isIP(remoteIp) === 0) throw new DomainProblem(503,
      'ENROLLMENT_RATE_LIMIT_UNAVAILABLE', 'Enrollment is temporarily unavailable');
    return this.hmac('patient-enrollment-ip', remoteIp);
  }

  private assertConfigured() {
    if (!this.env.NIN_LOOKUP_HMAC_KEY_B64 || !this.env.NIN_ENCRYPTION_KEY_B64
      || (this.env.NODE_ENV === 'production' && !this.env.OTP_HMAC_KEY_B64)) {
      throw new DomainProblem(503, 'ENROLLMENT_CONFIGURATION_UNAVAILABLE',
        'Patient identity enrollment is temporarily unavailable');
    }
  }

  private encrypt(id: string, purpose: 'nin' | 'profile' | 'contact', value: string) {
    this.assertConfigured();
    const key = Buffer.from(this.env.NIN_ENCRYPTION_KEY_B64!, 'base64');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`identity:public-patient-enrollment:${id}:${purpose}`));
    return Buffer.concat([Buffer.from([1]), nonce,
      cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  }

  private decrypt(id: string, purpose: 'profile' | 'contact', value: Buffer) {
    this.assertConfigured();
    if (value.length < 30 || value[0] !== 1) throw new DomainProblem(503,
      'ENROLLMENT_EVIDENCE_UNAVAILABLE', 'Enrollment evidence is unavailable');
    try {
      const key = Buffer.from(this.env.NIN_ENCRYPTION_KEY_B64!, 'base64');
      const nonce = value.subarray(1, 13);
      const tag = value.subarray(value.length - 16);
      const ciphertext = value.subarray(13, value.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(`identity:public-patient-enrollment:${id}:${purpose}`));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new DomainProblem(503, 'ENROLLMENT_EVIDENCE_UNAVAILABLE', 'Enrollment evidence is unavailable');
    }
  }

  private hmac(...parts: string[]) { return this.hmacBuffer(...parts).toString('hex'); }
  private hmacBuffer(...parts: string[]) {
    return createHmac('sha256', this.otpKey).update(parts.join('\u001f'), 'utf8').digest();
  }
  private equalHex(left: string, right: string) {
    const first = Buffer.from(left, 'hex');
    const second = Buffer.from(right, 'hex');
    return first.length === second.length && first.length === 32 && timingSafeEqual(first, second);
  }
  private invalidCode() { return new DomainProblem(422, 'OTP_INVALID', 'The verification code is invalid or expired'); }
  private rateLimited() { return new DomainProblem(429, 'ENROLLMENT_RATE_LIMITED',
    'Too many enrollment requests; try again later'); }
  private duplicate() { return new DomainProblem(409, 'NIN_ALREADY_REGISTERED',
    'This identity already has a Health ID or a pending enrollment'); }
  private databaseErrorCode(error: unknown) { return typeof error === 'object' && error
    && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
  private databaseConstraint(error: unknown) { return typeof error === 'object' && error
    && 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : undefined; }
  private mapDatabaseError(error: unknown) {
    if (error instanceof DomainProblem) return error;
    const code = this.databaseErrorCode(error);
    if (code === '23505') {
      const constraint = this.databaseConstraint(error);
      if (constraint === 'accounts_email_ci_uq' || constraint === 'patients_phone_hmac_uq'
        || constraint === 'patients_email_hmac_uq') {
        return new DomainProblem(409, 'CONTACT_ALREADY_REGISTERED',
          'This contact is already associated with a Health ID');
      }
      return this.duplicate();
    }
    if (code === '23514') return new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID',
      'Enrollment conditions are not complete');
    if (code === '42501') return new DomainProblem(403, 'ENROLLMENT_DENIED', 'Enrollment is not permitted');
    return new DomainProblem(503, 'ENROLLMENT_UNAVAILABLE', 'Enrollment is temporarily unavailable');
  }
}
