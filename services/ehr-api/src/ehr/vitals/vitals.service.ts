import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { decodeTimelineCursor, requestDigest, timelineCursorSql, timelinePage } from '../shared/clinical-context';
import {
  CreateVitalCorrectionDto,
  CreateVitalDto,
  hasMeasurements,
  TimelineQueryDto,
  VitalMeasurementsDto,
} from '../shared/clinical.dto';
import { requireChangeReason } from '../shared/change-reason';
import { ClinicalRepository, type OperationResult } from '../shared/clinical.repository';
import type { MarkVitalEnteredInErrorDto, VitalsListQueryDto } from './vitals.dto';
import { measureWarning, moreSerious, USUAL_RANGES_VERSION, vitalWarnings, type VitalWarning,
  type WarnedMeasure } from './usual-ranges';
import {
  checkObservationRules, OBSERVATION_FIELD_KEYS, OBSERVATION_INSERT_COLUMNS, observationColumnsSql,
  observationFieldsEnabled, observationInsertValues, requireObservationFieldsAllowed, type ObservationValues,
} from './observation-fields';

/** EHR-C8b (0142): a reading is recorded, or withdrawn for good. */
export type VitalStatus = 'recorded' | 'entered_in_error';

export interface VitalRow extends QueryResultRow {
  id: string;
  encounterId: string;
  patientId: string;
  facilityId: string;
  createdBy: string;
  createdByMembershipId: string;
  recordedAt: Date;
  heightCm: string | null;
  weightKg: string | null;
  temperatureC: string | null;
  pulseBpm: number | null;
  respiratoryRate: number | null;
  systolicMmhg: number | null;
  diastolicMmhg: number | null;
  oxygenSaturationPercent: string | null;
  source: string;
  currentCorrectionNo: number;
  rowVersion: string;
  createdAt: Date;
  updatedAt: Date;
  status: VitalStatus;
  statusChangedAt: Date | null;
  // NUR-1 (0174): present only while NURSING_ENABLED is on.
  painScore?: number | null;
  avpu?: string | null;
  bloodGlucoseMmolL?: string | null;
  oxygenDevice?: string | null;
  oxygenFlowLPerMin?: string | null;
  fio2Percent?: number | null;
  gcsEye?: number | null;
  gcsVerbal?: number | null;
  gcsVerbalNotTestable?: boolean | null;
  gcsMotor?: number | null;
}

export interface VitalCorrectionRow extends QueryResultRow {
  id: string;
  vitalId: string;
  patientId: string;
  facilityId: string;
  correctionNo: number;
  replacementValues: Readonly<Record<string, unknown>>;
  reason: string;
  createdBy: string;
  createdByMembershipId: string;
  contentSha256: string;
  createdAt: Date;
}

/**
 * EHR-C8b: a reading's status, read through the whole row so a database
 * without 0142 reads every reading as recorded (only the PATCH needs the
 * column, and answers 503 VITALS_STATUS_UNAVAILABLE without it). `alias` is
 * a table alias written by this code, never input.
 */
export function vitalStatusSql(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error('A table alias is required');
  return `coalesce(to_jsonb(${alias})->>'status', 'recorded')`;
}

/** Only recorded readings: the latest vitals, the record evidence, chat and the chart summary. */
export function recordedVitalSql(alias: string): string {
  return `${vitalStatusSql(alias)} = 'recorded'`;
}

export const VITAL_MESSAGES = {
  notFound: 'These vitals were not found.',
  versionConflict: 'Someone else changed these vitals. Reload them and try again.',
  alreadyEnteredInError: 'These vitals are already marked as entered in error.',
  enteredInError: 'These vitals were marked as entered in error. Record new vitals instead.',
  statusUnavailable: 'This cannot be done right now. Please try again.',
} as const;

const VITAL_COLUMNS = `
  id, encounter_id as "encounterId", patient_id as "patientId", facility_id as "facilityId",
  created_by as "createdBy", created_by_membership_id as "createdByMembershipId",
  recorded_at as "recordedAt", height_cm as "heightCm", weight_kg as "weightKg",
  temperature_c as "temperatureC", pulse_bpm as "pulseBpm", respiratory_rate as "respiratoryRate",
  systolic_mmhg as "systolicMmhg", diastolic_mmhg as "diastolicMmhg",
  oxygen_saturation_percent as "oxygenSaturationPercent", source,
  current_correction_no as "currentCorrectionNo", row_version as "rowVersion",
  created_at as "createdAt", updated_at as "updatedAt",
  ${vitalStatusSql('vitals')} as status,
  (to_jsonb(vitals)->>'status_changed_at')::timestamptz as "statusChangedAt"`;

