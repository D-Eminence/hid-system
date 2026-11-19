\set ON_ERROR_STOP on
-- Q108 desk NIN check review (no migration): the two reads the registration
-- desk now makes before it asks the NIN service, word for word as
-- NinRegistrationService sends them (qoreid-nin-desk.spec.ts checks that),
-- run under row-level security as Identity's runtime role in the context
-- Identity's transactions set. Rollback-only. Fictional people, places and
-- identifiers only; ids start a5180.
--
--   1. readNinHolder (Q110): the active patient who holds the NIN verified
--      and not revoked, with the name, date of birth (as text), sex and that
--      check's provider, reference and time; nothing for a revoked NIN, an
--      inactive patient or an unknown NIN; nothing for a member without
--      identity.registration.write.
--   2. assertNotHeldForMismatches (privacy hold): a keyed auth.otp_rate_limits
--      row blocked until later is read with its end; one whose block ended,
--      one never blocked and an unknown bucket read nothing.
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
-- Hold buckets: d1 blocked for a day; d2 whose block ended; d3 counted, never blocked.
insert into auth.otp_rate_limits (scope, bucket_hmac, window_started_at, request_count, blocked_until, updated_at)
values
  ('account', repeat('d1', 32), clock_timestamp() - interval '1 hour', 10, clock_timestamp() + interval '1 day',
   clock_timestamp()),
  ('account', repeat('d2', 32), clock_timestamp() - interval '2 days', 10, clock_timestamp() - interval '1 hour',
   clock_timestamp()),
  ('account', repeat('d3', 32), clock_timestamp() - interval '1 hour', 3, null, clock_timestamp());
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

-- The hold read, word for word as NinRegistrationService.assertNotHeldForMismatches sends it: $1 the bucket.
create function pg_temp.desk_nin_hold(char(64))
returns table (blocked_until timestamptz)
language sql stable as $$
  select blocked_until from auth.otp_rate_limits
            where scope = 'account' and bucket_hmac = $1 and blocked_until > clock_timestamp()
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
create function pg_temp.hold_as(n integer, bucket text) returns text language plpgsql as $f$
declare outcome text;
begin
  set local role hid_identity_api_runtime;
  perform set_config('app.actor_subject', 'synthetic:holder-member-' || n, true),
    set_config('app.facility_id', 'a5180000-0000-4000-8000-000000000002', true),
    set_config('app.correlation_id', 'holder-suite-hold-' || n, true),
    set_config('app.membership_id', 'a5180300-0000-4000-8000-00000000000' || n, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
  begin
    select coalesce(string_agg(case when hold.blocked_until > clock_timestamp() + interval '23 hours'
        then 'held about a day' else 'held ' || hold.blocked_until::text end, ','), 'none')
      into outcome
      from pg_temp.desk_nin_hold(bucket::char(64)) hold;
  exception when others then
    outcome := sqlstate || ' ' || sqlerrm;
  end;
  reset role;
  return outcome;
end $f$;
create function pg_temp.holder_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.holder_outcomes (name, expected, actual) values (case_name, expected, actual)
$f$;

-- 1. The holder read.
select pg_temp.holder_case('1a the desk reads the active patient holding the checked NIN, with its evidence',
  'a5180400-0000-4000-8000-000000000001|Ada|Holder|1991-04-05|female|qoreid|8001|2026-10-01T08:00:00Z',
  pg_temp.holder_as(1, repeat('c1', 32)));
select pg_temp.holder_case('1b a revoked NIN has no holder', 'none', pg_temp.holder_as(1, repeat('c2', 32)));
select pg_temp.holder_case('1c an inactive patient is no holder', 'none', pg_temp.holder_as(1, repeat('c3', 32)));
select pg_temp.holder_case('1d an unknown NIN has no holder', 'none', pg_temp.holder_as(1, repeat('c9', 32)));
select pg_temp.holder_case('1e a member without identity.registration.write reads no holder', 'none',
  pg_temp.holder_as(2, repeat('c1', 32)));

-- 2. The hold read.
select pg_temp.holder_case('2a a bucket blocked for a day is held, with its end', 'held about a day',
  pg_temp.hold_as(1, repeat('d1', 32)));
select pg_temp.holder_case('2b a bucket whose block ended is not held', 'none', pg_temp.hold_as(1, repeat('d2', 32)));
select pg_temp.holder_case('2c a counted bucket never blocked is not held', 'none', pg_temp.hold_as(1, repeat('d3', 32)));
select pg_temp.holder_case('2d an unknown bucket is not held', 'none', pg_temp.hold_as(1, repeat('d9', 32)));

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
