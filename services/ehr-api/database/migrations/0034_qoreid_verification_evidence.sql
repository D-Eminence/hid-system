-- QoreID verification is evidence about an existing canonical subject. This
-- migration intentionally stores no NIN, CAC number, provider payload, photo,
-- address, demographic record, or OAuth material.

create table identity.verification_evidence (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('patient', 'organization')),
  patient_id uuid references identity.patients(id) on delete restrict,
  organization_id uuid references identity.organizations(id) on delete restrict,
  verification_type text not null check (verification_type in ('nin', 'cac')),
  organization_context text check (organization_context in ('hospital', 'laboratory', 'pharmacy')),
  provider text not null check (provider = 'qoreid'),
  provider_reference text check (
    provider_reference is null
    or (length(provider_reference) between 1 and 255
      and provider_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$')
  ),
  result text not null check (result in ('verified', 'not_verified', 'incomplete', 'provider_error', 'disabled')),
  failure_category text check (failure_category in (
    'not_verified', 'incomplete', 'provider_authentication', 'provider_unavailable',
    'timeout', 'network', 'malformed_response', 'unexpected_response', 'disabled'
  )),
  verified_at timestamptz,
  correlation_id text not null check (
    length(correlation_id) between 8 and 128
    and correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  actor_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  facility_id uuid references identity.facilities(id) on delete restrict,
  source_system text not null default 'identity-api' check (source_system = 'identity-api'),
  created_at timestamptz not null default clock_timestamp(),
  check (
    (subject_type = 'patient' and verification_type = 'nin'
      and patient_id is not null and organization_id is null and organization_context is null
      and actor_membership_id is null and facility_id is null)
    or (subject_type = 'organization' and verification_type = 'cac'
      and patient_id is null and organization_id is not null and organization_context is not null
      and actor_membership_id is not null and facility_id is not null)
  ),
  check (
    (result = 'verified' and failure_category is null and verified_at is not null)
    or (result = 'not_verified' and failure_category = 'not_verified' and verified_at is null)
    or (result = 'incomplete' and failure_category = 'incomplete' and verified_at is null)
    or (result = 'provider_error' and failure_category in (
      'provider_authentication', 'provider_unavailable', 'timeout', 'network',
      'malformed_response', 'unexpected_response'
    ) and verified_at is null)
    or (result = 'disabled' and failure_category = 'disabled' and verified_at is null)
  )
);

create index verification_evidence_patient_created_idx
  on identity.verification_evidence (patient_id, created_at desc) where patient_id is not null;
create index verification_evidence_organization_created_idx
  on identity.verification_evidence (organization_id, created_at desc) where organization_id is not null;
create index verification_evidence_correlation_idx
  on identity.verification_evidence (correlation_id, created_at desc);
create trigger verification_evidence_no_mutation
  before update or delete on identity.verification_evidence
  for each row execute function platform.reject_mutation();

comment on table identity.verification_evidence is
  'Append-only minimal QoreID verification evidence. It excludes submitted identifiers and provider response payloads.';

-- Patient verification is available only to an authenticated patient session
-- that is already bound to the canonical patient. This command cannot insert,
-- merge, enroll, link, or otherwise alter an identity record.
create function identity.record_my_nin_verification_evidence(
  requested_subject text,
  requested_session uuid,
  requested_result text,
  requested_provider_reference text,
  requested_failure_category text
)
returns table (evidence_id uuid, recorded_at timestamptz)
language plpgsql security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
  evidence_id_value uuid;
  recorded_at_value timestamptz;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_result not in ('verified', 'not_verified', 'incomplete', 'provider_error', 'disabled')
     or requested_failure_category is not null and requested_failure_category not in (
       'not_verified', 'incomplete', 'provider_authentication', 'provider_unavailable',
       'timeout', 'network', 'malformed_response', 'unexpected_response', 'disabled'
     )
     or requested_provider_reference is not null and (
       length(requested_provider_reference) not between 1 and 255
       or requested_provider_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
     ) then
    raise exception using errcode = '22023', message = 'Invalid verification evidence';
  end if;
  if (requested_result = 'verified' and requested_failure_category is not null)
     or (requested_result = 'not_verified' and requested_failure_category is distinct from 'not_verified')
     or (requested_result = 'incomplete' and requested_failure_category is distinct from 'incomplete')
     or (requested_result = 'provider_error' and requested_failure_category not in (
       'provider_authentication', 'provider_unavailable', 'timeout', 'network',
       'malformed_response', 'unexpected_response'
     ))
     or (requested_result = 'disabled' and requested_failure_category is distinct from 'disabled') then
    raise exception using errcode = '22023', message = 'Invalid verification evidence state';
  end if;

  select account_id into account_id_value
  from identity.patients where id = patient_id_value and account_id is not null;
  if account_id_value is null then
    raise exception using errcode = '42501', message = 'Patient account is required';
  end if;

  insert into identity.verification_evidence (
    subject_type, patient_id, verification_type, provider, provider_reference,
    result, failure_category, verified_at, correlation_id, actor_account_id, source_system
  ) values (
    'patient', patient_id_value, 'nin', 'qoreid', requested_provider_reference,
    requested_result, requested_failure_category,
    case when requested_result = 'verified' then clock_timestamp() else null end,
    platform.current_correlation_id(), account_id_value, 'identity-api'
  ) returning id, created_at into evidence_id_value, recorded_at_value;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient.nin-verification',
    case when requested_result = 'verified' then 'success'
      when requested_result in ('not_verified', 'incomplete') then 'denied' else 'failure' end,
    'verification-evidence', evidence_id_value::text, 'patient-self',
    'application', 'identity-api', jsonb_build_object(
      'provider', 'qoreid', 'verificationType', 'nin', 'result', requested_result,
      'failureCategory', requested_failure_category, 'providerReference', requested_provider_reference
    )
  );
  return query select evidence_id_value, recorded_at_value;
