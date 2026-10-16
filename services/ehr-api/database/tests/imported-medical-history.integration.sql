\set ON_ERROR_STOP on
\o /dev/null
-- Imported legacy medical history (owner decision 3 of 2026-10-16, ADR-065,
-- migration 0096). Rollback-only.
--
-- Patients read their own imported history through main's patient-self
-- binding (ehr.patient_self_context, 0091) only in a transaction whose
-- app.patient_release names importedHistory, as PatientRecordRelease binds it
-- when its own flag is on. Staff read it only when every one of these holds:
-- the purpose is exactly direct-care; ehr.context_allows passes for the
-- patient at the selected facility (an active, unheld, unexpired standard
-- consent of the selected membership, no deny directive); the membership's
-- role holds ehr.imported-history.read; the patient has chosen to share
-- imported history (identity.imported_history_sharing, off by default); and
-- the patient's login is not deleted. The staff policies decide once per
-- statement, for the one patient the staff transaction names in
-- app.imported_history_patient (ehr.imported_history_staff_patient(), whose
-- decision is evaluated as an InitPlan, not per row): a binding is only the
-- request, never the permission, and a transaction bound to one patient reads
-- no other patient's rows. Break-glass never discloses it: an
-- active break-glass grant with purpose emergency reads nothing, although
-- ehr.context_allows admits it. The staff helper, the two sharing commands
-- and the import command are SECURITY DEFINER functions owned by NOLOGIN
-- technical owners whose grants and policies the role bootstrap creates; the
-- rehearsal reruns this suite with a schema owner that is neither a
-- superuser nor BYPASSRLS, which is where the helper must still read the
-- sharing row, the patient and the login (release checklist P8).
--
-- Fixtures are synthetic, in the e3 identifier range, and inserted as the
-- suite runner with session_replication_role = replica (no triggers or
-- foreign keys; CHECK constraints still apply). Every case is recorded and
-- the suite fails at the end listing every case whose outcome differs.
begin;
set constraints all deferred;

create temporary table imported_case_results(name text primary key, expected text not null, actual text not null)
  on commit drop;
grant all on imported_case_results to public;
create function pg_temp.imported_record(name text, expected text, actual text) returns void
language sql as $$
  insert into imported_case_results values (name, expected, coalesce(actual, '<none>'));
$$;

-- Accounts 1 to 5 are patients A to E, 6 a doctor, 7 a receptionist.
insert into auth.accounts(id,subject,email,display_name,status)
select ('e3100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'synthetic:imported:'||n,'imported-'||n||'@example.invalid','Synthetic imported '||n,'active'
from generate_series(1,7) n;
-- Patients: A shares and has consent at facility A; B has consent but does
-- not share; C shares and has consent, and its login is deleted below; D
-- shares and has only a break-glass grant; E has no sharing row.
insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status)
select ('e3200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('e3100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'HID-EMPRT'||chr(64+n),'Imported',chr(64+n),'Imported '||chr(64+n),'active'
from generate_series(1,5) n;
insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,account_token_version,
  authentication_method,issued_at,expires_at,absolute_expires_at,session_kind,patient_id)
