-- Patient self-service may display whether a PIN exists without exposing the
-- verifier or granting direct table access to the Identity runtime.
create or replace function identity.patient_self_profile(requested_subject text, requested_session uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('patientId',p.id,'hid',p.hid_code,
    'firstName',p.first_name,'lastName',p.last_name,'fullName',p.full_name,
    'dateOfBirth',p.dob,'gender',p.gender,'country',p.country,'state',p.state,
    'version',p.row_version,
    'assuranceState',(
      select assurance.state from identity.patient_assurance_states assurance
      where assurance.patient_id=p.id
    ),
    'accessPinConfigured',exists (
      select 1 from identity.patient_access_pins pin
      where pin.patient_id=p.id and pin.status='active'
    ))
  from identity.patients p
  where p.id = identity.patient_self_session(requested_subject,requested_session)
$$;

revoke all on function identity.patient_self_profile(text,uuid) from public;
