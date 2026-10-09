import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import {
  CreateEncounterDto,
  EncounterStatus,
  TimelineQueryDto,
  UpdateEncounterDto,
} from '../shared/clinical.dto';
import { decodeTimelineCursor, requestDigest, timelinePage } from '../shared/clinical-context';
import { ClinicalRepository } from '../shared/clinical.repository';

export interface EncounterRow extends QueryResultRow {
  id: string;
  patientId: string;
  facilityId: string;
  createdBy: string;
  createdByMembershipId: string;
  encounterNumber: string | null;
  encounterType: string;
  status: EncounterStatus;
  startedAt: Date;
  endedAt: Date | null;
  chiefComplaint: string | null;
  rowVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

const ENCOUNTER_COLUMNS = `
  id, patient_id as "patientId", facility_id as "facilityId",
  created_by as "createdBy", created_by_membership_id as "createdByMembershipId",
  encounter_number as "encounterNumber", encounter_type as "encounterType", status,
  started_at as "startedAt", ended_at as "endedAt", chief_complaint as "chiefComplaint",
  row_version as "rowVersion", created_at as "createdAt", updated_at as "updatedAt"`;

const TRANSITIONS: Readonly<Record<EncounterStatus, readonly EncounterStatus[]>> = {
  [EncounterStatus.Planned]: [EncounterStatus.InProgress, EncounterStatus.Cancelled, EncounterStatus.EnteredInError],
  [EncounterStatus.InProgress]: [EncounterStatus.OnHold, EncounterStatus.Completed, EncounterStatus.Cancelled, EncounterStatus.EnteredInError],
  [EncounterStatus.OnHold]: [EncounterStatus.InProgress, EncounterStatus.Cancelled, EncounterStatus.EnteredInError],
  [EncounterStatus.Completed]: [],
  [EncounterStatus.Cancelled]: [],
  [EncounterStatus.EnteredInError]: [],
};

@Injectable()
export class EncountersService {
  constructor(private readonly repository: ClinicalRepository) {}

  list(context: DataAccessContext, patientId: string, query: TimelineQueryDto) {
    const cursor = decodeTimelineCursor(query.cursor);
    return this.repository.run(
      context,
      patientId,
      'read_records',
      { action: 'ehr.encounter.list', resourceType: 'encounter' },
      async (client) => {
        const result = await client.query<EncounterRow>(
          `select ${ENCOUNTER_COLUMNS}
           from ehr.encounters
           where patient_id = $1 and facility_id = $2
             and ($3::timestamptz is null or (started_at, id) < ($3::timestamptz, $4::uuid))
           order by started_at desc, id desc limit $5`,
          [patientId, context.facilityId, cursor?.sortAt ?? null, cursor?.id ?? null, query.limit + 1],
        );
        const page = timelinePage(result.rows, query.limit, (row) => row.startedAt);
        return { value: page, details: { resultCount: page.items.length } };
      },
    );
  }

  get(context: DataAccessContext, patientId: string, encounterId: string): Promise<EncounterRow> {
    return this.repository.run(
      context,
      patientId,
      'read_records',
      { action: 'ehr.encounter.read', resourceType: 'encounter', resourceId: encounterId },
      async (client) => ({ value: await this.requireRow(client, patientId, context.facilityId, encounterId) }),
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
  }

  create(
    context: DataAccessContext,
    patientId: string,
    input: CreateEncounterDto,
    idempotencyKey: string,
  ): Promise<EncounterRow> {
    const operation = 'encounter.create';
    const digest = requestDigest(operation, { patientId, input });
    return this.repository.run(
      context,
      patientId,
      'write_records',
      { action: 'ehr.encounter.create', resourceType: 'encounter' },
      (client) => this.repository.executeCreate(
        client,
        context,
        patientId,
        idempotencyKey,
        operation,
        digest,
        'encounter',
        async () => {
          const result = await client.query<EncounterRow>(
            `insert into ehr.encounters (
               patient_id, facility_id, created_by, created_by_membership_id,
               encounter_number, encounter_type, status, started_at, ended_at, chief_complaint
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             returning ${ENCOUNTER_COLUMNS}`,
            [
              patientId,
              context.facilityId,
              context.actor.accountId,
              context.membershipId,
              input.encounterNumber ?? null,
              input.encounterType,
              input.status,
              input.startedAt,
              input.endedAt ?? null,
              input.chiefComplaint ?? null,
            ],
          );
          const row = this.single(result.rows[0]);
          return { value: row, id: row.id };
        },
        (id) => this.findRow(client, patientId, context.facilityId, id),
      ),
    );
  }

  update(
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    input: UpdateEncounterDto,
  ): Promise<EncounterRow> {
    this.requireMutation(input, ['status', 'endedAt', 'chiefComplaint']);
    return this.repository.run(
      context,
      patientId,
      'write_records',
      { action: 'ehr.encounter.update', resourceType: 'encounter', resourceId: encounterId },
      async (client) => {
        const current = await this.lockRow(client, patientId, context.facilityId, encounterId);
        if (input.status && input.status !== current.status && !TRANSITIONS[current.status].includes(input.status)) {
          throw new DomainProblem(409, 'INVALID_ENCOUNTER_TRANSITION', 'Encounter status transition is not allowed');
        }
        await this.repository.setChangeReason(client, input.changeReason);
        const result = await client.query<EncounterRow>(
          `update ehr.encounters set
             status = coalesce($1, status),
             ended_at = coalesce($2::timestamptz, ended_at),
             chief_complaint = coalesce($3, chief_complaint)
           where id = $4 and patient_id = $5 and facility_id = $6 and row_version = $7
           returning ${ENCOUNTER_COLUMNS}`,
          [
            input.status ?? null,
            input.endedAt ?? null,
            input.chiefComplaint ?? null,
            encounterId,
            patientId,
            context.facilityId,
            input.expectedRowVersion,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new DomainProblem(412, 'VERSION_CONFLICT', 'Encounter changed since it was loaded');
        return { value: row, resourceId: encounterId, details: { rowVersion: row.rowVersion } };
      },
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
  }

  private async findRow(client: PoolClient, patientId: string, facilityId: string, id: string): Promise<EncounterRow | undefined> {
    const result = await client.query<EncounterRow>(
      `select ${ENCOUNTER_COLUMNS} from ehr.encounters where id = $1 and patient_id = $2 and facility_id = $3`,
      [id, patientId, facilityId],
    );
    return result.rows[0];
  }

  private async requireRow(client: PoolClient, patientId: string, facilityId: string, id: string): Promise<EncounterRow> {
    return this.single(await this.findRow(client, patientId, facilityId, id));
  }

  private async lockRow(client: PoolClient, patientId: string, facilityId: string, id: string): Promise<EncounterRow> {
    const result = await client.query<EncounterRow>(
      `select ${ENCOUNTER_COLUMNS} from ehr.encounters
       where id = $1 and patient_id = $2 and facility_id = $3 for update`,
      [id, patientId, facilityId],
    );
    return this.single(result.rows[0]);
  }

  private single(row: EncounterRow | undefined): EncounterRow {
    if (!row) throw new DomainProblem(404, 'ENCOUNTER_NOT_FOUND', 'Encounter was not found');
    return row;
  }

  private requireMutation(input: object, keys: readonly string[]): void {
    if (!keys.some((key) => Object.prototype.hasOwnProperty.call(input, key))) {
      throw new DomainProblem(400, 'EMPTY_UPDATE', 'At least one clinical field must be supplied');
    }
  }
}
