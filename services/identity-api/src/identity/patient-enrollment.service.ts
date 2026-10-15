import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt,
  randomUUID, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';
import type { PoolClient, QueryResultRow } from 'pg';
import { GoogleAuthenticationService } from '../auth/google-authentication.service';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { consumeRateLimit, rateLimitBlocked, type RateLimitWindow } from '../auth/rate-limit';
import { publicClientNetwork } from '../common/client-network';
import { DomainProblem, PublicDetailProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { HidCodeGenerator } from './hid-code-generator.service';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { createContactLookupHmac } from './contact-lookup';
import { PUBLIC_PATIENT_IDENTITY_PROVIDER, type PublicPatientIdentityProvider,
  type VerifiedPublicPatientIdentity } from './patient-enrollment.provider';
import { quotaNetwork } from './provider-enrollment.service';
import { PATIENT_REGISTRATION_NOT_OPEN } from './qoreid-verification.adapter';
import type { QoreIdNinGender } from './qoreid-verification.types';

interface EnrollmentRow extends QueryResultRow {
  id: string; nin_lookup_hmac: string; request_hmac: string; token_hmac: string;
  patient_id: string | null;
  state: 'verify_holder' | 'verify_contact' | 'set_password' | 'active'; expires_at: Date;
  profile_ciphertext: Buffer; contact_ciphertext: Buffer | null;
  contact_hmac: string | null; contact_channel: 'phone' | 'email' | null;
  contact_lookup_hmac: string | null;
  contact_verified_at: Date | null;
  activated_at: Date | null;
  /** HMAC of the normalized registry phone; written at a holder code send (0093). */
  holder_recipient_hmac: string | null;
}
interface ChallengeRow extends QueryResultRow {
  id: string; verifier_hmac: string; expires_at: Date; created_at: Date;
  failed_attempts: number; max_attempts: number; channel: 'phone' | 'email';
  recipient_hmac: string; delivery_outcome: string; purpose: 'contact' | 'nin_holder';
}
/** The answers of identity.record_public_patient_holder_proof (0093). */
type HolderProofOutcome = 'verified' | 'existing_identity' | 'facility_conflict' | 'route_limited';
/**
 * Normalizes the phone a NIN record lists (ADR-062): spaces, hyphens and
 * brackets dropped, then 0 + 10 digits, 234 + 10 digits or +234 + 10 digits
 * become +234 + 10 digits. Anything else, a non-string included, is
 * unusable: null. The registry phone is never returned or logged.
 */
export function normalizeRegistryPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/[\s()-]/g, '');
  const match = /^(?:0|234|\+234)(\d{10})$/.exec(compact);
  return match ? `+234${match[1]}` : null;
}
/** True when a YYYY-MM-DD date of birth shows an age under 18 today (UTC). */
export function underEighteen(dateOfBirth: unknown, now = new Date()): boolean {
  if (typeof dateOfBirth !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return false;
  const adulthood = `${String(Number(dateOfBirth.slice(0, 4)) + 18).padStart(4, '0')}${dateOfBirth.slice(4)}`;
  return adulthood > now.toISOString().slice(0, 10);
}
type ContactChannel = 'phone' | 'email';
/**
 * The profile fields a NIN record may lack (ADR-061): QoreID may return only
 * the name, the NIN and its reference. The patient enters a missing one at
 * activation; one the record gives can never be replaced.
 */
export type EnrollmentProfileField = 'dateOfBirth' | 'gender';
const PROFILE_FIELDS: readonly EnrollmentProfileField[] = ['dateOfBirth', 'gender'];
const PROFILE_FIELD_NAMES: Record<EnrollmentProfileField, string> = {
  dateOfBirth: 'date of birth', gender: 'gender' };
const GENDERS: readonly QoreIdNinGender[] = ['female', 'male', 'intersex', 'other', 'unknown'];
/** What activation may carry for the fields the NIN record lacks. */
export interface SelfReportedProfile {
  dateOfBirth?: string;
  gender?: QoreIdNinGender;
}
const localOtpKey = randomBytes(32);
const ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Holder codes one enrollment may send over its 24 hours (ADR-062). */
const HOLDER_SENDS_PER_ENROLLMENT = 3;
/** The one patient text of a start whose QoreID lookup could not be completed (ADR-062). */
export const NIN_CHECK_UNAVAILABLE = 'We could not check your NIN now. Try again later.';
/** Every refusal of the holder code send before a code exists (ADR-062). */
export const HOLDER_ROUTE_UNAVAILABLE =
  'We cannot send a code to the phone on your NIN record. Use a participating facility to register.';
/** A spent holder budget (ADR-062). */
export const HOLDER_ROUTE_LIMITED = 'Use a participating facility to register.';
/** A NIN that already has a Health ID, answered only after a holder proof (ADR-062). */
export const NIN_ALREADY_REGISTERED_DETAIL = 'This NIN already has a Health ID. Use account recovery to sign in.';
/**
 * N2(b): how long after activation the enrollment cookie may show the HID
 * again (GET /current, an activation replay). After it the enrollment answers
 * 404, as an unknown one does; 0085 enforces the same in the replay command.
 */
const HID_REDISPLAY_WINDOW_MS = 15 * 60 * 1000;
/**
 * N2(c): how long a contact proof stays valid for activation. An older one is
 * cleared and the contact verified again; 0085 enforces the same in the
 * activation command.
 */
const CONTACT_PROOF_WINDOW_MS = 30 * 60 * 1000;
/** The account password hash activation stores; the database command checks this form. */
const PASSWORD_HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 };

@Injectable()
export class PatientEnrollmentService {
  private readonly env = getEnvironment();
  private readonly otpKey = this.env.OTP_HMAC_KEY_B64
    ? Buffer.from(this.env.OTP_HMAC_KEY_B64, 'base64') : localOtpKey;
  /**
   * What a replay of an active enrollment passes as its password hash. The
   * activation command returns the stored HID before it reads the hash and
   * sets no credential (0058), so a replay costs no argon2id run. A real
   * argon2id hash of random bytes, computed once per process and never
   * stored, keeps the argument well formed whatever the command's branch
   * order.
   */
  private readonly replayPlaceholderHash = argon2.hash(randomBytes(32), PASSWORD_HASH_OPTIONS);

