import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { Environment } from '../../config/environment';

/**
 * The patient's own record release (INTERFACE_CONTRACT.md, "Record
 * summaries"; owner decision 4 of 2026-10-16; D7). This module is the one
 * definition of what a patient may see of their record: the patient summary
 * reads it, and every later patient-facing reader (record chat, imported
 * records) must read through PatientRecordRelease.read and never with its own
 * SQL. It also tells the database its release set (bind): the patient record
 * release migration's policies and Lab view admit a category only in a
 * transaction whose app.patient_release names it, so with a flag off the
 * database refuses that category as well, and an EHR build that never binds
 * reads nothing beyond encounters and notes. Row-level security restricts
 * rows, not columns: the SELECT lists below are what keep the diagnosis
 * notes, storage locations and staff identities out.
 *
 * Always released: completed encounters and the current signed or amended
 * notes of completed encounters. Released when its flag is on: final vitals
 * never corrected (D8 is open), confirmed diagnoses without the clinician's
 * notes, active, on-hold and completed prescriptions, the latest released and
 * not invalidated Lab result revisions (no correction or release reason), and
 * available PHI documents; each of a completed encounter. Lab requests are
 * never released: an order carries the clinician's clinical information.
 */
export const PATIENT_ALWAYS_RELEASED = ['encounters', 'notes'] as const;
export const PATIENT_RELEASABLE = ['vitals', 'diagnoses', 'prescriptions', 'labResults', 'documents'] as const;
export type PatientReleasable = (typeof PATIENT_RELEASABLE)[number];
export const PATIENT_NEVER_RELEASED = ['labRequests'] as const;

/** The categories named as withheld when not released, in the order the summary always named them. */
const WITHHELD_ORDER = ['vitals', 'diagnoses', 'prescriptions', 'labRequests', 'documents'] as const;

/** The flag that releases each category (default off). */
export const PATIENT_RELEASE_FLAGS = {
  vitals: 'EHR_PATIENT_RELEASE_VITALS',
  diagnoses: 'EHR_PATIENT_RELEASE_DIAGNOSES',
  prescriptions: 'EHR_PATIENT_RELEASE_PRESCRIPTIONS',
  labResults: 'EHR_PATIENT_RELEASE_LAB_RESULTS',
  documents: 'EHR_PATIENT_RELEASE_DOCUMENTS',
} as const satisfies Readonly<Record<PatientReleasable, keyof Environment>>;

/** The categories the environment releases. */
export function configuredPatientRelease(environment: Pick<Environment,
  (typeof PATIENT_RELEASE_FLAGS)[PatientReleasable]>): PatientReleasable[] {
  return PATIENT_RELEASABLE.filter((category) => environment[PATIENT_RELEASE_FLAGS[category]]);
}

/** Rows each section shows at most, newest first; one more is read so truncation is known. */
export const PATIENT_SECTION_LIMITS = {
  encounters: 50, notes: 50, vitals: 100, diagnoses: 100, prescriptions: 100, labResults: 100, documents: 100,
} as const;
type ReleasedSection = keyof typeof PATIENT_SECTION_LIMITS;
/** The single `limit` existing clients read: the smallest section cap, the one encounters and notes have. */
const SUMMARY_LIMIT = 50;

/** The audit count each released category records. */
const COUNT_KEYS: Readonly<Record<ReleasedSection, string>> = {
  encounters: 'encounterCount', notes: 'noteCount', vitals: 'vitalCount', diagnoses: 'diagnosisCount',
  prescriptions: 'prescriptionCount', labResults: 'labResultCount', documents: 'documentCount',
};

/**
 * Database refusals of a released read: a privilege, a relation, a function or
 * a column that is not there, or the pool's statement timeout (a patient with
 * very many rows in a section that cannot stop early, such as documents).
 */
const REFUSED_READ = new Set(['42501', '42P01', '42883', '42703', '57014']);

