import { type BeforeApplicationShutdown, Inject, Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt,
  randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import * as argon2 from 'argon2';
import type { PoolClient, QueryResultRow } from 'pg';
import { emailFirstName } from '../auth/email-first-name';
import { GoogleAuthenticationService } from '../auth/google-authentication.service';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { consumeRateLimit, rateLimitBlocked, type RateLimitWindow } from '../auth/rate-limit';
import { AFTER_RESPONSE_SHUTDOWN_GRACE_MS, AfterResponseTasks } from '../common/after-response-tasks';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { HidCodeGenerator } from './hid-code-generator.service';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { createContactLookupHmac, normalizePatientPhone } from './contact-lookup';
import type { SignupGender } from './dto/patient-enrollment.dto';
import { enrollmentKeysConfigured } from './enrollment-keys';
import { PUBLIC_PATIENT_IDENTITY_PROVIDER, type PublicPatientIdentityProvider,
  type VerifiedPublicPatientIdentity } from './patient-enrollment.provider';

interface EnrollmentRow extends QueryResultRow {
  /** Null for a sign-up without a NIN (0092). */
  id: string; nin_lookup_hmac: string | null; request_hmac: string; token_hmac: string;
  /** Set only for a sign-up without a NIN (0092): the declared email's contact lookup HMAC. */
  signup_email_lookup_hmac?: string | null;
  key_version: string; profile_sha256: string;
  patient_id: string | null;
  state: 'verify_contact' | 'set_password' | 'active'; expires_at: Date;
  profile_ciphertext: Buffer; contact_ciphertext: Buffer | null;
  contact_hmac: string | null; contact_channel: 'phone' | 'email' | null;
  contact_lookup_hmac: string | null;
  contact_verified_at: Date | null;
  activated_at: Date | null;
  created_at: Date;
}
interface ChallengeRow extends QueryResultRow {
  id: string; verifier_hmac: string; expires_at: Date; created_at: Date;
  failed_attempts: number; max_attempts: number; channel: 'phone' | 'email';
  recipient_hmac: string; delivery_outcome: string;
}
type ContactChannel = 'phone' | 'email';
/** What a sign-up without a NIN declares (POST /identity/patient-enrollments/signup). */
export interface PatientSignupInput {
  firstName: string; lastName: string; email: string; phone: string;
  gender: SignupGender; hospitalCurrentlyUsing?: string;
}
/**
 * Key versions of sign-up rows encrypted with a key derived from the OTP key
 * (HKDF-SHA256), used when NIN_ENCRYPTION_KEY_B64 is not configured: a
 * sign-up never depends on the NIN keys.
 */
const SIGNUP_DERIVED_KEY_PREFIX = 'otp-hkdf:';
const localOtpKey = randomBytes(32);
const ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long after activation the enrollment cookie may show the HID again
 * (GET /current, an activation replay). After it the enrollment answers 404,
 * as an unknown one does, so a shared device does not show the last
 * enrollee's HID to the next person. Activation keeps the cookie, so a reload
 * or a lost response within the window still shows the HID.
 */
const HID_REDISPLAY_WINDOW_MS = 15 * 60 * 1000;
/**
 * How long after the enrollment's first start (a same-key resume does not
 * extend it) GET /current may show the name on the NIN record again, for a
 * reload. After it only a start, which needs the NIN, shows it,
 * so a shared device does not show it to the next person for the
 * enrollment's whole 24 hours.
 */
const RECORD_NAME_REDISPLAY_WINDOW_MS = 15 * 60 * 1000;
/** The account password hash activation stores; the database command checks this form. */
const PASSWORD_HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 };
/** The sign-up phone's refusal (owner decision of 2026-10-28: any country). */
export const SIGNUP_PHONE_MESSAGE = 'Enter your phone number with its country code, like +44 7700 900123, '
  + 'or a Nigerian number like 08012345678.';

@Injectable()
export class PatientEnrollmentService implements BeforeApplicationShutdown {
  private readonly env = getEnvironment();
  private readonly otpKey = this.env.OTP_HMAC_KEY_B64
    ? Buffer.from(this.env.OTP_HMAC_KEY_B64, 'base64') : localOtpKey;
  private replayPlaceholder?: Promise<string>;
  private readonly logger = new Logger(PatientEnrollmentService.name);
  /** The welcome email: sent after the activation answers, never waited for. */
  private readonly welcomes = new AfterResponseTasks(this.logger,
    'Health ID welcome email could not be sent');

  constructor(private readonly database: DatabaseService,
    private readonly ninProtector: NinIdentifierProtector,
    @Inject(PUBLIC_PATIENT_IDENTITY_PROVIDER) private readonly provider: PublicPatientIdentityProvider,
    private readonly notification: NotificationOtpClient,
    private readonly hidCodes: HidCodeGenerator,
    private readonly google: GoogleAuthenticationService) {}

