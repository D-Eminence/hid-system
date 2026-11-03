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
import { LabOrderRouteAccess, basisDetails } from './order-route-access';
import { LabOrderRouteCards, type OrderRouteCard, type WorkItemRoutePatient } from './order-route-cards';
import { LabOwnWorkPatientCards, OWN_WORK_PATIENT_CARDS_OFF } from './own-work-patient-cards';

interface WorkItemRow extends QueryResultRow {
  id: string; patient_id: string; facility_id: string; ordering_facility_id: string;
  source_ehr_order_id: string; source_ehr_order_version: string; source_encounter_id: string;
  status: 'accepted'; priority: AcceptEhrLabOrderCommand['priority']; accepted_by: string;
  accepted_at: Date; row_version: string; created_at: Date;
  /** Set when the work item came from another facility's order route (P4c). */
  order_route_id?: string | null;
}

const WORK_ITEM_SELECT = `select id::text,patient_id::text,facility_id::text,ordering_facility_id::text,
  source_ehr_order_id::text,source_ehr_order_version::text,source_encounter_id::text,status,priority,
  accepted_by::text,accepted_at,row_version::text,created_at,order_route_id::text from lab.work_items`;

const workItemDenied = () => new DomainProblem(403, 'LAB_WORK_ITEM_ACCESS_DENIED', 'Lab work-item access is not authorized');

/** Open work first, oldest first; then done work, newest first; the id breaks ties. */
const workOrder = (q: string) => `${q}.open_work desc,case when ${q}.open_work then ${q}.accepted_at end asc,`
  + `case when ${q}.open_work then null else ${q}.accepted_at end desc,case when ${q}.open_work then ${q}.id end asc,`
  + `case when ${q}.open_work then null else ${q}.id end desc`;

/** A work item's own columns, as `w` (both in the ordering and in the answer). */
const WORK_ITEM_COLUMNS = ['id', 'patient_id', 'facility_id', 'ordering_facility_id', 'source_ehr_order_id',
  'source_ehr_order_version', 'source_encounter_id', 'status', 'priority', 'accepted_by', 'accepted_at', 'row_version',
  'created_at', 'order_route_id', 'test_name'].map((column) => `w.${column}`).join(',');

/**
 * The work list (200 rows, as before). Open work comes first, oldest first,
 * so new and waiting work always shows however much is done; done work fills
 * the rest, newest first. Before, the oldest 200 rows the member could read
 * were answered whatever their state, so a busy facility stopped seeing new
 * work. $1 is the session's facility (DataAccessContext.facilityId). Exported
 * for the tests.
 *
 * A work item is open until every test it asks for has a result whose current
 * version is released and not marked entered in error (the same released truth
 * the patient and the chat read, PATIENT_LAB_QUERY); a work item without a
 * requested test is open. Every relation is read under the session's
 * row-level security, so a member sees only what the list itself may show.
 * An execution's requested test always belongs to its accession's work item
 * (lab.validate_execution_insert; requested tests, accessions and executions'
 * keys never change, and none is deleted), so a released result for a work
 * item's requested test is one on that work item's specimens.
 *
 * Cost. Every row read from a Lab table pays its own row-level security check
 * (the member's consent check, about 1.4-1.8 ms a row on a 2.1 GHz Xeon), so
 * the query reads each Lab table once: the facility's released results
 * (release, result at that version, execution) once, kept by requested test
 * (MATERIALIZED, so never re-read per work item); each work item and its
 * requested test once; the accession and specimens only for the 200 rows
 * answered. That is 5 checks per done work item, 2 per open one, plus 2 per
 * row answered (the oldest-200 query read 3 per work item, the first open-first
 * query 10). The facility test ($1, which row-level security already requires)
 * keeps every read within the facility, before any row's check. Known limit
 * (no schema change in this step, docs/INTERFACE_CONTRACT.md): past roughly
 * 2,000 work items at a laboratory the list exceeds lab-api's 15-second limit.
 * With OWN_WORK_PATIENT_CARD_ENABLED on, each list load also calls
 * lab.work_item_patient_cards (0113) once for its own rows, at most 200. That
 * is a statement of its own, so it does not count toward this query's
 * 15-second limit and does not grow with the laboratory. Under a NOBYPASSRLS
 * owner, as in production, each of those rows pays the work items' read
 * policy and then the same consent test again (0113's header, D5): 0.7-1.1 s
 * for 200 rows, against 0.8-1.2 s for this query (PostgreSQL 16, a shared
 * 4-CPU 2.8 GHz Xeon). So the setting roughly doubles the list's database time.
 */
