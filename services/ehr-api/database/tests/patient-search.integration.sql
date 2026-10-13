\set ON_ERROR_STOP on
-- Patient search without enumeration (0086), through the exact Identity API
-- runtime role. Rollback-only; synthetic data only.
--
-- * patients_registration_read admits a registration-role membership only to
--   patients linked to a registration case or candidate at its own facility,
--   never to every patient row.
-- * identity.patient_lookup_audit_subject names, for the audit only, the
--   patient a refused HID lookup was about.
-- * identity.registration_nin_holder and identity.registration_candidates give
--   governed registration its duplicate checks without a table-wide read.
-- * identity.create_access_request answers an unknown HID like a recorded
--   request: it records a refused audit event and persists nothing else.
-- * auth.otp_rate_limits accepts the staff search budgets.
begin;
set constraints all deferred;

insert into auth.accounts (id, subject, email, display_name, status) values
  ('e8610000-0000-4000-8000-000000000001', 'synthetic:search:nurse', 'search-nurse@example.invalid', 'Search Nurse', 'active'),
  ('e8610000-0000-4000-8000-000000000002', 'synthetic:search:doctor', 'search-doctor@example.invalid', 'Search Doctor', 'active'),
  ('e8610000-0000-4000-8000-000000000003', 'synthetic:search:pharmacist', 'search-pharmacist@example.invalid', 'Search Pharmacist', 'active'),
  ('e8610000-0000-4000-8000-000000000004', 'synthetic:search:org-admin', 'search-org-admin@example.invalid', 'Search Org Admin', 'active');
insert into identity.organizations (id, name, slug) values
  ('e8630000-0000-4000-8000-000000000001', 'Search Test Organization', 'search-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e8630000-0000-4000-8000-00000000000a', 'e8630000-0000-4000-8000-000000000001', 'Search Clinic A', 'SEARCH-A', 'Africa/Lagos', true, 'verified'),
  ('e8630000-0000-4000-8000-00000000000b', 'e8630000-0000-4000-8000-000000000001', 'Search Clinic B', 'SEARCH-B', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e8640000-0000-4000-8000-00000000000' || n)::uuid, ('e8610000-0000-4000-8000-00000000000' || n)::uuid,
  'Search Staff ' || n, 'search-staff-' || n || '@example.invalid', 'verified', role_code
from (values (1, 'nurse'), (2, 'doctor'), (3, 'pharmacist'), (4, 'org_admin')) member(n, role_code);
-- Memberships: nurse A, doctor A and B, pharmacist A, org admin A.
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select membership_id::uuid, ('e8640000-0000-4000-8000-00000000000' || n)::uuid,
  ('e8610000-0000-4000-8000-00000000000' || n)::uuid, 'e8630000-0000-4000-8000-000000000001',
  facility_id::uuid, role_code, role_code, primary_membership, true
from (values
  (1, 'nurse', 'e8650000-0000-4000-8000-0000000000a1', 'e8630000-0000-4000-8000-00000000000a', true),
  (2, 'doctor', 'e8650000-0000-4000-8000-0000000000a2', 'e8630000-0000-4000-8000-00000000000a', true),
  (2, 'doctor', 'e8650000-0000-4000-8000-0000000000b2', 'e8630000-0000-4000-8000-00000000000b', false),
  (3, 'pharmacist', 'e8650000-0000-4000-8000-0000000000a3', 'e8630000-0000-4000-8000-00000000000a', true),
  (4, 'org_admin', 'e8650000-0000-4000-8000-0000000000a4', 'e8630000-0000-4000-8000-00000000000a', true)
) member(n, role_code, membership_id, facility_id, primary_membership);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), membership.account_id, membership.membership_role, 'facility', membership.id,
  membership.facility_id, 'Patient search suite role'
from identity.staff_facility_memberships membership
where membership.organization_id = 'e8630000-0000-4000-8000-000000000001';
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct care', 'patient-search-test')
on conflict (code) do nothing;

