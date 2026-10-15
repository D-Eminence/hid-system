import { type BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { MFA_RETRY_AFTER_SECONDS, MfaService } from '../auth/mfa/mfa.service';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { generateSixDigitOtp } from '../auth/otp.service';
import { assertPasswordLength, hashAccountPassword } from '../auth/password-hash';
import type { SessionEventMetadata } from '../auth/token.service';
import { AFTER_RESPONSE_SHUTDOWN_GRACE_MS, AfterResponseTasks } from '../common/after-response-tasks';
import { publicClientNetwork } from '../common/client-network';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, PublicDetailProblem, RetryAfterProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { ClinicianApplicationCapabilityKind } from './clinician-application-cookie';
import { CLINICIAN_REGULATOR_OF, type ClinicianApplicationDetailsDto,
  type SubmitClinicianApplicationDto } from './dto/clinician-application.dto';

/** The request facts the clinician application commands use (never logged). */
export interface ClinicianRequest {
  correlationId: string;
  ip?: string;
  userAgent?: string;
}

/** The applicant's view of one application (identity.clinician_application_view). */
export type ClinicianApplicationView = Record<string, unknown>;
/** The applicant's account view (identity.clinician_application_account_view). */
export interface ClinicianAccountView extends Record<string, unknown> {
  stage: string;
  applications: ClinicianApplicationView[];
}

type QuotaOperation = 'email_code' | 'status_code' | 'facility_search' | 'submit';
type QuotaName = 'SIGNUP' | 'STATUS' | 'SEARCH' | 'SUBMIT';
const QUOTA_NAMES: Readonly<Record<QuotaOperation, QuotaName>> = Object.freeze({
  email_code: 'SIGNUP', status_code: 'STATUS', facility_search: 'SEARCH', submit: 'SUBMIT',
});

interface CapabilityRow {
  kind: ClinicianApplicationCapabilityKind;
  stage: 'enrolment_required' | 'authenticator_required' | 'ready' | null;
  account_id: string | null;
  mfa_challenge_id: string | null;
  expires_at: Date;
}

/** A capability token: 32 random bytes, base64url (43 characters). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** The quota windows are an hour and a day: the longer one bounds every refusal (A21). */
const QUOTA_RETRY_AFTER_SECONDS = 86_400;
/** A capability's own search budget lasts as long as the capability, at most an hour. */
const SEARCH_BUDGET_RETRY_AFTER_SECONDS = 3_600;
const CODE_ANSWER = { accepted: true as const, expiresInSeconds: 600, resendAfterSeconds: 60 };
const localKey = randomBytes(32);

const SIGNUP_CLOSED_DETAIL = 'Clinician sign-up is not open yet. If you already have a Health ID provider account, sign in.';
const EMAIL_IN_USE_DETAIL = 'This email address already has a Health ID account. Sign in, reset your password,'
  + ' or use a different email address for your clinician account.';
const FACTOR_UNPROVEN_DETAIL = 'Your authenticator was set up at platform sign-in. Contact HID support to reset it.';
const STAFF_SIGN_IN_DETAIL = 'Your authenticator was reset. Sign in to the provider portal to set it up again,'
  + ' or contact HID support.';

/**
 * The submit probe's answers for C8's refusals that need no password, with
 * the SQLSTATE C8 raises them with: P4 charges the quota, then answers them
 * as C8 would, without hashing the password.
 */
const SUBMIT_PROBE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  CLINICIAN_APPLICATION_INVALID: '22023',
  CLINICIAN_APPLICATION_FACILITY_UNAVAILABLE: '23514',
  CLINICIAN_APPLICATION_FACILITY_BUSY: '23514',
  CLINICIAN_EMAIL_IN_USE: '23505',
});

let replayPlaceholder: Promise<string> | undefined;
/**
 * What a submit replay passes as its password hash. C8 answers a replay from
 * the spent draft before it reads the hash and stores nothing, so a replay
 * costs no argon2id run of the applicant's password. A real argon2id hash of
 * random bytes, in the format C8 checks, computed once per process and never
 * stored.
 */
function replayPlaceholderHash(): Promise<string> {
  replayPlaceholder ??= hashAccountPassword(randomBytes(32).toString('base64url')).catch((error: unknown) => {
    replayPlaceholder = undefined;
    throw error;
  });
  return replayPlaceholder;
}

/** 409 answers of the database's conflict markers (23505 and 23514), with their fixed details. */
const CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  CLINICIAN_APPLICATION_ALREADY_OPEN: 'You already have an open application at this facility',
  CLINICIAN_APPLICATION_MEMBERSHIP_EXISTS: 'You already have access at this facility',
  CLINICIAN_APPLICATION_FACILITY_UNAVAILABLE: 'This facility is not accepting clinician applications',
  CLINICIAN_APPLICATION_FACILITY_BUSY: 'This facility has too many open applications; try again later',
  CLINICIAN_APPLICATION_ROLE_CONFLICT: 'Your role at this facility cannot hold a clinical role as well',
  CLINICIAN_APPLICATION_LIMIT_REACHED: 'You have reached the limit of open or recent applications',
  CLINICIAN_APPLICATION_STATE_INVALID: 'This application can no longer be changed; reload it',
});