export const WORK_LIST_QUERY = `with released_tests as materialized (
    select e.requested_test_id from lab.result_releases rel
    join lab.results r on r.id=rel.result_id and r.current_version=rel.result_version
    join lab.test_executions e on e.id=r.execution_id
    where rel.facility_id=$1::uuid and e.facility_id=$1::uuid
      and not exists(select 1 from lab.result_invalidations i where i.result_id=r.id and i.result_version=r.current_version)),
  shown as (
    select x.* from (
      select ${WORK_ITEM_COLUMNS},
        not bool_and(d.requested_test_id is not null) as open_work
      from lab.work_items w
      left join lab.work_item_requested_tests t on t.work_item_id=w.id
      left join released_tests d on d.requested_test_id=t.id
      where w.facility_id=$1::uuid
      group by w.id) x
    order by ${workOrder('x')} limit 200)
select w.id::text,w.patient_id::text,w.facility_id::text,w.ordering_facility_id::text,
  w.source_ehr_order_id::text,w.source_ehr_order_version::text,w.source_encounter_id::text,w.status,w.priority,
  w.accepted_by::text,w.accepted_at,w.row_version::text,w.created_at,w.order_route_id::text,w.test_name,a.id::text as accession_id,
  a.accession_number,array_remove(array_agg(s.status order by s.created_at),null) as specimen_statuses from shown w
  left join lab.accessions a on a.work_item_id=w.id left join lab.specimens s on s.accession_id=a.id
  group by ${WORK_ITEM_COLUMNS},w.open_work,a.id,a.accession_number
  order by ${workOrder('w')}`;