-- Patients: one with no link at all, one the doctor holds a grant for at A,
-- one a case at A resolved to, one a case at A lists as a candidate, and one
-- a case at B resolved to.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, status) values
  ('e8620000-0000-4000-8000-000000000001', 'HID-SRCHFREE', 'Adaeze', 'Unlinked', 'Adaeze Unlinked', date '1990-01-01', 'active'),
  ('e8620000-0000-4000-8000-000000000002', 'HID-SRCHGRNT', 'Bola', 'Granted', 'Bola Granted', date '1991-02-02', 'active'),
  ('e8620000-0000-4000-8000-000000000003', 'HID-SRCHCASE', 'Chika', 'Resolved', 'Chika Resolved', date '1992-03-03', 'active'),
  ('e8620000-0000-4000-8000-000000000004', 'HID-SRCHCAND', 'Dayo', 'Candidate', 'Dayo Candidate', date '1993-04-04', 'active'),
  ('e8620000-0000-4000-8000-000000000005', 'HID-SRCHBBBB', 'Emeka', 'Annex', 'Emeka Annex', date '1994-05-05', 'active');
insert into identity.access_requests (id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use,
  reason, status, requested_duration_minutes, approved_at)
values ('e8670000-0000-4000-8000-000000000001', 'e8620000-0000-4000-8000-000000000002',
  'e8640000-0000-4000-8000-000000000002', 'e8650000-0000-4000-8000-0000000000a2',
  'e8630000-0000-4000-8000-00000000000a', 'read_records', 'direct-care', 'Search suite approval', 'approved', 60,
  clock_timestamp());
insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, granted_by_patient_id, reason, starts_at, expires_at, break_glass)
values ('e8680000-0000-4000-8000-000000000001', 'e8670000-0000-4000-8000-000000000001',
  'e8620000-0000-4000-8000-000000000002', 'e8640000-0000-4000-8000-000000000002',
  'e8610000-0000-4000-8000-000000000002', 'e8650000-0000-4000-8000-0000000000a2',
  'e8630000-0000-4000-8000-00000000000a', 'read_records', 'direct-care', 'active',
  'e8620000-0000-4000-8000-000000000002', 'Search suite grant', clock_timestamp() - interval '1 minute',
  clock_timestamp() + interval '1 hour', false);

-- Registration cases are written in the context of a registration-role
-- member of their facility (identity.validate_registration_case_write).
select set_config('app.actor_subject', 'synthetic:search:nurse', true),
       set_config('app.membership_id', 'e8650000-0000-4000-8000-0000000000a1', true),
       set_config('app.facility_id', 'e8630000-0000-4000-8000-00000000000a', true),
       set_config('app.correlation_id', 'patient-search-suite-cases-a', true),
       set_config('app.purpose_of_use', 'healthcare-operations', true);
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id,
  status, first_name, last_name, full_name, dob, nin_ciphertext, nin_lookup_hmac, nin_last4, nin_key_version,
  verification_provider, verification_reference, verified_at, idempotency_key, request_sha256, resolved_patient_id)
values
  ('e8690000-0000-4000-8000-000000000001', 'e8630000-0000-4000-8000-00000000000a',
   'e8610000-0000-4000-8000-000000000001', 'e8650000-0000-4000-8000-0000000000a1',
   'resolved_existing_identity', 'Chika', 'Resolved', 'Chika Resolved', date '1992-03-03',
   decode(repeat('cd', 32), 'hex'), repeat('3', 64), '0003', 'synthetic', 'synthetic-provider',
   'search-suite-case-0001', clock_timestamp(), 'search-suite-case-key-1', repeat('a', 64),
   'e8620000-0000-4000-8000-000000000003'),
  ('e8690000-0000-4000-8000-000000000002', 'e8630000-0000-4000-8000-00000000000a',
   'e8610000-0000-4000-8000-000000000001', 'e8650000-0000-4000-8000-0000000000a1',
   'review_required', 'Dayo', 'Candidate', 'Dayo Candidate', date '1993-04-04',
   decode(repeat('ce', 32), 'hex'), repeat('4', 64), '0004', 'synthetic', 'synthetic-provider',
   'search-suite-case-0002', clock_timestamp(), 'search-suite-case-key-2', repeat('b', 64), null);
insert into identity.registration_case_candidates (case_id, patient_id, match_score, match_reasons)
values ('e8690000-0000-4000-8000-000000000002', 'e8620000-0000-4000-8000-000000000004', 90,
  '["date_of_birth","last_name"]'::jsonb);
