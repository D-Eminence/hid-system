import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { decodeTimelineCursor, requestDigest, timelineCursorSql, timelinePage } from '../shared/clinical-context';
import {
  CreateLabRequestDto,
  OrderStatus,
  SendLabRequestToLabDto,
  TimelineQueryDto,
  UpdateLabRequestDto,
} from '../shared/clinical.dto';
import { ClinicalRepository } from '../shared/clinical.repository';
import { LabApiService } from '../../integrations/lab-api.service';

export interface LabRequestRow extends QueryResultRow {
  id: string;
  encounterId: string;
  patientId: string;
  facilityId: string;
  createdBy: string;
  createdByMembershipId: string;
  testCodeSystem: string;
  testCode: string;
  testDisplay: string;
  priority: string;
  status: OrderStatus;
  specimenTypeCode: string | null;
  clinicalInformation: string | null;
  externalOrderReference: string | null;
  rowVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `
  id, encounter_id as "encounterId", patient_id as "patientId", facility_id as "facilityId",
  created_by as "createdBy", created_by_membership_id as "createdByMembershipId",
  test_code_system as "testCodeSystem", test_code as "testCode", test_display as "testDisplay",
  priority, status, specimen_type_code as "specimenTypeCode", clinical_information as "clinicalInformation",
  external_order_reference as "externalOrderReference", row_version as "rowVersion",
  created_at as "createdAt", updated_at as "updatedAt"`;

/**
 * created_at as microsecond UTC text. Lab accepts an order only when its
 * requested time equals the EHR row's created_at exactly, and node-postgres
 * returns created_at as a Date, which keeps only milliseconds.
 */
const EXACT_CREATED_AT = `${timelineCursorSql('created_at')} as "createdAtExact"`;

/** A row as created, replayed, updated or sent, carrying the exact created_at for Lab. */
type CreatedLabRequestRow = LabRequestRow & { createdAtExact: string };

/**
 * What became of asking Lab to accept an active lab request, after the EHR
 * committed it. Lab holds one work item per request, at the version it
 * accepted; `already_accepted` means it holds another version (CLIN-3b: later
 * EHR changes are not propagated to Lab).
 */
export type LabHandoff =
  | { state: 'accepted' }
  | { state: 'already_accepted'; code: 'LAB_ORDER_ALREADY_ACCEPTED' }
  | { state: 'failed'; status: number; code: string }
  | { state: 'not_sent'; code: 'LAB_PERMISSION_ABSENT' };

type HandoffOutcome = { handoff: LabHandoff; workItem: unknown };

const LAB_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

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
  ) {}

  list(context: DataAccessContext, patientId: string, encounterId: string, query: TimelineQueryDto) {
    const scope = { list: 'ehr.lab-requests', patientId, encounterId };
    const cursor = decodeTimelineCursor(query.cursor, scope);
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.lab-request.list', resourceType: 'lab-request', resourceId: encounterId },
      async (client) => {
        const result = await client.query<LabRequestRow & { cursorAt: string }>(
          `select ${COLUMNS}, ${timelineCursorSql('created_at')} as "cursorAt" from ehr.lab_requests
           where encounter_id = $1 and patient_id = $2 and facility_id = $3
             and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::uuid))
           order by created_at desc, id desc limit $6`,
          [encounterId, patientId, context.facilityId, cursor?.sortAt ?? null, cursor?.id ?? null, query.limit + 1],
        );
        const page = timelinePage(result.rows, query.limit, scope);
        return { value: page, details: { resultCount: page.items.length } };
      },
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
  }

  get(context: DataAccessContext, patientId: string, encounterId: string, requestId: string) {
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.lab-request.read', resourceType: 'lab-request', resourceId: requestId },
      async (client) => ({ value: this.single(await this.find(client, context, patientId, encounterId, requestId)) }),
      (client) => this.repository.exists(client, 'lab_requests', requestId, patientId, context.facilityId, encounterId),
    );
  }

  async create(context: DataAccessContext, patientId: string, encounterId: string, input: CreateLabRequestDto, key: string) {
    const operation = 'lab-request.create';
    const digest = requestDigest(operation, { patientId, encounterId, input });
    const row = await this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.lab-request.create', resourceType: 'lab-request' },
      (client) => this.repository.executeCreate(
        client, context, patientId, key, operation, digest, 'lab-request',
        async () => {
          const result = await client.query<CreatedLabRequestRow>(
            `insert into ehr.lab_requests (
               encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
               test_code_system, test_code, test_display, priority, status,
               specimen_type_code, clinical_information, external_order_reference
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             returning ${COLUMNS}, ${EXACT_CREATED_AT}`,
            [
              encounterId, patientId, context.facilityId, context.actor.accountId, context.membershipId,
              input.testCodeSystem, input.testCode, input.testDisplay, input.priority, input.status,
              input.specimenTypeCode ?? null, input.clinicalInformation ?? null,
              input.externalOrderReference ?? null,
            ],
          );
          const row = this.single(result.rows[0]);
          return { value: row, id: row.id };
        },
        (id) => this.findById(client, context, patientId, id),
      ),
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
   * Sends (or sends again) an active lab request to Lab at the version the
   * client read: the counterpart of a prescription's pharmacy-work-item
   * command. The EHR transaction reads the request without a lock and writes
   * only its audit event; Lab is called after it commits. Lab's
   * answer is returned as it is: its work item (a replay for a version it
   * already accepted), or its problem, since the EHR changed nothing.
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
        const current = this.single(await this.findExact(client, context, patientId, encounterId, requestId));
        if (Number(current.rowVersion) !== input.expectedRowVersion) {
          throw new DomainProblem(412, 'LAB_REQUEST_VERSION_CONFLICT',
            'Lab acceptance must bind to the current exact lab request version');
        }
        if (current.status !== OrderStatus.Active) {
          throw new DomainProblem(409, 'LAB_REQUEST_NOT_ELIGIBLE', 'Only an active lab request can be sent to Lab');
        }
        return { value: current, resourceId: requestId, details: { labRequestVersion: Number(current.rowVersion) } };
      },
      (client) => this.repository.exists(client, 'lab_requests', requestId, patientId, context.facilityId, encounterId),
    );
    return this.accept(context, row);
  }

  /**
   * Asks Lab to accept the committed active request and reports the outcome.
   * Every Lab answer, and Lab being unreachable, arrives as a DomainProblem
   * (LabApiService); anything else is a defect and is thrown.
   */
  private async handoff(context: DataAccessContext, row: CreatedLabRequestRow): Promise<HandoffOutcome> {
    try {
      return { handoff: { state: 'accepted' }, workItem: await this.accept(context, row) };
    } catch (error) {
      if (!(error instanceof DomainProblem)) throw error;
      const status = error.getStatus();
      const code = LAB_CODE.test(error.code) ? error.code : 'LAB_SERVICE_ERROR';
      if (status === 409 && code === 'LAB_ORDER_ALREADY_ACCEPTED') {
        return { handoff: { state: 'already_accepted', code }, workItem: null };
      }
      return { handoff: { state: 'failed', status, code }, workItem: null };
    }
  }

  /** The problem a create answers when Lab did not accept the request it committed. */
  private handoffProblem(requestId: string, failure: Extract<LabHandoff, { state: 'failed' }>) {
    return failure.status < 500
      ? new DomainProblem(409, 'LAB_HANDOFF_REFUSED',
        `Lab request ${requestId} is saved and active in the EHR, but Lab refused it (${failure.code}); `
        + 'send it to Lab again once that is resolved')
      : new DomainProblem(502, 'LAB_HANDOFF_UNCONFIRMED',
        `Lab request ${requestId} is saved and active in the EHR, but Lab did not confirm it (${failure.code}); `
        + 'send it to Lab again');
  }

  private accept(context: DataAccessContext, row: CreatedLabRequestRow) {
    return this.labApi.acceptEhrOrder(context, {
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
    }, `ehr-order:${row.id}:${row.rowVersion}`);
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
    const row = await this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.lab-request.update', resourceType: 'lab-request', resourceId: requestId },
      async (client) => {
        const current = await this.lock(client, context, patientId, encounterId, requestId);
        if (input.status && input.status !== current.status && !TRANSITIONS[current.status].includes(input.status)) {
          throw new DomainProblem(409, 'INVALID_LAB_REQUEST_TRANSITION', 'Lab request status transition is not allowed');
        }
        await this.repository.setChangeReason(client, input.changeReason);
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
        return { value: row, resourceId: requestId, details: { rowVersion: row.rowVersion } };
      },
      (client) => this.repository.exists(client, 'lab_requests', requestId, patientId, context.facilityId, encounterId),
    );
    const { createdAtExact: _exact, ...updated } = row;
    if (row.status !== OrderStatus.Active) return { ...updated, labWorkItem: null, labHandoff: null };
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

  private async lock(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<LabRequestRow>(
      `select ${COLUMNS} from ehr.lab_requests
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4 for update`,
      [id, encounterId, patientId, context.facilityId],
    );
    return this.single(result.rows[0]);
  }

  private single<Row extends LabRequestRow>(row: Row | undefined): Row {
    if (!row) throw new DomainProblem(404, 'LAB_REQUEST_NOT_FOUND', 'Lab request was not found');
    return row;
  }
}
