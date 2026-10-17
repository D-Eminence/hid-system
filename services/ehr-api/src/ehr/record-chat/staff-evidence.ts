import type { PoolClient, QueryResultRow } from 'pg';
import { PATIENT_SECTION_LIMITS, type PatientReleasedRecords } from '../patient-records/patient-release';

/**
 * The records staff record chat may send to the processor (ADR-069): what the
 * asking staff member may already read for this patient, at the facility they
 * selected, for direct care. It is read inside the staff transaction Identity
 * authorized (ClinicalRepository.run), so row-level security admits only that
 * facility's rows under that consent, and the extract is built by the same
 * code as the patient's (buildPatientExtract), so every field, redaction and
 * limit is the same. The shape of PatientReleasedRecords is reused for that
 * reason only: nothing here is the patient's release set.
 *
 * Each category is read only when the member holds the read permission its own
 * routes need (the emergency summary's rule). Not read, and named as withheld
 * so no answer claims completeness: Lab requests and Lab results (Lab is not
 * routed at launch), every other facility's records, the imported legacy
 * history (ADR-067: never chat evidence), the content of documents and the
 * clinicians' own free-text diagnosis notes.
 */
export const STAFF_EVIDENCE_PERMISSIONS = {
  encounters: 'ehr.encounter.read',
  notes: 'ehr.note.read',
  vitals: 'ehr.vital.read',
  diagnoses: 'ehr.diagnosis.read',
  prescriptions: 'ehr.prescription.read',
  documents: 'ehr.document.read',
} as const;
export type StaffEvidenceCategory = keyof typeof STAFF_EVIDENCE_PERMISSIONS;
const STAFF_CATEGORIES = Object.keys(STAFF_EVIDENCE_PERMISSIONS) as StaffEvidenceCategory[];

/** Named as withheld for every staff question: never read by staff chat. */
export const STAFF_ALWAYS_WITHHELD = ['labRequests', 'labResults'] as const;

/** The encounter states whose records staff chat reads: not planned, cancelled or entered in error. */
const OPEN_OR_COMPLETED = "e.status in ('in_progress','on_hold','completed')";

/** Which categories a member with these permissions may have read, in the order the extract names them. */
export function staffEvidenceCategories(permissions: readonly string[]): StaffEvidenceCategory[] {
  return STAFF_CATEGORIES.filter((category) => permissions.includes(STAFF_EVIDENCE_PERMISSIONS[category]));
}