select set_config('app.actor_subject', 'synthetic:search:doctor', true),
       set_config('app.membership_id', 'e8650000-0000-4000-8000-0000000000b2', true),
       set_config('app.facility_id', 'e8630000-0000-4000-8000-00000000000b', true),
       set_config('app.correlation_id', 'patient-search-suite-cases-b', true);
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id,
  status, first_name, last_name, full_name, dob, nin_ciphertext, nin_lookup_hmac, nin_last4, nin_key_version,
  verification_provider, verification_reference, verified_at, idempotency_key, request_sha256, resolved_patient_id)
values ('e8690000-0000-4000-8000-000000000003', 'e8630000-0000-4000-8000-00000000000b',
  'e8610000-0000-4000-8000-000000000002', 'e8650000-0000-4000-8000-0000000000b2',
  'resolved_existing_identity', 'Emeka', 'Annex', 'Emeka Annex', date '1994-05-05',
  decode(repeat('cf', 32), 'hex'), repeat('5', 64), '0005', 'synthetic', 'synthetic-provider',
  'search-suite-case-0003', clock_timestamp(), 'search-suite-case-key-3', repeat('c', 64),
  'e8620000-0000-4000-8000-000000000005');
-- A verified NIN of the unlinked patient (its evidence names a case; the
-- patient is still linked to none).
insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
  encryption_key_version, display_hint, verified, verified_at, verification_provider, verification_reference,
  registration_case_id)
values ('e8660000-0000-4000-8000-000000000001', 'e8620000-0000-4000-8000-000000000001', 'nin',
  decode(repeat('ab', 32), 'hex'), repeat('1', 64), 'synthetic', '****0001', true, clock_timestamp(),
  'synthetic-provider', 'search-suite-nin-0001', 'e8690000-0000-4000-8000-000000000003');

create function pg_temp.search_context(subject text, membership text, facility text, purpose text,
  correlation text) returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.membership_id', membership, true),
         set_config('app.facility_id', facility, true), set_config('app.purpose_of_use', purpose, true),
         set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.visible_search_patients() returns text language sql as $$
  select coalesce(string_agg(hid_code, ',' order by hid_code), '')
    from identity.patients where hid_code like 'HID-SRCH%';
$$;

set local role hid_identity_api_runtime;

-- 1. Row-level security: a clinical role never reads every patient row.
do $$
declare
  visible text;
begin
  perform pg_temp.search_context('synthetic:search:nurse', 'e8650000-0000-4000-8000-0000000000a1',
    'e8630000-0000-4000-8000-00000000000a', 'direct-care', 'patient-search-suite-rls-1');
  visible := pg_temp.visible_search_patients();
  if visible is distinct from 'HID-SRCHCAND,HID-SRCHCASE' then
    raise exception 'A nurse at facility A must read only the patients linked to its registration cases, read %', visible;
  end if;
  if exists (select 1 from identity.patient_identifiers where patient_id = 'e8620000-0000-4000-8000-000000000001') then
    raise exception 'A nurse read the NIN identifier of a patient with no consent or registration link';
  end if;
  if exists (select 1 from identity.patients where upper(hid_code) = 'HID-SRCHFREE') then
    raise exception 'An exact HID match exposed a patient with no consent or registration link';
  end if;

  perform pg_temp.search_context('synthetic:search:doctor', 'e8650000-0000-4000-8000-0000000000a2',
    'e8630000-0000-4000-8000-00000000000a', 'direct-care', 'patient-search-suite-rls-2');
  visible := pg_temp.visible_search_patients();
  if visible is distinct from 'HID-SRCHCAND,HID-SRCHCASE,HID-SRCHGRNT' then
    raise exception 'A doctor at facility A must read its consented and registration-linked patients only, read %', visible;
  end if;

  perform pg_temp.search_context('synthetic:search:doctor', 'e8650000-0000-4000-8000-0000000000b2',
    'e8630000-0000-4000-8000-00000000000b', 'direct-care', 'patient-search-suite-rls-3');
  visible := pg_temp.visible_search_patients();
  if visible is distinct from 'HID-SRCHBBBB' then
    raise exception 'At facility B the doctor must read only facility B registration links (no facility A grant), read %', visible;
  end if;

  perform pg_temp.search_context('synthetic:search:pharmacist', 'e8650000-0000-4000-8000-0000000000a3',
    'e8630000-0000-4000-8000-00000000000a', 'direct-care', 'patient-search-suite-rls-4');
  visible := pg_temp.visible_search_patients();
  if visible <> '' then
    raise exception 'A role without registration permissions read patients without consent: %', visible;
  end if;
