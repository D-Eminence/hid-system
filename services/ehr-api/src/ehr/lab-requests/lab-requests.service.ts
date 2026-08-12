import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { decodeTimelineCursor, requestDigest, timelinePage } from '../shared/clinical-context';
import { CreateLabRequestDto, OrderStatus, TimelineQueryDto, UpdateLabRequestDto } from '../shared/clinical.dto';
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
    const cursor = decodeTimelineCursor(query.cursor);
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.lab-request.list', resourceType: 'lab-request', resourceId: encounterId },
      async (client) => {
        const result = await client.query<LabRequestRow>(
          `select ${COLUMNS} from ehr.lab_requests
           where encounter_id = $1 and patient_id = $2 and facility_id = $3
             and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::uuid))
           order by created_at desc, id desc limit $6`,
          [encounterId, patientId, context.facilityId, cursor?.sortAt ?? null, cursor?.id ?? null, query.limit + 1],
        );
        const page = timelinePage(result.rows, query.limit, (row) => row.createdAt);
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
          const result = await client.query<LabRequestRow>(
            `insert into ehr.lab_requests (
               encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
               test_code_system, test_code, test_display, priority, status,
               specimen_type_code, clinical_information, external_order_reference
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             returning ${COLUMNS}`,
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
    const labWorkItem = row.status === OrderStatus.Active
      ? await this.accept(context, row)
      : null;
    return { ...row, labWorkItem };
  }

  private accept(context: DataAccessContext, row: LabRequestRow) {
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
      requestedAt: row.createdAt.toISOString(),
    }, `ehr-order:${row.id}:${row.rowVersion}`);
  }

  update(
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    requestId: string,
    input: UpdateLabRequestDto,
  ) {
    if (input.priority === undefined && input.status === undefined && input.clinicalInformation === undefined) {
      throw new DomainProblem(400, 'EMPTY_UPDATE', 'At least one clinical field must be supplied');
    }
    return this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.lab-request.update', resourceType: 'lab-request', resourceId: requestId },
      async (client) => {
        const current = await this.lock(client, context, patientId, encounterId, requestId);
        if (input.status && input.status !== current.status && !TRANSITIONS[current.status].includes(input.status)) {
          throw new DomainProblem(409, 'INVALID_LAB_REQUEST_TRANSITION', 'Lab request status transition is not allowed');
        }
        await this.repository.setChangeReason(client, input.changeReason);
        const result = await client.query<LabRequestRow>(
          `update ehr.lab_requests set
             priority = coalesce($1, priority), status = coalesce($2, status),
             clinical_information = coalesce($3, clinical_information)
           where id = $4 and encounter_id = $5 and patient_id = $6 and facility_id = $7 and row_version = $8
           returning ${COLUMNS}`,
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
  }

  private async find(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<LabRequestRow>(
      `select ${COLUMNS} from ehr.lab_requests
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4`,
      [id, encounterId, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async findById(client: PoolClient, context: DataAccessContext, patientId: string, id: string) {
    const result = await client.query<LabRequestRow>(
      `select ${COLUMNS} from ehr.lab_requests where id = $1 and patient_id = $2 and facility_id = $3`,
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

  private single(row: LabRequestRow | undefined): LabRequestRow {
    if (!row) throw new DomainProblem(404, 'LAB_REQUEST_NOT_FOUND', 'Lab request was not found');
    return row;
  }
}