select ('e3300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('e3100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('e3300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  md5('imported'||n)||md5('imported'||n),gen_random_uuid(),1,'password',clock_timestamp(),
  clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours','patient',
  ('e3200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
from generate_series(1,5) n;
insert into identity.organizations(id,name,slug)
values('e3400000-0000-4000-8000-000000000001','Imported test organization','imported-test-organization');
insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
values('e3400000-0000-4000-8000-000000000002','e3400000-0000-4000-8000-000000000001','Imported facility A',
  'IMP-A','Africa/Lagos',true,'verified'),
  ('e3400000-0000-4000-8000-000000000003','e3400000-0000-4000-8000-000000000001','Imported facility B',
  'IMP-B','Africa/Lagos',true,'verified');
insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
values('e3500000-0000-4000-8000-000000000001','e3100000-0000-4000-8000-000000000006','Synthetic imported doctor',
  'doctor-imported@example.invalid','verified','doctor'),
  ('e3500000-0000-4000-8000-000000000002','e3100000-0000-4000-8000-000000000007','Synthetic imported receptionist',
  'receptionist-imported@example.invalid','verified','receptionist');
-- Memberships: 1 the doctor at facility A, 2 the doctor at facility B, 3 the
-- receptionist at facility A.
insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,
  app_role,is_primary,active)
values('e3600000-0000-4000-8000-000000000001','e3500000-0000-4000-8000-000000000001',
  'e3100000-0000-4000-8000-000000000006','e3400000-0000-4000-8000-000000000001',
  'e3400000-0000-4000-8000-000000000002','doctor','doctor',true,true),
  ('e3600000-0000-4000-8000-000000000002','e3500000-0000-4000-8000-000000000001',
  'e3100000-0000-4000-8000-000000000006','e3400000-0000-4000-8000-000000000001',
  'e3400000-0000-4000-8000-000000000003','doctor','doctor',false,true),
  ('e3600000-0000-4000-8000-000000000003','e3500000-0000-4000-8000-000000000002',
  'e3100000-0000-4000-8000-000000000007','e3400000-0000-4000-8000-000000000001',
  'e3400000-0000-4000-8000-000000000002','receptionist','receptionist',true,true);
insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
values('e3610000-0000-4000-8000-000000000001','e3100000-0000-4000-8000-000000000006','doctor','facility',
  'e3600000-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000002','Synthetic imported role'),
  ('e3610000-0000-4000-8000-000000000002','e3100000-0000-4000-8000-000000000006','doctor','facility',
  'e3600000-0000-4000-8000-000000000002','e3400000-0000-4000-8000-000000000003','Synthetic imported role'),
  ('e3610000-0000-4000-8000-000000000003','e3100000-0000-4000-8000-000000000007','receptionist','facility',
  'e3600000-0000-4000-8000-000000000003','e3400000-0000-4000-8000-000000000002','Synthetic imported role');

set local session_replication_role = replica;

-- Standard direct-care read consents at facility A for A, B and C through the
-- doctor's membership 1 and for A through the receptionist's membership 3;
-- none at facility B. D has only a break-glass grant (below).
insert into identity.consent_grants(id,patient_id,staff_id,account_id,membership_id,facility_id,scope,purpose_of_use,
  status,reason,starts_at,expires_at)
select ('e3620000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('e3200000-0000-4000-8000-'||lpad((case when n = 4 then 1 else n end)::text,12,'0'))::uuid,
  case when n = 4 then 'e3500000-0000-4000-8000-000000000002' else 'e3500000-0000-4000-8000-000000000001' end::uuid,
  case when n = 4 then 'e3100000-0000-4000-8000-000000000007' else 'e3100000-0000-4000-8000-000000000006' end::uuid,
  case when n = 4 then 'e3600000-0000-4000-8000-000000000003' else 'e3600000-0000-4000-8000-000000000001' end::uuid,
  'e3400000-0000-4000-8000-000000000002','read_records','direct-care','active','Synthetic imported consent '||n,
  clock_timestamp()-interval '1 hour',clock_timestamp()+interval '30 days'
from generate_series(1,4) n;

-- The source run every imported row names.
insert into migration.runs(id,source_system,source_snapshot,mode,status,started_by)
values('e3700000-0000-4000-8000-000000000001','legacy_identity','synthetic-imported-suite','stage','staged',
  'synthetic-imported-suite');

-- Records: 1 and 2 of patient A (record 1 patient-provided with two versions
-- and a file, record 2 provider-authored), 3 of B, 4 of C, 5 of D.
insert into ehr.imported_medical_records(id,patient_id,author_account_id,origin,current_version_id,source_run_id,
  source_payload,source_sha256,source_created_at,source_updated_at)
select ('e3800000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('e3200000-0000-4000-8000-'||lpad((array[1,1,2,3,4])[n]::text,12,'0'))::uuid,
  case when n = 2 then 'e3100000-0000-4000-8000-000000000006'::uuid
       else ('e3100000-0000-4000-8000-'||lpad((array[1,1,2,3,4])[n]::text,12,'0'))::uuid end,
  case when n = 2 then 'provider-authored' else 'patient-provided' end,
  ('e3810000-0000-4000-8000-'||lpad((n*10+case when n = 1 then 2 else 1 end)::text,12,'0'))::uuid,
  'e3700000-0000-4000-8000-000000000001',
  jsonb_build_object('id',('e3800000-0000-4000-8000-'||lpad(n::text,12,'0')),'title','Synthetic history '||n,
    'category','history','info_type','text'),
  repeat(to_hex(n),64),clock_timestamp()-n*interval '1 day',clock_timestamp()-n*interval '1 day'
from generate_series(1,5) n;
insert into ehr.imported_medical_record_versions(id,record_id,patient_id,version_no,author_account_id,origin,
  source_payload,source_sha256,source_created_at)
select ('e3810000-0000-4000-8000-'||lpad((r*10+v)::text,12,'0'))::uuid,
  ('e3800000-0000-4000-8000-'||lpad(r::text,12,'0'))::uuid,
  ('e3200000-0000-4000-8000-'||lpad((array[1,1,2,3,4])[r]::text,12,'0'))::uuid,v,
  case when r = 2 then 'e3100000-0000-4000-8000-000000000006'::uuid
       else ('e3100000-0000-4000-8000-'||lpad((array[1,1,2,3,4])[r]::text,12,'0'))::uuid end,
  case when r = 2 then 'provider-authored' else 'patient-provided' end,
  jsonb_build_object('record','Synthetic content '||r||'.'||v),repeat(to_hex(r+v),64),
  clock_timestamp()-r*interval '1 day'+v*interval '1 hour'
from generate_series(1,5) r, generate_series(1,2) v where v = 1 or r = 1;
insert into ehr.imported_medical_record_files(id,record_id,patient_id,record_version_id,uploader_account_id,
  source_payload,source_sha256,source_created_at)
values('e3820000-0000-4000-8000-000000000001','e3800000-0000-4000-8000-000000000001',
  'e3200000-0000-4000-8000-000000000001','e3810000-0000-4000-8000-000000000012',
  'e3100000-0000-4000-8000-000000000001',
  jsonb_build_object('original_file_name','synthetic.txt','mime_type','text/plain','size_bytes',19),
  repeat('a',64),clock_timestamp()-interval '1 day');

-- Sharing choices: A, C and D share; B chose not to (a row with false); E has none.
insert into identity.imported_history_sharing(patient_id,shared,row_version,updated_at,updated_session_id)
select ('e3200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid, n <> 2, 1, clock_timestamp(),
  ('e3300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
from generate_series(1,4) n;

set local session_replication_role = origin;

-- Staff contexts, as DatabaseService.withTransaction sets them.
create function pg_temp.bind_staff(membership text, facility text, purpose text) returns void
language sql as $$
  select set_config('app.actor_subject','synthetic:imported:6',true),
    set_config('app.facility_id',facility,true), set_config('app.membership_id',membership,true),
    set_config('app.correlation_id','imported-history-integration-0001',true),
    set_config('app.purpose_of_use',purpose,true),
    set_config('app.patient_id','',true), set_config('app.patient_release','',true),
    set_config('app.imported_history_patient','e3200000-0000-4000-8000-000000000001',true);
$$;
-- The patient the staff read names, as ImportedHistoryService.staff binds it.
create function pg_temp.bind_staff_patient(patient text) returns void
language sql as $$ select set_config('app.imported_history_patient', patient, true); $$;
create function pg_temp.bind_receptionist(purpose text) returns void
language sql as $$
  select pg_temp.bind_staff('e3600000-0000-4000-8000-000000000003','e3400000-0000-4000-8000-000000000002',purpose),
    set_config('app.actor_subject','synthetic:imported:7',true);
$$;
-- The patient-self binding, as DatabaseService.withPatientTransaction sets it,
-- with the release set PatientRecordRelease binds.
create function pg_temp.bind_self(n integer, release text) returns void
language sql as $$
  select set_config('app.actor_subject','synthetic:imported:'||n,true),
    set_config('app.account_id','e3100000-0000-4000-8000-'||lpad(n::text,12,'0'),true),
    set_config('app.session_id','e3300000-0000-4000-8000-'||lpad(n::text,12,'0'),true),
    set_config('app.patient_id','e3200000-0000-4000-8000-'||lpad(n::text,12,'0'),true),
    set_config('app.correlation_id','imported-history-integration-0002',true),
    set_config('app.self_authorized_until',(clock_timestamp()+interval '30 seconds')::text,true),
    set_config('app.purpose_of_use','patient-self',true), set_config('app.facility_id','',true),
    set_config('app.membership_id','',true), set_config('app.patient_release',release,true);
$$;
-- The imported rows the current context reads: record ids, then version and file counts.
create function pg_temp.imported_visible() returns text
language sql as $$
  select coalesce((select string_agg(right(id::text,2), ',' order by id) from ehr.imported_medical_records), '')
    || '|' || (select count(*) from ehr.imported_medical_record_versions)
    || '|' || (select count(*) from ehr.imported_medical_record_files);
$$;

-- 1. Staff: direct-care, consent at the selected facility, the permission and
--    the patient's sharing choice. The doctor at facility A reads A's records
--    (01, 02, three versions, one file) only: B has not shared, C's login is
--    deleted (below), D has no standard consent.
set local session_replication_role = replica;
update auth.accounts set status = 'deleted' where id = 'e3100000-0000-4000-8000-000000000003';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff('e3600000-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000002','direct-care');
select pg_temp.imported_record('staff: consent and sharing disclose the whole history', '01,02|3|1', pg_temp.imported_visible());
select pg_temp.imported_record('staff helper per patient', 'A:true,B:false,C:false,D:false,E:false',
  (select string_agg(chr(64+n)||':'||ehr.imported_history_staff_read_allowed(
     ('e3200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid), ',' order by n) from generate_series(1,5) n));
select pg_temp.bind_staff_patient('e3200000-0000-4000-8000-000000000002');
select pg_temp.imported_record('staff: consent without sharing reads nothing (B)', '0',
  (select count(*)::text from ehr.imported_medical_records where patient_id = 'e3200000-0000-4000-8000-000000000002'));
select pg_temp.imported_record('staff bound to B reads none of A''s shared rows', '|0|0', pg_temp.imported_visible());
select pg_temp.bind_staff_patient('e3200000-0000-4000-8000-000000000003');
select pg_temp.imported_record('staff: a deleted login with sharing on reads nothing (C)', '0',
  (select count(*)::text from ehr.imported_medical_records where patient_id = 'e3200000-0000-4000-8000-000000000003'));
select pg_temp.bind_staff_patient('e3200000-0000-4000-8000-000000000004');
select pg_temp.imported_record('staff bound to D (shares, no standard consent) reads nothing', '|0|0',
  pg_temp.imported_visible());
-- A binding is the request, never the permission: no binding, a malformed
-- one and an upper-case spelling read nothing, and none is an error.
select pg_temp.bind_staff_patient('');
select pg_temp.imported_record('staff with no patient bound reads nothing', '|0|0', pg_temp.imported_visible());
select pg_temp.bind_staff_patient('not-a-patient');
select pg_temp.imported_record('staff with a malformed binding reads nothing', '|0|0', pg_temp.imported_visible());
select pg_temp.bind_staff_patient('E3200000-0000-4000-8000-000000000001');
select pg_temp.imported_record('staff with an upper-case binding reads nothing', '|0|0', pg_temp.imported_visible());
select pg_temp.bind_staff_patient('e3200000-0000-4000-8000-000000000001');
select pg_temp.imported_record('staff bound to A again reads A''s history', '01,02|3|1', pg_temp.imported_visible());
select pg_temp.imported_record('staff helper with no patient', 'false',
  ehr.imported_history_staff_read_allowed(null)::text);
-- Every purpose but direct-care reads nothing.
do $$
declare
  purpose text;
begin
  foreach purpose in array array['healthcare-operations', 'emergency', 'patient-self', 'Direct-care', ''] loop
    perform set_config('app.purpose_of_use', purpose, true);
    perform pg_temp.imported_record('staff purpose ' || quote_literal(purpose), '|0|0', pg_temp.imported_visible());
  end loop;
end $$;
-- The doctor's own membership at facility B, where A gave no consent.
select pg_temp.bind_staff('e3600000-0000-4000-8000-000000000002','e3400000-0000-4000-8000-000000000003','direct-care');
select pg_temp.imported_record('staff: consent at facility A only, reading at facility B', '|0|0', pg_temp.imported_visible());
-- Membership 1 named with facility B: the membership is not at the selected facility.
select pg_temp.bind_staff('e3600000-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000003','direct-care');
select pg_temp.imported_record('staff: the membership is not at the selected facility', '|0|0', pg_temp.imported_visible());
-- The receptionist has consent for A at facility A but no ehr.imported-history.read.
select pg_temp.bind_receptionist('direct-care');
select pg_temp.imported_record('staff: consent without the permission reads nothing', 'true:false',
  ehr.context_allows('e3200000-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000002','read_records')::text
  || ':' || exists(select 1 from ehr.imported_medical_records)::text);
reset role;

-- 2. Revoked, expired, held or denied consent, a revoked sharing choice and a
--    withdrawn permission each hide A's history at the next query.
do $$
declare
  probe record;
  visible text;
begin
  for probe in select * from (values
    ('revoked grant', $q$update identity.consent_grants set status='revoked', revoked_at=clock_timestamp(),
       revoked_reason='Synthetic revocation' where id='e3620000-0000-4000-8000-000000000001'$q$),
    ('expired grant', $q$update identity.consent_grants set expires_at=clock_timestamp()-interval '1 minute',
       starts_at=clock_timestamp()-interval '2 hours' where id='e3620000-0000-4000-8000-000000000001'$q$),
    ('held grant', $q$update identity.consent_grants set migration_hold_reason='legacy_grant_purpose_unmapped'
       where id='e3620000-0000-4000-8000-000000000001'$q$),
    ('deny directive', $q$insert into identity.consent_directives(id,patient_id,current_version)
       values('e3630000-0000-4000-8000-000000000001','e3200000-0000-4000-8000-000000000001',1);
       insert into identity.consent_directive_versions(id,directive_id,patient_id,version_no,status,provision_type,
         grantee_type,grantee_id,starts_at,source_reference,reason,content_sha256)
       values('e3640000-0000-4000-8000-000000000001','e3630000-0000-4000-8000-000000000001',
         'e3200000-0000-4000-8000-000000000001',1,'active','deny','facility','e3400000-0000-4000-8000-000000000002',
         clock_timestamp()-interval '1 minute','synthetic-imported-suite','Synthetic deny directive',repeat('d',64))$q$),
    ('sharing turned off', $q$update identity.imported_history_sharing set shared=false
       where patient_id='e3200000-0000-4000-8000-000000000001'$q$),
    ('permission withdrawn', $q$delete from auth.role_permissions
       where role_code='doctor' and permission_code='ehr.imported-history.read'$q$))
    cases(name, change)
  loop
    begin
      set local session_replication_role = replica;
      execute probe.change;
      set local session_replication_role = origin;
      set local role hid_ehr_api_runtime;
      perform pg_temp.bind_staff('e3600000-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000002',
        'direct-care');
      visible := pg_temp.imported_visible();
      reset role;
      raise exception using errcode = 'P0001', message = 'imported-case-rollback', detail = visible;
    exception when sqlstate 'P0001' then
      get stacked diagnostics visible = pg_exception_detail;
      set local session_replication_role = origin;
      reset role;
      perform pg_temp.imported_record('staff after ' || probe.name, '|0|0', visible);
    end;
  end loop;
end $$;

-- 3. Break-glass never discloses imported history. An active, reasoned
--    break-glass grant for D with purpose emergency (seeded here, as no
--    launch database holds the emergency purpose, D9) passes
--    ehr.context_allows, and still nothing imported is read.
insert into identity.purpose_of_use_codes(code,display,active,source_system)
select 'emergency','Emergency (synthetic, imported history suite)',true,'hid'
 where not exists (select 1 from identity.purpose_of_use_codes where code='emergency');
update identity.purpose_of_use_codes set active=true where code='emergency';
set local session_replication_role = replica;
insert into identity.consent_grants(id,patient_id,staff_id,account_id,membership_id,facility_id,scope,purpose_of_use,
  status,reason,starts_at,expires_at,break_glass)
values('e3620000-0000-4000-8000-000000000009','e3200000-0000-4000-8000-000000000004',
  'e3500000-0000-4000-8000-000000000001','e3100000-0000-4000-8000-000000000006','e3600000-0000-4000-8000-000000000001',
  'e3400000-0000-4000-8000-000000000002','break_glass','emergency','active','Synthetic emergency access reason',
  clock_timestamp()-interval '5 minutes',clock_timestamp()+interval '55 minutes',true);
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff('e3600000-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000002','emergency');
select pg_temp.imported_record('break-glass: the emergency grant passes ehr.context_allows', 'true',
  ehr.context_allows('e3200000-0000-4000-8000-000000000004','e3400000-0000-4000-8000-000000000002','read_records')::text);
select pg_temp.imported_record('break-glass: nothing imported is read', '|0|0', pg_temp.imported_visible());
select pg_temp.imported_record('break-glass: the staff helper refuses', 'false',
  ehr.imported_history_staff_read_allowed('e3200000-0000-4000-8000-000000000004')::text);
reset role;

-- 4. Patients read their own history through the patient-self binding, only
--    when the release set names importedHistory, and need no sharing choice.
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(1, 'importedHistory');
select pg_temp.imported_record('patient A reads its own history', '01,02|3|1', pg_temp.imported_visible());
select pg_temp.bind_self(2, 'importedHistory');
select pg_temp.imported_record('patient B reads its own history without sharing', '03|1|0', pg_temp.imported_visible());
do $$
declare
  probe record;
begin
  for probe in select * from (values
    ('', 'release set empty'), ('vitals,diagnoses,prescriptions,labResults,documents', 'release set of the summary'),
    ('importedhistory', 'release set misspelt'), (' importedHistory', 'release set padded'))
    cases(setting, name)
  loop
    perform pg_temp.bind_self(1, probe.setting);
    perform pg_temp.imported_record('patient A: ' || probe.name, '|0|0', pg_temp.imported_visible());
  end loop;
end $$;
select pg_temp.bind_self(1, 'vitals,importedHistory');
select pg_temp.imported_record('patient A: release set with importedHistory among others', '01,02|3|1',
  pg_temp.imported_visible());
-- A stale authorization, another session, another patient's id with A's own
-- session, and a context that names no account read nothing.
select pg_temp.bind_self(1, 'importedHistory'),
  set_config('app.self_authorized_until',(clock_timestamp()-interval '1 second')::text,true);
select pg_temp.imported_record('patient A: stale authorization', '|0|0', pg_temp.imported_visible());
select pg_temp.bind_self(1, 'importedHistory'), set_config('app.session_id','e3300000-0000-4000-8000-000000000002',true);
select pg_temp.imported_record('patient A: another patient''s session', '|0|0', pg_temp.imported_visible());
select pg_temp.bind_self(1, 'importedHistory'), set_config('app.patient_id','e3200000-0000-4000-8000-000000000002',true);
select pg_temp.imported_record('patient A''s session naming patient B', '|0|0', pg_temp.imported_visible());
select pg_temp.bind_self(1, 'importedHistory'), set_config('app.account_id','',true);
select pg_temp.imported_record('patient A: no account', '|0|0', pg_temp.imported_visible());
-- The patient whose login is deleted reads nothing either.
select pg_temp.bind_self(3, 'importedHistory');
select pg_temp.imported_record('patient C with a deleted login', '|0|0', pg_temp.imported_visible());
-- A patient-self context is not a staff context.
select pg_temp.bind_self(1, 'importedHistory');
select pg_temp.imported_record('the staff helper in a patient-self context', 'false',
  ehr.imported_history_staff_read_allowed('e3200000-0000-4000-8000-000000000001')::text);
reset role;

-- 5. Nobody but the import command writes, and nothing changes once written.
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff('e3600000-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000002','direct-care');
do $$
declare
  target text;
  outcome text;
begin
  foreach target in array array['ehr.imported_medical_records', 'ehr.imported_medical_record_versions',
      'ehr.imported_medical_record_files'] loop
    begin
      execute format('update %s set source_created_at = source_created_at', target);
      outcome := 'updated';
    exception when insufficient_privilege then outcome := 'refused';
    end;
    perform pg_temp.imported_record('EHR runtime updates ' || target, 'refused', outcome);
    begin
      execute format('delete from %s', target);
      outcome := 'deleted';
    exception when insufficient_privilege then outcome := 'refused';
    end;
    perform pg_temp.imported_record('EHR runtime deletes from ' || target, 'refused', outcome);
  end loop;
  begin
    insert into ehr.imported_medical_records(id,patient_id,author_account_id,origin,current_version_id,source_run_id,
      source_payload,source_sha256,source_created_at,source_updated_at)
    values (gen_random_uuid(),'e3200000-0000-4000-8000-000000000001','e3100000-0000-4000-8000-000000000001',
      'patient-provided',gen_random_uuid(),'e3700000-0000-4000-8000-000000000001','{}',repeat('0',64),now(),now());
    outcome := 'inserted';
  exception when insufficient_privilege then outcome := 'refused';
  end;
  perform pg_temp.imported_record('EHR runtime inserts a record', 'refused', outcome);
  begin
    perform ehr.import_legacy_medical_history('e3700000-0000-4000-8000-000000000001',
      'e3700000-0000-4000-8000-000000000001', 'synthetic', '[]'::jsonb);
    outcome := 'executed';
  exception when insufficient_privilege then outcome := 'refused';
  end;
  perform pg_temp.imported_record('EHR runtime executes the import command', 'refused', outcome);
  begin
    perform 1 from identity.imported_history_sharing;
    outcome := 'read';
  exception when insufficient_privilege then outcome := 'refused';
  end;
  perform pg_temp.imported_record('EHR runtime reads the sharing table', 'refused', outcome);
end $$;
reset role;
do $$
declare
  target text;
  outcome text;
begin
  foreach target in array array['ehr.imported_medical_records', 'ehr.imported_medical_record_versions',
      'ehr.imported_medical_record_files', 'identity.imported_history_sharing_events'] loop
    begin
      -- A row trigger fires only on a row: the change log gets one here,
      -- rolled back with the refused statement.
      if target = 'identity.imported_history_sharing_events' then
        insert into identity.imported_history_sharing_events(patient_id, shared, row_version, session_id, correlation_id)
        values ('e3200000-0000-4000-8000-000000000004', true, 900, 'e3300000-0000-4000-8000-000000000004',
                'imported-append-only');
      end if;
      execute format('update %s set patient_id = patient_id', target);
      outcome := 'updated';
    exception when sqlstate '55000' then outcome := 'append-only';
    end;
    perform pg_temp.imported_record('owner updates ' || target, 'append-only', outcome);
    begin
      if target = 'identity.imported_history_sharing_events' then
        insert into identity.imported_history_sharing_events(patient_id, shared, row_version, session_id, correlation_id)
        values ('e3200000-0000-4000-8000-000000000004', true, 900, 'e3300000-0000-4000-8000-000000000004',
                'imported-append-only');
      end if;
      execute format('delete from %s', target);
      outcome := 'deleted';
    exception when sqlstate '55000' then outcome := 'append-only';
    end;
    perform pg_temp.imported_record('owner deletes from ' || target, 'append-only', outcome);
  end loop;
end $$;

-- 6. The patient's sharing choice, through the session-bound commands, as the
--    Identity runtime. E has no row: its first choice inserts one.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','synthetic:imported:5',true),
  set_config('app.correlation_id','imported-sharing-integration-0001',true);
select pg_temp.imported_record('E reads the default choice', 'false:<null>',
  (select shared::text || ':' || coalesce(updated_at::text, '<null>')
     from identity.my_imported_history_sharing('synthetic:imported:5','e3300000-0000-4000-8000-000000000005')));
select pg_temp.imported_record('E turns sharing off while it is off: nothing changes', 'false:false',
  (select shared::text || ':' || changed::text from identity.set_my_imported_history_sharing(
     'synthetic:imported:5','e3300000-0000-4000-8000-000000000005',false)));
select pg_temp.imported_record('E turns sharing on: the first choice', 'true:true',
  (select shared::text || ':' || changed::text from identity.set_my_imported_history_sharing(
     'synthetic:imported:5','e3300000-0000-4000-8000-000000000005',true)));
select pg_temp.imported_record('E turns sharing on again: unchanged', 'true:false',
  (select shared::text || ':' || changed::text from identity.set_my_imported_history_sharing(
     'synthetic:imported:5','e3300000-0000-4000-8000-000000000005',true)));
select pg_temp.imported_record('E turns sharing off', 'false:true',
  (select shared::text || ':' || changed::text from identity.set_my_imported_history_sharing(
     'synthetic:imported:5','e3300000-0000-4000-8000-000000000005',false)));
select pg_temp.imported_record('E reads its choice', 'false',
  (select shared::text from identity.my_imported_history_sharing('synthetic:imported:5',
     'e3300000-0000-4000-8000-000000000005')));
-- Each change, and only a change, is recorded with the session and correlation.
reset role;
select pg_temp.imported_record('sharing events of E', 'true:1:e3300000-0000-4000-8000-000000000005:imported-sharing-integration-0001,'
  || 'false:2:e3300000-0000-4000-8000-000000000005:imported-sharing-integration-0001',
  (select string_agg(shared::text||':'||row_version||':'||session_id||':'||correlation_id, ',' order by row_version)
     from identity.imported_history_sharing_events where patient_id='e3200000-0000-4000-8000-000000000005'));
select pg_temp.imported_record('sharing row of E', 'false:2:e3300000-0000-4000-8000-000000000005',
  (select shared::text||':'||row_version||':'||updated_session_id from identity.imported_history_sharing
    where patient_id='e3200000-0000-4000-8000-000000000005'));
-- Another subject, another patient's session, a revoked session, a deleted
-- login and a missing correlation are refused with 42501.
update auth.sessions set revoked_at=clock_timestamp(),revocation_reason='synthetic-test'
  where id='e3300000-0000-4000-8000-000000000004';
set local role hid_identity_api_runtime;
do $$
declare
  probe record;
  outcome text;
begin
  for probe in select * from (values
    ('another subject', 'synthetic:imported:5', 'synthetic:imported:1', 'e3300000-0000-4000-8000-000000000005'),
    ('another patient''s session', 'synthetic:imported:5', 'synthetic:imported:5', 'e3300000-0000-4000-8000-000000000001'),
    ('a revoked session', 'synthetic:imported:4', 'synthetic:imported:4', 'e3300000-0000-4000-8000-000000000004'),
    ('a deleted login', 'synthetic:imported:3', 'synthetic:imported:3', 'e3300000-0000-4000-8000-000000000003'))
    cases(name, acting, subject, session)
  loop
    perform set_config('app.actor_subject', probe.acting, true);
    begin
      perform identity.set_my_imported_history_sharing(probe.subject, probe.session::uuid, true);
      outcome := 'changed';
    exception when insufficient_privilege then outcome := 'refused';
    end;
    perform pg_temp.imported_record('set sharing with ' || probe.name, 'refused', outcome);
    begin
      perform identity.my_imported_history_sharing(probe.subject, probe.session::uuid);
      outcome := 'read';
    exception when insufficient_privilege then outcome := 'refused';
    end;
    perform pg_temp.imported_record('read sharing with ' || probe.name, 'refused', outcome);
  end loop;
  perform set_config('app.actor_subject', 'synthetic:imported:5', true);
  perform set_config('app.correlation_id', '', true);
  begin
    perform identity.set_my_imported_history_sharing('synthetic:imported:5','e3300000-0000-4000-8000-000000000005',true);
    outcome := 'changed';
  exception when insufficient_privilege then outcome := 'refused';
  end;
  perform pg_temp.imported_record('set sharing without a correlation', 'refused', outcome);
  perform set_config('app.correlation_id', 'imported-sharing-integration-0002', true);
  begin
    perform identity.set_my_imported_history_sharing('synthetic:imported:5','e3300000-0000-4000-8000-000000000005',null);
    outcome := 'changed';
  exception when invalid_parameter_value then outcome := 'invalid';
  end;
  perform pg_temp.imported_record('set sharing to null', 'invalid', outcome);
  begin
    perform 1 from identity.imported_history_sharing;
    outcome := 'read';
  exception when insufficient_privilege then outcome := 'refused';
  end;
  perform pg_temp.imported_record('Identity runtime reads the sharing table', 'refused', outcome);
  begin
    perform 1 from ehr.imported_medical_records;
    outcome := 'read';
  exception when insufficient_privilege then outcome := 'refused';
  end;
  perform pg_temp.imported_record('Identity runtime reads imported records', 'refused', outcome);
end $$;
reset role;
-- A choice made through the command reaches the staff read at once: E has
-- no record, so A shows it. A turns sharing off and the doctor reads nothing.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','synthetic:imported:1',true),
  set_config('app.correlation_id','imported-sharing-integration-0003',true);
select pg_temp.imported_record('A turns sharing off through the command', 'false:true',
  (select shared::text || ':' || changed::text from identity.set_my_imported_history_sharing(
     'synthetic:imported:1','e3300000-0000-4000-8000-000000000001',false)));
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff('e3600000-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000002','direct-care');
select pg_temp.imported_record('staff after A turned sharing off', '|0|0', pg_temp.imported_visible());
reset role;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','synthetic:imported:1',true),
  set_config('app.correlation_id','imported-sharing-integration-0004',true);
select identity.set_my_imported_history_sharing('synthetic:imported:1','e3300000-0000-4000-8000-000000000001',true);
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff('e3600000-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000002','direct-care');
select pg_temp.imported_record('staff after A turned sharing on again', '01,02|3|1', pg_temp.imported_visible());
reset role;

-- 7. Catalogue: forced row-level security, the exact policies, the owners,
--    the EXECUTE holders, the immutability triggers and no other trigger.
select pg_temp.imported_record('forced row-level security',
  'ehr.imported_medical_record_files:true:true,ehr.imported_medical_record_versions:true:true,ehr.imported_medical_records:true:true,'
  || 'identity.imported_history_sharing:true:true,identity.imported_history_sharing_events:true:true',
  (select string_agg(oid::regclass::text||':'||relrowsecurity||':'||relforcerowsecurity, ',' order by oid::regclass::text collate "C")
     from pg_class where oid in ('ehr.imported_medical_records'::regclass,'ehr.imported_medical_record_versions'::regclass,
       'ehr.imported_medical_record_files'::regclass,'identity.imported_history_sharing'::regclass,
       'identity.imported_history_sharing_events'::regclass)));
select pg_temp.imported_record('policies of the imported tables',
  'ehr.imported_medical_record_files:imported_history_importer_insert(a:hid_imported_history_importer)/'
  || 'imported_history_importer_read(r:hid_imported_history_importer)/imported_history_patient_self_read(r:public)/'
  || 'imported_history_staff_read(r:public);'
  || 'ehr.imported_medical_record_versions:imported_history_importer_insert(a:hid_imported_history_importer)/'
  || 'imported_history_importer_read(r:hid_imported_history_importer)/imported_history_patient_self_read(r:public)/'
  || 'imported_history_staff_read(r:public);'
  || 'ehr.imported_medical_records:imported_history_importer_insert(a:hid_imported_history_importer)/'
  || 'imported_history_importer_read(r:hid_imported_history_importer)/imported_history_patient_self_read(r:public)/'
  || 'imported_history_staff_read(r:public);'
  || 'identity.imported_history_sharing:imported_history_commands_insert(a:hid_imported_history_commands)/'
  || 'imported_history_commands_read(r:hid_imported_history_commands)/'
  || 'imported_history_commands_update(w:hid_imported_history_commands);'
  || 'identity.imported_history_sharing_events:imported_history_commands_insert(a:hid_imported_history_commands)',
  (select string_agg(entry, ';' order by relation_order, entry collate "C") from (
     select case when policy.polrelid::regclass::text like 'ehr.%' then 0 else 1 end as relation_order,
       policy.polrelid::regclass::text || ':' || string_agg(policy.polname || '(' || policy.polcmd::text || ':'
         || coalesce((select string_agg(rolname, '|' order by rolname) from pg_roles where oid = any(policy.polroles)
                      and oid <> 0), 'public') || ')', '/' order by policy.polname collate "C") as entry
       from pg_policy policy
      where policy.polrelid in ('ehr.imported_medical_records'::regclass,'ehr.imported_medical_record_versions'::regclass,
        'ehr.imported_medical_record_files'::regclass,'identity.imported_history_sharing'::regclass,
        'identity.imported_history_sharing_events'::regclass)
      group by policy.polrelid) inventory));
select pg_temp.imported_record('patient-self policies follow the release set and the binding', 'true:true:true',
  (select string_agg((pg_get_expr(polqual, polrelid) like '%''importedHistory''::text = ANY (string_to_array(current_setting(''app.patient_release''::text, true), '',''::text))%'
     and pg_get_expr(polqual, polrelid) like '%ehr.patient_self_context(patient_id)%')::text, ':' order by polrelid::regclass::text)
     from pg_policy where polname = 'imported_history_patient_self_read'));
select pg_temp.imported_record('staff policies compare with the patient decided once per statement', 'true:true:true',
  (select string_agg((pg_get_expr(polqual, polrelid)
       = '(patient_id = ( SELECT ehr.imported_history_staff_patient() AS imported_history_staff_patient))')::text, ':'
     order by polrelid::regclass::text) from pg_policy where polname = 'imported_history_staff_read'));
select pg_temp.imported_record('the staff binding function: invoker, stable, pinned, run by the EHR runtime and the test role',
  'false:s:{"search_path=pg_catalog, pg_temp"}:hid_ehr_runtime|hid_schema_test_runtime',
  (select proc.prosecdef::text || ':' || proc.provolatile::text || ':' || proc.proconfig::text || ':'
     || (select string_agg(privilege.grantee::regrole::text, '|' order by privilege.grantee::regrole::text)
           from aclexplode(proc.proacl) privilege where privilege.grantee <> proc.proowner)
     from pg_proc proc where proc.oid = to_regprocedure('ehr.imported_history_staff_patient()')));
select pg_temp.imported_record('function owners, definer and pinned search_path',
  'ehr.import_legacy_medical_history(uuid,uuid,text,jsonb):hid_imported_history_importer:true:{"search_path=pg_catalog, pg_temp",TimeZone=UTC,plan_cache_mode=force_custom_plan},'
  || 'ehr.imported_history_staff_read_allowed(uuid):hid_imported_history_commands:true:{"search_path=pg_catalog, pg_temp"},'
  || 'identity.my_imported_history_sharing(text,uuid):hid_imported_history_commands:true:{"search_path=pg_catalog, pg_temp"},'
  || 'identity.set_my_imported_history_sharing(text,uuid,boolean):hid_imported_history_commands:true:{"search_path=pg_catalog, pg_temp"}',
  (select string_agg(replace(oid::regprocedure::text, ' ', '')||':'||proowner::regrole||':'||prosecdef||':'||proconfig::text, ','
     order by oid::regprocedure::text)
     from pg_proc where oid in ('ehr.imported_history_staff_read_allowed(uuid)'::regprocedure,
       'identity.my_imported_history_sharing(text,uuid)'::regprocedure,
       'identity.set_my_imported_history_sharing(text,uuid,boolean)'::regprocedure,
       'ehr.import_legacy_medical_history(uuid,uuid,text,jsonb)'::regprocedure)));
select pg_temp.imported_record('EXECUTE holders of the new functions',
  'ehr.import_legacy_medical_history(uuid,uuid,text,jsonb):hid_migration_admin,'
  || 'ehr.imported_history_staff_read_allowed(uuid):hid_ehr_runtime|hid_schema_test_runtime,'
  || 'identity.my_imported_history_sharing(text,uuid):hid_identity_runtime|hid_schema_test_runtime,'
  || 'identity.set_my_imported_history_sharing(text,uuid,boolean):hid_identity_runtime|hid_schema_test_runtime',
  (select string_agg(signature||':'||holders, ',' order by signature) from (
     select replace(proc.oid::regprocedure::text, ' ', '') as signature,
       coalesce(string_agg(case when privilege.grantee = 0 then 'public' else privilege.grantee::regrole::text end, '|'
         order by case when privilege.grantee = 0 then 'public' else privilege.grantee::regrole::text end), '<none>') as holders
       from pg_proc proc left join lateral aclexplode(proc.proacl) privilege
         on privilege.grantee <> proc.proowner and privilege.privilege_type = 'EXECUTE'
      where proc.oid in ('ehr.imported_history_staff_read_allowed(uuid)'::regprocedure,
        'identity.my_imported_history_sharing(text,uuid)'::regprocedure,
        'identity.set_my_imported_history_sharing(text,uuid,boolean)'::regprocedure,
        'ehr.import_legacy_medical_history(uuid,uuid,text,jsonb)'::regprocedure)
      group by proc.oid) holders));
select pg_temp.imported_record('no technical owner keeps an EXECUTE entry on its own function', '0',
  (select count(*)::text from pg_proc proc, aclexplode(proc.proacl) privilege
    where proc.oid in ('ehr.imported_history_staff_read_allowed(uuid)'::regprocedure,
      'identity.my_imported_history_sharing(text,uuid)'::regprocedure,
      'identity.set_my_imported_history_sharing(text,uuid,boolean)'::regprocedure,
      'ehr.import_legacy_medical_history(uuid,uuid,text,jsonb)'::regprocedure)
      and privilege.grantee = proc.proowner));
select pg_temp.imported_record('PUBLIC executes none of the new functions', 'f,f,f,f',
  concat_ws(',', has_function_privilege('public','ehr.imported_history_staff_read_allowed(uuid)','EXECUTE'),
    has_function_privilege('public','identity.my_imported_history_sharing(text,uuid)','EXECUTE'),
    has_function_privilege('public','identity.set_my_imported_history_sharing(text,uuid,boolean)','EXECUTE'),
    has_function_privilege('public','ehr.import_legacy_medical_history(uuid,uuid,text,jsonb)','EXECUTE')));
select pg_temp.imported_record('runtime table privileges',
  'ehr:true:false:false:false,identity:false:false,events:false,shared:false',
  'ehr:' || has_table_privilege('hid_ehr_runtime','ehr.imported_medical_records','SELECT')
    || ':' || has_table_privilege('hid_ehr_runtime','ehr.imported_medical_records','INSERT')
    || ':' || has_table_privilege('hid_ehr_runtime','ehr.imported_medical_records','UPDATE')
    || ':' || has_table_privilege('hid_ehr_runtime','ehr.imported_medical_records','DELETE')
    || ',identity:' || has_table_privilege('hid_identity_runtime','ehr.imported_medical_records','SELECT')
    || ':' || has_table_privilege('hid_identity_runtime','identity.imported_history_sharing','SELECT')
    || ',events:' || has_table_privilege('hid_identity_runtime','identity.imported_history_sharing_events','SELECT,INSERT')
    || ',shared:' || has_table_privilege('hid_ehr_runtime','identity.imported_history_sharing','SELECT'));
select pg_temp.imported_record('triggers of the imported tables: immutability only',
  'ehr.imported_medical_record_files:imported_history_no_mutation,'
  || 'ehr.imported_medical_record_versions:imported_history_no_mutation,'
  || 'ehr.imported_medical_records:imported_history_no_mutation,'
  || 'identity.imported_history_sharing_events:imported_history_sharing_events_no_mutation',
  (select string_agg(tgrelid::regclass::text||':'||tgname, ',' order by tgrelid::regclass::text, tgname) from pg_trigger
    where not tgisinternal and tgrelid in ('ehr.imported_medical_records'::regclass,
      'ehr.imported_medical_record_versions'::regclass,'ehr.imported_medical_record_files'::regclass,
      'identity.imported_history_sharing'::regclass,'identity.imported_history_sharing_events'::regclass)));
select pg_temp.imported_record('the permission and the roles that hold it', 'clinician,doctor,nurse',
  (select string_agg(role_code, ',' order by role_code) from auth.role_permissions
    where permission_code = 'ehr.imported-history.read'));

-- 8. A staff page at the page caps (51 records, each with 21 versions and 21
--    files; the read takes one more of each than it shows) asks the staff
--    decision once per policy, not once per row, as the EHR runtime. The
--    page is the EHR's own query (imported-history.query.ts) for patient A.
set local session_replication_role = replica;
insert into ehr.imported_medical_records(id,patient_id,author_account_id,origin,current_version_id,source_run_id,
  source_payload,source_sha256,source_created_at,source_updated_at)
select ('e3a00000-0000-4000-8000-'||lpad(r::text,12,'0'))::uuid,'e3200000-0000-4000-8000-000000000001',
  'e3100000-0000-4000-8000-000000000001','patient-provided',('e3b00000-0000-4000-8000-'||lpad((r*100+1)::text,12,'0'))::uuid,
  'e3700000-0000-4000-8000-000000000001',jsonb_build_object('title','Synthetic capped history '||r),repeat('c',64),
  clock_timestamp()-r*interval '1 second',clock_timestamp()-r*interval '1 second'
from generate_series(1,51) r;
insert into ehr.imported_medical_record_versions(id,record_id,patient_id,version_no,author_account_id,origin,
  source_payload,source_sha256,source_created_at)
select ('e3b00000-0000-4000-8000-'||lpad((r*100+v)::text,12,'0'))::uuid,('e3a00000-0000-4000-8000-'||lpad(r::text,12,'0'))::uuid,
  'e3200000-0000-4000-8000-000000000001',v,'e3100000-0000-4000-8000-000000000001','patient-provided',
  jsonb_build_object('record','Invented capped content '||v),repeat('d',64),clock_timestamp()-interval '30 days'
from generate_series(1,51) r, generate_series(1,21) v;
insert into ehr.imported_medical_record_files(id,record_id,patient_id,record_version_id,uploader_account_id,
  source_payload,source_sha256,source_created_at)
select ('e3c00000-0000-4000-8000-'||lpad((r*100+f)::text,12,'0'))::uuid,('e3a00000-0000-4000-8000-'||lpad(r::text,12,'0'))::uuid,
  'e3200000-0000-4000-8000-000000000001',null,'e3100000-0000-4000-8000-000000000001',
  jsonb_build_object('original_file_name','synthetic-capped.txt','mime_type','text/plain','size_bytes',19),repeat('e',64),
  clock_timestamp()-interval '30 days'+f*interval '1 second'
from generate_series(1,51) r, generate_series(1,21) f;
set local session_replication_role = origin;
-- The same statement as importedHistorySql(false), for patient A.
create function pg_temp.imported_page() returns text
language sql as $$
  select count(*) || ':' || sum(json_array_length(coalesce(versions, '[]'))) || ':' || sum(json_array_length(coalesce(files, '[]')))
  from (
    select r.id,
      (select json_agg(json_build_object('id',v.id,'versionNo',v.version_no) order by v.version_no desc)
         from (select * from ehr.imported_medical_record_versions version_row
                where version_row.record_id=r.id and version_row.patient_id=r.patient_id
                order by version_row.version_no desc limit 21) v) as versions,
      (select json_agg(json_build_object('id',f.id) order by f.source_created_at,f.id)
         from (select * from ehr.imported_medical_record_files file_row
                where file_row.record_id=r.id and file_row.patient_id=r.patient_id
                order by file_row.source_created_at,file_row.id limit 21) f) as files
      from ehr.imported_medical_records r
     where r.patient_id='e3200000-0000-4000-8000-000000000001'
     order by r.source_created_at desc,r.id desc
     limit 51) page;
$$;
-- Calls of the decision are counted where the session may count them (a
-- superuser sets track_functions); the time is measured everywhere.
do $$
declare
  counting boolean := (select rolsuper from pg_roles where rolname = session_user);
  calls_before bigint := 0;
  calls bigint;
  started timestamptz;
  staff_ms double precision;
  self_ms double precision;
  staff_page text;
  self_page text;
begin
  if counting then
    set local track_functions = 'all';
    calls_before := coalesce(pg_stat_get_xact_function_calls('ehr.imported_history_staff_read_allowed(uuid)'::regprocedure), 0);
  end if;
  set local role hid_ehr_api_runtime;
  perform pg_temp.bind_staff('e3600000-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000002','direct-care');
  started := clock_timestamp();
  staff_page := pg_temp.imported_page();
  staff_ms := extract(epoch from clock_timestamp() - started) * 1000;
  reset role;
  if counting then
    calls := coalesce(pg_stat_get_xact_function_calls('ehr.imported_history_staff_read_allowed(uuid)'::regprocedure), 0)
      - calls_before;
  end if;
  set local role hid_ehr_api_runtime;
  perform pg_temp.bind_self(1, 'importedHistory');
  started := clock_timestamp();
  self_page := pg_temp.imported_page();
  self_ms := extract(epoch from clock_timestamp() - started) * 1000;
  reset role;
  perform pg_temp.imported_record('staff page at the caps reads 51 records, 21 versions and 21 files of each',
    '51:1071:1071', staff_page);
  perform pg_temp.imported_record('patient page at the caps reads the same', '51:1071:1071', self_page);
  perform pg_temp.imported_record('staff page at the caps asks the decision once per policy',
    'true', case when counting then (calls between 1 and 6)::text else 'true' end);
  perform pg_temp.imported_record('staff page at the caps takes under 3 s', 'true', (staff_ms < 3000)::text);
  raise notice 'imported history page at the caps: staff % ms (% decisions), patient-self % ms',
    round(staff_ms::numeric), coalesce(calls::text, 'not counted'), round(self_ms::numeric);
end $$;

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by name)
    into failures from imported_case_results where expected is distinct from actual;
  if failures is not null then
    raise exception E'imported medical history cases differ from the rules:\n%', failures;
  end if;
  if (select count(*) from imported_case_results) < 60 then
    raise exception 'imported medical history suite recorded only % cases', (select count(*) from imported_case_results);
  end if;
end $$;
rollback;