end $$;

-- 2. The audit subject of a refused lookup: exact HID, any case, for an
-- identity.patient.read member only. It reads nothing else.
do $$
declare
  subject uuid;
begin
  perform pg_temp.search_context('synthetic:search:nurse', 'e8650000-0000-4000-8000-0000000000a1',
    'e8630000-0000-4000-8000-00000000000a', 'direct-care', 'patient-search-suite-subject-1');
  subject := identity.patient_lookup_audit_subject('hid-srchfree');
  if subject is distinct from 'e8620000-0000-4000-8000-000000000001'::uuid then
    raise exception 'The audit subject of an exact HID lookup was %', subject;
  end if;
  if identity.patient_lookup_audit_subject('HID-SRCHNONE') is not null
     or identity.patient_lookup_audit_subject('HID-SRCH') is not null then
    raise exception 'An unknown or partial HID named an audit subject';
  end if;
  perform pg_temp.search_context('synthetic:search:org-admin', 'e8650000-0000-4000-8000-0000000000a4',
    'e8630000-0000-4000-8000-00000000000a', 'direct-care', 'patient-search-suite-subject-2');
  begin
    perform identity.patient_lookup_audit_subject('HID-SRCHFREE');
    raise exception 'A member without identity.patient.read resolved a lookup audit subject';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.search_context('synthetic:search:nurse', 'e8650000-0000-4000-8000-0000000000b2',
    'e8630000-0000-4000-8000-00000000000b', 'direct-care', 'patient-search-suite-subject-3');
  begin
    perform identity.patient_lookup_audit_subject('HID-SRCHFREE');
    raise exception 'A borrowed membership resolved a lookup audit subject';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 3. Governed registration keeps its duplicate checks through two narrow
-- commands, for registration members only.
do $$
declare
  holder record;
  candidates text;
begin
  perform pg_temp.search_context('synthetic:search:nurse', 'e8650000-0000-4000-8000-0000000000a1',
    'e8630000-0000-4000-8000-00000000000a', 'healthcare-operations', 'patient-search-suite-registration-1');
  select * into holder from identity.registration_nin_holder(repeat('1', 64));
  if holder.patient_id is distinct from 'e8620000-0000-4000-8000-000000000001'::uuid
     or holder.hid_code is distinct from 'HID-SRCHFREE' or holder.patient_status is distinct from 'active' then
    raise exception 'The verified NIN holder was not found: %', row_to_json(holder);
  end if;
  if exists (select 1 from identity.registration_nin_holder(repeat('9', 64))) then
    raise exception 'An unknown NIN lookup HMAC named a holder';
  end if;
  select string_agg(candidate.full_name, ',' order by candidate.full_name) into candidates
    from identity.registration_candidates(date '1990-01-01', 'Nobody', 'Granted') candidate
   where candidate.patient_id::text like 'e8620000-%';
  if candidates is distinct from 'Adaeze Unlinked,Bola Granted' then
    raise exception 'Registration candidates must match the date of birth or a name, got %', candidates;
  end if;
  begin
    perform identity.registration_nin_holder('not-a-lookup-hmac');
    raise exception 'A malformed NIN lookup HMAC was accepted';
  exception when invalid_parameter_value then null;
  end;
  perform pg_temp.search_context('synthetic:search:pharmacist', 'e8650000-0000-4000-8000-0000000000a3',
    'e8630000-0000-4000-8000-00000000000a', 'healthcare-operations', 'patient-search-suite-registration-2');
  begin
    perform identity.registration_candidates(date '1990-01-01', 'Adaeze', 'Unlinked');
    raise exception 'A member without registration permissions searched registration candidates';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.registration_nin_holder(repeat('1', 64));
    raise exception 'A member without registration permissions resolved a NIN holder';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The candidate command returns minimum demographics only.
