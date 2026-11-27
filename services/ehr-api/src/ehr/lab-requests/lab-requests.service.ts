import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { decodeTimelineCursor, requestDigest, timelineCursorSql, timelinePage } from '../shared/clinical-context';
import type { LabAcceptEhrOrderInput } from '@hid/api-client';
import {
  type CreateLabRequestInput,
  OrderStatus,
  SendLabRequestToLabDto,
  UpdateLabRequestDto,
} from '../shared/clinical.dto';
import { ClinicalRepository, type AuditedPart, type OperationResult, type SemanticEvent } from '../shared/clinical.repository';
import { changeReasonRequired, hasTypedReason, neverReachedBefore, resolveChangeReason } from '../shared/change-reason';
import { requireVisitOpenForWork } from '../shared/visit-guard';
import { LabApiService } from '../../integrations/lab-api.service';
import { OrderRouteReader } from '../order-routes/order-route-reader';
import { routeInForce, withOrderRoute } from '../order-routes/order-route.mapping';
import type { CreateLabRequestGroupInput, LabRequestGroupTestInput, LabRequestListQueryDto } from './lab-request-groups.dto';
import {
  LAB_REQUEST_GROUP_OPERATION,
  LAB_REQUEST_GROUP_PART,
  LAB_REQUEST_GROUP_SEND_DEADLINE_MS,
  LAB_REQUEST_GROUPS_OFF,
  LabRequestGroups,
  labRequestGroupsUnavailable,
} from './lab-request-groups';

