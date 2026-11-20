\set ON_ERROR_STOP on
-- Q108 desk NIN check review (no migration): the read the registration desk
-- makes before it asks the NIN service, word for word as
-- NinRegistrationService sends it (qoreid-nin-desk.spec.ts checks that),
-- run under row-level security as Identity's runtime role in the context
-- Identity's transactions set. Rollback-only. Fictional people, places and
-- identifiers only; ids start a5180.
--
--   readNinHolder (Q110): the active patient who holds the NIN verified and
--   not revoked, with the name, date of birth (as text), sex and that check's
--   provider, reference and time; nothing for a revoked NIN, an inactive
--   patient or an unknown NIN; nothing for a member without
--   identity.registration.write.
--
--   SEALED_TENANT_SQL (0098 G6, 0123 G6q and D9): whether the desk's
--   facility or staff account is a member of the sealed demo or QA tenant,
--   whose desks make no QoreID call, read through the helpers 0098 and 0123
--   grant Identity's runtime (it cannot read the members themselves): true
--   for a demo or QA facility and for a demo or QA account, false for a real
--   facility and account and for null ids.
--
-- Each case records its outcome and the suite fails at the end listing every
-- case whose outcome differs.
begin;

set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('a5180000-0000-4000-8000-000000000001', 'Desk Holder Test Group', 'desk-holder-test-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('a5180000-0000-4000-8000-000000000002', 'a5180000-0000-4000-8000-000000000001', 'Desk Holder Test Clinic',
   'DESK-HOLDER-A', 'Africa/Lagos', true, 'verified');
-- Desk 1, a receptionist; member 2, a lab member without registration permission.
create temporary table holder_members (n integer primary key, role_code text, name text) on commit drop;
insert into holder_members values (1, 'receptionist', 'Ada Desk'), (2, 'lab', 'Bola Lab');
insert into auth.accounts (id, subject, email, display_name, status)
select ('a5180100-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:holder-member-' || n,
  'holder-member-' || n || '@example.invalid', name, 'active' from holder_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('a5180200-0000-4000-8000-00000000000' || n)::uuid, ('a5180100-0000-4000-8000-00000000000' || n)::uuid,
  name, 'holder-member-' || n || '@example.invalid', 'verified', role_code from holder_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('a5180300-0000-4000-8000-00000000000' || n)::uuid, ('a5180200-0000-4000-8000-00000000000' || n)::uuid,
  ('a5180100-0000-4000-8000-00000000000' || n)::uuid, 'a5180000-0000-4000-8000-000000000001',
  'a5180000-0000-4000-8000-000000000002', role_code, role_code, true, true
from holder_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('a5180100-0000-4000-8000-00000000000' || n)::uuid, role_code, 'facility',
  ('a5180300-0000-4000-8000-00000000000' || n)::uuid, 'a5180000-0000-4000-8000-000000000002',
  'Synthetic desk holder suite role'
from holder_members;

-- Patients: 1 holds NIN c1 checked; 2 held c2, revoked; 3 holds c3 but is inactive.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status) values
  ('a5180400-0000-4000-8000-000000000001', 'HID-HLD2A3', 'Ada', 'Holder', 'Ada Holder', '1991-04-05', 'female',
   'active'),
  ('a5180400-0000-4000-8000-000000000002', 'HID-HLD4B5', 'Bola', 'Revoked', 'Bola Revoked', '1980-01-02', 'male',
   'active'),
  ('a5180400-0000-4000-8000-000000000003', 'HID-HLD6C7', 'Chidi', 'Inactive', 'Chidi Inactive', '1975-06-07', null,
   'inactive');
insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
  encryption_key_version, display_hint, verified, verified_at, verification_provider, verification_reference,
  registration_case_id, revoked_at, revocation_reason) values
  ('a5180600-0000-4000-8000-000000000001', 'a5180400-0000-4000-8000-000000000001', 'nin',
   decode(repeat('ab', 32), 'hex'), repeat('c1', 32), 'k1', '****8901', true, '2026-10-01 08:00:00+00', 'qoreid',
   '8001', 'a5180500-0000-4000-8000-000000000001', null, null),
  ('a5180600-0000-4000-8000-000000000002', 'a5180400-0000-4000-8000-000000000002', 'nin',
   decode(repeat('ab', 32), 'hex'), repeat('c2', 32), 'k1', '****8902', true, '2026-10-02 08:00:00+00', 'qoreid',
   '8002', 'a5180500-0000-4000-8000-000000000002', '2026-10-03 08:00:00+00', 'Synthetic: the NIN was revoked'),
  ('a5180600-0000-4000-8000-000000000003', 'a5180400-0000-4000-8000-000000000003', 'nin',
   decode(repeat('ab', 32), 'hex'), repeat('c3', 32), 'k1', '****8903', true, '2026-10-04 08:00:00+00', 'qoreid',
   '8003', 'a5180500-0000-4000-8000-000000000003', null, null);
set local session_replication_role = origin;

-- The holder read, word for word as NinRegistrationService.readNinHolder sends it: $1 the NIN lookup HMAC.
create function pg_temp.desk_nin_holder(char(64))
returns table (patient_id text, first_name text, last_name text, dob text, gender text,
  verification_provider text, verification_reference text, verified_at timestamptz)
language sql stable as $$
  select patient.id::text as patient_id, patient.first_name, patient.last_name, patient.dob::text as dob,
                patient.gender, identifier.verification_provider, identifier.verification_reference,
                identifier.verified_at
           from identity.patient_identifiers identifier
           join identity.patients patient on patient.id = identifier.patient_id
          where identifier.identifier_type = 'nin'
            and identifier.lookup_hmac = $1
            and identifier.verified
            and identifier.revoked_at is null
            and patient.status = 'active'
          limit 1
$$;

create temporary table holder_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
grant select, insert on pg_temp.holder_outcomes to hid_identity_api_runtime;
grant usage on sequence pg_temp.holder_outcomes_seq_seq to hid_identity_api_runtime;

