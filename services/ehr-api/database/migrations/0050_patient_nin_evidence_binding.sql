-- A demographic match alone does not bind a submitted NIN to the current
-- patient. The submitted NIN's keyed lookup HMAC must match a prior governed,
-- verified, unrevoked NIN identifier on that exact session-bound patient.
create function identity.patient_self_nin_binding_matches(
  requested_subject text, requested_session uuid, requested_lookup_hmac text
) returns boolean language sql stable security definer
set search_path = pg_catalog, identity, pg_temp as $$
  select coalesce(requested_lookup_hmac ~ '^[0-9a-f]{64}$' and exists (
    select 1 from identity.patient_identifiers identifier
    where identifier.patient_id = identity.patient_self_session(requested_subject, requested_session)
      and identifier.identifier_type = 'nin'
      and identifier.lookup_hmac = requested_lookup_hmac
      and identifier.verified and identifier.revoked_at is null
  ), false)
$$;

-- The old five-argument entry point could record verified evidence without
-- any NIN binding. Remove it so no runtime call can use that path.
drop function identity.record_my_nin_verification_evidence(text,uuid,text,text,text);

create function identity.record_my_nin_verification_evidence(
  requested_subject text,
  requested_session uuid,
  requested_result text,
  requested_provider_reference text,
  requested_failure_category text,
  requested_lookup_hmac text
) returns table (evidence_id uuid, recorded_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
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
     or (requested_result = 'disabled' and requested_failure_category is distinct from 'disabled')
     or (requested_result = 'verified' and not identity.patient_self_nin_binding_matches(
       requested_subject, requested_session, requested_lookup_hmac))
     or (requested_result <> 'verified' and requested_lookup_hmac is not null) then
    raise exception using errcode = '23514', message = 'Patient NIN evidence binding is required';
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

revoke all on function identity.patient_self_nin_binding_matches(text,uuid,text),
  identity.record_my_nin_verification_evidence(text,uuid,text,text,text,text) from public;
