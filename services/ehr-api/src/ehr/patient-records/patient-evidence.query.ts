import { LOINC_SYSTEM_SQL_PATTERN, SENSITIVE_LOINC_SQL_LIST, SENSITIVE_TEST_SQL_PATTERN } from './patient-evidence.policy';

// Every relation is protected by patient-self RLS (patient chat) or facility and
// consent RLS (staff chat). No source payload or clinical identifiers are
// interpolated. Stable keyset pages prevent the old 50-row cutoff.
// origin_hint tells where a row came from beyond its kind (evidenceOrigin): an
// imported record's recorded origin, or 'scanned_paper' for a clinical note
// read from a scanned paper record. A note is known to be one by its OCR
// provenance row (readable by staff at the importing facility) or, where that
// row is not readable (the patient's own session, another facility), by its
// first revision, which only the OCR import writes with this fixed reason
// (ClinicalNotesService.createImportedFromOcr). A later amendment hides the
// first revision from the patient's session, so such a note then reads as a
// health worker's until the patient may read the provenance row.
const BASE_EVIDENCE_QUERY = `with sources as (
 select 'note' kind,n.id,n.patient_id,n.current_revision_no::text version,coalesce(n.title,'Clinical note') title,
 r.created_at recorded_at,n.signed_at effective_at,'Signed clinical note' provenance,'released' quality,
 jsonb_build_object('_encounterId',n.encounter_id,'noteType',n.note_type,'text',r.content,'signedAt',n.signed_at,'revisionRecordedAt',r.created_at) fields,
 case when (r.revision_no=1 and r.change_reason='OCR import from human-validated source evidence')
 or exists(select 1 from ehr.ocr_import_provenance o where o.clinical_resource_type='clinical_note' and o.clinical_resource_id=n.id
 and o.patient_id=n.patient_id) then 'scanned_paper' end origin_hint
 from ehr.clinical_notes n join ehr.clinical_note_revisions r on r.clinical_note_id=n.id
 and r.revision_no=n.current_revision_no and r.patient_id=n.patient_id and r.facility_id=n.facility_id
 where n.status in ('signed','amended')
 union all select 'encounter',e.id,e.patient_id,e.row_version::text,'Encounter: '||e.encounter_type,
 e.ended_at,e.started_at,'Completed encounter','recorded',jsonb_build_object('_encounterId',e.id,'type',e.encounter_type,'startedAt',e.started_at,'endedAt',e.ended_at,'status',e.status),null
 from ehr.encounters e where e.status='completed'
 union all select 'diagnosis',d.id,d.patient_id,d.row_version::text,d.display,d.created_at,d.onset_at,
 'Clinician recorded condition',d.verification_status,jsonb_build_object('_encounterId',d.encounter_id,'codeSystem',d.code_system,'code',d.code,'condition',d.display,'clinicalStatus',d.clinical_status,'verificationStatus',d.verification_status,'onsetAt',d.onset_at,'abatementAt',d.abatement_at,'notes',d.notes),null
 from ehr.diagnoses d where d.verification_status<>'entered_in_error'
 union all select 'prescription',p.id,p.patient_id,p.row_version::text,p.medication_display,p.created_at,p.starts_on::timestamptz,
 'Clinician prescription',p.status,jsonb_build_object('_encounterId',p.encounter_id,'medication',p.medication_display,'doseQuantity',p.dose_quantity,'doseUnit',p.dose_unit,'route',p.route_code,'frequency',p.frequency,'instructions',p.instructions,'startsOn',p.starts_on,'endsOn',p.ends_on,'status',p.status),null
 from ehr.prescriptions p where p.status not in ('draft','entered_in_error')
 union all select 'investigation',l.id,l.patient_id,l.row_version::text,l.test_display,l.created_at,l.created_at,
 'Investigation order',l.status,jsonb_build_object('_encounterId',l.encounter_id,'test',l.test_display,'codeSystem',l.test_code_system,'code',l.test_code,'status',l.status,'priority',l.priority,'information',l.clinical_information),null
 from ehr.lab_requests l where l.status not in ('draft','entered_in_error')
 union all select 'vital',v.id,v.patient_id,v.row_version::text,'Vital measurements',v.recorded_at,v.recorded_at,
 'Recorded vital measurements','recorded',
 (to_jsonb(v)-array['id','encounter_id','patient_id','facility_id','created_by','created_by_membership_id','created_at','updated_at','row_version','current_correction_no'])||coalesce(c.replacement_values,'{}'::jsonb)||jsonb_build_object('_encounterId',v.encounter_id),null
 from ehr.vitals v left join ehr.vital_corrections c on c.vital_id=v.id and c.correction_no=v.current_correction_no and c.patient_id=v.patient_id
 union all select 'import',r.id,r.patient_id,v.id::text,coalesce(r.source_payload->>'title','Imported medical record'),
 v.source_created_at,v.source_created_at,case when r.origin='patient-provided' then 'Patient reported imported history' else 'Provider authored imported history; original verification not inferred' end,'imported',
 jsonb_build_object('category',r.source_payload->>'category','infoType',r.source_payload->>'info_type','record',v.source_payload->'record','notes',v.source_payload->'notes','structuredData',v.source_payload->'structured_data','transcriptionText',v.source_payload->'transcription_text','transcriptionStatus','original source text; extraction quality not independently verified'),r.origin
 from ehr.imported_medical_records r join ehr.imported_medical_record_versions v on v.id=r.current_version_id and v.record_id=r.id and v.patient_id=r.patient_id
 union all select 'import_version',v.id,v.patient_id,v.version_no::text,
 'Prior version of '||coalesce(r.source_payload->>'title','imported history'),v.source_created_at,v.source_created_at,
 case when v.origin='patient-provided' then 'Patient reported imported history' else 'Provider authored imported history; original verification not inferred' end,
 'superseded imported version; historical evidence, not current clinical truth',
 jsonb_build_object('record',v.source_payload->'record','notes',v.source_payload->'notes','structuredData',v.source_payload->'structured_data',
 'transcriptionText',v.source_payload->'transcription_text','versionNo',v.version_no,'superseded',true),v.origin
 from ehr.imported_medical_record_versions v join ehr.imported_medical_records r on r.id=v.record_id and r.patient_id=v.patient_id
 where v.id<>r.current_version_id
 union all select 'health_profile',p.patient_id,p.patient_id,p.source_updated_at::text,'Imported health profile',p.source_updated_at,p.source_updated_at,
 'Imported patient health profile','imported',p.clinical_payload,null from ehr.imported_patient_health_profiles p
)
select kind,id,version,title,recorded_at,effective_at,provenance,quality,fields,origin_hint from sources
where patient_id=$1 and (kind,id::text)>($2::text,$3::text) order by kind,id::text limit 201`;

