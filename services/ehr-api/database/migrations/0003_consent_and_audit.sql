-- Consent, access grants, and centralized semantic audit.

create table identity.purpose_of_use_codes (
  code text primary key,
  display text not null,
  active boolean not null default true,
  source_system text not null,
  created_at timestamptz not null default clock_timestamp()
);

create table identity.consent_directives (
  id uuid primary key,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  current_version integer not null default 1 check (current_version > 0),
  row_version bigint not null default 1 check (row_version > 0),
  source_system text not null default 'hid',
  source_record_id text,
  created_by uuid references auth.accounts(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique (id, patient_id)
);

create table identity.consent_directive_versions (
  id uuid primary key,
  directive_id uuid not null,
  patient_id uuid not null,
  version_no integer not null check (version_no > 0),
  status text not null check (status in ('draft', 'active', 'inactive', 'entered_in_error')),
  provision_type text not null check (provision_type in ('permit', 'deny')),
  grantee_type text not null check (grantee_type in ('staff', 'facility', 'organization', 'patient_delegate', 'all')),
  grantee_id uuid,
  facility_id uuid references identity.facilities(id) on delete restrict,
  purposes text[] not null default '{}',
  actions text[] not null default '{}',
  data_classes text[] not null default '{}',
  starts_at timestamptz not null,
  expires_at timestamptz,
  legal_basis text,
  source_reference text not null,
  reason text not null,
  content_sha256 char(64) not null,
  supersedes_version integer,
  created_by uuid references auth.accounts(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (directive_id, patient_id) references identity.consent_directives(id, patient_id) on delete restrict,
  unique (directive_id, version_no),
  check (expires_at is null or expires_at > starts_at),
  check ((grantee_type = 'all' and grantee_id is null) or (grantee_type <> 'all' and grantee_id is not null)),
  check (supersedes_version is null or supersedes_version < version_no)
);

alter table identity.consent_directives
  add constraint consent_directives_current_version_fk
  foreign key (id, current_version)
  references identity.consent_directive_versions(directive_id, version_no)
  on delete restrict
  deferrable initially deferred;

create index consent_directive_versions_patient_active_idx
  on identity.consent_directive_versions (patient_id, starts_at, expires_at)
  where status = 'active';

create trigger consent_directive_versions_no_mutation
  before update or delete on identity.consent_directive_versions
  for each row execute function platform.reject_mutation();

create table identity.access_requests (
  id uuid primary key,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  staff_id uuid not null references identity.staff(id) on delete restrict,
  membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  facility_id uuid references identity.facilities(id) on delete restrict,
  scope text not null check (scope in ('read_records', 'write_records', 'break_glass')),
  reason text not null check (length(btrim(reason)) >= 3),
  status text not null check (status in ('pending', 'approved', 'denied', 'revoked', 'expired')),
  requested_duration_minutes integer not null check (requested_duration_minutes between 5 and 1440),
  break_glass boolean not null default false,
  approved_by_patient_id uuid references identity.patients(id) on delete restrict,
  approved_at timestamptz,
  denied_at timestamptz,
  denied_reason text,
  correlation_id text,
  migration_hold_reason text,
  source_system text not null default 'hid',
  source_record_id text,
  source_created_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  check (correlation_id is null or length(correlation_id) between 8 and 128),
  check (facility_id is not null or migration_hold_reason is not null),
  check ((status = 'approved') = (approved_at is not null) or source_system <> 'hid')
);

create index access_requests_patient_status_idx
  on identity.access_requests (patient_id, status, created_at desc);
create index access_requests_membership_status_idx
  on identity.access_requests (membership_id, facility_id, status, created_at desc);

create table identity.consent_grants (
  id uuid primary key,
  request_id uuid references identity.access_requests(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  staff_id uuid not null,
  account_id uuid not null,
  membership_id uuid not null,
  facility_id uuid,
  scope text not null check (scope in ('read_records', 'write_records', 'break_glass')),
  status text not null check (status in ('active', 'revoked', 'expired')),
  granted_by_patient_id uuid references identity.patients(id) on delete restrict,
  reason text not null check (length(btrim(reason)) >= 3),
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references auth.accounts(id) on delete restrict,
  revoked_reason text,
  break_glass boolean not null default false,
  correlation_id text,
  migration_hold_reason text,
  source_system text not null default 'hid',
  source_record_id text,
  source_created_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (staff_id, account_id) references identity.staff(id, account_id) on delete restrict,
  foreign key (membership_id, facility_id, account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check (expires_at > starts_at),
  check (correlation_id is null or length(correlation_id) between 8 and 128),
  check (facility_id is not null or migration_hold_reason is not null),
  check ((status = 'revoked') = (revoked_at is not null) or source_system <> 'hid'),
  check ((scope = 'break_glass') = break_glass or source_system <> 'hid')
);

create index consent_grants_authorization_idx
  on identity.consent_grants (patient_id, membership_id, facility_id, status, expires_at desc);
create index consent_grants_actor_idx
  on identity.consent_grants (account_id, facility_id, status, expires_at desc);

create or replace function identity.has_active_consent_grant(
  request_patient_id uuid,
  request_subject text,
  request_membership_id uuid,
  request_facility_id uuid,
  request_action text,
  request_purpose text,
  at_time timestamptz default current_timestamp
)
returns boolean
language sql
stable
security definer
set search_path = identity, auth, pg_temp
as $$
  select
    request_purpose is not null
    and length(btrim(request_purpose)) > 0
    and exists (
      select 1
      from identity.purpose_of_use_codes purpose
      where purpose.code = request_purpose and purpose.active
    )
    and identity.has_active_membership(request_subject, request_membership_id, request_facility_id)
    and exists (
      select 1
      from identity.consent_grants grant_row
      join auth.accounts account_row on account_row.id = grant_row.account_id
      where grant_row.patient_id = request_patient_id
        and grant_row.membership_id = request_membership_id
        and grant_row.facility_id = request_facility_id
        and account_row.subject = request_subject
        and account_row.status = 'active'
        and grant_row.status = 'active'
        and grant_row.migration_hold_reason is null
        and grant_row.starts_at <= at_time
        and grant_row.expires_at > at_time
        and (
          grant_row.scope = 'break_glass'
          or grant_row.scope = request_action
          or (request_action = 'read_records' and grant_row.scope = 'write_records')
        )
    )
    and not exists (
      select 1
      from identity.consent_directives directive
      join identity.consent_directive_versions directive_version
        on directive_version.directive_id = directive.id
       and directive_version.version_no = directive.current_version
      join identity.staff_facility_memberships membership
        on membership.id = request_membership_id
       and membership.facility_id = request_facility_id
      where directive.patient_id = request_patient_id
        and directive_version.status = 'active'
        and directive_version.provision_type = 'deny'
        and directive_version.starts_at <= at_time
        and (directive_version.expires_at is null or directive_version.expires_at > at_time)
        and (directive_version.facility_id is null or directive_version.facility_id = request_facility_id)
        and (cardinality(directive_version.actions) = 0 or request_action = any(directive_version.actions))
        and (cardinality(directive_version.purposes) = 0 or request_purpose = any(directive_version.purposes))
        and (
          directive_version.grantee_type = 'all'
          or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = request_facility_id)
          or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = membership.organization_id)
          or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = membership.staff_id)
        )
    )
$$;

create table audit.events (
  sequence_id bigint generated always as identity primary key,
  event_id uuid not null unique default gen_random_uuid(),
  occurred_at timestamptz not null default clock_timestamp(),
  recorded_at timestamptz not null default clock_timestamp(),
  correlation_id text not null check (
    length(correlation_id) between 8 and 128
    and correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  actor_type text not null check (actor_type in ('staff', 'patient', 'workload', 'system', 'legacy')),
  actor_subject text,
  actor_account_id uuid references auth.accounts(id) on delete restrict,
  actor_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  organization_id uuid references identity.organizations(id) on delete restrict,
  facility_id uuid references identity.facilities(id) on delete restrict,
  patient_id uuid references identity.patients(id) on delete restrict,
  action text not null check (length(btrim(action)) between 3 and 160),
  outcome text not null check (outcome in ('success', 'denied', 'failure')),
  resource_type text,
  resource_id text,
  resource_uuid uuid generated always as (
    case
      when resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then resource_id::uuid
      else null
    end
  ) stored,
  purpose_of_use text,
  reason text,
  source_ip inet,
  user_agent text check (user_agent is null or length(user_agent) <= 512),
  provenance text not null check (provenance in ('application', 'legacy_identity', 'migration', 'system')),
  source_system text,
  source_event_id text,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  foreign key (actor_account_id, actor_subject) references auth.accounts(id, subject) on delete restrict,
  foreign key (actor_membership_id, facility_id, actor_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check (
    facility_id is not null
    or actor_type in ('patient', 'workload', 'system', 'legacy')
    or (
      actor_type = 'staff'
      and action like 'auth.%'
      and resource_type in ('authentication', 'session')
    )
  ),
  check (actor_type <> 'legacy' or (provenance = 'legacy_identity' and source_system is not null and source_event_id is not null)),
  check (actor_type <> 'system' or actor_subject is null),
  check (actor_type <> 'staff' or actor_subject is not null),
  check (
    actor_type <> 'staff'
    or action like 'auth.%'
    or (actor_account_id is not null and actor_membership_id is not null and facility_id is not null)
  ),
  check (octet_length(details::text) <= 65536),
  check (recorded_at >= occurred_at or provenance in ('legacy_identity', 'migration'))
);

create index audit_patient_time_idx on audit.events (patient_id, occurred_at desc) where patient_id is not null;
create index audit_facility_time_idx on audit.events (facility_id, occurred_at desc) where facility_id is not null;
create index audit_actor_time_idx on audit.events (actor_subject, occurred_at desc) where actor_subject is not null;
create index audit_correlation_idx on audit.events (correlation_id);
create index audit_resource_uuid_idx on audit.events (resource_type, resource_uuid) where resource_uuid is not null;
create index audit_resource_text_idx on audit.events (resource_type, resource_id) where resource_id is not null;
create index audit_recorded_brin_idx on audit.events using brin (recorded_at);

create trigger audit_events_no_mutation
  before update or delete on audit.events
  for each row execute function platform.reject_mutation();

comment on table audit.events is
  'Append-only semantic audit. Staff clinical/identity actions require a facility; facility-less staff rows are limited to auth lifecycle actions.';
comment on column audit.events.resource_id is
  'Opaque resource identifier; supports UUID and non-UUID identifiers without unsafe casts.';
