import { type BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { QueryResultRow } from 'pg';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { assertPasswordLength, hashAccountPassword } from '../auth/password-hash';
import { AFTER_RESPONSE_SHUTDOWN_GRACE_MS, AfterResponseTasks } from '../common/after-response-tasks';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { CompleteOrganizationProfileDto, StartOrganizationProfileCompletionDto } from './dto/organization-application.dto';
import { selfServiceGateRefusal } from './provider-self-service-gate';

const localCompletionKey = randomBytes(32);
type FieldSource = 'qoreid' | 'user_provided' | null;

interface CompletionProfileRow extends QueryResultRow {
  application_status: 'pending_verification' | 'ready_for_review';
  profile_state: 'incomplete' | 'complete';
  row_version: string;
  product_code: string;
  cac_registration_number: string;
  profile_organization_name: string | null;
  profile_organization_name_source: FieldSource;
  profile_entity_type: string | null;
  profile_entity_type_source: FieldSource;
  profile_registration_date: string | null;
  profile_registration_date_source: FieldSource;
  profile_address: string | null;
  profile_address_source: FieldSource;
  profile_registry_status: string | null;
  profile_registry_status_source: FieldSource;
}

/** The administrator details facility self sign-up sends with its emailed code (P4 review fix R6). */
export interface SelfServiceCompletionDetails {
  administratorName: string;
  organizationType: 'clinic' | 'hospital' | 'laboratory' | 'pharmacy' | 'other';
}

/** The governed completion's start answer: the same for every input (no enumeration). */
export interface CompletionStartAnswer {
  accepted: true;
  challengeId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

/**
 * Facility self sign-up's start answer (P4 round 2, R14). codeSent says whether
 * this start sent a new code. When it did not (a limit of 0056 or R5),
 * challengeId and expiresInSeconds name the code still in force, the newest
 * one that can still be entered, and are absent when there is none;
 * resendAfterSeconds is how long until a start can send a new code.
 */
export interface SelfServiceStartAnswer {
  accepted: true;
  codeSent: boolean;
  challengeId?: string;
  expiresInSeconds?: number;
  resendAfterSeconds: number;
}

/**
 * What facility self sign-up's password step shows before the account exists
 * (P4 round 2, R13): the verified legal name the activation will register, the
 * CAC number as entered, and the product, organization type, administrator
 * name and email the account will keep.
 */
export interface SelfServiceEnrollmentProfile {
  organizationName: string;
  registrationNumber: string;
  productCode: string;
  organizationType: string;
  administratorName: string;
  administratorEmail: string;
}

interface SelfServiceProfileRow extends QueryResultRow {
  organization_name: string;
  cac_registration_number: string;
  product_code: string;
  organization_type: string;
  administrator_name: string;
  administrator_email: string;
}

interface SelfServiceCodeStateRow extends QueryResultRow {
  application_open: boolean;
  challenge_id: string | null;
  expires_in_seconds: number | null;
  resend_after_seconds: number | null;
}

/** identity.prepare_self_service_provider_activation's answers (0086, review fix R1). */
type ActivationPreCheck = 'ready' | 'session_invalid' | 'attempts_exceeded' | 'not_ready'
  | 'email_registered' | 'cac_bound' | 'name_exists';

@Injectable()
export class OrganizationProfileCompletionService implements BeforeApplicationShutdown {
  private readonly environment = getEnvironment();
  private readonly key = this.environment.OTP_HMAC_KEY_B64
    ? Buffer.from(this.environment.OTP_HMAC_KEY_B64, 'base64') : localCompletionKey;
  private readonly deliveries = new AfterResponseTasks(new Logger(OrganizationProfileCompletionService.name),
    'Organization completion code delivery or its invalidation failed');

  constructor(private readonly database: DatabaseService,
    private readonly notification: NotificationOtpClient) {}

  /** Waits for the deliveries started so far, and any started meanwhile. */
  settleDeliveries(): Promise<void> {
    return this.deliveries.settle();
  }

  /** Runs before DatabaseService ends the pool, so a failed delivery can still invalidate its challenge. */
  beforeApplicationShutdown(): Promise<void> {
    return this.deliveries.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS);
  }

  /**
   * Sends the emailed code. Every call charges the public application quota
   * (0049) once, keyed by publicApplicationDigest: here, unless the caller
   * already charged it in its own transaction. Facility self sign-up charges
   * it before its submit (P4 A7 and review fix R4) and passes
   * publicApplicationQuotaCharged, so a start costs one, not two (CRITIC C8).
   *
   * The governed completion answers every input alike (no enumeration).
   * Facility self sign-up passes selfService: its code is sent by
   * identity.begin_self_service_provider_enrollment, which stores the
   * administrator name and organization type with the code (the activation
   * takes them from the code that opened its session, R6) and sends at most
   * 10 codes a day to one administrator email (R5); its answer says whether
   * a code was sent (R14), since its start has already told the caller that
   * the application exists.
   */
  start(input: StartOrganizationProfileCompletionDto, remoteIp: string | undefined, correlationId: string,
    options?: { publicApplicationQuotaCharged?: boolean }): Promise<CompletionStartAnswer>;
  start(input: StartOrganizationProfileCompletionDto, remoteIp: string | undefined, correlationId: string,
    options: { publicApplicationQuotaCharged?: boolean; selfService: SelfServiceCompletionDetails },
  ): Promise<SelfServiceStartAnswer>;
  async start(input: StartOrganizationProfileCompletionDto, remoteIp: string | undefined,
    correlationId: string,
    options: { publicApplicationQuotaCharged?: boolean; selfService?: SelfServiceCompletionDetails } = {},
  ): Promise<CompletionStartAnswer | SelfServiceStartAnswer> {
    this.assertConfigured();
    const challengeId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const registrationNumber = input.cacRegistrationNumber.replace(/\s+/g, '').toUpperCase();
    const email = input.administratorEmail.trim().toLowerCase();
    const selfService = options.selfService;
    let recipient: string | null;
    let state: SelfServiceCodeStateRow | undefined;
    try {
      ({ recipient, state } = await this.database.withSystemTransaction(correlationId, async (client) => {
        if (!options.publicApplicationQuotaCharged) {
          await client.query('select platform.consume_public_application_quota($1)', [
            this.networkDigest(remoteIp),
          ]);
        }
        if (!selfService) {
          const found = await client.query<{ recipient_email: string | null }>(
            'select identity.begin_organization_profile_completion($1,$2,$3,$4,$5) as recipient_email',
            [registrationNumber, email, input.productCode, challengeId,
              this.hmac('otp', challengeId, code)],
          );
          return { recipient: found.rows[0]?.recipient_email ?? null, state: undefined };
        }
        const found = await client.query<{ recipient_email: string | null }>(
          'select identity.begin_self_service_provider_enrollment($1,$2,$3,$4,$5,$6,$7) as recipient_email',
          [registrationNumber, email, input.productCode, challengeId, this.hmac('otp', challengeId, code),
            selfService.administratorName, selfService.organizationType],
        );
        // In the same transaction, so it sees this start's code, if any (R14).
        const current = await client.query<SelfServiceCodeStateRow>(
          'select * from identity.self_service_provider_code_state($1,$2,$3)',
          [registrationNumber, email, input.productCode],
        );
        return { recipient: found.rows[0]?.recipient_email ?? null, state: current.rows[0] };
      }));
    } catch (error) { throw this.databaseProblem(error); }
    if (recipient) {
      // Only an eligible application has a code to deliver, so the response
      // does not wait for it: its timing would tell that the CAC number and
      // administrator email match an application. The delivery request starts
      // here, synchronously; a definitive failure invalidates the challenge
      // after the response.
      this.deliveries.run(correlationId, async () => {
        const delivered = await this.notification.deliver({
          challengeId, recipient, code, purpose: 'EMAIL_VERIFY', channel: 'email', correlationId,
        }).catch(() => ({ outcome: 'unknown' as const }));
        if (delivered.outcome === 'definitive_failure') {
          await this.database.withSystemTransaction(correlationId, (client) =>
            client.query('select identity.invalidate_organization_profile_completion_challenge($1)',
              [challengeId]));
        }
      });
    }
    if (!selfService) {
      return { accepted: true as const, challengeId, expiresInSeconds: 600, resendAfterSeconds: 60 };
    }
    return this.selfServiceStartAnswer(challengeId, recipient, state);
  }

  /**
   * Facility self sign-up's start answer (R14). A sent code is the new one.
   * Otherwise the application is either still open, and a limit held the
   * code back (codeSent false, with the code still in force if any and the
   * wait before a new one), or it was activated, lapsed or rejected since
   * this start read it: a retry would be answered 409
   * PROVIDER_ENROLLMENT_REQUIRES_REVIEW, so this start is too.
   */
  private selfServiceStartAnswer(challengeId: string, recipient: string | null,
    state: SelfServiceCodeStateRow | undefined): SelfServiceStartAnswer {
    const wait = (seconds: number | null | undefined, fallback: number) =>
      Math.max(1, typeof seconds === 'number' && Number.isSafeInteger(seconds) ? seconds : fallback);
    if (recipient) {
      return { accepted: true, codeSent: true, challengeId, expiresInSeconds: 600,
        resendAfterSeconds: wait(state?.resend_after_seconds, 60) };
    }
    if (state?.application_open !== true) {
      throw new DomainProblem(409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW',
        'This provider application requires manual resolution');
    }
    return {
      accepted: true,
      codeSent: false,
      ...(state.challenge_id ? { challengeId: state.challenge_id,
        expiresInSeconds: Math.max(0, Number(state.expires_in_seconds ?? 0)) } : {}),
      resendAfterSeconds: wait(state.resend_after_seconds, 60),
    };
  }

  async verify(challengeId: string, code: string, correlationId: string) {
    this.assertConfigured();
    if (!/^[0-9]{6}$/.test(code)) throw this.invalidCode();
    const token = randomBytes(32).toString('base64url');
    let verified: boolean;
    try {
      verified = await this.database.withSystemTransaction(correlationId, async (client) => {
        const result = await client.query<{ verified: boolean }>(
          'select identity.verify_organization_profile_completion_challenge($1,$2,$3) as verified',
          [challengeId, this.hmac('otp', challengeId, code), this.hmac('session', token)],
        );
        return result.rows[0]?.verified === true;
      });
    } catch (error) { throw this.databaseProblem(error); }
    if (!verified) throw this.invalidCode();
    return { verified: true as const, cookie: token };
  }

  async current(token: string | undefined, correlationId: string) {
    const sessionHash = this.sessionHash(token);
    try {
      const result = await this.database.withSystemTransaction(correlationId, (client) =>
        client.query<CompletionProfileRow>(
          'select * from identity.current_organization_profile_completion($1)', [sessionHash]));
      const row = result.rows[0];
      if (!row) throw this.invalidSession();
      return this.profile(row);
    } catch (error) { throw this.databaseProblem(error); }
  }

  /**
   * Facility self sign-up's confirmation read (P4 round 2, R13): what the
   * password step shows before the account exists, for the enrollment
   * session's cookie. It changes nothing. No live session of a verified
   * self-service application ready for activation answers 401; the control
   * off answers 423.
   */
  async selfServiceProfile(token: string | undefined, correlationId: string): Promise<SelfServiceEnrollmentProfile> {
    const sessionHash = this.sessionHash(token);
    let row: SelfServiceProfileRow | undefined;
    try {
      const result = await this.database.withSystemTransaction(correlationId, (client) =>
        client.query<SelfServiceProfileRow>(
          'select * from identity.current_self_service_provider_enrollment($1)', [sessionHash]));
      row = result.rows[0];
    } catch (error) {
      throw selfServiceGateRefusal(error) ?? this.databaseProblem(error);
    }
    if (!row) throw this.invalidSession();
    return {
      organizationName: row.organization_name,
      registrationNumber: row.cac_registration_number,
      productCode: row.product_code,
      organizationType: row.organization_type,
      administratorName: row.administrator_name,
      administratorEmail: row.administrator_email,
    };
  }

  /**
   * Facility self sign-up's withdrawal (P4b, P4 leftover 1: "This isn't my
   * organization"): identity.withdraw_self_service_provider_enrollment closes
   * the open self-service application of the enrollment session's cookie,
   * ends its sessions and codes and audits it, with no 7-day refusal. It
   * answers 'withdrawn' when it closed one; anything else ('session_invalid':
   * no live session, or its application is no longer open) is 401, as an
   * invalid session. The control off answers 423.
   */
  async withdrawSelfService(token: string | undefined, correlationId: string): Promise<void> {
    const sessionHash = this.sessionHash(token);
    let withdrawn = false;
    try {
      const result = await this.database.withSystemTransaction(correlationId, (client) =>
        client.query<{ result: string | null }>(
          'select identity.withdraw_self_service_provider_enrollment($1) as result', [sessionHash]));
      withdrawn = result.rows[0]?.result === 'withdrawn';
    } catch (error) {
      throw selfServiceGateRefusal(error) ?? this.databaseProblem(error);
    }
    if (!withdrawn) throw this.invalidSession();
  }

  async complete(token: string | undefined, expectedVersion: number,
    input: CompleteOrganizationProfileDto, correlationId: string) {
    const sessionHash = this.sessionHash(token);
    try {
      const result = await this.database.withSystemTransaction(correlationId, (client) =>
        client.query<CompletionProfileRow>(
          'select * from identity.complete_organization_profile($1,$2,$3,$4,$5,$6,$7)',
          [sessionHash, expectedVersion, input.companyName ?? null, input.entityType ?? null,
            input.registrationDate ?? null, input.address ?? null, input.registryStatus ?? null]));
      const row = result.rows[0];
      if (!row) throw this.invalidSession();
      return this.profile(row);
    } catch (error) { throw this.databaseProblem(error); }
  }

  /**
   * Facility self sign-up's activation: sets the administrator's password and
   * creates the organization, facility, account and membership in one runtime
   * command, which also returns the login email.
   *
   * The 64 MiB argon2id hash is computed only after the pre-check
   * identity.prepare_self_service_provider_activation has answered 'ready'
   * in its own committed transaction (P4 A9 and review fix R1): it refuses a
   * token that names no live session, charges one of the session's 5
   * attempts, and answers an activation that can never succeed (email
   * already registered, CAC already bound, legal name already used,
   * application not ready) at once, ending the session. So a session costs at
   * most 5 hashes, and a request that is certain to fail costs none.
   */
  async activate(token: string | undefined, password: string, correlationId: string) {
    assertPasswordLength(password);
    const sessionHash = this.sessionHash(token);
    let preCheck: ActivationPreCheck | undefined;
    try {
      const result = await this.database.withSystemTransaction(correlationId, (client) =>
        client.query<{ verdict: ActivationPreCheck }>(
          'select identity.prepare_self_service_provider_activation($1) as verdict', [sessionHash]));
      preCheck = result.rows[0]?.verdict;
    } catch (error) {
      throw this.activationProblem(error);
    }
    if (preCheck !== 'ready') throw this.preCheckProblem(preCheck);
    const passwordHash = await hashAccountPassword(password);
    try {
      const result = await this.database.withSystemTransaction(correlationId, (client) =>
        client.query<{
          organization_id: string;
          facility_id: string;
          account_id: string;
          row_version: string;
          hid_subject: string;
          account_email: string;
        }>(
          // The login email is returned by the same transaction that creates the
          // account; nothing is read after the activation commits.
          'select * from identity.activate_self_service_provider_enrollment($1,$2)',
          [sessionHash, passwordHash],
        ));
      const row = result.rows[0];
      if (!row) throw new DomainProblem(503, 'PROVIDER_ENROLLMENT_ACTIVATION_UNAVAILABLE',
        'Provider account activation is temporarily unavailable');
      return {
        organizationId: row.organization_id,
        facilityId: row.facility_id,
        accountId: row.account_id,
        email: row.account_email,
      };
    } catch (error) {
      throw this.activationProblem(error);
    }
  }

  /**
   * The public application quota digest of a client address (0049): the same
   * key start charges, for a caller that charges it in its own transaction.
   */
  publicApplicationDigest(remoteIp: string | undefined): string {
    this.assertConfigured();
    return this.networkDigest(remoteIp);
  }

  /**
   * The public application quota digest of a client network that the caller
   * has already normalized: an IPv4 address (the same digest as
   * publicApplicationDigest gives that address) or an IPv6 /64 prefix such as
   * '2001:db8:1:2::/64'. Facility self sign-up charges the quota to the
   * network, so rotating IPv6 addresses inside one allocation does not reset
   * it (P4 review fix R5).
   */
  publicApplicationNetworkDigest(network: string): string {
    this.assertConfigured();
    if (!network || (isIP(network) !== 4 && !/^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::\/64$/.test(network))) {
      throw new DomainProblem(503, 'APPLICATION_RATE_LIMIT_UNAVAILABLE',
        'Organization profile completion is temporarily unavailable');
    }
    return this.hmac('ip', network);
  }

  private profile(row: CompletionProfileRow) {
    return { status: row.application_status, profileState: row.profile_state,
      version: Number(row.row_version), productCode: row.product_code,
      registrationNumber: row.cac_registration_number,
      fields: {
        companyName: { value: row.profile_organization_name, source: row.profile_organization_name_source },
        entityType: { value: row.profile_entity_type, source: row.profile_entity_type_source },
        registrationDate: { value: row.profile_registration_date, source: row.profile_registration_date_source },
        address: { value: row.profile_address, source: row.profile_address_source },
        registryStatus: { value: row.profile_registry_status, source: row.profile_registry_status_source },
      } };
  }

  private sessionHash(token: string | undefined): string {
    this.assertConfigured();
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw this.invalidSession();
    return this.hmac('session', token);
  }

  private networkDigest(remoteIp: string | undefined): string {
    if (!remoteIp || isIP(remoteIp) === 0) {
      throw new DomainProblem(503, 'APPLICATION_RATE_LIMIT_UNAVAILABLE',
        'Organization profile completion is temporarily unavailable');
    }
    return this.hmac('ip', remoteIp);
  }

  private hmac(label: string, ...parts: string[]): string {
    const digest = createHmac('sha256', this.key).update('organization-profile-completion\0');
    digest.update(label);
    for (const part of parts) digest.update('\0').update(part);
    return digest.digest('hex');
  }

  private assertConfigured(): void {
    if (this.environment.NODE_ENV === 'production' && !this.environment.OTP_HMAC_KEY_B64) {
      throw new DomainProblem(503, 'ORGANIZATION_COMPLETION_UNAVAILABLE',
        'Organization profile completion is temporarily unavailable');
    }
  }

  private invalidCode() {
    return new DomainProblem(401, 'ORGANIZATION_COMPLETION_CODE_INVALID',
      'The confirmation code is invalid or expired');
  }

  private invalidSession() {
    return new DomainProblem(401, 'ORGANIZATION_COMPLETION_SESSION_INVALID',
      'Organization profile completion session is invalid or expired');
  }

  /**
   * The pre-check's refusals (R1). A session that is not live, or whose
   * attempts are spent (it has just been ended), answers 401 as any invalid
   * session does: the applicant must confirm the email again. The rest end
   * the session with the answer the activation itself would give.
   */
  private preCheckProblem(verdict: ActivationPreCheck | undefined): DomainProblem {
    switch (verdict) {
      case 'session_invalid':
      case 'attempts_exceeded':
        return this.invalidSession();
      case 'email_registered':
        return new DomainProblem(409, 'PROVIDER_EMAIL_ALREADY_REGISTERED',
          'The administrator email is already associated with an HID account');
      case 'not_ready':
      case 'cac_bound':
      case 'name_exists':
        return new DomainProblem(409, 'ORGANIZATION_REVIEW_REQUIRED',
          'Organization profile completion is unavailable');
      default:
        return new DomainProblem(503, 'ORGANIZATION_COMPLETION_UNAVAILABLE',
          'Organization profile completion is temporarily unavailable');
    }
  }

  /**
   * The activation's answers. Self sign-up closed (the control off, or not
   * deployed) is 423, never 400 or 503 (CRITIC C1, C19). The activation
   * refuses an administrator email that already belongs to an account or
   * staff record with this exact unique violation; the caller has proved
   * control of that mailbox with the emailed code, so the answer tells a
   * stranger nothing, and start makes no such check. Any other unique
   * violation keeps the general answer.
   */
  private activationProblem(error: unknown): DomainProblem {
    const closed = selfServiceGateRefusal(error);
    if (closed) return closed;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
      && 'message' in error && error.message === 'Administrator email already belongs to an account') {
      return new DomainProblem(409, 'PROVIDER_EMAIL_ALREADY_REGISTERED',
        'The administrator email is already associated with an HID account');
    }
    return this.databaseProblem(error);
  }

  private databaseProblem(error: unknown): DomainProblem {
    if (error instanceof DomainProblem) return error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'P4290') return new DomainProblem(429, 'APPLICATION_RATE_LIMITED',
      'Application request limit reached; try again later');
    if (code === '40001') return new DomainProblem(409, 'VERSION_CONFLICT',
      'Application changed; reload before retrying');
    if (code === '22023') return new DomainProblem(400, 'ORGANIZATION_PROFILE_INVALID',
      'The organization profile contains an invalid or provider-owned field');
    if (code === '42501') return this.invalidSession();
    if (code === '23514') return new DomainProblem(409, 'ORGANIZATION_REVIEW_REQUIRED',
      'Organization profile completion is unavailable');
    return new DomainProblem(503, 'ORGANIZATION_COMPLETION_UNAVAILABLE',
      'Organization profile completion is temporarily unavailable');
  }
}