export type EvidenceAudience = 'patient' | 'staff';

/** Replaces exactly one occurrence, so a missed or repeated anchor fails loudly instead of silently. */
function replaceOnce(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error(`Evidence query anchor must occur exactly once: ${from.slice(0, 60)}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}
const SELECT = 'select kind,id,version,title,recorded_at,effective_at,provenance,quality,fields,origin_hint from sources';
const SELECT_WITH_PATIENT = 'select kind,id,version,title,recorded_at,effective_at,provenance,quality,fields,origin_hint,patient_id from sources';
const completedEncounter = (alias: string) =>
  `join ehr.encounters e on e.id=${alias}.encounter_id and e.patient_id=${alias}.patient_id and e.facility_id=${alias}.facility_id and e.status='completed'`;
const VITAL_FIELDS_SQL = "jsonb_build_object('recorded_at',v.recorded_at,'height_cm',v.height_cm,'weight_kg',v.weight_kg,"
  + "'temperature_c',v.temperature_c,'pulse_bpm',v.pulse_bpm,'respiratory_rate',v.respiratory_rate,'systolic_mmhg',v.systolic_mmhg,"
  + "'diastolic_mmhg',v.diastolic_mmhg,'oxygen_saturation_percent',v.oxygen_saturation_percent,'source',v.source)";

/**
 * Staff: exactly the query the staff chat has always used (its source
 * permission filter $4, completed-encounter diagnoses and vitals), with the
 * row's patient_id so the caller can check every row is its one patient.
 * Nothing the patient chat leaves out is removed here: staff keeps refuted
 * diagnoses with their notes, request reasons and cancelled items, each
 * labelled by its status.
 *
 * Patient: the patient-self rows the patient chat may use (patient-evidence.policy.ts
 * re-checks every rule): notes, prescriptions and test requests only from a
 * completed visit; confirmed diagnoses without the clinician's notes; active,
 * on-hold or completed prescriptions without free-text instructions; active,
 * on-hold or completed test requests without the clinical reason or priority,
 * and never a sensitive test; vitals as an explicit list of measures.
 */
export function evidenceQuery(audience: EvidenceAudience): string {
  let q = BASE_EVIDENCE_QUERY;
  if (audience === 'staff') {
    q = replaceOnce(q, 'where patient_id=$1 and (kind', 'where patient_id=$1 and kind=any($4::text[]) and (kind');
    q = replaceOnce(q, "from ehr.diagnoses d where d.verification_status<>'entered_in_error'", "from ehr.diagnoses d where d.verification_status<>'entered_in_error' and exists(select 1 from ehr.encounters e where e.id=d.encounter_id and e.patient_id=d.patient_id and e.facility_id=d.facility_id and e.status='completed')");
    q = replaceOnce(q, 'from ehr.vitals v left join', "from ehr.vitals v join ehr.encounters e on e.id=v.encounter_id and e.patient_id=v.patient_id and e.facility_id=v.facility_id and e.status='completed' left join");
    return replaceOnce(q, SELECT, SELECT_WITH_PATIENT);
  }
  if (audience !== 'patient') throw new Error('Unknown evidence audience');
  // Notes: only from a completed visit (withdrawn and unfinished visits are left out).
  q = replaceOnce(q, "jsonb_build_object('_encounterId',n.encounter_id,'noteType'", "jsonb_build_object('_encounterId',n.encounter_id,'_encounterStatus',e.status,'noteType'");
  q = replaceOnce(q, 'from ehr.clinical_notes n join ehr.clinical_note_revisions r', `from ehr.clinical_notes n ${completedEncounter('n')} join ehr.clinical_note_revisions r`);
  // Diagnoses: confirmed only, and never the clinician's notes.
  q = replaceOnce(q, ",'onsetAt',d.onset_at,'abatementAt',d.abatement_at,'notes',d.notes)", ",'onsetAt',d.onset_at,'abatementAt',d.abatement_at)");
  q = replaceOnce(q, "from ehr.diagnoses d where d.verification_status<>'entered_in_error'", "from ehr.diagnoses d where d.verification_status='confirmed'");
  // Prescriptions: current or finished ones from a completed visit, without free-text instructions.
  // The medicine's code goes to the policy (an ATC L01/L02 code is sensitive) as internal keys, which it strips.
  q = replaceOnce(q, "jsonb_build_object('_encounterId',p.encounter_id,", "jsonb_build_object('_encounterId',p.encounter_id,'_encounterStatus',e.status,"
    + "'_medicationCodeSystem',p.medication_code_system,'_medicationCode',p.medication_code,");
  q = replaceOnce(q, ",'frequency',p.frequency,'instructions',p.instructions,", ",'frequency',p.frequency,");
  q = replaceOnce(q, "from ehr.prescriptions p where p.status not in ('draft','entered_in_error')", `from ehr.prescriptions p ${completedEncounter('p')} where p.status in ('active','on_hold','completed')`);
  // Test requests: current or finished ones from a completed visit, without the reason or priority; no sensitive test.
  q = replaceOnce(q, "jsonb_build_object('_encounterId',l.encounter_id,", "jsonb_build_object('_encounterId',l.encounter_id,'_encounterStatus',e.status,");
  q = replaceOnce(q, ",'status',l.status,'priority',l.priority,'information',l.clinical_information)", ",'status',l.status)");
  q = replaceOnce(q, "from ehr.lab_requests l where l.status not in ('draft','entered_in_error')",
    `from ehr.lab_requests l ${completedEncounter('l')} where l.status in ('active','on_hold','completed') and coalesce(l.test_display,'') !~* '${SENSITIVE_TEST_SQL_PATTERN}'`
    + ` and not (btrim(coalesce(l.test_code_system,'')) ~* '${LOINC_SYSTEM_SQL_PATTERN}' and btrim(coalesce(l.test_code,'')) in (${SENSITIVE_LOINC_SQL_LIST}))`);
  // Vitals: an explicit list of measures, so a future column cannot leak.
  q = replaceOnce(q, "(to_jsonb(v)-array['id','encounter_id','patient_id','facility_id','created_by','created_by_membership_id','created_at','updated_at','row_version','current_correction_no'])", VITAL_FIELDS_SQL);
  return replaceOnce(q, SELECT, SELECT_WITH_PATIENT);
}
/** Params $1 patient id, $2/$3 keyset cursor. */
export const PATIENT_EVIDENCE_QUERY = evidenceQuery('patient');
/** Params $1 patient id, $2/$3 keyset cursor, $4 the source kinds the staff member may read. */
export const STAFF_EVIDENCE_QUERY = evidenceQuery('staff');
