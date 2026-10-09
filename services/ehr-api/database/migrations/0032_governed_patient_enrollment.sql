-- Enroll a portal account only after governed Identity registration resolves a
-- canonical patient. Contact ownership and a password are established by OTP.
-- Runtime roles retain no direct account INSERT or patient UPDATE privilege.
create table identity.patient_enrollments (
  case_id uuid primary key references identity.registration_cases(id) on delete restrict,
  patient_id uuid not null unique references identity.patients(id) on delete restrict,
  account_id uuid not null unique references auth.accounts(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  actor_membership_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  request_sha256 char(64) not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  reason text not null check (length(btrim(reason)) between 8 and 500),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (actor_membership_id, facility_id, actor_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique (actor_account_id, idempotency_key)
);
create trigger patient_enrollments_immutable before update or delete on identity.patient_enrollments
  for each row execute function platform.reject_mutation();
alter table identity.patient_enrollments enable row level security;
alter table identity.patient_enrollments force row level security;
create policy patient_enrollments_governed on identity.patient_enrollments
  for all using (facility_id = platform.current_facility_id()
    and auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
      facility_id, 'identity.registration.approve'))
  with check (facility_id = platform.current_facility_id()
    and actor_account_id = auth.account_id_for_subject(platform.current_actor_subject())
    and actor_membership_id = platform.current_membership_id()
    and auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
      facility_id, 'identity.registration.approve'));
-- Only the definer command has UPDATE privileges. RLS additionally binds the
-- resulting mapping to the immutable enrollment evidence in this transaction.
create policy patients_governed_enrollment_update on identity.patients for update
  using (account_id is null and status = 'active'
    and auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
      platform.current_facility_id(), 'identity.registration.approve'))
  with check (status = 'active' and exists (select 1 from identity.patient_enrollments enrollment
    where enrollment.patient_id = patients.id and enrollment.account_id = patients.account_id
      and enrollment.facility_id = platform.current_facility_id()));

create function identity.enroll_registered_patient(
  requested_case_id uuid, expected_version bigint, requested_email text,
  requested_reason text, requested_key text, requested_digest char(64)
) returns table (patient_id uuid, hid text, account_id uuid, replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  registration identity.registration_cases%rowtype;
  patient identity.patients%rowtype;
  prior identity.patient_enrollments%rowtype;
  verified_identifier uuid;
  new_account uuid;
begin
  if actor_account is null or platform.current_correlation_id() is null
    or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
    or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'identity.registration.approve') then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if requested_email is null or length(requested_email) > 254
    or requested_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500
    or requested_key is null or length(requested_key) not between 8 and 200
    or requested_digest is null or requested_digest !~ '^[a-f0-9]{64}$'
    or expected_version is null or expected_version < 1 then
    raise exception using errcode = '22023', message = 'PATIENT_ENROLLMENT_INVALID';
  end if;
  -- Serializes same-case retries, including a concurrent first enrollment.
  select * into registration from identity.registration_cases
    where id = requested_case_id and facility_id = actor_facility for update;
  if not found then raise exception using errcode = 'P0002', message = 'REGISTRATION_CASE_NOT_FOUND'; end if;
  select * into prior from identity.patient_enrollments where case_id = requested_case_id;
  if found then
    if prior.actor_account_id <> actor_account or prior.idempotency_key <> requested_key
      or prior.request_sha256 <> requested_digest then
      raise exception using errcode = '23505', message = 'PATIENT_ENROLLMENT_CONFLICT';
    end if;
    select * into patient from identity.patients where id = prior.patient_id;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id,
      actor_membership_id, facility_id, patient_id, action, resource_type, resource_id,
      outcome, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'staff', actor_subject, actor_account,
      actor_membership, actor_facility, patient.id, 'identity.patient.enroll.replay',
      'registration-case', requested_case_id::text, 'success', 'healthcare-operations', 'application', 'identity-api', '{}');
    return query select patient.id, patient.hid_code, prior.account_id, true;
    return;
  end if;
  if registration.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'REGISTRATION_VERSION_CONFLICT';
  end if;
  if registration.status not in ('approved_new_identity', 'linked_existing', 'resolved_existing_identity')
    or registration.resolved_patient_id is null then
    raise exception using errcode = '23514', message = 'REGISTRATION_UNRESOLVED';
  end if;
  select * into patient from identity.patients where id = registration.resolved_patient_id for update;
  if not found or patient.status <> 'active' or patient.account_id is not null then
    raise exception using errcode = '23505', message = 'PATIENT_ENROLLMENT_CONFLICT';
  end if;
  -- Contact assertion cannot establish identity assurance. Require the exact
  -- currently verified canonical NIN, bound to governed provider evidence.
  -- A resolved-existing case retains the identifier's original registration
  -- provenance while the current case proves the same keyed NIN identity.
  select identifier.id into verified_identifier from identity.patient_identifiers identifier
    where identifier.patient_id = patient.id and identifier.identifier_type = 'nin'
      and identifier.lookup_hmac = registration.nin_lookup_hmac
      and identifier.verified and identifier.revoked_at is null
      and identifier.verified_at is not null and identifier.registration_case_id is not null
      and identifier.verification_provider is not null and identifier.verification_reference is not null
      and (registration.status = 'resolved_existing_identity'
        or (identifier.registration_case_id = registration.id
          and identifier.verification_provider = registration.verification_provider
          and identifier.verification_reference = registration.verification_reference))
    for share;
  if verified_identifier is null then
    raise exception using errcode = '23514', message = 'PATIENT_VERIFIED_IDENTITY_REQUIRED';
  end if;
  -- Never link a preexisting account by an asserted email, and never replace
  -- a patient's existing mapping, even when the caller is an approver.
  new_account := gen_random_uuid();
  insert into auth.accounts (id, subject, email, display_name, status, source_system)
    values (new_account, 'patient:' || new_account::text, lower(btrim(requested_email)),
      patient.full_name, 'pending_reset', 'hid-governed-patient-enrollment');
  insert into identity.patient_enrollments (case_id, patient_id, account_id, facility_id,
    actor_account_id, actor_membership_id, idempotency_key, request_sha256, reason)
    values (requested_case_id, patient.id, new_account, actor_facility,
      actor_account, actor_membership, requested_key, requested_digest, btrim(requested_reason));
  update identity.patients target set account_id = new_account, row_version = target.row_version + 1,
    updated_at = clock_timestamp() where target.id = patient.id and target.account_id is null;
  if not found then raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED'; end if;
  insert into identity.patient_assurance_states(patient_id,account_id,state,source_system,
    source_reference,verified_provider,nin_verified_at)
    values(patient.id,new_account,'NIN_VERIFIED','hid-governed-patient-enrollment',
      registration.id::text,registration.verification_provider,registration.verified_at);
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id,
    actor_membership_id, facility_id, patient_id, action, resource_type, resource_id,
    outcome, purpose_of_use, reason, provenance, source_system, details)
    values (platform.current_correlation_id(), 'staff', actor_subject, actor_account,
      actor_membership, actor_facility, patient.id, 'identity.patient.enroll', 'registration-case',
      requested_case_id::text, 'success', 'healthcare-operations', btrim(requested_reason), 'application', 'identity-api',
      jsonb_build_object('contactVerificationRequired', true));
  return query select patient.id, patient.hid_code, new_account, false;
end
$$;
revoke all on function identity.enroll_registered_patient(uuid, bigint, text, text, text, char) from public;