/**
 * Clinician self sign-up and its status page (ADR-064, owner decision 2). A
 * doctor or nurse proves an email address, submits a licence and a facility,
 * and sets up an authenticator before any review; two Super Admins then
 * verify and grant (AdminClinicianApplicationsService). Nothing here issues a
 * session or a role: the browser holds only the application capability, and
 * the 0088 challenge that capability drives is derived here and never leaves
 * Identity, so no value captured from these routes works at /auth/mfa/*.
 *
 * The database commands (0094) hold every rule; this service adds the gate
 * and quota order, the keyed digests, the delivery after the response and
 * the HTTP answers. Nothing it logs carries an email, a name, a licence, a
 * search, a code or a token.
 */
@Injectable()
export class ClinicianApplicationService implements BeforeApplicationShutdown {
  private readonly environment = getEnvironment();
  private readonly key = this.environment.OTP_HMAC_KEY_B64
    ? Buffer.from(this.environment.OTP_HMAC_KEY_B64, 'base64') : localKey;
  private readonly deliveries = new AfterResponseTasks(new Logger(ClinicianApplicationService.name),
    'Clinician application code delivery or its invalidation failed');

  constructor(private readonly database: DatabaseService,
    private readonly notification: NotificationOtpClient,
    private readonly mfa: MfaService) {}

  /** Waits for the deliveries started so far, and any started meanwhile. */
  settleDeliveries(): Promise<void> {
    return this.deliveries.settle();
  }

