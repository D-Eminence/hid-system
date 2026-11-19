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
import { ClinicalRepository, type OperationResult } from '../shared/clinical.repository';

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

const VITAL_COLUMNS = `
  id, encounter_id as "encounterId", patient_id as "patientId", facility_id as "facilityId",
  created_by as "createdBy", created_by_membership_id as "createdByMembershipId",
  recorded_at as "recordedAt", height_cm as "heightCm", weight_kg as "weightKg",
  temperature_c as "temperatureC", pulse_bpm as "pulseBpm", respiratory_rate as "respiratoryRate",
  systolic_mmhg as "systolicMmhg", diastolic_mmhg as "diastolicMmhg",
  oxygen_saturation_percent as "oxygenSaturationPercent", source,
  current_correction_no as "currentCorrectionNo", row_version as "rowVersion",
  created_at as "createdAt", updated_at as "updatedAt"`;

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
 * reading. Vitals of a visit entered in error are left out.
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

@Injectable()
export class VitalsService {
  constructor(private readonly repository: ClinicalRepository) {}

  /**
   * EHR-C3: the newest value of each measure for the patient at this
   * facility (GET ehr/patients/:patientId/vitals/latest). Read under the
   * patient's consent and audited (`ehr.vital.latest`, with the count of
   * measures, never the values); a refusal is audited by the repository.
   */
  latest(context: DataAccessContext, patientId: string): Promise<LatestVitals> {
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.vital.latest', resourceType: 'vital' },
      async (client) => {
        const result = await client.query<LatestVitalRow>(LATEST_VITALS_SQL, [patientId, context.facilityId]);
        const measures: Partial<Record<LatestVitalMeasure, LatestVitalValue>> = {};
        for (const row of result.rows) {
          if (!LATEST_VITAL_MEASURES.includes(row.measure)) continue;
          measures[row.measure] = { value: latestValue(row.value), recordedAt: row.recordedAt, vitalId: row.vitalId,
            encounterId: row.encounterId, corrected: row.corrected === true };
        }
        return { value: { facilityId: context.facilityId, measures },
          details: { measureCount: Object.keys(measures).length } };
      },
    );
  }

  list(context: DataAccessContext, patientId: string, encounterId: string, query: TimelineQueryDto) {
    const scope = { list: 'ehr.vitals', patientId, encounterId };
    const cursor = decodeTimelineCursor(query.cursor, scope);
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.vital.list', resourceType: 'vital', resourceId: encounterId },
      async (client) => {
        const result = await client.query<VitalRow & { cursorAt: string }>(
          `select ${VITAL_COLUMNS}, ${timelineCursorSql('recorded_at')} as "cursorAt" from ehr.vitals
           where encounter_id = $1 and patient_id = $2 and facility_id = $3
             and ($4::timestamptz is null or (recorded_at, id) < ($4::timestamptz, $5::uuid))
           order by recorded_at desc, id desc limit $6`,
          [encounterId, patientId, context.facilityId, cursor?.sortAt ?? null, cursor?.id ?? null, query.limit + 1],
        );
        const page = timelinePage(result.rows, query.limit, scope);
        return { value: page, details: { resultCount: page.items.length } };
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

  create(context: DataAccessContext, patientId: string, encounterId: string, input: CreateVitalDto, key: string) {
    this.assertMeasurements(input);
    return this.repository.run(
      context, patientId, 'write_records', { action: 'ehr.vital.create', resourceType: 'vital' },
      (client) => this.createInTransaction(client, context, patientId, encounterId, input, key),
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
  }

  /** The checks a vitals create runs before the database is touched (also EHR-C5's one-call consultation). */
  checkCreate(input: CreateVitalDto): void {
    this.assertMeasurements(input);
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
        const result = await client.query<VitalRow>(
          `insert into ehr.vitals (
             encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
             recorded_at, height_cm, weight_kg, temperature_c, pulse_bpm, respiratory_rate,
             systolic_mmhg, diastolic_mmhg, oxygen_saturation_percent, source
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           returning ${VITAL_COLUMNS}`,
          [
            encounterId, patientId, context.facilityId, context.actor.accountId, context.membershipId,
            input.recordedAt, input.heightCm ?? null, input.weightKg ?? null, input.temperatureC ?? null,
            input.pulseBpm ?? null, input.respiratoryRate ?? null, input.systolicMmhg ?? null,
            input.diastolicMmhg ?? null, input.oxygenSaturationPercent ?? null, input.source,
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
    this.assertMeasurements(input.replacementValues);
    const operation = 'vital-correction.create';
    const digest = requestDigest(operation, { patientId, encounterId, vitalId, input });
    return this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.vital-correction.create', resourceType: 'vital-correction' },
      (client) => this.repository.executeCreate(
        client, context, patientId, key, operation, digest, 'vital-correction',
        async () => {
          const vital = await this.lockVital(client, context, patientId, encounterId, vitalId);
          if (Number(vital.rowVersion) !== input.expectedRowVersion) {
            throw new DomainProblem(412, 'VERSION_CONFLICT', 'Vitals changed since they were loaded');
          }
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
          if (updated.rowCount !== 1) throw new DomainProblem(412, 'VERSION_CONFLICT', 'Vitals changed since they were loaded');
          const storedCorrection = result.rows[0];
          if (!storedCorrection) throw new DomainProblem(500, 'CORRECTION_CREATE_FAILED', 'Vital correction could not be created');
          const correction = vitalCorrectionFromStorage(storedCorrection);
          return { value: correction, id: correction.id };
        },
        (id) => this.findCorrection(client, context, patientId, vitalId, id),
      ),
      (client) => this.repository.exists(client, 'vitals', vitalId, patientId, context.facilityId, encounterId),
    );
  }

  private async findVital(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<VitalRow>(
      `select ${VITAL_COLUMNS} from ehr.vitals
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4`,
      [id, encounterId, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async findVitalById(client: PoolClient, context: DataAccessContext, patientId: string, id: string) {
    const result = await client.query<VitalRow>(
      `select ${VITAL_COLUMNS} from ehr.vitals where id = $1 and patient_id = $2 and facility_id = $3`,
      [id, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async lockVital(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<VitalRow>(
      `select ${VITAL_COLUMNS} from ehr.vitals
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
    if (!row) throw new DomainProblem(404, 'VITAL_NOT_FOUND', 'Vital observation was not found');
    return row;
  }

  private assertMeasurements(value: VitalMeasurementsDto): void {
    if (!hasMeasurements(value)) throw new DomainProblem(400, 'VITAL_MEASUREMENT_REQUIRED', 'At least one vital measurement is required');
    if ((value.systolicMmhg === undefined) !== (value.diastolicMmhg === undefined)) {
      throw new DomainProblem(400, 'BLOOD_PRESSURE_INCOMPLETE', 'Systolic and diastolic pressure must be supplied together');
    }
  }
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
} as const;

function latestValue(value: unknown): LatestVitalValue['value'] {
  if (value && typeof value === 'object') {
    const pair = value as { systolicMmhg: unknown; diastolicMmhg: unknown };
    return { systolicMmhg: Number(pair.systolicMmhg), diastolicMmhg: Number(pair.diastolicMmhg) };
  }
  return Number(value);
}

export function vitalMeasurementsToStorage(
  measurements: VitalMeasurementsDto,
): Readonly<Record<string, number>> {
  const stored: Record<string, number> = {};
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
