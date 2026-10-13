-- Additive patient-self visibility and derived search storage. No clinical rows change.
create policy diagnoses_patient_self_read on ehr.diagnoses for select using
 (ehr.patient_self_context(patient_id) and verification_status <> 'entered_in_error'
 and exists(select 1 from ehr.encounters e where e.id=encounter_id and e.patient_id=diagnoses.patient_id and e.status='completed'));
create policy prescriptions_patient_self_read on ehr.prescriptions for select using
 (ehr.patient_self_context(patient_id) and status not in ('draft','entered_in_error'));
create policy investigations_patient_self_read on ehr.lab_requests for select using
 (ehr.patient_self_context(patient_id) and status not in ('draft','entered_in_error'));
create policy vitals_patient_self_read on ehr.vitals for select using
 (ehr.patient_self_context(patient_id) and exists(select 1 from ehr.encounters e where e.id=encounter_id and e.patient_id=vitals.patient_id and e.status='completed'));
create policy vital_corrections_patient_self_read on ehr.vital_corrections for select using
 (ehr.patient_self_context(patient_id) and exists(select 1 from ehr.vitals v where v.id=vital_id and v.patient_id=vital_corrections.patient_id));

-- The Lab runtime establishes this short-lived context only after Identity's
-- fresh patient-self decision. EHR receives no Lab schema/table privileges.
create function lab.patient_self_context(requested_patient uuid) returns boolean
 language sql stable set search_path=pg_catalog,pg_temp as $$
 select ehr.patient_self_context(requested_patient) $$;
revoke all on function lab.patient_self_context(uuid) from public;
do $$ declare n text; begin
 foreach n in array array['results','result_revisions','result_verifications','result_releases',
 'result_invalidations','test_executions','work_item_requested_tests','specimens'] loop
  execute format('create policy lab_patient_self_read on lab.%I for select using (lab.patient_self_context(patient_id))',n);
 end loop;
end $$;

create table ehr.patient_evidence_chunks (
 patient_id uuid not null references identity.patients(id) on delete cascade,
 source_kind text not null check(source_kind in ('note','encounter','diagnosis','prescription','investigation','vital','import','health_profile','lab_result','attachment')),
 source_id uuid not null, source_version text not null check(length(source_version) between 1 and 80),
 source_hash char(64) not null check(source_hash ~ '^[a-f0-9]{64}$'),
 normalizer_version integer not null default 1 check(normalizer_version=1),
 chunk_no integer not null check(chunk_no between 0 and 999),
 model_id text not null check(length(model_id) between 1 and 160),
 embedding public.vector(1024) not null, indexed_at timestamptz not null default clock_timestamp(),
 primary key(patient_id,source_kind,source_id,source_version,source_hash,normalizer_version,chunk_no,model_id)
);
alter table ehr.patient_evidence_chunks enable row level security;
alter table ehr.patient_evidence_chunks force row level security;
create policy patient_evidence_chunks_self on ehr.patient_evidence_chunks
 using(ehr.patient_self_context(patient_id)) with check(ehr.patient_self_context(patient_id));
revoke all on ehr.patient_evidence_chunks from public;
comment on table ehr.patient_evidence_chunks is 'Derived search vectors, never clinical truth. Retrieval must join freshly authorized exact source identities/versions/hashes. Existing note-reference table and foreign keys remain unchanged.';

do $$ begin
 if exists(select 1 from pg_roles where rolname='hid_ehr_runtime') then
  grant select,insert,delete on ehr.patient_evidence_chunks to hid_ehr_runtime;
  grant select on ehr.diagnoses,ehr.prescriptions,ehr.lab_requests,ehr.vitals,ehr.vital_corrections to hid_ehr_runtime;
 end if;
 if exists(select 1 from pg_roles where rolname='hid_lab_runtime') then
  grant usage on schema ehr to hid_lab_runtime;
  grant execute on function ehr.patient_self_context(uuid),lab.patient_self_context(uuid) to hid_lab_runtime;
 end if;
 if exists(select 1 from pg_roles where rolname='hid_schema_test_runtime') then
  grant execute on function lab.patient_self_context(uuid) to hid_schema_test_runtime;
 end if;
end $$;
