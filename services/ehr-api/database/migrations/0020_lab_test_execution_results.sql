-- Lab-owned analytical execution and manually entered, explicitly unverified result history.
-- No analyzer, instrument, reagent, calibration, QC, verification, release, or attestation evidence.
-- Applied migrations 0001 through 0019 remain immutable.

insert into auth.permissions(code,description) values
 ('lab.execution.read','Read authorized Lab execution and unverified result evidence'),
 ('lab.execution.start','Start execution for an eligible received specimen and exact requested test'),
 ('lab.execution.complete','Complete an in-progress Lab execution'),
 ('lab.result.enter','Enter a manual unverified result for a completed execution'),
 ('lab.result.correct','Correct a manual unverified result with immutable revision history');
insert into auth.role_permissions(role_code,permission_code)
select role_code,permission_code from (values
 ('lab','lab.execution.read'),('lab','lab.execution.start'),('lab','lab.execution.complete'),
 ('lab','lab.result.enter'),('lab','lab.result.correct'),('admin','lab.execution.read')
) mapping(role_code,permission_code);

create table lab.test_executions (
 id uuid primary key default gen_random_uuid(), accession_id uuid not null, specimen_id uuid not null,
 requested_test_id uuid not null references lab.work_item_requested_tests(id) on delete restrict,
 patient_id uuid not null references identity.patients(id) on delete restrict,
 facility_id uuid not null references identity.facilities(id) on delete restrict,
 status text not null default 'in_progress' check(status in ('in_progress','completed','failed','cancelled')),
 method text check(method is null or length(btrim(method)) between 1 and 240),
 started_by uuid not null references auth.accounts(id) on delete restrict,
 started_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
 started_at timestamptz not null, completed_by uuid references auth.accounts(id) on delete restrict,
 completed_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
 completed_at timestamptz, completion_notes text check(completion_notes is null or length(completion_notes)<=1000),
 completed_idempotency_key text check(completed_idempotency_key is null or completed_idempotency_key~'^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
 completed_request_sha256 char(64) check(completed_request_sha256 is null or completed_request_sha256~'^[0-9a-f]{64}$'),
 idempotency_key text not null check(idempotency_key~'^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
 request_sha256 char(64) not null check(request_sha256~'^[0-9a-f]{64}$'),
 correlation_id text not null check(length(correlation_id) between 8 and 128),
 row_version bigint not null default 1 check(row_version>0), created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 foreign key(specimen_id,accession_id,patient_id,facility_id) references lab.specimens(id,accession_id,patient_id,facility_id) on delete restrict,
 foreign key(started_by_membership_id,facility_id,started_by) references identity.staff_facility_memberships(id,facility_id,account_id),
 foreign key(completed_by_membership_id,facility_id,completed_by) references identity.staff_facility_memberships(id,facility_id,account_id),
 unique(specimen_id,requested_test_id), unique(facility_id,started_by,idempotency_key),
 unique(facility_id,completed_by,completed_idempotency_key), unique(id,patient_id,facility_id),
 check((status='in_progress' and completed_at is null and completed_by is null) or
       (status='completed' and completed_at is not null and completed_by is not null) or status in ('failed','cancelled'))
);
create index lab_test_executions_queue_idx on lab.test_executions(facility_id,status,started_at,id);

create table lab.execution_events (
 id uuid primary key default gen_random_uuid(), execution_id uuid not null, patient_id uuid not null, facility_id uuid not null,
 event_version bigint not null check(event_version>0), event_type text not null check(event_type in ('execution_started','execution_completed')),
 actor_id uuid not null, actor_membership_id uuid not null, reason text not null check(length(btrim(reason)) between 3 and 500),
 correlation_id text not null check(length(correlation_id) between 8 and 128), occurred_at timestamptz not null default clock_timestamp(),
 foreign key(execution_id,patient_id,facility_id) references lab.test_executions(id,patient_id,facility_id) on delete restrict,
 foreign key(actor_membership_id,facility_id,actor_id) references identity.staff_facility_memberships(id,facility_id,account_id),
 unique(execution_id,event_version)
);

create table lab.results (
 id uuid primary key default gen_random_uuid(), execution_id uuid not null unique,
 patient_id uuid not null references identity.patients(id), facility_id uuid not null references identity.facilities(id),
 status text not null default 'entered' check(status='entered'), current_version bigint not null default 1 check(current_version>0),
 created_by uuid not null references auth.accounts(id), created_by_membership_id uuid not null references identity.staff_facility_memberships(id),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 foreign key(execution_id,patient_id,facility_id) references lab.test_executions(id,patient_id,facility_id) on delete restrict,
 foreign key(created_by_membership_id,facility_id,created_by) references identity.staff_facility_memberships(id,facility_id,account_id),
 unique(id,execution_id,patient_id,facility_id)
);

create table lab.result_revisions (
 id uuid primary key default gen_random_uuid(), result_id uuid not null, execution_id uuid not null,
 patient_id uuid not null, facility_id uuid not null, version bigint not null check(version>0),
 result_type text not null check(result_type in ('numeric','text')),
 numeric_value numeric, text_value text, unit text, reference_range text,
 abnormal_flag text not null default 'unknown' check(abnormal_flag in ('normal','high','low','abnormal','critical_candidate','unknown')),
 entry_source text not null default 'manual' check(entry_source='manual'), verification_status text not null default 'unverified' check(verification_status='unverified'),
 entered_by uuid not null, entered_by_membership_id uuid not null, entered_at timestamptz not null default clock_timestamp(),
 correction_reason text, idempotency_key text not null check(idempotency_key~'^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
 request_sha256 char(64) not null check(request_sha256~'^[0-9a-f]{64}$'), correlation_id text not null check(length(correlation_id) between 8 and 128),
 foreign key(result_id,execution_id,patient_id,facility_id) references lab.results(id,execution_id,patient_id,facility_id) on delete restrict,
 foreign key(entered_by_membership_id,facility_id,entered_by) references identity.staff_facility_memberships(id,facility_id,account_id),
 unique(result_id,version), unique(facility_id,entered_by,idempotency_key),
 check((result_type='numeric' and numeric_value is not null and text_value is null) or
       (result_type='text' and text_value is not null and length(btrim(text_value))>0 and numeric_value is null)),
 check(unit is null or length(btrim(unit)) between 1 and 80),
 check(reference_range is null or length(reference_range)<=240),
 check((version=1 and correction_reason is null) or (version>1 and length(btrim(correction_reason)) between 3 and 500))
);
create index lab_result_revisions_history_idx on lab.result_revisions(result_id,version desc);

create table lab.result_events (
 id uuid primary key default gen_random_uuid(), result_id uuid not null, execution_id uuid not null,
 patient_id uuid not null, facility_id uuid not null, event_version bigint not null,
 event_type text not null check(event_type in ('result_entered','result_corrected')), actor_id uuid not null,
 actor_membership_id uuid not null, reason text not null check(length(btrim(reason)) between 3 and 500),
 correlation_id text not null check(length(correlation_id) between 8 and 128), occurred_at timestamptz not null default clock_timestamp(),
 foreign key(result_id,execution_id,patient_id,facility_id) references lab.results(id,execution_id,patient_id,facility_id),
 foreign key(actor_membership_id,facility_id,actor_id) references identity.staff_facility_memberships(id,facility_id,account_id),
 unique(result_id,event_version)
);

alter table lab.outbox_events drop constraint outbox_events_event_type_check;
alter table lab.outbox_events add constraint outbox_events_event_type_check check(event_type in
 ('LabImportedEvidenceCreated','LabImportedEvidenceAmended','LabWorkItemCreated','LabAccessionCreated',
  'LabSpecimenCollected','LabSpecimenReceived','LabSpecimenRejected','LabTestExecutionStarted',
  'LabTestExecutionCompleted','LabResultEntered','LabResultCorrected'));

create or replace function lab.validate_execution_insert() returns trigger language plpgsql security definer
set search_path=lab,platform,pg_temp as $$ declare specimen lab.specimens%rowtype; accession lab.accessions%rowtype; test lab.work_item_requested_tests%rowtype; begin
 select * into specimen from lab.specimens where id=new.specimen_id;
 select * into accession from lab.accessions where id=new.accession_id;
 select * into test from lab.work_item_requested_tests where id=new.requested_test_id;
 if specimen.id is null or specimen.status<>'received' or specimen.accession_id<>new.accession_id
   or specimen.patient_id<>new.patient_id or specimen.facility_id<>new.facility_id
   or accession.id is null or accession.patient_id<>new.patient_id or accession.facility_id<>new.facility_id
   or test.id is null or test.work_item_id<>accession.work_item_id or test.patient_id<>new.patient_id or test.facility_id<>new.facility_id
   or new.facility_id<>platform.current_facility_id() or new.started_by<>platform.current_account_id()
   or new.started_by_membership_id<>platform.current_membership_id() then
  raise exception using errcode='23514',message='Execution must match a received specimen and exact requested test'; end if;
 return new; end $$;
create trigger lab_execution_insert_validate before insert on lab.test_executions for each row execute function lab.validate_execution_insert();

create or replace function lab.validate_execution_transition() returns trigger language plpgsql set search_path=lab,platform,pg_temp as $$ begin
 if old.id<>new.id or old.accession_id<>new.accession_id or old.specimen_id<>new.specimen_id or old.requested_test_id<>new.requested_test_id
  or old.patient_id<>new.patient_id or old.facility_id<>new.facility_id or old.method is distinct from new.method
  or new.facility_id<>platform.current_facility_id() or new.row_version<>old.row_version+1
  or not(old.status='in_progress' and new.status='completed') then
  raise exception using errcode='23514',message='Illegal or stale execution transition'; end if;
 new.updated_at=clock_timestamp(); return new; end $$;
create trigger lab_execution_transition before update on lab.test_executions for each row execute function lab.validate_execution_transition();
create trigger lab_execution_no_delete before delete on lab.test_executions for each row execute function lab.reject_immutable_evidence();

create or replace function lab.validate_result_insert() returns trigger language plpgsql security definer
set search_path=lab,platform,pg_temp as $$ declare execution lab.test_executions%rowtype; begin
 select * into execution from lab.test_executions where id=new.execution_id;
 if execution.id is null or execution.status<>'completed' or execution.patient_id<>new.patient_id or execution.facility_id<>new.facility_id
  or new.facility_id<>platform.current_facility_id() then raise exception using errcode='23514',message='Result requires exact completed execution'; end if;
 return new; end $$;
create trigger lab_result_insert_validate before insert on lab.results for each row execute function lab.validate_result_insert();

create or replace function lab.validate_result_head_update() returns trigger language plpgsql set search_path=lab,platform,pg_temp as $$ begin
 if old.id<>new.id or old.execution_id<>new.execution_id or old.patient_id<>new.patient_id or old.facility_id<>new.facility_id
  or old.status<>new.status or new.current_version<>old.current_version+1 or new.facility_id<>platform.current_facility_id()
  then raise exception using errcode='23514',message='Illegal or stale result head update'; end if;
 new.updated_at=clock_timestamp(); return new; end $$;
create trigger lab_result_head_update before update on lab.results for each row execute function lab.validate_result_head_update();
create trigger lab_result_no_delete before delete on lab.results for each row execute function lab.reject_immutable_evidence();

create or replace function lab.validate_result_revision() returns trigger language plpgsql security definer set search_path=lab,pg_temp as $$ declare head lab.results%rowtype; begin
 select * into head from lab.results where id=new.result_id;
 if head.id is null or head.execution_id<>new.execution_id or head.patient_id<>new.patient_id or head.facility_id<>new.facility_id
  or new.version<>head.current_version then raise exception using errcode='23514',message='Result revision does not match current result head'; end if;
 return new; end $$;
create trigger lab_result_revision_validate before insert on lab.result_revisions for each row execute function lab.validate_result_revision();
create trigger lab_result_revisions_immutable before update or delete on lab.result_revisions for each row execute function lab.reject_immutable_evidence();
create trigger lab_execution_events_immutable before update or delete on lab.execution_events for each row execute function lab.reject_immutable_evidence();
create trigger lab_result_events_immutable before update or delete on lab.result_events for each row execute function lab.reject_immutable_evidence();

create or replace function lab.validate_execution_child() returns trigger language plpgsql security definer set search_path=lab,platform,pg_temp as $$ declare execution lab.test_executions%rowtype; begin
 select * into execution from lab.test_executions where id=new.execution_id;
 if execution.id is null or execution.patient_id<>new.patient_id or execution.facility_id<>new.facility_id
  or new.facility_id<>platform.current_facility_id() then raise exception using errcode='23514',message='Execution child integrity failure'; end if;
 return new; end $$;
create trigger lab_execution_event_validate before insert on lab.execution_events for each row execute function lab.validate_execution_child();
create trigger lab_result_event_validate before insert on lab.result_events for each row execute function lab.validate_execution_child();

alter table lab.test_executions enable row level security; alter table lab.test_executions force row level security;
alter table lab.execution_events enable row level security; alter table lab.execution_events force row level security;
alter table lab.results enable row level security; alter table lab.results force row level security;
alter table lab.result_revisions enable row level security; alter table lab.result_revisions force row level security;
alter table lab.result_events enable row level security; alter table lab.result_events force row level security;
create policy lab_executions_read on lab.test_executions for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_executions_insert on lab.test_executions for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_executions_update on lab.test_executions for update using(lab.context_allows(patient_id,facility_id,'write_records')) with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_execution_events_read on lab.execution_events for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_execution_events_insert on lab.execution_events for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_results_read on lab.results for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_results_insert on lab.results for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_results_update on lab.results for update using(lab.context_allows(patient_id,facility_id,'write_records')) with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_result_revisions_read on lab.result_revisions for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_result_revisions_insert on lab.result_revisions for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_result_events_read on lab.result_events for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_result_events_insert on lab.result_events for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));

revoke all on lab.test_executions,lab.execution_events,lab.results,lab.result_revisions,lab.result_events from public;
comment on table lab.test_executions is 'Lab analytical execution for exact received specimen/requested test; completion is not verification.';
comment on table lab.result_revisions is 'Immutable manually entered, explicitly unverified result history; no analyzer, QC, release, or attestation claim.';