/** Today's columns, and (NUR-1, 0174) the observation chart's fields while NURSING_ENABLED is on. */
function vitalColumns(): string {
  return VITAL_COLUMNS + (observationFieldsEnabled() ? observationColumnsSql('vitals') : '');
}

const CORRECTION_COLUMNS = `
  id, vital_id as "vitalId", patient_id as "patientId", facility_id as "facilityId",
  correction_no as "correctionNo", replacement_values as "replacementValues", reason,
  created_by as "createdBy", created_by_membership_id as "createdByMembershipId",
  content_sha256 as "contentSha256", created_at as "createdAt"`;

/** EHR-C3: the measures `latest` answers, each the newest corrected value. */
export const LATEST_VITAL_MEASURES = [
  'heightCm', 'weightKg', 'temperatureC', 'pulseBpm', 'respiratoryRate', 'bloodPressure', 'oxygenSaturationPercent',
] as const;
export type LatestVitalMeasure = (typeof LATEST_VITAL_MEASURES)[number];

/**
 * One measure's newest value: where and when it was taken, and whether the
 * reading's current correction set this measure (review finding 4: per
 * measure, not per reading; for bloodPressure, either half of the pair).
 */
export interface LatestVitalValue {
  /** A number, or for bloodPressure `{ systolicMmhg, diastolicMmhg }` (always the pair). */
  value: number | { systolicMmhg: number; diastolicMmhg: number };
  recordedAt: Date;
  vitalId: string;
  encounterId: string;
  corrected: boolean;
}

export interface LatestVitals {
  facilityId: string;
  measures: Partial<Record<LatestVitalMeasure, LatestVitalValue>>;
}

interface LatestVitalRow extends QueryResultRow {
  measure: LatestVitalMeasure;
  value: unknown;
  recordedAt: Date;
  vitalId: string;
  encounterId: string;
  corrected: boolean;
}

/**
 * EHR-C3: for each measure, the newest value at this facility, after the
 * vital's current correction is applied (as the patient record evidence
 * applies it: the correction's values over the original ones). Blood pressure
 * is one measure, kept as its systolic and diastolic pair from the same
 * reading. Vitals of a visit entered in error, and readings entered in error
 * (EHR-C8b), are left out: the next newest reading is used.
 */
export const LATEST_VITALS_SQL = `
  with effective as (
    select v.id, v.encounter_id, v.recorded_at, v.created_at,
           to_jsonb(v) || coalesce(c.replacement_values, '{}'::jsonb) as m,
           coalesce(c.replacement_values, '{}'::jsonb) as r
    from ehr.vitals v
    join ehr.encounters e
      on e.id = v.encounter_id and e.patient_id = v.patient_id and e.facility_id = v.facility_id
    left join ehr.vital_corrections c
      on c.vital_id = v.id and c.correction_no = v.current_correction_no
     and c.patient_id = v.patient_id and c.facility_id = v.facility_id
    where v.patient_id = $1 and v.facility_id = $2 and e.status <> 'entered_in_error'
      and ${recordedVitalSql('v')}
  )
  select distinct on (x.measure)
         x.measure, x.value, effective.recorded_at as "recordedAt", effective.id as "vitalId",
         effective.encounter_id as "encounterId", x.corrected
  from effective
  cross join lateral (values
    ('heightCm', effective.m->'height_cm', effective.r ? 'height_cm'),
    ('weightKg', effective.m->'weight_kg', effective.r ? 'weight_kg'),
    ('temperatureC', effective.m->'temperature_c', effective.r ? 'temperature_c'),
    ('pulseBpm', effective.m->'pulse_bpm', effective.r ? 'pulse_bpm'),
    ('respiratoryRate', effective.m->'respiratory_rate', effective.r ? 'respiratory_rate'),
    ('bloodPressure', case
      when jsonb_typeof(effective.m->'systolic_mmhg') = 'number' and jsonb_typeof(effective.m->'diastolic_mmhg') = 'number'
      then jsonb_build_object('systolicMmhg', effective.m->'systolic_mmhg', 'diastolicMmhg', effective.m->'diastolic_mmhg')
    end, effective.r ?| array['systolic_mmhg', 'diastolic_mmhg']),
    ('oxygenSaturationPercent', effective.m->'oxygen_saturation_percent', effective.r ? 'oxygen_saturation_percent')
  ) as x(measure, value, corrected)
  where x.value is not null and jsonb_typeof(x.value) <> 'null'
  order by x.measure, effective.recorded_at desc, effective.created_at desc, effective.id desc`;

