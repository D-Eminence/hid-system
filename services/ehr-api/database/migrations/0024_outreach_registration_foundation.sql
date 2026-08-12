-- Minimum Outreach-owned field-registration intake. This migration deliberately
-- does not create canonical patients, HIDs, clinical encounters, campaigns,
-- vaccinations, laboratory samples, or a second identity-resolution engine.

insert into auth.permissions (code, description) values
  ('outreach.registration.read', 'Read facility-scoped Outreach registration intake'),
  ('outreach.registration.write', 'Capture and reconcile facility-scoped Outreach registration intake')
on conflict (code) do update set description = excluded.description;

insert into auth.role_permissions (role_code, permission_code)
select mapping.role_code, mapping.permission_code
from (values
  ('doctor', 'outreach.registration.read'),
  ('doctor', 'outreach.registration.write'),
  ('clinician', 'outreach.registration.read'),
  ('clinician', 'outreach.registration.write'),
  ('nurse', 'outreach.registration.read'),
  ('nurse', 'outreach.registration.write'),
  ('receptionist', 'outreach.registration.read'),
  ('receptionist', 'outreach.registration.write'),
  ('admin', 'outreach.registration.read'),
  ('admin', 'outreach.registration.write'),
  ('org_admin', 'outreach.registration.read'),
  ('org_admin', 'outreach.registration.write')
) as mapping(role_code, permission_code)
on conflict do nothing;

create schema if not exists outreach;
revoke all on schema outreach from public;

