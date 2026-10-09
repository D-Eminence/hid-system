\set ON_ERROR_STOP on
-- The clinician's own access-request list reports the outcome of each approval
-- (0074), through the exact Identity API runtime role. Rollback-only.
begin;
set constraints all deferred;

insert into auth.accounts (id, subject, email, display_name, status) values
  ('f9100000-0000-4000-8000-000000000001', 'synthetic:outcome:patient', 'outcome-patient@example.invalid', 'Outcome Patient', 'active'),
  ('f9100000-0000-4000-8000-000000000002', 'synthetic:outcome:clinician', 'outcome-clinician@example.invalid', 'Outcome Clinician', 'active'),
  ('f9100000-0000-4000-8000-000000000003', 'synthetic:outcome:colleague', 'outcome-colleague@example.invalid', 'Outcome Colleague', 'active'),
  ('f9100000-0000-4000-8000-000000000004', 'synthetic:outcome:org-admin', 'outcome-org-admin@example.invalid', 'Outcome Org Admin', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('f9200000-0000-4000-8000-000000000001', 'f9100000-0000-4000-8000-000000000001', 'HID-RESULTX', 'Outcome', 'Patient', 'Outcome Patient', 'active');
insert into identity.organizations (id, name, slug) values
  ('f9300000-0000-4000-8000-000000000001', 'Outcome Test Organization', 'outcome-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('f9300000-0000-4000-8000-000000000002', 'f9300000-0000-4000-8000-000000000001', 'Outcome Test Clinic',
   'OUTCOME-A', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('f9400000-0000-4000-8000-000000000002', 'f9100000-0000-4000-8000-000000000002', 'Outcome Clinician',
   'outcome-clinician@example.invalid', 'verified', 'doctor'),
  ('f9400000-0000-4000-8000-000000000003', 'f9100000-0000-4000-8000-000000000003', 'Outcome Colleague',
   'outcome-colleague@example.invalid', 'verified', 'doctor'),
  ('f9400000-0000-4000-8000-000000000004', 'f9100000-0000-4000-8000-000000000004', 'Outcome Org Admin',
   'outcome-org-admin@example.invalid', 'verified', 'org_admin');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('f9500000-0000-4000-8000-00000000000' || n)::uuid, ('f9400000-0000-4000-8000-00000000000' || n)::uuid,
  ('f9100000-0000-4000-8000-00000000000' || n)::uuid, 'f9300000-0000-4000-8000-000000000001',
  'f9300000-0000-4000-8000-000000000002', role_code, role_code, true, true
from (values (2, 'doctor'), (3, 'doctor'), (4, 'org_admin')) member(n, role_code);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('f9100000-0000-4000-8000-00000000000' || n)::uuid, role_code, 'facility',
  ('f9500000-0000-4000-8000-00000000000' || n)::uuid, 'f9300000-0000-4000-8000-000000000002', 'Outcome suite role'
from (values (2, 'doctor'), (3, 'doctor'), (4, 'org_admin')) member(n, role_code);
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct care', 'outcome-test')
on conflict (code) do nothing;

-- Requests by the clinician (1-8) and by a colleague at the same facility (9).
insert into identity.access_requests (id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use,
  reason, status, requested_duration_minutes, approved_at, denied_at, denied_reason, created_at)
select ('f9600000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'f9200000-0000-4000-8000-000000000001',
  ('f9400000-0000-4000-8000-00000000000' || requester)::uuid, ('f9500000-0000-4000-8000-00000000000' || requester)::uuid,
  'f9300000-0000-4000-8000-000000000002', 'read_records', 'direct-care', 'Outcome request ' || n, request_status, 60,
  case when request_status = 'approved' then clock_timestamp() - interval '2 hours' end,
  case when request_status = 'denied' then clock_timestamp() - interval '2 hours' end,
  case when request_status = 'denied' then 'Not now' end,
  clock_timestamp() - make_interval(mins => 100 - n)
from (values (1, 2, 'pending'), (2, 2, 'approved'), (3, 2, 'approved'), (4, 2, 'approved'), (5, 2, 'approved'),
  (6, 2, 'approved'), (7, 2, 'approved'), (8, 2, 'denied'), (9, 3, 'pending'), (10, 2, 'approved'),
  (11, 2, 'approved')) request(n, requester, request_status);
-- The grants made from the approvals: current, lapsed but unswept, marked
-- expired, revoked by the patient, closed by the clinician, a PIN grant, and
-- two that lapsed before the patient (a later PIN change) or the clinician
-- revoked them, which stay expired.
insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, granted_by_patient_id, reason, starts_at, expires_at, revoked_at, revoked_by,
  revoked_reason, authorization_method, break_glass)
select ('f9700000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('f9600000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'f9200000-0000-4000-8000-000000000001', 'f9400000-0000-4000-8000-000000000002',
  'f9100000-0000-4000-8000-000000000002', 'f9500000-0000-4000-8000-000000000002',
  'f9300000-0000-4000-8000-000000000002', 'read_records', 'direct-care', grant_status,
  'f9200000-0000-4000-8000-000000000001', 'Outcome grant ' || n, clock_timestamp() - interval '2 hours',
  clock_timestamp() + ends_in, case when grant_status = 'revoked' then clock_timestamp() - interval '1 hour' end,
  revoker, case when grant_status = 'revoked' then 'Outcome revocation' end, method, false
from (values
  (2, 'active', interval '30 minutes', null::uuid, null::text),
  (3, 'active', interval '-5 minutes', null, null),
  (4, 'expired', interval '-30 minutes', null, null),
  (5, 'revoked', interval '30 minutes', 'f9100000-0000-4000-8000-000000000001'::uuid, null),
  (6, 'revoked', interval '30 minutes', 'f9100000-0000-4000-8000-000000000002'::uuid, null),
  (7, 'active', interval '30 minutes', null, 'patient_access_pin'),
  (10, 'revoked', interval '-90 minutes', 'f9100000-0000-4000-8000-000000000001'::uuid, 'patient_access_pin'),
  (11, 'revoked', interval '-90 minutes', 'f9100000-0000-4000-8000-000000000002'::uuid, null)) grant_fixture(n, grant_status, ends_in, revoker, method);

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:outcome:clinician', true),
       set_config('app.membership_id', 'f9500000-0000-4000-8000-000000000002', true),
       set_config('app.facility_id', 'f9300000-0000-4000-8000-000000000002', true),
       set_config('app.correlation_id', 'outcome-suite-0001', true),
       set_config('app.purpose_of_use', 'direct-care', true);

do $$
declare
  mismatches text;
begin
  select string_agg(format('%s: %s/%s/%s', coalesce(expected.id, actual.access_request_id),
           actual.effective_status, actual.authorization_method, actual.consent_grant_id), '; ')
    into mismatches
    from (values
      ('f9600000-0000-4000-8000-000000000001'::uuid, 'pending', null::text, null::uuid),
      ('f9600000-0000-4000-8000-000000000002', 'active', 'patient_approval', 'f9700000-0000-4000-8000-000000000002'::uuid),
      ('f9600000-0000-4000-8000-000000000003', 'expired', 'patient_approval', 'f9700000-0000-4000-8000-000000000003'),
      ('f9600000-0000-4000-8000-000000000004', 'expired', 'patient_approval', 'f9700000-0000-4000-8000-000000000004'),
      ('f9600000-0000-4000-8000-000000000005', 'revoked', 'patient_approval', 'f9700000-0000-4000-8000-000000000005'),
      ('f9600000-0000-4000-8000-000000000006', 'closed', 'patient_approval', 'f9700000-0000-4000-8000-000000000006'),
      ('f9600000-0000-4000-8000-000000000007', 'active', 'patient_access_pin', 'f9700000-0000-4000-8000-000000000007'),
      ('f9600000-0000-4000-8000-000000000008', 'denied', null, null),
      ('f9600000-0000-4000-8000-000000000010', 'expired', 'patient_access_pin', 'f9700000-0000-4000-8000-000000000010'),
      ('f9600000-0000-4000-8000-000000000011', 'expired', 'patient_approval', 'f9700000-0000-4000-8000-000000000011')
    ) expected(id, effective_status, method, grant_id)
    full join identity.list_my_staff_access_requests(null) actual on actual.access_request_id = expected.id
   where actual.access_request_id is null or expected.id is null
      or actual.effective_status is distinct from expected.effective_status
      or actual.authorization_method is distinct from expected.method
      or actual.consent_grant_id is distinct from expected.grant_id;
  if mismatches is not null then
    raise exception 'unexpected access-request outcomes (a colleague''s request must not appear): %', mismatches;
  end if;

  -- The filter matches the request status or the outcome: 'approved' still
  -- returns every approval, and each outcome returns the approvals it names.
  select string_agg(format('%s: %s', expected.filter, expected.ids), '; ')
    into mismatches
    from (values
      ('approved', '2,3,4,5,6,7,10,11'), ('active', '2,7'), ('expired', '3,4,10,11'), ('closed', '6'),
      ('revoked', '5'), ('pending', '1'), ('denied', '8')
    ) expected(filter, ids)
   where expected.ids is distinct from (
     select string_agg(ltrim(right(listed.access_request_id::text, 12), '0'), ',' order by listed.access_request_id)
       from identity.list_my_staff_access_requests(expected.filter) listed);
  if mismatches is not null then
    raise exception 'the status filter must match the request status or the outcome: %', mismatches;
  end if;
  if (select grant_expires_at from identity.list_my_staff_access_requests('approved')
       where access_request_id = 'f9600000-0000-4000-8000-000000000002') <= clock_timestamp() then
    raise exception 'an active grant must report its expiry';
  end if;
end $$;

-- A colleague sees only their own request.
select set_config('app.actor_subject', 'synthetic:outcome:colleague', true),
       set_config('app.membership_id', 'f9500000-0000-4000-8000-000000000003', true);
do $$ begin
  if (select array_agg(access_request_id) from identity.list_my_staff_access_requests(null))
     is distinct from array['f9600000-0000-4000-8000-000000000009'::uuid] then
    raise exception 'a clinician must see only their own access requests';
  end if;
end $$;

-- A member without identity.consent.write is refused.
select set_config('app.actor_subject', 'synthetic:outcome:org-admin', true),
       set_config('app.membership_id', 'f9500000-0000-4000-8000-000000000004', true);
do $$ begin
  perform 1 from identity.list_my_staff_access_requests(null);
  raise exception 'a member without identity.consent.write must be refused';
exception when insufficient_privilege then null;
end $$;

reset role;
rollback;