  constructor(private readonly database: DatabaseService,
    private readonly ninProtector: NinIdentifierProtector,
    @Inject(PUBLIC_PATIENT_IDENTITY_PROVIDER) private readonly provider: PublicPatientIdentityProvider,
    private readonly notification: NotificationOtpClient,
    private readonly hidCodes: HidCodeGenerator,
    private readonly google: GoogleAuthenticationService) {}

  /**
   * Whether a start would now pass the checks it makes before it reads a NIN:
   * the enrollment keys, an ownership route and the QoreID gate (FE-4,
   * ADR-062). It reads no NIN, cookie or rate bucket and writes nothing;
   * per-request refusals (rate limits, the lookup quota) are not predicted.
   * online is NIN_HOLDER_SMS_ENABLED; facility is the facility route, which
   * needs the participating facilities of 0094 and is closed until then.
   */
  async availability(): Promise<{ open: boolean; online: boolean; facility: boolean }> {
    const routes = this.ownershipRoutes();
    if (!this.configured() || !(routes.online || routes.facility)) return { open: false, ...routes };
    return { open: await this.provider.isAvailable(), ...routes };
  }

  async start(nin: string, idempotencyKey: string, remoteIp: string | undefined,
    correlationId: string, googleCookie?: string) {
    this.assertConfigured();
    if (!/^\d{11}$/.test(nin)) throw new DomainProblem(400, 'NIN_INVALID', 'An 11-digit NIN is required');
    // Without a route to prove that the person holds the NIN, a lookup leads
    // nowhere (ADR-062): refused before QoreID, for every NIN alike.
    const routes = this.ownershipRoutes();
    if (!routes.online && !routes.facility) {
      throw new PublicDetailProblem(503, 'PATIENT_REGISTRATION_NOT_OPEN', PATIENT_REGISTRATION_NOT_OPEN);
    }
    // The QoreID gate comes before anything that reads the registry (ENR-4):
    // while it is closed every NIN gets the same 503, and no rate bucket is
    // charged. A same-key resume is refused too; GET /current still answers
    // with the cookie.
    await this.provider.assertAvailable();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      throw new DomainProblem(400, 'IDEMPOTENCY_KEY_INVALID', 'A valid idempotency key is required');
    }
    const lookupHmac = this.ninProtector.lookup(nin);
    const requestHmac = this.hmac('patient-enrollment-request', idempotencyKey);
    const token = this.hmacBuffer('patient-enrollment-cookie', idempotencyKey).toString('base64url');
    const tokenHmac = this.hmac('patient-enrollment-token', token);
    const ipHmac = this.networkHmac(remoteIp);
    const networkDigest = this.lookupNetworkDigest(remoteIp);

    // A start never reads whether the NIN has a Health ID or a pending
    // enrollment (ADR-062): that is answered only after a holder proof.
    const preflight = await this.database.withSystemTransaction(correlationId, async (client) => {
      await client.query('select identity.prune_expired_public_patient_enrollments()');
      const limited = await this.consumeRate(client, 'ip', ipHmac,
        this.env.PATIENT_ENROLLMENT_START_RATE_MAX_REQUESTS);
      const readiness = await client.query<{ ready: boolean }>(
        'select identity.public_patient_enrollment_ready() as ready');
      const keyed = await client.query<EnrollmentRow>(
        'select * from identity.public_patient_enrollments where request_hmac = $1', [requestHmac]);
      return { limited, ready: readiness.rows[0]?.ready === true, keyed: keyed.rows[0] };
    });
    if (preflight.limited) throw this.rateLimited();
    if (!preflight.ready) throw this.reconciliationRequired();
    if (preflight.keyed) return this.resume(preflight.keyed, lookupHmac, token, correlationId, googleCookie);