end;
$$;

-- Staff can verify only the organization resolved by their exact active
-- facility membership. There is no caller-supplied organization ID and this
-- command has no organization creation, transfer, or merge behavior.
create function identity.record_organization_cac_verification_evidence(
  requested_organization_context text,
  requested_result text,
  requested_provider_reference text,
  requested_failure_category text
)
returns table (evidence_id uuid, recorded_at timestamptz)
language plpgsql security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject_value text := platform.current_actor_subject();
  account_id_value uuid := auth.account_id_for_subject(actor_subject_value);
  membership_id_value uuid := platform.current_membership_id();
  facility_id_value uuid := platform.current_facility_id();
  organization_id_value uuid;
  evidence_id_value uuid;
  recorded_at_value timestamptz;
begin
  if account_id_value is null or membership_id_value is null or facility_id_value is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.membership_has_permission(
       actor_subject_value, membership_id_value, facility_id_value, 'organization.manage'
     ) then
    raise exception using errcode = '42501', message = 'Organization verification authorization is required';
  end if;
  if requested_organization_context not in ('hospital', 'laboratory', 'pharmacy')
     or requested_result not in ('verified', 'not_verified', 'incomplete', 'provider_error', 'disabled')
     or requested_failure_category is not null and requested_failure_category not in (
       'not_verified', 'incomplete', 'provider_authentication', 'provider_unavailable',
       'timeout', 'network', 'malformed_response', 'unexpected_response', 'disabled'
     )
     or requested_provider_reference is not null and (
       length(requested_provider_reference) not between 1 and 255
       or requested_provider_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
     ) then
    raise exception using errcode = '22023', message = 'Invalid verification evidence';
  end if;
  if (requested_result = 'verified' and requested_failure_category is not null)
     or (requested_result = 'not_verified' and requested_failure_category is distinct from 'not_verified')
     or (requested_result = 'incomplete' and requested_failure_category is distinct from 'incomplete')
     or (requested_result = 'provider_error' and requested_failure_category not in (
       'provider_authentication', 'provider_unavailable', 'timeout', 'network',
       'malformed_response', 'unexpected_response'
     ))
     or (requested_result = 'disabled' and requested_failure_category is distinct from 'disabled') then
    raise exception using errcode = '22023', message = 'Invalid verification evidence state';
  end if;

  select facility.organization_id into organization_id_value
  from identity.staff_facility_memberships membership
  join identity.facilities facility on facility.id = membership.facility_id
  join identity.organizations organization_row on organization_row.id = facility.organization_id
  where membership.id = membership_id_value
    and membership.account_id = account_id_value
    and membership.facility_id = facility_id_value
    and membership.organization_id = facility.organization_id
    and membership.active and facility.active and organization_row.active;
  if organization_id_value is null then
    raise exception using errcode = '42501', message = 'Existing organization authorization is required';
  end if;

  insert into identity.verification_evidence (
    subject_type, organization_id, verification_type, organization_context,
    provider, provider_reference, result, failure_category, verified_at,
    correlation_id, actor_account_id, actor_membership_id, facility_id, source_system
  ) values (
    'organization', organization_id_value, 'cac', requested_organization_context,
    'qoreid', requested_provider_reference, requested_result, requested_failure_category,
    case when requested_result = 'verified' then clock_timestamp() else null end,
    platform.current_correlation_id(), account_id_value, membership_id_value, facility_id_value, 'identity-api'
  ) returning id, created_at into evidence_id_value, recorded_at_value;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', actor_subject_value, account_id_value, membership_id_value,
    organization_id_value, facility_id_value, 'identity.organization.cac-verification',
    case when requested_result = 'verified' then 'success'
      when requested_result in ('not_verified', 'incomplete') then 'denied' else 'failure' end,
    'verification-evidence', evidence_id_value::text,
    'healthcare-operations', 'application', 'identity-api', jsonb_build_object(
      'provider', 'qoreid', 'verificationType', 'cac', 'organizationContext', requested_organization_context,
      'result', requested_result, 'failureCategory', requested_failure_category,
      'providerReference', requested_provider_reference
    )
  );
  return query select evidence_id_value, recorded_at_value;
end;
$$;

revoke all on identity.verification_evidence from public;
revoke all on function identity.record_my_nin_verification_evidence(text, uuid, text, text, text) from public;
revoke all on function identity.record_organization_cac_verification_evidence(text, text, text, text) from public;
