-- Minimum-necessary Identity events for the governed registration workflow.
-- The canonical patient UUID/HID and registration semantics remain unchanged.

create table identity.outbox_events (
  sequence_id bigint generated always as identity primary key,
  event_id uuid not null unique default gen_random_uuid(),
  event_type text not null check (event_type in (
    'PatientRegistered',
    'PatientIdentifierAdded',
    'PatientIdentityResolved'
  )),
  aggregate_id uuid not null references identity.registration_cases(id) on delete restrict,
  aggregate_version bigint not null check (aggregate_version > 0),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  correlation_id text not null check (
    length(correlation_id) between 8 and 128
    and correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 8192
    and not (payload ?| array['nin', 'rawNin', 'identifierValue', 'hid'])
  ),
  created_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error_code text,
  unique (event_type, aggregate_id, aggregate_version)
);

create index identity_outbox_pending_idx
  on identity.outbox_events (next_attempt_at, sequence_id)
  where published_at is null;

alter table identity.outbox_events enable row level security;
alter table identity.outbox_events force row level security;

create policy identity_outbox_staff_read on identity.outbox_events for select
  using (
    facility_id = platform.current_facility_id()
    and (
      auth.membership_has_permission(
        platform.current_actor_subject(), platform.current_membership_id(), facility_id,
        'identity.registration.write'
      )
      or auth.membership_has_permission(
        platform.current_actor_subject(), platform.current_membership_id(), facility_id,
        'identity.registration.approve'
      )
    )
  );

create policy identity_outbox_staff_insert on identity.outbox_events for insert
  with check (
    facility_id = platform.current_facility_id()
    and exists (
      select 1
      from identity.registration_cases registration
      where registration.id = identity.outbox_events.aggregate_id
        and registration.facility_id = identity.outbox_events.facility_id
        and registration.resolved_patient_id = identity.outbox_events.patient_id
    )
    and (
      auth.membership_has_permission(
        platform.current_actor_subject(), platform.current_membership_id(), facility_id,
        'identity.registration.write'
      )
      or auth.membership_has_permission(
        platform.current_actor_subject(), platform.current_membership_id(), facility_id,
        'identity.registration.approve'
      )
    )
  );

revoke all on identity.outbox_events from public;
revoke all on all sequences in schema identity from public;

comment on table identity.outbox_events is
  'Minimum-necessary transactional canonical Identity events; raw identifiers and HID values are forbidden from payloads.';