    // Verification is not retried after transport or result failures. The
    // adapter may replay once after an explicit 401 with a fresh access token.
    // The QoreID lookup quota (0085) is charged here only: never for a resume
    // or a refusal above.
    let verified: VerifiedPublicPatientIdentity;
    try {
      verified = this.validateIdentity(await this.provider.verifyNin(nin,
        { correlationId, networkDigest }), nin);
    } catch (error) { throw this.ninCheckUnavailable(error); }
    // Each start inserts its own enrollment; a holder proof removes the others.
    const id = randomUUID();
    const profileJson = JSON.stringify(verified);
    const profileCiphertext = this.encrypt(id, 'profile', profileJson);
    const ninCiphertext = this.encrypt(id, 'nin', nin);
    const profileHash = createHash('sha256').update(profileJson).digest('hex');
    try {
      await this.database.withSystemTransaction(correlationId, async (client) => {
        const readiness = await client.query<{ ready: boolean }>(
          'select identity.public_patient_enrollment_ready() as ready');
        if (readiness.rows[0]?.ready !== true) throw this.reconciliationRequired();
        await client.query(
          `insert into identity.public_patient_enrollments
           (id,nin_lookup_hmac,nin_last4,nin_ciphertext,profile_ciphertext,profile_sha256,
            key_version,provider_reference,request_hmac,token_hmac)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, lookupHmac, nin.slice(-4), ninCiphertext, profileCiphertext, profileHash,
            this.env.NIN_KEY_VERSION, verified.providerReference, requestHmac, tokenHmac]);
        if (googleCookie) await this.google.bindPendingInTransaction(client, googleCookie, id, tokenHmac);
      });
    } catch (error) {
      // A concurrent start with the same key won: resume its enrollment.
      if (this.databaseErrorCode(error) === '23505'
        && this.databaseConstraint(error) === 'public_patient_enrollment_request_uq') {
        const keyed = await this.database.withSystemTransaction(correlationId, (client) =>
          client.query<EnrollmentRow>('select * from identity.public_patient_enrollments where request_hmac = $1',
            [requestHmac]));
        if (keyed.rows[0]) return this.resume(keyed.rows[0], lookupHmac, token, correlationId, googleCookie);
      }
      if (this.databaseErrorCode(error) === '23505') throw this.unavailable();
      throw this.mapDatabaseError(error);
    }
    return { cookie: `${id}.${token}`, progress: { stage: 'verify_holder' as const,
      expiresAt: new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString(),
      googleOnboardingRequired: Boolean(googleCookie),
      online: { available: this.holderRecipient(verified as unknown as Record<string, unknown>) !== null },
      facility: { available: routes.facility } } };
  }

  /** A start with the key of an enrollment already made answers that enrollment, asking QoreID nothing. */
  private async resume(keyed: EnrollmentRow, lookupHmac: string, token: string, correlationId: string,
    googleCookie: string | undefined) {
    if (!this.equalHex(keyed.nin_lookup_hmac, lookupHmac) || keyed.state === 'active') {
      throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED',
        'This enrollment retry key belongs to a different request');
    }
    if (googleCookie) {
      await this.database.withSystemTransaction(correlationId, (client) =>
        this.google.bindPendingInTransaction(client, googleCookie, keyed.id, keyed.token_hmac));
    }
    return { cookie: `${keyed.id}.${token}`, progress: await this.progress(keyed, correlationId) };
  }

  async current(cookie: string | undefined, correlationId: string) {
    const row = await this.requireEnrollment(cookie, correlationId);
    return this.progress(row, correlationId);
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

  /**
   * Sends a one-time code to the phone the NIN record lists (ADR-062). Only at
   * verify_holder, with the online route on and a usable registry phone of an
   * adult; every other refusal has one text. The send and failure budgets are
   * checked here only, by identity.record_public_patient_holder_send under
   * the NIN lock, after the new code is stored: the command counts its
   * attempts with those left on the NIN's other open codes. A spent budget
   * rolls back the code and the recipient. One enrollment sends at most
   * three codes.
   */
  async sendHolderCode(cookie: string | undefined, remoteIp: string | undefined, correlationId: string) {
    this.assertConfigured();
    // Before any database work: without a client network nothing is charged.
    const ipHmac = this.networkHmac(remoteIp);
    const enrollment = await this.requireEnrollment(cookie, correlationId);
    if (!this.ownershipRoutes().online) throw this.holderRouteUnavailable(503);
    if (enrollment.state !== 'verify_holder') throw this.holderRouteUnavailable(409);
    const phone = this.holderRecipient(this.parseProfile(
      this.decrypt(enrollment.id, 'profile', enrollment.profile_ciphertext)));
    if (!phone) throw this.holderRouteUnavailable(409);
    const recipientHmac = this.hmac('patient-enrollment-holder-phone', phone);
    const ninDigest = this.holderNinDigest(enrollment.nin_lookup_hmac);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const challengeId = randomUUID();
    const limited = await this.database.withSystemTransaction(correlationId, (client) =>
      this.consumeRate(client, 'ip', ipHmac, this.env.OTP_RATE_MAX_REQUESTS * 3));
    if (limited) throw this.rateLimited();
    const enrollmentId = await this.withNinLock(cookie, correlationId, async (client, row) => {
      if (row.state !== 'verify_holder') throw this.holderRouteUnavailable(409);
      const active = (await client.query<ChallengeRow>(
        `select * from identity.public_patient_enrollment_otps where enrollment_id=$1 and purpose='nin_holder'
          and consumed_at is null and invalidated_at is null order by created_at desc limit 1 for update`,
        [row.id])).rows[0];
      if (active && active.created_at.getTime() + this.env.OTP_RESEND_COOLDOWN_SECONDS * 1000 > Date.now()) {
        throw new DomainProblem(429, 'OTP_RESEND_COOLDOWN', 'Wait before requesting another code');
      }
      const sent = await client.query<{ sent: number }>(
        `select count(*)::integer as sent from identity.public_patient_enrollment_otps
          where enrollment_id=$1 and purpose='nin_holder'`, [row.id]);
      if (Number(sent.rows[0]?.sent ?? HOLDER_SENDS_PER_ENROLLMENT) >= HOLDER_SENDS_PER_ENROLLMENT) {
        throw this.holderRouteLimited();
      }
      await client.query(
        `update identity.public_patient_enrollments set holder_recipient_hmac=$2,
           updated_at=clock_timestamp(), row_version=row_version+1 where id=$1`, [row.id, recipientHmac]);
      if (active) await client.query(
        `update identity.public_patient_enrollment_otps set invalidated_at=clock_timestamp(),
           invalidation_reason='resend' where id=$1`, [active.id]);
      const verifierHmac = this.hmac('patient-enrollment-holder-otp', row.id, challengeId, recipientHmac, code);
      await client.query(
        `insert into identity.public_patient_enrollment_otps
         (id,enrollment_id,recipient_hmac,channel,purpose,verifier_hmac,verifier_key_version,
          expires_at,max_attempts,request_ip_hmac)
         values($1,$2,$3,'phone','nin_holder',$4,$5,clock_timestamp()+($6*interval '1 second'),$7,$8)`,
        [challengeId, row.id, recipientHmac, verifierHmac, this.env.OTP_HMAC_KEY_VERSION,
          this.env.OTP_EXPIRY_SECONDS, this.env.OTP_MAX_ATTEMPTS, ipHmac]);
      const allowed = await client.query<{ allowed: boolean }>(
        'select identity.record_public_patient_holder_send($1,$2,$3,$4,$5,$6) as allowed',
        [row.id, row.token_hmac, ninDigest, this.env.NIN_HOLDER_SMS_DAILY_MAX,
          this.env.NIN_HOLDER_FAILURES_DAILY_MAX, this.env.NIN_HOLDER_FAILURES_MONTHLY_MAX]);
      // A spent budget rolls back the new code, the resend and the recipient write.
      if (allowed.rows[0]?.allowed !== true) throw this.holderRouteLimited();
      return row.id;
    });
    const delivered = await this.notification.deliver({ challengeId, recipient: phone, code,
      purpose: 'NIN_HOLDER_VERIFY', channel: 'sms', correlationId });
    await this.database.withSystemTransaction(correlationId, (client) => client.query(
      `update identity.public_patient_enrollment_otps set delivery_outcome=$2,
         delivery_provider=$3,
         invalidated_at=case when $2='definitive_failure' then clock_timestamp() else invalidated_at end,
         invalidation_reason=case when $2='definitive_failure' then 'delivery_failed' else invalidation_reason end
       where id=$1 and enrollment_id=$4 and purpose='nin_holder' and consumed_at is null`,
      [challengeId, delivered.outcome, delivered.provider ?? null, enrollmentId]));
    if (delivered.outcome === 'definitive_failure') throw new DomainProblem(503, 'OTP_DELIVERY_UNAVAILABLE',
      'Verification code delivery is unavailable');
    return { challengeId, expiresInSeconds: this.env.OTP_EXPIRY_SECONDS,
      resendAfterSeconds: this.env.OTP_RESEND_COOLDOWN_SECONDS };
  }

  /**
   * Checks a registry-phone code (ADR-062): readiness first (503, counting
   * nothing), then, under the NIN lock, the code once, in constant time, at
   * most five times, before its expiry. A wrong code counts against the
   * NIN's failure budgets. A correct one is recorded by
   * identity.record_public_patient_holder_proof, which only then answers
   * whether the NIN already has a Health ID.
   */
  async verifyHolderCode(cookie: string | undefined, challengeId: string, code: string,
    correlationId: string) {
    if (!/^\d{6}$/.test(code)) throw this.invalidCode();
    const readiness = await this.database.withSystemTransaction(correlationId, (client) =>
      client.query<{ ready: boolean }>('select identity.public_patient_enrollment_ready() as ready'));
    if (readiness.rows[0]?.ready !== true) throw this.reconciliationRequired();
    if (!this.ownershipRoutes().online) throw this.holderRouteUnavailable(503);
    let result: { outcome: HolderProofOutcome | 'invalid'; requiredProfileFields?: EnrollmentProfileField[] };
    try {
      result = await this.withNinLock(cookie, correlationId, async (client, row) => {
        if (row.state !== 'verify_holder') return { outcome: 'invalid' as const };
        // Read before anything changes: unreadable evidence leaves the code unspent.
        const requiredProfileFields = this.requiredProfileFields(row);
        const challenge = (await client.query<ChallengeRow>(
          `select * from identity.public_patient_enrollment_otps where id=$1 and enrollment_id=$2
            and purpose='nin_holder' and consumed_at is null and invalidated_at is null limit 1 for update`,
          [challengeId, row.id])).rows[0];
        if (!challenge || challenge.expires_at.getTime() <= Date.now()
          || challenge.failed_attempts >= challenge.max_attempts
          || challenge.delivery_outcome === 'definitive_failure' || challenge.channel !== 'phone'
          || !row.holder_recipient_hmac || !this.equalHex(challenge.recipient_hmac, row.holder_recipient_hmac)) {
          return { outcome: 'invalid' as const };
        }
        const ninDigest = this.holderNinDigest(row.nin_lookup_hmac);
        const supplied = this.hmac('patient-enrollment-holder-otp', row.id, challenge.id,
          challenge.recipient_hmac, code);
        if (!this.equalHex(challenge.verifier_hmac, supplied)) {
          await client.query(
            `update identity.public_patient_enrollment_otps set failed_attempts=failed_attempts+1,
               invalidated_at=case when failed_attempts+1>=max_attempts then clock_timestamp() else null end,
               invalidation_reason=case when failed_attempts+1>=max_attempts then 'attempts_exhausted' else null end
             where id=$1`, [challenge.id]);
          await client.query('select identity.record_public_patient_holder_failure($1,$2,$3,$4,$5,$6)',
            [row.id, row.token_hmac, challenge.id, ninDigest, this.env.NIN_HOLDER_FAILURES_DAILY_MAX,
              this.env.NIN_HOLDER_FAILURES_MONTHLY_MAX]);
          return { outcome: 'invalid' as const };
        }
        const proof = await client.query<{ outcome: HolderProofOutcome }>(
          `select identity.record_public_patient_holder_proof($1,$2,'registry_phone_otp',$3,null,$4,$5) as outcome`,
          [row.id, row.token_hmac, challenge.id, ninDigest, this.env.NIN_HOLDER_DISTINCT_NINS_MAX]);
        const outcome = proof.rows[0]?.outcome;
        if (!outcome) throw this.unavailable();
        return { outcome, requiredProfileFields };
      });
    } catch (error) {
      if (this.databaseErrorCode(error) === '23514' && error instanceof Error
        && error.message === 'PATIENT_HOLDER_PROOF_INVALID') throw this.invalidCode();
      throw this.mapDatabaseError(error);
    }
    switch (result.outcome) {
      case 'verified':
        return { stage: 'verify_contact' as const, requiredProfileFields: result.requiredProfileFields ?? [] };
      case 'existing_identity': throw this.ninAlreadyRegistered();
      case 'facility_conflict': throw new DomainProblem(409, 'NIN_HOLDER_PROOF_CONFLICT',
        'Registration for this NIN is in progress at a facility.');
      case 'route_limited': throw this.holderRouteLimited();
      default: throw this.invalidCode();
    }
  }

  async startContact(cookie: string | undefined, channel: ContactChannel, rawContact: string,
    remoteIp: string | undefined, correlationId: string) {
    this.assertConfigured();
    // Before any database work: without a client network nothing is charged.
    const ipHmac = this.networkHmac(remoteIp);
    const enrollment = await this.requireEnrollment(cookie, correlationId);
    if (enrollment.state !== 'verify_contact') throw new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID',
      'This enrollment is not waiting for contact verification');
    const contact = this.normalizeContact(channel, rawContact);
    const lookupHmac = createContactLookupHmac(channel, contact);
    const recipientHmac = this.hmac('patient-enrollment-recipient', channel, contact);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const challengeId = randomUUID();
    const preflight = await this.database.withSystemTransaction(correlationId, async (client) => {
      const ipLimited = await this.consumeRate(client, 'ip', ipHmac,
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
      const readiness = await client.query<{ ready: boolean }>(
        'select identity.public_patient_enrollment_ready() as ready');
      const contactBound = await client.query<{ bound: boolean }>(
        'select identity.public_patient_contact_already_bound($1,$2) as bound',
        [channel, lookupHmac]);
      return { limited: ipLimited || recipientLimited || enrollmentLimited || failureBlocked,
        ready: readiness.rows[0]?.ready === true, contactBound: contactBound.rows[0]?.bound === true };
    });
    if (preflight.limited) throw this.rateLimited();
    if (!preflight.ready) throw this.reconciliationRequired();
    if (preflight.contactBound) throw this.contactAlreadyRegistered();
    const result = await this.withEnrollmentLock(cookie, correlationId, async (client, row) => {
      if (row.state !== 'verify_contact') throw new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID',
        'This enrollment is not waiting for contact verification');
      const active = (await client.query<ChallengeRow>(
        `select * from identity.public_patient_enrollment_otps where enrollment_id=$1 and purpose='contact'
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
        [row.id, channel, recipientHmac, lookupHmac, this.encrypt(row.id, 'contact', contact)]);
      await client.query(
        `insert into identity.public_patient_enrollment_otps
         (id,enrollment_id,recipient_hmac,channel,purpose,verifier_hmac,verifier_key_version,
          expires_at,max_attempts,request_ip_hmac)
         values($1,$2,$3,$4,'contact',$5,$6,clock_timestamp()+($7*interval '1 second'),$8,$9)`,
        [challengeId, row.id, recipientHmac, channel, verifierHmac,
          this.env.OTP_HMAC_KEY_VERSION, this.env.OTP_EXPIRY_SECONDS,
          this.env.OTP_MAX_ATTEMPTS, ipHmac]);
      return { enrollmentId: row.id };
    });
    const delivered = await this.notification.deliver({ challengeId, recipient: contact, code,
      purpose: 'SIGNUP_VERIFY', channel: channel === 'phone' ? 'sms' : 'email', correlationId });
    await this.database.withSystemTransaction(correlationId, (client) => client.query(
      `update identity.public_patient_enrollment_otps set delivery_outcome=$2,
         delivery_provider=$3,
         invalidated_at=case when $2='definitive_failure' then clock_timestamp() else invalidated_at end,
         invalidation_reason=case when $2='definitive_failure' then 'delivery_failed' else invalidation_reason end
       where id=$1 and enrollment_id=$4 and purpose='contact' and consumed_at is null`,
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
          and purpose='contact' and consumed_at is null and invalidated_at is null limit 1 for update`,
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
      // Read before anything changes: unreadable evidence leaves the code unspent.
      const requiredProfileFields = this.requiredProfileFields(row);
      await client.query(
        `update identity.public_patient_enrollment_otps set verified_at=clock_timestamp(),
           consumed_at=clock_timestamp() where id=$1`, [challenge.id]);
      await client.query(
        `update identity.public_patient_enrollments set state='set_password',
           contact_verified_at=clock_timestamp(), verified_challenge_id=$2,
           updated_at=clock_timestamp(), row_version=row_version+1 where id=$1`,
        [row.id, challenge.id]);
      return { requiredProfileFields };
    });
    if (!result) throw this.invalidCode();
    return { stage: 'set_password' as const, requiredProfileFields: result.requiredProfileFields };
  }

  async activate(cookie: string | undefined, password: string, correlationId: string,
    googleCookie?: string, profile: SelfReportedProfile = {}) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new DomainProblem(400, 'PASSWORD_INVALID', 'Password must be 12–256 characters');
    }
    const row = await this.requireEnrollment(cookie, correlationId);
    if (row.state !== 'set_password' && row.state !== 'active') {
      throw new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID', 'Contact verification is required');
    }
    if (!row.contact_ciphertext) throw new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID',
      'Contact verification is required');
    // A contact proof older than 30 minutes is verified again (N2(c)). The
    // reset decides by the database clock; if it changes nothing, the
    // activation command decides with the same clock.
    if (row.state === 'set_password' && (!row.contact_verified_at
      || row.contact_verified_at.getTime() + CONTACT_PROOF_WINDOW_MS <= Date.now())
      && await this.resetStaleContact(row.id, correlationId)) {
      throw this.contactReverifyRequired();
    }
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
    const profileJson = this.decrypt(row.id, 'profile', row.profile_ciphertext);
    // A first activation enters what the NIN record lacks, and nothing it has
    // (ADR-061), checked before argon2id. A replay ignores the fields: the
    // command returns the stored HID and changes nothing.
    const selfReported = row.state === 'active' ? { dateOfBirth: null, gender: null }
      : this.selfReportedProfile(this.parseProfile(profileJson), profile);
    const contact = this.decrypt(row.id, 'contact', row.contact_ciphertext);
    const contactLookupHmac = createContactLookupHmac(row.contact_channel!, contact);
    // Two first activations that race still hash twice; the command lets one
    // activate and replays the other.
    const hash = row.state === 'active' ? await this.replayPlaceholderHash
      : await argon2.hash(password, PASSWORD_HASH_OPTIONS);
    const tokenHmac = this.cookieTokenHmac(cookie);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const hid = this.hidCodes.generate();
        const result = await this.database.withSystemTransaction(correlationId, async (client) => {
          const activated = await client.query<{ patient_id: string; hid_code: string;
            account_id: string; replayed: boolean }>(
            'select * from identity.activate_public_patient_enrollment($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [row.id, tokenHmac, profileJson, contact, hid, hash, contactLookupHmac,
              selfReported.dateOfBirth, selfReported.gender]);
          if (!activated.rows[0]) throw new DomainProblem(503, 'ENROLLMENT_ACTIVATION_UNAVAILABLE',
            'Health ID activation is unavailable');
          await this.google.consumePendingInTransaction(client, googleCookie, row.id,
            activated.rows[0].account_id);
          return activated;
        });
        const activated = result.rows[0];
        if (!activated) throw new DomainProblem(503, 'ENROLLMENT_ACTIVATION_UNAVAILABLE',
          'Health ID activation is unavailable');
        return { stage: 'active' as const, hidCode: activated.hid_code };
      } catch (error) {
        if (this.databaseErrorCode(error) === '23505'
          && this.databaseConstraint(error) === 'patients_hid_code_ci_uq') continue;
        if (this.databaseErrorCode(error) === '23514' && error instanceof Error
          && error.message === 'PATIENT_CONTACT_REVERIFY_REQUIRED') {
          await this.resetStaleContact(row.id, correlationId);
          throw this.contactReverifyRequired();
        }
        throw this.mapDatabaseError(error);
      }
    }
    throw new DomainProblem(503, 'ENROLLMENT_ACTIVATION_UNAVAILABLE',
      'Health ID activation is unavailable');
  }

  private async progress(row: EnrollmentRow, correlationId: string) {
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
    if (row.state === 'verify_holder') return this.holderProgress(row, googleProgress, correlationId);
    if (row.state === 'active') {
      const result = await this.database.withSystemTransaction(correlationId, (client) =>
        client.query<{ hid_code: string }>(
          'select hid_code from identity.patients where id=$1 and source_system=$2',
          [row.patient_id, 'hid-public-qoreid-enrollment']));
      if (!result.rows[0]) throw new DomainProblem(503, 'ENROLLMENT_EVIDENCE_UNAVAILABLE',
        'Enrollment evidence is unavailable');
      return { stage: 'active' as const, hidCode: result.rows[0].hid_code, ...googleProgress };
    }
    const base = { stage: row.state, expiresAt: row.expires_at.toISOString(),
      ...(row.contact_channel ? { contactChannel: row.contact_channel } : {}), ...googleProgress,
      requiredProfileFields: this.requiredProfileFields(row) };
    if (row.state === 'set_password') return base;
    const active = await this.database.withSystemTransaction(correlationId, (client) =>
      client.query<ChallengeRow>(
        `select * from identity.public_patient_enrollment_otps where enrollment_id=$1
           and purpose='contact' and consumed_at is null and invalidated_at is null
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

  /**
   * Progress at verify_holder (ADR-062): whether each ownership route can be
   * used, and an open holder code's timing. No registry value, masked digit
   * or required profile field before the proof.
   */
  private async holderProgress(row: EnrollmentRow, googleProgress: Record<string, unknown>,
    correlationId: string) {
    const base = { stage: 'verify_holder' as const, expiresAt: row.expires_at.toISOString(), ...googleProgress };
    const facility = { available: this.ownershipRoutes().facility };
    const available = this.holderRecipient(this.parseProfile(
      this.decrypt(row.id, 'profile', row.profile_ciphertext))) !== null;
    if (!available) return { ...base, online: { available }, facility };
    const open = await this.database.withSystemTransaction(correlationId, (client) =>
      client.query<ChallengeRow>(
        `select * from identity.public_patient_enrollment_otps where enrollment_id=$1
           and purpose='nin_holder' and consumed_at is null and invalidated_at is null
           order by created_at desc limit 1`, [row.id]));
    const challenge = open.rows[0];
    if (!challenge || challenge.expires_at.getTime() <= Date.now()) return { ...base, online: { available }, facility };
    return { ...base, facility, online: { available, challengeId: challenge.id,
      expiresInSeconds: Math.max(0, Math.floor((challenge.expires_at.getTime() - Date.now()) / 1000)),
      resendAfterSeconds: Math.max(0, Math.floor((challenge.created_at.getTime()
        + this.env.OTP_RESEND_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000)) } };
  }

  /**
   * The routes to prove that a person holds a NIN (ADR-062): online, a code
   * to the registry phone (NIN_HOLDER_SMS_ENABLED); facility, an in-person
   * check, which also needs a participating facility (0094) and is closed
   * here whatever ASSISTED_REGISTRATION_ENABLED says.
   */
  private ownershipRoutes() {
    // Read on every request, as the QoreID gate reads its flags.
    return { online: getEnvironment().NIN_HOLDER_SMS_ENABLED, facility: false };
  }

  /** The normalized registry phone a holder code may go to, or null: route off, unusable phone or a minor. */
  private holderRecipient(profile: Record<string, unknown>): string | null {
    if (!this.ownershipRoutes().online || underEighteen(profile.dateOfBirth)) return null;
    return normalizeRegistryPhone(profile.phoneNumber);
  }

  /** The NIN's digest in the holder events (domain patient-enrollment-holder-nin), never the lookup HMAC itself. */
  private holderNinDigest(ninLookupHmac: string) {
    return this.hmac('patient-enrollment-holder-nin', ninLookupHmac);
  }

  /**
   * Runs an operation on the cookie's enrollment under the NIN lock, taken
   * before the row lock: the order of the holder proof and of activation
   * (ADR-062), so that two holder steps or a holder step and an activation
   * of one NIN wait for each other instead of deadlocking.
   */
  private async withNinLock<T>(cookie: string | undefined, correlationId: string,
    operation: (client: PoolClient, row: EnrollmentRow) => Promise<T>): Promise<T> {
    const parsed = this.parseCookie(cookie);
    return this.database.withSystemTransaction(correlationId, async (client) => {
      const located = (await client.query<{ nin_lookup_hmac: string }>(
        'select nin_lookup_hmac from identity.public_patient_enrollments where id=$1', [parsed.id])).rows[0];
      if (!located) throw new DomainProblem(404, 'ENROLLMENT_NOT_FOUND', 'No pending enrollment was found');
      await client.query("select pg_advisory_xact_lock(hashtextextended('patient-nin:' || $1, 0))",
        [located.nin_lookup_hmac]);
      const row = (await client.query<EnrollmentRow>(
        'select * from identity.public_patient_enrollments where id=$1 for update', [parsed.id])).rows[0];
      if (!row || row.nin_lookup_hmac !== located.nin_lookup_hmac || row.expires_at.getTime() <= Date.now()
        || this.redisplayEnded(row)
        || !this.equalHex(row.token_hmac, this.hmac('patient-enrollment-token', parsed.token))) {
        throw new DomainProblem(404, 'ENROLLMENT_NOT_FOUND', 'No pending enrollment was found');
      }
      return operation(client, row);
    });
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

  /** An active enrollment shows its HID for 15 minutes after activation, then is gone (N2(b)). */
  private redisplayEnded(row: EnrollmentRow) {
    return row.state === 'active' && (!(row.activated_at instanceof Date)
      || row.activated_at.getTime() + HID_REDISPLAY_WINDOW_MS <= Date.now());
  }

  /**
   * Clears a contact proof older than 30 minutes, by the database clock, and
   * sends the enrollment back to the contact step. True when it did; the
   * contact is chosen and proved again from the start.
   */
  private async resetStaleContact(enrollmentId: string, correlationId: string) {
    const reset = await this.database.withSystemTransaction(correlationId, (client) => client.query(
      `update identity.public_patient_enrollments set state='verify_contact', contact_channel=null,
         contact_hmac=null, contact_lookup_hmac=null, contact_ciphertext=null, contact_verified_at=null,
         verified_challenge_id=null, updated_at=clock_timestamp(), row_version=row_version+1
       where id=$1 and state='set_password' and contact_verified_at <= clock_timestamp() - interval '30 minutes'`,
      [enrollmentId]));
    return reset.rowCount === 1;
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
    // A residence the record gives in part keeps the parts it gives (ADR-062).
    const residence = identity.residence;
    const validResidence = (residence === undefined && identity.address === undefined) || (residence !== null
      && typeof residence === 'object' && !Array.isArray(residence)
      && validText(residence.address1, 1000) && identity.address === residence.address1
      && validText(residence.town, 120) && validText(residence.lga, 120)
      && validText(residence.state, 120));
    // A NIN record may lack a date of birth or gender (ADR-061); one it gives
    // must be valid exactly as before.
    const date = typeof identity.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(identity.dateOfBirth)
      ? new Date(`${identity.dateOfBirth}T00:00:00Z`) : new Date(NaN);
    const validDate = identity.dateOfBirth === undefined || (Number.isFinite(date.getTime())
      && date.toISOString().slice(0, 10) === identity.dateOfBirth
      && date.getUTCFullYear() >= 1900 && date.getTime() <= Date.now());
    const validGender = identity.gender === undefined || GENDERS.includes(identity.gender);
    if (identity.nin !== nin || !validName(identity.firstName) || !validName(identity.lastName)
      || !validDate || !validGender
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

  /** The fields the NIN record lacks, in a fixed order; never a profile value. */
  private missingProfileFields(profile: Partial<Record<EnrollmentProfileField, unknown>>): EnrollmentProfileField[] {
    return PROFILE_FIELDS.filter((field) => profile[field] === undefined || profile[field] === null);
  }

  /** The stored profile's missing fields, for a progress answer before activation. */
  private requiredProfileFields(row: EnrollmentRow) {
    return this.missingProfileFields(this.parseProfile(this.decrypt(row.id, 'profile', row.profile_ciphertext)));
  }

  private parseProfile(profileJson: string): Record<string, unknown> {
    try {
      const profile: unknown = JSON.parse(profileJson);
      if (typeof profile === 'object' && profile !== null && !Array.isArray(profile)) {
        return profile as Record<string, unknown>;
      }
    } catch { /* answered below */ }
    throw new DomainProblem(503, 'ENROLLMENT_EVIDENCE_UNAVAILABLE', 'Enrollment evidence is unavailable');
  }

  /**
   * What a first activation passes as the command's $8 and $9 (ADR-061): the
   * entered value of each field the NIN record lacks, null for each it gives.
   * A field the record gives may not be sent; each one it lacks must be.
   */
  private selfReportedProfile(profile: Record<string, unknown>, input: SelfReportedProfile) {
    const missing = this.missingProfileFields(profile);
    const supplied = PROFILE_FIELDS.filter((field) => input[field] !== undefined && input[field] !== null);
    const named = (fields: readonly EnrollmentProfileField[]) =>
      fields.map((field) => PROFILE_FIELD_NAMES[field]).join(' and ');
    const recorded = supplied.filter((field) => !missing.includes(field));
    if (recorded.length) {
      throw new DomainProblem(400, 'ENROLLMENT_PROFILE_FIELD_VERIFIED',
        `Your ${named(recorded)} ${recorded.length > 1 ? 'come' : 'comes'} from your NIN record and cannot be changed here`);
    }
    const absent = missing.filter((field) => !supplied.includes(field));
    if (absent.length) {
      throw new DomainProblem(400, 'ENROLLMENT_PROFILE_REQUIRED', `Enter your ${named(absent)}`);
    }
    const dateOfBirth = missing.includes('dateOfBirth') ? input.dateOfBirth ?? null : null;
    const gender = missing.includes('gender') ? input.gender ?? null : null;
    if (dateOfBirth !== null && !this.realDateOfBirth(dateOfBirth)) {
      throw new DomainProblem(400, 'DATE_OF_BIRTH_INVALID',
        'Enter a real date of birth. It cannot be before 1 January 1900 or in the future.');
    }
    // The request pipe already refuses any other gender; this keeps the
    // service closed when it is called without it.
    if (gender !== null && !GENDERS.includes(gender)) {
      throw new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.');
    }
    return { dateOfBirth, gender };
  }

  /** A YYYY-MM-DD calendar date from 1900-01-01 to today (UTC), as 0092 checks it. */
  private realDateOfBirth(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
      && value >= '1900-01-01' && value <= new Date().toISOString().slice(0, 10);
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

  /**
   * The keyed client network of the enrollment IP limits: an IPv4 address or
   * an IPv6 /64, and in production never one of our own proxies, which every
   * client would share (IP-1). Without one, enrollment answers 503.
   */
  private networkHmac(remoteIp: string | undefined) {
    const network = publicClientNetwork(remoteIp, this.env);
    if (!network) throw new DomainProblem(503,
      'ENROLLMENT_RATE_LIMIT_UNAVAILABLE', 'Enrollment is temporarily unavailable');
    return this.hmac('patient-enrollment-ip', network);
  }

  /**
   * The QoreID lookup quota's key for the client: an IPv4 address or an IPv6
   * /64, so rotating addresses inside one allocation does not reset it. Its
   * own HMAC domain, so it matches no rate bucket.
   */
  private lookupNetworkDigest(remoteIp: string | undefined) {
    const network = quotaNetwork(remoteIp);
    if (!network) throw new DomainProblem(503, 'ENROLLMENT_RATE_LIMIT_UNAVAILABLE',
      'Enrollment is temporarily unavailable');
    return this.hmac('patient-enrollment-qoreid-network', network);
  }

  private configured(): boolean {
    return Boolean(this.env.NIN_LOOKUP_HMAC_KEY_B64 && this.env.NIN_ENCRYPTION_KEY_B64
      && (this.env.NODE_ENV !== 'production' || this.env.OTP_HMAC_KEY_B64));
  }

  private assertConfigured() {
    if (!this.configured()) {
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
  private ninAlreadyRegistered() { return new DomainProblem(409, 'NIN_ALREADY_REGISTERED',
    NIN_ALREADY_REGISTERED_DETAIL); }
  /** A fixed patient sentence, shown as sent even with the 503 (ADR-062). */
  private holderRouteUnavailable(status: 409 | 503) { return new PublicDetailProblem(status,
    'NIN_HOLDER_ROUTE_UNAVAILABLE', HOLDER_ROUTE_UNAVAILABLE); }
  private holderRouteLimited() { return new DomainProblem(429, 'NIN_HOLDER_ROUTE_LIMITED', HOLDER_ROUTE_LIMITED); }
  private unavailable() { return new DomainProblem(503, 'ENROLLMENT_UNAVAILABLE',
    'Enrollment is temporarily unavailable'); }
  /**
   * A QoreID lookup that could not be completed (502, 503 or 504) shows one
   * fixed patient text at start (ADR-062); its code is kept.
   */
  private ninCheckUnavailable(error: unknown) {
    if (error instanceof DomainProblem && !(error instanceof PublicDetailProblem)
      && [502, 503, 504].includes(error.getStatus())) {
      return new PublicDetailProblem(error.getStatus(), error.code, NIN_CHECK_UNAVAILABLE);
    }
    return error;
  }
  private contactReverifyRequired() { return new DomainProblem(409, 'ENROLLMENT_CONTACT_REVERIFY_REQUIRED',
    'Verify your contact again before setting a password'); }
  private contactAlreadyRegistered() { return new DomainProblem(409, 'CONTACT_ALREADY_REGISTERED',
    'This contact is already associated with a Health ID'); }
  private reconciliationRequired() { return new DomainProblem(503, 'ENROLLMENT_RECONCILIATION_REQUIRED',
    'Patient enrollment is temporarily unavailable while identity reconciliation is incomplete'); }
  private databaseErrorCode(error: unknown) { return typeof error === 'object' && error
    && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
  private databaseConstraint(error: unknown) { return typeof error === 'object' && error
    && 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : undefined; }
  private mapDatabaseError(error: unknown) {
    if (error instanceof DomainProblem) return error;
    const code = this.databaseErrorCode(error);
    // A replay more than 15 minutes after activation (0085): as an unknown enrollment.
    if (code === 'P0002' && error instanceof Error && error.message === 'PATIENT_ENROLLMENT_REPLAY_EXPIRED') {
      return new DomainProblem(404, 'ENROLLMENT_NOT_FOUND', 'No pending enrollment was found');
    }
    if (code === '23505') {
      const constraint = this.databaseConstraint(error);
      if (error instanceof Error && error.message === 'PATIENT_CONTACT_ALREADY_BOUND') {
        return this.contactAlreadyRegistered();
      }
      if (constraint === 'accounts_email_ci_uq' || constraint === 'patients_phone_hmac_uq'
        || constraint === 'patients_email_hmac_uq') {
        return new DomainProblem(409, 'CONTACT_ALREADY_REGISTERED',
          'This contact is already associated with a Health ID');
      }
      if ((error instanceof Error && error.message === 'PATIENT_NIN_ALREADY_BOUND')
        || constraint === 'patient_identifiers_lookup_uq') return this.ninAlreadyRegistered();
      return this.unavailable();
    }
    // 0093 (ADR-062): a first activation needs a holder proof.
    if (code === '23514' && error instanceof Error && error.message === 'PATIENT_HOLDER_PROOF_INVALID') {
      return new DomainProblem(409, 'ENROLLMENT_HOLDER_PROOF_REQUIRED',
        'Prove that you hold this NIN before you set a password');
    }
    if (code === '23514') return new DomainProblem(409, 'ENROLLMENT_STAGE_INVALID',
      'Enrollment conditions are not complete');
    if (code === '42501') return new DomainProblem(403, 'ENROLLMENT_DENIED', 'Enrollment is not permitted');
    if (code === '55000') return this.reconciliationRequired();
    return this.unavailable();
  }
}
