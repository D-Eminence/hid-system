-- Governed NIN verification and duplicate-safe registration cases.
-- Raw NIN values never appear in this migration, indexes, audit details, or
-- public response models. Existing patient UUIDs and prior migrations remain
-- untouched.

insert into auth.permissions (code, description) values
  ('identity.registration.write', 'Verify identifiers and create governed patient registration cases'),
  ('identity.registration.approve', 'Approve a new canonical identity or link a reviewed duplicate candidate');

insert into auth.role_permissions (role_code, permission_code)
select mapping.role_code, mapping.permission_code
from (values
  ('doctor', 'identity.registration.write'),
  ('clinician', 'identity.registration.write'),
  ('nurse', 'identity.registration.write'),
  ('receptionist', 'identity.registration.write'),
  ('admin', 'identity.registration.write'),
  ('org_admin', 'identity.registration.write'),
  ('admin', 'identity.registration.approve'),
  ('org_admin', 'identity.registration.approve')
) as mapping(role_code, permission_code);

do $$
declare
  identifier_constraint text;
begin
  select constraint_row.conname
    into identifier_constraint
    from pg_constraint constraint_row
   where constraint_row.conrelid = 'identity.patient_identifiers'::regclass
     and constraint_row.contype = 'c'
     and pg_get_constraintdef(constraint_row.oid) like '%identifier_type%'
     and pg_get_constraintdef(constraint_row.oid) like '%external%'
   limit 1;
  if identifier_constraint is null then
    raise exception 'patient identifier type constraint was not found';
  end if;
  execute format('alter table identity.patient_identifiers drop constraint %I', identifier_constraint);
end
$$;

alter table identity.patient_identifiers
  add constraint patient_identifiers_identifier_type_check
    check (identifier_type in ('hid_code', 'phone', 'email', 'legacy_mrn', 'external', 'nin')),
  add column registration_case_id uuid,
  add column verified_at timestamptz,
  add column verification_provider text,
  add column verification_reference text,
  add column revoked_at timestamptz,
  add column revocation_reason text,
  add constraint patient_identifiers_nin_verification_ck check (
    identifier_type <> 'nin'
    or (
      verified
      and verified_at is not null
      and verification_provider is not null
      and length(verification_provider) between 1 and 100
      and verification_reference is not null
      and length(verification_reference) between 1 and 255
      and registration_case_id is not null
    )
  ),
  add constraint patient_identifiers_registration_case_ck check (
    (identifier_type = 'nin') = (registration_case_id is not null)
  ),
  add constraint patient_identifiers_revocation_ck check (
    (revoked_at is null) = (revocation_reason is null)
  );

comment on column identity.patients.nin_hash is
  'Deprecated legacy field. New NIN bindings use identity.patient_identifiers with keyed lookup HMAC and governed verification evidence.';
comment on column identity.patients.nin_ciphertext is
  'Deprecated legacy field. New encrypted NIN values are stored only in governed identifier and registration-case records.';

