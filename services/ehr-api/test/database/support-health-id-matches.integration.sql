\set ON_ERROR_STOP on
-- Support chat Health ID check (0109): identity.support_health_id_matches.
-- Rollback-only. Fictional patients and Health IDs only.
--
-- Fixtures are inserted with session_replication_role = replica (no triggers
-- or foreign-key checks); every case then runs with triggers enforced, as the
-- exact runtime role (hid_identity_runtime, which identity-api's support
-- route uses), or as another runtime role to prove it is refused. Each case
-- records its outcome (the matches it answered, or the SQLSTATE and message
-- it raised) and the suite fails at the end listing every case whose outcome
-- differs.
begin;

-- 1. The function and its grant, as 0109 makes them.
do $$
begin
  if to_regprocedure('identity.support_health_id_matches(text[])') is null then
    raise exception 'identity.support_health_id_matches(text[]) is missing (0109)';
  end if;
  if exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid = 'identity.support_health_id_matches(text[])'::regprocedure
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime')) then
    raise exception 'the function is granted to more than hid_identity_runtime';
  end if;
end $$;

-- 2. Fixtures: one patient of each status, a 32-character Health ID and a
-- letters-only one (issued before the owner's 2026-10-31 decision).
set local session_replication_role = replica;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('5a990000-0109-4000-8000-000000000001', 'HID-SUP2A3', 'Support', 'Active', 'Support Active', 'active'),
  ('5a990000-0109-4000-8000-000000000002', 'HID-SUP4B5', 'Support', 'Inactive', 'Support Inactive', 'inactive'),
  ('5a990000-0109-4000-8000-000000000003', 'HID-SUP6C7', 'Support', 'Merged', 'Support Merged', 'merged'),
  ('5a990000-0109-4000-8000-000000000004', 'HID-SUP8D9', 'Support', 'Deceased', 'Support Deceased', 'deceased'),
  ('5a990000-0109-4000-8000-000000000005', 'HID-SUP2E3', 'Support', 'Deleted', 'Support Deleted', 'deleted'),
  ('5a990000-0109-4000-8000-000000000006', 'HID-ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 'Support', 'Long', 'Support Long', 'active'),
  ('5a990000-0109-4000-8000-000000000007', 'HID-SUPPRT', 'Support', 'Letters', 'Support Letters', 'active');
set local session_replication_role = origin;

create temporary table support_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;

-- Runs the check as run_as: its matches joined by commas ('none' for no
-- match), or the SQLSTATE and message it raised.
create function pg_temp.support_try(run_as text, candidates text[]) returns text language plpgsql as $$
declare outcome text;
begin
  execute format('set local role %I', run_as);
  begin
    select coalesce(string_agg(match.health_id, ',' order by match.health_id), 'none') into outcome
      from identity.support_health_id_matches(candidates) match;
  exception when others then
    outcome := sqlstate || ' ' || sqlerrm;
  end;
  reset role;
  return outcome;
end $$;
create function pg_temp.support_case(case_name text, run_as text, expected text, candidates text[])
returns void language plpgsql as $$
begin
  insert into pg_temp.support_cases (name, expected, actual)
  values (case_name, expected, pg_temp.support_try(run_as, candidates));
end $$;

-- 3. Matches.
select pg_temp.support_case('1a issued only, any order', 'hid_identity_runtime', 'HID-SUP2A3,HID-SUP4B5',
  array['HID-SUP4B5', 'HID-ZZ22ZZ', 'HID-SUP2A3']);
select pg_temp.support_case('1b each match once', 'hid_identity_runtime', 'HID-SUP2A3',
  array['HID-SUP2A3', 'HID-SUP2A3', 'HID-SUP2A3']);
select pg_temp.support_case('1c every status counts', 'hid_identity_runtime',
  'HID-SUP2A3,HID-SUP2E3,HID-SUP4B5,HID-SUP6C7,HID-SUP8D9',
  array['HID-SUP2A3', 'HID-SUP4B5', 'HID-SUP6C7', 'HID-SUP8D9', 'HID-SUP2E3']);
select pg_temp.support_case('1d 32 characters', 'hid_identity_runtime', 'HID-ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  array['HID-ABCDEFGHJKLMNPQRSTUVWXYZ23456789']);
select pg_temp.support_case('1e letters only (issued before 2026-10-31)', 'hid_identity_runtime', 'HID-SUPPRT',
  array['HID-SUPPRT', 'HID-SUPPRU']);
select pg_temp.support_case('1f no match is an empty answer', 'hid_identity_runtime', 'none',
  array['HID-ZZ22ZZ', 'HID-YY33YY']);
select pg_temp.support_case('1g 200 candidates', 'hid_identity_runtime', 'HID-SUP2A3',
  array(select 'HID-ZZ22Z' || chr(65 + n % 8) from generate_series(1, 199) n) || 'HID-SUP2A3'::text);

-- 4. Refusals: never "no match" for a request the check cannot read.
select pg_temp.support_case('2a no candidate', 'hid_identity_runtime',
  '22023 Support Health ID check: 1 to 200 candidates, each HID- and 6 to 32 Health ID characters', array[]::text[]);
select pg_temp.support_case('2b null', 'hid_identity_runtime',
  '22023 Support Health ID check: 1 to 200 candidates, each HID- and 6 to 32 Health ID characters', null);
select pg_temp.support_case('2c 201 candidates', 'hid_identity_runtime',
  '22023 Support Health ID check: 1 to 200 candidates, each HID- and 6 to 32 Health ID characters',
  array(select 'HID-SUP2A3' from generate_series(1, 201)));
select pg_temp.support_case('2d lower case', 'hid_identity_runtime',
  '22023 Support Health ID check: 1 to 200 candidates, each HID- and 6 to 32 Health ID characters', array['hid-sup2a3']);
select pg_temp.support_case('2e five characters', 'hid_identity_runtime',
  '22023 Support Health ID check: 1 to 200 candidates, each HID- and 6 to 32 Health ID characters', array['HID-SUP2A']);
select pg_temp.support_case('2f 33 characters', 'hid_identity_runtime',
  '22023 Support Health ID check: 1 to 200 candidates, each HID- and 6 to 32 Health ID characters',
  array['HID-ABCDEFGHJKLMNPQRSTUVWXYZ23456789A']);
select pg_temp.support_case('2g a letter outside the alphabet', 'hid_identity_runtime',
  '22023 Support Health ID check: 1 to 200 candidates, each HID- and 6 to 32 Health ID characters', array['HID-SUPO2I']);
select pg_temp.support_case('2h no prefix', 'hid_identity_runtime',
  '22023 Support Health ID check: 1 to 200 candidates, each HID- and 6 to 32 Health ID characters', array['SUP2A3']);
select pg_temp.support_case('2i a null among them', 'hid_identity_runtime',
  '22023 Support Health ID check: 1 to 200 candidates, each HID- and 6 to 32 Health ID characters',
  array['HID-SUP2A3', null]);
select pg_temp.support_case('2j a nested array', 'hid_identity_runtime',
  '22023 Support Health ID check: 1 to 200 candidates, each HID- and 6 to 32 Health ID characters',
  array[array['HID-SUP2A3'], array['HID-SUP4B5']]);
select pg_temp.support_case('2k a valid one beside a malformed one', 'hid_identity_runtime',
  '22023 Support Health ID check: 1 to 200 candidates, each HID- and 6 to 32 Health ID characters',
  array['HID-SUP2A3', 'HID-SUP2A3 and more']);

-- 5. Who may ask.
select pg_temp.support_case('3a the EHR runtime may not', 'hid_ehr_runtime',
  '42501 permission denied for function support_health_id_matches', array['HID-SUP2A3']);
select pg_temp.support_case('3b the Lab runtime may not', 'hid_lab_runtime',
  '42501 permission denied for function support_health_id_matches', array['HID-SUP2A3']);
select pg_temp.support_case('3c the OCR worker may not', 'hid_ocr_worker',
  '42501 permission denied for function support_health_id_matches', array['HID-SUP2A3']);

-- 6. The function is needed: Identity's runtime role, with no patient or
-- staff context, sees none of these patients through the table itself.
do $$
declare seen bigint;
begin
  set local role hid_identity_runtime;
  select count(*) into seen from identity.patients where id::text like '5a990000-0109-%';
  reset role;
  insert into pg_temp.support_cases (name, expected, actual)
  values ('4a no context reads no patient row', '0', seen::text);
end $$;

-- 7. Result.
do $$
declare
  failed text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, coalesce(actual, 'null')), E'\n' order by seq)
    into failed
    from pg_temp.support_cases
   where actual is distinct from expected;
  if failed is not null then
    raise exception E'support Health ID suite failed:\n%', failed;
  end if;
  raise notice 'support Health ID suite: % cases passed', (select count(*) from pg_temp.support_cases);
end $$;

rollback;