export interface LabRequestRow extends QueryResultRow {
  id: string;
  encounterId: string;
  patientId: string;
  facilityId: string;
  createdBy: string;
  createdByMembershipId: string;
  /** Both null for a test ordered by its name only (0156, LAB_REQUEST_NAME_ONLY_ENABLED). */
  testCodeSystem: string | null;
  testCode: string | null;
  testDisplay: string;
  priority: string;
  status: OrderStatus;
  specimenTypeCode: string | null;
  clinicalInformation: string | null;
  externalOrderReference: string | null;
  /**
   * ORD-6 (0158): the group the request was ordered in (one POST of several
   * tests), or null for a request ordered on its own. Set once, by ehr-api,
   * and never changed (0158's guard); answered whatever
   * LAB_REQUEST_GROUPS_ENABLED says.
   */
  requestGroupId: string | null;
  rowVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `
  id, encounter_id as "encounterId", patient_id as "patientId", facility_id as "facilityId",
  created_by as "createdBy", created_by_membership_id as "createdByMembershipId",
  test_code_system as "testCodeSystem", test_code as "testCode", test_display as "testDisplay",
  priority, status, specimen_type_code as "specimenTypeCode", clinical_information as "clinicalInformation",
  external_order_reference as "externalOrderReference", request_group_id as "requestGroupId",
  row_version as "rowVersion", created_at as "createdAt", updated_at as "updatedAt"`;

/**
 * created_at as microsecond UTC text. Lab accepts an order only when its
 * requested time equals the EHR row's created_at exactly, and node-postgres
 * returns created_at as a Date, which keeps only milliseconds.
 */
const EXACT_CREATED_AT = `${timelineCursorSql('created_at')} as "createdAtExact"`;

/** A row as created, replayed, updated or sent, carrying the exact created_at for Lab. */
export type CreatedLabRequestRow = LabRequestRow & { createdAtExact: string };

/**
 * What became of asking Lab to accept an active lab request, after the EHR
 * committed it. Lab holds one work item per request, at the version it
 * accepted; `already_accepted` means it holds an earlier version, so this
 * version's change is not in Lab (CLIN-3b: later EHR changes are not
 * propagated to Lab). A version earlier than the one Lab holds is `failed`
 * with Lab's `409 LAB_ORDER_NOT_CURRENT`.
 */
export type LabHandoff =
  | { state: 'accepted' }
  | { state: 'already_accepted'; code: 'LAB_ORDER_ALREADY_ACCEPTED' }
  // ORD-6: a group's send cut off by its deadline is 503 LAB_SERVICE_UNAVAILABLE (Lab
  // unreachable); one not tried before it, 503 LAB_HANDOFF_NOT_TRIED. "Send to lab" sends either.
  | { state: 'failed'; status: number; code: string }
  | { state: 'not_sent'; code: 'LAB_PERMISSION_ABSENT' }
  // P4c (SPEC-FINAL §7.5, V8): the request had a route to another facility in
  // force before this update, so it is never handed to this facility's Lab.
  | { state: 'not_sent'; code: 'ORDER_ROUTED' };

type HandoffOutcome = { handoff: LabHandoff; workItem: unknown };

/** A lab request as a create answers it: the row, and what became of sending it to Lab (null when not active). */
export type LabRequestCreated = LabRequestRow & { labWorkItem: unknown; labHandoff: LabHandoff | null };

/**
 * ORD-6: the tests of a group as createInTransaction saved (or replayed)
 * them, in the order given, and the audit rows they need.
 */
export interface LabRequestGroupSaved {
  /**
   * The group's id: one for every test, made here (randomUUID) while
   * LAB_REQUEST_GROUPS_ENABLED is on; null while it is off (option (b)). A
   * replay answers the group the tests were saved with.
   */
  requestGroupId: string | null;
  labRequests: CreatedLabRequestRow[];
  /**
   * One `ehr.lab-request.create` row per test, as the single create writes
   * it, and one `ehr.lab-request-group.create` row (the request ids, the
   * count and the status; no test names) only when a group was written.
   */
  parts: AuditedPart[];
}

/** ORD-6: the group route's answer. */
export interface LabRequestGroupCreated {
  requestGroupId: string;
  /** Each the single create's answer, in the order sent; a failed send shows only in its labHandoff. */
  labRequests: LabRequestCreated[];
}

/** The audit row of each test: the single create's own. */
const LAB_REQUEST_CREATE_EVENT: SemanticEvent = { action: 'ehr.lab-request.create', resourceType: 'lab-request' };

/** ORD-6's group audit row, naming the group; written only when a group is. */
const LAB_REQUEST_GROUP_EVENT: SemanticEvent = { action: 'ehr.lab-request-group.create', resourceType: 'lab-request-group' };

/**
 * A group's test as the single create takes it: the test's own fields, the
 * group's status and clinical information, and its priority unless the test
 * gives one. Only the fields given are set, so a test's digest is the same
 * however its body was written.
 */
function groupTest(group: CreateLabRequestGroupInput, test: LabRequestGroupTestInput): CreateLabRequestInput {
  return {
    ...(test.testCodeSystem === undefined ? {} : { testCodeSystem: test.testCodeSystem }),
    ...(test.testCode === undefined ? {} : { testCode: test.testCode }),
    testDisplay: test.testDisplay,
    priority: test.priority ?? group.priority,
    status: group.status,
    ...(test.specimenTypeCode === undefined ? {} : { specimenTypeCode: test.specimenTypeCode }),
    ...(group.clinicalInformation === undefined ? {} : { clinicalInformation: group.clinicalInformation }),
  };
}

const LAB_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** EHR-C8a: the only changes allowed on a visit entered in error: stopping the request. */
const STOPPING: readonly OrderStatus[] = [OrderStatus.OnHold, OrderStatus.Cancelled, OrderStatus.EnteredInError];

/**
 * Lab's verdicts on the request or on the caller: invalid (400), not allowed
 * (403), or in conflict with what Lab holds (409). Any other answer (401 when
 * Lab cannot verify the EHR's workload identity, another 4xx, 5xx, or Lab
 * unreachable) says nothing about the request, which can be sent again as it is.
 */
const LAB_REFUSALS: ReadonlySet<number> = new Set([400, 403, 409]);

/** Lab's code as the EHR reports it: a well-formed code, or a fixed one. */
const labCode = (problem: DomainProblem) => (LAB_CODE.test(problem.code) ? problem.code : 'LAB_SERVICE_ERROR');

const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.Draft]: [OrderStatus.Active, OrderStatus.Cancelled, OrderStatus.EnteredInError],
  [OrderStatus.Active]: [OrderStatus.OnHold, OrderStatus.Completed, OrderStatus.Cancelled, OrderStatus.EnteredInError],
  [OrderStatus.OnHold]: [OrderStatus.Active, OrderStatus.Cancelled, OrderStatus.EnteredInError],
  [OrderStatus.Completed]: [],
  [OrderStatus.Cancelled]: [],
  [OrderStatus.EnteredInError]: [],
};

@Injectable()
export class LabRequestsService {
  constructor(
    private readonly repository: ClinicalRepository,
    private readonly labApi: LabApiService,
    private readonly orderRoutes: OrderRouteReader,
    private readonly groups: LabRequestGroups = LAB_REQUEST_GROUPS_OFF,
  ) {}