do $$
begin
  if (select string_agg(parameter.name, ',' order by parameter.ordinality)
        from pg_proc procedure_row
        cross join lateral unnest(procedure_row.proargnames, procedure_row.proargmodes::text[])
          with ordinality parameter(name, mode, ordinality)
       where procedure_row.oid = 'identity.registration_candidates(date,text,text)'::regprocedure
         and parameter.mode = 't') is distinct from 'patient_id,first_name,last_name,full_name,dob' then
    raise exception 'identity.registration_candidates must return only the candidate demographics';
  end if;
end $$;

-- 4. An access request for an unknown HID is answered like a recorded one,
-- audited as refused, and persists nothing for any patient.
do $$
declare
  refused record;
  recorded record;
  requests_before integer;
begin
  perform pg_temp.search_context('synthetic:search:doctor', 'e8650000-0000-4000-8000-0000000000a2',
    'e8630000-0000-4000-8000-00000000000a', 'direct-care', 'patient-search-suite-request-1');
  select count(*) into requests_before from identity.access_requests
   where membership_id = 'e8650000-0000-4000-8000-0000000000a2';
  select * into refused from identity.create_access_request('HID-SRCHNONE', 'read_records',
    'Synthetic follow-up consultation', 60);
  if refused.access_request_id is null or refused.subject_patient_id is not null
     or refused.request_status is distinct from 'pending' or refused.request_scope is distinct from 'read_records'
     or refused.request_purpose is distinct from 'direct-care' or refused.duration_minutes is distinct from 60
     or refused.requested_at is null or refused.existing_request is distinct from false then
    raise exception 'An unknown HID was not answered like a recorded request: %', row_to_json(refused);
  end if;
  if (select count(*) from identity.access_requests
       where membership_id = 'e8650000-0000-4000-8000-0000000000a2') <> requests_before
     or exists (select 1 from identity.access_requests where id = refused.access_request_id) then
    raise exception 'An access request for an unknown HID persisted a request';
  end if;
  select * into recorded from identity.create_access_request('HID-SRCHFREE', 'read_records',
    'Synthetic follow-up consultation', 60);
  if recorded.subject_patient_id is distinct from 'e8620000-0000-4000-8000-000000000001'::uuid
     or not exists (select 1 from identity.access_requests where id = recorded.access_request_id) then
    raise exception 'A request for a known HID was not recorded';
  end if;
end $$;
reset role;

do $$
begin
  if (select count(*) from audit.events
       where correlation_id = 'patient-search-suite-request-1' and action = 'identity.access-request.refused'
         and outcome = 'denied' and patient_id is null and resource_type = 'access-request'
         and actor_membership_id = 'e8650000-0000-4000-8000-0000000000a2'
         and details ->> 'reason' = 'patient_not_available') <> 1 then
    raise exception 'The refused access request was not audited exactly once';
  end if;
  if exists (select 1 from audit.events where correlation_id = 'patient-search-suite-request-1'
               and action = 'identity.access-request.refused' and details::text like '%SRCHNONE%') then
    raise exception 'The refused access request audit copied the requested HID';
  end if;
end $$;

-- 5. Staff search budgets reuse the keyed request-window table.
set local role hid_identity_api_runtime;
do $$
begin
  insert into auth.otp_rate_limits (scope, bucket_hmac, window_started_at, request_count)
  select scope, repeat('e', 64), clock_timestamp(), 1
    from unnest(array['patient_lookup_actor', 'patient_lookup_facility',
      'access_request_actor', 'access_request_facility']) scope;
  begin
    insert into auth.otp_rate_limits (scope, bucket_hmac, window_started_at, request_count)
    values ('patient_lookup_everyone', repeat('e', 64), clock_timestamp(), 1);
    raise exception 'auth.otp_rate_limits accepted an unknown scope';
  exception when check_violation then null;
  end;
end $$;
reset role;

-- 6. Only the Identity runtime may call the new commands.
set local role hid_ehr_api_runtime;
do $$
begin
  begin
    perform identity.patient_lookup_audit_subject('HID-SRCHFREE');
    raise exception 'The EHR runtime resolved a lookup audit subject';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.registration_candidates(date '1990-01-01', 'Adaeze', 'Unlinked');
    raise exception 'The EHR runtime searched registration candidates';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;
