import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { requirePatient } from '../auth/patient-self.service';
import { DatabaseService } from '../database/database.service';
import type { CreateAccessRequestDto } from './dto/create-access-request.dto';
import type { CreateBreakGlassDto } from './dto/create-break-glass.dto';
import type { ListStaffAccessRequestsDto } from './dto/list-staff-access-requests.dto';
import type { VerifyPatientAccessPinDto } from './dto/verify-patient-access-pin.dto';

export interface AccessRequestRow extends QueryResultRow {
  accessRequestId: string;
  patientId: string;
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

@Injectable()
export class ConsentService {
  constructor(private readonly database: DatabaseService) {}

  async createAccessRequest(context: DataAccessContext, input: CreateAccessRequestDto) {
    try {
      return await this.database.withTransaction(context, async (client) => {
        const result = await client.query<AccessRequestRow>(
          `select
             access_request_id as "accessRequestId",
             subject_patient_id as "patientId",
             request_status as status,
             request_scope as scope,
             request_purpose as purpose,
             duration_minutes as "durationMinutes",
             requested_at as "requestedAt",
             existing_request as "existingRequest"
           from identity.create_access_request($1, $2, $3, $4)`,
          [input.hid, input.scope, input.reason, input.durationMinutes],
        );
        return this.requireRow(result.rows[0]);
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
             denied_at as "deniedAt", denied_reason as "deniedReason",
             consent_grant_id as "consentGrantId", grant_expires_at as "grantExpiresAt",
             effective_status as "effectiveStatus", authorization_method as "authorizationMethod"
           from identity.list_my_staff_access_requests($1)`,
          [query.status ?? null],
        );
        return result.rows;
      }, { readOnly: true });
    } catch (error) {
      throw this.translate(error);
    }
  }

  async listMyAccessRequests(request: HidRequest) {
    const actor = requirePatient(request.actor);
    try {
      return await this.asPatient(request, actor.subject, async (client) => (await client.query<Record<string, unknown> & QueryResultRow>(
        `select access_request_id as "accessRequestId", facility_id as "facilityId",
           facility_name as "facilityName", scope, reason, status,
           requested_duration_minutes as "requestedDurationMinutes",
           requested_at as "requestedAt", approved_at as "approvedAt",
           denied_at as "deniedAt", denied_reason as "deniedReason"
         from identity.list_my_patient_access_requests($1, $2)`,
        [actor.subject, actor.sessionId],
      )).rows);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async approveAccessRequest(request: HidRequest, requestId: string) {
    const actor = requirePatient(request.actor);
    try {
      return await this.asPatient(request, actor.subject, async (client) => this.requireRow((await client.query<Record<string, unknown> & QueryResultRow>(
        `select access_request_id as "accessRequestId", consent_grant_id as "consentGrantId",
           patient_id as "patientId", status, expires_at as "expiresAt", replayed
         from identity.approve_my_access_request($1, $2, $3)`,
        [actor.subject, actor.sessionId, requestId],
      )).rows[0]));
    } catch (error) {
      throw this.translate(error);
    }
  }

  async denyAccessRequest(request: HidRequest, requestId: string, reason: string) {
    const actor = requirePatient(request.actor);
    try {
      return await this.asPatient(request, actor.subject, async (client) => this.requireRow((await client.query<Record<string, unknown> & QueryResultRow>(
        `select access_request_id as "accessRequestId", patient_id as "patientId",
           status, denied_at as "deniedAt", replayed
         from identity.deny_my_access_request($1, $2, $3, $4)`,
        [actor.subject, actor.sessionId, requestId, reason.trim()],
      )).rows[0]));
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Patients may revoke access they granted; break-glass grants are not patient-revocable. */
  async revokeMyConsentGrant(request: HidRequest, grantId: string, reason: string) {
    const actor = requirePatient(request.actor);
    try {
      return await this.asPatient(request, actor.subject, async (client) => this.requireRow((await client.query<Record<string, unknown> & QueryResultRow>(
        `select consent_grant_id as "consentGrantId", grant_status as status,
           revoked_at as "revokedAt", replayed
         from identity.revoke_my_consent_grant($1, $2, $3, $4)`,
        [actor.subject, actor.sessionId, grantId, reason.trim()],
      )).rows[0]));
    } catch (error) {
      throw this.translate(error);
    }
  }

  async activateBreakGlass(context: DataAccessContext, input: CreateBreakGlassDto) {
    try {
      return await this.database.withTransaction(context, async (client) => {
        // The platform administrative control is the authoritative switch for
        // emergency access; it is checked inside the activation transaction.
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
      throw this.translate(error);
    }
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

  private asPatient<Result>(
    request: HidRequest,
    subject: string,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    return this.database.withSystemTransaction(request.correlationId, async (client) => {
      // Bind the verified patient subject; each command re-validates the session.
      await client.query("select set_config('app.actor_subject', $1, true)", [subject]);
      return operation(client);
    });
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
    if (error.code === '55000' && message === 'PLATFORM_CONTROL_DISABLED:break_glass_enabled') {
      return new DomainProblem(423, 'BREAK_GLASS_DISABLED', 'Emergency access is currently disabled by the platform administrator');
    }
    if (error.code === '55000' && message === 'PLATFORM_CONTROL_UNAVAILABLE') {
      return new DomainProblem(503, 'PLATFORM_CONTROL_UNAVAILABLE', 'Platform runtime controls are unavailable');
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
