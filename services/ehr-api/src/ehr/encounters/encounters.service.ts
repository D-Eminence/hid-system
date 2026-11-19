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
import { changeReasonRequired, hasTypedReason, neverReachedBefore, resolveChangeReason } from '../shared/change-reason';
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
  // EHR-C8a: a completed visit may be entered in error, with a reason
  // (a typed one: Q105 frees only starting and finishing); never the imported
  // paper records visit.
  [EncounterStatus.Completed]: [EncounterStatus.EnteredInError],
  [EncounterStatus.Cancelled]: [],
  [EncounterStatus.EnteredInError]: [],
};

/**
 * Q105: whether the body could be a visit start (to in progress, nothing
 * else) or a finish (to completed, with at most its end time), the only
 * changes that may go without a typed reason. The visit's current status and
 * history decide the rest, under its row lock.
 */
function mayStartOrFinish(input: UpdateEncounterDto): boolean {
  if (input.chiefComplaint !== undefined) return false;
  return (input.status === EncounterStatus.InProgress && input.endedAt === undefined)
    || input.status === EncounterStatus.Completed;
}

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
    const day = reuse ? lagosCalendarDate(this.now()) : undefined;
    // EHR-C1 (review finding 3): the lookup is for today's open visit, so the
    // visit a reuse request would create must start today too. Otherwise a
    // device whose clock is behind (just after midnight) would create a visit
    // dated yesterday that no later lookup finds, and a future booking would
    // get today's visit back instead of being created.
    if (day !== undefined && lagosCalendarDate(new Date(input.startedAt)) !== day) {
      throw new DomainProblem(400, 'REUSE_OPEN_VISIT_STARTED_AT_NOT_TODAY',
        'To use the open visit today, the visit must start today (Lagos time). Check the date and time on this device.');
    }
    // A body without reuseOpenVisit keeps the Idempotency-Key digest it had before EHR-C1.
    const { reuseOpenVisit: _reuse, ...withoutReuse } = input;
    const digest = requestDigest(operation, { patientId, input: input.reuseOpenVisit === undefined ? withoutReuse : input });
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
    // Q105: only a start or a finish may go without a typed reason. A change
    // without one that can be neither (hold, cancel, entered in error, an end
    // time alone, a chief complaint) answers 400 before the visit is read, as
    // the body's validation did before Q105, so before EHR-C8a's 409s. Whether
    // a move to in progress or completed is a first start or finish (and not,
    // say, a resume) is decided under the visit's row lock.
    if (!hasTypedReason(input.changeReason) && !mayStartOrFinish(input)) {
      return Promise.reject(changeReasonRequired());
    }
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
        const completedInError = current.status === EncounterStatus.Completed
          && input.status === EncounterStatus.EnteredInError;
        if (completedInError) await this.assertCompletedVisitCanBeEnteredInError(client, context, patientId, current);
        // Q105: starting a planned visit (nothing else changed) and finishing
        // a visit in progress (with its end time, nothing else) need no typed
        // reason; the fixed one is recorded. "First" is checked against the
        // version history and fails closed. Holds, resumes, cancels, entered
        // in error and edits still need a typed reason.
        const fixed = hasTypedReason(input.changeReason) ? undefined : await this.fixedVisitReason(client, current, input);
        const { reason, details: reasonDetails } = resolveChangeReason(input.changeReason, fixed);
        await this.repository.setChangeReason(client, reason);
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
        return { value: row, resourceId: encounterId,
          details: { rowVersion: row.rowVersion, ...reasonDetails,
            ...(completedInError ? { completedVisitEnteredInError: true } : {}) } };
      },
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
  }

  /**
   * EHR-C8a: the checks before a completed visit is entered in error, run
   * under the visit's row lock (taken FOR UPDATE). The imported paper records visit (0113)
   * is refused, and so is a visit that still has:
   * - a draft, active or on-hold prescription or lab request: those are
   *   cancelled, stopped or entered in error first, so no pharmacy or lab keeps
   *   acting on a visit that should not exist (a draft counts, since it could
   *   otherwise be activated later);
   * - a signed or amended note: each is entered in error first, so the
   *   patient's own record (which can see only completed visits, and so cannot
   *   tell a visit entered in error from one still open) never lists it.
   * Every order and note change that starts or adds something checks the
   * visit under FOR SHARE (shared/visit-guard.ts), so none can slip in between
   * this count and the update.
   */
  private async assertCompletedVisitCanBeEnteredInError(
    client: PoolClient,
    context: DataAccessContext,
    patientId: string,
    current: EncounterRow,
  ): Promise<void> {
    if (current.importedPaperRecords) {
      throw new DomainProblem(409, 'IMPORTED_VISIT_NOT_ENTERED_IN_ERROR',
        'The imported paper records visit cannot be marked as entered in error.');
    }
    const open = await client.query<{ openOrders: number; signedNotes: number }>(
      `select ((select count(*) from ehr.prescriptions
                 where encounter_id = $1 and patient_id = $2 and facility_id = $3
                   and status in ('draft', 'active', 'on_hold'))
             + (select count(*) from ehr.lab_requests
                 where encounter_id = $1 and patient_id = $2 and facility_id = $3
                   and status in ('draft', 'active', 'on_hold')))::int as "openOrders",
              (select count(*) from ehr.clinical_notes
                 where encounter_id = $1 and patient_id = $2 and facility_id = $3
                   and status in ('signed', 'amended'))::int as "signedNotes"`,
      [current.id, patientId, context.facilityId],
    );
    if (Number(open.rows[0]?.openOrders ?? 0) > 0) {
      throw new DomainProblem(409, 'VISIT_HAS_OPEN_ORDERS',
        'Cancel or stop this visit\'s prescriptions and lab requests, drafts included, before marking it as entered in error.');
    }
    if (Number(open.rows[0]?.signedNotes ?? 0) > 0) {
      throw new DomainProblem(409, 'VISIT_HAS_SIGNED_NOTES',
        'Mark this visit\'s signed notes as entered in error before marking the visit as entered in error.');
    }
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
   * the same visit, with `reusedOpenVisit` false only when the original
   * request created it.
   *
   * Review finding 5: decided from facts recorded in the original
   * transaction, not from timestamps (a request's key row is written before
   * it waits on the advisory lock, so a visit another request created while
   * it waited is younger than the key). The request created the visit when
   * the visit's create version (ehr.record_versions, version_no 1) carries
   * the same correlation id and account as the Idempotency-Key's create
   * version: both are written by the same request. If either version cannot
   * be seen, the old comparison of creation times is the fallback.
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
      `select coalesce(
                (select encounter_version.correlation_id is distinct from key_version.correlation_id
                        or encounter_version.changed_by is distinct from key_version.changed_by
                 from ehr.record_versions encounter_version, ehr.record_versions key_version
                 where encounter_version.resource_type = 'encounters'
                   and encounter_version.resource_id = encounter_row.id::text
                   and encounter_version.version_no = 1
                   and key_version.resource_type = 'idempotency_keys'
                   and key_version.resource_id = key_row.id::text
                   and key_version.version_no = 1),
                encounter_row.created_at < key_row.created_at) as reused
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

  /**
   * Q105: the fixed reason for starting or finishing a visit, or undefined
   * when the change needs a typed one. Start: planned to in progress with no
   * other field, never in progress, on hold or completed before. Finish: in
   * progress to completed with at most its end time, never completed before.
   */
  private async fixedVisitReason(client: PoolClient, current: EncounterRow, input: UpdateEncounterDto)
    : Promise<'visit_start' | 'visit_finish' | undefined> {
    if (!mayStartOrFinish(input)) return undefined;
    if (current.status === EncounterStatus.Planned && input.status === EncounterStatus.InProgress) {
      return await neverReachedBefore(client, 'encounters', current.id,
        [EncounterStatus.InProgress, EncounterStatus.OnHold, EncounterStatus.Completed]) ? 'visit_start' : undefined;
    }
    if (current.status === EncounterStatus.InProgress && input.status === EncounterStatus.Completed) {
      return await neverReachedBefore(client, 'encounters', current.id, [EncounterStatus.Completed])
        ? 'visit_finish' : undefined;
    }
    return undefined;
  }

  private requireMutation(input: object, keys: readonly string[]): void {
    if (!keys.some((key) => Object.prototype.hasOwnProperty.call(input, key))) {
      throw new DomainProblem(400, 'EMPTY_UPDATE', 'At least one clinical field must be supplied');
    }
  }
}
