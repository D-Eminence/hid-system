import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem, refusalOutcome } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import type { EncounterStatus } from './clinical.dto';
import { type EncounterChange, lockEncounterStatus, refuseClosedEncounter } from './encounter-status';

export type ClinicalAccess = 'read_records' | 'write_records';

export interface SemanticEvent {
  /** Only a break-glass authorization may run it (the emergency summary). */
  breakGlassOnly?: boolean;
  /**
   * A break-glass authorization may never run it (imported legacy history,
   * ADR-065): refused with 403 and this code, audited denied, before any
   * transaction.
   */
  excludeBreakGlass?: { code: string };
  action: string;
  resourceType: string;
  resourceId?: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface OperationResult<Value> {
  value: Value;
  resourceId?: string;
  details?: Readonly<Record<string, unknown>>;
}

interface IdempotencyRow extends QueryResultRow {
  request_sha256: string;
  state: 'processing' | 'completed' | 'failed';
  result_resource_id: string | null;
  result_resource_type: string | null;
}

type TransactionState<Value> =
  | { state: 'ok'; result: OperationResult<Value> }
  | { state: 'denied' }
  | { state: 'missing' };

@Injectable()
export class ClinicalRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly identity: IdentityApiService,
  ) {}

  async run<Value>(
    context: DataAccessContext,
    patientId: string,
    access: ClinicalAccess,
    event: SemanticEvent,
    operation: (client: PoolClient) => Promise<OperationResult<Value>>,
    scopedLookup?: (client: PoolClient) => Promise<boolean>,
  ): Promise<Value> {
    if (event.breakGlassOnly && event.excludeBreakGlass) {
      throw new Error('A clinical event cannot set both breakGlassOnly and excludeBreakGlass');
    }
    // Set once a refusal has its own audit row: Identity's refusal, or a
    // resource not found, recorded inside its transaction.
    let audited = false;
    try {
      const authorization = await this.identity.authorize(
        patientId,
        access,
        context.purposeOfUse,
        context,
      );
      if (!authorization.allowed || (event.breakGlassOnly && !authorization.breakGlass)) {
        await this.audit.record({
          correlationId: context.correlationId,
          actorType: 'staff',
          actorSubject: context.actor.subject,
          actorAccountId: context.actor.accountId,
          actorMembershipId: context.membershipId,
          organizationId: context.actor.facility?.organizationId,
          facilityId: context.facilityId,
          patientId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          outcome: 'denied',
          purposeOfUse: context.purposeOfUse,
          details: { ...event.details, reason: 'identity_authorization' },
        });
        audited = true;
        throw new DomainProblem(403, 'CONSENT_REQUIRED', 'Active consent and facility membership are required');
      }
      if (event.excludeBreakGlass && authorization.breakGlass) {
        await this.audit.record({
          correlationId: context.correlationId,
          actorType: 'staff',
          actorSubject: context.actor.subject,
          actorAccountId: context.actor.accountId,
          actorMembershipId: context.membershipId,
          organizationId: context.actor.facility?.organizationId,
          facilityId: context.facilityId,
          patientId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          outcome: 'denied',
          purposeOfUse: context.purposeOfUse,
          details: { ...event.details, reason: 'break_glass_excluded' },
        });
        audited = true;
        throw new DomainProblem(403, event.excludeBreakGlass.code, 'This read is never available under break-glass');
      }
      const result = await this.database.withTransaction(context, async (client): Promise<TransactionState<Value>> => {
        // Resource probes are always constrained by facility and patient before
        // authorization so an identifier from another tenant cannot be resolved.
        const resourceExists = scopedLookup ? await scopedLookup(client) : true;
        if (!resourceExists) {
          await this.record(client, context, patientId, event, 'failure', { reason: 'not_found' });
          return { state: 'missing' };
        }
        const operationResult = await operation(client);
        await this.record(client, context, patientId, {
          ...event,
          resourceId: operationResult.resourceId ?? event.resourceId,
          details: { ...event.details, ...operationResult.details },
        }, 'success');
        return { state: 'ok', result: operationResult };
      });

      if (result.state === 'denied') {
        throw new DomainProblem(403, 'CONSENT_REQUIRED', 'Active consent and facility membership are required');
      }
      if (result.state === 'missing') {
        audited = true;
        throw new DomainProblem(404, 'CLINICAL_RESOURCE_NOT_FOUND', 'Clinical resource was not found');
      }
      return result.result.value;
    } catch (error) {
      const translated = this.translate(error);
      if (!audited) await this.recordRefusal(context, patientId, event, translated);
      throw translated;
    }
  }

  /**
   * A command refused inside its transaction lost its semantic audit row with
   * the rollback; only the HTTP failure row remained (A17-EHR-AUDIT). The
   * refusal is recorded here, after the rollback, outside any transaction:
   * `denied` for a refusal (401, 403, 409, 412, 423, 429), `failure` for
   * invalid or missing input (400, 404), with the status and code answered
   * and the refusal's own audit details (codes, never clinical content). A
   * server fault (5xx, or an untranslated error) is left to the HTTP failure
   * row. When the row cannot be written the request fails closed with 503.
   */
  private async recordRefusal(context: DataAccessContext, patientId: string, event: SemanticEvent,
    refusal: unknown): Promise<void> {
    if (!(refusal instanceof DomainProblem) || refusal.getStatus() >= 500) return;
    const status = refusal.getStatus();
    await this.audit.record({
      correlationId: context.correlationId,
      actorType: 'staff',
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      patientId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      outcome: refusalOutcome(status),
      purposeOfUse: context.purposeOfUse,
      details: { status, code: refusal.code, ...refusal.auditDetails },
    });
  }

  async executeCreate<Value>(
    client: PoolClient,
    context: DataAccessContext,
    patientId: string,
    idempotencyKey: string,
    operation: string,
    requestSha256: string,
    resourceType: string,
    create: () => Promise<{ value: Value; id: string }>,
    load: (id: string) => Promise<Value | undefined>,
  ): Promise<OperationResult<Value>> {
    const inserted = await client.query<{ id: string }>(
      `insert into ehr.idempotency_keys (
         facility_id, patient_id, created_by, created_by_membership_id,
         idempotency_key, operation, request_sha256, locked_until, expires_at
       ) values ($1, $2, $3, $4, $5, $6, $7, clock_timestamp() + interval '30 seconds', clock_timestamp() + interval '24 hours')
       on conflict (facility_id, created_by, operation, idempotency_key) do nothing
       returning id`,
      [
        context.facilityId,
        patientId,
        context.actor.accountId,
        context.membershipId,
        idempotencyKey,
        operation,
        requestSha256,
      ],
    );

    if (inserted.rowCount === 0) {
      const existing = await client.query<IdempotencyRow>(
        `select request_sha256, state, result_resource_id, result_resource_type
         from ehr.idempotency_keys
         where facility_id = $1 and created_by = $2 and operation = $3 and idempotency_key = $4
         for update`,
        [context.facilityId, context.actor.accountId, operation, idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row || row.request_sha256 !== requestSha256) {
        throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
      }
      if (row.state !== 'completed' || row.result_resource_type !== resourceType || !row.result_resource_id) {
        throw new DomainProblem(409, 'REQUEST_IN_PROGRESS', 'An operation with this Idempotency-Key is already in progress');
      }
      const value = await load(row.result_resource_id);
      if (!value) throw new DomainProblem(409, 'IDEMPOTENCY_RESULT_UNAVAILABLE', 'The prior operation result is unavailable');
      return { value, resourceId: row.result_resource_id, details: { idempotentReplay: true } };
    }

    const created = await create();
    await this.setChangeReason(client, 'complete idempotent clinical create');
    await client.query(
      `update ehr.idempotency_keys
       set state = 'completed', result_resource_type = $1, result_resource_id = $2,
           response_status = 201, locked_until = clock_timestamp()
       where id = $3`,
      [resourceType, created.id, inserted.rows[0]?.id],
    );
    return { value: created.value, resourceId: created.id, details: { idempotentReplay: false } };
  }

  async setChangeReason(client: PoolClient, reason: string): Promise<void> {
    await client.query(`select set_config('app.change_reason', $1, true)`, [reason]);
  }

  async exists(
    client: PoolClient,
    table: 'encounters' | 'clinical_notes' | 'vitals' | 'diagnoses' | 'prescriptions' | 'lab_requests',
    id: string,
    patientId: string,
    facilityId: string,
    encounterId?: string,
  ): Promise<boolean> {
    const encounterClause = encounterId ? ' and encounter_id = $4' : '';
    const values = encounterId ? [id, patientId, facilityId, encounterId] : [id, patientId, facilityId];
    const result = await client.query(
      `select 1 from ehr.${table} where id = $1 and patient_id = $2 and facility_id = $3${encounterClause} limit 1`,
      values,
    );
    return (result.rowCount ?? 0) > 0;
  }

  async encounterExists(client: PoolClient, encounterId: string, patientId: string, facilityId: string): Promise<boolean> {
    return this.exists(client, 'encounters', encounterId, patientId, facilityId);
  }

  /**
   * Share-locks the encounter, as ehr.require_open_encounter() does (0084),
   * and returns its status. Call it before locking any record of the
   * encounter. 404 when the writer cannot see or lock it.
   */
  async lockEncounterStatus(
    client: PoolClient,
    encounterId: string,
    patientId: string,
    facilityId: string,
  ): Promise<EncounterStatus> {
    const status = await lockEncounterStatus(client, encounterId, patientId, facilityId);
    if (!status) throw new DomainProblem(404, 'ENCOUNTER_NOT_FOUND', 'Encounter was not found');
    return status;
  }

  /**
   * Share-locks the encounter and refuses a closed one before a record or
   * order is added (409 ENCOUNTER_NOT_OPEN; CLIN-EIE). An idempotent replay
   * returns its earlier result without this check.
   */
  async requireOpenEncounter(
    client: PoolClient,
    encounterId: string,
    patientId: string,
    facilityId: string,
    change: EncounterChange,
  ): Promise<EncounterStatus> {
    const status = await this.lockEncounterStatus(client, encounterId, patientId, facilityId);
    refuseClosedEncounter(status, change);
    return status;
  }

  private async record(
    client: PoolClient,
    context: DataAccessContext,
    patientId: string,
    event: SemanticEvent,
    outcome: 'success' | 'denied' | 'failure',
    additionalDetails: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.audit.recordWithClient(client, {
      correlationId: context.correlationId,
      actorType: 'staff',
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      patientId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      outcome,
      purposeOfUse: context.purposeOfUse,
      details: { ...event.details, ...additionalDetails },
    });
  }

  private translate(error: unknown): unknown {
    if (error instanceof DomainProblem) return error;
    if (!isDatabaseError(error)) return error;
    // The 0084 guards, behind the services' own checks.
    if (error.code === '55000') {
      const message = (error as { message?: unknown }).message;
      if (message === 'ENCOUNTER_NOT_OPEN') {
        return new DomainProblem(409, 'ENCOUNTER_NOT_OPEN', 'The encounter takes no further clinical records of this kind');
      }
      if (message === 'DIAGNOSIS_ENTERED_IN_ERROR') {
        return new DomainProblem(409, 'DIAGNOSIS_NOT_AMENDABLE', 'A diagnosis entered in error cannot be changed');
      }
      if (message === 'VITAL_RECORD_IMMUTABLE') {
        return new DomainProblem(409, 'VITAL_RECORD_IMMUTABLE', 'Recorded vitals are corrected only by a correction');
      }
      // The 0090 guards.
      if (message === 'VITAL_ENTERED_IN_ERROR') {
        return new DomainProblem(409, 'VITAL_NOT_AMENDABLE', 'A vital entered in error cannot be changed');
      }
      if (message === 'PRESCRIPTION_FINAL') {
        return new DomainProblem(409, 'PRESCRIPTION_NOT_AMENDABLE',
          'A completed, cancelled or entered-in-error prescription cannot be changed');
      }
      if (message === 'INVALID_PRESCRIPTION_TRANSITION') {
        return new DomainProblem(409, 'INVALID_PRESCRIPTION_TRANSITION', 'Prescription status transition is not allowed');
      }
      if (message === 'LAB_REQUEST_FINAL') {
        return new DomainProblem(409, 'LAB_REQUEST_NOT_AMENDABLE',
          'A completed, cancelled or entered-in-error lab request cannot be changed');
      }
      if (message === 'INVALID_LAB_REQUEST_TRANSITION') {
        return new DomainProblem(409, 'INVALID_LAB_REQUEST_TRANSITION', 'Lab request status transition is not allowed');
      }
    }
    if (error.code === '42501' && (error as { message?: unknown }).message === 'ENCOUNTER_RETRACTION_NOT_PERMITTED') {
      return new DomainProblem(403, 'ENCOUNTER_RETRACTION_NOT_PERMITTED',
        'Cancelling or retracting this encounter changes records you may not write');
    }
    switch (error.code) {
      case '42501':
        return new DomainProblem(403, 'ACCESS_DENIED', 'Clinical access was denied');
      case '23505':
        return new DomainProblem(409, 'CLINICAL_CONFLICT', 'A conflicting clinical record already exists');
      case '23503':
        return new DomainProblem(409, 'INVALID_CLINICAL_REFERENCE', 'A referenced clinical resource is unavailable');
      case '23514':
      case '22001':
      case '22007':
      case '22P02':
        return new DomainProblem(400, 'INVALID_CLINICAL_DATA', 'Clinical data failed integrity validation');
      default:
        return error;
    }
  }
}

function isDatabaseError(value: unknown): value is { code: string } {
  return typeof value === 'object' && value !== null && 'code' in value && typeof (value as { code?: unknown }).code === 'string';
}