@Injectable()
export class LabWorkItemsService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityService,
    private readonly audit: AuditService, private readonly routeAccess: LabOrderRouteAccess,
    private readonly routeCards: LabOrderRouteCards,
    private readonly ownPatients: LabOwnWorkPatientCards = OWN_WORK_PATIENT_CARDS_OFF) {}

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
      // Only after DatabaseService's one retry of a unique violation.
      throw heldOrderConflict(error) ?? error;
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
      const held = Number(existing.source_ehr_order_version);
      // A version before the one Lab holds is stale: EHR has changed the order
      // since, and the version Lab holds may carry that change (two EHR
      // updates whose later call reached Lab first). It is not current.
      if (held > command.sourceEhrOrderVersion) {
        throw new DomainProblem(409, 'LAB_ORDER_NOT_CURRENT',
          `Lab already holds version ${held} of this EHR order, later than the version sent, which is not current`);
      }
      // A later version: EHR changed the order after Lab accepted it. Lab keeps
      // the earlier version it accepted (later changes are not propagated).
      if (held < command.sourceEhrOrderVersion) {
        throw new DomainProblem(409, 'LAB_ORDER_ALREADY_ACCEPTED',
          `Lab already holds version ${held} of this EHR order and accepts no other version`);
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
        context.actor.accountId,context.membershipId,key,digest,context.correlationId])
      .catch((error: unknown) => { throw workItemInsertRefusal(error) ?? error; });
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
      if (!row) return this.routeAccess.hiddenWorkItem(client, workItemId, 'read_records',
        () => new DomainProblem(404, 'LAB_WORK_ITEM_NOT_FOUND', 'Lab work item was not found'));
      const basis = await this.routeAccess.authorize(client, context, 'work_item', row.id, row.patient_id, 'read_records',
        workItemDenied);
      await this.audit.recordWithClient(client, this.auditEvent(context,row,'lab.work-item.read', basisDetails(basis)));
      const cards = row.order_route_id ? await this.routeCards.cards(client, [row.id], context.correlationId) : undefined;
      // Own work (0113, OWN_WORK_PATIENT_CARD_ENABLED): its patient, read after
      // the read row above, which already names the patient.
      const own = row.order_route_id ? undefined
        : await this.ownPatients.patients(client, [row.id], context.correlationId);
      return this.project(row, cards?.get(row.id), own?.get(row.id));
    });
  }

  /**
   * The work list. Row-level security shows this facility's rows the member
   * may read: under a consent grant, or bound to an order route that allows
   * a read now (P4c, strict policy). Open work comes first, oldest first, then
   * done work, newest first, 200 rows in all (WORK_LIST_QUERY); the answer's
   * shape is unchanged. A route-backed row carries its route
   * card and, while the route allows a read, its patient (C12). This
   * facility's own row carries its patient while OWN_WORK_PATIENT_CARD_ENABLED
   * is on and the member may read it (0113); off, it carries none. To a member
   * who may receive lab requests from other facilities, the answer says
   * whether this facility receives them now and whether any wait or are held
   * here (item 4, 0089; read in the transaction after the audit rows, left
   * out when it cannot be read), and that this backend serves the late
   * correction (`lateCorrection: true`, D17) and "We can't complete this
   * order" (`cannotComplete: true`, D18). The answer also says whether
   * orders between facilities and work on them are on, read after the
   * transaction (FEAS R4, V11).
   */
  async list(context: DataAccessContext) {
    if (!context.actor.permissions.includes('lab.work-item.read')) {
      throw new DomainProblem(403, 'LAB_WORK_ITEM_ACCESS_DENIED', 'Lab work-item read permission is required');
    }
    const page = await this.database.withTransaction(context, async (client) => {
      const result = await client.query<WorkItemRow & { test_name:string; accession_id:string|null; accession_number:string|null;
        specimen_statuses:string[]|null }>(WORK_LIST_QUERY, [context.facilityId]);
      const routed = result.rows.filter((row) => row.order_route_id).map((row) => row.id);
      const cards = await this.routeCards.cards(client, routed, context.correlationId);
      const own = await this.ownPatients.patients(client, result.rows.filter((row) => !row.order_route_id)
        .map((row) => row.id), context.correlationId);
      await this.auditShownPatients(client, context, result.rows, cards, own);
      const receiving = await this.routeCards.receiving(client, context);
      return { items: result.rows.map((row) => ({ ...this.project(row, cards.get(row.id), own.get(row.id)),testName:row.test_name,
        accessionId:row.accession_id,accessionNumber:row.accession_number,specimenStatuses:row.specimen_statuses ?? [] })),
      ...receiving, ...this.routeCards.lateCorrection(context), ...this.routeCards.cannotComplete(context) };
    });
    return { ...page, ...(await this.routeCards.flags()) };
  }

  /**
   * Who saw which patient on the work list (P4c): a route-backed row's card
   * shows the patient's name, sex, date of birth and Health ID ending, so one
   * row per patient shown, naming the patient, with the work items and routes
   * (ids only, §12) and basis 'order-route', in the list's transaction (no
   * answer without its audit). Rows without a patient on the card (the route
   * allows no read now, or C12 failed) name no one. Own work whose patient is
   * shown (0113) gets the same: one row per patient, with the work items (ids
   * only) and basis 'consent', which the patient's access log shows as a view;
   * none while OWN_WORK_PATIENT_CARD_ENABLED is off.
   */
  private async auditShownPatients(client: PoolClient, context: DataAccessContext, rows: readonly WorkItemRow[],
    cards: ReadonlyMap<string, OrderRouteCard>, own: ReadonlyMap<string, WorkItemRoutePatient>) {
    const shown = new Map<string, { first: WorkItemRow; workItemIds: string[]; orderRouteIds: string[] }>();
    for (const row of rows) {
      const card = cards.get(row.id);
      if (!row.order_route_id || !card?.patient) continue;
      const entry = shown.get(row.patient_id) ?? { first: row, workItemIds: [], orderRouteIds: [] };
      entry.workItemIds.push(row.id);
      entry.orderRouteIds.push(card.orderRoute.id);
      shown.set(row.patient_id, entry);
    }
    for (const entry of shown.values()) {
      await this.audit.recordWithClient(client, this.auditEvent(context, entry.first, 'lab.work-item.list',
        { basis: 'order-route', workItemIds: entry.workItemIds, orderRouteIds: entry.orderRouteIds }));
    }
    const ownShown = new Map<string, { first: WorkItemRow; workItemIds: string[] }>();
    for (const row of rows) {
      if (row.order_route_id || !own.has(row.id)) continue;
      const entry = ownShown.get(row.patient_id) ?? { first: row, workItemIds: [] };
      entry.workItemIds.push(row.id);
      ownShown.set(row.patient_id, entry);
    }
    for (const entry of ownShown.values()) {
      await this.audit.recordWithClient(client, this.auditEvent(context, entry.first, 'lab.work-item.list',
        { basis: 'consent', workItemIds: entry.workItemIds }));
    }
  }

  private async authorize(patientId: string, context: DataAccessContext, action: 'read_records' | 'write_records') {
    const decision = await this.identity.authorize(patientId, action, context.purposeOfUse, context);
    if (!decision.allowed || (action === 'write_records' && decision.breakGlass)) {
      throw new DomainProblem(403, 'LAB_WORK_ITEM_ACCESS_DENIED', 'Lab work-item access is not authorized');
    }
  }

  /**
   * A work item as Lab answers it. A route-backed one (P4c) never carries
   * the other facility's order id (PRIV P4.3); it carries its route card
   * instead, and its patient only while the route allows a read. This
   * facility's own one carries its patient when 0113's reader gave one
   * (OWN_WORK_PATIENT_CARD_ENABLED on, and the member may read it).
   */
  private project(row: WorkItemRow, card?: OrderRouteCard, ownPatient?: WorkItemRoutePatient): LabWorkItemResult {
    const base = { id: row.id,patientId: row.patient_id,facilityId: row.facility_id,
      sourceEhrOrderVersion: Number(row.source_ehr_order_version),
      status: row.status,priority: row.priority,acceptedAt: row.accepted_at,version: Number(row.row_version) };
    if (!row.order_route_id) {
      return { ...base, sourceEhrOrderId: row.source_ehr_order_id, ...(ownPatient ? { patient: ownPatient } : {}) };
    }
    return { ...base, ...(card ? { orderRoute: card.orderRoute, ...(card.patient ? { patient: card.patient } : {}) } : {}) };
  }

  private auditEvent(context: DataAccessContext,row: WorkItemRow,action: string,details?: Record<string,unknown>) {
    return { correlationId: context.correlationId,actorType: 'staff' as const,actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,facilityId: context.facilityId,
      patientId: row.patient_id,action,resourceType: 'lab-work-item',resourceId: row.id,
      outcome: 'success' as const,purposeOfUse: context.purposeOfUse,details,sourceSystem: 'lab-api' };
  }
}

