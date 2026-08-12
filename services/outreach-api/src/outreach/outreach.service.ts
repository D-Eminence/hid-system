import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { CreateRegistrationCaseDto } from './dto/create-registration-case.dto';
import type { LinkExistingPatientDto } from './dto/link-existing-patient.dto';
import { registrationCase, type OutreachRegistrationCase, type RegistrationRow } from './outreach.types';

interface IdempotencyRow { request_sha256: string; registration_case_id: string }

@Injectable()
export class OutreachService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
  ) {}

  async create(input: CreateRegistrationCaseDto, idempotencyKey: string,
    context: DataAccessContext): Promise<OutreachRegistrationCase> {
    const normalized = { ...input, fullName: input.fullName.trim(),
      phone: input.phone?.trim() || null, operationalNotes: input.operationalNotes?.trim() || null };
    const digest = requestDigest('outreach.registration-case.create', normalized);
    return this.database.withTransaction(context, async (client) => {
      const replay = await this.replay(client, context, 'registration_case_create', idempotencyKey, digest);
      if (replay) return replay;
      try {
        const inserted = await client.query<RegistrationRow>(`insert into outreach.registration_cases (
          facility_id,created_by_account_id,created_by_membership_id,local_command_id,
          temporary_patient_id,full_name,sex,age_years,phone,operational_notes
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [context.facilityId, context.actor.accountId, context.membershipId, normalized.localCommandId,
          normalized.temporaryPatientId, normalized.fullName, normalized.sex, normalized.ageYears,
          normalized.phone, normalized.operationalNotes]);
        const row = inserted.rows[0];
        if (!row) throw new Error('Outreach registration insert returned no row');
        await client.query(`insert into outreach.registration_case_events (
          registration_case_id,event_type,facility_id,temporary_patient_id,actor_account_id,actor_membership_id
        ) values ($1,'registration_case_received',$2,$3,$4,$5)`,
        [row.id, context.facilityId, row.temporary_patient_id, context.actor.accountId, context.membershipId]);
        await client.query(`insert into outreach.command_idempotency (
          requester_account_id,requester_membership_id,facility_id,operation,idempotency_key,
          request_sha256,registration_case_id
        ) values ($1,$2,$3,'registration_case_create',$4,$5,$6)`,
        [context.actor.accountId, context.membershipId, context.facilityId, idempotencyKey, digest, row.id]);
        await this.outbox(client, 'OutreachRegistrationCaseCreated', row.id, 1, context, null,
          { registrationCaseId: row.id, temporaryPatientId: row.temporary_patient_id,
            status: 'identity_resolution_pending' });
        await this.audit.recordWithClient(client, context, 'outreach.registration-case.received', row.id);
        return registrationCase(row);
      } catch (error) {
        this.translateConflict(error, 'OUTREACH_REGISTRATION_CONFLICT',
          'This local Outreach registration was already received');
        throw error;
      }
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async list(context: DataAccessContext): Promise<readonly OutreachRegistrationCase[]> {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<RegistrationRow>(`select * from outreach.registration_cases
        where facility_id=$1 order by created_at desc,id desc limit 100`, [context.facilityId]);
      await this.audit.recordWithClient(client, context, 'outreach.registration-case.list', context.facilityId);
      return result.rows.map(registrationCase);
    });
  }

  async get(id: string, context: DataAccessContext): Promise<OutreachRegistrationCase> {
    return this.database.withTransaction(context, async (client) => {
      const value = await this.find(client, id);
      await this.audit.recordWithClient(client, context, 'outreach.registration-case.read', id,
        value.resolvedPatientId ?? undefined);
      return value;
    });
  }

  async linkExisting(id: string, input: LinkExistingPatientDto, idempotencyKey: string,
    context: DataAccessContext): Promise<OutreachRegistrationCase> {
    await this.identity.authorizeExistingPatient(input.canonicalPatientId, context);
    const normalized = { ...input, reason: input.reason.trim() };
    const digest = requestDigest('outreach.registration-case.link-existing', { id, ...normalized });
    try {
      return await this.database.withTransaction(context, async (client) => {
        const replay = await this.replay(client, context, 'registration_case_link_existing',
          idempotencyKey, digest);
        if (replay) return replay;
        const currentResult = await client.query<RegistrationRow>(
          'select * from outreach.registration_cases where id=$1 for update', [id]);
        const current = currentResult.rows[0];
        if (!current) throw new DomainProblem(404, 'OUTREACH_REGISTRATION_NOT_FOUND',
          'The Outreach registration case was not found');
        if (current.status !== 'identity_resolution_pending') throw new DomainProblem(409,
          'OUTREACH_REGISTRATION_ALREADY_RESOLVED', 'The Outreach registration case is already resolved');
        if (Number(current.row_version) !== normalized.expectedVersion) throw new DomainProblem(412,
          'VERSION_CONFLICT', 'The Outreach registration case changed; reload before reconciling');
        await client.query(`insert into outreach.patient_mappings (
          registration_case_id,facility_id,temporary_patient_id,canonical_patient_id,
          resolution_kind,resolved_by_account_id,resolved_by_membership_id,reason
        ) values ($1,$2,$3,$4,'linked_existing',$5,$6,$7)`,
        [id, context.facilityId, current.temporary_patient_id, normalized.canonicalPatientId,
          context.actor.accountId, context.membershipId, normalized.reason]);
        const updated = await client.query<RegistrationRow>(`update outreach.registration_cases set
          status='identity_resolved',resolved_patient_id=$2,resolution_kind='linked_existing',
          resolved_by_account_id=$3,resolved_by_membership_id=$4,resolution_reason=$5,
          resolved_at=clock_timestamp(),row_version=row_version+1
          where id=$1 and row_version=$6 returning *`,
        [id, normalized.canonicalPatientId, context.actor.accountId, context.membershipId,
          normalized.reason, normalized.expectedVersion]);
        const row = updated.rows[0];
        if (!row) throw new DomainProblem(412, 'VERSION_CONFLICT',
          'The Outreach registration case changed; reload before reconciling');
        await client.query(`insert into outreach.registration_case_events (
          registration_case_id,event_type,facility_id,temporary_patient_id,canonical_patient_id,
          actor_account_id,actor_membership_id,reason
        ) values ($1,'existing_patient_linked',$2,$3,$4,$5,$6,$7)`,
        [id, context.facilityId, row.temporary_patient_id, normalized.canonicalPatientId,
          context.actor.accountId, context.membershipId, normalized.reason]);
        await client.query(`insert into outreach.command_idempotency (
          requester_account_id,requester_membership_id,facility_id,operation,idempotency_key,
          request_sha256,registration_case_id
        ) values ($1,$2,$3,'registration_case_link_existing',$4,$5,$6)`,
        [context.actor.accountId, context.membershipId, context.facilityId, idempotencyKey, digest, id]);
        await this.outbox(client, 'OutreachPatientResolved', id, Number(row.row_version), context,
          normalized.canonicalPatientId, { registrationCaseId: id,
            temporaryPatientId: row.temporary_patient_id, canonicalPatientId: normalized.canonicalPatientId,
            resolutionKind: 'linked_existing' });
        await this.audit.recordWithClient(client, context, 'outreach.patient.linked-existing', id,
          normalized.canonicalPatientId);
        return registrationCase(row);
      }, { isolationLevel: 'SERIALIZABLE' });
    } catch (error) {
      this.translateConflict(error, 'OUTREACH_RESOLUTION_CONFLICT',
        'The Outreach registration has a conflicting patient resolution');
      throw error;
    }
  }

  private async replay(client: PoolClient, context: DataAccessContext, operation: string,
    key: string, digest: string): Promise<OutreachRegistrationCase | null> {
    const result = await client.query<IdempotencyRow>(`select request_sha256,registration_case_id
      from outreach.command_idempotency where requester_account_id=$1 and facility_id=$2
      and operation=$3 and idempotency_key=$4`,
    [context.actor.accountId, context.facilityId, operation, key]);
    const replay = result.rows[0];
    if (!replay) return null;
    if (replay.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT',
      'The Idempotency-Key belongs to a different Outreach request');
    return this.find(client, replay.registration_case_id);
  }

  private async find(client: PoolClient, id: string): Promise<OutreachRegistrationCase> {
    const result = await client.query<RegistrationRow>(
      'select * from outreach.registration_cases where id=$1', [id]);
    const row = result.rows[0];
    if (!row) throw new DomainProblem(404, 'OUTREACH_REGISTRATION_NOT_FOUND',
      'The Outreach registration case was not found');
    return registrationCase(row);
  }

  private outbox(client: PoolClient, eventType: string, id: string, version: number,
    context: DataAccessContext, patientId: string | null, payload: Record<string, unknown>) {
    return client.query(`insert into outreach.outbox_events (
      event_type,aggregate_id,aggregate_version,facility_id,patient_id,correlation_id,payload
    ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [eventType, id, version, context.facilityId, patientId, context.correlationId, JSON.stringify(payload)]);
  }

  private translateConflict(error: unknown, problemCode: string, detail: string): void {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code : undefined;
    if (code === '23505') throw new DomainProblem(409, problemCode, detail);
  }
}