/** Names the transaction's release set for the release policies and the Lab view. */
const RELEASE_BINDING = "select set_config('app.patient_release',$1,true)";

/** A released Lab result revision, as Lab's own API names its fields. */
export interface PatientLabResult {
  id: string;
  encounterId: string;
  sourceEhrOrderId: string;
  facilityId: string;
  test: { codeSystem: string; code: string; name: string };
  version: number;
  revisionKind: string;
  resultType: string;
  numericValue: number | null;
  textValue: string | null;
  unit: string | null;
  referenceRange: string | null;
  abnormalFlag: string;
  releasedAt: Date | string;
}

/** The patient's released records. labResults is present only when its category is released. */
export interface PatientReleasedRecords {
  encounters: QueryResultRow[];
  notes: QueryResultRow[];
  vitals: QueryResultRow[];
  diagnoses: QueryResultRow[];
  prescriptions: QueryResultRow[];
  labRequests: never[];
  labResults?: PatientLabResult[];
  documents: QueryResultRow[];
  released: string[];
  withheld: string[];
  limits: Record<string, number>;
  truncated: Record<string, boolean>;
  limit: number;
}

interface SectionRows<Row> { rows: Row[]; truncated: boolean }

export class PatientRecordRelease {
  private readonly categories: ReadonlySet<PatientReleasable>;
  /** The database's form of the release set: the released categories, in release order. */
  private readonly setting: string;

  constructor(categories: Iterable<PatientReleasable>) {
    const configured = [...categories];
    for (const category of configured as string[]) {
      if ((PATIENT_NEVER_RELEASED as readonly string[]).includes(category)) {
        throw new Error(`${category} are never released to the patient`);
      }
      if (!(PATIENT_RELEASABLE as readonly string[]).includes(category)) {
        throw new Error(`${category} is not a releasable patient record category`);
      }
    }
    this.categories = new Set(configured);
    this.setting = PATIENT_RELEASABLE.filter((category) => this.categories.has(category)).join(',');
  }

  /**
   * Tells the database, for the rest of this patient-self transaction, which
   * categories it releases (app.patient_release, transaction-local). Every
   * patient read of a releasable category runs after it; read() calls it first.
   */
  async bind(client: PoolClient): Promise<void> {
    await client.query(RELEASE_BINDING, [this.setting]);
  }

  /** Whether this deployment releases the category to the patient. */
  releases(category: PatientReleasable): boolean {
    return this.categories.has(category);
  }

  /**
   * The patient's released records. Run it only inside a patient-self
   * transaction bound to this patient (DatabaseService.withPatientTransaction
   * after IdentityApiService.authorizeSelf): row-level security admits the
   * rows of that binding, and of the categories bind() names, only. A
   * configured category's read that the database refuses or times out is 503
   * PATIENT_RECORDS_UNAVAILABLE, and nothing is returned.
   */
  async read(client: PoolClient, patientId: string): Promise<PatientReleasedRecords> {
    await this.bind(client);
    const values = [patientId];
    const encounters = await section(client, 'encounters', patientEncountersSql(), values);
    const notes = await section(client, 'notes', patientNotesSql(), values);
    const sections: Partial<Record<ReleasedSection, SectionRows<QueryResultRow>>> = { encounters, notes };
    for (const category of PATIENT_RELEASABLE) {
      if (!this.categories.has(category)) continue;
      sections[category] = await refusedAsUnavailable(() => section(client, category, PATIENT_SQL[category], values));
    }
    const released = [...PATIENT_ALWAYS_RELEASED, ...PATIENT_RELEASABLE.filter((category) => this.categories.has(category))];
    const records: PatientReleasedRecords = {
      encounters: encounters.rows,
      notes: notes.rows,
      vitals: sections.vitals?.rows ?? [],
      diagnoses: sections.diagnoses?.rows ?? [],
      prescriptions: sections.prescriptions?.rows ?? [],
      labRequests: [],
      ...(sections.labResults ? { labResults: sections.labResults.rows.map(labResult) } : {}),
      documents: sections.documents?.rows ?? [],
      released,
      withheld: WITHHELD_ORDER.filter((category) => !(released as string[]).includes(category)),
      limits: Object.fromEntries(released.map((name) => [name, PATIENT_SECTION_LIMITS[name]])),
      truncated: Object.fromEntries(released.map((name) => [name, sections[name]?.truncated ?? false])),
      limit: SUMMARY_LIMIT,
    };
    return records;
  }

