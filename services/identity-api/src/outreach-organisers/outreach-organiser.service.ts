import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { assertPasswordLength, hashAccountPassword } from '../auth/password-hash';
import { consumeRateLimit } from '../auth/rate-limit';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { createContactLookupHmac } from '../identity/contact-lookup';
import { OrganizationProfileCompletionService } from '../identity/organization-profile-completion.service';
import { quotaNetwork } from '../identity/provider-enrollment.service';
import type { ActivateOutreachOrganiserDto, StartOutreachGroupForAccountDto,
  StartOutreachOrganiserSignupDto } from './dto/outreach-organiser.dto';
import { databaseCode, domainHmac, encryptOutreachPhone, hasRefusal, normalizeOutreachPhone,
  OUTREACH_ORGANISER_TERMS_VERSION, OUTREACH_PHONE_MESSAGE, outreachKey, reservedNameProblem,
  reservedOrganiserName } from './outreach-organiser-crypto';
import { assertOutreachSignupOpen, outreachSignupGateRefusal, outreachSignupUnavailable } from './outreach-organiser-gate';

/** Sign-up starts per client network an hour (anti-bot, besides Turnstile and the public application quota). */
export const OUTREACH_SIGNUP_NETWORK_WINDOW = { windowSeconds: 3600, maxRequests: 10 } as const;
/** How long the sign-up cookie lives: the whole sign-up must finish within it. */
export const OUTREACH_SIGNUP_SESSION_SECONDS = 60 * 60;

const HMAC_DOMAIN = 'outreach-organiser-signup';

/** 0115's fixed timings: a code lasts 15 minutes, a new one can be asked for after a minute. */
export const OUTREACH_SIGNUP_CODE_SECONDS = 15 * 60;
export const OUTREACH_SIGNUP_RESEND_SECONDS = 60;

/** identity.activate_outreach_organiser (0115). */
interface ActivateRow extends QueryResultRow {
  organization_id: string;
  facility_id: string;
  account_id: string;
  membership_id: string;
  hid_subject: string;
  replayed: boolean;
}

/** identity.activate_outreach_organiser_for_account (0115). */
interface ForAccountRow extends QueryResultRow {
  result: string;
  organization_id: string | null;
  facility_id: string | null;
  membership_id: string | null;
}

export function emailAlreadyRegistered(): DomainProblem {
  return new DomainProblem(409, 'OUTREACH_ORGANISER_EMAIL_REGISTERED',
    'This email already has a Health ID account. Sign in with it, then choose "Start an outreach group".');
}

function signupSessionInvalid(): DomainProblem {
  return new DomainProblem(401, 'OUTREACH_ORGANISER_SIGNUP_SESSION_INVALID',
    'Your sign-up has timed out or was opened in another browser. Please start again.');
}

function signupExpired(): DomainProblem {
  return new DomainProblem(410, 'OUTREACH_ORGANISER_SIGNUP_EXPIRED',
    'Your sign-up has expired. Please start again.');
}

function patientLogin(): DomainProblem {
  return new DomainProblem(409, 'OUTREACH_ORGANISER_PATIENT_LOGIN',
    'This email is used for a Health ID patient account, which cannot run an outreach group yet. Use a different email.');
}

function emailRateLimited(): DomainProblem {
  return new DomainProblem(429, 'OUTREACH_ORGANISER_EMAIL_RATE_LIMITED',
    'We have sent sign-up codes to this email 3 times today. Look for the latest code in your inbox or spam folder, or try again tomorrow.');
}

function notEligible(): DomainProblem {
  return new DomainProblem(403, 'OUTREACH_ORGANISER_NOT_ELIGIBLE',
    'This account cannot start an outreach group. Use a staff account that is active and checked, or contact Health ID support.');
}

function newCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** The code as 0115 stores it: keyed, and bound to the sign-up. */
function codeHmac(key: Buffer, signupId: string, code: string): string {
  return domainHmac(key, HMAC_DOMAIN, 'otp', signupId, code);
}

/**
 * The refusal codes 0115's sign-up commands raise, in plain English. A test
 * compares this list with the migration's raise messages.
 */
