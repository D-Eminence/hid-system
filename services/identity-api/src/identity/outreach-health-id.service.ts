import { Injectable } from '@nestjs/common';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { consumeRateLimit } from '../auth/rate-limit';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { createContactLookupHmac, normalizePatientPhone, patientPhoneStoredForms } from './contact-lookup';
import { HidCodeGenerator } from './hid-code-generator.service';
import { generateOutreachClaimCode, OUTREACH_CLAIM_KEY_VERSION, outreachClaimCodeHmac } from './outreach-claim-code';
import { contactKeyForVersion, currentContactEncryption, decryptContactValue, encryptContactValue,
  otpHmacKey } from './patient-contact-crypto';

/** identity.outreach_health_id_registration(case) (0119). */
interface RegistrationRow {
  registration_case_id: string;
  facility_id: string;
  full_name: string;
  sex: string;
  age_years: number;
  phone: string | null;
  group_name: string | null;
  existing_hid_code: string | null;
}

/** identity.outreach_health_id_open_challenge(case) (0119, with the email's ciphertext). */
interface OpenChallengeRow {
  challenge_id: string;
  expires_at: Date;
  verifier_key_version: string;
  email_ciphertext: Buffer;
  key_version: string;
}

export interface OutreachHealthIdStartResult {
  channel: 'email';
  expiresAt: string;
  destinationHint: string;
  resendAfterSeconds: number;
}

export interface OutreachHealthIdConfirmResult {
  healthId: string;
  outcome: 'created' | 'replayed';
}

/** POST identity/outreach/health-id/create-unclaimed's answer (0120). The claim code is in no other answer. */
export interface OutreachHealthIdCreateUnclaimedResult {
  healthId: string;
  /** Shown once (printed on the slip); only its keyed HMAC is stored. */
  claimCode: string;
  claimExpiresAt: string;
}

/** The 0119 per-registration cooldown between codes (identity.outreach_health_id_start). */
export const OUTREACH_HEALTH_ID_RESEND_SECONDS = 60;
/** A volunteer may ask for this many times the per-recipient budget in one window (a busy outreach). */
const VOLUNTEER_RATE_MULTIPLIER = 6;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MESSAGES = {
  notFound: 'This registration was not found.',
  redacted: "This registration's details were removed, so a Health ID can't be created from it.",
  notAvailable: "Health IDs can't be created from this group's registrations.",
  suspended: 'This outreach group has been paused by Health ID. Contact Health ID support.',
  alreadyCreated: 'A Health ID was already created for this person.',
  under18: "Health IDs for under-18s can't be created at outreach yet. A parent or guardian can do it later in the app.",
  noPhone: "Add the person's phone number to create a Health ID.",
  phoneInvalid: "The person's phone number isn't a valid number, so a Health ID can't be created with it.",
  emailInvalid: 'Enter a valid email address.',
  emailTaken: 'This email already has a Health ID. Ask them to sign in with it.',
  phoneTaken: 'This phone number already has a Health ID. Ask them to sign in with it.',
  tooManyCodes: 'Too many codes for this person today. Try again tomorrow.',
  unavailable: "Health ID codes can't be sent right now. Try again in a few minutes.",
  smsUnavailable: "Codes by SMS aren't available yet. Use the person's email.",
  codeInvalid: "That code isn't right. Check the email and try again.",
  codeExpired: 'That code has expired. Send a new one.',
  tooManyTries: 'Too many wrong codes. Send a new one.',
} as const;

/**
 * Assisted Health ID at an outreach (0119): a volunteer creates a person's
 * Health ID from their registration after the person proves an email with a
 * 6-digit code. Runs in the volunteer's delegated session (outreach-api
 * forwards the browser's sign-in), so 0119's commands see the volunteer's
 * facility, membership and row-level security. Only Identity holds the
 * contact keys, the OTP verifier key and the Health ID generator.
 */
@Injectable()
export class OutreachHealthIdService {
  private readonly env = getEnvironment();
  private readonly otpKey = otpHmacKey(this.env);

  constructor(private readonly database: DatabaseService,
    private readonly notification: NotificationOtpClient,
    private readonly hidCodes: HidCodeGenerator) {}

