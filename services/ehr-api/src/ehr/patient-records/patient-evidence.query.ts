// Every relation is protected by patient-self RLS. No source payload or clinical
// identifiers are interpolated. Stable keyset pages prevent the old 50-row cutoff.
export const LOCAL_EVIDENCE_QUERY = `with sources as (
 select 'note' kind,n.id,n.patient_id,n.current_revision_no::text version,coalesce(n.title,'Clinical note') title,
 r.created_at recorded_at,n.signed_at effective_at,'Signed clinical note' provenance,'released' quality,
 jsonb_build_object('_encounterId',n.encounter_id,'noteType',n.note_type,'text',r.content,'signedAt',n.signed_at,'revisionRecordedAt',r.created_at) fields
 from ehr.clinical_notes n join ehr.clinical_note_revisions r on r.clinical_note_id=n.id
 and r.revision_no=n.current_revision_no and r.patient_id=n.patient_id and r.facility_id=n.facility_id
 where n.status in ('signed','amended')
 union all select 'encounter',e.id,e.patient_id,e.row_version::text,'Encounter: '||e.encounter_type,
 e.ended_at,e.started_at,'Completed encounter','recorded',jsonb_build_object('_encounterId',e.id,'type',e.encounter_type,'startedAt',e.started_at,'endedAt',e.ended_at,'status',e.status)
 from ehr.encounters e where e.status='completed'
 union all select 'diagnosis',d.id,d.patient_id,d.row_version::text,d.display,d.created_at,d.onset_at,
 'Clinician recorded condition',d.verification_status,jsonb_build_object('_encounterId',d.encounter_id,'codeSystem',d.code_system,'code',d.code,'condition',d.display,'clinicalStatus',d.clinical_status,'verificationStatus',d.verification_status,'onsetAt',d.onset_at,'abatementAt',d.abatement_at,'notes',d.notes)
 from ehr.diagnoses d where d.verification_status<>'entered_in_error'
 union all select 'prescription',p.id,p.patient_id,p.row_version::text,p.medication_display,p.created_at,p.starts_on::timestamptz,
 'Clinician prescription',p.status,jsonb_build_object('_encounterId',p.encounter_id,'medication',p.medication_display,'doseQuantity',p.dose_quantity,'doseUnit',p.dose_unit,'route',p.route_code,'frequency',p.frequency,'instructions',p.instructions,'startsOn',p.starts_on,'endsOn',p.ends_on,'status',p.status)
 from ehr.prescriptions p where p.status not in ('draft','entered_in_error')
 union all select 'investigation',l.id,l.patient_id,l.row_version::text,l.test_display,l.created_at,l.created_at,
 'Investigation order',l.status,jsonb_build_object('_encounterId',l.encounter_id,'test',l.test_display,'codeSystem',l.test_code_system,'code',l.test_code,'status',l.status,'priority',l.priority,'information',l.clinical_information)
 from ehr.lab_requests l where l.status not in ('draft','entered_in_error')
 union all select 'vital',v.id,v.patient_id,v.row_version::text,'Vital measurements',v.recorded_at,v.recorded_at,
 'Recorded vital measurements','recorded',
 (to_jsonb(v)-array['id','encounter_id','patient_id','facility_id','created_by','created_by_membership_id','created_at','updated_at','row_version','current_correction_no'])||coalesce(c.replacement_values,'{}'::jsonb)||jsonb_build_object('_encounterId',v.encounter_id)
 from ehr.vitals v left join ehr.vital_corrections c on c.vital_id=v.id and c.correction_no=v.current_correction_no and c.patient_id=v.patient_id
 union all select 'import',r.id,r.patient_id,v.id::text,coalesce(r.source_payload->>'title','Imported medical record'),
 v.source_created_at,v.source_created_at,case when r.origin='patient-provided' then 'Patient reported imported history' else 'Provider authored imported history; original verification not inferred' end,'imported',
 jsonb_build_object('category',r.source_payload->>'category','infoType',r.source_payload->>'info_type','record',v.source_payload->'record','notes',v.source_payload->'notes','structuredData',v.source_payload->'structured_data','transcriptionText',v.source_payload->'transcription_text','transcriptionStatus','original source text; extraction quality not independently verified')
 from ehr.imported_medical_records r join ehr.imported_medical_record_versions v on v.id=r.current_version_id and v.record_id=r.id and v.patient_id=r.patient_id
 union all select 'import_version',v.id,v.patient_id,v.version_no::text,
 'Prior version of '||coalesce(r.source_payload->>'title','imported history'),v.source_created_at,v.source_created_at,
 case when v.origin='patient-provided' then 'Patient reported imported history' else 'Provider authored imported history; original verification not inferred' end,
 'superseded imported version; historical evidence, not current clinical truth',
 jsonb_build_object('record',v.source_payload->'record','notes',v.source_payload->'notes','structuredData',v.source_payload->'structured_data',
 'transcriptionText',v.source_payload->'transcription_text','versionNo',v.version_no,'superseded',true)
 from ehr.imported_medical_record_versions v join ehr.imported_medical_records r on r.id=v.record_id and r.patient_id=v.patient_id
 where v.id<>r.current_version_id
 union all select 'health_profile',p.patient_id,p.patient_id,p.source_updated_at::text,'Imported health profile',p.source_updated_at,p.source_updated_at,
 'Imported patient health profile','imported',p.clinical_payload from ehr.imported_patient_health_profiles p
)
select kind,id,version,title,recorded_at,effective_at,provenance,quality,fields from sources
where patient_id=$1 and (kind,id::text)>($2::text,$3::text) order by kind,id::text limit 201`;
