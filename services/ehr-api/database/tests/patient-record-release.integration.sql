\set ON_ERROR_STOP on
\o /dev/null
-- Patient record release (owner decision 4 of 2026-10-16, D7). Rollback-only.
--
-- A patient bound to their own live session (ehr.patient_self_context, 0091)
-- may read, besides completed encounters and current signed notes, exactly:
-- final, uncorrected vitals; confirmed diagnoses; active, on-hold and
-- completed prescriptions; uploaded PHI documents attached to an encounter
-- (available only when the latest scan of the exact object is clean); and the
-- latest released, not invalidated revision of each Lab result whose source
-- order is open or completed. Every item's encounter must be completed. An
-- unbound context, a staff context, the Lab runtimes and the view's owner read
-- nothing. lab-api never uses patient-self (D17): hid_lab_runtime gains no
-- privilege on schema ehr or on ehr.patient_self_context, whose EXECUTE stays
-- with hid_ehr_runtime and the test role (PSELF-RLS).
--
-- The database follows the release flags: each release policy and the view
-- admit their category only when the transaction-local app.patient_release,
-- which PatientRecordRelease sets to the categories the EHR configuration
-- releases, names it exactly. A transaction that names none, such as one of
-- an EHR build from before the release (a rollback past D-Eminence/hid-system#52),
-- reads nothing new. The policies' and the view's own conditions are checked
-- in the catalogue too, where a behaviour case cannot tell them apart.
--
-- Fixtures are synthetic and inserted as the suite runner with
-- session_replication_role = replica (no triggers or foreign keys; CHECK
-- constraints still apply), so each row has exactly the state its case
-- names. Every case is recorded and the suite fails at the end listing every
-- case whose outcome differs from the expected one. The rehearsal also runs
-- this suite with a schema owner that is neither a superuser nor BYPASSRLS
-- (release checklist P8); the view's owner is the technical role either way.
begin;
set constraints all deferred;

create temporary table release_case_results(name text primary key, expected text not null, actual text not null)
  on commit drop;
grant all on release_case_results to public;

-- Accounts, patients and live patient sessions (patients 1 and 2), and a doctor.
insert into auth.accounts(id,subject,email,display_name,status)
select ('b1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'synthetic:release:'||n,'release-'||n||'@example.invalid','Synthetic release '||n,'active'
from generate_series(1,3) n;
insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status)
values
 ('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','HID-RELAXA','Release','One','Release One','active'),
 ('b2000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000002','HID-RELAXB','Release','Two','Release Two','active');
insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,account_token_version,
  authentication_method,issued_at,expires_at,absolute_expires_at,session_kind,patient_id)
