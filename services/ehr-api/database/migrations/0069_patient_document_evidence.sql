-- Native scanned documents become readable only through a completed encounter;
-- draft/unattached provider documents do not acquire patient visibility.
create policy documents_patient_self_read on ehr.documents for select using
 (ehr.patient_self_context(patient_id) and status='uploaded' and exists(select 1 from ehr.encounters e
 where e.id=encounter_id and e.patient_id=documents.patient_id and e.status='completed'));
create policy document_scans_patient_self_read on ehr.document_scan_events for select using
 (ehr.patient_self_context(patient_id) and exists(select 1 from ehr.documents d where d.id=document_id and d.patient_id=document_scan_events.patient_id));
alter table ehr.documents add unique(id,patient_id,facility_id,object_version_id,sha256_hex);
create table ehr.patient_document_extractions
 (like ehr.patient_attachment_extractions including defaults including constraints including indexes);
alter table ehr.patient_document_extractions add column facility_id uuid not null;
alter table ehr.patient_document_extractions add foreign key(file_id,patient_id,facility_id,object_version_id,sha256_hex)
 references ehr.documents(id,patient_id,facility_id,object_version_id,sha256_hex) on delete restrict;
alter table ehr.patient_document_extractions enable row level security;
alter table ehr.patient_document_extractions force row level security;
create policy patient_document_text_self on ehr.patient_document_extractions
 using(ehr.patient_self_context(patient_id) and exists(select 1 from ehr.documents_effective d where
 d.id=file_id and d.patient_id=patient_document_extractions.patient_id and d.status='available'
 and d.object_version_id=patient_document_extractions.object_version_id and d.sha256_hex=patient_document_extractions.sha256_hex))
 with check(ehr.patient_self_context(patient_id) and exists(select 1 from ehr.documents_effective d where
 d.id=file_id and d.patient_id=patient_document_extractions.patient_id and d.status='available'
 and d.object_version_id=patient_document_extractions.object_version_id and d.sha256_hex=patient_document_extractions.sha256_hex));
revoke all on ehr.patient_document_extractions from public;
alter table ehr.patient_evidence_chunks drop constraint patient_evidence_chunks_source_kind_check;
alter table ehr.patient_evidence_chunks add check(source_kind in ('note','encounter','diagnosis','prescription',
 'investigation','vital','import','import_version','health_profile','lab_result','attachment','document','profile'));
do $$ begin if exists(select 1 from pg_roles where rolname='hid_ehr_runtime') then
 grant select,insert,update on ehr.patient_document_extractions to hid_ehr_runtime;
end if;end $$;