  /**
   * One page of the encounter's lab requests. Each item carries its latest
   * route to another facility (`orderRoute`, null when none; left out when it
   * cannot be read) and the page whether orders between facilities are on
   * (`crossFacilityOrders`, a pool read after the clinical transaction).
   * `wrongPatientReports: true` says this backend lets the receiving
   * laboratory or pharmacy end an order it accepted for someone who was not
   * the patient (item 3, 0088): only then does the website ask a clinician to
   * have it ended there before changing the order. An earlier backend sends
   * no such field, and the website keeps its earlier warning (D15).
   * `lateCorrection: true` says it also lets the receiver withdraw, after the
   * order ended, what it sent back for the wrong person (D17, 0090): only then
   * does the website say until when it can, from each route's
   * `correctableUntil`.
   * ORD-6: `requestGroupId` keeps the page to that group's requests, within
   * the cursor's scope (a cursor binds the filter); it needs no index (the
   * page is one visit's). It works whatever LAB_REQUEST_GROUPS_ENABLED says.
   */
  async list(context: DataAccessContext, patientId: string, encounterId: string, query: LabRequestListQueryDto) {
    const scope = { list: 'ehr.lab-requests', patientId, encounterId,
      ...(query.requestGroupId === undefined ? {} : { filter: query.requestGroupId }) };
    const cursor = decodeTimelineCursor(query.cursor, scope);
    const page = await this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.lab-request.list', resourceType: 'lab-request', resourceId: encounterId },
      async (client) => {
        const result = await client.query<LabRequestRow & { cursorAt: string }>(
          `select ${COLUMNS}, ${timelineCursorSql('created_at')} as "cursorAt" from ehr.lab_requests
           where encounter_id = $1 and patient_id = $2 and facility_id = $3
             and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::uuid))
             and ($7::uuid is null or request_group_id = $7::uuid)
           order by created_at desc, id desc limit $6`,
          [encounterId, patientId, context.facilityId, cursor?.sortAt ?? null, cursor?.id ?? null, query.limit + 1,
            query.requestGroupId ?? null],
        );
        const page = timelinePage(result.rows, query.limit, scope);
        const routes = await this.orderRoutes.summaries(client, context, 'lab_request', patientId,
          page.items.map((item) => item.id));
        const items = page.items.map((item) => withOrderRoute(item, routes));
        return { value: { ...page, items }, details: { resultCount: page.items.length } };
      },
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
    return { ...page, crossFacilityOrders: await this.orderRoutes.crossFacilityOrdersEnabled(), wrongPatientReports: true,
      lateCorrection: true };
  }