/*
 * The database refusals of EHR-order acceptance that Lab answers with its own
 * problem (fix/ehr-lab-handoff-resend). Lab maps them here, for this command
 * only: every other Lab command answers a database error 500, which OCR stores
 * for its Lab import as the retryable OWNING_SERVICE_UNAVAILABLE. Each detail
 * is fixed; the error, whose message can name rows, values and constraints, is
 * the problem's cause, which is never sent (the problem filter logs its
 * SQLSTATE). Every other error is passed on unchanged and answers 500.
 */

/**
 * A refusal of the work-item insert, the statement that lab.validate_work_item
 * and row-level security check. A 23514 or 42501 of any other statement (the
 * child guards, a missing grant on a child table or the outbox) is a defect of
 * the command, not a verdict on the order, and stays 500.
 */
function workItemInsertRefusal(error: unknown): DomainProblem | undefined {
  switch (sqlState(error)) {
    // lab.validate_work_item (0077): not the EHR order's current active version
    // exactly as EHR holds it (a changed or no longer active order, another time
    // or field). Never retried. P4c (SPEC-FINAL §7.5): an order with a live
    // route to another facility's laboratory is refused with the message
    // LAB_REQUEST_ROUTED, answered by that code as the EHR answers it.
    case '23514':
      if ((error as { message?: unknown }).message === 'LAB_REQUEST_ROUTED') {
        return new DomainProblem(409, 'LAB_REQUEST_ROUTED',
          'This lab request has been sent to another laboratory; withdraw it there first', undefined, { cause: error });
      }
      return new DomainProblem(409, 'LAB_ORDER_NOT_CURRENT',
        'Lab accepts only the current version of an active EHR order, exactly as the EHR holds it', undefined,
        { cause: error });
    // Row-level security refuses the insert (lab.context_allows): the actor has
    // no database consent to write the patient's records at this facility. A
    // runtime role without INSERT on lab.work_items (a deployment fault) raises
    // the same SQLSTATE here and gets the same answer; the filter's log line
    // names the SQLSTATE and route.
    case '42501':
      return new DomainProblem(403, 'LAB_ACCESS_DENIED', 'Lab does not allow this actor to accept the EHR order',
        undefined, { cause: error });
    default:
      return undefined;
  }
}

/**
 * A unique violation of lab.work_items left after DatabaseService's one retry:
 * unique(source_ehr_order_id), or the idempotency key, which names the order
 * and version. Lab holds a work item for this EHR order that the replay read
 * cannot return (row-level security hides it from this actor), so it cannot
 * name the version it holds. A unique violation of any other table stays 500.
 */
function heldOrderConflict(error: unknown): DomainProblem | undefined {
  if (sqlState(error) !== '23505') return undefined;
  const { schema, table } = error as { schema?: unknown; table?: unknown };
  if (schema !== 'lab' || table !== 'work_items') return undefined;
  return new DomainProblem(409, 'LAB_ORDER_ALREADY_ACCEPTED', 'Lab already holds a work item for this EHR order',
    undefined, { cause: error });
}

function sqlState(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}
