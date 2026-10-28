import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { type BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import { emailFirstName } from '../auth/email-first-name';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { generateSixDigitOtp } from '../auth/otp.service';
import { requirePatient } from '../auth/patient-self.service';
import { consumeRateLimit, releaseRateLimit } from '../auth/rate-limit';
import { requireNoRecentRecoveryHold } from '../auth/recent-authentication';
import { AFTER_RESPONSE_SHUTDOWN_GRACE_MS, AfterResponseTasks } from '../common/after-response-tasks';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { createContactLookupHmac, normalizeContactForLookup, normalizePatientPhone,
  patientPhoneStoredForms } from '../identity/contact-lookup';
import { maskDestination } from '../patient-safety/emergency-contact-protector';
import { PatientContactReader } from './patient-contact-reader';
import { PatientProfileCrypto } from './patient-profile-crypto';
import { patientCommandProblem } from './patient-profile-problems';

/**
 * At most four current passwords are checked in 15 minutes; the next attempt
 * is refused (429) and blocks contact changes for 15 minutes. Each attempt is
 * counted before its hash is checked, under the bucket's lock, so concurrent
 * guesses cannot all pass the budget; a right password gives its count back.
 */
const PASSWORD_FAILURE_WINDOW_SECONDS = 900;
export const PASSWORD_FAILURES_ALLOWED = 4;

/** What the 24-hour hold after an OTP recovery names (recent-authentication.ts). */
const RECOVERY_HOLD_WHAT = 'email and phone number changes';

const PHONE_MESSAGE = 'Enter your phone number with its country code, like +44 7700 900123, '
  + 'or a Nigerian number like 08012345678.';

interface CredentialsRow {
  account_id: string;
  email: string | null;
  email_verified: boolean;
  password_hash: string | null;
  password_algorithm: string | null;
  patient_first_name: string | null;
  patient_hid_code: string | null;
}

interface PhoneChangeRow {
  outcome: 'changed' | 'unchanged' | 'rate_limited' | 'unavailable';
  notice_email: string | null;
  patient_first_name: string | null;
  patient_hid_code: string | null;
}

interface EmailCompletionRow {
  outcome: 'completed' | 'invalid' | 'expired' | 'unavailable' | 'workforce';
  email: string | null;
  previous_email: string | null;
  patient_first_name: string | null;
  patient_hid_code: string | null;
}

export interface EmailChangeStarted {
  changeId: string;
  maskedContact: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

/** "That email address or phone number can't be used." — no detail (owner's wording). */
export function contactUnavailable(): DomainProblem {
  return new DomainProblem(409, 'CONTACT_UNAVAILABLE', "That email address or phone number can't be used.");
}

/**
 * A patient account that is also a staff login (0093's workforce test): its
 * email is the staff sign-in and the staff record's address too, so the
 * patient profile does not change it.
 */
export function staffAccountEmail(): DomainProblem {
  return new DomainProblem(409, 'CONTACT_CHANGE_STAFF_ACCOUNT',
    'This account is also used to sign in as facility staff, so its email can\'t be changed here. '
    + 'Contact Health ID support to change it.');
}

/**
 * The new address as the "email was changed" notice shows it, built from
 * characters notification-api's MASKED_CONTACT admits whatever the address's
 * spelling (so a new address cannot stop the notice to the old one): its
 * first character only when it is a letter or digit, "•••@", and the domain
 * in ASCII (punycode for an international domain) with any character but a
 * letter, digit, "." or "-" shown as "•", at most 253 characters.
 */
export function contactChangeHint(email: string): string {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, Math.max(at, 0));
  const domain = email.slice(at + 1).toLowerCase();
  const first = /^[A-Za-z0-9]/.test(local) ? local.slice(0, 1) : '';
  const ascii = (domainToASCII(domain) || domain).toLowerCase().replace(/[^a-z0-9.-]/gu, '•');
  const shown = ascii.length > 253 ? `•${ascii.slice(-252)}` : ascii;
  return `${first}•••@${shown || '•'}`;
}

/**
 * A patient's change of email or phone (0094; the lead's decisions for this
 * wave): both need the current password (403 PASSWORD_INCORRECT; four are
 * checked in 15 minutes, then 429 for 15 minutes; an account without a
 * password, Google only, 409 PASSWORD_REQUIRED), and both are held for 24
 * hours after an OTP account recovery (403 PATIENT_RECENT_RECOVERY_HOLD, as
 * the other commands that redirect access are), so that whoever recovered
 * the account cannot also move its email or phone. Production sends no SMS,
 * so a phone change takes effect at once and is announced to the verified
 * email; an email change takes effect when the 6-digit code sent to the new
 * address is entered, and the old address is told. Sign-in, recovery and
 * Novu use the new contact from then on (auth.accounts.email,
 * identity.patients' lookups). The notices are best-effort, after the
 * answer.
 */
@Injectable()
export class PatientContactChangeService implements BeforeApplicationShutdown {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(PatientContactChangeService.name);
  private readonly notices = new AfterResponseTasks(this.logger, 'Contact-change notice email could not be sent');

  constructor(private readonly database: DatabaseService, private readonly crypto: PatientProfileCrypto,
    private readonly notification: NotificationOtpClient, private readonly reader: PatientContactReader) {}

  /** Waits for the notices started so far (tests). */
  settleNotices(): Promise<void> {
    return this.notices.settle();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.notices.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS);
  }

  async start(request: HidRequest, input: { channel: 'email' | 'phone'; email?: string; phone?: string;
    currentPassword: string }): Promise<EmailChangeStarted | { phone: string; phoneVerified: boolean }> {
    const actor = requirePatient(request.actor);
    if (input.channel === 'email') {
      if (input.phone !== undefined || typeof input.email !== 'string') throw this.invalid('email');
      let email: string;
      try {
        email = normalizeContactForLookup('email', input.email);
      } catch {
        throw this.invalid('email');
      }
      this.crypto.assertConfigured();
      await this.confirmPassword(request, actor, input.currentPassword);
      return this.startEmail(request, actor, email);
    }
    if (input.email !== undefined || typeof input.phone !== 'string') throw this.invalid('phone');
    const phone = normalizePatientPhone(input.phone);
    if (!phone) throw this.invalid('phone');
    this.crypto.assertConfigured();
    await this.confirmPassword(request, actor, input.currentPassword);
    return this.changePhone(request, actor, phone);
  }

  async verify(request: HidRequest, changeId: string, code: string): Promise<{ email: string }> {
    const actor = requirePatient(request.actor);
    this.crypto.assertConfigured();
    const verifier = this.crypto.codeVerifier(changeId, code);
    let row: EmailCompletionRow | undefined;
    try {
      row = await this.asPatient(request, actor, async (client) => {
        // A change started before an OTP recovery is not finished during its hold.
        await requireNoRecentRecoveryHold(client, actor.accountId, RECOVERY_HOLD_WHAT);
        const pending = (await client.query<{ new_ciphertext: Buffer; key_version: string }>(
          'select new_ciphertext, key_version from identity.read_my_pending_email_change($1, $2, $3)',
          [actor.subject, actor.sessionId, changeId])).rows[0];
        const email = pending
          ? this.crypto.decryptContact(changeId, 'email', pending.key_version, pending.new_ciphertext) : '';
        if (email === undefined) throw this.unavailable();
        return (await client.query<EmailCompletionRow>(
          'select outcome, email, previous_email, patient_first_name, patient_hid_code '
          + 'from identity.complete_my_email_change($1, $2, $3, $4, $5)',
          [actor.subject, actor.sessionId, changeId, verifier, email])).rows[0];
      });
    } catch (error) {
      throw patientCommandProblem(error);
    }
    // A wrong code's count and its audit row committed before this answer.
    if (row?.outcome === 'unavailable') throw contactUnavailable();
    if (row?.outcome === 'workforce') throw staffAccountEmail();
    if (row?.outcome !== 'completed' || !row.email) {
      throw new DomainProblem(400, 'OTP_INVALID_OR_EXPIRED', 'The verification code is invalid or expired.');
    }
    const previous = row.previous_email?.trim().toLowerCase();
    if (previous && previous !== row.email) {
      this.announce(request.correlationId, changeId, previous, 'email', row, contactChangeHint(row.email));
    }
    return { email: row.email };
  }

  /**
   * The account's password is right, or the answer is 403 (a recovery hold,
   * or a wrong password, counted), 409 or 429. The attempt is counted, under
   * the bucket's lock, in the transaction that reads the credentials and
   * before the hash is checked; a right password gives the count back.
   */
  private async confirmPassword(request: HidRequest, actor: ReturnType<typeof requirePatient>,
    password: string): Promise<CredentialsRow> {
    let found: { credentials?: CredentialsRow; blocked: boolean };
    try {
      found = await this.asPatient(request, actor, async (client) => {
        const credentials = (await client.query<CredentialsRow>(
          'select account_id::text, email, email_verified, password_hash, password_algorithm, '
          + 'patient_first_name, patient_hid_code from identity.my_contact_change_credentials($1, $2)',
          [actor.subject, actor.sessionId])).rows[0];
        if (!credentials) return { blocked: false };
        // Whoever recovered the account with a code may not move its contacts for 24 hours (REC-NOTIFY).
        await requireNoRecentRecoveryHold(client, actor.accountId, RECOVERY_HOLD_WHAT);
        if (!credentials.password_hash) return { credentials, blocked: false };
        const blocked = await consumeRateLimit(client, 'account', this.crypto.passwordFailureBucket(credentials.account_id),
          { windowSeconds: PASSWORD_FAILURE_WINDOW_SECONDS, maxRequests: PASSWORD_FAILURES_ALLOWED });
        return { credentials, blocked };
      });
    } catch (error) {
      throw patientCommandProblem(error);
    }
    const credentials = found.credentials;
    if (!credentials) throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient access is unavailable');
    if (!credentials.password_hash) {
      throw new DomainProblem(409, 'PASSWORD_REQUIRED', 'Set a password first to change your contact details.');
    }
    if (found.blocked) throw this.rateLimited('Too many incorrect passwords. Try again in 15 minutes.');
    const valid = credentials.password_algorithm === 'bcrypt_legacy'
      ? await bcrypt.compare(password, credentials.password_hash).catch(() => false)
      : credentials.password_algorithm === 'argon2id'
        ? await argon2.verify(credentials.password_hash, password).catch(() => false)
        : false;
    if (!valid) throw new DomainProblem(403, 'PASSWORD_INCORRECT', 'The current password is incorrect.');
    await this.database.withSystemTransaction(request.correlationId, (client) => releaseRateLimit(client, 'account',
      this.crypto.passwordFailureBucket(credentials.account_id)));
    return credentials;
  }

  private async startEmail(request: HidRequest, actor: ReturnType<typeof requirePatient>,
    email: string): Promise<EmailChangeStarted> {
    const changeId = randomUUID();
    const code = generateSixDigitOtp();
    const lookup = createContactLookupHmac('email', email);
    const ciphertext = this.crypto.encryptContact(changeId, 'email', email);
    let outcome: string | undefined;
    try {
      outcome = await this.asPatient(request, actor, async (client) => (await client.query<{ outcome: string }>(
        'select identity.start_my_email_change($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as outcome',
        [actor.subject, actor.sessionId, changeId, email, lookup, ciphertext, this.crypto.keyVersion,
          this.crypto.codeVerifier(changeId, code), this.crypto.verifierKeyVersion,
          this.environment.OTP_EXPIRY_SECONDS, this.environment.OTP_MAX_ATTEMPTS,
          this.environment.OTP_RESEND_COOLDOWN_SECONDS])).rows[0]?.outcome);
    } catch (error) {
      throw patientCommandProblem(error);
    }
    if (outcome === 'workforce') throw staffAccountEmail();
    if (outcome === 'unchanged') {
      throw new DomainProblem(400, 'CONTACT_UNCHANGED', 'That is already the email address on your account.');
    }
    if (outcome === 'rate_limited') throw this.rateLimited('Wait a moment before asking for another code.');
    if (outcome === 'unavailable') throw contactUnavailable();
    if (outcome !== 'started') throw this.unavailable();
    // The new address is not yet proved to be the patient's: the code names no one.
    const delivery = await this.notification.deliverEmailChangeCode({
      changeId, recipient: email, code,
      expiresInMinutes: Math.ceil(this.environment.OTP_EXPIRY_SECONDS / 60), correlationId: request.correlationId,
    });
    try {
      await this.asPatient(request, actor, (client) => client.query(
        'select identity.record_my_contact_change_delivery($1, $2, $3, $4, $5)',
        [actor.subject, actor.sessionId, changeId, delivery.outcome, delivery.provider ?? null]));
    } catch (error) {
      throw patientCommandProblem(error);
    }
    if (delivery.outcome === 'definitive_failure') {
      throw new DomainProblem(422, 'CONTACT_CODE_UNDELIVERABLE',
        "We couldn't send a code to that email address. Check it and try again.");
    }
    return { changeId, maskedContact: maskDestination('email', email),
      expiresInSeconds: this.environment.OTP_EXPIRY_SECONDS,
      resendAfterSeconds: this.environment.OTP_RESEND_COOLDOWN_SECONDS };
  }

  private async changePhone(request: HidRequest, actor: ReturnType<typeof requirePatient>, phone: string)
    : Promise<{ phone: string; phoneVerified: boolean }> {
    const changeId = randomUUID();
    const [canonical, ...others] = patientPhoneStoredForms(phone).map((form) => createContactLookupHmac('phone', form));
    const ciphertext = this.crypto.encryptContact(changeId, 'phone', phone);
    let row: PhoneChangeRow | undefined;
    try {
      row = await this.asPatient(request, actor, async (client) => {
        // The number the profile shows now. A stored number Identity cannot
        // read (hid-1.0's, under the migration's key) shows as none: the same
        // number entered again is then written again under Identity's key, as
        // a change, so that the profile shows it from then on.
        const current = await this.reader.read(client, actor);
        return (await client.query<PhoneChangeRow>(
          'select outcome, notice_email, patient_first_name, patient_hid_code '
          + 'from identity.change_my_phone($1, $2, $3, $4, $5::char(64)[], $6, $7, $8)',
          [actor.subject, actor.sessionId, changeId, canonical, others, ciphertext, this.crypto.keyVersion,
            (current?.phone ?? null) === null])).rows[0];
      });
    } catch (error) {
      throw patientCommandProblem(error);
    }
    if (!row) throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient access is unavailable');
    if (row.outcome === 'rate_limited') throw this.rateLimited('Too many phone number changes. Try again later.');
    if (row.outcome === 'unavailable') throw contactUnavailable();
    // The number the profile already shows: nothing changed and nothing is sent.
    if (row.outcome === 'unchanged') {
      throw new DomainProblem(400, 'CONTACT_UNCHANGED', 'That is already the phone number on your account.',
        [{ field: 'phone', messages: ['That is already the phone number on your account.'] }]);
    }
    if (row.outcome !== 'changed') throw this.unavailable();
    if (row.notice_email) {
      this.announce(request.correlationId, changeId, row.notice_email, 'phone', row, maskDestination('sms', phone));
    }
    return { phone, phoneVerified: false };
  }

  /**
   * "Your Health ID email was changed" (to the previous address) or "Your
   * Health ID phone number was changed" (to the verified email), naming the
   * patient and their Health ID and showing the new contact masked.
   * Best-effort: never waited for; a failure is logged with the correlation
   * id and the outcome only.
   */
  private announce(correlationId: string, changeId: string, recipient: string, kind: 'email' | 'phone',
    row: { patient_first_name: string | null; patient_hid_code: string | null }, newContactHint: string): void {
    const naming = this.naming(row.patient_first_name, row.patient_hid_code);
    this.notices.run(correlationId, async () => {
      const delivery = await this.notification.deliverContactChanged({
        changeId, recipient, kind, newContactHint,
        ...(naming.firstName ? { firstName: naming.firstName } : {}),
        ...(naming.healthId ? { healthId: naming.healthId } : {}), correlationId,
      });
      if (delivery.outcome !== 'accepted') {
        this.logger.warn(`Contact-change notice was not accepted (correlation ${correlationId}, `
          + `outcome ${delivery.outcome}${delivery.safeCode ? `, code ${delivery.safeCode}` : ''})`);
      }
    });
  }

  private naming(firstName: string | null, hidCode: string | null): { firstName?: string; healthId?: string } {
    const name = emailFirstName(firstName);
    return { ...(name ? { firstName: name } : {}),
      ...(hidCode && /^HID-[A-HJ-NP-Z2-9]{6,32}$/.test(hidCode) ? { healthId: hidCode } : {}) };
  }

  private asPatient<T>(request: HidRequest, actor: ReturnType<typeof requirePatient>,
    work: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    return this.database.withSystemTransaction(request.correlationId, async (client) => {
      await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
      return work(client);
    });
  }

  private invalid(field: 'email' | 'phone'): DomainProblem {
    const message = field === 'email' ? 'Enter a valid email address.' : PHONE_MESSAGE;
    return new DomainProblem(400, 'CONTACT_INVALID', message, [{ field, messages: [message] }]);
  }

  private rateLimited(detail: string): DomainProblem {
    return new DomainProblem(429, 'CONTACT_CHANGE_RATE_LIMITED', detail);
  }

  private unavailable(): DomainProblem {
    return new DomainProblem(503, 'CONTACT_CHANGE_UNAVAILABLE', 'Contact changes are temporarily unavailable');
  }
}