create or replace function outreach.context_allows(
  resource_facility_id uuid,
  required_permission text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
  select
    resource_facility_id is not null
    and resource_facility_id = platform.current_facility_id()
    and nullif(platform.current_actor_subject(), '') is not null
    and platform.current_membership_id() is not null
    and platform.current_purpose_of_use() = 'direct-care'
    and auth.membership_has_permission(
      platform.current_actor_subject(),
      platform.current_membership_id(),
      resource_facility_id,
      required_permission
    )
$$;

revoke all on function outreach.context_allows(uuid, text) from public;

create table outreach.registration_cases (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  created_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null,
  local_command_id uuid not null,
  temporary_patient_id text not null,
  status text not null default 'identity_resolution_pending'
    check (status in ('identity_resolution_pending', 'identity_resolved')),
  full_name text not null check (length(btrim(full_name)) between 1 and 200),
  sex text not null check (sex in ('female', 'male', 'other', 'unknown')),
  age_years smallint not null check (age_years between 0 and 130),
  phone text check (phone is null or length(btrim(phone)) between 3 and 32),
  operational_notes text check (
    operational_notes is null or length(btrim(operational_notes)) between 3 and 2000
  ),
  resolved_patient_id uuid references identity.patients(id) on delete restrict,
  resolution_kind text check (resolution_kind is null or resolution_kind = 'linked_existing'),
  resolved_by_account_id uuid references auth.accounts(id) on delete restrict,
  resolved_by_membership_id uuid,
  resolution_reason text check (
    resolution_reason is null or length(btrim(resolution_reason)) between 8 and 1000
  ),
  resolved_at timestamptz,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (created_by_membership_id, facility_id, created_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  foreign key (resolved_by_membership_id, facility_id, resolved_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique (facility_id, created_by_account_id, local_command_id),
  unique (facility_id, temporary_patient_id),
  check (temporary_patient_id ~* '^tmp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  check (
    (status = 'identity_resolution_pending'
      and resolved_patient_id is null
      and resolution_kind is null
      and resolved_by_account_id is null
      and resolved_by_membership_id is null
      and resolution_reason is null
      and resolved_at is null)
    or
    (status = 'identity_resolved'
      and resolved_patient_id is not null
      and resolution_kind = 'linked_existing'
      and resolved_by_account_id is not null
      and resolved_by_membership_id is not null
      and resolution_reason is not null
      and resolved_at is not null)
  )
);

create index outreach_registration_cases_facility_status_idx
  on outreach.registration_cases (facility_id, status, created_at desc, id);
create index outreach_registration_cases_resolved_patient_idx
  on outreach.registration_cases (resolved_patient_id, created_at desc)
  where resolved_patient_id is not null;

create table outreach.patient_mappings (
  id uuid primary key default gen_random_uuid(),
  registration_case_id uuid not null unique references outreach.registration_cases(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  temporary_patient_id text not null,
  canonical_patient_id uuid not null references identity.patients(id) on delete restrict,
  resolution_kind text not null check (resolution_kind = 'linked_existing'),
  resolved_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  resolved_by_membership_id uuid not null,
  reason text not null check (length(btrim(reason)) between 8 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (resolved_by_membership_id, facility_id, resolved_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique (facility_id, temporary_patient_id)
);

create index outreach_patient_mappings_patient_idx
  on outreach.patient_mappings (canonical_patient_id, created_at desc);

create table outreach.registration_case_events (
  sequence_id bigint generated always as identity primary key,
  event_id uuid not null unique default gen_random_uuid(),
  registration_case_id uuid not null references outreach.registration_cases(id) on delete restrict,
  event_type text not null check (event_type in ('registration_case_received', 'existing_patient_linked')),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  temporary_patient_id text not null,
  canonical_patient_id uuid references identity.patients(id) on delete restrict,
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  actor_membership_id uuid not null,
  reason text,
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (actor_membership_id, facility_id, actor_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check (
    (event_type = 'registration_case_received' and canonical_patient_id is null)
    or (event_type = 'existing_patient_linked' and canonical_patient_id is not null
      and reason is not null and length(btrim(reason)) >= 8)
  )
);

create index outreach_registration_events_case_idx
  on outreach.registration_case_events (registration_case_id, sequence_id);

create table outreach.command_idempotency (
  id uuid primary key default gen_random_uuid(),
  requester_account_id uuid not null references auth.accounts(id) on delete restrict,
  requester_membership_id uuid not null,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  operation text not null check (operation in ('registration_case_create', 'registration_case_link_existing')),
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  request_sha256 char(64) not null,
  registration_case_id uuid not null references outreach.registration_cases(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (requester_membership_id, facility_id, requester_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique (requester_account_id, facility_id, operation, idempotency_key)
);

create table outreach.outbox_events (
  sequence_id bigint generated always as identity primary key,
  event_id uuid not null unique default gen_random_uuid(),
  event_type text not null check (event_type in ('OutreachRegistrationCaseCreated', 'OutreachPatientResolved')),
  aggregate_id uuid not null references outreach.registration_cases(id) on delete restrict,
  aggregate_version bigint not null check (aggregate_version > 0),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid references identity.patients(id) on delete restrict,
  correlation_id text not null check (
    length(correlation_id) between 8 and 128
    and correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8192),
  created_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error_code text,
  unique (event_type, aggregate_id, aggregate_version)
);

create index outreach_outbox_pending_idx
  on outreach.outbox_events (next_attempt_at, sequence_id) where published_at is null;

create or replace function outreach.validate_registration_case_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
begin
  if platform.current_purpose_of_use() <> 'direct-care'
     or new.facility_id <> platform.current_facility_id() then
    raise exception using errcode = '42501', message = 'Valid Outreach registration context is required';
  end if;

  if tg_op = 'INSERT' then
    if new.created_by_account_id <> platform.current_account_id()
       or new.created_by_membership_id <> platform.current_membership_id()
       or new.status <> 'identity_resolution_pending' or new.row_version <> 1 then
      raise exception using errcode = '42501', message = 'Outreach registration starts unresolved';
    end if;
    return new;
  end if;

  if old.status <> 'identity_resolution_pending'
     or new.status <> 'identity_resolved'
     or new.row_version <> old.row_version + 1
     or new.resolution_kind <> 'linked_existing'
     or new.resolved_by_account_id <> platform.current_account_id()
     or new.resolved_by_membership_id <> platform.current_membership_id()
     or new.id <> old.id
     or new.facility_id <> old.facility_id
     or new.created_by_account_id <> old.created_by_account_id
     or new.created_by_membership_id <> old.created_by_membership_id
     or new.local_command_id <> old.local_command_id
     or new.temporary_patient_id <> old.temporary_patient_id
     or new.full_name <> old.full_name
     or new.sex <> old.sex
     or new.age_years <> old.age_years
     or new.phone is distinct from old.phone
     or new.operational_notes is distinct from old.operational_notes
     or new.created_at <> old.created_at then
    raise exception using errcode = '55000', message = 'Outreach registration history cannot be overwritten';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$$;

create trigger outreach_registration_case_validate
  before insert or update on outreach.registration_cases
  for each row execute function outreach.validate_registration_case_write();

create or replace function outreach.validate_registration_case_event()
returns trigger
language plpgsql
set search_path = pg_catalog, platform, outreach
as $$
declare
  registration outreach.registration_cases%rowtype;
begin
  if new.actor_account_id <> platform.current_account_id()
     or new.actor_membership_id <> platform.current_membership_id() then
    raise exception using errcode = '42501', message = 'Outreach event actor must match request context';
  end if;
  select * into registration from outreach.registration_cases where id = new.registration_case_id;
  if not found
     or new.facility_id <> registration.facility_id
     or new.temporary_patient_id <> registration.temporary_patient_id
     or (new.event_type = 'existing_patient_linked'
       and (registration.status <> 'identity_resolved'
         or new.canonical_patient_id is distinct from registration.resolved_patient_id)) then
    raise exception using errcode = '23514', message = 'Outreach event must match its registration case';
  end if;
  return new;
end
$$;

create trigger outreach_registration_event_validate
  before insert on outreach.registration_case_events
  for each row execute function outreach.validate_registration_case_event();

create or replace function outreach.validate_outbox_event()
returns trigger
language plpgsql
set search_path = pg_catalog, outreach
as $$
declare
  registration outreach.registration_cases%rowtype;
begin
  select * into registration from outreach.registration_cases where id = new.aggregate_id;
  if not found or new.facility_id <> registration.facility_id
     or new.aggregate_version <> registration.row_version
     or (new.event_type = 'OutreachRegistrationCaseCreated'
       and (new.patient_id is not null or registration.row_version <> 1))
     or (new.event_type = 'OutreachPatientResolved'
       and (registration.status <> 'identity_resolved'
         or new.patient_id is distinct from registration.resolved_patient_id)) then
    raise exception using errcode = '23514', message = 'Outreach outbox event must match its registration case';
  end if;
  return new;
end
$$;

create trigger outreach_outbox_event_validate
  before insert on outreach.outbox_events
  for each row execute function outreach.validate_outbox_event();

create or replace function outreach.assert_registration_case_mapping_consistency()
returns trigger
language plpgsql
set search_path = pg_catalog, outreach
as $$
begin
  if not exists (
    select 1
    from outreach.registration_cases registration
    join outreach.patient_mappings mapping on mapping.registration_case_id = registration.id
    where registration.id = new.id
      and registration.status = 'identity_resolved'
      and registration.facility_id = mapping.facility_id
      and registration.temporary_patient_id = mapping.temporary_patient_id
      and registration.resolved_patient_id = mapping.canonical_patient_id
      and registration.resolution_kind = mapping.resolution_kind
  ) then
    raise exception using errcode = '23514', message = 'Resolved Outreach registration requires one exact patient mapping';
  end if;
  return null;
end
$$;

create or replace function outreach.assert_patient_mapping_case_consistency()
returns trigger
language plpgsql
set search_path = pg_catalog, outreach
as $$
begin
  if not exists (
    select 1
    from outreach.registration_cases registration
    where registration.id = new.registration_case_id
      and registration.status = 'identity_resolved'
      and registration.facility_id = new.facility_id
      and registration.temporary_patient_id = new.temporary_patient_id
      and registration.resolved_patient_id = new.canonical_patient_id
      and registration.resolution_kind = new.resolution_kind
  ) then
    raise exception using errcode = '23514', message = 'Outreach patient mapping requires one exact resolved registration';
  end if;
  return null;
end
$$;

create constraint trigger outreach_registration_mapping_from_case
  after insert or update on outreach.registration_cases
  deferrable initially deferred
  for each row when (new.status = 'identity_resolved')
  execute function outreach.assert_registration_case_mapping_consistency();

create constraint trigger outreach_registration_mapping_from_mapping
  after insert on outreach.patient_mappings
  deferrable initially deferred
  for each row execute function outreach.assert_patient_mapping_case_consistency();

create trigger outreach_patient_mappings_no_mutation
  before update or delete on outreach.patient_mappings
  for each row execute function platform.reject_mutation();
create trigger outreach_registration_events_no_mutation
  before update or delete on outreach.registration_case_events
  for each row execute function platform.reject_mutation();
create trigger outreach_command_idempotency_no_mutation
  before update or delete on outreach.command_idempotency
  for each row execute function platform.reject_mutation();
create trigger outreach_outbox_events_no_mutation
  before update or delete on outreach.outbox_events
  for each row execute function platform.reject_mutation();

alter table outreach.registration_cases enable row level security;
alter table outreach.registration_cases force row level security;
alter table outreach.patient_mappings enable row level security;
alter table outreach.patient_mappings force row level security;
alter table outreach.registration_case_events enable row level security;
alter table outreach.registration_case_events force row level security;
alter table outreach.command_idempotency enable row level security;
alter table outreach.command_idempotency force row level security;
alter table outreach.outbox_events enable row level security;
alter table outreach.outbox_events force row level security;

create policy outreach_registration_cases_read on outreach.registration_cases
  for select using (outreach.context_allows(facility_id, 'outreach.registration.read'));
create policy outreach_registration_cases_create on outreach.registration_cases
  for insert with check (outreach.context_allows(facility_id, 'outreach.registration.write'));
create policy outreach_registration_cases_resolve on outreach.registration_cases
  for update using (outreach.context_allows(facility_id, 'outreach.registration.write'))
  with check (outreach.context_allows(facility_id, 'outreach.registration.write'));

create policy outreach_patient_mappings_read on outreach.patient_mappings
  for select using (outreach.context_allows(facility_id, 'outreach.registration.read'));
create policy outreach_patient_mappings_create on outreach.patient_mappings
  for insert with check (
    resolved_by_account_id = platform.current_account_id()
    and resolved_by_membership_id = platform.current_membership_id()
    and outreach.context_allows(facility_id, 'outreach.registration.write')
  );

create policy outreach_registration_events_read on outreach.registration_case_events
  for select using (outreach.context_allows(facility_id, 'outreach.registration.read'));
create policy outreach_registration_events_create on outreach.registration_case_events
  for insert with check (
    actor_account_id = platform.current_account_id()
    and actor_membership_id = platform.current_membership_id()
    and outreach.context_allows(facility_id, 'outreach.registration.write')
  );

create policy outreach_command_idempotency_read on outreach.command_idempotency
  for select using (
    requester_account_id = platform.current_account_id()
    and outreach.context_allows(facility_id, 'outreach.registration.read')
  );
create policy outreach_command_idempotency_create on outreach.command_idempotency
  for insert with check (
    requester_account_id = platform.current_account_id()
    and requester_membership_id = platform.current_membership_id()
    and outreach.context_allows(facility_id, 'outreach.registration.write')
  );

create policy outreach_outbox_read on outreach.outbox_events
  for select using (outreach.context_allows(facility_id, 'outreach.registration.read'));
create policy outreach_outbox_create on outreach.outbox_events
  for insert with check (outreach.context_allows(facility_id, 'outreach.registration.write'));

revoke all on function outreach.validate_registration_case_write() from public;
revoke all on function outreach.validate_registration_case_event() from public;
revoke all on function outreach.validate_outbox_event() from public;
revoke all on function outreach.assert_registration_case_mapping_consistency() from public;
revoke all on function outreach.assert_patient_mapping_case_consistency() from public;
alter default privileges in schema outreach revoke all on tables from public;
alter default privileges in schema outreach revoke all on sequences from public;
alter default privileges in schema outreach revoke all on functions from public;

comment on schema outreach is
  'Field-operational records only. Identity remains the sole canonical patient and HID authority.';
comment on table outreach.registration_cases is
  'Temporary field registration intake. Unresolved does not mean registered in Identity.';
comment on table outreach.patient_mappings is
  'Append-only temporary-to-canonical mapping after governed Identity authorization.';
comment on column outreach.registration_cases.temporary_patient_id is
  'Locally generated tmp_<UUID> reference; never a canonical Identity UUID or HID.';
