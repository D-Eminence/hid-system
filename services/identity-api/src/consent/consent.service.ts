import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { requireNoRecentRecoveryHold, requireRecentPatientAuthentication, type PatientSessionActor }
  from '../auth/recent-authentication';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { CreateAccessRequestDto } from './dto/create-access-request.dto';
import type { CreateBreakGlassDto } from './dto/create-break-glass.dto';
import type { ListStaffAccessRequestsDto } from './dto/list-staff-access-requests.dto';
import type { VerifyPatientAccessPinDto } from './dto/verify-patient-access-pin.dto';

export interface AccessRequestRow extends QueryResultRow {
  accessRequestId: string;
  status: 'pending';
  scope: 'read_records' | 'write_records';
  purpose: string;
  durationMinutes: number;
  requestedAt: Date;
  existingRequest: boolean;
}

export interface BreakGlassRow extends QueryResultRow {
  accessRequestId: string;
  consentGrantId: string;
  patientId: string;
  status: 'active';
  expiresAt: Date;
  existingGrant: boolean;
}

export interface RevokedGrantRow extends QueryResultRow {
  consentGrantId: string;
  status: 'revoked';
  revokedAt: Date;
  replayed: boolean;
}

/**
 * The patient's revocation (0087) answers with main's codes; the website shows
 * `detail` to the patient as it is, so these are written for the patient.
 * (A 5xx detail is replaced by ProblemDetailsFilter in any case.)
 */
export const REVOCATION_DETAIL = {
  notRevocable: 'This access cannot be revoked here. Emergency access, and access you did not give, end on their own.',
  notActive: 'This access has already ended. Reload the page to see its current status.',
  notFound: 'This access record is not available. Reload the page to see your current access.',
  sessionNotLive: 'Your session could not be confirmed. Sign in again, then revoke access.',
  invalidReason: 'Enter a reason of at least 3 characters.',
  unavailable: 'Revoking access is not available right now. Try again later.',
} as const;

export interface ClosedGrantRow extends QueryResultRow {
  consentGrantId: string;
  patientId: string;
  status: 'revoked';
  closedAt: Date;
  alreadyClosed: boolean;
}

interface PatientPinAccessRow extends QueryResultRow {
  verified: boolean;
  accessRequestId: string | null;
  consentGrantId: string | null;
  patientId: string | null;
  status: 'active' | null;
  expiresAt: Date | null;
  existingGrant: boolean;
}

export interface VerifiedPatientPinAccess {
  accessRequestId: string;
  consentGrantId: string;
  patientId: string;
  status: 'active';
  expiresAt: Date;
  existingGrant: boolean;
}

/** main's answer to an approval from a session not freshly signed in (eb9b1ca consent.service.ts). */
export const RECENT_APPROVAL_AUTH_DETAIL = 'For your security, sign out, sign in again, and approve within 10 minutes.';

@Injectable()
export class ConsentService {
  constructor(private readonly database: DatabaseService) {}

  // The clinician learns the request, not the patient: the answer carries no
  // patient id before the patient consents (main D-Eminence/hid-system#69).
  async createAccessRequest(context: DataAccessContext, input: CreateAccessRequestDto): Promise<AccessRequestRow> {
    try {
      return await this.database.withTransaction(context, async (client) => {
        const result = await client.query<AccessRequestRow>(
          `select
             access_request_id as "accessRequestId",
             request_status as status,
             request_scope as scope,
             request_purpose as purpose,
             duration_minutes as "durationMinutes",
             requested_at as "requestedAt",
             existing_request as "existingRequest"
           from identity.create_access_request($1, $2, $3, $4)`,
          [input.hid, input.scope, input.reason, input.durationMinutes],
        );
        const row = this.requireRow(result.rows[0]);
        // Exactly these fields, whatever else a row may carry.
        return {
          accessRequestId: row.accessRequestId, status: row.status, scope: row.scope, purpose: row.purpose,
          durationMinutes: row.durationMinutes, requestedAt: row.requestedAt, existingRequest: row.existingRequest,
        };
      });
    } catch (error) {
      throw this.translate(error);
    }
  }