/**
 * EHR-C3's reader, inside the caller's transaction (already authorized and
 * audited by the caller): the newest corrected value of each measure for the
 * patient at this facility. Also read by the chart summary (EHR-C4).
 */
export async function readLatestVitals(client: PoolClient, patientId: string, facilityId: string): Promise<LatestVitals> {
  const result = await client.query<LatestVitalRow>(LATEST_VITALS_SQL, [patientId, facilityId]);
  const measures: Partial<Record<LatestVitalMeasure, LatestVitalValue>> = {};
  for (const row of result.rows) {
    if (!LATEST_VITAL_MEASURES.includes(row.measure)) continue;
    measures[row.measure] = { value: latestValue(row.value), recordedAt: row.recordedAt, vitalId: row.vitalId,
      encounterId: row.encounterId, corrected: row.corrected === true };
  }
  return { facilityId, measures };
}

@Injectable()
export class VitalsService {
  constructor(private readonly repository: ClinicalRepository) {}

  /**
   * EHR-C3: the newest value of each measure for the patient at this
   * facility (GET ehr/patients/:patientId/vitals/latest). Read under the
   * patient's consent and audited (`ehr.vital.latest`, with the count of
   * measures, never the values); a refusal is audited by the repository.
   */
  async latest(context: DataAccessContext, patientId: string): Promise<LatestVitalsWithWarnings> {
    const latest = await this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.vital.latest', resourceType: 'vital' },
      async (client) => {
        const value = await readLatestVitals(client, patientId, context.facilityId);
        return { value, details: { measureCount: Object.keys(value.measures).length } };
      },
    );
    return latestWithWarnings(latest);
  }

  list(context: DataAccessContext, patientId: string, encounterId: string, query: VitalsListQueryDto | TimelineQueryDto) {
    const includeEnteredInError = 'includeEnteredInError' in query && query.includeEnteredInError === 'true';
    // A page's cursor is valid only for the same choice (EHR-C8b): the
    // cursor binds the list name, so the full history has its own.
    const scope = { list: includeEnteredInError ? 'ehr.vitals.with-entered-in-error' : 'ehr.vitals', patientId, encounterId };
    const cursor = decodeTimelineCursor(query.cursor, scope);
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.vital.list', resourceType: 'vital', resourceId: encounterId },
      async (client) => {
        const result = await client.query<VitalRow & { cursorAt: string }>(
          `select ${vitalColumns()}, ${timelineCursorSql('recorded_at')} as "cursorAt" from ehr.vitals
           where encounter_id = $1 and patient_id = $2 and facility_id = $3
             and ($4::timestamptz is null or (recorded_at, id) < ($4::timestamptz, $5::uuid))
             and ($7 or ${recordedVitalSql('vitals')})
           order by recorded_at desc, id desc limit $6`,
          [encounterId, patientId, context.facilityId, cursor?.sortAt ?? null, cursor?.id ?? null, query.limit + 1,
            includeEnteredInError],
        );
        const page = timelinePage(result.rows, query.limit, scope);
        return { value: page, details: { resultCount: page.items.length,
          ...(includeEnteredInError ? { includeEnteredInError: true } : {}) } };
      },
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
  }

  get(context: DataAccessContext, patientId: string, encounterId: string, vitalId: string) {
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.vital.read', resourceType: 'vital', resourceId: vitalId },
      async (client) => ({ value: this.single(await this.findVital(client, context, patientId, encounterId, vitalId)) }),
      (client) => this.repository.exists(client, 'vitals', vitalId, patientId, context.facilityId, encounterId),
    );
  }

  corrections(context: DataAccessContext, patientId: string, encounterId: string, vitalId: string) {
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.vital-correction.list', resourceType: 'vital', resourceId: vitalId },
      async (client) => {
        const result = await client.query<VitalCorrectionRow>(
          `select ${CORRECTION_COLUMNS} from ehr.vital_corrections
           where vital_id = $1 and patient_id = $2 and facility_id = $3 order by correction_no desc`,
          [vitalId, patientId, context.facilityId],
        );
        return {
          value: result.rows.map(vitalCorrectionFromStorage),
          resourceId: vitalId,
          details: { resultCount: result.rows.length },
        };
      },
      (client) => this.repository.exists(client, 'vitals', vitalId, patientId, context.facilityId, encounterId),
    );
  }

  /**
   * VIT-1: the answer (and its replay) carries the reading's warnings; they
   * never block the save. A replay of a reading since marked entered in error
   * carries none.
   */
  async create(context: DataAccessContext, patientId: string, encounterId: string, input: CreateVitalDto, key: string) {
    this.assertMeasurementsGiven(input);
    const row = await this.repository.run(
      context, patientId, 'write_records', { action: 'ehr.vital.create', resourceType: 'vital' },
      (client) => this.createInTransaction(client, context, patientId, encounterId, input, key),
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
    return { ...row, ...(row.status === 'entered_in_error' ? noWarnings() : warningsOf(vitalValues(row))) };
  }

  /**
   * The checks a vitals create runs before the database is touched (also
   * EHR-C5's one-call consultation). VIT-1's blood-pressure order rule is not
   * among them: it runs only for a new write, after the key lookup
   * (checkBloodPressureOrder), so a retry of a reading an older image saved
   * still replays.
   */
  checkCreate(input: CreateVitalDto): void {
    this.assertMeasurementsGiven(input);
  }

  /** VIT-1's one hard rule, for a new write only (never a replay of a saved one). */
  checkBloodPressureOrder(value: VitalMeasurementsDto): void {
    if (value.systolicMmhg !== undefined && value.diastolicMmhg !== undefined && value.diastolicMmhg >= value.systolicMmhg) {
      throw new DomainProblem(400, 'BLOOD_PRESSURE_ORDER_INVALID', 'The lower blood pressure number (diastolic) must be '
        + 'less than the upper one (systolic). Check the reading.');
    }
  }

  /**
   * The vitals create inside a transaction the caller already holds (the
   * route's own, or EHR-C5's one-call consultation). The caller runs
   * checkCreate first and writes the `ehr.vital.create` audit row.
   */
  createInTransaction(
    client: PoolClient,
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    input: CreateVitalDto,
    key: string,
    operation = 'vital.create',
  ): Promise<OperationResult<VitalRow>> {
    const digest = requestDigest(operation, { patientId, encounterId, input });
    return this.repository.executeCreate(
      client, context, patientId, key, operation, digest, 'vital',
      async () => {
        this.checkBloodPressureOrder(input);
        // NUR-1 (0174): the observation chart's fields go in only while NURSING_ENABLED is on (off, the INSERT is
        // today's, and a reading carrying them was refused before the key lookup).
        const observations = observationFieldsEnabled();
        const result = await client.query<VitalRow>(
          `insert into ehr.vitals (
             encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
             recorded_at, height_cm, weight_kg, temperature_c, pulse_bpm, respiratory_rate,
             systolic_mmhg, diastolic_mmhg, oxygen_saturation_percent, source${observations ? `, ${OBSERVATION_INSERT_COLUMNS}` : ''}
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15${observations
             ? ',$16,$17,$18,$19,$20,$21,$22,$23,$24,$25' : ''})
           returning ${vitalColumns()}`,
          [
            encounterId, patientId, context.facilityId, context.actor.accountId, context.membershipId,
            input.recordedAt, input.heightCm ?? null, input.weightKg ?? null, input.temperatureC ?? null,
            input.pulseBpm ?? null, input.respiratoryRate ?? null, input.systolicMmhg ?? null,
            input.diastolicMmhg ?? null, input.oxygenSaturationPercent ?? null, input.source,
            ...(observations ? observationInsertValues(input) : []),
          ],
        );
        const row = this.single(result.rows[0]);
        return { value: row, id: row.id };
      },
      (id) => this.findVitalById(client, context, patientId, id),
    );
  }

  correct(
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    vitalId: string,
    input: CreateVitalCorrectionDto,
    key: string,
  ) {
    this.assertMeasurementsGiven(input.replacementValues, false);
    const operation = 'vital-correction.create';
    const digest = requestDigest(operation, { patientId, encounterId, vitalId, input });
    return this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.vital-correction.create', resourceType: 'vital-correction' },
      (client) => this.repository.executeCreate(
        client, context, patientId, key, operation, digest, 'vital-correction',
        async () => {
          this.checkBloodPressureOrder(input.replacementValues);
          const vital = await this.lockVital(client, context, patientId, encounterId, vitalId);
          if (vital.status === 'entered_in_error') {
            throw new DomainProblem(409, 'VITAL_ENTERED_IN_ERROR', VITAL_MESSAGES.enteredInError);
          }
          if (Number(vital.rowVersion) !== input.expectedRowVersion) {
            throw new DomainProblem(412, 'VERSION_CONFLICT', VITAL_MESSAGES.versionConflict);
          }
          // NUR-1 (0174): a correction of the new fields keeps the oxygen and GCS rules for the values after it.
          if (observationFieldsEnabled()) checkObservationRules(observationsAfter(vital, input.replacementValues));
          const nextCorrection = vital.currentCorrectionNo + 1;
          const result = await client.query<VitalCorrectionRow>(
            `insert into ehr.vital_corrections (
               vital_id, patient_id, facility_id, correction_no, replacement_values, reason,
               created_by, created_by_membership_id
             ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
             returning ${CORRECTION_COLUMNS}`,
            [
              vitalId, patientId, context.facilityId, nextCorrection,
              JSON.stringify(vitalMeasurementsToStorage(input.replacementValues)), input.changeReason,
              context.actor.accountId, context.membershipId,
            ],
          );
          await this.repository.setChangeReason(client, input.changeReason);
          const updated = await client.query(
            `update ehr.vitals set current_correction_no = $1
             where id = $2 and patient_id = $3 and facility_id = $4 and row_version = $5`,
            [nextCorrection, vitalId, patientId, context.facilityId, input.expectedRowVersion],
          );
          if (updated.rowCount !== 1) throw new DomainProblem(412, 'VERSION_CONFLICT', VITAL_MESSAGES.versionConflict);
          const storedCorrection = result.rows[0];
          if (!storedCorrection) throw new DomainProblem(500, 'CORRECTION_CREATE_FAILED', 'Vital correction could not be created');
          const correction = vitalCorrectionFromStorage(storedCorrection);
          return { value: correctionWithWarnings(vital, correction), id: correction.id };
        },
        async (id) => {
          // A replay: the warnings again, for the values after the correction.
          const correction = await this.findCorrection(client, context, patientId, vitalId, id);
          const vital = correction ? await this.findVitalById(client, context, patientId, vitalId) : undefined;
          return correction && vital ? correctionWithWarnings(vital, correction) : correction;
        },
      ),
      (client) => this.repository.exists(client, 'vitals', vitalId, patientId, context.facilityId, encounterId),
    );
  }

  /**
   * EHR-C8b: PATCH .../vitals/:vitalId, marking one reading entered in error
   * for good. The reading is locked FOR UPDATE before the checks; the typed
   * reason goes to the version row (0004's trigger) and never to the audit
   * row, which says only `enteredInError: true` (`ehr.vital.update`).
   */
  markEnteredInError(context: DataAccessContext, patientId: string, encounterId: string, vitalId: string,
    input: MarkVitalEnteredInErrorDto) {
    const reason = requireChangeReason(input.changeReason);
    // The scoped lookup (as a correction's) audits a reading of another visit,
    // patient or facility as not_found; its 404 keeps this route's code.
    return this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.vital.update', resourceType: 'vital', resourceId: vitalId, details: { enteredInError: true } },
      async (client) => {
        const vital = await this.lockVital(client, context, patientId, encounterId, vitalId);
        if (vital.status === 'entered_in_error') {
          throw new DomainProblem(409, 'VITAL_ALREADY_ENTERED_IN_ERROR', VITAL_MESSAGES.alreadyEnteredInError);
        }
        if (Number(vital.rowVersion) !== input.expectedRowVersion) {
          throw new DomainProblem(412, 'VERSION_CONFLICT', VITAL_MESSAGES.versionConflict);
        }
        await this.repository.setChangeReason(client, reason);
        let updated: VitalRow | undefined;
        try {
          updated = (await client.query<VitalRow>(
            `update ehr.vitals set status = 'entered_in_error'
             where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4 and row_version = $5
             returning ${vitalColumns()}`,
            [vitalId, encounterId, patientId, context.facilityId, input.expectedRowVersion],
          )).rows[0];
        } catch (error) {
          throw vitalStatusProblem(error);
        }
        if (!updated) throw new DomainProblem(412, 'VERSION_CONFLICT', VITAL_MESSAGES.versionConflict);
        return { value: updated, resourceId: vitalId };
      },
      (client) => this.repository.exists(client, 'vitals', vitalId, patientId, context.facilityId, encounterId),
    ).catch((error: unknown) => {
      if (error instanceof DomainProblem && error.code === 'CLINICAL_RESOURCE_NOT_FOUND') {
        throw new DomainProblem(404, 'VITAL_NOT_FOUND', VITAL_MESSAGES.notFound);
      }
      throw error;
    });
  }

  private async findVital(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<VitalRow>(
      `select ${vitalColumns()} from ehr.vitals
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4`,
      [id, encounterId, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async findVitalById(client: PoolClient, context: DataAccessContext, patientId: string, id: string) {
    const result = await client.query<VitalRow>(
      `select ${vitalColumns()} from ehr.vitals where id = $1 and patient_id = $2 and facility_id = $3`,
      [id, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async lockVital(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<VitalRow>(
      `select ${vitalColumns()} from ehr.vitals
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4 for update`,
      [id, encounterId, patientId, context.facilityId],
    );
    return this.single(result.rows[0]);
  }

  private async findCorrection(client: PoolClient, context: DataAccessContext, patientId: string, vitalId: string, id: string) {
    const result = await client.query<VitalCorrectionRow>(
      `select ${CORRECTION_COLUMNS} from ehr.vital_corrections
       where id = $1 and vital_id = $2 and patient_id = $3 and facility_id = $4`,
      [id, vitalId, patientId, context.facilityId],
    );
    const row = result.rows[0];
    return row ? vitalCorrectionFromStorage(row) : undefined;
  }

  private single(row: VitalRow | undefined): VitalRow {
    if (!row) throw new DomainProblem(404, 'VITAL_NOT_FOUND', VITAL_MESSAGES.notFound);
    return row;
  }

  private assertMeasurementsGiven(value: VitalMeasurementsDto, whole = true): void {
    // NUR-1 (0174): the observation chart's fields only while NURSING_ENABLED is on; on a new reading, the oxygen and
    // GCS rules (a correction's are checked on the values after it, once the reading is locked).
    requireObservationFieldsAllowed(value, observationFieldsEnabled());
    if (whole) checkObservationRules(value as ObservationValues);
    if (!hasMeasurements(value)) throw new DomainProblem(400, 'VITAL_MEASUREMENT_REQUIRED', 'At least one vital measurement is required');
    if ((value.systolicMmhg === undefined) !== (value.diastolicMmhg === undefined)) {
      throw new DomainProblem(400, 'BLOOD_PRESSURE_INCOMPLETE', 'Systolic and diastolic pressure must be supplied together');
    }
  }
}

/**
 * The status write's database answers: no 0142 column (42703) or any other
 * failure of the write is 503 VITALS_STATUS_UNAVAILABLE; 0142's guard
 * refusing a reading already entered in error (55000) is 409.
 */
function vitalStatusProblem(error: unknown): DomainProblem {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : '';
  if (code === '55000' && message === 'VITAL_ENTERED_IN_ERROR') {
    return new DomainProblem(409, 'VITAL_ALREADY_ENTERED_IN_ERROR', VITAL_MESSAGES.alreadyEnteredInError);
  }
  return new DomainProblem(503, 'VITALS_STATUS_UNAVAILABLE', VITAL_MESSAGES.statusUnavailable);
}

/** VIT-1: a measure's newest value in `vitals/latest`, with its warning (or null). */
export type LatestVitalValueWithWarning = LatestVitalValue & { warning: VitalWarning | null };
export interface LatestVitalsWithWarnings {
  facilityId: string;
  measures: Partial<Record<LatestVitalMeasure, LatestVitalValueWithWarning>>;
  usualRangesVersion: string;
}

/** A reading's values as numbers (numeric columns arrive as strings). */
function vitalValues(row: Pick<VitalRow, WarnedMeasure>): Partial<Record<WarnedMeasure, number | null>> {
  const values: Partial<Record<WarnedMeasure, number | null>> = {};
  for (const measure of ['pulseBpm', 'respiratoryRate', 'oxygenSaturationPercent', 'systolicMmhg', 'diastolicMmhg',
    'temperatureC'] as const) {
    const raw = row[measure];
    values[measure] = raw === null || raw === undefined ? null : Number(raw);
  }
  return values;
}

function warningsOf(values: Partial<Record<WarnedMeasure, number | null>>) {
  return { warnings: vitalWarnings(values), usualRangesVersion: USUAL_RANGES_VERSION };
}

/** A reading entered in error gets no warnings (EHR-C8b), even on a replay of its create or correction. */
function noWarnings() {
  return { warnings: [] as ReturnType<typeof vitalWarnings>, usualRangesVersion: USUAL_RANGES_VERSION };
}

/**
 * A correction's warnings are for the values after it: its values over the
 * reading's own; none once the reading is entered in error.
 */
function correctionWithWarnings(vital: VitalRow, correction: VitalCorrectionRow) {
  if (vital.status === 'entered_in_error') return { ...correction, ...noWarnings() };
  const after = { ...vitalValues(vital) };
  for (const [key, value] of Object.entries(correction.replacementValues)) {
    if (key in after) after[key as WarnedMeasure] = value === null ? null : Number(value);
  }
  return { ...correction, ...warningsOf(after) };
}

function latestWithWarnings(latest: LatestVitals): LatestVitalsWithWarnings {
  const measures: Partial<Record<LatestVitalMeasure, LatestVitalValueWithWarning>> = {};
  for (const [measure, entry] of Object.entries(latest.measures) as [LatestVitalMeasure, LatestVitalValue][]) {
    let warning: VitalWarning | null = null;
    if (measure === 'bloodPressure' && typeof entry.value === 'object') {
      warning = moreSerious(measureWarning('systolicMmhg', entry.value.systolicMmhg),
        measureWarning('diastolicMmhg', entry.value.diastolicMmhg));
    } else if (measure !== 'heightCm' && measure !== 'weightKg' && typeof entry.value === 'number') {
      warning = measureWarning(measure as WarnedMeasure, entry.value);
    }
    measures[measure] = { ...entry, warning };
  }
  return { ...latest, measures, usualRangesVersion: USUAL_RANGES_VERSION };
}

const VITAL_STORAGE_KEYS = {
  heightCm: 'height_cm',
  weightKg: 'weight_kg',
  temperatureC: 'temperature_c',
  pulseBpm: 'pulse_bpm',
  respiratoryRate: 'respiratory_rate',
  systolicMmhg: 'systolic_mmhg',
  diastolicMmhg: 'diastolic_mmhg',
  oxygenSaturationPercent: 'oxygen_saturation_percent',
  // NUR-1 (0174): the observation chart's fields (0174's corrections CHECK lists their keys).
  ...OBSERVATION_FIELD_KEYS,
} as const;

/** NUR-1 (0174): a reading's new fields after a correction: its values, then the correction's over them. */
function observationsAfter(vital: VitalRow, replacement: VitalMeasurementsDto): ObservationValues {
  const after: ObservationValues = {};
  for (const field of Object.keys(OBSERVATION_FIELD_KEYS) as (keyof typeof OBSERVATION_FIELD_KEYS)[]) {
    const corrected = (replacement as ObservationValues)[field];
    after[field] = corrected !== undefined ? corrected : (vital[field] ?? null);
  }
  return after;
}

function latestValue(value: unknown): LatestVitalValue['value'] {
  if (value && typeof value === 'object') {
    const pair = value as { systolicMmhg: unknown; diastolicMmhg: unknown };
    return { systolicMmhg: Number(pair.systolicMmhg), diastolicMmhg: Number(pair.diastolicMmhg) };
  }
  return Number(value);
}

export function vitalMeasurementsToStorage(
  measurements: VitalMeasurementsDto,
): Readonly<Record<string, number | string | boolean>> {
  const stored: Record<string, number | string | boolean> = {};
  for (const [applicationKey, storageKey] of Object.entries(VITAL_STORAGE_KEYS)) {
    const value = measurements[applicationKey as keyof VitalMeasurementsDto];
    if (value !== undefined) stored[storageKey] = value;
  }
  return stored;
}

export function vitalCorrectionFromStorage(row: VitalCorrectionRow): VitalCorrectionRow {
  const applicationValues: Record<string, unknown> = {};
  for (const [applicationKey, storageKey] of Object.entries(VITAL_STORAGE_KEYS)) {
    if (Object.prototype.hasOwnProperty.call(row.replacementValues, storageKey)) {
      applicationValues[applicationKey] = row.replacementValues[storageKey];
    }
  }
  return { ...row, replacementValues: applicationValues };
}