select ('b3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('b1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('b3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  md5('release'||n)||md5('release'||n),gen_random_uuid(),1,'password',clock_timestamp(),
  clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours','patient',
  ('b2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
from generate_series(1,2) n;
insert into identity.organizations(id,name,slug)
values('b4000000-0000-4000-8000-000000000001','Release test organization','release-test-organization');
insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
values('b4000000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001','Release test facility',
  'REL-A','Africa/Lagos',true,'verified');
insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
values('b5000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000003','Synthetic release doctor',
  'doctor-release@example.invalid','verified','doctor');
insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,
  app_role,is_primary,active)
values('b6000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000003',
  'b4000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000002','doctor','doctor',true,true);

set local session_replication_role = replica;

-- The doctor's active direct-care read consent for patient 1, so the staff
-- context below reaches patient 1's encounters and only the view's own
-- patient-self condition keeps it from the released Lab results.
insert into identity.consent_grants(id,patient_id,staff_id,account_id,membership_id,facility_id,scope,purpose_of_use,
  status,reason,starts_at,expires_at)
values('b6100000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001',
  'b5000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000003','b6000000-0000-4000-8000-000000000001',
  'b4000000-0000-4000-8000-000000000002','read_records','direct-care','active','Synthetic release staff consent',
  clock_timestamp()-interval '1 hour',clock_timestamp()+interval '30 days');

-- Encounters: 1 completed, 2 in progress, 3 cancelled, 4 entered in error and
-- 5 completed then entered in error (a wrong-patient retraction), all of
-- patient 1; 6 completed, of patient 2.
insert into ehr.encounters(id,patient_id,facility_id,created_by,created_by_membership_id,encounter_type,status,
  started_at,ended_at)
select ('b7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('b2000000-0000-4000-8000-'||lpad((case when n=6 then 2 else 1 end)::text,12,'0'))::uuid,
  'b4000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000003','b6000000-0000-4000-8000-000000000001',
  'ambulatory',(array['completed','in_progress','cancelled','entered_in_error','entered_in_error','completed'])[n],
  clock_timestamp()-interval '3 hours',
  case when n in (1,5,6) then clock_timestamp()-interval '2 hours' end
from generate_series(1,6) n;

-- Vitals: 1 final, never corrected, of encounter 1 (released); 2 corrected
-- once (withheld while D8 is open); 3 entered in error; 4 of the encounter in
-- progress; 5 of the encounter entered in error; 6 of patient 2; 7 of the
-- cancelled encounter.
insert into ehr.vitals(id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,recorded_at,
  systolic_mmhg,diastolic_mmhg,pulse_bpm,current_correction_no,status)
select ('b8000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('b7000000-0000-4000-8000-'||lpad((array[1,1,1,2,4,6,3])[n]::text,12,'0'))::uuid,
  ('b2000000-0000-4000-8000-'||lpad((case when n=6 then 2 else 1 end)::text,12,'0'))::uuid,
  'b4000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000003','b6000000-0000-4000-8000-000000000001',
  clock_timestamp()-n*interval '1 minute',120,80,70,case when n=2 then 1 else 0 end,
  case when n=3 then 'entered_in_error' else 'final' end
from generate_series(1,7) n;

-- Diagnoses of encounter 1 in every verification status (4 confirmed), and
-- confirmed diagnoses of the encounter in progress (7), of the completed then
-- retracted encounter (8) and of patient 2 (9).
insert into ehr.diagnoses(id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,code_system,code,
  display,clinical_status,verification_status,notes)
select ('b9000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('b7000000-0000-4000-8000-'||lpad((array[1,1,1,1,1,1,2,5,6])[n]::text,12,'0'))::uuid,
  ('b2000000-0000-4000-8000-'||lpad((case when n=9 then 2 else 1 end)::text,12,'0'))::uuid,
  'b4000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000003','b6000000-0000-4000-8000-000000000001',
  'http://hl7.org/fhir/sid/icd-10','J0'||n,'Synthetic diagnosis '||n,'active',
  (array['unconfirmed','provisional','differential','confirmed','refuted','entered_in_error',
         'confirmed','confirmed','confirmed'])[n],'Synthetic clinician note '||n
from generate_series(1,9) n;

-- Prescriptions of encounter 1 in every status (2 active, 3 on hold and 4
-- completed are released), of the cancelled encounter (7) and of patient 2 (8).
insert into ehr.prescriptions(id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,
  medication_display,frequency,instructions,status)
select ('ba000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('b7000000-0000-4000-8000-'||lpad((array[1,1,1,1,1,1,3,6])[n]::text,12,'0'))::uuid,
  ('b2000000-0000-4000-8000-'||lpad((case when n=8 then 2 else 1 end)::text,12,'0'))::uuid,
  'b4000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000003','b6000000-0000-4000-8000-000000000001',
  'Synthetic medication '||n,'Once daily','Synthetic instructions',
  (array['draft','active','on_hold','completed','cancelled','entered_in_error','active','active'])[n]
from generate_series(1,8) n;

-- Documents: 1 clean PHI of encounter 1 (available); 2 clean restricted; 3
-- rejected; 4 not scanned; 5 clean then retracted; 6 initiated; 7 clean but
-- attached to no encounter; 8 clean only on an earlier object version; 9
-- clean and then rejected; 10 clean, of the encounter in progress; 11 clean,
-- of patient 2; 12 clean internal.
insert into ehr.documents(id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,original_file_name,
  storage_bucket,storage_key,object_version_id,declared_media_type,size_bytes,sha256_hex,classification,status,
  retention_class)
select ('bb000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  case when n=7 then null
       else ('b7000000-0000-4000-8000-'||lpad((case n when 10 then 2 when 11 then 6 else 1 end)::text,12,'0'))::uuid end,
  ('b2000000-0000-4000-8000-'||lpad((case when n=11 then 2 else 1 end)::text,12,'0'))::uuid,
  'b4000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000003','b6000000-0000-4000-8000-000000000001',
  'synthetic-release-'||n||'.pdf','synthetic-release-bucket','synthetic/release-'||n||'.pdf',
  case when n=6 then null when n=8 then 'release-v2-'||n else 'release-v1-'||n end,'application/pdf',
  case when n=6 then null else 2048 end, case when n=6 then null else repeat(to_hex(n % 16),64) end,
  case n when 2 then 'restricted' when 12 then 'internal' else 'phi' end,
  case n when 5 then 'entered_in_error' when 6 then 'initiated' else 'uploaded' end,'clinical_record'
from generate_series(1,12) n;
insert into ehr.document_scan_events(document_id,patient_id,facility_id,created_by,event_type,detected_media_type,
  reason_code,scanner_engine,scanner_version,idempotency_key,correlation_id,object_version_id,object_sha256_hex,created_at)
select document_row.id,document_row.patient_id,document_row.facility_id,'b1000000-0000-4000-8000-000000000003',
  scan.event_type,case when scan.event_type='clean' then 'application/pdf' end,
  case when scan.event_type='rejected' then 'MALWARE_DETECTED' end,'synthetic-scanner','1.0',
  'release-scan-'||scan.n||'-'||document_row.id,'release-scan-correlation',
  coalesce(scan.object_version, document_row.object_version_id),document_row.sha256_hex,
  clock_timestamp()-scan.age
from (values (1,1,'clean',null::text,interval '5 minutes'), (2,2,'clean',null,interval '5 minutes'),
             (3,3,'rejected',null,interval '5 minutes'), (4,5,'clean',null,interval '5 minutes'),
             (5,7,'clean',null,interval '5 minutes'), (6,8,'clean','release-v1-8',interval '5 minutes'),
             (7,9,'clean',null,interval '10 minutes'), (8,9,'rejected',null,interval '2 minutes'),
             (9,10,'clean',null,interval '5 minutes'), (10,11,'clean',null,interval '5 minutes'),
             (11,12,'clean',null,interval '5 minutes'))
       scan(n,document_no,event_type,object_version,age)
join ehr.documents document_row
  on document_row.id = ('bb000000-0000-4000-8000-'||lpad(scan.document_no::text,12,'0'))::uuid;

-- Lab results, one EHR lab order, work item, requested test and execution
-- each. Case k: patient, encounter, order status, entered revisions, and the
-- verified, released and invalidated versions.
--   1  released v1                                  -> released v1
--   2  v1 released, v2 entered and unreleased        -> released v1
--   3  v1 released, then invalidated                 -> withheld
--   4  v1 verified, never released                   -> withheld
--   5  v1 unverified                                 -> withheld
--   6  v1 and v2 released                            -> released v2 (correction)
--   7  released, encounter in progress               -> withheld
--   8  released, order entered in error              -> withheld
--   9  released, patient 2                           -> withheld from patient 1
--   10 v1 and v2 released, v2 invalidated            -> withheld
--   11 released, order cancelled                     -> withheld
create temporary table release_lab_cases(k integer primary key, patient integer, encounter integer, order_status text,
  revisions integer, verified integer[], released integer[], invalidated integer[]) on commit drop;
insert into release_lab_cases values
  (1,1,1,'active',1,'{1}','{1}','{}'), (2,1,1,'active',2,'{1}','{1}','{}'), (3,1,1,'active',1,'{1}','{1}','{1}'),
  (4,1,1,'active',1,'{1}','{}','{}'), (5,1,1,'active',1,'{}','{}','{}'), (6,1,1,'completed',2,'{1,2}','{1,2}','{}'),
  (7,1,2,'active',1,'{1}','{1}','{}'), (8,1,1,'entered_in_error',1,'{1}','{1}','{}'),
  (9,2,6,'active',1,'{1}','{1}','{}'), (10,1,1,'active',2,'{1,2}','{1,2}','{2}'),
  (11,1,1,'cancelled',1,'{1}','{1}','{}');
create temporary view release_lab_ids as
select k, patient, encounter, order_status, revisions, verified, released, invalidated,
  ('bc000000-0000-4000-8000-'||lpad(k::text,12,'0'))::uuid as order_id,
  ('bd000000-0000-4000-8000-'||lpad(k::text,12,'0'))::uuid as work_item_id,
  ('be000000-0000-4000-8000-'||lpad(k::text,12,'0'))::uuid as test_id,
  ('bf000000-0000-4000-8000-'||lpad(k::text,12,'0'))::uuid as execution_id,
  ('c1000000-0000-4000-8000-'||lpad(k::text,12,'0'))::uuid as result_id,
  ('b2000000-0000-4000-8000-'||lpad(patient::text,12,'0'))::uuid as patient_id,
  ('b7000000-0000-4000-8000-'||lpad(encounter::text,12,'0'))::uuid as encounter_id,
  'b4000000-0000-4000-8000-000000000002'::uuid as facility_id,
  'b1000000-0000-4000-8000-000000000003'::uuid as doctor,
  'b6000000-0000-4000-8000-000000000001'::uuid as membership
from release_lab_cases;
insert into ehr.lab_requests(id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,test_code_system,
  test_code,test_display,status)
select order_id,encounter_id,patient_id,facility_id,doctor,membership,'http://loinc.org','2345-'||k,
  'Synthetic glucose '||k,order_status from release_lab_ids;
insert into lab.work_items(id,patient_id,facility_id,ordering_facility_id,source_ehr_order_id,source_ehr_order_version,
  source_encounter_id,priority,test_code_system,test_code,test_name,clinical_indication,requested_by,requested_at,
  accepted_by,accepted_by_membership_id,idempotency_key,request_sha256,correlation_id)
select work_item_id,patient_id,facility_id,facility_id,order_id,1,encounter_id,'routine','http://loinc.org','2345-'||k,
  'Synthetic glucose '||k,'Synthetic clinical indication',doctor,clock_timestamp()-interval '2 hours',doctor,membership,
  'release-work-item-'||k||'-000000',repeat('a',64),'release-lab-correlation' from release_lab_ids;
insert into lab.work_item_requested_tests(id,work_item_id,facility_id,patient_id,"ordinal",code_system,code,name)
select test_id,work_item_id,facility_id,patient_id,1,'http://loinc.org','2345-'||k,'Synthetic glucose '||k
from release_lab_ids;
insert into lab.test_executions(id,accession_id,specimen_id,requested_test_id,patient_id,facility_id,status,
  started_by,started_by_membership_id,started_at,completed_by,completed_by_membership_id,completed_at,
  idempotency_key,request_sha256,correlation_id)
select execution_id,gen_random_uuid(),gen_random_uuid(),test_id,patient_id,facility_id,'completed',doctor,membership,
  clock_timestamp()-interval '90 minutes',doctor,membership,clock_timestamp()-interval '80 minutes',
  'release-execution-'||k||'-000000',repeat('b',64),'release-lab-correlation' from release_lab_ids;
insert into lab.results(id,execution_id,patient_id,facility_id,current_version,created_by,created_by_membership_id)
select result_id,execution_id,patient_id,facility_id,revisions,doctor,membership from release_lab_ids;
insert into lab.result_revisions(result_id,execution_id,patient_id,facility_id,version,result_type,numeric_value,
  text_value,unit,reference_range,abnormal_flag,entered_by,entered_by_membership_id,correction_reason,idempotency_key,
  request_sha256,correlation_id,revision_kind,supersedes_version)
select result_id,execution_id,patient_id,facility_id,v,
  case when k=6 then 'text' else 'numeric' end,
  case when k=6 then null else round(5.0+k+v/10.0, 1) end, case when k=6 then 'Synthetic text result v'||v end,
  case when k=6 then null else 'mmol/L' end,'3.9-5.5',case when v=2 then 'high' else 'normal' end,doctor,membership,
  case when v>1 then 'Synthetic correction reason' end,'release-revision-'||k||'-'||v||'-0000',repeat('c',64),
  'release-lab-correlation',case when v=1 then 'original' else 'correction' end,case when v>1 then v-1 end
from release_lab_ids, generate_series(1,revisions) v;
insert into lab.result_verifications(id,result_id,execution_id,patient_id,facility_id,result_version,verified_by,
  verified_by_membership_id,verified_at,reason,idempotency_key,request_sha256,correlation_id)
select ('c2000000-0000-4000-8000-'||lpad((k*10+v)::text,12,'0'))::uuid,result_id,execution_id,patient_id,facility_id,v,
  doctor,membership,clock_timestamp()-interval '70 minutes'+v*interval '1 minute','Synthetic verification',
  'release-verify-'||k||'-'||v||'-000000',repeat('d',64),'release-lab-correlation'
from release_lab_ids, unnest(verified) v;
insert into lab.result_releases(verification_id,result_id,execution_id,patient_id,facility_id,result_version,released_by,
  released_by_membership_id,released_at,reason,idempotency_key,request_sha256,correlation_id)
select ('c2000000-0000-4000-8000-'||lpad((k*10+v)::text,12,'0'))::uuid,result_id,execution_id,patient_id,facility_id,v,
  doctor,membership,clock_timestamp()-interval '60 minutes'+k*interval '1 minute'+v*interval '10 seconds',
  'Synthetic release reason','release-release-'||k||'-'||v||'-00000',repeat('e',64),'release-lab-correlation'
from release_lab_ids, unnest(released) v;
insert into lab.result_invalidations(result_id,execution_id,patient_id,facility_id,result_version,disposition,actor_id,
  actor_membership_id,reason,idempotency_key,request_sha256,correlation_id)
select result_id,execution_id,patient_id,facility_id,v,'entered_in_error',doctor,membership,
  'Synthetic invalidation reason','release-invalidate-'||k||'-'||v||'-00',repeat('f',64),'release-lab-correlation'
from release_lab_ids, unnest(invalidated) v;

set local session_replication_role = origin;

-- The patient-self binding, as DatabaseService.withPatientTransaction sets it.
create temporary table release_binding(patient text, subject text, account text, session text) on commit drop;
grant all on release_binding to public;
insert into release_binding values ('b2000000-0000-4000-8000-000000000001','synthetic:release:1',
  'b1000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001');
create function pg_temp.bind_self(patient text, subject text, account text, session text) returns void
language sql as $$
  select set_config('app.actor_subject',subject,true), set_config('app.account_id',account,true),
    set_config('app.session_id',session,true), set_config('app.patient_id',patient,true),
    set_config('app.correlation_id','patient-release-integration-0001',true),
    set_config('app.self_authorized_until',(clock_timestamp()+interval '30 seconds')::text,true),
    set_config('app.purpose_of_use','patient-self',true), set_config('app.facility_id','',true),
    set_config('app.membership_id','',true);
$$;
-- As PatientRecordRelease.bind sets it with every release flag on.
create function pg_temp.bind_release(patient text, subject text, account text, session text) returns void
language sql as $$
  select pg_temp.bind_self(patient, subject, account, session),
    set_config('app.patient_release','vitals,diagnoses,prescriptions,labResults,documents',true);
$$;
-- Which released relations the current context reads any row of.
create function pg_temp.release_visible() returns text
language sql as $$
  select concat_ws(',',
    case when exists(select 1 from ehr.vitals) then 'vitals' end,
    case when exists(select 1 from ehr.diagnoses) then 'diagnoses' end,
    case when exists(select 1 from ehr.prescriptions) then 'prescriptions' end,
    case when exists(select 1 from ehr.patient_released_lab_results) then 'labResults' end,
    case when exists(select 1 from ehr.documents) then 'documents' end,
    case when exists(select 1 from ehr.document_scan_events) then 'scan events' end,
    case when exists(select 1 from ehr.documents_effective) then 'documents_effective' end);
$$;
create function pg_temp.release_record(name text, expected text, actual text) returns void
language sql as $$
  insert into release_case_results values (name, expected, coalesce(actual, '<none>'));
$$;

-- 0. The database follows the release flags. The patient is bound to their
--    own live session throughout; only app.patient_release changes. First as
--    an EHR build from before the release binds it (the setting never set in
--    this session), then with each value PatientRecordRelease may set, and
--    with values it never sets, none of which releases anything.
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(patient, subject, account, session) from release_binding;
select pg_temp.release_record('flags never set: the binding is live', 'b7000000-0000-4000-8000-000000000001',
  (select string_agg(id::text, ',' order by id) from ehr.encounters));
select pg_temp.release_record('flags never set (an EHR build before the release)', '<null>:',
  coalesce(current_setting('app.patient_release', true), '<null>') || ':' || pg_temp.release_visible());
do $$
declare
  probe record;
begin
  for probe in select * from (values
    ('', ''),
    ('vitals', 'vitals'),
    ('diagnoses', 'diagnoses'),
    ('prescriptions', 'prescriptions'),
    ('labResults', 'labResults'),
    ('documents', 'documents,scan events,documents_effective'),
    ('vitals,labResults', 'vitals,labResults'),
    ('diagnoses,prescriptions,documents', 'diagnoses,prescriptions,documents,scan events,documents_effective'),
    ('Vitals', ''), (' vitals', ''), ('vitals ', ''), ('vitals;diagnoses', ''), ('lab_results', ''),
    ('labRequests', ''), ('encounters', ''), ('*', ''), ('vitals,,', 'vitals'))
    cases(setting, visible)
  loop
    perform set_config('app.patient_release', probe.setting, true);
    perform pg_temp.release_record('flags ' || quote_literal(probe.setting), probe.visible, pg_temp.release_visible());
  end loop;
end $$;
reset role;

-- 1. The bound patient sees exactly the released rows, through each table,
--    through ehr.documents_effective and through the Lab view.
set local role hid_ehr_api_runtime;
select pg_temp.bind_release(patient, subject, account, session) from release_binding;
select pg_temp.release_record('vitals released',
  'b8000000-0000-4000-8000-000000000001',
  (select string_agg(id::text, ',' order by id) from ehr.vitals));
select pg_temp.release_record('diagnoses released',
  'b9000000-0000-4000-8000-000000000004',
  (select string_agg(id::text, ',' order by id) from ehr.diagnoses));
select pg_temp.release_record('prescriptions released',
  'ba000000-0000-4000-8000-000000000002,ba000000-0000-4000-8000-000000000003,ba000000-0000-4000-8000-000000000004',
  (select string_agg(id::text, ',' order by id) from ehr.prescriptions));
select pg_temp.release_record('documents readable',
  'bb000000-0000-4000-8000-000000000001,bb000000-0000-4000-8000-000000000003,bb000000-0000-4000-8000-000000000004,'
  || 'bb000000-0000-4000-8000-000000000008,bb000000-0000-4000-8000-000000000009',
  (select string_agg(id::text, ',' order by id) from ehr.documents));
select pg_temp.release_record('documents effective status',
  'bb000000-0000-4000-8000-000000000001:available:clean,bb000000-0000-4000-8000-000000000003:rejected:rejected,'
  || 'bb000000-0000-4000-8000-000000000004:uploaded:pending,bb000000-0000-4000-8000-000000000008:uploaded:pending,'
  || 'bb000000-0000-4000-8000-000000000009:rejected:rejected',
  (select string_agg(id::text||':'||status||':'||scan_status, ',' order by id) from ehr.documents_effective));
select pg_temp.release_record('scan events readable',
  'bb000000-0000-4000-8000-000000000001,bb000000-0000-4000-8000-000000000003,bb000000-0000-4000-8000-000000000008,'
  || 'bb000000-0000-4000-8000-000000000009,bb000000-0000-4000-8000-000000000009',
  (select string_agg(document_id::text, ',' order by document_id) from ehr.document_scan_events));
select pg_temp.release_record('lab results released',
  'c1000000-0000-4000-8000-000000000001:1:original:numeric,c1000000-0000-4000-8000-000000000002:1:original:numeric,'
  || 'c1000000-0000-4000-8000-000000000006:2:correction:text',
  (select string_agg(result_id::text||':'||version||':'||revision_kind||':'||result_type, ',' order by result_id)
     from ehr.patient_released_lab_results));
select pg_temp.release_record('lab result values and source',
  'c1000000-0000-4000-8000-000000000001|b7000000-0000-4000-8000-000000000001|bc000000-0000-4000-8000-000000000001|'
  || 'b4000000-0000-4000-8000-000000000002|2345-1|Synthetic glucose 1|6.1|mmol/L|3.9-5.5|normal',
  (select string_agg(concat_ws('|', result_id, encounter_id, source_ehr_order_id, facility_id, test_code, test_name,
       numeric_value, unit, reference_range, abnormal_flag), ',')
     from ehr.patient_released_lab_results where result_id = 'c1000000-0000-4000-8000-000000000001'));
select pg_temp.release_record('lab text value is the released revision',
  'Synthetic text result v2', (select text_value from ehr.patient_released_lab_results
    where result_id = 'c1000000-0000-4000-8000-000000000006'));
-- The patient context cannot write any released table.
do $$
declare
  target text;
  outcome text;
begin
  foreach target in array array['ehr.vitals', 'ehr.diagnoses', 'ehr.prescriptions', 'ehr.documents'] loop
    begin
      execute format('update %s set updated_at = updated_at', target);
      get diagnostics outcome = row_count;
      outcome := 'updated ' || outcome;
    exception when insufficient_privilege then outcome := 'refused';
    end;
    perform pg_temp.release_record('patient context writes ' || target,
      case when outcome = 'refused' then 'refused' else 'updated 0' end, outcome);
  end loop;
  begin
    insert into ehr.document_scan_events(document_id,patient_id,facility_id,created_by,event_type,scanner_engine,
      scanner_version,idempotency_key,correlation_id)
    values ('bb000000-0000-4000-8000-000000000004','b2000000-0000-4000-8000-000000000001',
      'b4000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000001','scan_started','x','1',
      'release-forged-scan-0000','release-forged-scan');
    outcome := 'inserted';
  exception when insufficient_privilege then outcome := 'refused';
  end;
  perform pg_temp.release_record('patient context appends a scan event', 'refused', outcome);
  begin
    perform 1 from ehr.patient_released_lab_results for update;
    outcome := 'locked';
  exception when others then outcome := 'refused';
  end;
  perform pg_temp.release_record('patient context locks the Lab view', 'refused', outcome);
end $$;
reset role;

-- 2. Unbound contexts read nothing: the 0091 probes (another patient,
--    missing, revoked, another account's or subject's session, a non-UUID
--    session) and an expired authorization.
update auth.sessions set revoked_at=clock_timestamp(),revocation_reason='synthetic-test'
  where id='b3000000-0000-4000-8000-000000000002';
-- Patient 2 holds a released Lab result (case 9) and a released vital-free
-- completed encounter; patient 1's binding to another account or subject
-- must hide patient 1's own rows.
set local role hid_ehr_api_runtime;
do $$
declare
  probe record;
  leaked text;
begin
  for probe in select * from (values
    ('another patient with the caller''s own live session',
     'b2000000-0000-4000-8000-000000000002','synthetic:release:1','b1000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001'),
    ('another patient with a session that does not exist',
     'b2000000-0000-4000-8000-000000000002','synthetic:release:2','b1000000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000099'),
    ('a patient whose own session is revoked',
     'b2000000-0000-4000-8000-000000000002','synthetic:release:2','b1000000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000002'),
    ('a patient session of another account',
     'b2000000-0000-4000-8000-000000000002','synthetic:release:2','b1000000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000001'),
    ('the patient''s own session under another account id',
     'b2000000-0000-4000-8000-000000000001','synthetic:release:1','b1000000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000001'),
    ('the patient''s own session under another subject',
     'b2000000-0000-4000-8000-000000000001','synthetic:release:2','b1000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001'),
    ('a session id that is not a UUID',
     'b2000000-0000-4000-8000-000000000001','synthetic:release:1','b1000000-0000-4000-8000-000000000001','not-a-session-id'))
    cases(label, patient, subject, account, session)
  loop
    perform pg_temp.bind_release(probe.patient, probe.subject, probe.account, probe.session);
    select concat_ws(',',
        case when exists(select 1 from ehr.vitals) then 'vitals' end,
        case when exists(select 1 from ehr.diagnoses) then 'diagnoses' end,
        case when exists(select 1 from ehr.prescriptions) then 'prescriptions' end,
        case when exists(select 1 from ehr.documents) then 'documents' end,
        case when exists(select 1 from ehr.document_scan_events) then 'scan events' end,
        case when exists(select 1 from ehr.documents_effective) then 'documents_effective' end,
        case when exists(select 1 from ehr.patient_released_lab_results) then 'lab results' end)
      into leaked;
    perform pg_temp.release_record('unbound: ' || probe.label, '', leaked);
  end loop;
end $$;
-- An expired authorization, in statements of their own: patient-self compares
-- it with the statement's start, which inside one DO block would be the
-- block's start (patient-self.integration.sql does the same).
select pg_temp.bind_release('b2000000-0000-4000-8000-000000000001','synthetic:release:1',
  'b1000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001');
select set_config('app.self_authorized_until',(clock_timestamp()-interval '1 second')::text,true);
select pg_temp.release_record('unbound: an expired self authorization', '0',
  ((select count(*) from ehr.vitals) + (select count(*) from ehr.diagnoses) + (select count(*) from ehr.prescriptions)
    + (select count(*) from ehr.documents) + (select count(*) from ehr.patient_released_lab_results))::text);
-- A staff direct-care context whose consent covers patient 1 reads no released
-- Lab result through the view, even with every release category named: the
-- view serves only the bound patient-self context. The first case shows the
-- consent reaches the encounter, so only the view's own condition refuses.
select set_config('app.actor_subject','synthetic:release:3',true),
  set_config('app.account_id','b1000000-0000-4000-8000-000000000003',true), set_config('app.session_id','',true),
  set_config('app.membership_id','b6000000-0000-4000-8000-000000000001',true),
  set_config('app.facility_id','b4000000-0000-4000-8000-000000000002',true),
  set_config('app.purpose_of_use','direct-care',true), set_config('app.patient_id','',true),
  set_config('app.self_authorized_until','',true),
  set_config('app.patient_release','vitals,diagnoses,prescriptions,labResults,documents',true);
select pg_temp.release_record('staff context with consent reads the completed encounter', '1',
  (select count(*)::text from ehr.encounters where id = 'b7000000-0000-4000-8000-000000000001'));
select pg_temp.release_record('staff context reads the Lab view', '0',
  (select count(*)::text from ehr.patient_released_lab_results));
reset role;
update auth.sessions set revoked_at=null,revocation_reason=null where id='b3000000-0000-4000-8000-000000000002';

-- Patient 2 bound to its own session sees its own released Lab result only.
set local role hid_ehr_api_runtime;
select pg_temp.bind_release('b2000000-0000-4000-8000-000000000002','synthetic:release:2',
  'b1000000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000002');
select pg_temp.release_record('patient 2 lab results', 'c1000000-0000-4000-8000-000000000009:1',
  (select string_agg(result_id::text||':'||version, ',') from ehr.patient_released_lab_results));
select pg_temp.release_record('patient 2 vitals', '',
  coalesce((select string_agg(id::text, ',') from ehr.vitals where encounter_id <> 'b7000000-0000-4000-8000-000000000006'), ''));
reset role;

-- 3. The Lab runtimes, the view's owner and PUBLIC cannot read the view, and
--    Lab never gains the patient-self context.
do $$
declare
  role_name text;
  outcome text;
begin
  foreach role_name in array array['hid_lab_api_runtime', 'hid_lab_runtime', 'hid_identity_api_runtime',
      'hid_lab_release_reader'] loop
    execute format('set local role %I', role_name);
    begin
      perform 1 from ehr.patient_released_lab_results limit 1;
      outcome := 'read';
    exception when insufficient_privilege then outcome := 'refused';
    end;
    reset role;
    perform pg_temp.release_record(role_name || ' reads the Lab view', 'refused', outcome);
  end loop;
end $$;
select pg_temp.release_record('Lab and owner privileges', 'f,f,f,f,f,f,f,f,f',
  concat_ws(',',
    has_function_privilege('hid_lab_runtime', 'ehr.patient_self_context(uuid)', 'EXECUTE'),
    has_function_privilege('hid_lab_api_runtime', 'ehr.patient_self_context(uuid)', 'EXECUTE'),
    has_function_privilege('hid_lab_release_reader', 'ehr.patient_self_context(uuid)', 'EXECUTE'),
    has_function_privilege('public', 'ehr.patient_self_context(uuid)', 'EXECUTE'),
    has_schema_privilege('hid_lab_runtime', 'ehr', 'USAGE'),
    has_table_privilege('public', 'ehr.patient_released_lab_results', 'SELECT'),
    has_table_privilege('hid_lab_api_runtime', 'ehr.patient_released_lab_results', 'SELECT'),
    has_table_privilege('hid_identity_api_runtime', 'ehr.patient_released_lab_results', 'SELECT'),
    exists (select 1 from pg_auth_members where roleid = 'hid_lab_release_reader'::regrole
             and (inherit_option or set_option))));
select pg_temp.release_record('patient-self context EXECUTE holders',
  'hid_ehr_runtime,hid_schema_test_runtime',
  (select string_agg(privilege.grantee::regrole::text, ',' order by privilege.grantee::regrole::text)
     from pg_proc proc, aclexplode(proc.proacl) privilege
    where proc.oid = 'ehr.patient_self_context(uuid)'::regprocedure and privilege.grantee <> proc.proowner));
select pg_temp.release_record('Lab view owner and readers',
  'hid_lab_release_reader|f|v|hid_ehr_runtime,hid_schema_test_runtime',
  (select concat_ws('|', relation.relowner::regrole::text, owner_role.rolcanlogin, relation.relkind,
      (select string_agg(privilege.grantee::regrole::text, ',' order by privilege.grantee::regrole::text)
         from aclexplode(relation.relacl) privilege where privilege.grantee <> relation.relowner))
     from pg_class relation join pg_roles owner_role on owner_role.oid = relation.relowner
    where relation.oid = 'ehr.patient_released_lab_results'::regclass));
select pg_temp.release_record('Lab view options', 'security_barrier=true',
  (select array_to_string(reloptions, ',') from pg_class where oid = 'ehr.patient_released_lab_results'::regclass));
select pg_temp.release_record('Lab view columns',
  'result_id,patient_id,encounter_id,source_ehr_order_id,facility_id,test_code_system,test_code,test_name,version,'
  || 'revision_kind,result_type,numeric_value,text_value,unit,reference_range,abnormal_flag,released_at',
  (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
    where table_schema = 'ehr' and table_name = 'patient_released_lab_results'));

-- 4. The exact policy inventory of every table the release reads. A database
--    built from a branch that carries other patient-self policies (for
--    example diagnoses_patient_self_read, vitals_patient_self_read,
--    vital_corrections_patient_self_read, investigations_patient_self_read,
--    documents_patient_self_read, document_scans_patient_self_read or
--    lab_patient_self_read) fails here: permissive policies are OR-ed, so any
--    of them would widen the release.
select pg_temp.release_record('policy inventory',
  'ehr.diagnoses:diagnoses_insert(public)/diagnoses_patient_release_read(public)/diagnoses_read(public)/diagnoses_update(public);'
  || 'ehr.document_scan_events:document_scan_events_patient_release_read(public)/document_scan_events_scanner_function_read(public)/'
  || 'document_scan_events_staff_read(public)/document_scan_events_workload_insert(public);'
  || 'ehr.documents:documents_insert(public)/documents_patient_release_read(public)/documents_read(public)/'
  || 'documents_scanner_function_read(public)/documents_update(public);'
  || 'ehr.encounters:encounters_insert(public)/encounters_patient_self_read(public)/encounters_read(public)/encounters_update(public);'
  || 'ehr.lab_requests:lab_requests_insert(public)/lab_requests_read(public)/lab_requests_update(public)/'
  || 'patient_release_reader_read(hid_lab_release_reader);'
  || 'ehr.prescriptions:prescriptions_insert(public)/prescriptions_patient_release_read(public)/prescriptions_read(public)/'
  || 'prescriptions_update(public);'
  || 'ehr.vital_corrections:vital_corrections_insert(public)/vital_corrections_read(public);'
  || 'ehr.vitals:vitals_insert(public)/vitals_patient_release_read(public)/vitals_read(public)/vitals_update(public);'
  || 'lab.result_invalidations:lab_invalidations_insert(public)/lab_invalidations_read(public)/'
  || 'patient_release_reader_read(hid_lab_release_reader);'
  || 'lab.result_releases:lab_releases_insert(public)/lab_releases_read(public)/patient_release_reader_read(hid_lab_release_reader);'
  || 'lab.result_revisions:lab_result_revisions_insert(public)/lab_result_revisions_read(public)/'
  || 'patient_release_reader_read(hid_lab_release_reader);'
  || 'lab.result_verifications:lab_verifications_insert(public)/lab_verifications_read(public);'
  || 'lab.results:lab_results_insert(public)/lab_results_read(public)/lab_results_update(public)/'
  || 'patient_release_reader_read(hid_lab_release_reader);'
  || 'lab.specimens:lab_specimens_insert(public)/lab_specimens_read(public)/lab_specimens_update(public);'
  || 'lab.test_executions:lab_executions_insert(public)/lab_executions_read(public)/lab_executions_update(public)/'
  || 'patient_release_reader_read(hid_lab_release_reader);'
  || 'lab.work_item_requested_tests:lab_work_item_tests_insert(public)/lab_work_item_tests_read(public)/'
  || 'patient_release_reader_read(hid_lab_release_reader);'
  || 'lab.work_items:lab_work_items_insert(public)/lab_work_items_read(public)/patient_release_reader_read(hid_lab_release_reader)',
  (select string_agg(inventory.entry, ';' order by inventory.entry)
     from (select schemaname||'.'||tablename||':'||string_agg(policyname||'('||array_to_string(roles,'|')||')', '/'
                    order by policyname) as entry
             from pg_policies
            where (schemaname, tablename) in (('ehr','vitals'),('ehr','vital_corrections'),('ehr','diagnoses'),
                ('ehr','prescriptions'),('ehr','documents'),('ehr','document_scan_events'),('ehr','lab_requests'),
                ('ehr','encounters'),('lab','results'),('lab','result_revisions'),('lab','result_releases'),
                ('lab','result_invalidations'),('lab','result_verifications'),('lab','test_executions'),
                ('lab','work_items'),('lab','work_item_requested_tests'),('lab','specimens'))
            group by schemaname, tablename) inventory));
select pg_temp.release_record('technical owner policies are true and select-only',
  '8', (select count(*)::text from pg_policy policy
    where policy.polname = 'patient_release_reader_read' and policy.polcmd = 'r' and policy.polpermissive
      and policy.polroles = array['hid_lab_release_reader'::regrole::oid]
      and pg_get_expr(policy.polqual, policy.polrelid) = 'true' and policy.polwithcheck is null));

-- 4b. Each release policy and the view require the patient-self binding and
--     their own category in app.patient_release. A policy without its
--     patient-self condition still reads nothing in any behaviour case above
--     (its encounter's own policy hides the row), so the catalogue says it.
select pg_temp.release_record('release policies require the binding and their category',
  'diagnoses_patient_release_read:diagnoses:true,document_scan_events_patient_release_read:documents:true,'
  || 'documents_patient_release_read:documents:true,prescriptions_patient_release_read:prescriptions:true,'
  || 'vitals_patient_release_read:vitals:true',
  (select string_agg(policy.polname || ':' || coalesce(substring(pg_get_expr(policy.polqual, policy.polrelid)
        from '^\(\(''([A-Za-z]+)''::text = ANY \(string_to_array\(current_setting\(''app\.patient_release''::text, true\), '',''::text\)\)\) AND '), '<none>')
      || ':' || (position('ehr.patient_self_context(patient_id)' in pg_get_expr(policy.polqual, policy.polrelid)) > 0),
      ',' order by policy.polname)
     from pg_policy policy where policy.polname like '%\_patient\_release\_read'
       and policy.polrelid::regclass::text like 'ehr.%'));
select pg_temp.release_record('Lab view requires the binding and its category', 't,t',
  (select concat_ws(',',
     position('ehr.patient_self_context(release_row.patient_id)' in pg_get_viewdef('ehr.patient_released_lab_results'::regclass)) > 0,
     position('(''labResults''::text = ANY (string_to_array(current_setting(''app.patient_release''::text, true), '',''::text)))'
       in pg_get_viewdef('ehr.patient_released_lab_results'::regclass)) > 0)));
-- Each section reads its newest rows through an index in its own order, so
-- it stops after the rows it shows instead of checking every row's policy.
select pg_temp.release_record('section indexes',
  'diagnoses:diagnoses_patient_release_idx:(patient_id, created_at DESC, id DESC),'
  || 'prescriptions:prescriptions_patient_release_idx:(patient_id, created_at DESC, id DESC),'
  || 'vitals:vitals_patient_release_idx:(patient_id, recorded_at DESC, id DESC)',
  (select string_agg(tablename || ':' || indexname || ':' || substring(indexdef from '\(.*\)$'), ',' order by tablename)
     from pg_indexes where schemaname = 'ehr' and indexname like '%\_patient\_release\_idx'));

-- 5. Changes after release (undone with the suite): a released correction
--    replaces the earlier value, an invalidated release disappears, and
--    retracting the completed encounter hides every item of it, its Lab
--    results included.
set local session_replication_role = replica;
insert into lab.result_verifications(id,result_id,execution_id,patient_id,facility_id,result_version,verified_by,
  verified_by_membership_id,verified_at,reason,idempotency_key,request_sha256,correlation_id)
values ('c2000000-0000-4000-8000-000000000022','c1000000-0000-4000-8000-000000000002',
  'bf000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000002',
  2,'b1000000-0000-4000-8000-000000000003','b6000000-0000-4000-8000-000000000001',clock_timestamp(),
  'Synthetic verification','release-verify-2-2-later-0',repeat('d',64),'release-lab-correlation');
insert into lab.result_releases(verification_id,result_id,execution_id,patient_id,facility_id,result_version,released_by,
  released_by_membership_id,released_at,reason,idempotency_key,request_sha256,correlation_id)
values ('c2000000-0000-4000-8000-000000000022','c1000000-0000-4000-8000-000000000002',
  'bf000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000002',
  2,'b1000000-0000-4000-8000-000000000003','b6000000-0000-4000-8000-000000000001',clock_timestamp(),
  'Synthetic release reason','release-release-2-2-later-',repeat('e',64),'release-lab-correlation');
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.bind_release(patient, subject, account, session) from release_binding;
select pg_temp.release_record('a released correction replaces the earlier value', '2:correction:high',
  (select version||':'||revision_kind||':'||abnormal_flag from ehr.patient_released_lab_results
    where result_id = 'c1000000-0000-4000-8000-000000000002'));
reset role;
set local session_replication_role = replica;
insert into lab.result_invalidations(result_id,execution_id,patient_id,facility_id,result_version,disposition,actor_id,
  actor_membership_id,reason,idempotency_key,request_sha256,correlation_id)
values ('c1000000-0000-4000-8000-000000000002','bf000000-0000-4000-8000-000000000002',
  'b2000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000002',2,'entered_in_error',
  'b1000000-0000-4000-8000-000000000003','b6000000-0000-4000-8000-000000000001','Synthetic invalidation reason',
  'release-invalidate-2-2-later',repeat('f',64),'release-lab-correlation');
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.bind_release(patient, subject, account, session) from release_binding;
select pg_temp.release_record('an invalidated latest release is withheld', '0',
  (select count(*)::text from ehr.patient_released_lab_results where result_id = 'c1000000-0000-4000-8000-000000000002'));
reset role;
set local session_replication_role = replica;
update ehr.encounters set status = 'entered_in_error' where id = 'b7000000-0000-4000-8000-000000000001';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.bind_release(patient, subject, account, session) from release_binding;
select pg_temp.release_record('a retracted encounter hides every released item', '0,0,0,0,0,0',
  concat_ws(',', (select count(*) from ehr.vitals), (select count(*) from ehr.diagnoses),
    (select count(*) from ehr.prescriptions), (select count(*) from ehr.documents),
    (select count(*) from ehr.documents_effective), (select count(*) from ehr.patient_released_lab_results)));
reset role;

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by name)
    into failures from release_case_results where expected is distinct from actual;
  if failures is not null then
    raise exception E'patient record release cases differ from the release rules:\n%', failures;
  end if;
  if (select count(*) from release_case_results) < 30 then
    raise exception 'patient record release suite recorded only % cases', (select count(*) from release_case_results);
  end if;
end $$;
rollback;