  get(context: DataAccessContext, patientId: string, encounterId: string, requestId: string) {
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.lab-request.read', resourceType: 'lab-request', resourceId: requestId },
      async (client) => {
        const row = this.single(await this.find(client, context, patientId, encounterId, requestId));
        const routes = await this.orderRoutes.summaries(client, context, 'lab_request', patientId, [row.id]);
        return { value: withOrderRoute(row, routes) };
      },
      (client) => this.repository.exists(client, 'lab_requests', requestId, patientId, context.facilityId, encounterId),
    );
  }

  /**
   * A new lab request. While LAB_REQUEST_NAME_ONLY_ENABLED is on (0156) it may
   * leave out its test code pair (CreateLabRequestBodyPipe), and is saved,
   * answered and sent to Lab with both codes null. It is ordered on its own:
   * its requestGroupId is null (ORD-6), and a client's is refused (400
   * VALIDATION_FAILED, the body pipe's forbidNonWhitelisted).
   */
  async create(context: DataAccessContext, patientId: string, encounterId: string, input: CreateLabRequestInput,
    key: string) {
    const row = await this.repository.run(
      context, patientId, 'write_records', LAB_REQUEST_CREATE_EVENT,
      (client) => this.createOne(client, context, patientId, encounterId, input, key, 'lab-request.create', null),
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
    const { createdAtExact: _exact, ...created } = row;
    if (row.status !== OrderStatus.Active) return { ...created, labWorkItem: null, labHandoff: null };
    // The request is committed. A Lab refusal or silence is reported as the
    // handoff's, naming the saved request, so the client neither shows it as in
    // Lab nor creates it again; it can send it with POST .../lab-work-item.
    const { handoff, workItem } = await this.handoff(context, row);
    if (handoff.state === 'failed') throw this.handoffProblem(row.id, handoff);
    return { ...created, labWorkItem: workItem, labHandoff: handoff };
  }

  /**
   * ORD-6 (0158): several tests in one lab request, one POST (the group
   * route, its body already validated). While LAB_REQUEST_GROUPS_ENABLED is
   * off only a new group is refused (the clinical owner's addendum,
   * 7223408785): with no `lab-request-group.create` row for the caller's key
   * it answers 503 LAB_REQUEST_GROUPS_UNAVAILABLE before the consent check,
   * with nothing written and Lab not called; a same-key retry of a
   * stored group goes on and is answered as any replay is, so a retry never
   * leads a clinician to order twice. Each test becomes its own lab request,
   * linked by one requestGroupId that ehr-api makes, so every rule stays per
   * test. All are written in one transaction, every one or none, under one
   * consent check, and each is checked and audited as the single create
   * checks and audits it, plus one `ehr.lab-request-group.create` row.
   * One Idempotency-Key covers the group, as EHR-C5's does: a whole-call row
   * (`lab-request-group.create`), whose result names the group, not a table
   * row, so a replay re-runs the parts, and a part row per test
   * (`lab-request-group.test.<n>`), each of which replays. A replay answers
   * the requests as they are now, and the group they were saved with.
   * After the commit each active test is sent to Lab in order (sendGroup); a
   * group never fails because of Lab. On a same-key retry a test routed to
   * another facility since it was saved is `not_sent` ORDER_ROUTED, as PATCH
   * answers it (the routes are read in the transaction, as PATCH reads them),
   * whatever the setting says.
   */
  async createGroup(context: DataAccessContext, patientId: string, encounterId: string,
    input: CreateLabRequestGroupInput, key: string, receivedAt: number): Promise<LabRequestGroupCreated> {
    // Off: the setting stops new groups only. A key with a stored whole-call row replays (or is 409 for another
    // body, as when on); with none the call would make a group, so it is refused here.
    if (!this.groups.enabled && !await this.repository.idempotencyKeyStored(context, key, LAB_REQUEST_GROUP_OPERATION)) {
      throw labRequestGroupsUnavailable();
    }
    const digest = requestDigest(LAB_REQUEST_GROUP_OPERATION, { patientId, encounterId, input });
    const events = [...input.tests.map(() => LAB_REQUEST_CREATE_EVENT), LAB_REQUEST_GROUP_EVENT];
    const saved = await this.repository.runParts(context, patientId, 'write_records', events, async (client) => {
      const parts = () => this.createInTransaction(client, context, patientId, encounterId, input, key,
        LAB_REQUEST_GROUP_PART);
      const group = await this.repository.executeCreate(
        client, context, patientId, key, LAB_REQUEST_GROUP_OPERATION, digest, 'lab-request-group',
        async () => {
          const value = await parts();
          // Off, and the key's row was gone by the time it was written (a first call with the same key rolled
          // back): createInTransaction wrote a null group, so the whole transaction is refused and keeps nothing.
          if (value.requestGroupId === null) throw labRequestGroupsUnavailable();
          return { value, id: value.requestGroupId };
        },
        // The whole-call row names the group, not a row: each part answers its own saved request again.
        () => parts(),
      );
      // P4c (§7.5), as PATCH: a test of a replayed group with a route to another facility in force is not sent
      // here. A new group's tests have no route yet.
      const routes = group.details?.idempotentReplay === true
        ? await this.orderRoutes.summaries(client, context, 'lab_request', patientId,
          group.value.labRequests.map((row) => row.id))
        : undefined;
      const routed = new Set([...(routes?.entries() ?? [])].filter(([, summary]) => routeInForce(summary))
        .map(([id]) => id));
      return { value: { ...group.value, routed }, parts: group.value.parts };
    }, (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId));
    // Every group the route wrote has an id; a replay of one answers it.
    if (saved.requestGroupId === null) throw labRequestGroupsUnavailable();
    return { requestGroupId: saved.requestGroupId,
      labRequests: await this.sendGroup(context, saved.labRequests, receivedAt + LAB_REQUEST_GROUP_SEND_DEADLINE_MS,
        saved.routed) };
  }

  /**
   * ORD-6: the tests of a group inside a transaction the caller already holds
   * (the group route's, or ORD-8's order set, 0180), as
   * DiagnosesService.createInTransaction is for a diagnosis. Each test is
   * saved as the single create saves it, under the caller's Idempotency-Key
   * with the caller's part name (`partOperation(index)`, from 0): the group
   * route's `lab-request-group.test.<n>`, ORD-8's its own, so a key never
   * replays across routes. While LAB_REQUEST_GROUPS_ENABLED is on, the tests
   * of a new group get one requestGroupId (randomUUID); while it is off, a
   * null one (option (b)), so an order set's tests go as separate requests
   * and no group audit row is written. A replay answers what was stored.
   * The caller's whole-call digest must cover every test: a key whose part
   * rows replay some tests while others are new (an order set changed under
   * the same key) is 409 IDEMPOTENCY_KEY_REUSED, and the caller's transaction
   * keeps nothing, so a group is never split across two ids.
   * Nothing is sent to Lab here: the caller sends after its commit, with
   * sendGroup.
   */
  async createInTransaction(
    client: PoolClient,
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    input: CreateLabRequestGroupInput,
    key: string,
    partOperation: (index: number) => string,
  ): Promise<LabRequestGroupSaved> {
    const newGroupId = this.groups.enabled ? randomUUID() : null;
    const labRequests: CreatedLabRequestRow[] = [];
    const parts: AuditedPart[] = [];
    const replays: boolean[] = [];
    for (const [index, test] of input.tests.entries()) {
      const created = await this.createOne(client, context, patientId, encounterId, groupTest(input, test), key,
        partOperation(index), newGroupId);
      parts.push({ event: LAB_REQUEST_CREATE_EVENT, resourceId: created.resourceId, details: created.details });
      labRequests.push(created.value);
      replays.push(created.details?.idempotentReplay === true);
    }
    const replayed = replays.every(Boolean);
    if (!replayed && replays.some(Boolean)) {
      throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
    }
    // A replay answers the group the tests were saved with (all in one transaction, so all alike).
    const requestGroupId = labRequests[0]?.requestGroupId ?? null;
    if (requestGroupId !== null) {
      parts.push({ event: LAB_REQUEST_GROUP_EVENT, resourceId: requestGroupId, details: {
        labRequestIds: labRequests.map((row) => row.id), count: labRequests.length, status: input.status,
        idempotentReplay: replayed } });
    }
    return { requestGroupId, labRequests, parts };
  }

  /**
   * One lab request, in the caller's transaction, under the caller's key and
   * operation: the single create (`lab-request.create`, no group) and each
   * test of a group. `requestGroupId` is ehr-api's own, never a client's.
   */
  private createOne(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string,
    input: CreateLabRequestInput, key: string, operation: string, requestGroupId: string | null,
  ): Promise<OperationResult<CreatedLabRequestRow>> {
    const digest = requestDigest(operation, { patientId, encounterId, input });
    return this.repository.executeCreate(
      client, context, patientId, key, operation, digest, 'lab-request',
      async () => {
        // EHR-C8a: nothing new on a visit entered in error (409 VISIT_ENTERED_IN_ERROR).
        await requireVisitOpenForWork(client, patientId, context.facilityId, encounterId);
        const result = await client.query<CreatedLabRequestRow>(
          `insert into ehr.lab_requests (
             encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
             test_code_system, test_code, test_display, priority, status,
             specimen_type_code, clinical_information, external_order_reference, request_group_id
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           returning ${COLUMNS}, ${EXACT_CREATED_AT}`,
          [
            encounterId, patientId, context.facilityId, context.actor.accountId, context.membershipId,
            input.testCodeSystem ?? null, input.testCode ?? null, input.testDisplay, input.priority, input.status,
            input.specimenTypeCode ?? null, input.clinicalInformation ?? null,
            input.externalOrderReference ?? null, requestGroupId,
          ],
        );
        const row = this.single(result.rows[0]);
        return { value: row, id: row.id };
      },
      (id) => this.findById(client, context, patientId, id),
    );
  }

  /**
   * ORD-6: after the group's commit, each active test is sent to Lab in
   * order, one at a time (Rahman's answer 5: Lab's pool is small and each
   * acceptance is SERIALIZABLE), with today's handoff, so each labHandoff
   * says what happened and the group never fails because of Lab. Lab copies
   * the group from the EHR row (0158's validator); nothing sends it. Each
   * send gets the time left before `deadline` (25 s after the request
   * reached ehr-api): a send cut off is `failed` 503
   * LAB_SERVICE_UNAVAILABLE, and one not tried before it `failed` 503
   * LAB_HANDOFF_NOT_TRIED; "Send to lab" (POST .../lab-work-item) sends
   * either safely. A same-key retry sends every active test again, and Lab
   * replays the ones it holds; a test in `routed` (a route to another
   * facility in force, read in the caller's transaction) is `not_sent`
   * ORDER_ROUTED, as PATCH answers it. Without lab.work-item.accept a test is
   * `not_sent` LAB_PERMISSION_ABSENT, as an activation is (defensive: every
   * seeded role with ehr.lab-request.write has it). Public for ORD-8 (0180),
   * which sends the tests createInTransaction saved after its own commit.
   */
  async sendGroup(context: DataAccessContext, rows: readonly CreatedLabRequestRow[], deadline: number,
    routed: ReadonlySet<string> = new Set()): Promise<LabRequestCreated[]> {
    const answers: LabRequestCreated[] = [];
    for (const row of rows) {
      const { createdAtExact: _exact, ...created } = row;
      if (row.status !== OrderStatus.Active) {
        answers.push({ ...created, labWorkItem: null, labHandoff: null });
        continue;
      }
      if (routed.has(row.id)) {
        answers.push({ ...created, labWorkItem: null, labHandoff: { state: 'not_sent', code: 'ORDER_ROUTED' } });
        continue;
      }
      if (!context.actor.permissions.includes('lab.work-item.accept')) {
        answers.push({ ...created, labWorkItem: null, labHandoff: { state: 'not_sent', code: 'LAB_PERMISSION_ABSENT' } });
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        answers.push({ ...created, labWorkItem: null,
          labHandoff: { state: 'failed', status: 503, code: 'LAB_HANDOFF_NOT_TRIED' } });
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), left);
      try {
        const { handoff, workItem } = await this.handoff(context, row, controller.signal);
        answers.push({ ...created, labWorkItem: workItem, labHandoff: handoff });
      } finally {
        clearTimeout(timer);
      }
    }
    return answers;
  }

  /**
   * Sends (or sends again) an active lab request to Lab at the version the
   * client read: the counterpart of a prescription's pharmacy-work-item
   * command. The EHR transaction reads the request without a lock and writes
   * only its audit event; Lab is called after it commits. Lab's work item (a
   * replay for a version it already accepted) and Lab's refusal of the request
   * (LAB_REFUSALS) are returned as they are, since the EHR changed nothing. Any
   * other Lab answer is 502 LAB_HANDOFF_UNCONFIRMED: Lab's 401 must never reach
   * the browser, which would take it for its own expired session and sign the
   * clinician out.
   */
  async sendToLab(
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    requestId: string,
    input: SendLabRequestToLabDto,
  ) {
    const row = await this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.lab-request.lab-handoff.eligibility-checked', resourceType: 'lab-request', resourceId: requestId,
        details: { expectedRowVersion: input.expectedRowVersion } },
      async (client) => {
        // EHR-C8a: never sent to the laboratory from a visit entered in error
        // (a read, no lock: this path writes nothing in the EHR).
        await requireVisitOpenForWork(client, patientId, context.facilityId, encounterId, { lock: false });
        const current = this.single(await this.findExact(client, context, patientId, encounterId, requestId));
        if (Number(current.rowVersion) !== input.expectedRowVersion) {
          throw new DomainProblem(412, 'LAB_REQUEST_VERSION_CONFLICT',
            'Lab acceptance must bind to the current exact lab request version');
        }
        if (current.status !== OrderStatus.Active) {
          throw new DomainProblem(409, 'LAB_REQUEST_NOT_ELIGIBLE', 'Only an active lab request can be sent to Lab');
        }
        // P4c (§7.5): a request with a route to another facility in force is
        // not handed to this facility's Lab; Lab's validator refuses it too.
        if (routeInForce(await this.orderRoutes.summary(client, context, 'lab_request', patientId, requestId))) {
          throw new DomainProblem(409, 'LAB_REQUEST_ROUTED',
            'This lab request has been sent to another laboratory; withdraw it there first');
        }
        return { value: current, resourceId: requestId, details: { labRequestVersion: Number(current.rowVersion) } };
      },
      (client) => this.repository.exists(client, 'lab_requests', requestId, patientId, context.facilityId, encounterId),
    );
    try {
      return await this.accept(context, row);
    } catch (error) {
      if (error instanceof DomainProblem && !LAB_REFUSALS.has(error.getStatus())) {
        throw this.handoffProblem(row.id, { state: 'failed', status: error.getStatus(), code: labCode(error) });
      }
      throw error;
    }
  }

  /**
   * Asks Lab to accept the committed active request and reports the outcome.
   * Every Lab answer, and Lab being unreachable, arrives as a DomainProblem
   * (LabApiService); anything else is a defect and is thrown.
   */
  private async handoff(context: DataAccessContext, row: CreatedLabRequestRow, signal?: AbortSignal):
  Promise<HandoffOutcome> {
    try {
      return { handoff: { state: 'accepted' }, workItem: await this.accept(context, row, signal) };
    } catch (error) {
      if (!(error instanceof DomainProblem)) throw error;
      const status = error.getStatus();
      const code = labCode(error);
      if (status === 409 && code === 'LAB_ORDER_ALREADY_ACCEPTED') {
        return { handoff: { state: 'already_accepted', code }, workItem: null };
      }
      return { handoff: { state: 'failed', status, code }, workItem: null };
    }
  }

  /**
   * The problem a create (or a send) answers when Lab did not accept the saved
   * request: 409 when Lab refused it, else 502, never Lab's own status.
   */
  private handoffProblem(requestId: string, failure: Extract<LabHandoff, { state: 'failed' }>) {
    return LAB_REFUSALS.has(failure.status)
      ? new DomainProblem(409, 'LAB_HANDOFF_REFUSED',
        `Lab request ${requestId} is saved and active in the EHR, but Lab refused it (${failure.code}); `
        + 'send it to Lab again once that is resolved')
      : new DomainProblem(502, 'LAB_HANDOFF_UNCONFIRMED',
        `Lab request ${requestId} is saved and active in the EHR, but Lab did not confirm it (${failure.code}); `
        + 'send it to Lab again');
  }

  /**
   * A request by name only is sent with both codes null (0156); a Lab image
   * before 0156 refuses that (400), which is answered as LAB_HANDOFF_REFUSED.
   * No group is sent (ORD-6): Lab's validator copies it from the EHR row
   * (0158), so a test activated or resumed on its own keeps its group in Lab.
   */
  private accept(context: DataAccessContext, row: CreatedLabRequestRow, signal?: AbortSignal) {
    const order: LabAcceptEhrOrderInput = {
      sourceEhrOrderId: row.id,
      sourceEhrOrderVersion: Number(row.rowVersion),
      sourceEncounterId: row.encounterId,
      patientId: row.patientId,
      orderingFacilityId: row.facilityId,
      testCodeSystem: row.testCodeSystem,
      testCode: row.testCode,
      testName: row.testDisplay,
      priority: row.priority as 'routine' | 'urgent' | 'asap' | 'stat',
      clinicalIndication: row.clinicalInformation ?? undefined,
      requestedBy: row.createdBy,
      requestedAt: row.createdAtExact,
    };
    return this.labApi.acceptEhrOrder(context, order, `ehr-order:${row.id}:${row.rowVersion}`, signal);
  }

  /**
   * Updates the request, then, if it is active, sends that version to Lab:
   * activating a draft or resuming a held request sends it, and an edit of an
   * active request that Lab holds at an earlier version is reported as
   * `already_accepted`. The update is committed whatever Lab answers, so a Lab
   * failure is reported in `labHandoff`, not as an error.
   */
  async update(
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    requestId: string,
    input: UpdateLabRequestDto,
  ) {
    if (input.priority === undefined && input.status === undefined && input.clinicalInformation === undefined) {
      throw new DomainProblem(400, 'EMPTY_UPDATE', 'At least one clinical field must be supplied');
    }
    // Q105: a draft that was never active may be activated (its first
    // activation, which sends it to Lab) or edited, or both, with no typed
    // reason; the fixed one is recorded. Any other change without a typed
    // reason (hold, resume, complete, cancel, entered in error) answers 400
    // before the request reaches the database; whether the request is a
    // draft that was never active is checked under its row lock, against the
    // version history, failing closed.
    const typed = hasTypedReason(input.changeReason);
    if (!typed && input.status !== undefined && input.status !== OrderStatus.Draft && input.status !== OrderStatus.Active) {
      throw changeReasonRequired();
    }
    const { row, routedBefore, orderRoute } = await this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.lab-request.update', resourceType: 'lab-request', resourceId: requestId },
      async (client) => {
        // EHR-C8a: on a visit entered in error a lab request can only be put
        // on hold, cancelled or entered in error; anything else (activate,
        // resume, complete, edit) is 409 VISIT_ENTERED_IN_ERROR. The visit is
        // locked before the request, as in every order path.
        if (!STOPPING.includes(input.status as OrderStatus)) {
          await requireVisitOpenForWork(client, patientId, context.facilityId, encounterId);
        }
        const current = await this.lock(client, context, patientId, encounterId, requestId);
        if (input.status && input.status !== current.status && !TRANSITIONS[current.status].includes(input.status)) {
          throw new DomainProblem(409, 'INVALID_LAB_REQUEST_TRANSITION', 'Lab request status transition is not allowed');
        }
        // Read under the row lock, which C1 takes first, so no route can be
        // sent between this read and the update (SPEC-FINAL §8.9).
        const before = await this.orderRoutes.summary(client, context, 'lab_request', patientId, requestId);
        const free = !typed && current.status === OrderStatus.Draft
          && await neverReachedBefore(client, 'lab_requests', requestId,
            [OrderStatus.Active, OrderStatus.OnHold, OrderStatus.Completed]);
        const { reason, details: reasonDetails } = resolveChangeReason(input.changeReason,
          free ? (input.status === OrderStatus.Active ? 'first_activation' : 'draft_edit') : undefined);
        await this.repository.setChangeReason(client, reason);
        const result = await client.query<CreatedLabRequestRow>(
          `update ehr.lab_requests set
             priority = coalesce($1, priority), status = coalesce($2, status),
             clinical_information = coalesce($3, clinical_information)
           where id = $4 and encounter_id = $5 and patient_id = $6 and facility_id = $7 and row_version = $8
           returning ${COLUMNS}, ${EXACT_CREATED_AT}`,
          [
            input.priority ?? null, input.status ?? null, input.clinicalInformation ?? null,
            requestId, encounterId, patientId, context.facilityId, input.expectedRowVersion,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new DomainProblem(412, 'VERSION_CONFLICT', 'Lab request changed since it was loaded');
        // The route as the order-change trigger left it (§7.2): withdrawn,
        // cancelled or unchanged.
        const after = before ? await this.orderRoutes.summary(client, context, 'lab_request', patientId, requestId)
          : before;
        return { value: { row, routedBefore: routeInForce(before), orderRoute: after },
          resourceId: requestId, details: { rowVersion: row.rowVersion, ...reasonDetails } };
      },
      (client) => this.repository.exists(client, 'lab_requests', requestId, patientId, context.facilityId, encounterId),
    );
    const { createdAtExact: _exact, ...fields } = row;
    const updated = orderRoute === undefined ? fields : { ...fields, orderRoute };
    if (row.status !== OrderStatus.Active) return { ...updated, labWorkItem: null, labHandoff: null };
    if (routedBefore) {
      const routed: LabHandoff = { state: 'not_sent', code: 'ORDER_ROUTED' };
      return { ...updated, labWorkItem: null, labHandoff: routed };
    }
    if (!context.actor.permissions.includes('lab.work-item.accept')) {
      const notSent: LabHandoff = { state: 'not_sent', code: 'LAB_PERMISSION_ABSENT' };
      return { ...updated, labWorkItem: null, labHandoff: notSent };
    }
    const { handoff, workItem } = await this.handoff(context, row);
    return { ...updated, labWorkItem: workItem, labHandoff: handoff };
  }

  private async find(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<LabRequestRow>(
      `select ${COLUMNS} from ehr.lab_requests
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4`,
      [id, encounterId, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async findExact(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<CreatedLabRequestRow>(
      `select ${COLUMNS}, ${EXACT_CREATED_AT} from ehr.lab_requests
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4`,
      [id, encounterId, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async findById(client: PoolClient, context: DataAccessContext, patientId: string, id: string) {
    const result = await client.query<CreatedLabRequestRow>(
      `select ${COLUMNS}, ${EXACT_CREATED_AT} from ehr.lab_requests where id = $1 and patient_id = $2 and facility_id = $3`,
      [id, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  /**
   * The request's row lock: FOR NO KEY UPDATE (P4c, FEAS K1). Lab's work-item
   * insert at another facility takes FOR KEY SHARE on this row through its
   * foreign key; FOR UPDATE would wait for it, and with the route lock taken
   * in the other order the two would deadlock.
   */
  private async lock(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<LabRequestRow>(
      `select ${COLUMNS} from ehr.lab_requests
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4 for no key update`,
      [id, encounterId, patientId, context.facilityId],
    );
    return this.single(result.rows[0]);
  }

  private single<Row extends LabRequestRow>(row: Row | undefined): Row {
    if (!row) throw new DomainProblem(404, 'LAB_REQUEST_NOT_FOUND', 'Lab request was not found');
    return row;
  }
}
