-- Additive staff chat storage. This migration never rewrites clinical rows.
create function ehr.staff_chat_context(p uuid,f uuid,a uuid,m uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
 select coalesce(platform.current_correlation_id() is not null and platform.current_purpose_of_use()='direct-care'
 and p=nullif(current_setting('app.chat_patient_id',true),'')::uuid
 and f=platform.current_facility_id() and m=platform.current_membership_id()
 and a=platform.current_account_id()
 and a=nullif(current_setting('app.chat_account_id',true),'')::uuid
 and nullif(current_setting('app.chat_authorized_until',true),'')::timestamptz>statement_timestamp()
 and nullif(current_setting('app.chat_authorized_until',true),'')::timestamptz<=statement_timestamp()+interval '60 seconds'
 and identity.has_active_membership(platform.current_actor_subject(),m,f)
 and ehr.context_allows(p,f,'read_records'),false)
$$;
revoke all on function ehr.staff_chat_context(uuid,uuid,uuid,uuid) from public;

create table ehr.staff_chat_state (like ehr.patient_chat_state including defaults including constraints,
 facility_id uuid not null default nullif(current_setting('app.facility_id',true),'')::uuid,
 account_id uuid not null default nullif(current_setting('app.chat_account_id',true),'')::uuid,
 membership_id uuid not null default nullif(current_setting('app.membership_id',true),'')::uuid,
 purpose_of_use text not null default 'direct-care' check(purpose_of_use='direct-care')
,primary key(patient_id,facility_id,account_id,membership_id,purpose_of_use));
alter table ehr.staff_chat_state add foreign key(patient_id) references identity.patients(id) on delete cascade;
alter table ehr.staff_chat_state enable row level security;
alter table ehr.staff_chat_state force row level security;
revoke all on ehr.staff_chat_state from public;
create policy staff_chat_state_scope on ehr.staff_chat_state using(ehr.staff_chat_context(patient_id,facility_id,account_id,membership_id) and purpose_of_use='direct-care') with check(ehr.staff_chat_context(patient_id,facility_id,account_id,membership_id) and purpose_of_use='direct-care');

create table ehr.staff_chat_messages (like ehr.patient_chat_messages including defaults including constraints,
 facility_id uuid not null default nullif(current_setting('app.facility_id',true),'')::uuid,
 account_id uuid not null default nullif(current_setting('app.chat_account_id',true),'')::uuid,
 membership_id uuid not null default nullif(current_setting('app.membership_id',true),'')::uuid,
 purpose_of_use text not null default 'direct-care' check(purpose_of_use='direct-care')
, permission_hash char(64) not null default current_setting('app.chat_permission_hash',true) check(permission_hash ~ '^[a-f0-9]{64}$'),primary key(id));
alter table ehr.staff_chat_messages add foreign key(patient_id) references identity.patients(id) on delete cascade;
alter table ehr.staff_chat_messages enable row level security;
alter table ehr.staff_chat_messages force row level security;
revoke all on ehr.staff_chat_messages from public;
create policy staff_chat_messages_scope on ehr.staff_chat_messages using(ehr.staff_chat_context(patient_id,facility_id,account_id,membership_id) and purpose_of_use='direct-care') with check(ehr.staff_chat_context(patient_id,facility_id,account_id,membership_id) and purpose_of_use='direct-care');

create table ehr.staff_evidence_chunks (like ehr.patient_evidence_chunks including defaults including constraints,
 facility_id uuid not null default nullif(current_setting('app.facility_id',true),'')::uuid,
 account_id uuid not null default nullif(current_setting('app.chat_account_id',true),'')::uuid,
 membership_id uuid not null default nullif(current_setting('app.membership_id',true),'')::uuid,
 purpose_of_use text not null default 'direct-care' check(purpose_of_use='direct-care')
,primary key(patient_id,facility_id,account_id,membership_id,purpose_of_use,source_kind,source_id,source_version,source_hash,normalizer_version,chunk_no,model_id));
alter table ehr.staff_evidence_chunks add foreign key(patient_id) references identity.patients(id) on delete cascade;
alter table ehr.staff_evidence_chunks enable row level security;
alter table ehr.staff_evidence_chunks force row level security;
revoke all on ehr.staff_evidence_chunks from public;
create policy staff_evidence_chunks_scope on ehr.staff_evidence_chunks using(ehr.staff_chat_context(patient_id,facility_id,account_id,membership_id) and purpose_of_use='direct-care') with check(ehr.staff_chat_context(patient_id,facility_id,account_id,membership_id) and purpose_of_use='direct-care');

create table ehr.staff_attachment_extractions (like ehr.patient_attachment_extractions including defaults including constraints,
 facility_id uuid not null default nullif(current_setting('app.facility_id',true),'')::uuid,
 account_id uuid not null default nullif(current_setting('app.chat_account_id',true),'')::uuid,
 membership_id uuid not null default nullif(current_setting('app.membership_id',true),'')::uuid,
 purpose_of_use text not null default 'direct-care' check(purpose_of_use='direct-care')
,primary key(patient_id,facility_id,account_id,membership_id,purpose_of_use,file_id,object_version_id,sha256_hex,extractor_version));
alter table ehr.staff_attachment_extractions add foreign key(patient_id) references identity.patients(id) on delete cascade;
alter table ehr.staff_attachment_extractions enable row level security;
alter table ehr.staff_attachment_extractions force row level security;
revoke all on ehr.staff_attachment_extractions from public;
alter table ehr.staff_attachment_extractions add foreign key(file_id,patient_id,sha256_hex,object_version_id)
 references ehr.imported_attachment_bindings(file_id,patient_id,sha256_hex,object_version_id) on delete restrict;
create policy staff_attachment_extractions_scope on ehr.staff_attachment_extractions using(ehr.staff_chat_context(patient_id,facility_id,account_id,membership_id) and purpose_of_use='direct-care' and (select s.result from ehr.imported_attachment_scan_events s where s.file_id=staff_attachment_extractions.file_id and s.patient_id=staff_attachment_extractions.patient_id and s.sha256_hex=staff_attachment_extractions.sha256_hex and s.object_version_id=staff_attachment_extractions.object_version_id order by s.sequence_id desc limit 1)='clean') with check(ehr.staff_chat_context(patient_id,facility_id,account_id,membership_id) and purpose_of_use='direct-care' and (select s.result from ehr.imported_attachment_scan_events s where s.file_id=staff_attachment_extractions.file_id and s.patient_id=staff_attachment_extractions.patient_id and s.sha256_hex=staff_attachment_extractions.sha256_hex and s.object_version_id=staff_attachment_extractions.object_version_id order by s.sequence_id desc limit 1)='clean');

create table ehr.staff_document_extractions (like ehr.patient_attachment_extractions including defaults including constraints,
 facility_id uuid not null default nullif(current_setting('app.facility_id',true),'')::uuid,
 account_id uuid not null default nullif(current_setting('app.chat_account_id',true),'')::uuid,
 membership_id uuid not null default nullif(current_setting('app.membership_id',true),'')::uuid,
 purpose_of_use text not null default 'direct-care' check(purpose_of_use='direct-care')
,primary key(patient_id,facility_id,account_id,membership_id,purpose_of_use,file_id,object_version_id,sha256_hex,extractor_version));
alter table ehr.staff_document_extractions add foreign key(patient_id) references identity.patients(id) on delete cascade;
alter table ehr.staff_document_extractions enable row level security;
alter table ehr.staff_document_extractions force row level security;
revoke all on ehr.staff_document_extractions from public;
alter table ehr.staff_document_extractions add foreign key(file_id,patient_id,facility_id,object_version_id,sha256_hex)
 references ehr.documents(id,patient_id,facility_id,object_version_id,sha256_hex) on delete restrict;
create policy staff_document_extractions_scope on ehr.staff_document_extractions using(ehr.staff_chat_context(patient_id,facility_id,account_id,membership_id) and purpose_of_use='direct-care' and exists(select 1 from ehr.documents_effective d join ehr.encounters e on e.id=d.encounter_id and e.patient_id=d.patient_id and e.facility_id=d.facility_id where d.id=staff_document_extractions.file_id and d.patient_id=staff_document_extractions.patient_id and d.facility_id=staff_document_extractions.facility_id and d.status='available' and e.status='completed' and d.object_version_id=staff_document_extractions.object_version_id and d.sha256_hex=staff_document_extractions.sha256_hex)) with check(ehr.staff_chat_context(patient_id,facility_id,account_id,membership_id) and purpose_of_use='direct-care' and exists(select 1 from ehr.documents_effective d join ehr.encounters e on e.id=d.encounter_id and e.patient_id=d.patient_id and e.facility_id=d.facility_id where d.id=staff_document_extractions.file_id and d.patient_id=staff_document_extractions.patient_id and d.facility_id=staff_document_extractions.facility_id and d.status='available' and e.status='completed' and d.object_version_id=staff_document_extractions.object_version_id and d.sha256_hex=staff_document_extractions.sha256_hex));

alter table ehr.staff_chat_state add unique(patient_id,facility_id,account_id,membership_id,purpose_of_use,generation);
alter table ehr.staff_chat_messages add foreign key(patient_id,facility_id,account_id,membership_id,purpose_of_use,generation) references ehr.staff_chat_state(patient_id,facility_id,account_id,membership_id,purpose_of_use,generation);
create index staff_chat_messages_scope_time on ehr.staff_chat_messages(patient_id,facility_id,account_id,membership_id,purpose_of_use,created_at desc,id desc);

do $$ begin if exists(select 1 from pg_roles where rolname='hid_ehr_runtime') then
grant execute on function ehr.staff_chat_context(uuid,uuid,uuid,uuid) to hid_ehr_runtime;
grant select,insert,update on ehr.staff_chat_state to hid_ehr_runtime;
grant select,insert,delete on ehr.staff_chat_messages,ehr.staff_evidence_chunks to hid_ehr_runtime;
grant select,insert,update on ehr.staff_attachment_extractions,ehr.staff_document_extractions to hid_ehr_runtime;
end if;end $$;