export const OUTREACH_SIGNUP_REFUSALS: ReadonlyArray<readonly [string, () => DomainProblem]> = [
  ['OUTREACH_ORGANISER_EMAIL_REGISTERED', emailAlreadyRegistered],
  ['OUTREACH_ORGANISER_NAME_NOT_ALLOWED', reservedNameProblem],
  ['OUTREACH_ORGANISER_SIGNUP_NOT_READY', () => new DomainProblem(409, 'OUTREACH_ORGANISER_SIGNUP_NOT_READY',
    'Confirm your email with the 6-digit code before setting a password. If it has been more than a day, please start again.')],
  ['OUTREACH_ORGANISER_TERMS_REQUIRED', () => new DomainProblem(409, 'OUTREACH_ORGANISER_TERMS_REQUIRED',
    'The organiser terms have changed. Reload the page and accept the current terms.')],
  ['OUTREACH_ORGANISER_PASSWORD_INVALID', () => new DomainProblem(400, 'OUTREACH_ORGANISER_PASSWORD_INVALID',
    'That password could not be used. Choose another password of at least 12 characters.')],
  ['OUTREACH_ORGANISER_SIGNUP_INVALID', () => new DomainProblem(400, 'OUTREACH_ORGANISER_SIGNUP_INVALID',
    'Some of your details are not in the right form. Check your name, email, phone and group name, then try again.')],
  ['OUTREACH_ORGANISER_SIGNUP_DENIED', signupSessionInvalid],
  ['OUTREACH_ORGANISER_ACCOUNT_REQUIRED', () => new DomainProblem(401, 'OUTREACH_ORGANISER_ACCOUNT_REQUIRED',
    'Sign in again, then choose "Start an outreach group".')],
  ['OUTREACH_ROLE_ONLY_AT_OUTREACH_GROUP', () => new DomainProblem(409, 'OUTREACH_ROLE_ONLY_AT_OUTREACH_GROUP',
    'Outreach roles can only be given at an outreach group, never at a hospital.')],
  ['OUTREACH_GROUP_ROLE_INVALID', () => new DomainProblem(409, 'OUTREACH_GROUP_ROLE_INVALID',
    'An outreach group can only have organisers and helpers, never clinical roles.')],
  ['OUTREACH_ORGANISER_SUSPENDED', () => new DomainProblem(423, 'OUTREACH_ORGANISER_SUSPENDED',
    'This outreach group has been paused by Health ID. Contact Health ID support.')],
];

/**
 * Open sign-up on outreach. (plan PR-3, owner decisions of 11 Nov 2026): a
 * volunteer, NGO or community group signs up with their name, email, phone and
 * group name, proves the email with a 6-digit code, accepts the organiser
 * terms and sets a password. Activation creates their own private Outreach
 * organisation and signs them in. An existing Health ID account (for example
 * a hospital worker) starts an outreach group for itself with the same login.
 *
 * The database is authoritative for every rule (the fence on roles, the
 * name blocklist, pausing, consent and retention); Identity's
 * checks only answer earlier and in plain English. Secrets reach the database
 * only as HMACs; the phone as its contact lookup HMAC and a ciphertext.
 */
@Injectable()
export class OutreachOrganiserService {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(OutreachOrganiserService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly notification: NotificationOtpClient,
    private readonly completion: OrganizationProfileCompletionService,
  ) {}

  /** The gate: 423 OUTREACH_ORGANISER_SIGNUP_UNAVAILABLE while closed. */
  assertOpen(): Promise<void> {
    return assertOutreachSignupOpen(this.database);
  }

  /** { open, termsVersion }: never an error, so the page can fail safe and hide the sign-up. */
  async availability(): Promise<{ open: boolean; termsVersion: string }> {
    try {
      await this.assertOpen();
      return { open: outreachKey() !== null, termsVersion: OUTREACH_ORGANISER_TERMS_VERSION };
    } catch {
      return { open: false, termsVersion: OUTREACH_ORGANISER_TERMS_VERSION };
    }
  }

