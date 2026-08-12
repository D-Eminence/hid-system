-- Lab-owned accession and specimen custody foundation.
-- Receipt is not analysis; this migration creates no execution, QC, or result state.
-- Applied migrations 0001 through 0018 remain immutable.

insert into auth.permissions(code,description) values
  ('lab.accession.read','Read authorized Lab accessions and specimen lifecycle'),
  ('lab.accession.create','Create a governed Lab accession from accepted work'),
  ('lab.specimen.collect','Record explicit Lab specimen collection'),
  ('lab.specimen.receive','Record explicit Lab specimen receipt'),
  ('lab.specimen.reject','Reject an unsuitable collected Lab specimen');
insert into auth.role_permissions(role_code,permission_code)
select role_code,permission_code from (values
  ('lab','lab.accession.read'),('lab','lab.accession.create'),
  ('lab','lab.specimen.collect'),('lab','lab.specimen.receive'),('lab','lab.specimen.reject'),
  ('admin','lab.accession.read')
) mapping(role_code,permission_code);

create sequence lab.accession_number_seq;
create sequence lab.specimen_identifier_seq;

create table lab.accessions (
  id uuid primary key default gen_random_uuid(),
  accession_number text not null default
    ('LAB-'||to_char(clock_timestamp(),'YYYYMMDD')||'-'||lpad(nextval('lab.accession_number_seq')::text,10,'0')),
  work_item_id uuid not null references lab.work_items(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  status text not null default 'accessioned' check(status='accessioned'),
  priority text not null check(priority in ('routine','urgent','asap','stat')),
  created_by uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  idempotency_key text not null check(idempotency_key~'^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check(request_sha256~'^[0-9a-f]{64}$'),
  correlation_id text not null check(length(correlation_id) between 8 and 128),
  row_version bigint not null default 1 check(row_version=1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(created_by_membership_id,facility_id,created_by)
    references identity.staff_facility_memberships(id,facility_id,account_id) on delete restrict,
  unique(accession_number), unique(work_item_id), unique(facility_id,created_by,idempotency_key),
  unique(id,patient_id,facility_id)
);
create index lab_accessions_queue_idx on lab.accessions(facility_id,status,priority,created_at,id);
create index lab_accessions_patient_idx on lab.accessions(facility_id,patient_id,created_at desc,id);

create table lab.specimen_requirements (
  id uuid primary key default gen_random_uuid(),
  accession_id uuid not null,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  ordinal integer not null check(ordinal between 1 and 50),
  specimen_type text not null check(length(btrim(specimen_type)) between 1 and 240),
  container_type text check(container_type is null or length(btrim(container_type)) between 1 and 240),
  notes text check(notes is null or length(notes)<=1000),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(accession_id,patient_id,facility_id)
    references lab.accessions(id,patient_id,facility_id) on delete restrict,
  unique(accession_id,ordinal), unique(id,accession_id,patient_id,facility_id)
);

create table lab.specimens (
  id uuid primary key default gen_random_uuid(),
  specimen_identifier text not null default
    ('SPC-'||to_char(clock_timestamp(),'YYYYMMDD')||'-'||lpad(nextval('lab.specimen_identifier_seq')::text,10,'0')),
  requirement_id uuid not null,
  accession_id uuid not null,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  collection_ordinal integer not null default 1 check(collection_ordinal between 1 and 100),
  specimen_type text not null check(length(btrim(specimen_type)) between 1 and 240),
  container_type text check(container_type is null or length(btrim(container_type)) between 1 and 240),
  status text not null default 'required'
    check(status in ('required','collected','received','rejected','cancelled','entered_in_error')),
  collected_at timestamptz,
  collected_by uuid references auth.accounts(id) on delete restrict,
  collected_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  collection_notes text check(collection_notes is null or length(collection_notes)<=1000),
  received_at timestamptz,
  received_by uuid references auth.accounts(id) on delete restrict,
  received_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  receipt_condition text check(receipt_condition is null or length(receipt_condition)<=500),
  rejected_at timestamptz,
  rejected_by uuid references auth.accounts(id) on delete restrict,
  rejected_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  rejection_reason text check(rejection_reason is null or length(btrim(rejection_reason)) between 3 and 500),
  row_version bigint not null default 1 check(row_version>0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(requirement_id,accession_id,patient_id,facility_id)
    references lab.specimen_requirements(id,accession_id,patient_id,facility_id) on delete restrict,
  foreign key(collected_by_membership_id,facility_id,collected_by)
    references identity.staff_facility_memberships(id,facility_id,account_id) on delete restrict,
  foreign key(received_by_membership_id,facility_id,received_by)
    references identity.staff_facility_memberships(id,facility_id,account_id) on delete restrict,
  foreign key(rejected_by_membership_id,facility_id,rejected_by)
    references identity.staff_facility_memberships(id,facility_id,account_id) on delete restrict,
  unique(specimen_identifier), unique(requirement_id,collection_ordinal), unique(id,accession_id,patient_id,facility_id),
  unique(id,patient_id,facility_id),
  check(
    (status='required' and collected_at is null and collected_by is null and received_at is null and rejected_at is null)
    or (status='collected' and collected_at is not null and collected_by is not null and received_at is null and rejected_at is null)
    or (status='received' and collected_at is not null and collected_by is not null and received_at is not null and received_by is not null and rejected_at is null)
    or (status='rejected' and collected_at is not null and collected_by is not null and rejected_at is not null and rejected_by is not null and rejection_reason is not null)
    or status in ('cancelled','entered_in_error')
  )
);
create index lab_specimens_queue_idx on lab.specimens(facility_id,status,updated_at,id);
create index lab_specimens_accession_idx on lab.specimens(accession_id,collection_ordinal,id);

create table lab.specimen_command_idempotency (
  id uuid primary key default gen_random_uuid(), facility_id uuid not null references identity.facilities(id),
  patient_id uuid not null references identity.patients(id), actor_id uuid not null references auth.accounts(id),
  idempotency_key text not null check(idempotency_key~'^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  operation text not null check(operation in ('collect','receive','reject')), specimen_id uuid not null,
  request_sha256 char(64) not null check(request_sha256~'^[0-9a-f]{64}$'), result_version bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(specimen_id,patient_id,facility_id) references lab.specimens(id,patient_id,facility_id) on delete restrict,
  unique(facility_id,actor_id,idempotency_key)
);

create table lab.accession_events (
  id uuid primary key default gen_random_uuid(), accession_id uuid not null, work_item_id uuid not null,
  patient_id uuid not null, facility_id uuid not null, event_version bigint not null check(event_version=1),
  event_type text not null check(event_type='accession_created'), actor_id uuid not null,
  actor_membership_id uuid not null, reason text not null check(length(btrim(reason)) between 3 and 500),
  correlation_id text not null check(length(correlation_id) between 8 and 128),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key(accession_id,patient_id,facility_id) references lab.accessions(id,patient_id,facility_id) on delete restrict,
  foreign key(work_item_id) references lab.work_items(id) on delete restrict,
  foreign key(actor_membership_id,facility_id,actor_id)
    references identity.staff_facility_memberships(id,facility_id,account_id) on delete restrict,
  unique(accession_id,event_version)
);

create table lab.specimen_events (
  id uuid primary key default gen_random_uuid(), specimen_id uuid not null, accession_id uuid not null,
  patient_id uuid not null, facility_id uuid not null, event_version bigint not null check(event_version>0),
  event_type text not null check(event_type in ('specimen_required','specimen_collected','specimen_received','specimen_rejected')),
  actor_id uuid not null, actor_membership_id uuid not null,
  reason text not null check(length(btrim(reason)) between 3 and 500),
  correlation_id text not null check(length(correlation_id) between 8 and 128),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key(specimen_id,accession_id,patient_id,facility_id)
    references lab.specimens(id,accession_id,patient_id,facility_id) on delete restrict,
  foreign key(actor_membership_id,facility_id,actor_id)
    references identity.staff_facility_memberships(id,facility_id,account_id) on delete restrict,
  unique(specimen_id,event_version)
);

alter table lab.outbox_events drop constraint outbox_events_event_type_check;
alter table lab.outbox_events add constraint outbox_events_event_type_check check(event_type in
  ('LabImportedEvidenceCreated','LabImportedEvidenceAmended','LabWorkItemCreated',
   'LabAccessionCreated','LabSpecimenCollected','LabSpecimenReceived','LabSpecimenRejected'));

create or replace function lab.validate_accession_insert() returns trigger language plpgsql security definer
set search_path=lab,platform,pg_temp as $$ declare parent lab.work_items%rowtype; begin
  select * into parent from lab.work_items where id=new.work_item_id;
  if parent.id is null or parent.status<>'accepted' or parent.patient_id<>new.patient_id
    or parent.facility_id<>new.facility_id or parent.priority<>new.priority
    or new.facility_id<>platform.current_facility_id() or new.created_by<>platform.current_account_id()
    or new.created_by_membership_id<>platform.current_membership_id() then
    raise exception using errcode='23514',message='Accession does not match accepted Lab work and actor context';
  end if; return new;
end $$;
create trigger lab_accession_validate before insert on lab.accessions for each row execute function lab.validate_accession_insert();

create or replace function lab.validate_specimen_parent() returns trigger language plpgsql security definer
set search_path=lab,platform,pg_temp as $$ declare req lab.specimen_requirements%rowtype; begin
  select * into req from lab.specimen_requirements where id=new.requirement_id;
  if req.id is null or req.accession_id<>new.accession_id or req.patient_id<>new.patient_id
    or req.facility_id<>new.facility_id or req.specimen_type<>new.specimen_type
    or req.container_type is distinct from new.container_type or new.facility_id<>platform.current_facility_id() then
    raise exception using errcode='23514',message='Specimen does not match its requirement and facility context';
  end if; return new;
end $$;
create trigger lab_specimen_parent_validate before insert on lab.specimens for each row execute function lab.validate_specimen_parent();

create or replace function lab.validate_specimen_transition() returns trigger language plpgsql
set search_path=lab,platform,pg_temp as $$ begin
  if old.specimen_identifier<>new.specimen_identifier or old.requirement_id<>new.requirement_id
    or old.accession_id<>new.accession_id or old.patient_id<>new.patient_id or old.facility_id<>new.facility_id
    or old.specimen_type<>new.specimen_type or old.container_type is distinct from new.container_type
    or new.facility_id<>platform.current_facility_id() or new.row_version<>old.row_version+1
    or not ((old.status='required' and new.status='collected')
      or (old.status='collected' and new.status in ('received','rejected'))) then
    raise exception using errcode='23514',message='Illegal or stale specimen lifecycle transition';
  end if;
  new.updated_at=clock_timestamp(); return new;
end $$;
create trigger lab_specimen_transition before update on lab.specimens for each row execute function lab.validate_specimen_transition();

create or replace function lab.validate_accession_child() returns trigger language plpgsql security definer
set search_path=lab,platform,pg_temp as $$ declare accession lab.accessions%rowtype; begin
  select * into accession from lab.accessions where id=new.accession_id;
  if accession.id is null or accession.patient_id<>new.patient_id or accession.facility_id<>new.facility_id
    or new.facility_id<>platform.current_facility_id() then
    raise exception using errcode='23514',message='Lab lifecycle child does not match accession context';
  end if; return new;
end $$;
create trigger lab_requirement_validate before insert on lab.specimen_requirements for each row execute function lab.validate_accession_child();
create trigger lab_accession_event_validate before insert on lab.accession_events for each row execute function lab.validate_accession_child();
create trigger lab_specimen_event_validate before insert on lab.specimen_events for each row execute function lab.validate_accession_child();

create trigger lab_accessions_immutable before update or delete on lab.accessions for each row execute function lab.reject_immutable_evidence();
create trigger lab_requirements_immutable before update or delete on lab.specimen_requirements for each row execute function lab.reject_immutable_evidence();
create trigger lab_accession_events_immutable before update or delete on lab.accession_events for each row execute function lab.reject_immutable_evidence();
create trigger lab_specimen_events_immutable before update or delete on lab.specimen_events for each row execute function lab.reject_immutable_evidence();
create trigger lab_specimen_idempotency_immutable before update or delete on lab.specimen_command_idempotency for each row execute function lab.reject_immutable_evidence();
create trigger lab_specimens_no_delete before delete on lab.specimens for each row execute function lab.reject_immutable_evidence();

alter table lab.accessions enable row level security; alter table lab.accessions force row level security;
alter table lab.specimen_requirements enable row level security; alter table lab.specimen_requirements force row level security;
alter table lab.specimens enable row level security; alter table lab.specimens force row level security;
alter table lab.accession_events enable row level security; alter table lab.accession_events force row level security;
alter table lab.specimen_events enable row level security; alter table lab.specimen_events force row level security;
alter table lab.specimen_command_idempotency enable row level security; alter table lab.specimen_command_idempotency force row level security;
create policy lab_accessions_read on lab.accessions for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_accessions_insert on lab.accessions for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_requirements_read on lab.specimen_requirements for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_requirements_insert on lab.specimen_requirements for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_specimens_read on lab.specimens for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_specimens_insert on lab.specimens for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_specimens_update on lab.specimens for update using(lab.context_allows(patient_id,facility_id,'write_records')) with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_accession_events_read on lab.accession_events for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_accession_events_insert on lab.accession_events for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_specimen_events_read on lab.specimen_events for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_specimen_events_insert on lab.specimen_events for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_specimen_idempotency_read on lab.specimen_command_idempotency for select using(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_specimen_idempotency_insert on lab.specimen_command_idempotency for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));

revoke all on lab.accessions,lab.specimen_requirements,lab.specimens,lab.accession_events,lab.specimen_events,lab.specimen_command_idempotency from public;
revoke all on sequence lab.accession_number_seq,lab.specimen_identifier_seq from public;
comment on table lab.accessions is 'Lab-owned accession for one accepted work item; not specimen collection, execution, QC, or result.';
comment on table lab.specimen_requirements is 'Immutable accession specimen requirements; separate from physical collection.';
comment on table lab.specimens is 'Lab-owned physical specimen head with explicit, versioned custody transitions; receipt is not testing.';
comment on table lab.specimen_events is 'Append-only specimen lifecycle evidence reconstructing required, collected, received, or rejected states.';
