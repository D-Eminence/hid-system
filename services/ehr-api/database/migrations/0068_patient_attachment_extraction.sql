-- Imported file OCR remains derived, explicitly unverified text; original
-- medical records and files are never rewritten or promoted to signed notes.
create table ehr.patient_attachment_extractions (
 file_id uuid not null,patient_id uuid not null,object_version_id text not null,
 sha256_hex char(64) not null,extractor_version integer not null default 1 check(extractor_version=1),
 status text not null check(status in ('processing','ready','partial','unreadable','failed')),
 job_id text not null check(length(job_id) between 1 and 64),next_token text,
 extracted_text text not null default '' check(length(extracted_text)<=200000),
 minimum_confidence numeric,unclear_lines integer not null default 0 check(unclear_lines>=0),
 page_count integer not null default 0 check(page_count>=0),
 started_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 primary key(file_id,object_version_id,sha256_hex,extractor_version),
 foreign key(file_id,patient_id,sha256_hex,object_version_id)
 references ehr.imported_attachment_bindings(file_id,patient_id,sha256_hex,object_version_id) on delete restrict
);
alter table ehr.patient_attachment_extractions enable row level security;
alter table ehr.patient_attachment_extractions force row level security;
create policy patient_extractions_self on ehr.patient_attachment_extractions
 using(ehr.patient_self_context(patient_id) and (select s.result from ehr.imported_attachment_scan_events s
 where s.file_id=patient_attachment_extractions.file_id and s.patient_id=patient_attachment_extractions.patient_id
 and s.sha256_hex=patient_attachment_extractions.sha256_hex and s.object_version_id=patient_attachment_extractions.object_version_id
 order by s.sequence_id desc limit 1)='clean')
 with check(ehr.patient_self_context(patient_id) and (select s.result from ehr.imported_attachment_scan_events s
 where s.file_id=patient_attachment_extractions.file_id and s.patient_id=patient_attachment_extractions.patient_id
 and s.sha256_hex=patient_attachment_extractions.sha256_hex and s.object_version_id=patient_attachment_extractions.object_version_id
 order by s.sequence_id desc limit 1)='clean');
revoke all on ehr.patient_attachment_extractions from public;
do $$ begin if exists(select 1 from pg_roles where rolname='hid_ehr_runtime') then
 grant select,insert,update on ehr.patient_attachment_extractions to hid_ehr_runtime;
end if;end $$;
