-- Exact-version EHR laboratory-order acceptance into Lab-owned operational work.
-- A work item is not an accession, specimen, execution, QC record, or result.
-- Applied migrations 0001 through 0017 remain immutable.

insert into auth.permissions(code,description) values
  ('lab.work-item.read','Read authorized Lab-owned work items'),
  ('lab.work-item.accept','Accept exact active EHR laboratory-order intent into Lab work');
insert into auth.role_permissions(role_code,permission_code)
select role_code,permission_code from (values
  ('doctor','lab.work-item.read'),('doctor','lab.work-item.accept'),
  ('clinician','lab.work-item.read'),('clinician','lab.work-item.accept'),
  ('nurse','lab.work-item.read'),('nurse','lab.work-item.accept'),
  ('lab','lab.work-item.read'),('lab','lab.work-item.accept'),
  ('admin','lab.work-item.read')
) mapping(role_code,permission_code);

create table lab.work_items (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  ordering_facility_id uuid not null references identity.facilities(id) on delete restrict,
  source_ehr_order_id uuid not null,
  source_ehr_order_version bigint not null check(source_ehr_order_version>0),
  source_encounter_id uuid not null,
  status text not null default 'accepted' check(status='accepted'),
  priority text not null check(priority in ('routine','urgent','asap','stat')),
  test_code_system text not null check(length(btrim(test_code_system)) between 1 and 255),
  test_code text not null check(length(btrim(test_code)) between 1 and 100),
  test_name text not null check(length(btrim(test_name)) between 1 and 500),
  clinical_indication text check(clinical_indication is null or length(clinical_indication)<=4000),
  requested_by uuid not null references auth.accounts(id) on delete restrict,
  requested_at timestamptz not null,
  accepted_by uuid not null references auth.accounts(id) on delete restrict,
  accepted_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  accepted_at timestamptz not null default clock_timestamp(),
  idempotency_key text not null check(idempotency_key~'^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check(request_sha256~'^[0-9a-f]{64}$'),
  correlation_id text not null check(length(correlation_id) between 8 and 128),
  row_version bigint not null default 1 check(row_version=1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(source_ehr_order_id,patient_id,facility_id)
    references ehr.lab_requests(id,patient_id,facility_id) on delete restrict,
  foreign key(source_encounter_id,patient_id,facility_id)
    references ehr.encounters(id,patient_id,facility_id) on delete restrict,
  foreign key(accepted_by_membership_id,facility_id,accepted_by)
    references identity.staff_facility_memberships(id,facility_id,account_id) on delete restrict,
  unique(facility_id,accepted_by,idempotency_key),
  unique(source_ehr_order_id,source_ehr_order_version),
  unique(source_ehr_order_id),
  check(facility_id=ordering_facility_id)
);
create index lab_work_items_worklist_idx on lab.work_items(facility_id,status,priority,accepted_at,id);
create index lab_work_items_patient_idx on lab.work_items(facility_id,patient_id,accepted_at desc,id);

create table lab.work_item_requested_tests (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references lab.work_items(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  "ordinal" integer not null check("ordinal" between 1 and 200),
  code_system text not null check(length(btrim(code_system)) between 1 and 255),
  code text not null check(length(btrim(code)) between 1 and 100),
  name text not null check(length(btrim(name)) between 1 and 500),
  created_at timestamptz not null default clock_timestamp(),
  unique(work_item_id,"ordinal")
);

create table lab.work_item_events (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references lab.work_items(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  event_version integer not null check(event_version>0),
  event_type text not null check(event_type='accepted'),
  actor_id uuid not null references auth.accounts(id) on delete restrict,
  actor_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  reason text not null check(length(btrim(reason)) between 8 and 500),
  correlation_id text not null check(length(correlation_id) between 8 and 128),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key(actor_membership_id,facility_id,actor_id)
    references identity.staff_facility_memberships(id,facility_id,account_id) on delete restrict,
  unique(work_item_id,event_version)
);

alter table lab.outbox_events drop constraint outbox_events_event_type_check;
alter table lab.outbox_events add constraint outbox_events_event_type_check check(
  event_type in ('LabImportedEvidenceCreated','LabImportedEvidenceAmended','LabWorkItemCreated'));

create or replace function lab.validate_work_item()
returns trigger language plpgsql security definer
set search_path=lab,ehr,identity,auth,platform,pg_temp as $$
declare source_row ehr.lab_requests%rowtype;
begin
  select * into source_row from ehr.lab_requests where id=new.source_ehr_order_id;
  if source_row.id is null or source_row.patient_id<>new.patient_id
     or source_row.facility_id<>new.facility_id or source_row.encounter_id<>new.source_encounter_id
     or source_row.row_version<>new.source_ehr_order_version or source_row.status<>'active'
     or source_row.test_code_system<>new.test_code_system or source_row.test_code<>new.test_code
     or source_row.test_display<>new.test_name or source_row.priority<>new.priority
     or source_row.clinical_information is distinct from new.clinical_indication
     or source_row.created_by<>new.requested_by or source_row.created_at<>new.requested_at
     or new.facility_id<>platform.current_facility_id()
     or new.accepted_by<>platform.current_account_id()
     or new.accepted_by_membership_id<>platform.current_membership_id() then
    raise exception using errcode='23514',message='Lab work item does not match the exact active EHR order version and actor context';
  end if;
  return new;
end
$$;
create trigger lab_work_item_validate before insert on lab.work_items
  for each row execute function lab.validate_work_item();

create or replace function lab.validate_work_item_child()
returns trigger language plpgsql security definer set search_path=lab,pg_temp as $$
declare parent_row lab.work_items%rowtype;
begin
  select * into parent_row from lab.work_items where id=new.work_item_id;
  if parent_row.id is null or parent_row.facility_id<>new.facility_id
     or parent_row.patient_id<>new.patient_id then
    raise exception using errcode='23514',message='Lab work-item evidence does not match its parent';
  end if;
  if tg_table_name='work_item_requested_tests' and
     (new.ordinal<>1 or new.code_system<>parent_row.test_code_system
      or new.code<>parent_row.test_code or new.name<>parent_row.test_name) then
    raise exception using errcode='23514',message='Requested-test snapshot differs from accepted EHR order';
  end if;
  return new;
end
$$;
create trigger lab_work_item_test_validate before insert on lab.work_item_requested_tests
  for each row execute function lab.validate_work_item_child();
create trigger lab_work_item_event_validate before insert on lab.work_item_events
  for each row execute function lab.validate_work_item_child();

create trigger lab_work_items_immutable before update or delete on lab.work_items
  for each row execute function lab.reject_immutable_evidence();
create trigger lab_work_item_tests_immutable before update or delete on lab.work_item_requested_tests
  for each row execute function lab.reject_immutable_evidence();
create trigger lab_work_item_events_immutable before update or delete on lab.work_item_events
  for each row execute function lab.reject_immutable_evidence();

alter table lab.work_items enable row level security; alter table lab.work_items force row level security;
alter table lab.work_item_requested_tests enable row level security;
alter table lab.work_item_requested_tests force row level security;
alter table lab.work_item_events enable row level security; alter table lab.work_item_events force row level security;
create policy lab_work_items_read on lab.work_items for select
  using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_work_items_insert on lab.work_items for insert
  with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_work_item_tests_read on lab.work_item_requested_tests for select
  using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_work_item_tests_insert on lab.work_item_requested_tests for insert
  with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_work_item_events_read on lab.work_item_events for select
  using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_work_item_events_insert on lab.work_item_events for insert
  with check(lab.context_allows(patient_id,facility_id,'write_records'));

revoke all on lab.work_items,lab.work_item_requested_tests,lab.work_item_events from public;
revoke all on all sequences in schema lab from public;
comment on table lab.work_items is
  'Lab acceptance of exact active EHR order intent; not accession, specimen, execution, QC, verification, or result.';
comment on table lab.work_item_requested_tests is
  'Immutable minimum-necessary requested-test snapshot accepted by Lab.';
comment on table lab.work_item_events is
  'Append-only Lab work-item lifecycle evidence; only acceptance exists in this slice.';