  /** Runs before DatabaseService ends the pool, so a failed delivery can still invalidate its challenge. */
  beforeApplicationShutdown(): Promise<void> {
    return this.deliveries.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS);
  }

  /** P0: whether intake is open (C1). Unconfigured is closed; a fault is 503. */
  async availability(correlationId: string): Promise<{ open: boolean }> {
    if (!this.configured()) return { open: false };
    try {
      const open = await this.database.withSystemTransaction(correlationId, async (client) =>
        (await client.query<{ open: boolean }>('select identity.clinician_signup_open() as open')).rows[0]?.open);
      return { open: open === true };
    } catch {
      throw new DomainProblem(503, 'PLATFORM_CONTROL_UNAVAILABLE', 'Platform runtime controls are unavailable');
    }
  }

  /**
   * P1: a sign-up email code. Every address gets the same answer; the code is
   * delivered after the response, so its timing tells nothing either.
   */
  startSignup(email: string, request: ClinicianRequest) {
    return this.startCode('signup', email, request);
  }

  /** P10: a status-page email code; only an applicant's address gets a real one. */
  startStatus(email: string, request: ClinicianRequest) {
    return this.startCode('status', email, request);
  }

  /** P2: a correct sign-up code opens a 60-minute draft. */
  async verifySignupCode(input: { challengeId: string; email: string; code: string }, request: ClinicianRequest):
    Promise<{ answer: { verified: true; expiresAt: string }; token: string }> {
    this.assertConfigured();
    const token = this.newToken();
    const result = await this.run(request, async (client) => {
      await this.gate(client, 'intake');
      const outcome = (await client.query<{ outcome: string }>(
        'select identity.verify_clinician_application_signup_code($1,$2,$3,$4,$5) as outcome',
        [input.challengeId, this.hmac('email', input.email), input.email,
          this.hmac('otp', input.challengeId, input.code), this.hmac('session', token)],
      )).rows[0]?.outcome;
      if (outcome !== 'verified') return { verified: false, inUse: outcome === 'email_in_use' } as const;
      const capability = await this.capability(client, token);
      return { verified: true, expiresAt: capability.expires_at } as const;
    });
    if (!result.verified && result.inUse) {
      throw new DomainProblem(409, 'CLINICIAN_EMAIL_IN_USE', EMAIL_IN_USE_DETAIL);
    }
    if (!result.verified) throw this.codeInvalid();
    return { answer: { verified: true, expiresAt: new Date(result.expiresAt).toISOString() }, token };
  }

  /**
   * P11: a correct status code opens a 30-minute account capability at the
   * stage its authenticator requires, and the 0088 challenge of that stage.
   */
  async verifyStatusCode(input: { challengeId: string; email: string; code: string }, request: ClinicianRequest):
    Promise<{ answer: { next: 'authenticator_verify' | 'authenticator_setup'; expiresAt: string }; token: string }> {
    this.assertConfigured();
    const token = this.newToken();
    const result = await this.run(request, async (client) => {
      const row = (await client.query<{ outcome: string; account_id: string | null; stage: string | null }>(
        'select outcome, account_id::text, stage from identity.verify_clinician_application_status_code($1,$2,$3,$4)',
        [input.challengeId, this.hmac('email', input.email), this.hmac('otp', input.challengeId, input.code),
          this.hmac('session', token)],
      )).rows[0];
      if (row?.outcome !== 'verified' || !row.account_id) {
        return { verified: false, unproven: row?.outcome === 'factor_unproven',
          staffSignIn: row?.outcome === 'staff_sign_in_required' } as const;
      }
      await this.openChallenge(client, token, row.account_id, request);
      const capability = await this.capability(client, token);
      return { verified: true, stage: capability.stage, expiresAt: capability.expires_at } as const;
    });
    if (!result.verified && result.unproven) {
      throw new DomainProblem(403, 'STAFF_MFA_FACTOR_UNPROVEN', FACTOR_UNPROVEN_DETAIL);
    }
    if (!result.verified && result.staffSignIn) throw this.staffSignInRequired();
    if (!result.verified) throw this.codeInvalid();
    return { answer: { next: result.stage === 'authenticator_required' ? 'authenticator_verify' : 'authenticator_setup',
      expiresAt: new Date(result.expiresAt).toISOString() }, token };
  }

  /**
   * P3: verified, active facilities of active organizations matching the
   * query, in one transaction: the gate (closed intake, then maintenance),
   * then the capability (a missing, malformed or forged one is 401), then
   * the accountless rule (a draft is held to a signed-out browser, `signedIn`
   * refuses it; a ready account capability may search while signed in
   * elsewhere), then the quota and the search.
   */
  async searchFacilities(token: string | undefined, query: string, signedIn: boolean, request: ClinicianRequest) {
    this.assertConfigured();
    const networkDigest = this.networkDigest(request.ip);
    const result = await this.run(request, async (client) => {
      await this.gate(client, 'intake');
      const sessionHmac = this.sessionHmac(token);
      const capability = await this.capability(client, token!, sessionHmac);
      if (capability.kind === 'draft' && signedIn) throw this.requiresSignOut();
      if (!(await this.quota(client, networkDigest, 'facility_search'))) return { kind: 'rate_limited' } as const;
      const rows = (await client.query<{ facility_id: string; facility_name: string; organization_name: string }>(
        'select facility_id::text, facility_name, organization_name from identity.search_clinician_application_facilities($1,$2)',
        [sessionHmac, query])).rows;
      return { kind: 'found', rows } as const;
    });
    if (result.kind === 'rate_limited') throw this.rateLimited(QUOTA_RETRY_AFTER_SECONDS);
    return { facilities: result.rows.map((row) => ({ facilityId: row.facility_id, name: row.facility_name,
      organizationName: row.organization_name })) };
  }

  /**
   * P4: the sign-up. After the gate, the draft is checked (a live draft of
   * this address, or one this key and request already spent), so a missing,
   * forged or spent capability is refused before anything is charged or
   * hashed, and a closed intake is answered as closed whatever the cookie; with
   * it, the probe answers C8's refusals that need no password. Then the
   * quota is charged and committed (a submission that will be hashed counts
   * against its draft's five hashes in the same transaction). A refusal is
   * answered without hashing; a replay passes a placeholder (C8 answers it
   * from the spent draft); only a submission C8 may create hashes the
   * password, with argon2id. Then one transaction creates the account, the
   * pending staff record and the application (C8, which counts it against
   * the platform's daily cap and refuses it at the cap, under the counter's
   * lock), opens the 0088 enrolment challenge on a token derived from the
   * next capability, and binds it (C9).
   */
  async submit(token: string | undefined, idempotencyKey: string, input: SubmitClinicianApplicationDto,
    request: ClinicianRequest) {
    assertPasswordLength(input.password);
    this.assertPairing(input);
    this.assertConfigured();
    const networkDigest = this.networkDigest(request.ip);
    const { password: _password, ...withoutPassword } = input;
    const digest = requestDigest('clinician-application.submit', withoutPassword);
    let sessionHmac = '';
    let outcome = '';
    await this.chargeQuota(networkDigest, 'submit', request, async (client) => {
      // After the gate: a missing or malformed capability is refused as a forged one is.
      sessionHmac = this.sessionHmac(token);
      outcome = (await client.query<{ outcome: string }>(
        'select identity.clinician_application_submit_probe($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as outcome',
        [sessionHmac, this.hmac('email', input.email), idempotencyKey, digest, input.email, input.fullName,
          input.profession, input.regulator, input.licenceNumber, input.licenceValidUntil, input.facilityId,
          this.environment.CLINICIAN_APPLICATION_FACILITY_OPEN_LIMIT])).rows[0]?.outcome ?? '';
      if (outcome !== 'new' && outcome !== 'replay' && !Object.hasOwn(SUBMIT_PROBE_REFUSALS, outcome)) {
        throw this.unavailable();
      }
    }, async (client) => {
      // A submission that will hash the password counts against its draft's five hashes.
      if (outcome === 'new') {
        await client.query('select identity.count_clinician_application_submit_attempt($1)', [sessionHmac]);
      }
    });
    if (outcome !== 'new' && outcome !== 'replay') {
      throw this.databaseProblem({ code: SUBMIT_PROBE_REFUSALS[outcome], message: outcome });
    }
    const passwordHash = outcome === 'replay' ? await replayPlaceholderHash() : await hashAccountPassword(input.password);
    const next = this.newToken();
    const result = await this.run(request, async (client) => {
      const row = (await client.query<{
        application_id: string; account_id: string; state: string; submitted_at: Date; expires_at: Date;
        facility_id: string; facility_name: string; application_version: string; session_stage: string;
        replayed: boolean;
      }>(
        `select application_id::text, account_id::text, state, submitted_at, expires_at, facility_id::text,
                facility_name, application_version::text, session_stage, replayed
           from identity.submit_clinician_application($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [sessionHmac, this.hmac('session', next), idempotencyKey, digest, input.email, this.hmac('email', input.email),
          input.fullName, passwordHash, input.profession, input.regulator, input.licenceNumber,
          input.licenceValidUntil, input.facilityId, this.environment.CLINICIAN_APPLICATION_FACILITY_OPEN_LIMIT,
          this.environment.CLINICIAN_APPLICATION_SUBMIT_PLATFORM_DAILY_LIMIT],
      )).rows[0];
      if (!row) throw this.unavailable();
      const authenticator = await this.openChallenge(client, next, row.account_id, request);
      return { row, authenticator };
    });
    const { row, authenticator } = result;
    return {
      answer: {
        applicationId: row.application_id,
        state: row.state,
        submittedAt: new Date(row.submitted_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
        facility: { id: row.facility_id, name: row.facility_name },
        profession: input.profession,
        version: Number(row.application_version),
        replayed: row.replayed,
        next: 'authenticator' as const,
        // Null only when the account's challenge budget is spent: P9 opens it later.
        authenticator: authenticator
          ? { purpose: authenticator.purpose, expiresAt: authenticator.expiresAt.toISOString() } : null,
      },
      token: next,
    };
  }

  /**
   * P5: the emailed proof of the enrolment (0088 sendEnrollmentCode on the
   * derived token). As on every authenticator step, a database fault is 503
   * and the 0088 answers keep their codes.
   */
  async sendAuthenticatorCode(token: string | undefined, request: ClinicianRequest) {
    const derived = await this.authenticatorToken(token, request);
    try {
      const sent = await this.mfa.sendEnrollmentCode(derived, this.event(request));
      return { ...sent, expiresAt: sent.expiresAt.toISOString() };
    } catch (error) {
      throw this.databaseProblem(error);
    }
  }

  /** P6: verifies the emailed proof and returns the new TOTP secret, once. */
  async startAuthenticator(token: string | undefined, emailCode: string, request: ClinicianRequest) {
    const derived = await this.authenticatorToken(token, request);
    try {
      const enrollment = await this.mfa.startEnrollment(derived, this.event(request), 'staff', { emailCode },
        { applicant: true });
      return { ...enrollment, expiresAt: enrollment.expiresAt.toISOString() };
    } catch (error) {
      throw this.databaseProblem(error);
    }
  }

  /**
   * P7: activates the authenticator with its first code, without a session;
   * in the same transaction the capability becomes ready and the account's
   * applications awaiting it are submitted for review (C10).
   */
  async activateAuthenticator(token: string | undefined, code: string, request: ClinicianRequest) {
    const sessionHmac = this.sessionHmac(token);
    const derived = await this.authenticatorToken(token, request);
    try {
      const activated = await this.mfa.activateEnrollment(derived, code, this.event(request), 'staff', {
        issue: 'none',
        onActivated: (client, factorId) => this.authenticatorReady(client, sessionHmac, factorId, 'enrolment'),
      });
      return { recoveryCodes: activated.recoveryCodes, ...activated.result };
    } catch (error) {
      throw this.databaseProblem(error);
    }
  }

  /** P8: verifies the authenticator (a TOTP code or one recovery code), without a session, then C10. */
  async verifyAuthenticator(token: string | undefined, input: { code?: string; recoveryCode?: string },
    request: ClinicianRequest) {
    const sessionHmac = this.sessionHmac(token);
    const derived = await this.authenticatorToken(token, request);
    try {
      const verified = await this.mfa.completeLogin(derived, input, this.event(request), 'staff', {
        issue: 'none',
        onVerified: (client, factor) => this.authenticatorReady(client, sessionHmac, factor.factorId, factor.method),
      });
      return verified.result;
    } catch (error) {
      throw this.databaseProblem(error);
    }
  }

  /** P9: re-opens the 0088 challenge of the capability's stage (the previous one is superseded). */
  async reopenAuthenticator(token: string | undefined, request: ClinicianRequest) {
    const sessionHmac = this.sessionHmac(token);
    const capability = await this.run(request, (client) => this.capability(client, token!, sessionHmac));
    if (capability.kind !== 'account' || !capability.account_id) throw this.sessionInvalid();
    if (capability.stage === 'ready') throw this.authenticatorReadyProblem();
    const opened = await this.run(request, (client) =>
      this.openChallenge(client, token!, capability.account_id!, request));
    if (!opened) throw new RetryAfterProblem(429, 'MFA_RATE_LIMITED', 'Too many verification attempts; try again later',
      MFA_RETRY_AFTER_SECONDS);
    return { purpose: opened.purpose, expiresAt: opened.expiresAt.toISOString() };
  }

  /** P12: the applicant's applications (C11). */
  async current(token: string | undefined, request: ClinicianRequest): Promise<ClinicianAccountView> {
    const sessionHmac = this.sessionHmac(token);
    return this.run(request, async (client) => {
      const view = (await client.query<{ view: ClinicianAccountView }>(
        'select identity.current_clinician_applications($1) as view', [sessionHmac])).rows[0]?.view;
      if (!view) throw this.unavailable();
      return view;
    });
  }

  /** P13: withdraws one open application (C12). */
  async withdraw(token: string | undefined, applicationId: string, expectedVersion: number,
    request: ClinicianRequest): Promise<ClinicianApplicationView> {
    const sessionHmac = this.sessionHmac(token);
    return this.run(request, async (client) => {
      const view = (await client.query<{ view: ClinicianApplicationView }>(
        'select identity.withdraw_clinician_application($1,$2,$3) as view',
        [sessionHmac, applicationId, expectedVersion])).rows[0]?.view;
      if (!view) throw this.unavailable();
      return view;
    });
  }

  /**
   * P14: a ready account applies to another facility (C13, which counts it
   * against the platform's daily cap as C8 does); the quota is the submit
   * one, charged only once the capability (checked after the gate) is a live
   * account capability at ready.
   */
  async apply(token: string | undefined, idempotencyKey: string, input: ClinicianApplicationDetailsDto,
    request: ClinicianRequest): Promise<ClinicianApplicationView & { replayed: boolean }> {
    this.assertPairing(input);
    this.assertConfigured();
    const networkDigest = this.networkDigest(request.ip);
    let sessionHmac = '';
    await this.chargeQuota(networkDigest, 'submit', request, async (client) => {
      // After the gate: a missing or malformed capability is refused as a forged one is.
      sessionHmac = this.sessionHmac(token);
      const capability = await this.capability(client, token!, sessionHmac);
      if (capability.kind !== 'account') throw this.sessionInvalid();
      if (capability.stage !== 'ready') throw this.authenticatorRequired();
    });
    const digest = requestDigest('clinician-application.apply', input);
    return this.run(request, async (client) => {
      const row = (await client.query<{ application: ClinicianApplicationView; replayed: boolean }>(
        'select application, replayed from identity.file_clinician_application($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [sessionHmac, idempotencyKey, digest, input.profession, input.regulator, input.licenceNumber,
          input.licenceValidUntil, input.facilityId, this.environment.CLINICIAN_APPLICATION_FACILITY_OPEN_LIMIT,
          this.environment.CLINICIAN_APPLICATION_SUBMIT_PLATFORM_DAILY_LIMIT],
      )).rows[0];
      if (!row?.application) throw this.unavailable();
      return { ...row.application, replayed: row.replayed };
    });
  }

  /**
   * P15: ends the capability and the live 0088 challenge it drives (C14).
   * Always succeeds for the caller: the cookie is cleared whatever happens.
   */
  async endSession(token: string | undefined, request: ClinicianRequest): Promise<void> {
    if (!token || !TOKEN.test(token) || !this.configured()) return;
    try {
      await this.database.withSystemTransaction(request.correlationId, (client) =>
        client.query('select identity.end_clinician_application_session($1)', [this.hmac('session', token)]));
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unknown';
      new Logger(ClinicianApplicationService.name)
        .warn(`Clinician application session end failed (code=${code}, correlation=${request.correlationId})`);
    }
  }

  /** The 0088 challenge token a capability drives: derived, never sent to the browser. */
  derivedChallengeToken(capabilityToken: string, challengeId: string): string {
    return createHmac('sha256', this.key).update('clinician-application\0mfa-challenge\0', 'utf8')
      .update(capabilityToken, 'utf8').update('\0', 'utf8').update(challengeId, 'utf8').digest('base64url');
  }

  private async startCode(purpose: 'signup' | 'status', email: string, request: ClinicianRequest) {
    this.assertConfigured();
    const networkDigest = this.networkDigest(request.ip);
    const challengeId = randomUUID();
    const code = generateSixDigitOtp();
    const result = await this.run(request, async (client) => {
      await this.gate(client, purpose === 'signup' ? 'intake' : 'status');
      if (!(await this.quota(client, networkDigest, purpose === 'signup' ? 'email_code' : 'status_code'))) {
        return { kind: 'rate_limited' } as const;
      }
      const deliver = (await client.query<{ deliver: boolean }>(
        'select identity.begin_clinician_application_challenge($1,$2,$3,$4,$5) as deliver',
        [purpose, challengeId, this.hmac('email', email), email, this.hmac('otp', challengeId, code)],
      )).rows[0]?.deliver === true;
      return { kind: 'started', deliver } as const;
    });
    if (result.kind === 'rate_limited') throw this.rateLimited(QUOTA_RETRY_AFTER_SECONDS);
    if (result.deliver) {
      // Only a real challenge has a code to deliver, so the response does not
      // wait for it. The request starts here, synchronously; a definitive
      // failure invalidates the challenge after the response.
      this.deliveries.run(request.correlationId, async () => {
        const delivered = await this.notification.deliver({
          challengeId, recipient: email, code, purpose: 'SIGNUP_VERIFY', channel: 'email',
          correlationId: request.correlationId,
        }).catch(() => ({ outcome: 'unknown' as const }));
        if (delivered.outcome === 'definitive_failure') {
          await this.database.withSystemTransaction(request.correlationId, (client) =>
            client.query('select identity.invalidate_clinician_application_challenge($1)', [challengeId]));
        }
      });
    }
    return { ...CODE_ANSWER, challengeId };
  }

  /**
   * Opens the 0088 challenge of an account capability on a derived token and
   * binds it (C9). Over the account's challenge budget nothing is opened or
   * bound and null is returned, so the counted refusal commits with the
   * caller's transaction. An account whose factor platform sign-in enrolled
   * is 403 STAFF_MFA_FACTOR_UNPROVEN.
   */
  private async openChallenge(client: PoolClient, capabilityToken: string, accountId: string,
    request: ClinicianRequest) {
    const challengeId = randomUUID();
    const outcome = await this.mfa.openApplicantChallenge(client, accountId,
      { id: challengeId, token: this.derivedChallengeToken(capabilityToken, challengeId) }, this.event(request));
    if (outcome.kind === 'unproven') throw new DomainProblem(403, 'STAFF_MFA_FACTOR_UNPROVEN', FACTOR_UNPROVEN_DETAIL);
    if (outcome.kind === 'invalid') {
      throw new DomainProblem(403, 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE', 'This account cannot apply');
    }
    if (outcome.kind === 'rate_limited') return null;
    await client.query('select identity.bind_clinician_application_mfa_challenge($1,$2)',
      [this.hmac('session', capabilityToken), challengeId]);
    return { purpose: outcome.purpose, expiresAt: outcome.expiresAt };
  }

  /** The derived token of the 0088 challenge an account capability is bound to. */
  private async authenticatorToken(token: string | undefined, request: ClinicianRequest): Promise<string> {
    const sessionHmac = this.sessionHmac(token);
    const capability = await this.run(request, (client) => this.capability(client, token!, sessionHmac));
    if (capability.kind !== 'account') throw this.sessionInvalid();
    if (capability.stage === 'ready') throw this.authenticatorReadyProblem();
    if (!capability.mfa_challenge_id) {
      // No challenge is bound (its budget was spent): the step has expired, as
      // for a challenge that timed out; P9 opens a new one.
      throw new DomainProblem(401, 'MFA_CHALLENGE_INVALID', 'Sign in again to continue');
    }
    return this.derivedChallengeToken(token!, capability.mfa_challenge_id);
  }

  private async authenticatorReady(client: PoolClient, sessionHmac: string, factorId: string,
    method: 'enrolment' | 'totp' | 'recovery_code'): Promise<ClinicianAccountView> {
    const view = (await client.query<{ view: ClinicianAccountView }>(
      'select identity.clinician_application_authenticator_ready($1,$2,$3) as view',
      [sessionHmac, factorId, method])).rows[0]?.view;
    if (!view) throw this.unavailable();
    return view;
  }

  /** The live capability a token names (closed in maintenance). */
  private async capability(client: PoolClient, token: string, sessionHmac = this.hmac('session', token)):
    Promise<CapabilityRow> {
    const row = (await client.query<CapabilityRow>(
      'select kind, stage, account_id::text, mfa_challenge_id::text, expires_at from identity.clinician_application_session($1)',
      [sessionHmac])).rows[0];
    if (!row) throw this.sessionInvalid();
    return row;
  }

  /**
   * Intake (sign-up, facility search, submit, apply) needs
   * clinician_signup_enabled and provider_portal_enabled on; every route
   * needs maintenance off. The database checks the same again.
   */
  private async gate(client: PoolClient, scope: 'intake' | 'status'): Promise<void> {
    const row = (await client.query<{ maintenance: boolean; signup: boolean; portal: boolean }>(
      `select platform.control_enabled('maintenance_mode') as maintenance,
              platform.control_enabled('clinician_signup_enabled') as signup,
              platform.control_enabled('provider_portal_enabled') as portal`)).rows[0];
    if (!row) throw this.unavailable();
    if (scope === 'intake' && !(row.signup && row.portal)) throw this.signupClosed();
    if (row.maintenance) throw this.maintenance();
  }

  /**
   * Charges a network's quota in its own transaction (the gate first), so a
   * refusal and a charge both commit. `precheck` runs after the gate and
   * before the charge (a read): a request it refuses charges nothing.
   * `afterCharge` runs only when the quota allowed the request; a refusal it
   * raises rolls the charge back.
   */
  private async chargeQuota(networkDigest: string, operation: QuotaOperation, request: ClinicianRequest,
    precheck?: (client: PoolClient) => Promise<void>, afterCharge?: (client: PoolClient) => Promise<void>) {
    const allowed = await this.run(request, async (client) => {
      await this.gate(client, 'intake');
      await precheck?.(client);
      const charged = await this.quota(client, networkDigest, operation);
      if (charged) await afterCharge?.(client);
      return charged;
    });
    if (!allowed) throw this.rateLimited(QUOTA_RETRY_AFTER_SECONDS);
  }

  private async quota(client: PoolClient, networkDigest: string, operation: QuotaOperation): Promise<boolean> {
    const name = QUOTA_NAMES[operation];
    const environment = this.environment;
    const result = await client.query<{ allowed: boolean }>(
      'select platform.consume_clinician_application_quota($1,$2,$3,$4,$5) as allowed',
      [networkDigest, operation, environment[`CLINICIAN_APPLICATION_${name}_NETWORK_HOURLY_LIMIT`],
        environment[`CLINICIAN_APPLICATION_${name}_NETWORK_DAILY_LIMIT`],
        environment[`CLINICIAN_APPLICATION_${name}_PLATFORM_DAILY_LIMIT`]]);
    return result.rows[0]?.allowed === true;
  }

  /** A system transaction whose database errors are answered by databaseProblem. */
  private async run<Result>(request: ClinicianRequest, operation: (client: PoolClient) => Promise<Result>):
    Promise<Result> {
    try {
      return await this.database.withSystemTransaction(request.correlationId, operation);
    } catch (error) {
      throw this.databaseProblem(error);
    }
  }

  private assertPairing(input: { profession: keyof typeof CLINICIAN_REGULATOR_OF; regulator: string }): void {
    if (CLINICIAN_REGULATOR_OF[input.profession] !== input.regulator) {
      throw new DomainProblem(400, 'CLINICIAN_APPLICATION_INVALID',
        'A doctor applies with an MDCN licence and a nurse with an NMCN licence');
    }
  }

  private sessionHmac(token: string | undefined): string {
    this.assertConfigured();
    if (!token || !TOKEN.test(token)) throw this.sessionInvalid();
    return this.hmac('session', token);
  }

  private networkDigest(remoteIp: string | undefined): string {
    // The client network (an IPv4 address or IPv6 /64); in production never
    // one of our own proxies, which every client would share (IP-1).
    const network = publicClientNetwork(remoteIp, this.environment);
    if (!network) throw this.unavailable();
    return this.hmac('ip', network);
  }

  /** HMAC-SHA256 under the OTP key in this flow's own domain: 'clinician-application\0<label>(\0<part>)*'. */
  hmac(label: 'email' | 'otp' | 'session' | 'ip', ...parts: string[]): string {
    const digest = createHmac('sha256', this.key).update('clinician-application\0', 'utf8').update(label, 'utf8');
    for (const part of parts) digest.update('\0', 'utf8').update(part, 'utf8');
    return digest.digest('hex');
  }

  private newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private event(request: ClinicianRequest): SessionEventMetadata {
    return { correlationId: request.correlationId, sourceIp: request.ip, userAgent: request.userAgent };
  }

  private configured(): boolean {
    return this.environment.NODE_ENV !== 'production' || Boolean(this.environment.OTP_HMAC_KEY_B64);
  }

  private assertConfigured(): void {
    if (!this.configured()) throw this.unavailable();
  }

  /**
   * Database errors as HTTP answers (the design's table): the message marker
   * decides first, then the SQLSTATE; anything unmatched is 503. A refusal
   * that is not about the capability is never a 401 (ADR-059): an unmarked
   * 42501 (a missing grant) or the system-context marker is 503.
   */
  databaseProblem(error: unknown): DomainProblem {
    if (error instanceof DomainProblem) return error;
    const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
    const message = typeof (error as { message?: unknown })?.message === 'string'
      ? (error as { message: string }).message : '';
    if (code === 'P4290') {
      return this.rateLimited(message === 'CLINICIAN_APPLICATION_SEARCH_BUDGET'
        ? SEARCH_BUDGET_RETRY_AFTER_SECONDS : QUOTA_RETRY_AFTER_SECONDS);
    }
    if (code === '55000') {
      if (message === 'PLATFORM_CONTROL_DISABLED:clinician_signup_enabled'
        || message === 'PLATFORM_CONTROL_DISABLED:provider_portal_enabled') return this.signupClosed();
      if (message === 'PLATFORM_MAINTENANCE') return this.maintenance();
      if (message === 'PLATFORM_CONTROL_UNAVAILABLE') {
        return new DomainProblem(503, 'PLATFORM_CONTROL_UNAVAILABLE', 'Platform runtime controls are unavailable');
      }
      return this.unavailable();
    }
    if (code === '42501') {
      if (message === 'CLINICIAN_APPLICATION_SESSION_INVALID') return this.sessionInvalid();
      if (message === 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED') return this.authenticatorRequired();
      // A live capability at the wrong stage is never the 401 of an ended one.
      if (message === 'CLINICIAN_APPLICATION_AUTHENTICATOR_READY') return this.authenticatorReadyProblem();
      if (message === 'CLINICIAN_APPLICATION_STAFF_SIGN_IN_REQUIRED') return this.staffSignInRequired();
      return this.unavailable();
    }
    if (code === '40001') return new DomainProblem(409, 'VERSION_CONFLICT', 'The application changed; reload it');
    if (code === '22023' && message === 'CLINICIAN_APPLICATION_INVALID') {
      return new DomainProblem(400, 'CLINICIAN_APPLICATION_INVALID', 'The application details are not valid');
    }
    if (code === 'P0002' && message === 'CLINICIAN_APPLICATION_NOT_FOUND') {
      return new DomainProblem(404, 'CLINICIAN_APPLICATION_NOT_FOUND', 'Application not found');
    }
    if (code === '23505') {
      if (message === 'CLINICIAN_EMAIL_IN_USE') return new DomainProblem(409, message, EMAIL_IN_USE_DETAIL);
      if (message === 'CLINICIAN_APPLICATION_IDEMPOTENCY_CONFLICT') {
        return new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for a different request');
      }
      if (message === 'CLINICIAN_APPLICATION_ALREADY_OPEN' || message === 'CLINICIAN_APPLICATION_MEMBERSHIP_EXISTS') {
        return new DomainProblem(409, message, CONFLICTS[message]!);
      }
      return this.unavailable();
    }
    if (code === '23514') {
      if (message === 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE') {
        return new DomainProblem(403, message, 'This account cannot apply');
      }
      if (Object.hasOwn(CONFLICTS, message) && message !== 'CLINICIAN_APPLICATION_ALREADY_OPEN'
        && message !== 'CLINICIAN_APPLICATION_MEMBERSHIP_EXISTS') {
        return new DomainProblem(409, message, CONFLICTS[message]!);
      }
      return this.unavailable();
    }
    return this.unavailable();
  }

  private signupClosed(): DomainProblem {
    return new PublicDetailProblem(503, 'CLINICIAN_SIGNUP_CLOSED', SIGNUP_CLOSED_DETAIL);
  }

  private maintenance(): DomainProblem {
    return new DomainProblem(503, 'PLATFORM_MAINTENANCE', 'HID is temporarily in maintenance mode');
  }

  private unavailable(): DomainProblem {
    return new DomainProblem(503, 'CLINICIAN_APPLICATION_UNAVAILABLE', 'Clinician applications are temporarily unavailable');
  }

  private rateLimited(retryAfterSeconds: number): DomainProblem {
    return new RetryAfterProblem(429, 'CLINICIAN_APPLICATION_RATE_LIMITED', 'Too many requests; try again later',
      retryAfterSeconds);
  }

  private codeInvalid(): DomainProblem {
    return new DomainProblem(401, 'CLINICIAN_APPLICATION_CODE_INVALID', 'The code is wrong or has expired.');
  }

  private sessionInvalid(): DomainProblem {
    return new DomainProblem(401, 'CLINICIAN_APPLICATION_SESSION_INVALID',
      'Your application session has ended. Verify your email address again to continue.');
  }

  private authenticatorRequired(): DomainProblem {
    return new DomainProblem(403, 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED', 'Verify your authenticator to continue');
  }

  private authenticatorReadyProblem(): DomainProblem {
    return new DomainProblem(409, 'CLINICIAN_APPLICATION_AUTHENTICATOR_READY',
      'Your authenticator is already verified for this session');
  }

  /** An account that sets its authenticator up again only through staff sign-in (an approved clinician after a reset). */
  private staffSignInRequired(): DomainProblem {
    return new DomainProblem(403, 'CLINICIAN_APPLICATION_STAFF_SIGN_IN_REQUIRED', STAFF_SIGN_IN_DETAIL);
  }

  private requiresSignOut(): DomainProblem {
    return new DomainProblem(409, 'CLINICIAN_APPLICATION_REQUIRES_SIGN_OUT',
      'Sign out of Health ID before applying as a clinician');
  }
}
