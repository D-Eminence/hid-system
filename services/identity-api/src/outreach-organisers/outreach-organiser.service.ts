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

interface StartRow extends QueryResultRow {
  outcome: string;
  signup_id: string | null;
  challenge_id: string | null;
  resend_after_seconds: number | null;
}

interface ActivateRow extends QueryResultRow {
  organization_id: string;
  facility_id: string;
  account_id: string;
  membership_id: string;
  email: string;
}

interface ForAccountRow extends QueryResultRow {
  organization_id: string;
  facility_id: string;
  membership_id: string;
}

export function emailAlreadyRegistered(): DomainProblem {
  return new DomainProblem(409, 'OUTREACH_ORGANISER_EMAIL_REGISTERED',
    'This email already has a Health ID account. Sign in with it, then choose "Start an outreach group".');
}

function signupSessionInvalid(): DomainProblem {
  return new DomainProblem(401, 'OUTREACH_ORGANISER_SIGNUP_SESSION_INVALID',
    'Your sign-up has timed out or was opened in another browser. Please start again.');
}

/**
 * Open sign-up on outreach. (plan PR-3, owner decisions of 11 Nov 2026): a
 * volunteer, NGO or community group signs up with their name, email, phone and
 * group name, proves the email with a 6-digit code, accepts the organiser
 * terms and sets a password. Activation creates their own private Outreach
 * organisation and signs them in. An existing Health ID account (for example
 * a hospital worker) starts an outreach group for itself with the same login.
 *
 * The database is authoritative for every rule (the fence on roles, the
 * review before a first live campaign, consent and retention); Identity's
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
   * (`<signupId>.<token>`) for the controller to set, and { challengeId,
   * expiresInSeconds, resendAfterSeconds } for the page. A start for an email
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

    // Anti-bot: the network's own window, then the public application quota
    // (0049) shared with every other public application, in one committed
    // transaction so a refused start still costs quota.
    let limited = false;
    try {
      limited = await this.database.withSystemTransaction(correlationId, async (client) => {
        const blocked = await consumeRateLimit(client, 'ip', domainHmac(key, HMAC_DOMAIN, 'network', network),
          OUTREACH_SIGNUP_NETWORK_WINDOW);
        if (blocked) return true;
        await client.query('select platform.consume_public_application_quota($1)',
          [this.completion.publicApplicationNetworkDigest(network)]);
        return false;
      });
    } catch (error) {
      throw this.mapError(error);
    }
    if (limited) throw this.rateLimited();

    const signupId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const challengeId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    let row: StartRow | undefined;
    try {
      row = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<StartRow>(
        'select * from identity.start_outreach_organiser_signup($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
        [signupId, domainHmac(key, HMAC_DOMAIN, 'cookie', token), input.email, phoneLookup,
          encryptOutreachPhone(key, phone), input.organiserName, input.groupName, input.kind,
          input.registrationNumber ?? null, domainHmac(key, HMAC_DOMAIN, 'network', network), challengeId,
          domainHmac(key, HMAC_DOMAIN, 'otp', signupId, challengeId, code),
          this.environment.OTP_HMAC_KEY_VERSION, this.environment.OTP_EXPIRY_SECONDS,
          this.environment.OTP_MAX_ATTEMPTS])).rows[0]);
    } catch (error) {
      throw this.mapError(error);
    }
    if (row?.outcome === 'email_registered') throw emailAlreadyRegistered();
    if (row?.outcome === 'resend_wait') {
      throw new DomainProblem(429, 'OTP_RESEND_COOLDOWN',
        `We sent a code a moment ago. Wait ${row.resend_after_seconds ?? this.environment.OTP_RESEND_COOLDOWN_SECONDS} seconds before asking for another.`);
    }
    if (row?.outcome !== 'code_issued' || row.signup_id !== signupId || row.challenge_id !== challengeId) {
      throw outreachSignupUnavailable();
    }

    const delivered = await this.notification.deliver({ challengeId, recipient: input.email, code,
      purpose: 'SIGNUP_VERIFY', channel: 'email', correlationId }).catch(() => ({ outcome: 'unknown' as const }));
    if (delivered.outcome === 'definitive_failure') {
      throw new DomainProblem(503, 'OTP_DELIVERY_UNAVAILABLE',
        'We could not send the code to that email just now. Check the address and try again in a few minutes.');
    }
    return {
      cookie: `${signupId}.${token}`,
      body: { accepted: true as const, challengeId, expiresInSeconds: this.environment.OTP_EXPIRY_SECONDS,
        resendAfterSeconds: this.environment.OTP_RESEND_COOLDOWN_SECONDS },
    };
  }

  /** Checks the emailed code against the sign-up the cookie names: 200 { verified: true }. */
  async verify(cookie: string | undefined, challengeId: string, code: string, correlationId: string) {
    await this.assertOpen();
    const key = this.requireKey();
    const session = this.parseCookie(cookie);
    let result: string | undefined;
    try {
      result = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<{ result: string }>(
        'select * from identity.verify_outreach_organiser_email($1,$2,$3,$4)',
        [session.signupId, domainHmac(key, HMAC_DOMAIN, 'cookie', session.token), challengeId,
          domainHmac(key, HMAC_DOMAIN, 'otp', session.signupId, challengeId, code)])).rows[0]?.result);
    } catch (error) {
      throw this.mapError(error);
    }
    switch (result) {
      case 'verified': return { verified: true as const };
      case 'invalid_code': throw new DomainProblem(400, 'OTP_INVALID', 'That code is not right. Check the email and try again.');
      case 'expired': throw new DomainProblem(410, 'OTP_EXPIRED', 'That code has expired. Ask for a new one.');
      case 'attempts_exhausted': throw new DomainProblem(429, 'OTP_ATTEMPTS_EXHAUSTED',
        'Too many wrong codes. Ask for a new code and try again.');
      case 'not_found': throw signupSessionInvalid();
      default: throw outreachSignupUnavailable();
    }
  }

  /**
   * Accepts the terms, sets the password and creates the organiser's own
   * Outreach organisation (review state pending). The controller then signs
   * the organiser in with that password.
   */
  async activate(cookie: string | undefined, input: ActivateOutreachOrganiserDto, correlationId: string) {
    await this.assertOpen();
    const key = this.requireKey();
    assertPasswordLength(input.password);
    const session = this.parseCookie(cookie);
    const passwordHash = await hashAccountPassword(input.password);
    let row: ActivateRow | undefined;
    try {
      row = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<ActivateRow>(
        'select * from identity.activate_outreach_organiser($1,$2,$3,$4)',
        [session.signupId, domainHmac(key, HMAC_DOMAIN, 'cookie', session.token), passwordHash,
          input.termsVersion])).rows[0]);
    } catch (error) {
      throw this.mapError(error);
    }
    if (!row) throw signupSessionInvalid();
    return { organizationId: row.organization_id, facilityId: row.facility_id, accountId: row.account_id,
      membershipId: row.membership_id, email: row.email };
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
        'select * from identity.activate_outreach_organiser_for_account($1,$2,$3,$4,$5,$6)',
        [input.groupName, input.kind, input.registrationNumber ?? null, createContactLookupHmac('phone', phone),
          encryptOutreachPhone(key, phone), input.termsVersion])).rows[0]);
    } catch (error) {
      throw this.mapError(error);
    }
    if (!row) throw outreachSignupUnavailable();
    return { started: true as const, organizationId: row.organization_id, facilityId: row.facility_id,
      membershipId: row.membership_id, reviewState: 'pending' as const };
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
    if (hasRefusal(error, 'OUTREACH_ORGANISER_EMAIL_REGISTERED')) return emailAlreadyRegistered();
    if (hasRefusal(error, 'OUTREACH_ORGANISER_NAME_RESERVED')) return reservedNameProblem();
    if (hasRefusal(error, 'OUTREACH_ORGANISER_NOT_VERIFIED')) {
      return new DomainProblem(409, 'OUTREACH_ORGANISER_NOT_VERIFIED',
        'Confirm your email with the 6-digit code before setting a password.');
    }
    if (hasRefusal(error, 'OUTREACH_TERMS_VERSION_INVALID')) {
      return new DomainProblem(409, 'OUTREACH_TERMS_VERSION_INVALID',
        'The organiser terms have changed. Reload the page and accept the current terms.');
    }
    if (hasRefusal(error, 'OUTREACH_ORGANISER_ALREADY_RUNNING')) {
      return new DomainProblem(409, 'OUTREACH_ORGANISER_ALREADY_RUNNING',
        'You already run an outreach group with this account. Choose it in the facility picker.');
    }
    if (hasRefusal(error, 'OUTREACH_ORGANISER_SIGNUP_SESSION_INVALID')) return signupSessionInvalid();
    if (code === '23505') return emailAlreadyRegistered();
    if (code === '40001') {
      return new DomainProblem(409, 'VERSION_CONFLICT', 'Something changed while we were saving. Please try again.');
    }
    if (code === '42501') {
      return new DomainProblem(403, 'OUTREACH_ORGANISER_SIGNUP_DENIED', 'You cannot start an outreach group with this account.');
    }
    this.logger.warn(`Outreach organiser sign-up failed (event=outreach_organiser_signup_failed code=${code ?? 'none'})`);
    return outreachSignupUnavailable();
  }
}