  async listMyStaffAccessRequests(context: DataAccessContext, query: ListStaffAccessRequestsDto) {
    try {
      return await this.database.withTransaction(context, async (client) => {
        const result = await client.query<Record<string, unknown> & QueryResultRow>(
          `select access_request_id as "accessRequestId", patient_id as "patientId",
             scope, purpose_of_use as "purposeOfUse", reason, status,
             requested_duration_minutes as "requestedDurationMinutes",
             requested_at as "requestedAt", approved_at as "approvedAt",
             denied_at as "deniedAt", denied_reason as "deniedReason"
           from identity.list_my_staff_access_requests($1)`,
          [query.status ?? null],
        );
        return result.rows;
      }, { readOnly: true });
    } catch (error) {
      throw this.translate(error);
    }
  }

  async listMyAccessRequests(context: DataAccessContext) {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<Record<string, unknown> & QueryResultRow>(
        `select access_request_id as "accessRequestId", facility_id as "facilityId",
           facility_name as "facilityName", scope, reason, status,
           requested_duration_minutes as "requestedDurationMinutes",
           requested_at as "requestedAt", approved_at as "approvedAt",
           denied_at as "deniedAt", denied_reason as "deniedReason"
         from identity.list_my_access_requests()`,
      );
      return result.rows;
    }, { readOnly: true });
  }

  /**
   * Approval grants a clinician access (a write grant is what lets a clinician
   * send the patient's order to another facility, P4c), so, as main does, it
   * is refused for 24 hours after an OTP account recovery (403
   * PATIENT_RECENT_RECOVERY_HOLD, checked first) and needs a recent sign-in:
   * the session family first issued within 10 minutes (403
   * PATIENT_RECENT_AUTH_REQUIRED). Both run in the approval's transaction.
   * Denial and the list stay available.
   */
  async approveAccessRequest(context: DataAccessContext, requestId: string) {
    const actor = context.actor;
    if (actor.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
    }
    const patient = actor as PatientSessionActor;
    try {
      return await this.database.withTransaction(context, async (client) => {
        await requireNoRecentRecoveryHold(client, patient.accountId, 'new access approvals');
        await requireRecentPatientAuthentication(client, patient, RECENT_APPROVAL_AUTH_DETAIL);
        const result = await client.query<Record<string, unknown> & QueryResultRow>(
          `select access_request_id as "accessRequestId", consent_grant_id as "consentGrantId",
             patient_id as "patientId", status, expires_at as "expiresAt", replayed
           from identity.approve_access_request($1)`,
          [requestId],
        );
        return this.requireRow(result.rows[0]);
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  async denyAccessRequest(context: DataAccessContext, requestId: string, reason: string) {
    try {
      return await this.database.withTransaction(context, async (client) => {
        const result = await client.query<Record<string, unknown> & QueryResultRow>(
          `select access_request_id as "accessRequestId", patient_id as "patientId",
             status, denied_at as "deniedAt", replayed
           from identity.deny_access_request($1, $2)`,
          [requestId, reason.trim()],
        );
        return this.requireRow(result.rows[0]);
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * The patient revokes a grant they gave (main 0066 item 2, migration 0087).
   * Bound to the live patient session the way the patient-self commands are
   * (W03): a system transaction, the verified subject bound, then the command
   * checks the subject/session pair through identity.patient_self_session.
   * Unlike approval, no recovery hold and no recent sign-in (main: "Denial
   * and revocation stay available").
   */
  async revokeMyConsentGrant(request: HidRequest, grantId: string, reason: string) {
    const actor = request.actor;
    if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
    }
    try {
      return await this.database.withSystemTransaction(request.correlationId, async (client) => {
        await client.query("select set_config('app.actor_subject', $1, true)", [actor.subject]);
        const result = await client.query<RevokedGrantRow>(
          `select consent_grant_id as "consentGrantId", grant_status as status,
             revoked_at as "revokedAt", replayed
           from identity.revoke_my_consent_grant($1, $2, $3, $4)`,
          [actor.subject, actor.sessionId, grantId, reason.trim()],
        );
        return this.requireRow(result.rows[0]);
      });
    } catch (error) {
      throw this.translateRevocation(error);
    }
  }

  async activateBreakGlass(context: DataAccessContext, input: CreateBreakGlassDto) {
    try {
      return await this.database.withTransaction(context, async (client) => {
        // The platform administrative control is the authoritative switch for
        // emergency access; it is checked inside the activation transaction
        // (main #18 0c4de59). platform.require_control_enabled (0040) is
        // SECURITY DEFINER and granted to PUBLIC, so a staff session reads it
        // without platform.control.read.
        await client.query('select platform.require_control_enabled($1)', ['break_glass_enabled']);
        const result = await client.query<BreakGlassRow>(
          `select
             access_request_id as "accessRequestId",
             consent_grant_id as "consentGrantId",
             subject_patient_id as "patientId",
             grant_status as status,
             expires_at as "expiresAt",
             existing_grant as "existingGrant"
           from identity.activate_break_glass($1, $2, $3)`,
          [input.hid, input.reason, input.durationMinutes],
        );
        return this.requireRow(result.rows[0]);
      });
    } catch (error) {
      throw this.translateBreakGlass(error);
    }
  }

  /**
   * identity.activate_break_glass (0031) refuses with 22023 and this message
   * when no active 'emergency' purpose of use exists. The route always runs it
   * with the emergency purpose, so here the refusal means emergency access is
   * not enabled on the platform: 0085 seeds 'emergency', so on a migrated
   * database it means an operator deactivated the code, or the database
   * predates 0085. It is answered like the disabled platform control (main
   * 17abba5, with its 0097). Every other 22023 (duration, reason) stays 400.
   */
  private translateBreakGlass(error: unknown): unknown {
    if (isDatabaseError(error) && error.code === '22023'
      && (error as unknown as { message?: unknown }).message === 'Break-glass requires the emergency purpose of use') {
      return new DomainProblem(423, 'BREAK_GLASS_DISABLED', 'Emergency access is not enabled on this platform');
    }
    return this.translate(error);
  }

  /**
   * The function commits a non-disclosing denial/audit/rate-limit result for
   * every failed verification. Convert that result to one generic API error
   * only after the transaction commits, so an attacker cannot distinguish an
   * unknown HID, absent/revoked PIN, malformed secret, or a locked window.
   */
  async verifyPatientAccessPin(
    context: DataAccessContext,
    input: VerifyPatientAccessPinDto,
  ): Promise<VerifiedPatientPinAccess> {
    let row: PatientPinAccessRow;
    try {
      row = await this.database.withTransaction(context, async (client) => {
        const result = await client.query<PatientPinAccessRow>(
          'select verified, access_request_id as "accessRequestId", '
          + 'consent_grant_id as "consentGrantId", subject_patient_id as "patientId", '
          + 'grant_status as status, expires_at as "expiresAt", '
          + 'existing_grant as "existingGrant" '
          + 'from identity.access_patient_with_pin($1, $2, $3)',
          [input.hid, input.pin, input.durationMinutes ?? 15],
        );
        return this.requireRow(result.rows[0]);
      });
    } catch (error) {
      throw this.translatePatientPin(error);
    }
    if (!row.verified
      || !row.accessRequestId
      || !row.consentGrantId
      || !row.patientId
      || row.status !== 'active'
      || !row.expiresAt) {
      throw this.patientPinDenied();
    }
    return {
      accessRequestId: row.accessRequestId,
      consentGrantId: row.consentGrantId,
      patientId: row.patientId,
      status: row.status,
      expiresAt: row.expiresAt,
      existingGrant: row.existingGrant,
    };
  }

  async closeOwnGrant(context: DataAccessContext, grantId: string, reason: string) {
    try {
      return await this.database.withTransaction(context, async (client) => {
        const result = await client.query<ClosedGrantRow>(
          `select
             consent_grant_id as "consentGrantId",
             subject_patient_id as "patientId",
             grant_status as status,
             closed_at as "closedAt",
             already_closed as "alreadyClosed"
           from identity.close_own_consent_grant($1, $2)`,
          [grantId, reason],
        );
        return this.requireRow(result.rows[0]);
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  private requireRow<Row>(row: Row | undefined): Row {
    if (!row) throw new DomainProblem(503, 'CONSENT_COMMAND_UNAVAILABLE', 'Consent command returned no result');
    return row;
  }

  private translate(error: unknown): unknown {
    if (error instanceof DomainProblem) return error;
    if (!isDatabaseError(error)) return error;
    const raw = (error as unknown as { message?: unknown }).message;
    const message = typeof raw === 'string' ? raw : '';
    // platform.require_control_enabled (0040): the control is off, or its row
    // cannot be read (missing, or hidden by row-level security). Every other
    // 55000 stays a 409 conflict.
    if (error.code === '55000' && message === 'PLATFORM_CONTROL_DISABLED:break_glass_enabled') {
      return new DomainProblem(423, 'BREAK_GLASS_DISABLED', 'Emergency access is currently disabled by the platform administrator');
    }
    if (error.code === '55000' && message === 'PLATFORM_CONTROL_UNAVAILABLE') {
      return new DomainProblem(503, 'PLATFORM_CONTROL_UNAVAILABLE', 'Platform runtime controls are unavailable');
    }
    // A self-signed-up facility's first 30 days after support's review (P4b,
    // Q4): the trigger consent_grants_self_service_probation allows 5
    // emergency activations a day per facility. Mapped before the generic
    // P0001 so it is not shown as the per-account limit (V5).
    if (error.code === 'P0001' && message === 'EMERGENCY_PROBATION_LIMIT') {
      return new DomainProblem(429, 'EMERGENCY_PROBATION_LIMITED', 'This facility is new to Health ID: emergency '
        + 'access is limited to 5 activations a day in its first 30 days. Contact Health ID support to lift the limit.');
    }
    switch (error.code) {
      case 'P0001':
        return new DomainProblem(429, 'EMERGENCY_RATE_LIMITED', 'Too many emergency activations. Contact your facility emergency access administrator.');
      case 'P0002':
        return new DomainProblem(404, 'CONSENT_RESOURCE_NOT_FOUND', 'The requested patient or consent grant is unavailable');
      case '42501':
        return new DomainProblem(403, 'CONSENT_COMMAND_DENIED', 'The consent command is not authorized');
      case '23505':
      case '55000':
        return new DomainProblem(409, 'CONSENT_COMMAND_CONFLICT', 'The consent state no longer permits this command');
      case '22001':
      case '22023':
      case '22P02':
      case '23514':
        return new DomainProblem(400, 'INVALID_CONSENT_COMMAND', 'The consent command failed integrity validation');
      default:
        return error;
    }
  }

  /** main's codes for the revocation, with REVOCATION_DETAIL for the patient. */
  private translateRevocation(error: unknown): unknown {
    if (error instanceof DomainProblem || !isDatabaseError(error)) return error;
    const raw = (error as unknown as { message?: unknown }).message;
    switch (error.code) {
      case '55000':
        return new DomainProblem(409, 'CONSENT_COMMAND_CONFLICT', raw === 'CONSENT_GRANT_NOT_PATIENT_REVOCABLE'
          ? REVOCATION_DETAIL.notRevocable : REVOCATION_DETAIL.notActive);
      case 'P0002':
        return new DomainProblem(404, 'CONSENT_RESOURCE_NOT_FOUND', REVOCATION_DETAIL.notFound);
      case '42501':
        return new DomainProblem(403, 'CONSENT_COMMAND_DENIED', REVOCATION_DETAIL.sessionNotLive);
      case '22023':
        return new DomainProblem(400, 'INVALID_CONSENT_COMMAND', REVOCATION_DETAIL.invalidReason);
      case '42883':
        // An Identity build ahead of migration 0087 (a rehearsal order only).
        return new DomainProblem(503, 'CONSENT_COMMAND_UNAVAILABLE', REVOCATION_DETAIL.unavailable);
      default:
        return this.translate(error);
    }
  }

  private translatePatientPin(error: unknown): unknown {
    if (error instanceof DomainProblem) return error;
    if (isDatabaseError(error) && ['42501', 'P0001', 'P0002', '22023', '22P02', '23514'].includes(error.code)) {
      return this.patientPinDenied();
    }
    return error;
  }

  private patientPinDenied(): DomainProblem {
    return new DomainProblem(403, 'PATIENT_PIN_ACCESS_DENIED', 'Patient access could not be verified');
  }
}

function isDatabaseError(value: unknown): value is { code: string } {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof (value as { code?: unknown }).code === 'string';
}