-- Runs a read as member n at the facility (Identity's transaction context);
-- answers its row as text, 'none' for no row, or the SQLSTATE and message.
create function pg_temp.holder_as(n integer, lookup text) returns text language plpgsql as $f$
declare outcome text;
begin
  set local role hid_identity_api_runtime;
  perform set_config('app.actor_subject', 'synthetic:holder-member-' || n, true),
    set_config('app.facility_id', 'a5180000-0000-4000-8000-000000000002', true),
    set_config('app.correlation_id', 'holder-suite-' || n, true),
    set_config('app.membership_id', 'a5180300-0000-4000-8000-00000000000' || n, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
  begin
    select coalesce(string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', held.patient_id, held.first_name, held.last_name,
        held.dob, coalesce(held.gender, '-'), held.verification_provider, held.verification_reference,
        to_char(held.verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), ','), 'none')
      into outcome
      from pg_temp.desk_nin_holder(lookup::char(64)) held;
  exception when others then
    outcome := sqlstate || ' ' || sqlerrm;
  end;
  reset role;
  return outcome;
end $f$;
create function pg_temp.holder_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.holder_outcomes (name, expected, actual) values (case_name, expected, actual)
$f$;

-- The holder read.
select pg_temp.holder_case('1a the desk reads the active patient holding the checked NIN, with its evidence',
  'a5180400-0000-4000-8000-000000000001|Ada|Holder|1991-04-05|female|qoreid|8001|2026-10-01T08:00:00Z',
  pg_temp.holder_as(1, repeat('c1', 32)));
select pg_temp.holder_case('1b a revoked NIN has no holder', 'none', pg_temp.holder_as(1, repeat('c2', 32)));
select pg_temp.holder_case('1c an inactive patient is no holder', 'none', pg_temp.holder_as(1, repeat('c3', 32)));
select pg_temp.holder_case('1d an unknown NIN has no holder', 'none', pg_temp.holder_as(1, repeat('c9', 32)));
select pg_temp.holder_case('1e a member without identity.registration.write reads no holder', 'none',
  pg_temp.holder_as(2, repeat('c1', 32)));

-- The seal read, word for word as NinRegistrationService.sealedTenant sends it: $1 the facility, $2 the account.
-- Members of the sealed demo (98a5180...) and QA (a1a5180...) tenants, fictional ids; the real ones are this
-- suite's own clinic and receptionist. Rolled back with the rest.
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('facility', '98a51800-0000-4000-8000-000000000002'), ('account', '98a51801-0000-4000-8000-000000000001');
insert into identity.sealed_qa_members (member_kind, member_id) values
  ('facility', 'a1a51800-0000-4000-8000-000000000002'), ('account', 'a1a51801-0000-4000-8000-000000000001');
create function pg_temp.desk_sealed_tenant(uuid, uuid)
returns boolean
language sql stable as $$
  select coalesce(identity.sealed_demo_facility($1::uuid)
           or identity.sealed_qa_facility($1::uuid)
           or $2::uuid = any(identity.sealed_demo_ids('account'))
           or $2::uuid = any(identity.sealed_qa_ids('account')), false) as sealed
$$;
-- Runs the seal read as Identity's runtime role in the desk's context; its answer as text, or the SQLSTATE.
create function pg_temp.sealed_as(facility uuid, account uuid) returns text language plpgsql as $f$
declare outcome text;
begin
  set local role hid_identity_api_runtime;
  perform set_config('app.actor_subject', 'synthetic:holder-member-1', true),
    set_config('app.facility_id', coalesce(facility::text, ''), true),
    set_config('app.correlation_id', 'holder-suite-sealed', true),
    set_config('app.membership_id', 'a5180300-0000-4000-8000-000000000001', true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
  begin
    outcome := coalesce(pg_temp.desk_sealed_tenant(facility, account)::text, 'null');
  exception when others then
    outcome := sqlstate || ' ' || sqlerrm;
  end;
  reset role;
  return outcome;
end $f$;
create function pg_temp.sealed_members_as() returns text language plpgsql as $f$
declare outcome text;
begin
  set local role hid_identity_api_runtime;
  begin
    perform count(*) from identity.sealed_demo_members;
    outcome := 'read';
  exception when others then
    outcome := sqlstate || ' ' || sqlerrm;
  end;
  reset role;
  return outcome;
end $f$;
select pg_temp.holder_case('2a a real facility and a real account are not sealed', 'false',
  pg_temp.sealed_as('a5180000-0000-4000-8000-000000000002', 'a5180100-0000-4000-8000-000000000001'));
select pg_temp.holder_case('2b a sealed demo facility is sealed', 'true',
  pg_temp.sealed_as('98a51800-0000-4000-8000-000000000002', 'a5180100-0000-4000-8000-000000000001'));
select pg_temp.holder_case('2c a sealed QA facility is sealed', 'true',
  pg_temp.sealed_as('a1a51800-0000-4000-8000-000000000002', 'a5180100-0000-4000-8000-000000000001'));
select pg_temp.holder_case('2d a sealed demo account is sealed, whatever the facility', 'true',
  pg_temp.sealed_as('a5180000-0000-4000-8000-000000000002', '98a51801-0000-4000-8000-000000000001'));
select pg_temp.holder_case('2e a sealed QA account is sealed, whatever the facility', 'true',
  pg_temp.sealed_as('a5180000-0000-4000-8000-000000000002', 'a1a51801-0000-4000-8000-000000000001'));
select pg_temp.holder_case('2f null ids are not sealed', 'false', pg_temp.sealed_as(null, null));
select pg_temp.holder_case('2g Identity''s runtime still cannot read the members themselves',
  '42501 permission denied for table sealed_demo_members', pg_temp.sealed_members_as());

-- Result.
do $$
declare
  failed text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, coalesce(actual, 'null')), E'\n' order by seq)
    into failed
    from pg_temp.holder_outcomes
   where actual is distinct from expected;
  if failed is not null then
    raise exception E'desk NIN holder suite failed:\n%', failed;
  end if;
  raise notice 'desk NIN holder suite: % cases passed', (select count(*) from pg_temp.holder_outcomes);
end $$;

rollback;