  /** The success audit's details: the count of each category read, then the withheld ones. Counts only. */
  auditDetails(records: PatientReleasedRecords): Record<string, unknown> {
    const details: Record<string, unknown> = {};
    for (const name of records.released as ReleasedSection[]) {
      details[COUNT_KEYS[name]] = name === 'labResults' ? records.labResults?.length ?? 0 : records[name].length;
    }
    details.withheldCategories = records.withheld;
    return details;
  }
}

async function refusedAsUnavailable<Result>(read: () => Promise<Result>): Promise<Result> {
  try {
    return await read();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && REFUSED_READ.has(code)) {
      throw new DomainProblem(503, 'PATIENT_RECORDS_UNAVAILABLE', 'Patient records are unavailable');
    }
    throw error;
  }
}

/** Reads one row more than the section shows, so truncation is known rather than guessed. */
async function section(client: PoolClient, name: ReleasedSection, sql: string, values: readonly string[]):
  Promise<SectionRows<QueryResultRow>> {
  const limit = PATIENT_SECTION_LIMITS[name];
  const result = await client.query(`${sql} limit ${limit + 1}`, [...values]);
  return { rows: result.rows.slice(0, limit), truncated: result.rows.length > limit };
}

function labResult(row: QueryResultRow): PatientLabResult {
  return {
    id: row.id, encounterId: row.encounterId, sourceEhrOrderId: row.sourceEhrOrderId, facilityId: row.facilityId,
    test: { codeSystem: row.testCodeSystem, code: row.testCode, name: row.testName },
    version: Number(row.version), revisionKind: row.revisionKind, resultType: row.resultType,
    numericValue: row.numericValue === null || row.numericValue === undefined ? null : Number(row.numericValue),
    textValue: row.textValue ?? null, unit: row.unit ?? null, referenceRange: row.referenceRange ?? null,
    abnormalFlag: row.abnormalFlag, releasedAt: row.releasedAt,
  };
}

/** An item's encounter, matched on all three keys of the composite foreign key, and completed (D7). */
function completedEncounter(alias: string): string {
  return `join ehr.encounters e on e.id=${alias}.encounter_id and e.patient_id=${alias}.patient_id
      and e.facility_id=${alias}.facility_id`;
}

/** Completed encounters of every facility: the patient's summary spans facilities. */
export function patientEncountersSql(): string {
  return `select id,facility_id as "facilityId",encounter_type as "encounterType",
    status,started_at as "startedAt",ended_at as "endedAt" from ehr.encounters
    where patient_id=$1 and status='completed' order by started_at desc,id desc`;
}

/** Current signed or amended notes of completed encounters only (PREC-NOTES, 0084). */
export function patientNotesSql(): string {
  return `select n.id,n.encounter_id as "encounterId",n.facility_id as "facilityId",
    n.note_type as "noteType",n.title,n.status,n.current_revision_no as "revisionNo",r.content,n.signed_at as "signedAt"
    from ehr.clinical_notes n join ehr.clinical_note_revisions r
      on r.clinical_note_id=n.id and r.revision_no=n.current_revision_no
      and r.patient_id=n.patient_id and r.facility_id=n.facility_id
    join ehr.encounters e on e.id=n.encounter_id and e.patient_id=n.patient_id and e.facility_id=n.facility_id
    where n.patient_id=$1 and n.status in ('signed','amended') and e.status='completed'
    order by n.signed_at desc,n.id desc`;
}

