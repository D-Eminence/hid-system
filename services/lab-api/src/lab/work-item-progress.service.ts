import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { LabWorkItemProgressDto } from './dto/work-item-progress.dto';

/**
 * Where a lab request is in this facility's own laboratory (ORD-3):
 * - not_received: no work item here that the clinician may read;
 * - received: the laboratory has it and no sample is taken yet;
 * - sample_collected: a sample was taken (collectedAt, the first one);
 * - some_results_ready: some of its tests have a released result;
 * - results_ready: every test it asks for has a released result.
 * A result counts only while its current version is released and not marked
 * entered in error, the same rule as the laboratory's own work list.
 */
export type LabProgressStatus = 'not_received' | 'received' | 'sample_collected' | 'some_results_ready'
  | 'results_ready';

export interface LabProgressItem {
  sourceEhrOrderId: string;
  status: LabProgressStatus;
  receivedAt: string | null;
  collectedAt: string | null;
  lastResultAt: string | null;
}

interface ProgressRow extends QueryResultRow {
  work_item_id: string; source_ehr_order_id: string; accepted_at: Date; collected_at: Date | null;
  test_count: number; released_count: number; released_at: Date | null;
}

/**
 * This facility's own work items for the given EHR lab requests of one
 * patient: $1 patient, $2 facility, $3 lab request ids. Work items on an
 * order route to another facility are left out (their progress is on the
 * route). Every Lab table is read under row-level security, which the
 * clinician passes with their own consent grant (lab.context_allows), never a
 * laboratory member's. A sample counts once taken (collected or received; not
 * one rejected, cancelled or entered in error). Exported for the tests.
 */
export const LAB_WORK_ITEM_PROGRESS_QUERY = `select w.id::text as work_item_id,
  w.source_ehr_order_id::text as source_ehr_order_id, w.accepted_at,
  c.collected_at, t.test_count, rl.released_count, rl.released_at
  from lab.work_items w
  cross join lateral (select min(s.collected_at) as collected_at from lab.accessions a
    join lab.specimens s on s.accession_id=a.id
    where a.work_item_id=w.id and s.status in ('collected','received') and s.collected_at is not null) c
  cross join lateral (select count(*)::int as test_count from lab.work_item_requested_tests rt
    where rt.work_item_id=w.id) t
  cross join lateral (select count(distinct e.requested_test_id)::int as released_count,
      max(rel.released_at) as released_at
    from lab.work_item_requested_tests rt
    join lab.test_executions e on e.requested_test_id=rt.id
    join lab.results r on r.execution_id=e.id
    join lab.result_releases rel on rel.result_id=r.id and rel.result_version=r.current_version
    where rt.work_item_id=w.id and not exists(select 1 from lab.result_invalidations i
      where i.result_id=r.id and i.result_version=r.current_version)) rl
  where w.patient_id=$1::uuid and w.facility_id=$2::uuid and w.order_route_id is null
    and w.source_ehr_order_id=any($3::uuid[])`;

/**
 * ORD-3: a read-only progress answer for ehr-api, which shows the clinician
 * whether this facility's laboratory received each lab request, took the
 * sample and released results. Identity first decides the clinician's read of
 * the patient (a refusal is 403 and is audited); then one audit row names the
 * patient, with the requests asked about and the work items found, in the
 * read's transaction (no answer without its audit row).
 */
@Injectable()
export class LabWorkItemProgressService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityService,
    private readonly audit: AuditService) {}

  async read(context: DataAccessContext, input: LabWorkItemProgressDto): Promise<{ items: LabProgressItem[] }> {
    const decision = await this.identity.authorize(input.patientId, 'read_records', context.purposeOfUse, context);
    if (!decision.allowed) {
      await this.database.withTransaction(context, (client) => this.audit.recordWithClient(client,
        this.event(context, input, 'denied', { requestedCount: input.sourceEhrOrderIds.length,
          reason: 'identity_authorization' })));
      throw new DomainProblem(403, 'LAB_WORK_ITEM_ACCESS_DENIED', 'Lab work-item access is not authorized');
    }
    return this.database.withTransaction(context, async (client) => {
      const rows = (await client.query<ProgressRow>(LAB_WORK_ITEM_PROGRESS_QUERY,
        [input.patientId, context.facilityId, input.sourceEhrOrderIds])).rows;
      await this.audit.recordWithClient(client, this.event(context, input, 'success', {
        requestedCount: input.sourceEhrOrderIds.length, foundCount: rows.length,
        workItemIds: rows.map((row) => row.work_item_id), breakGlass: decision.breakGlass }));
      const found = new Map(rows.map((row) => [row.source_ehr_order_id.toLowerCase(), row]));
      return { items: input.sourceEhrOrderIds.map((id) => project(id, found.get(id.toLowerCase()))) };
    });
  }

  private event(context: DataAccessContext, input: LabWorkItemProgressDto, outcome: 'success' | 'denied',
    details: Record<string, unknown>) {
    return { correlationId: context.correlationId, actorType: 'staff' as const, actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId,
      patientId: input.patientId, action: 'lab.work-item.progress.read', resourceType: 'lab-work-item-collection',
      resourceId: context.facilityId, outcome, purposeOfUse: context.purposeOfUse, details, sourceSystem: 'lab-api' };
  }
}

function project(id: string, row: ProgressRow | undefined): LabProgressItem {
  if (!row) return { sourceEhrOrderId: id, status: 'not_received', receivedAt: null, collectedAt: null,
    lastResultAt: null };
  const tests = Number(row.test_count);
  const released = Number(row.released_count);
  const status: LabProgressStatus = tests > 0 && released >= tests ? 'results_ready'
    : released > 0 ? 'some_results_ready' : row.collected_at ? 'sample_collected' : 'received';
  return { sourceEhrOrderId: id, status, receivedAt: iso(row.accepted_at), collectedAt: iso(row.collected_at),
    lastResultAt: released > 0 ? iso(row.released_at) : null };
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