create table identity.registration_cases (
  id uuid primary key,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  created_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null,
  status text not null check (status in (
    'pending_new_identity_approval',
    'review_required',
    'resolved_existing_identity',
    'linked_existing',
    'approved_new_identity',
    'rejected',
    'cancelled'
  )),
  first_name text not null check (length(btrim(first_name)) between 1 and 100),
  last_name text not null check (length(btrim(last_name)) between 1 and 100),
  full_name text not null check (length(btrim(full_name)) between 1 and 201),
  dob date not null check (dob >= date '1900-01-01'),
  gender text check (gender in ('female', 'male', 'intersex', 'other', 'unknown')),
  nin_ciphertext bytea not null check (octet_length(nin_ciphertext) >= 30),
  nin_lookup_hmac char(64) not null check (nin_lookup_hmac ~ '^[0-9a-f]{64}$'),
  nin_last4 char(4) not null check (nin_last4 ~ '^[0-9]{4}$'),
  nin_key_version text not null check (length(nin_key_version) between 1 and 64),
  verification_provider text not null check (length(verification_provider) between 1 and 100),
  verification_reference text not null check (length(verification_reference) between 1 and 255),
  verified_at timestamptz not null,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  resolved_patient_id uuid references identity.patients(id) on delete restrict,
  review_idempotency_key text,
  review_request_sha256 char(64),
  reviewed_by_account_id uuid references auth.accounts(id) on delete restrict,
  reviewed_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  review_reason text check (review_reason is null or length(btrim(review_reason)) between 8 and 500),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (created_by_membership_id, facility_id, created_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  foreign key (reviewed_by_membership_id, facility_id, reviewed_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique (facility_id, created_by_account_id, idempotency_key),
  check ((review_idempotency_key is null) = (review_request_sha256 is null)),
  check (review_idempotency_key is null or review_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  check (review_request_sha256 is null or review_request_sha256 ~ '^[0-9a-f]{64}$'),
  check (
    (status in ('resolved_existing_identity', 'linked_existing', 'approved_new_identity')) = (resolved_patient_id is not null)
  ),
  check (
    (reviewed_by_account_id is null and reviewed_by_membership_id is null and review_reason is null)
    or
    (reviewed_by_account_id is not null and reviewed_by_membership_id is not null and review_reason is not null)
  ),
  check (
    (reviewed_by_account_id is not null) = (review_idempotency_key is not null)
  ),
  check (
    (status in ('linked_existing', 'approved_new_identity', 'rejected', 'cancelled')) =
    (reviewed_by_account_id is not null)
  )
);

alter table identity.patient_identifiers
  add constraint patient_identifiers_registration_case_fk
    foreign key (registration_case_id)
    references identity.registration_cases(id)
    on delete restrict;

create index patient_identifiers_registration_case_idx
  on identity.patient_identifiers (registration_case_id)
  where registration_case_id is not null;

create unique index registration_cases_active_nin_uq
  on identity.registration_cases (nin_lookup_hmac)
  where status in ('pending_new_identity_approval', 'review_required');
create index registration_cases_facility_status_idx
  on identity.registration_cases (facility_id, status, created_at desc);

create table identity.registration_case_candidates (
  case_id uuid not null references identity.registration_cases(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  match_score smallint not null check (match_score between 65 and 100),
  match_reasons jsonb not null check (jsonb_typeof(match_reasons) = 'array'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (case_id, patient_id)
);

create trigger registration_case_candidates_no_mutation
  before update or delete on identity.registration_case_candidates
  for each row execute function platform.reject_mutation();

create table identity.registration_case_events (
  id bigint generated always as identity primary key,
  event_id uuid not null unique default gen_random_uuid(),
  case_id uuid not null references identity.registration_cases(id) on delete restrict,
  event_type text not null check (event_type in (
    'verified_existing',
    'review_required',
    'pending_new_identity_approval',
    'approved_new_identity',
    'linked_existing',
    'rejected',
    'cancelled'
  )),
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  actor_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid references identity.patients(id) on delete restrict,
  reason text check (reason is null or length(btrim(reason)) between 8 and 500),
  details jsonb not null default '{}'::jsonb check (
    jsonb_typeof(details) = 'object' and octet_length(details::text) <= 16384
  ),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (actor_membership_id, facility_id, actor_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict
);

create trigger registration_case_events_no_mutation
  before update or delete on identity.registration_case_events
  for each row execute function platform.reject_mutation();

create or replace function identity.validate_registration_case_write()
returns trigger
language plpgsql
security definer
set search_path = identity, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
begin
  if actor_account is null
     or actor_membership is null
     or actor_facility is null
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Verified registration context is required';
  end if;

  if tg_op = 'INSERT' then
    if new.created_by_account_id <> actor_account
       or new.created_by_membership_id <> actor_membership
       or new.facility_id <> actor_facility
       or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'identity.registration.write') then
      raise exception using errcode = '42501', message = 'Registration case attribution is invalid';
    end if;
    return new;
  end if;

  if new.facility_id is distinct from old.facility_id
     or new.created_by_account_id is distinct from old.created_by_account_id
     or new.created_by_membership_id is distinct from old.created_by_membership_id
     or new.first_name is distinct from old.first_name
     or new.last_name is distinct from old.last_name
     or new.full_name is distinct from old.full_name
     or new.dob is distinct from old.dob
     or new.gender is distinct from old.gender
     or new.nin_lookup_hmac is distinct from old.nin_lookup_hmac
     or new.nin_ciphertext is distinct from old.nin_ciphertext
     or new.nin_last4 is distinct from old.nin_last4
     or new.nin_key_version is distinct from old.nin_key_version
     or new.verification_provider is distinct from old.verification_provider
     or new.verification_reference is distinct from old.verification_reference
     or new.verified_at is distinct from old.verified_at
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_sha256 is distinct from old.request_sha256
     or (old.review_idempotency_key is not null and new.review_idempotency_key is distinct from old.review_idempotency_key)
     or (old.review_request_sha256 is not null and new.review_request_sha256 is distinct from old.review_request_sha256)
     or new.row_version <> old.row_version + 1
     or new.reviewed_by_account_id is distinct from actor_account
     or new.reviewed_by_membership_id is distinct from actor_membership
     or not (
       (old.status = 'pending_new_identity_approval' and new.status in ('approved_new_identity', 'rejected', 'cancelled'))
       or (old.status = 'review_required' and new.status in ('linked_existing', 'rejected', 'cancelled'))
     )
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'identity.registration.approve') then
    raise exception using errcode = '42501', message = 'Registration review transition is invalid';
  end if;
  return new;
end;
$$;

create trigger registration_cases_validate_write
  before insert or update on identity.registration_cases
  for each row execute function identity.validate_registration_case_write();

alter table identity.registration_cases enable row level security;
alter table identity.registration_cases force row level security;
alter table identity.registration_case_candidates enable row level security;
alter table identity.registration_case_candidates force row level security;
alter table identity.registration_case_events enable row level security;
alter table identity.registration_case_events force row level security;

create policy patients_registration_read on identity.patients
  for select using (
    auth.membership_has_permission(
      platform.current_actor_subject(), platform.current_membership_id(),
      platform.current_facility_id(), 'identity.registration.write'
    )
    or auth.membership_has_permission(
      platform.current_actor_subject(), platform.current_membership_id(),
      platform.current_facility_id(), 'identity.registration.approve'
    )
  );

create policy patients_registration_insert on identity.patients
  for insert with check (
    source_system = 'hid-nin-registration'
    and account_id is null
    and phone_e164_ciphertext is null
    and phone_lookup_hmac is null
    and email_ciphertext is null
    and email_lookup_hmac is null
    and nin_last4 is null
    and nin_hash is null
    and nin_ciphertext is null
    and
    auth.membership_has_permission(
      platform.current_actor_subject(), platform.current_membership_id(),
      platform.current_facility_id(), 'identity.registration.approve'
    )
    and exists (
      select 1
      from identity.registration_cases registration
      where registration.facility_id = platform.current_facility_id()
        and registration.status = 'pending_new_identity_approval'
        and registration.resolved_patient_id is null
        and registration.first_name = patients.first_name
        and registration.last_name = patients.last_name
        and registration.full_name = patients.full_name
        and registration.dob = patients.dob
        and coalesce(registration.gender, 'unknown') = coalesce(patients.gender, 'unknown')
        and not exists (
          select 1
          from identity.registration_case_candidates candidate
          where candidate.case_id = registration.id
        )
    )
  );

create policy patient_identifiers_registration_insert on identity.patient_identifiers
  for insert with check (
    identifier_type = 'nin'
    and verified
    and registration_case_id is not null
    and exists (
      select 1
      from identity.registration_cases registration
      join identity.patients patient_row on patient_row.id = patient_identifiers.patient_id
      where registration.id = patient_identifiers.registration_case_id
        and registration.facility_id = platform.current_facility_id()
        and (
          (
            registration.status = 'pending_new_identity_approval'
            and registration.resolved_patient_id is null
            and patient_row.source_system = 'hid-nin-registration'
            and patient_row.first_name = registration.first_name
            and patient_row.last_name = registration.last_name
            and patient_row.full_name = registration.full_name
            and patient_row.dob = registration.dob
            and coalesce(patient_row.gender, 'unknown') = coalesce(registration.gender, 'unknown')
          )
          or (
            registration.status = 'review_required'
            and exists (
              select 1
              from identity.registration_case_candidates candidate
              where candidate.case_id = registration.id
                and candidate.patient_id = patient_identifiers.patient_id
            )
          )
        )
    )
    and auth.membership_has_permission(
      platform.current_actor_subject(), platform.current_membership_id(),
      platform.current_facility_id(), 'identity.registration.approve'
    )
  );

create policy registration_cases_staff_access on identity.registration_cases
  for select using (
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

create policy registration_cases_staff_create on identity.registration_cases
  for insert with check (
    facility_id = platform.current_facility_id()
    and auth.membership_has_permission(
      platform.current_actor_subject(), platform.current_membership_id(), facility_id,
      'identity.registration.write'
    )
  );

create policy registration_cases_staff_review on identity.registration_cases
  for update using (
    facility_id = platform.current_facility_id()
    and auth.membership_has_permission(
      platform.current_actor_subject(), platform.current_membership_id(), facility_id,
      'identity.registration.approve'
    )
  ) with check (
    facility_id = platform.current_facility_id()
    and auth.membership_has_permission(
      platform.current_actor_subject(), platform.current_membership_id(), facility_id,
      'identity.registration.approve'
    )
  );

create policy registration_candidates_staff_access on identity.registration_case_candidates
  for select using (
    exists (
      select 1 from identity.registration_cases registration
      where registration.id = registration_case_candidates.case_id
    )
  );

create policy registration_candidates_staff_create on identity.registration_case_candidates
  for insert with check (
    exists (
      select 1 from identity.registration_cases registration
      where registration.id = registration_case_candidates.case_id
        and registration.facility_id = platform.current_facility_id()
        and registration.created_by_account_id = auth.account_id_for_subject(platform.current_actor_subject())
    )
  );

create policy registration_events_staff_access on identity.registration_case_events
  for select using (
    facility_id = platform.current_facility_id()
    and exists (
      select 1 from identity.registration_cases registration
      where registration.id = registration_case_events.case_id
    )
  );

create policy registration_events_staff_create on identity.registration_case_events
  for insert with check (
    facility_id = platform.current_facility_id()
    and actor_account_id = auth.account_id_for_subject(platform.current_actor_subject())
    and actor_membership_id = platform.current_membership_id()
    and exists (
      select 1 from identity.registration_cases registration
      where registration.id = registration_case_events.case_id
        and registration.facility_id = registration_case_events.facility_id
    )
  );

comment on table identity.registration_cases is
  'Governed NIN-backed registration workflow. Unmatched verification creates a case, never a patient.';
comment on table identity.registration_case_candidates is
  'Deterministic and fuzzy duplicate candidates requiring explicit human review before NIN linking.';
comment on table identity.registration_case_events is
  'Append-only identity registration history; audit events remain a separate semantic access trail.';
