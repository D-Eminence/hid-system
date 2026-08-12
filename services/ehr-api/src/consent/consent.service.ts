import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { CreateAccessRequestDto } from './dto/create-access-request.dto';
import type { CreateBreakGlassDto } from './dto/create-break-glass.dto';

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

  async activateBreakGlass(context: DataAccessContext, input: CreateBreakGlassDto) {
    try {
      return await this.database.withTransaction(context, async (client) => {
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
    switch (error.code) {
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
}

function isDatabaseError(value: unknown): value is { code: string } {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof (value as { code?: unknown }).code === 'string';
}