  /**
   * Starts a sign-up and emails the code. Returns the cookie value
   * (`<signupId>.<token>`) for the controller to set, and { challengeId (the
   * delivery's reference only), expiresInSeconds, resendAfterSeconds } for
   * the page. A start for an email
   * that already has an account is refused (409): that person signs in and
   * uses "Start an outreach group".
   */
  async start(input: StartOutreachOrganiserSignupDto, remoteIp: string | undefined, correlationId: string) {
    await this.assertOpen();
    const key = this.requireKey();
    const network = quotaNetwork(remoteIp);
    if (!network) throw outreachSignupUnavailable();
    const phone = normalizeOutreachPhone(input.phone);
    if (!phone) throw new DomainProblem(400, 'OUTREACH_PHONE_INVALID', OUTREACH_PHONE_MESSAGE);
    if (reservedOrganiserName(input.groupName)) throw reservedNameProblem();
    const phoneLookup = createContactLookupHmac('phone', phone);

    // Anti-bot, besides Turnstile: the network's own hourly window, in its own
    // committed transaction. The command then charges the public application
    // quota (0049, shared with every other public application) and its own
    // 5 sign-ups a day for the network, both under this digest.
    const networkDigest = this.completion.publicApplicationNetworkDigest(network);
    let limited = false;
    try {
      limited = await this.database.withSystemTransaction(correlationId, (client) =>
        consumeRateLimit(client, 'ip', domainHmac(key, HMAC_DOMAIN, 'network', network), OUTREACH_SIGNUP_NETWORK_WINDOW));
    } catch (error) {
      throw this.mapError(error);
    }
    if (limited) throw this.rateLimited();

    const signupId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const code = newCode();
    let outcome: string | undefined;
    try {
      outcome = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<{ outcome: string }>(
        'select identity.start_outreach_organiser_signup($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as outcome',
        [signupId, domainHmac(key, HMAC_DOMAIN, 'cookie', token), input.email, input.organiserName, input.groupName,
          input.kind, input.registrationNumber ?? null, phoneLookup, encryptOutreachPhone(key, phone),
          String(this.environment.OTP_HMAC_KEY_VERSION), networkDigest, codeHmac(key, signupId, code)])).rows[0]?.outcome);
    } catch (error) {
      throw this.mapError(error);
    }
    switch (outcome) {
      case 'started': break;
      case 'email_registered': throw emailAlreadyRegistered();
      case 'patient_login': throw patientLogin();
      case 'name_not_allowed': throw reservedNameProblem();
      case 'rate_limited': throw this.rateLimited();
      case 'email_rate_limited': throw emailRateLimited();
      case 'suspended': throw new DomainProblem(423, 'OUTREACH_ORGANISER_SUSPENDED',
        'This phone number belongs to an outreach group that Health ID has paused. Contact Health ID support.');
      default: throw outreachSignupUnavailable();
    }

    const challengeId = await this.sendCode(input.email, code, correlationId);
    return {
      cookie: `${signupId}.${token}`,
      body: { accepted: true as const, challengeId, expiresInSeconds: OUTREACH_SIGNUP_CODE_SECONDS,
        resendAfterSeconds: OUTREACH_SIGNUP_RESEND_SECONDS },
    };
  }

  /**
   * A new code for the sign-up the cookie names (after a minute, at most 5
   * codes in all). The command answers the sign-up's own email with 'sent'
   * (Identity has no read of the sign-up table), so the new code can only go
   * where the first one went.
   */
  async resend(cookie: string | undefined, correlationId: string) {
    await this.assertOpen();
    const key = this.requireKey();
    const session = this.parseCookie(cookie);
    const code = newCode();
    let answer: { result?: string; email?: string | null } = {};
    try {
      answer = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<{
        result: string; email: string | null }>(
        'select * from identity.resend_outreach_organiser_signup_code($1,$2,$3)',
        [session.signupId, domainHmac(key, HMAC_DOMAIN, 'cookie', session.token), codeHmac(key, session.signupId, code)]))
        .rows[0] ?? {});
    } catch (error) {
      throw this.mapError(error);
    }
    switch (answer.result) {
      case 'sent': break;
      case 'too_soon': throw new DomainProblem(429, 'OTP_RESEND_COOLDOWN',
        `We sent a code a moment ago. Wait ${OUTREACH_SIGNUP_RESEND_SECONDS} seconds before asking for another.`);
      case 'too_many': throw new DomainProblem(429, 'OTP_RESEND_LIMIT',
        'We have already sent 5 codes for this sign-up. Please start again.');
      case 'expired': throw signupExpired();
      case 'denied': throw signupSessionInvalid();
      default: throw outreachSignupUnavailable();
    }
    if (!answer.email) throw outreachSignupUnavailable();
    const challengeId = await this.sendCode(answer.email, code, correlationId);
    return { sent: true as const, challengeId, expiresInSeconds: OUTREACH_SIGNUP_CODE_SECONDS,
      resendAfterSeconds: OUTREACH_SIGNUP_RESEND_SECONDS };
  }

  /** Emails a code; the delivery id is returned to the page only as a reference. */
  private async sendCode(email: string, code: string, correlationId: string): Promise<string> {
    const challengeId = randomUUID();
    const delivered = await this.notification.deliver({ challengeId, recipient: email, code,
      purpose: 'SIGNUP_VERIFY', channel: 'email', correlationId }).catch(() => ({ outcome: 'unknown' as const }));
    if (delivered.outcome === 'definitive_failure') {
      throw new DomainProblem(503, 'OTP_DELIVERY_UNAVAILABLE',
        'We could not send the code to that email just now. Check the address and try again in a few minutes.');
    }
    return challengeId;
  }

  /**
   * Checks the emailed code against the sign-up the cookie names: 200
   * { verified: true }. A wrong code is counted by the database (5 wrong
   * codes lock it until a new code is sent).
   */
  async verify(cookie: string | undefined, code: string, correlationId: string) {
    await this.assertOpen();
    const key = this.requireKey();
    const session = this.parseCookie(cookie);
    let result: string | undefined;
    try {
      result = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<{ result: string }>(
        'select identity.verify_outreach_organiser_email($1,$2,$3) as result',
        [session.signupId, domainHmac(key, HMAC_DOMAIN, 'cookie', session.token),
          codeHmac(key, session.signupId, code)])).rows[0]?.result);
    } catch (error) {
      throw this.mapError(error);
    }
    switch (result) {
      case 'verified': return { verified: true as const };
      case 'wrong_code': throw new DomainProblem(400, 'OTP_INVALID', 'That code is not right. Check the email and try again.');
      case 'code_expired': throw new DomainProblem(410, 'OTP_EXPIRED', 'That code has expired. Ask for a new one.');
      case 'locked': throw new DomainProblem(429, 'OTP_ATTEMPTS_EXHAUSTED',
        'Too many wrong codes. Ask for a new code and try again.');
      case 'expired': throw signupExpired();
      case 'denied': throw signupSessionInvalid();
      default: throw outreachSignupUnavailable();
    }
  }

  /**
   * Accepts the terms, sets the password and creates the organiser's own
   * Outreach organisation, whose campaigns can go live at once (owner
   * decision Q38: no Health ID check first). The controller then signs
   * the organiser in with that password.
   */
  async activate(cookie: string | undefined, input: ActivateOutreachOrganiserDto, correlationId: string) {
    await this.assertOpen();
    const key = this.requireKey();
    assertPasswordLength(input.password);
    const session = this.parseCookie(cookie);
    const passwordHash = await hashAccountPassword(input.password);
    let activated: { row: ActivateRow; email: string } | undefined;
    try {
      activated = await this.database.withSystemTransaction(correlationId, async (client) => {
        const row = (await client.query<ActivateRow>(
          'select * from identity.activate_outreach_organiser($1,$2,$3,$4)',
          [session.signupId, domainHmac(key, HMAC_DOMAIN, 'cookie', session.token), passwordHash,
            input.termsVersion])).rows[0];
        if (!row) return undefined;
        // The sign-in that follows needs the login's email; the command does not answer it.
        const email = (await client.query<{ email: string }>(
          'select lower(account.email) as email from auth.accounts account where account.id = $1',
          [row.account_id])).rows[0]?.email;
        return email ? { row, email } : undefined;
      });
    } catch (error) {
      throw this.mapError(error);
    }
    if (!activated) throw signupSessionInvalid();
    const { row, email } = activated;
    return { organizationId: row.organization_id, facilityId: row.facility_id, accountId: row.account_id,
      membershipId: row.membership_id, email, replayed: row.replayed === true };
  }

  /**
   * "Start an outreach group" for a signed-in Health ID account (owner
   * decision 5): the account gets a second membership, as outreach_organiser,
   * at its own new outreach organisation, and keeps every role it has at a
   * hospital. It then switches to the new facility with the facility picker.
   */
  async startForAccount(context: DataAccessContext, input: StartOutreachGroupForAccountDto) {
    if (context.actor.kind === 'patient') {
      throw new DomainProblem(403, 'OUTREACH_ORGANISER_STAFF_ACCOUNT_REQUIRED',
        'Sign in with a staff account to start an outreach group.');
    }
    await this.assertOpen();
    const key = this.requireKey();
    const phone = normalizeOutreachPhone(input.phone);
    if (!phone) throw new DomainProblem(400, 'OUTREACH_PHONE_INVALID', OUTREACH_PHONE_MESSAGE);
    if (reservedOrganiserName(input.groupName)) throw reservedNameProblem();
    let row: ForAccountRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<ForAccountRow>(
        'select * from identity.activate_outreach_organiser_for_account($1,$2,$3,$4,$5,$6,$7)',
        [input.groupName, input.kind, input.registrationNumber ?? null, input.termsVersion,
          createContactLookupHmac('phone', phone), encryptOutreachPhone(key, phone),
          String(this.environment.OTP_HMAC_KEY_VERSION)])).rows[0]);
    } catch (error) {
      throw this.mapError(error);
    }
    switch (row?.result) {
      case 'started': break;
      case 'already_organiser': throw new DomainProblem(409, 'OUTREACH_ORGANISER_ALREADY_RUNNING',
        'You already run an outreach group with this account. Choose it in the facility picker.');
      case 'suspended': throw new DomainProblem(403, 'OUTREACH_ORGANISER_SUSPENDED',
        'Your outreach group was paused by Health ID. Contact Health ID support.');
      case 'patient_login': throw new DomainProblem(403, 'OUTREACH_ORGANISER_PATIENT_LOGIN',
        'A Health ID patient account cannot run an outreach group yet. Sign in with a staff account.');
      case 'name_not_allowed': throw reservedNameProblem();
      case 'not_eligible': throw notEligible();
      default: throw outreachSignupUnavailable();
    }
    if (!row.organization_id || !row.facility_id || !row.membership_id) throw outreachSignupUnavailable();
    return { started: true as const, organizationId: row.organization_id, facilityId: row.facility_id,
      membershipId: row.membership_id, organiserStatus: 'active' as const, label: 'Unverified organiser' as const };
  }

  private parseCookie(cookie: string | undefined): { signupId: string; token: string } {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i
      .exec(cookie ?? '');
    if (!match?.[1] || !match[2]) throw signupSessionInvalid();
    return { signupId: match[1], token: match[2] };
  }

  private requireKey(): Buffer {
    const key = outreachKey();
    if (!key) throw outreachSignupUnavailable();
    return key;
  }

  private rateLimited(): DomainProblem {
    return new DomainProblem(429, 'OUTREACH_ORGANISER_SIGNUP_RATE_LIMITED',
      'Too many sign-ups have been started from this network. Please try again in an hour.');
  }

  /** The database's refusals in plain English; anything unknown is 503. */
  mapError(error: unknown): DomainProblem {
    if (error instanceof DomainProblem) return error;
    const closed = outreachSignupGateRefusal(error);
    if (closed) return closed;
    const code = databaseCode(error);
    if (code === 'P4290') return this.rateLimited();
    for (const [refusal, problem] of OUTREACH_SIGNUP_REFUSALS) {
      if (hasRefusal(error, refusal)) return problem();
    }
    if (code === '23505') return emailAlreadyRegistered();
    if (code === '40001') {
      return new DomainProblem(409, 'VERSION_CONFLICT', 'Something changed while we were saving. Please try again.');
    }
    if (code === '42501') return notEligible();
    this.logger.warn(`Outreach organiser sign-up failed (event=outreach_organiser_signup_failed code=${code ?? 'none'})`);
    return outreachSignupUnavailable();
  }
}
