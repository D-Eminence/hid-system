import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { AcceptEhrLabOrderCommand, LabWorkItemResult } from './lab-work-items.types';

interface WorkItemRow extends QueryResultRow {
  id: string; patient_id: string; facility_id: string; ordering_facility_id: string;
  source_ehr_order_id: string; source_ehr_order_version: string; source_encounter_id: string;
  status: 'accepted'; priority: AcceptEhrLabOrderCommand['priority']; accepted_by: string;
  accepted_at: Date; row_version: string; created_at: Date;
}

const WORK_ITEM_SELECT = `select id::text,patient_id::text,facility_id::text,ordering_facility_id::text,
  source_ehr_order_id::text,source_ehr_order_version::text,source_encounter_id::text,status,priority,
  accepted_by::text,accepted_at,row_version::text,created_at from lab.work_items`;

@Injectable()
export class LabWorkItemsService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityService,
    private readonly audit: AuditService) {}

  async acceptEhrOrder(context: DataAccessContext, command: AcceptEhrLabOrderCommand): Promise<LabWorkItemResult> {
    if (!context.actor.permissions.includes('lab.work-item.accept')) {
      throw new DomainProblem(403, 'LAB_WORK_ITEM_ACCESS_DENIED', 'Lab order acceptance permission is required');
    }
    if (command.orderingFacilityId !== context.facilityId) {
      throw new DomainProblem(403, 'LAB_CROSS_FACILITY_ACCEPTANCE_DENIED', 'Only same-facility Lab acceptance is currently supported');
    }
    await this.authorize(command.patientId, context, 'write_records');
    const key = `ehr-lab-order:${command.sourceEhrOrderId}:v${command.sourceEhrOrderVersion}`;
    const digest = requestDigest('lab.work-item.accept-ehr-order', command);
    try {
      return await this.database.withTransaction(context, (client) => this.accept(context, command, key, digest, client),
        { isolationLevel: 'SERIALIZABLE' });
    } catch (error) {
      // lab.validate_work_item (0077) refuses a work item that is not the EHR
      // order's current active version exactly as EHR holds it (a changed or
      // no longer active order, another time or field): 23514, never retried.
      if (sqlState(error) === '23514') {
        throw new DomainProblem(409, 'LAB_ORDER_NOT_CURRENT',
          'Lab accepts only the current version of an active EHR order, exactly as the EHR holds it', undefined,
          { cause: error });
      }
      throw error;
    }
  }

  private async accept(context: DataAccessContext, command: AcceptEhrLabOrderCommand, key: string, digest: string,
    client: PoolClient): Promise<LabWorkItemResult> {
    // Work items are insert-only (0018 trigger; no UPDATE for the runtime role,
    // so no row lock). Lab holds one work item per EHR order, ever
    // (unique source_ehr_order_id), and one per idempotency key, so the replay
    // read looks for the order at any version; DatabaseService reruns the
    // SERIALIZABLE loser of a race, which then finds the winner (Stage 9).
    const existingResult = await client.query<WorkItemRow & { request_sha256: string }>(
      `select id::text,patient_id::text,facility_id::text,ordering_facility_id::text,
        source_ehr_order_id::text,source_ehr_order_version::text,source_encounter_id::text,status,
        priority,accepted_by::text,accepted_at,row_version::text,created_at,request_sha256
       from lab.work_items where (facility_id=$1 and accepted_by=$2 and idempotency_key=$3)
         or source_ehr_order_id=$4`,
      [context.facilityId, context.actor.accountId, key, command.sourceEhrOrderId]);
    const existing = existingResult.rows[0];
    if (existing) {
      // Another version of the order: EHR changed it after Lab accepted it. Lab
      // keeps the version it accepted (later changes are not propagated).
      if (Number(existing.source_ehr_order_version) !== command.sourceEhrOrderVersion) {
        throw new DomainProblem(409, 'LAB_ORDER_ALREADY_ACCEPTED',
          `Lab already holds version ${Number(existing.source_ehr_order_version)} of this EHR order and accepts no other version`);
      }
      if (existing.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'Lab order acceptance conflicts with existing work');
      return this.project(existing);
    }
    const result = await client.query<WorkItemRow>(
      `insert into lab.work_items(id,patient_id,facility_id,ordering_facility_id,source_ehr_order_id,
        source_ehr_order_version,source_encounter_id,status,priority,test_code_system,test_code,
        test_name,clinical_indication,requested_by,requested_at,accepted_by,
        accepted_by_membership_id,idempotency_key,request_sha256,correlation_id)
       values ($1,$2,$3,$4,$5,$6,$7,'accepted',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       returning *`,
      [randomUUID(),command.patientId,context.facilityId,command.orderingFacilityId,
        command.sourceEhrOrderId,command.sourceEhrOrderVersion,command.sourceEncounterId,
        command.priority,command.testCodeSystem,command.testCode,command.testName,
        command.clinicalIndication ?? null,command.requestedBy,command.requestedAt,
        context.actor.accountId,context.membershipId,key,digest,context.correlationId]);
    const row = result.rows[0];
    if (!row) throw new DomainProblem(503, 'LAB_WORK_ITEM_NOT_CREATED', 'Lab could not accept the EHR order');
    await client.query(
      `insert into lab.work_item_requested_tests(work_item_id,facility_id,patient_id,"ordinal",code_system,code,name)
       values ($1,$2,$3,1,$4,$5,$6)`,
      [row.id,row.facility_id,row.patient_id,command.testCodeSystem,command.testCode,command.testName]);
    await client.query(
      `insert into lab.work_item_events(work_item_id,facility_id,patient_id,event_version,event_type,
        actor_id,actor_membership_id,reason,correlation_id)
       values ($1,$2,$3,1,'accepted',$4,$5,'Accepted exact EHR laboratory order version',$6)`,
      [row.id,row.facility_id,row.patient_id,context.actor.accountId,context.membershipId,context.correlationId]);
    await client.query(
      `insert into lab.outbox_events(event_type,aggregate_id,aggregate_version,facility_id,patient_id,correlation_id,payload)
       values ('LabWorkItemCreated',$1,1,$2,$3,$4,$5::jsonb)`,
      [row.id,row.facility_id,row.patient_id,context.correlationId,
        JSON.stringify({ workItemId: row.id, sourceEhrOrderId: row.source_ehr_order_id,
          sourceEhrOrderVersion: Number(row.source_ehr_order_version), status: row.status })]);
    await this.audit.recordWithClient(client, this.auditEvent(context,row,'lab.work-item.accept', {
      orderingFacilityId: row.ordering_facility_id, sourceEhrOrderId: row.source_ehr_order_id,
      sourceEhrOrderVersion: Number(row.source_ehr_order_version),
    }));
    return this.project(row);
  }

  async get(context: DataAccessContext, workItemId: string): Promise<LabWorkItemResult> {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<WorkItemRow>(`${WORK_ITEM_SELECT} where id=$1`, [workItemId]);
      const row = result.rows[0];
      if (!row) throw new DomainProblem(404, 'LAB_WORK_ITEM_NOT_FOUND', 'Lab work item was not found');
      await this.authorize(row.patient_id, context, 'read_records');
      await this.audit.recordWithClient(client, this.auditEvent(context,row,'lab.work-item.read'));
      return this.project(row);
    });
  }

  async list(context: DataAccessContext) {
    if (!context.actor.permissions.includes('lab.work-item.read')) {
      throw new DomainProblem(403, 'LAB_WORK_ITEM_ACCESS_DENIED', 'Lab work-item read permission is required');
    }
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<WorkItemRow & { test_name:string; accession_id:string|null; accession_number:string|null;
        specimen_statuses:string[]|null }>(`select w.id::text,w.patient_id::text,w.facility_id::text,w.ordering_facility_id::text,
        w.source_ehr_order_id::text,w.source_ehr_order_version::text,w.source_encounter_id::text,w.status,w.priority,
        w.accepted_by::text,w.accepted_at,w.row_version::text,w.created_at,w.test_name,a.id::text as accession_id,
        a.accession_number,array_remove(array_agg(s.status order by s.created_at),null) as specimen_statuses from lab.work_items w
        left join lab.accessions a on a.work_item_id=w.id left join lab.specimens s on s.accession_id=a.id
        group by w.id,a.id,a.accession_number order by w.accepted_at asc,w.id asc limit 200`);
      return { items: result.rows.map((row) => ({ ...this.project(row),testName:row.test_name,
        accessionId:row.accession_id,accessionNumber:row.accession_number,specimenStatuses:row.specimen_statuses ?? [] })) };
    });
  }

  private async authorize(patientId: string, context: DataAccessContext, action: 'read_records' | 'write_records') {
    const decision = await this.identity.authorize(patientId, action, context.purposeOfUse, context);
    if (!decision.allowed || (action === 'write_records' && decision.breakGlass)) {
      throw new DomainProblem(403, 'LAB_WORK_ITEM_ACCESS_DENIED', 'Lab work-item access is not authorized');
    }
  }

  private project(row: WorkItemRow): LabWorkItemResult {
    return { id: row.id,patientId: row.patient_id,facilityId: row.facility_id,
      sourceEhrOrderId: row.source_ehr_order_id,sourceEhrOrderVersion: Number(row.source_ehr_order_version),
      status: row.status,priority: row.priority,acceptedAt: row.accepted_at,version: Number(row.row_version) };
  }

  private auditEvent(context: DataAccessContext,row: WorkItemRow,action: string,details?: Record<string,unknown>) {
    return { correlationId: context.correlationId,actorType: 'staff' as const,actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,facilityId: context.facilityId,
      patientId: row.patient_id,action,resourceType: 'lab-work-item',resourceId: row.id,
      outcome: 'success' as const,purposeOfUse: context.purposeOfUse,details,sourceSystem: 'lab-api' };
  }
}

function sqlState(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}