  async start(input: { caseId: string; channel: 'email' | 'sms'; email?: string },
    context: DataAccessContext, idempotencyKey?: string): Promise<OutreachHealthIdStartResult> {
    if (input.channel === 'sms') throw new DomainProblem(503, 'OUTREACH_HEALTH_ID_UNAVAILABLE', MESSAGES.smsUnavailable);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !EMAIL.test(email)) {
      throw new DomainProblem(422, 'OUTREACH_HEALTH_ID_EMAIL_INVALID', MESSAGES.emailInvalid);
    }
    this.assertConfigured();
    const emailLookup = createContactLookupHmac('email', email);
    const challengeId = idempotencyKey
      ? this.keyedChallengeId(input.caseId, context.actor.accountId, idempotencyKey, emailLookup) : randomUUID();

    const { registration, open } = await this.run(() => this.database.withTransaction(context, async (client) => ({
      registration: await this.registration(client, input.caseId),
      open: await this.openChallenge(client, input.caseId),
    })));
    // A retry of the same request (same Idempotency-Key, registration,
    // volunteer and email) while its code is still open answers it again
    // without sending another.
    if (open && open.challenge_id === challengeId) {
      return this.startAnswer(email, open.expires_at);
    }
    this.assertEligible(registration);
    const phone = this.registrationPhone(registration);