  /** Waits for the welcome emails started so far, and any started meanwhile. */
  settleWelcomeEmails(): Promise<void> {
    return this.welcomes.settle();
  }

  /** Lets a welcome email in flight finish before the process stops. */
  beforeApplicationShutdown(): Promise<void> {
    return this.welcomes.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS);
  }

  /**
   * `open`: whether a sign-up without a NIN (POST signup) would now pass the
   * checks it makes before it reads anything: its keys and the contact lookup
   * readiness; it never depends on QoreID or the NIN keys. `signup: true` says
   * this build serves POST signup. `ninStart`: whether the NIN-first start
   * would pass its checks (the enrollment keys, the QoreID gate, a runtime
   * pause included, and the database's readiness). It reads no NIN, cookie or
   * rate bucket and writes nothing; per-request refusals (rate limits, a
   * registered email, phone or NIN) are not predicted.
   */
  async availability(correlationId: string): Promise<{ open: boolean; signup: true; ninStart: boolean }> {
    const signupConfigured = this.signupConfigured();
    const ninConfigured = this.configured() && await this.provider.isAvailable();
    if (!signupConfigured && !ninConfigured) return { open: false, signup: true, ninStart: false };
    return this.database.withSystemTransaction(correlationId, async (client) => {
      const contactReady = signupConfigured ? (await client.query<{ ready: boolean }>(
        'select identity.patient_contact_lookup_ready() as ready')).rows[0]?.ready === true : false;
      const ninReady = ninConfigured ? (await client.query<{ ready: boolean }>(
        'select identity.public_patient_enrollment_ready() as ready')).rows[0]?.ready === true : false;
      return { open: contactReady, signup: true as const, ninStart: ninReady };
    });
  }

  /**
   * Sign-up without a NIN (owner decision of 2026-10-27, as hid-1.0): stores
   * the declared profile in a pending enrollment (0092), sets the enrollment
   * cookie through `setCookie` as soon as the enrollment exists, and sends a
   * code to the declared email at once (SIGNUP_VERIFY). A retry with the same
   * Idempotency-Key and the same declaration resumes the same enrollment.
   */
  async signup(input: PatientSignupInput, idempotencyKey: string, remoteIp: string | undefined,
    correlationId: string, setCookie: (cookie: string) => void) {
    this.assertSignupConfigured();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      throw new DomainProblem(400, 'IDEMPOTENCY_KEY_INVALID', 'A valid idempotency key is required');
    }
    const declared = this.declaredProfile(input);
    const emailLookup = createContactLookupHmac('email', declared.email);
    const phoneLookup = createContactLookupHmac('phone', declared.phone);
    const requestHmac = this.hmac('patient-enrollment-request', idempotencyKey);
    const token = this.hmacBuffer('patient-enrollment-cookie', idempotencyKey).toString('base64url');
    const tokenHmac = this.hmac('patient-enrollment-token', token);
    const ipHmac = this.networkHmac(remoteIp);
    const profileJson = JSON.stringify(declared);
    const profileHash = createHash('sha256').update(profileJson).digest('hex');

    const preflight = await this.database.withSystemTransaction(correlationId, async (client) => {
      await client.query('select identity.prune_expired_public_patient_enrollments()');
      const limited = await this.consumeRate(client, 'ip', ipHmac, this.env.OTP_RATE_MAX_REQUESTS);
      const keyed = await client.query<EnrollmentRow>(
        'select * from identity.public_patient_enrollments where request_hmac = $1', [requestHmac]);
      return { limited, keyed: keyed.rows[0] };
    });
    if (preflight.limited) throw this.rateLimited();
    let id: string;
    if (preflight.keyed) {
      const keyed = preflight.keyed;
      // The same page retrying its own sign-up resumes it; anything else
      // holding this key (a NIN start, another declaration, an activated
      // enrollment) is refused.
      if (keyed.nin_lookup_hmac !== null || keyed.state === 'active'
        || !keyed.signup_email_lookup_hmac || !this.equalHex(keyed.signup_email_lookup_hmac, emailLookup)
        || !this.equalHex(keyed.profile_sha256, profileHash)
        || !this.equalHex(keyed.token_hmac, tokenHmac)) {
        throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED',
          'This enrollment retry key belongs to a different request');
      }
      id = keyed.id;
    } else {
      id = randomUUID();
      const encryption = this.signupEncryption();
      let outcome: string | undefined;
      try {
        outcome = await this.database.withSystemTransaction(correlationId, async (client) =>
          (await client.query<{ outcome: string }>(
            `select identity.start_public_patient_signup($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as outcome`,
            [id, requestHmac, tokenHmac, declared.email, emailLookup, phoneLookup,
              this.encryptWith(encryption.key, id, 'phone', declared.phone),
              this.encryptWith(encryption.key, id, 'profile', profileJson), profileHash,
              encryption.version])).rows[0]?.outcome);
      } catch (error) {
        if (this.databaseErrorCode(error) === '23505') throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED',
          'This enrollment retry key belongs to a different request');
        throw this.mapDatabaseError(error);
      }
      if (outcome === 'email_registered') throw this.emailAlreadyRegistered();
      if (outcome === 'phone_registered') throw this.phoneAlreadyRegistered();
      if (outcome !== 'started') throw new DomainProblem(503, 'ENROLLMENT_UNAVAILABLE',
        'Enrollment is temporarily unavailable');
    }
    const cookie = `${id}.${token}`;
    setCookie(cookie);
    let row = await this.requireEnrollment(cookie, correlationId);
    if (row.state === 'verify_contact') {
      const progress = await this.progress(row, correlationId);
      if ('challengeId' in progress && progress.challengeId) return { cookie, progress };
      await this.startContact(cookie, 'email', declared.email, remoteIp, correlationId);
      row = await this.requireEnrollment(cookie, correlationId);
    }
    return { cookie, progress: await this.progress(row, correlationId) };
  }

  async start(nin: string, idempotencyKey: string, remoteIp: string | undefined,
    correlationId: string, googleCookie?: string) {
    this.assertConfigured();
    if (!/^\d{11}$/.test(nin)) throw new DomainProblem(400, 'NIN_INVALID', 'An 11-digit NIN is required');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      throw new DomainProblem(400, 'IDEMPOTENCY_KEY_INVALID', 'A valid idempotency key is required');
    }
    // The QoreID gate comes before anything that reads the registry: while it
    // is closed, a bound, a pending and an unknown NIN get the same 503, and no
    // rate bucket is charged. A same-key resume is refused too; GET /current
    // still answers with the cookie.
    await this.provider.assertAvailable();
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
      const readiness = await client.query<{ ready: boolean }>(
        'select identity.public_patient_enrollment_ready() as ready');
      const query = await client.query<EnrollmentRow>(
        'select * from identity.public_patient_enrollments where nin_lookup_hmac = $1', [lookupHmac]);
      const keyed = await client.query<EnrollmentRow>(
        'select * from identity.public_patient_enrollments where request_hmac = $1', [requestHmac]);
      return { limited, ready: readiness.rows[0]?.ready === true,
        bound: bound.rows[0]?.bound === true, existing: query.rows[0],
        keyed: keyed.rows[0] };
    });
    if (preflight.limited) throw this.rateLimited();
    if (!preflight.ready) throw this.reconciliationRequired();
    // The key of an enrollment already activated is refused as reused, before
    // the duplicate checks: only the page that holds it can send it, and the
    // client says that registration was completed.
    if (preflight.keyed && (preflight.keyed.nin_lookup_hmac === null
      || !this.equalHex(preflight.keyed.nin_lookup_hmac, lookupHmac)
      || preflight.keyed.state === 'active')) {
      throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED',
        'This enrollment retry key belongs to a different request');
    }
    if (preflight.bound) throw this.duplicate();
    const existing = preflight.existing;
    if (existing?.state === 'active') throw this.duplicate();
    if (existing && existing.expires_at.getTime() > Date.now()) {
      if (!this.equalHex(existing.request_hmac, requestHmac)) throw this.duplicate();
      if (googleCookie) {
        await this.database.withSystemTransaction(correlationId, (client) =>
          this.google.bindPendingInTransaction(client, googleCookie, existing.id, tokenHmac));
      }
      return { cookie: `${existing.id}.${token}`, progress: await this.progress(existing, correlationId, true) };
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
        const readiness = await client.query<{ ready: boolean }>(
          'select identity.public_patient_enrollment_ready() as ready');
        if (readiness.rows[0]?.ready !== true) throw this.reconciliationRequired();
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
        if (googleCookie) await this.google.bindPendingInTransaction(client, googleCookie, id, tokenHmac);
      });
    } catch (error) { throw this.mapDatabaseError(error); }
    const recordName = this.recordName(verified);
    return { cookie: `${id}.${token}`, progress: { stage: 'verify_contact' as const,
      expiresAt: new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString(),
      googleOnboardingRequired: Boolean(googleCookie), ...(recordName ? { recordName } : {}) } };
  }

  async current(cookie: string | undefined, correlationId: string) {
    const row = await this.requireEnrollment(cookie, correlationId);
    return this.progress(row, correlationId, row.created_at instanceof Date
      && row.created_at.getTime() + RECORD_NAME_REDISPLAY_WINDOW_MS > Date.now());
  }

  async bindGoogle(cookie: string | undefined, googleCookie: string | undefined,
    correlationId: string) {
    if (!googleCookie) throw new DomainProblem(404, 'GOOGLE_ONBOARDING_NOT_FOUND',
      'No pending Google onboarding was found');
    await this.withEnrollmentLock(cookie, correlationId, async (client, row) => {
      if (row.state === 'active') throw new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID',
        'This enrollment is already active');
      await this.google.bindPendingInTransaction(client, googleCookie, row.id, row.token_hmac);
    });
    return { bound: true as const };
  }

  async startContact(cookie: string | undefined, channel: ContactChannel, rawContact: string,
    remoteIp: string | undefined, correlationId: string) {
    const enrollment = await this.requireEnrollment(cookie, correlationId);
    const signup = this.isSignup(enrollment);
    if (signup) this.assertSignupConfigured(); else this.assertConfigured();
    if (enrollment.state !== 'verify_contact') throw new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID',
      'This enrollment is not waiting for contact verification');
    const contact = this.normalizeContact(channel, rawContact);
    const lookupHmac = createContactLookupHmac(channel, contact);
    // A sign-up verifies the email it declared, and only that one.
    if (signup && (channel !== 'email'
      || !this.equalHex(enrollment.signup_email_lookup_hmac ?? '', lookupHmac))) {
      throw new DomainProblem(400, 'ENROLLMENT_CONTACT_MISMATCH',
        'Use the email address you signed up with');
    }
    const recipientHmac = this.hmac('patient-enrollment-recipient', channel, contact);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const challengeId = randomUUID();
    const preflight = await this.database.withSystemTransaction(correlationId, async (client) => {
      const ipLimited = await this.consumeRate(client, 'ip', this.networkHmac(remoteIp),
        this.env.OTP_RATE_MAX_REQUESTS * 3);
      const recipientLimited = await this.consumeRate(client, 'recipient', recipientHmac,
        this.env.OTP_RATE_MAX_REQUESTS);
      const enrollmentLimited = await this.consumeRate(client, 'enrollment',
        this.hmac('patient-enrollment-id', enrollment.id),
        this.env.OTP_RATE_MAX_REQUESTS * 3);
      // A recipient whose code failure budget is spent gets no code: none
      // could be verified before the block ends. A read; it takes no lock.
      const failureBlocked = await rateLimitBlocked(client, 'recipient',
        this.contactFailureBucket(recipientHmac));
      const readiness = await client.query<{ ready: boolean }>(signup
        ? 'select identity.patient_contact_lookup_ready() as ready'
        : 'select identity.public_patient_enrollment_ready() as ready');
      const contactBound = await client.query<{ bound: boolean }>(
        'select identity.public_patient_contact_already_bound($1,$2) as bound',
        [channel, lookupHmac]);
      return { limited: ipLimited || recipientLimited || enrollmentLimited || failureBlocked,
        ready: readiness.rows[0]?.ready === true, contactBound: contactBound.rows[0]?.bound === true };
    });
    if (preflight.limited) throw this.rateLimited();
    if (!preflight.ready) throw this.reconciliationRequired();
    if (preflight.contactBound) throw signup ? this.emailAlreadyRegistered() : this.contactAlreadyRegistered();
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
          contact_lookup_hmac=$4, contact_ciphertext=$5,
          updated_at=clock_timestamp(), row_version=row_version+1 where id=$1`,
        [row.id, channel, recipientHmac, lookupHmac, this.encrypt(row.id, 'contact', contact, row.key_version)]);
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
      // One failure budget per recipient, across its challenges and
      // enrollments, so that a resend or a new enrollment naming the same
      // contact does not bring five more guesses. Keyed by the recipient HMAC,
      // never by client IP. Once spent it refuses every code, a correct one
      // too, for one window, before the comparison and without counting.
      // Read, comparison and count run under the bucket's lock, taken after
      // the enrollment and challenge locks; no other challenge is written.
      const failureBucket = this.contactFailureBucket(challenge.recipient_hmac);
      await this.lockContactFailureBucket(client, failureBucket);
      if (await rateLimitBlocked(client, 'recipient', failureBucket)) return false;
      const supplied = this.hmac('patient-enrollment-otp', row.id, challengeId, challenge.recipient_hmac, code);
      if (!this.equalHex(challenge.verifier_hmac, supplied)) {
        await client.query(
          `update identity.public_patient_enrollment_otps set failed_attempts=failed_attempts+1,
             invalidated_at=case when failed_attempts+1>=max_attempts then clock_timestamp() else null end,
             invalidation_reason=case when failed_attempts+1>=max_attempts then 'attempts_exhausted' else null end
           where id=$1`, [challenge.id]);
        await consumeRateLimit(client, 'recipient', failureBucket, this.contactFailureWindow());
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

  async activate(cookie: string | undefined, password: string, correlationId: string,
    googleCookie?: string) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new DomainProblem(400, 'PASSWORD_INVALID', 'Password must be 12–256 characters');
    }
    const row = await this.requireEnrollment(cookie, correlationId);
    if (row.state !== 'set_password' && row.state !== 'active') {
      throw new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID', 'Contact verification is required');
    }
    if (!row.contact_ciphertext) throw new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID',
      'Contact verification is required');
    // Activations and replays share one budget per enrollment, charged only
    // after the cookie has proved the enrollment, so a guessed enrollment id
    // cannot spend another browser's. Every attempt from here counts, whatever
    // its outcome (one that fails later may already have hashed), so the budget
    // is the contact step's per-enrollment size, leaving room for transient
    // failures. Its own bucket: not the contact step's.
    const limited = await this.database.withSystemTransaction(correlationId, (client) =>
      this.consumeRate(client, 'enrollment', this.hmac('patient-enrollment-activate', row.id),
        this.env.OTP_RATE_MAX_REQUESTS * 3));
    if (limited) throw this.rateLimited();
    const signup = this.isSignup(row);
    const profileJson = this.decrypt(row.id, 'profile', row.profile_ciphertext, row.key_version);
    const contact = this.decrypt(row.id, 'contact', row.contact_ciphertext, row.key_version);
    const contactLookupHmac = createContactLookupHmac(row.contact_channel!, contact);
    // Two first activations that race still hash twice; the command lets one
    // activate and replays the other.
    const hash = row.state === 'active' ? await this.replayPlaceholderHash()
      : await argon2.hash(password, PASSWORD_HASH_OPTIONS);
    const tokenHmac = this.cookieTokenHmac(cookie);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const hid = this.hidCodes.generate();
        const result = await this.database.withSystemTransaction(correlationId, async (client) => {
          // A sign-up without a NIN (0092) has its own activation and no
          // Google onboarding; the NIN activation refuses its row.
          const activated = await client.query<{ patient_id: string; hid_code: string;
            account_id: string; replayed: boolean }>(signup
            ? 'select * from identity.activate_public_patient_signup($1,$2,$3,$4,$5,$6,$7)'
            : 'select * from identity.activate_public_patient_enrollment($1,$2,$3,$4,$5,$6,$7)',
            [row.id, tokenHmac, profileJson, contact, hid, hash, contactLookupHmac]);
          if (!activated.rows[0]) throw new DomainProblem(503, 'ENROLLMENT_ACTIVATION_UNAVAILABLE',
            'Health ID activation is unavailable');
          if (!signup) await this.google.consumePendingInTransaction(client, googleCookie, row.id,
            activated.rows[0].account_id);
          return activated;
        });
        const activated = result.rows[0];
        if (!activated) throw new DomainProblem(503, 'ENROLLMENT_ACTIVATION_UNAVAILABLE',
          'Health ID activation is unavailable');
        // `replayed`: the enrollment was already active, so this call
        // verified no password (it hashed a placeholder). The controller signs
        // in only a first activation, and only it sends the welcome email.
        const replayed = activated.replayed === true;
        if (!replayed) this.sendWelcome(row.contact_channel, contact, profileJson,
          activated.patient_id, activated.hid_code, correlationId);
        return { stage: 'active' as const, hidCode: activated.hid_code, replayed };
      } catch (error) {
        if (this.databaseErrorCode(error) === '23505'
          && this.databaseConstraint(error) === 'patients_hid_code_ci_uq') continue;
        throw this.mapDatabaseError(error);
      }
    }
    throw new DomainProblem(503, 'ENROLLMENT_ACTIVATION_UNAVAILABLE',
      'Health ID activation is unavailable');
  }

  /**
   * The welcome email of a first activation ("Your Health ID is ready"), to
   * the contact the enrollment verified, when it is an email address
   * (production delivers email only). Best-effort: it starts now and the
   * activation does not wait for it; a failure is logged with the correlation
   * id and the outcome only, never the address, name or Health ID.
   */
  private sendWelcome(channel: ContactChannel | null, contact: string, profileJson: string,
    patientId: string, hidCode: string, correlationId: string) {
    if (channel !== 'email') return;
    let firstName: string | undefined;
    try {
      firstName = emailFirstName((JSON.parse(profileJson) as { firstName?: unknown }).firstName);
    } catch {
      firstName = undefined;
    }
    this.welcomes.run(correlationId, async () => {
      const delivery = await this.notification.deliverPatientWelcome({ patientId, recipient: contact,
        ...(firstName ? { firstName } : {}), healthId: hidCode, correlationId });
      if (delivery.outcome !== 'accepted') {
        this.logger.warn(`Health ID welcome email was not accepted (correlation ${correlationId}, `
          + `outcome ${delivery.outcome}${delivery.safeCode ? `, code ${delivery.safeCode}` : ''})`);
      }
    });
  }

  /** `withRecordName`: whether this answer may carry the name on the NIN record (a start, or a reload soon after). */
  private async progress(row: EnrollmentRow, correlationId: string, withRecordName = false) {
    const googleRequirement = await this.database.withSystemTransaction(correlationId, (client) =>
      client.query<{ required: boolean; capability_expires_at: Date | null }>(
        'select * from auth.google_onboarding_enrollment_requirement($1,$2)',
        [row.id, row.token_hmac]));
    const google = googleRequirement.rows[0];
    const googleProgress = {
      googleOnboardingRequired: google?.required === true,
      ...(google?.capability_expires_at instanceof Date
        ? { googleOnboardingExpiresAt: google.capability_expires_at.toISOString() } : {}),
    };
    if (row.state === 'active') {
      const result = await this.database.withSystemTransaction(correlationId, (client) =>
        client.query<{ hid_code: string }>(
          'select hid_code from identity.patients where id=$1 and source_system=$2',
          [row.patient_id, 'hid-public-qoreid-enrollment']));
      if (!result.rows[0]) throw new DomainProblem(503, 'ENROLLMENT_EVIDENCE_UNAVAILABLE',
        'Enrollment evidence is unavailable');
      return { stage: 'active' as const, hidCode: result.rows[0].hid_code, ...googleProgress };
    }
    const recordName = withRecordName && !this.isSignup(row) ? this.storedRecordName(row) : undefined;
    const base = { stage: row.state, expiresAt: row.expires_at.toISOString(),
      ...(row.contact_channel ? { contactChannel: row.contact_channel } : {}),
      ...(recordName ? { recordName } : {}), ...googleProgress };
    if (row.state === 'set_password') return base;
    const active = await this.database.withSystemTransaction(correlationId, (client) =>
      client.query<ChallengeRow>(
        `select * from identity.public_patient_enrollment_otps where enrollment_id=$1
           and consumed_at is null and invalidated_at is null
           order by created_at desc limit 1`, [row.id]));
    const challenge = active.rows[0];
    if (!challenge || challenge.expires_at.getTime() <= Date.now()) return base;
    const maskedContact = row.contact_ciphertext
      ? this.mask(row.contact_channel, this.decrypt(row.id, 'contact', row.contact_ciphertext, row.key_version))
      : undefined;
    return { ...base, ...(maskedContact ? { maskedContact } : {}), challengeId: challenge.id,
      expiresInSeconds: Math.max(0, Math.floor((challenge.expires_at.getTime() - Date.now()) / 1000)),
      resendAfterSeconds: Math.max(0, Math.floor((challenge.created_at.getTime()
        + this.env.OTP_RESEND_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000)) };
  }

  /**
   * The name on the NIN record, as the registry gives it (first, middle and
   * last), so the person can check that the NIN they typed is theirs before
   * they go on (owner decision: the full name). Only a start's answer, and
   * GET /current within 15 minutes of the enrollment's first start, carry it,
   * and only before activation.
   */
  private recordName(identity: { firstName?: unknown; middleName?: unknown; lastName?: unknown }) {
    return [identity.firstName, identity.middleName, identity.lastName]
      .filter((part): part is string => typeof part === 'string')
      .map((part) => part.trim().replace(/\s+/g, ' '))
      .filter(Boolean).join(' ') || undefined;
  }

  /** The stored enrollment's record name; left out, never a failure, if the profile cannot be read. */
  private storedRecordName(row: EnrollmentRow) {
    try {
      return this.recordName(JSON.parse(this.decrypt(row.id, 'profile', row.profile_ciphertext,
        row.key_version)) as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }

  private async requireEnrollment(cookie: string | undefined, correlationId: string): Promise<EnrollmentRow> {
    const parsed = this.parseCookie(cookie);
    const result = await this.database.withSystemTransaction(correlationId, (client) =>
      client.query<EnrollmentRow>('select * from identity.public_patient_enrollments where id=$1', [parsed.id]));
    const row = result.rows[0];
    if (!row || row.expires_at.getTime() <= Date.now() || this.redisplayEnded(row)
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
      if (!row || row.expires_at.getTime() <= Date.now() || this.redisplayEnded(row)
        || !this.equalHex(row.token_hmac, this.hmac('patient-enrollment-token', parsed.token))) {
        throw new DomainProblem(404, 'ENROLLMENT_NOT_FOUND', 'No pending enrollment was found');
      }
      return operation(client, row);
    });
  }

  /** An active enrollment shows its HID for 15 minutes after activation, then is gone. */
  private redisplayEnded(row: EnrollmentRow) {
    return row.state === 'active' && (!(row.activated_at instanceof Date)
      || row.activated_at.getTime() + HID_REDISPLAY_WINDOW_MS <= Date.now());
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
    // A residence the record gives in part keeps the parts it gives.
    const residence = identity.residence;
    const validResidence = (residence === undefined && identity.address === undefined) || (residence !== null
      && typeof residence === 'object' && !Array.isArray(residence)
      && validText(residence.address1, 1000) && identity.address === residence.address1
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

  /**
   * The contact-code failure bucket in `auth.otp_rate_limits` (scope
   * `recipient`): its own HMAC domain over the recipient HMAC, so it matches
   * neither the stored recipient HMAC nor any OTP recovery bucket. Unlike
   * enrollment's own rate rows (pruned after 48 hours), nothing deletes these
   * rows yet; the prune is a follow-up (DATABASE.md, the 0051 paragraph).
   */
  private contactFailureBucket(recipientHmac: string) {
    return this.hmac('patient-enrollment-contact-failure', recipientHmac);
  }

  /** The MAX-th failure within the window blocks the recipient for one window. */
  private contactFailureWindow(): RateLimitWindow {
    return { windowSeconds: this.env.PATIENT_ENROLLMENT_CONTACT_FAILURE_WINDOW_SECONDS,
      maxRequests: this.env.PATIENT_ENROLLMENT_CONTACT_FAILURE_MAX - 1 };
  }

  /**
   * The transaction lock consumeRateLimit takes for the bucket (rate-limit.ts),
   * taken before the blocked read so that concurrent verifications for one
   * recipient cannot all read "not blocked" before any of them has counted.
   */
  private async lockContactFailureBucket(client: PoolClient, bucket: string) {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`otp-rate:recipient:${bucket}`]);
  }

  private networkHmac(remoteIp: string | undefined) {
    if (!remoteIp || isIP(remoteIp) === 0) throw new DomainProblem(503,
      'ENROLLMENT_RATE_LIMIT_UNAVAILABLE', 'Enrollment is temporarily unavailable');
    return this.hmac('patient-enrollment-ip', remoteIp);
  }

  /**
   * What a replay of an active enrollment passes as its password hash. The
   * activation command returns the stored HID before it reads the hash and
   * sets no credential (0058), so a replay costs no argon2id run. A real
   * argon2id hash of random bytes, computed at the first replay, kept for the
   * process and never stored, keeps the argument well formed whatever the
   * command's branch order. A failed computation is tried again next time.
   */
  private replayPlaceholderHash(): Promise<string> {
    this.replayPlaceholder ??= argon2.hash(randomBytes(32), PASSWORD_HASH_OPTIONS)
      .catch((error: unknown) => { this.replayPlaceholder = undefined; throw error; });
    return this.replayPlaceholder;
  }

  private configured(): boolean {
    return enrollmentKeysConfigured(this.env);
  }

  private assertConfigured() {
    if (!this.configured()) {
      throw new DomainProblem(503, 'ENROLLMENT_CONFIGURATION_UNAVAILABLE',
        'Patient identity enrollment is temporarily unavailable');
    }
  }

  /** A NIN enrollment's (or `keyVersion`'s) encryption; a sign-up row's may be the derived key. */
  private encrypt(id: string, purpose: 'nin' | 'profile' | 'contact', value: string, keyVersion?: string) {
    return this.encryptWith(this.encryptionKey(keyVersion), id, purpose, value);
  }

  private encryptWith(key: Buffer, id: string, purpose: 'nin' | 'profile' | 'contact' | 'phone', value: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`identity:public-patient-enrollment:${id}:${purpose}`));
    return Buffer.concat([Buffer.from([1]), nonce,
      cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  }

  private decrypt(id: string, purpose: 'profile' | 'contact', value: Buffer, keyVersion?: string) {
    const key = this.encryptionKey(keyVersion);
    if (value.length < 30 || value[0] !== 1) throw new DomainProblem(503,
      'ENROLLMENT_EVIDENCE_UNAVAILABLE', 'Enrollment evidence is unavailable');
    try {
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

  /**
   * The key of a row's `key_version`: the OTP-derived key for a sign-up row
   * written without the NIN encryption key, else the NIN encryption key (a NIN
   * enrollment needs every enrollment key, as before).
   */
  private encryptionKey(keyVersion?: string): Buffer {
    if (keyVersion?.startsWith(SIGNUP_DERIVED_KEY_PREFIX)) {
      if (keyVersion !== this.derivedKeyVersion()) throw new DomainProblem(503,
        'ENROLLMENT_EVIDENCE_UNAVAILABLE', 'Enrollment evidence is unavailable');
      return this.derivedEncryptionKey();
    }
    if (keyVersion === undefined) this.assertConfigured();
    else if (!this.env.NIN_ENCRYPTION_KEY_B64) this.assertConfigured();
    return Buffer.from(this.env.NIN_ENCRYPTION_KEY_B64!, 'base64');
  }

  private derivedKeyVersion() { return `${SIGNUP_DERIVED_KEY_PREFIX}${this.env.OTP_HMAC_KEY_VERSION}`; }

  private derivedEncryptionKey(): Buffer {
    return Buffer.from(hkdfSync('sha256', this.otpKey, Buffer.alloc(0),
      Buffer.from('hid:public-patient-signup:encryption:v1'), 32));
  }

  /** A sign-up row's key: the NIN encryption key when configured, else the OTP-derived key. */
  private signupEncryption(): { key: Buffer; version: string } {
    if (this.env.NIN_ENCRYPTION_KEY_B64) {
      return { key: Buffer.from(this.env.NIN_ENCRYPTION_KEY_B64, 'base64'), version: this.env.NIN_KEY_VERSION };
    }
    return { key: this.derivedEncryptionKey(), version: this.derivedKeyVersion() };
  }

  /** A sign-up needs the contact lookup key, and in production the OTP key; never QoreID or the NIN keys. */
  private signupConfigured(): boolean {
    return Boolean(this.env.CONTACT_LOOKUP_HMAC_KEY_B64
      && (this.env.NODE_ENV !== 'production' || this.env.OTP_HMAC_KEY_B64)
      && (this.env.NIN_ENCRYPTION_KEY_B64 || this.derivedKeyVersion().length <= 64));
  }

  private assertSignupConfigured() {
    if (!this.signupConfigured()) {
      throw new DomainProblem(503, 'ENROLLMENT_CONFIGURATION_UNAVAILABLE',
        'Patient sign-up is temporarily unavailable');
    }
  }

  private isSignup(row: EnrollmentRow) {
    return row.nin_lookup_hmac === null && typeof row.signup_email_lookup_hmac === 'string';
  }

  /** The declared profile a sign-up stores and activation reads (0092 checks the same rules). */
  private declaredProfile(input: PatientSignupInput) {
    const name = (value: unknown) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    const firstName = name(input.firstName);
    const lastName = name(input.lastName);
    const hospital = name(input.hospitalCurrentlyUsing);
    const invalid = (field: string, message: string) => new DomainProblem(400, 'VALIDATION_FAILED',
      'One or more request fields are invalid.', [{ field, messages: [message] }]);
    const control = /[\x00-\x1f\x7f]/;
    if (!firstName || firstName.length > 80 || control.test(firstName)) throw invalid('firstName', 'Enter your first name (1-80 characters)');
    if (!lastName || lastName.length > 80 || control.test(lastName)) throw invalid('lastName', 'Enter your last name (1-80 characters)');
    if (hospital.length > 120 || control.test(hospital)) throw invalid('hospitalCurrentlyUsing', 'Enter at most 120 characters');
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('email', 'Enter a valid email address');
    // Any country's E.164 number, or a Nigerian local number stored as +234
    // (owner decision of 2026-10-28; 0093 admits it at activation).
    const phone = typeof input.phone === 'string' ? normalizePatientPhone(input.phone) ?? '' : '';
    if (!phone) throw invalid('phone', SIGNUP_PHONE_MESSAGE);
    if (!['male', 'female', 'intersex', 'other', 'unknown'].includes(input.gender)) throw invalid('gender', 'Choose a gender');
    return { kind: 'signup' as const, firstName, lastName, email, phone, gender: input.gender,
      ...(hospital ? { hospitalCurrentlyUsing: hospital } : {}), termsAccepted: true as const };
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
  private contactAlreadyRegistered() { return new DomainProblem(409, 'CONTACT_ALREADY_REGISTERED',
    'This contact is already associated with a Health ID'); }
  private emailAlreadyRegistered() { return new DomainProblem(409, 'PATIENT_EMAIL_ALREADY_REGISTERED',
    'This email address already has a Health ID account. Sign in instead.'); }
  private phoneAlreadyRegistered() { return new DomainProblem(409, 'PATIENT_PHONE_ALREADY_REGISTERED',
    'This phone number already has a Health ID account. Sign in instead.'); }
  private reconciliationRequired() { return new DomainProblem(503, 'ENROLLMENT_RECONCILIATION_REQUIRED',
    'Patient enrollment is temporarily unavailable while identity reconciliation is incomplete'); }
  private databaseErrorCode(error: unknown) { return typeof error === 'object' && error
    && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
  private databaseConstraint(error: unknown) { return typeof error === 'object' && error
    && 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : undefined; }
  private mapDatabaseError(error: unknown) {
    if (error instanceof DomainProblem) return error;
    const code = this.databaseErrorCode(error);
    if (code === '23505') {
      const constraint = this.databaseConstraint(error);
      if (error instanceof Error && error.message === 'PATIENT_CONTACT_ALREADY_BOUND') {
        return this.contactAlreadyRegistered();
      }
      if (error instanceof Error && error.message === 'PATIENT_EMAIL_ALREADY_BOUND') return this.emailAlreadyRegistered();
      if (error instanceof Error && error.message === 'PATIENT_PHONE_ALREADY_BOUND') return this.phoneAlreadyRegistered();
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
    if (code === '55000') return this.reconciliationRequired();
    return new DomainProblem(503, 'ENROLLMENT_UNAVAILABLE', 'Enrollment is temporarily unavailable');
  }
}
