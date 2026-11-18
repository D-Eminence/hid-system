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
import { decodeTimelineCursor, requestDigest, timelineCursorSql, timelinePage } from '../shared/clinical-context';
import { ClinicalRepository } from '../shared/clinical.repository';
import { lagosCalendarDate, lagosDaySql, VISIT_DAY_TIME_ZONE } from './lagos-day';

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
  importedPaperRecords?: boolean;
}

/** EHR-C1: the answer of a create that asked for the open visit today. */
export type EncounterCreated = EncounterRow & { reusedOpenVisit?: boolean };

/** EHR-C1: what the visit desk reads before starting a visit. */
export interface OpenVisitToday {
  /** Today's Lagos calendar date (YYYY-MM-DD). */
  day: string;
  timeZone: typeof VISIT_DAY_TIME_ZONE;
  /** The newest open visit started today at this facility, or null. */
  encounter: EncounterRow | null;
}

/** Statuses of a visit still open (not completed, cancelled or entered in error). */
export const OPEN_VISIT_STATUSES: readonly EncounterStatus[] = [
  EncounterStatus.Planned, EncounterStatus.InProgress, EncounterStatus.OnHold,
];

const ENCOUNTER_COLUMNS = `
  id, patient_id as "patientId", facility_id as "facilityId",
  created_by as "createdBy", created_by_membership_id as "createdByMembershipId",
  encounter_number as "encounterNumber", encounter_type as "encounterType", status,
  started_at as "startedAt", ended_at as "endedAt", chief_complaint as "chiefComplaint",
  row_version as "rowVersion", created_at as "createdAt", updated_at as "updatedAt",
  imported_paper_records as "importedPaperRecords"`;

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
  /** The clock "today" is read from; tests replace it. */
  now: () => Date = () => new Date();

  constructor(private readonly repository: ClinicalRepository) {}

  /**
   * EHR-C1: the patient's open visit today (Lagos calendar day) at this
   * facility, or null. Read under the patient's consent like every visit
   * read, and audited (`ehr.encounter.open-today`, with `found`).
   */
  openToday(context: DataAccessContext, patientId: string): Promise<OpenVisitToday> {
    const day = lagosCalendarDate(this.now());
    return this.repository.run(
      context,
      patientId,
      'read_records',
      { action: 'ehr.encounter.open-today', resourceType: 'encounter', details: { day } },
      async (client) => {
        const encounter = (await this.findOpenToday(client, patientId, context.facilityId, day)) ?? null;
        return { value: { day, timeZone: VISIT_DAY_TIME_ZONE, encounter },
          ...(encounter ? { resourceId: encounter.id } : {}), details: { found: encounter !== null } };
      },
    );
  }

  list(context: DataAccessContext, patientId: string, query: TimelineQueryDto) {
    const scope = { list: 'ehr.encounters', patientId };
    const cursor = decodeTimelineCursor(query.cursor, scope);
    return this.repository.run(
      context,
      patientId,
      'read_records',
      { action: 'ehr.encounter.list', resourceType: 'encounter' },
      async (client) => {
        const result = await client.query<EncounterRow & { cursorAt: string }>(
          `select ${ENCOUNTER_COLUMNS}, ${timelineCursorSql('started_at')} as "cursorAt"
           from ehr.encounters
           where patient_id = $1 and facility_id = $2
             and ($3::timestamptz is null or (started_at, id) < ($3::timestamptz, $4::uuid))
           order by started_at desc, id desc limit $5`,
          [patientId, context.facilityId, cursor?.sortAt ?? null, cursor?.id ?? null, query.limit + 1],
        );
        const page = timelinePage(result.rows, query.limit, scope);
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
  ): Promise<EncounterCreated> {
    const operation = 'encounter.create';
    const reuse = input.reuseOpenVisit === true;
    if (reuse && input.status !== EncounterStatus.Planned && input.status !== EncounterStatus.InProgress) {
      throw new DomainProblem(400, 'REUSE_OPEN_VISIT_NEEDS_OPEN_STATUS',
        'To use the open visit today, start the visit as planned or in progress.');
    }
    // A body without reuseOpenVisit keeps the Idempotency-Key digest it had before EHR-C1.
    const { reuseOpenVisit: _reuse, ...withoutReuse } = input;
    const digest = requestDigest(operation, { patientId, input: input.reuseOpenVisit === undefined ? withoutReuse : input });
    const day = reuse ? lagosCalendarDate(this.now()) : undefined;
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
          if (day) {
            // EHR-C1: one open visit per patient per facility per Lagos day.
            // The lock is taken before the lookup, so two requests at once
            // cannot both find none and both create one; it is held until
            // this transaction ends (READ COMMITTED: the lookup after the
            // wait sees the other request's committed visit).
            await this.lockOpenVisit(client, context.facilityId, patientId);
            const open = await this.findOpenToday(client, patientId, context.facilityId, day);
            if (open) {
              return { value: { ...open, reusedOpenVisit: true }, id: open.id,
                details: { reusedOpenVisit: true, day } };
            }
          }
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
          return day
            ? { value: { ...row, reusedOpenVisit: false }, id: row.id, details: { reusedOpenVisit: false, day } }
            : { value: row, id: row.id };
        },
        (id) => day
          ? this.findReplay(client, context, patientId, idempotencyKey, operation, id)
          : this.findRow(client, patientId, context.facilityId, id),
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

  /** EHR-C1: serialises the open-visit lookup and create for one patient at one facility. */
  private async lockOpenVisit(client: PoolClient, facilityId: string, patientId: string): Promise<void> {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('ehr.open-visit:' || $1::text || ':' || $2::text, 0))`,
      [facilityId, patientId],
    );
  }

  /** EHR-C1: the newest open visit started on the given Lagos day at this facility. */
  private async findOpenToday(
    client: PoolClient,
    patientId: string,
    facilityId: string,
    day: string,
  ): Promise<EncounterRow | undefined> {
    const result = await client.query<EncounterRow>(
      `select ${ENCOUNTER_COLUMNS} from ehr.encounters
       where patient_id = $1 and facility_id = $2
         and status = any($4::text[]) and not imported_paper_records
         and ${lagosDaySql('started_at', 3)}
       order by started_at desc, created_at desc, id desc
       limit 1`,
      [patientId, facilityId, day, OPEN_VISIT_STATUSES],
    );
    return result.rows[0];
  }

  /**
   * EHR-C1: an idempotent replay of a create that asked for the open visit:
   * the same visit, with `reusedOpenVisit` true when the visit is older than
   * the request's Idempotency-Key (it was found, not created).
   */
  private async findReplay(
    client: PoolClient,
    context: DataAccessContext,
    patientId: string,
    idempotencyKey: string,
    operation: string,
    id: string,
  ): Promise<EncounterCreated | undefined> {
    const row = await this.findRow(client, patientId, context.facilityId, id);
    if (!row) return undefined;
    // Compared in the database, at full (microsecond) precision.
    const key = await client.query<{ reused: boolean }>(
      `select encounter_row.created_at < key_row.created_at as reused
       from ehr.idempotency_keys key_row
       join ehr.encounters encounter_row
         on encounter_row.id = $1 and encounter_row.patient_id = $2 and encounter_row.facility_id = key_row.facility_id
       where key_row.facility_id = $3 and key_row.created_by = $4 and key_row.operation = $5
         and key_row.idempotency_key = $6`,
      [row.id, patientId, context.facilityId, context.actor.accountId, operation, idempotencyKey],
    );
    return { ...row, reusedOpenVisit: key.rows[0]?.reused === true };
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