/**
 * Each releasable category's read, repeating the release policy's predicates
 * as defense in depth. Every statement names the patient as $1 and nothing
 * else: the patient's summary spans facilities. Vitals, diagnoses and
 * prescriptions are ordered as their release index is, so each stops after the
 * rows it shows.
 */
const PATIENT_SQL: Readonly<Record<PatientReleasable, string>> = {
  // As first recorded: a vital with a correction is withheld until D8 decides
  // how a correction is shown, and a vital entered in error is never released.
  vitals: `select v.id,v.encounter_id as "encounterId",v.facility_id as "facilityId",
    v.recorded_at as "recordedAt",v.height_cm as "heightCm",v.weight_kg as "weightKg",
    v.temperature_c as "temperatureC",v.pulse_bpm as "pulseBpm",v.respiratory_rate as "respiratoryRate",
    v.systolic_mmhg as "systolicMmhg",v.diastolic_mmhg as "diastolicMmhg",
    v.oxygen_saturation_percent as "oxygenSaturationPercent",v.source
    from ehr.vitals v ${completedEncounter('v')}
    where v.patient_id=$1 and v.status='final' and v.current_correction_no=0 and e.status='completed'
    order by v.recorded_at desc,v.id desc`,
  // The clinician's free-text column is never selected.
  diagnoses: `select d.id,d.encounter_id as "encounterId",d.facility_id as "facilityId",
    d.code_system as "codeSystem",d.code,d.display,d.clinical_status as "clinicalStatus",
    d.verification_status as "verificationStatus",d.onset_at as "onsetAt",d.abatement_at as "abatementAt"
    from ehr.diagnoses d ${completedEncounter('d')}
    where d.patient_id=$1 and d.verification_status='confirmed' and e.status='completed'
    order by d.created_at desc,d.id desc`,
  prescriptions: `select p.id,p.encounter_id as "encounterId",p.facility_id as "facilityId",
    p.medication_code_system as "medicationCodeSystem",p.medication_code as "medicationCode",
    p.medication_display as "medicationDisplay",p.dose_quantity as "doseQuantity",p.dose_unit as "doseUnit",
    p.route_code as "routeCode",p.frequency,p.instructions,p.starts_on as "startsOn",p.ends_on as "endsOn",p.status
    from ehr.prescriptions p ${completedEncounter('p')}
    where p.patient_id=$1 and p.status in ('active','on_hold','completed') and e.status='completed'
    order by p.created_at desc,p.id desc`,
  // Lab's released truth, through the view that admits only the bound
  // patient's latest released, not invalidated revisions (no reasons).
  labResults: `select result_id as id,encounter_id as "encounterId",source_ehr_order_id as "sourceEhrOrderId",
    facility_id as "facilityId",test_code_system as "testCodeSystem",test_code as "testCode",test_name as "testName",
    version,revision_kind as "revisionKind",result_type as "resultType",numeric_value as "numericValue",
    text_value as "textValue",unit,reference_range as "referenceRange",abnormal_flag as "abnormalFlag",
    released_at as "releasedAt"
    from ehr.patient_released_lab_results where patient_id=$1
    order by released_at desc,result_id desc`,
  // Available only when the latest scan of the exact stored object is clean
  // (0009); never the storage location: the download route signs a URL.
  documents: `select d.id,d.encounter_id as "encounterId",d.facility_id as "facilityId",
    d.original_file_name as "fileName",coalesce(d.detected_media_type,d.declared_media_type) as "mediaType",
    d.size_bytes as "sizeBytes",d.classification,d.status,d.scan_status as "scanStatus",d.created_at as "createdAt"
    from ehr.documents_effective d ${completedEncounter('d')}
    where d.patient_id=$1 and d.status='available' and d.classification='phi' and e.status='completed'
    order by d.created_at desc,d.id desc`,
};