/** Each statement names the patient as $1 and the facility as $2, and nothing else. */
const STAFF_SQL: Readonly<Record<StaffEvidenceCategory, string>> = {
  encounters: `select e.id,e.facility_id as "facilityId",e.encounter_type as "encounterType",
    e.status,e.started_at as "startedAt",e.ended_at as "endedAt" from ehr.encounters e
    where e.patient_id=$1 and e.facility_id=$2 and ${OPEN_OR_COMPLETED}
    order by e.started_at desc,e.id desc`,
  // The current signed or amended revision, never a draft.
  notes: `select n.id,n.encounter_id as "encounterId",n.facility_id as "facilityId",
    n.note_type as "noteType",n.title,n.status,n.current_revision_no as "revisionNo",r.content,n.signed_at as "signedAt"
    from ehr.clinical_notes n join ehr.clinical_note_revisions r
      on r.clinical_note_id=n.id and r.revision_no=n.current_revision_no
      and r.patient_id=n.patient_id and r.facility_id=n.facility_id
    join ehr.encounters e on e.id=n.encounter_id and e.patient_id=n.patient_id and e.facility_id=n.facility_id
    where n.patient_id=$1 and n.facility_id=$2 and n.status in ('signed','amended') and ${OPEN_OR_COMPLETED}
    order by n.signed_at desc,n.id desc`,
  // As first recorded (D8 is open): a vital with a correction is left out, and one entered in error never read.
  vitals: `select v.id,v.encounter_id as "encounterId",v.facility_id as "facilityId",
    v.recorded_at as "recordedAt",v.height_cm as "heightCm",v.weight_kg as "weightKg",
    v.temperature_c as "temperatureC",v.pulse_bpm as "pulseBpm",v.respiratory_rate as "respiratoryRate",
    v.systolic_mmhg as "systolicMmhg",v.diastolic_mmhg as "diastolicMmhg",
    v.oxygen_saturation_percent as "oxygenSaturationPercent",v.source
    from ehr.vitals v join ehr.encounters e on e.id=v.encounter_id and e.patient_id=v.patient_id
      and e.facility_id=v.facility_id
    where v.patient_id=$1 and v.facility_id=$2 and v.status='final' and v.current_correction_no=0
      and ${OPEN_OR_COMPLETED}
    order by v.recorded_at desc,v.id desc`,
  // The clinician's free-text column is never selected.
  diagnoses: `select d.id,d.encounter_id as "encounterId",d.facility_id as "facilityId",
    d.code_system as "codeSystem",d.code,d.display,d.clinical_status as "clinicalStatus",
    d.verification_status as "verificationStatus",d.onset_at as "onsetAt",d.abatement_at as "abatementAt"
    from ehr.diagnoses d join ehr.encounters e on e.id=d.encounter_id and e.patient_id=d.patient_id
      and e.facility_id=d.facility_id
    where d.patient_id=$1 and d.facility_id=$2 and d.verification_status<>'entered_in_error' and ${OPEN_OR_COMPLETED}
    order by d.created_at desc,d.id desc`,
  prescriptions: `select p.id,p.encounter_id as "encounterId",p.facility_id as "facilityId",
    p.medication_code_system as "medicationCodeSystem",p.medication_code as "medicationCode",
    p.medication_display as "medicationDisplay",p.dose_quantity as "doseQuantity",p.dose_unit as "doseUnit",
    p.route_code as "routeCode",p.frequency,p.instructions,p.starts_on as "startsOn",p.ends_on as "endsOn",p.status
    from ehr.prescriptions p join ehr.encounters e on e.id=p.encounter_id and e.patient_id=p.patient_id
      and e.facility_id=p.facility_id
    where p.patient_id=$1 and p.facility_id=$2 and p.status in ('active','on_hold','completed') and ${OPEN_OR_COMPLETED}
    order by p.created_at desc,p.id desc`,
  // Metadata only, and only a document whose latest scan of the exact stored object is clean
  // (ehr.documents_effective): never the file name's content, the file or the storage location.
  documents: `select d.id,d.encounter_id as "encounterId",d.facility_id as "facilityId",
    d.original_file_name as "fileName",coalesce(d.detected_media_type,d.declared_media_type) as "mediaType",
    d.size_bytes as "sizeBytes",d.classification,d.status,d.scan_status as "scanStatus",d.created_at as "createdAt"
    from ehr.documents_effective d join ehr.encounters e on e.id=d.encounter_id and e.patient_id=d.patient_id
      and e.facility_id=d.facility_id
    where d.patient_id=$1 and d.facility_id=$2 and d.status='available' and ${OPEN_OR_COMPLETED}
    order by d.created_at desc,d.id desc`,
};

interface SectionRows { rows: QueryResultRow[]; truncated: boolean }

/** Reads one row more than the section shows, so truncation is known rather than guessed. */
async function section(client: PoolClient, category: StaffEvidenceCategory, values: readonly string[]):
  Promise<SectionRows> {
  const limit = PATIENT_SECTION_LIMITS[category];
  const result = await client.query(`${STAFF_SQL[category]} limit ${limit + 1}`, [...values]);
  return { rows: result.rows.slice(0, limit), truncated: result.rows.length > limit };
}

/**
 * The records of this patient at this facility that a member holding these
 * permissions may send to staff chat. Run it only inside the staff
 * transaction ClinicalRepository.run opens for this patient.
 */
export async function readStaffEvidence(client: PoolClient, patientId: string, facilityId: string,
  permissions: readonly string[]): Promise<PatientReleasedRecords> {
  const read = staffEvidenceCategories(permissions);
  const values = [patientId, facilityId];
  const sections: Partial<Record<StaffEvidenceCategory, SectionRows>> = {};
  for (const category of read) sections[category] = await section(client, category, values);
  const rows = (category: StaffEvidenceCategory) => sections[category]?.rows ?? [];
  return {
    encounters: rows('encounters'),
    notes: rows('notes'),
    vitals: rows('vitals'),
    diagnoses: rows('diagnoses'),
    prescriptions: rows('prescriptions'),
    labRequests: [],
    // size_bytes is a bigint, which pg reads as text; the value is at most 52428800 (0004).
    documents: rows('documents').map((row) => ({ ...row, sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes) })),
    released: [...read],
    withheld: [...STAFF_CATEGORIES.filter((category) => !read.includes(category)), ...STAFF_ALWAYS_WITHHELD],
    limits: Object.fromEntries(read.map((category) => [category, PATIENT_SECTION_LIMITS[category]])),
    truncated: Object.fromEntries(read.map((category) => [category, sections[category]?.truncated ?? false])),
    limit: 50,
  };
}