    const preflight = await this.database.withSystemTransaction(context.correlationId, async (client) => {
      const window = { windowSeconds: this.env.OTP_RATE_WINDOW_SECONDS, maxRequests: this.env.OTP_RATE_MAX_REQUESTS };
      const volunteerLimited = await consumeRateLimit(client, 'account',
        this.hmac('outreach-health-id-volunteer', context.actor.accountId),
        { ...window, maxRequests: window.maxRequests * VOLUNTEER_RATE_MULTIPLIER });
      const recipientLimited = await consumeRateLimit(client, 'recipient',
        this.hmac('outreach-health-id-recipient', email), window);
      const ready = (await client.query<{ ready: boolean }>(
        'select identity.patient_contact_lookup_ready() as ready')).rows[0]?.ready === true;
      const emailBound = await this.contactBound(client, 'email', [emailLookup]);
      // Every form a patient's phone may be stored in (a legacy +2340... too).
      const phoneBound = phone ? await this.contactBound(client, 'phone',
        patientPhoneStoredForms(phone).map((form) => createContactLookupHmac('phone', form))) : false;
      return { limited: volunteerLimited || recipientLimited, ready, emailBound, phoneBound };
    });
    if (preflight.limited) {
      throw new DomainProblem(429, 'OUTREACH_HEALTH_ID_TOO_MANY_CODES', MESSAGES.tooManyCodes, undefined,
        { extensions: { retryAfterSeconds: this.env.OTP_RATE_WINDOW_SECONDS } });
    }
    if (!preflight.ready) throw this.unavailable();
    if (preflight.emailBound) throw new DomainProblem(409, 'OUTREACH_HEALTH_ID_EMAIL_TAKEN', MESSAGES.emailTaken);
    if (preflight.phoneBound) throw new DomainProblem(409, 'OUTREACH_HEALTH_ID_PHONE_TAKEN', MESSAGES.phoneTaken);

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const encryption = currentContactEncryption(this.env);
    const started = await this.run(() => this.database.withTransaction(context, async (client) =>
      (await client.query<{ challenge_id: string; expires_at: Date }>(
        `select * from identity.outreach_health_id_start($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [input.caseId, challengeId, email, emailLookup,
          encryptContactValue(encryption.key, challengeId, 'contact', email),
          phone ? createContactLookupHmac('phone', phone) : null, encryption.version,
          this.verifier(input.caseId, challengeId, code), this.env.OTP_HMAC_KEY_VERSION,
          this.env.OTP_EXPIRY_SECONDS, this.env.OTP_MAX_ATTEMPTS])).rows[0]));
    if (!started) throw this.unavailable();

    const delivered = await this.notification.deliverOutreachHealthIdCode({
      challengeId, recipient: email, code,
      ...(registration.group_name?.trim() ? { groupName: registration.group_name.trim().slice(0, 200) } : {}),
      expiresInMinutes: Math.max(1, Math.ceil(this.env.OTP_EXPIRY_SECONDS / 60)),
      correlationId: context.correlationId,
    });
    if (delivered.outcome === 'definitive_failure') {
      await this.database.withTransaction(context, (client) => client.query(
        'select identity.outreach_health_id_delivery_failed($1)', [challengeId]));
      throw this.unavailable();
    }
    return this.startAnswer(email, new Date(started.expires_at));
  }

  async confirm(input: { caseId: string; code: string }, context: DataAccessContext)
    : Promise<OutreachHealthIdConfirmResult> {
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!/^\d{6}$/.test(code)) throw this.codeInvalid();
    this.assertConfigured();
    const { registration, open } = await this.run(() => this.database.withTransaction(context, async (client) => ({
      registration: await this.registration(client, input.caseId),
      open: await this.openChallenge(client, input.caseId),
    })));
    if (!open) {
      if (registration.existing_hid_code) throw this.alreadyCreated(registration.existing_hid_code);
      throw this.codeExpired();
    }
    // A code keyed with an OTP key this process no longer holds cannot be checked.
    if (open.verifier_key_version !== this.env.OTP_HMAC_KEY_VERSION) throw this.codeExpired();
    this.assertEligible(registration);
    const phone = this.registrationPhone(registration);
    const key = contactKeyForVersion(this.env, open.key_version);
    const email = key ? decryptContactValue(key, open.challenge_id, 'contact', open.email_ciphertext) : undefined;
    if (!key || !email) throw this.unavailable();
    // The patient's contacts share one key_version (the challenge's). The
    // phone is optional: without one, both are null and the patient has none.
    const phoneCiphertext = phone ? encryptContactValue(key, open.challenge_id, 'phone', phone) : null;
    const phoneLookup = phone ? createContactLookupHmac('phone', phone) : null;
    const verifier = this.verifier(input.caseId, open.challenge_id, code);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const hid = this.hidCodes.generate();
      try {
        const row = await this.database.withTransaction(context, async (client) =>
          (await client.query<{ outcome: string; hid_code: string | null; patient_id: string | null }>(
            'select * from identity.outreach_health_id_confirm($1,$2,$3,$4,$5,$6,$7)',
            [input.caseId, open.challenge_id, verifier, email, hid, phoneCiphertext, phoneLookup])).rows[0]);
        switch (row?.outcome) {
          case 'created':
          case 'replayed':
            if (!row.hid_code) throw this.unavailable();
            return { healthId: row.hid_code, outcome: row.outcome };
          case 'invalid': throw this.codeInvalid();
          case 'expired': throw this.codeExpired();
          case 'too_many_tries':
            throw new DomainProblem(429, 'OUTREACH_HEALTH_ID_TOO_MANY_TRIES', MESSAGES.tooManyTries);
          default: throw this.unavailable();
        }
      } catch (error) {
        if (error instanceof DomainProblem) throw error;
        if (databaseCode(error) === '23505' && databaseConstraint(error) === 'patients_hid_code_ci_uq') continue;
        throw this.problem(error);
      }
    }
    throw this.unavailable();
  }

  /**
   * No contact at all (0120): creates the person's Health ID with no account
   * and a one-time claim code (8 characters), stored as its keyed HMAC only.
   * The code is answered here once and never again: a retry finds the Health
   * ID created and answers 409 OUTREACH_HEALTH_ID_ALREADY_CREATED with it.
   * The registration's phone, if any, is stored as 0119's confirm stores it
   * (sign-up's contact key and key version, its lookup HMAC), bound to the
   * registration id since there is no challenge.
   */
  async createUnclaimed(input: { caseId: string }, context: DataAccessContext)
    : Promise<OutreachHealthIdCreateUnclaimedResult> {
    this.assertConfigured();
    const registration = await this.run(() => this.database.withTransaction(context, (client) =>
      this.registration(client, input.caseId)));
    this.assertEligible(registration);
    const phone = this.registrationPhone(registration);
    if (phone) {
      const preflight = await this.database.withSystemTransaction(context.correlationId, async (client) => ({
        ready: (await client.query<{ ready: boolean }>(
          'select identity.patient_contact_lookup_ready() as ready')).rows[0]?.ready === true,
        // Every form a patient's phone may be stored in (a legacy +2340... too).
        phoneBound: await this.contactBound(client, 'phone',
          patientPhoneStoredForms(phone).map((form) => createContactLookupHmac('phone', form))),
      }));
      if (!preflight.ready) throw this.unavailable();
      if (preflight.phoneBound) throw new DomainProblem(409, 'OUTREACH_HEALTH_ID_PHONE_TAKEN', MESSAGES.phoneTaken);
    }
    const encryption = phone ? currentContactEncryption(this.env) : undefined;
    const phoneCiphertext = phone && encryption ? encryptContactValue(encryption.key, input.caseId, 'phone', phone) : null;
    const phoneLookup = phone ? createContactLookupHmac('phone', phone) : null;

    let claimCode = generateOutreachClaimCode();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const hid = this.hidCodes.generate();
      try {
        const row = await this.database.withTransaction(context, async (client) =>
          (await client.query<{ hid_code: string; patient_id: string; claim_expires_at: Date }>(
            'select * from identity.outreach_health_id_create_unclaimed($1,$2,$3,$4,$5,$6,$7)',
            [input.caseId, hid, phoneCiphertext, phoneLookup, encryption?.version ?? null,
              outreachClaimCodeHmac(this.otpKey, claimCode), OUTREACH_CLAIM_KEY_VERSION])).rows[0]);
        if (!row?.hid_code || !row.claim_expires_at) throw this.unavailable();
        return { healthId: row.hid_code, claimCode, claimExpiresAt: new Date(row.claim_expires_at).toISOString() };
      } catch (error) {
        if (error instanceof DomainProblem) throw error;
        if (databaseCode(error) === '23505') {
          const constraint = databaseConstraint(error);
          if (constraint === 'patients_hid_code_ci_uq') continue;
          // Another Health ID's claim code has the same HMAC (vanishingly rare): draw another code.
          if (constraint === 'outreach_health_id_claims_code_hmac_key') {
            claimCode = generateOutreachClaimCode();
            continue;
          }
        }
        throw this.problem(error);
      }
    }
    throw this.unavailable();
  }

  /** 0119's refusals as the agreed problems; anything else unchanged. */
  problem(error: unknown): unknown {
    if (error instanceof DomainProblem || typeof error !== 'object' || error === null) return error;
    const message = String((error as { message?: unknown }).message ?? '');
    const has = (code: string) => message === code;
    if (has('OUTREACH_REGISTRATION_NOT_FOUND')) {
      return new DomainProblem(404, 'OUTREACH_REGISTRATION_NOT_FOUND', MESSAGES.notFound);
    }
    if (has('OUTREACH_REGISTRATION_REDACTED')) {
      return new DomainProblem(409, 'OUTREACH_REGISTRATION_REDACTED', MESSAGES.redacted);
    }
    if (has('OUTREACH_HEALTH_ID_NOT_AVAILABLE')) {
      return new DomainProblem(403, 'OUTREACH_HEALTH_ID_NOT_AVAILABLE', MESSAGES.notAvailable);
    }
    if (has('OUTREACH_ORGANISER_SUSPENDED')) {
      return new DomainProblem(423, 'OUTREACH_ORGANISER_SUSPENDED', MESSAGES.suspended);
    }
    if (has('OUTREACH_HEALTH_ID_ALREADY_CREATED')) {
      const detail = (error as { detail?: unknown }).detail;
      return this.alreadyCreated(typeof detail === 'string' ? detail : null);
    }
    if (has('OUTREACH_HEALTH_ID_UNDER_18')) return new DomainProblem(422, 'OUTREACH_HEALTH_ID_UNDER_18', MESSAGES.under18);
    if (has('OUTREACH_HEALTH_ID_NO_PHONE')) return new DomainProblem(422, 'OUTREACH_HEALTH_ID_NO_PHONE', MESSAGES.noPhone);
    if (has('OUTREACH_HEALTH_ID_EMAIL_INVALID')) {
      return new DomainProblem(422, 'OUTREACH_HEALTH_ID_EMAIL_INVALID', MESSAGES.emailInvalid);
    }
    if (has('OUTREACH_HEALTH_ID_EMAIL_TAKEN')) {
      return new DomainProblem(409, 'OUTREACH_HEALTH_ID_EMAIL_TAKEN', MESSAGES.emailTaken);
    }
    if (has('OUTREACH_HEALTH_ID_PHONE_TAKEN')) {
      return new DomainProblem(409, 'OUTREACH_HEALTH_ID_PHONE_TAKEN', MESSAGES.phoneTaken);
    }
    if (has('OUTREACH_HEALTH_ID_TOO_MANY_CODES')) {
      return new DomainProblem(429, 'OUTREACH_HEALTH_ID_TOO_MANY_CODES', MESSAGES.tooManyCodes);
    }
    // Our own arguments were refused (a bug, not the volunteer's): unavailable.
    if (has('OUTREACH_HEALTH_ID_REQUEST_INVALID')) return this.unavailable();
    return error;
  }

  private async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      throw this.problem(error);
    }
  }

  private async registration(client: PoolClient, caseId: string): Promise<RegistrationRow> {
    const row = (await client.query<RegistrationRow>(
      'select * from identity.outreach_health_id_registration($1)', [caseId])).rows[0];
    if (!row) throw new DomainProblem(404, 'OUTREACH_REGISTRATION_NOT_FOUND', MESSAGES.notFound);
    return row;
  }

  private async openChallenge(client: PoolClient, caseId: string): Promise<OpenChallengeRow | undefined> {
    return (await client.query<OpenChallengeRow>(
      'select * from identity.outreach_health_id_open_challenge($1)', [caseId])).rows[0];
  }

  private async contactBound(client: PoolClient, channel: 'email' | 'phone', lookups: string[]): Promise<boolean> {
    for (const lookup of lookups) {
      const bound = await client.query<{ bound: boolean }>(
        'select identity.public_patient_contact_already_bound($1,$2) as bound', [channel, lookup]);
      if (bound.rows[0]?.bound === true) return true;
    }
    return false;
  }

  /** What 0119's eligibility check refuses, answered before anything is sent. */
  private assertEligible(registration: RegistrationRow): void {
    if (registration.existing_hid_code) throw this.alreadyCreated(registration.existing_hid_code);
    if (Number(registration.age_years) < 18) {
      throw new DomainProblem(422, 'OUTREACH_HEALTH_ID_UNDER_18', MESSAGES.under18);
    }
  }

  /**
   * The registration's phone as patient sign-up stores it (E.164; a Nigerian
   * 0... number as +234...), or undefined when the registration has none: on
   * the email path the phone is optional (0119). A phone that is not a valid
   * number is refused, since 0119 needs its lookup HMAC whenever there is one.
   */
  private registrationPhone(registration: RegistrationRow): string | undefined {
    if (registration.phone === null) return undefined;
    const phone = normalizePatientPhone(registration.phone);
    if (!phone) throw new DomainProblem(422, 'OUTREACH_HEALTH_ID_PHONE_INVALID', MESSAGES.phoneInvalid);
    return phone;
  }

  private startAnswer(email: string, expiresAt: Date): OutreachHealthIdStartResult {
    return { channel: 'email', expiresAt: expiresAt.toISOString(), destinationHint: emailHint(email),
      resendAfterSeconds: OUTREACH_HEALTH_ID_RESEND_SECONDS };
  }

  /** The keyed verifier 0119 stores: never the code. */
  verifier(caseId: string, challengeId: string, code: string): string {
    return this.hmac('outreach-health-id-otp', caseId, challengeId, code);
  }

  /** A challenge id derived from the request, so a retry with the same Idempotency-Key is recognised. */
  private keyedChallengeId(caseId: string, accountId: string, idempotencyKey: string, emailLookup: string): string {
    const bytes = createHmac('sha256', this.otpKey)
      .update(['outreach-health-id-challenge', caseId, accountId, idempotencyKey, emailLookup].join('\u001f'), 'utf8')
      .digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private hmac(...parts: string[]): string {
    return createHmac('sha256', this.otpKey).update(parts.join('\u001f'), 'utf8').digest('hex');
  }

  /** The contact lookup key, and in production the OTP key, as patient sign-up needs. */
  private assertConfigured(): void {
    if (!this.env.CONTACT_LOOKUP_HMAC_KEY_B64 || (this.env.NODE_ENV === 'production' && !this.env.OTP_HMAC_KEY_B64)) {
      throw this.unavailable();
    }
  }

  private alreadyCreated(healthId: string | null): DomainProblem {
    return new DomainProblem(409, 'OUTREACH_HEALTH_ID_ALREADY_CREATED', MESSAGES.alreadyCreated, undefined,
      healthId ? { extensions: { healthId } } : undefined);
  }

  private codeInvalid() { return new DomainProblem(422, 'OUTREACH_HEALTH_ID_CODE_INVALID', MESSAGES.codeInvalid); }
  private codeExpired() { return new DomainProblem(422, 'OUTREACH_HEALTH_ID_CODE_EXPIRED', MESSAGES.codeExpired); }
  private unavailable() { return new DomainProblem(503, 'OUTREACH_HEALTH_ID_UNAVAILABLE', MESSAGES.unavailable); }
}

/** "a***@gmail.com": the first character of the local part and the domain. */
export function emailHint(email: string): string {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}

function databaseCode(error: unknown): string | undefined {
  return typeof error === 'object' && error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function databaseConstraint(error: unknown): string | undefined {
  return typeof error === 'object' && error && 'constraint' in error && typeof error.constraint === 'string'
    ? error.constraint : undefined;
}
