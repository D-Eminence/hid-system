\set ON_ERROR_STOP on
-- QoreID NIN checks asked once per NIN (0137, Q109). Covers: the boundary
-- (no role reads or writes the table; the four commands to the Identity and
-- schema test runtimes only; the erasure test to no role; row-level security
-- forced); the system context and argument checks; the lease (the first
-- attempt calls, a second waits, the lease's end lets another take over); the
-- holder alone records an outcome; a record reused by every question, with
-- its source; an incomplete profile record taken over by a caller that needs
-- a complete one, an incomplete NIN-only record answered to it from storage;
-- "no record" for the question asked and, asked with the NIN alone, for every
-- question; QoreID's "not found" for every question, whichever check got it;
-- an answer HID cannot use, kept and reused like "no record"; Q115's rule (a
-- record 90 days from the first check and at least 30 days from each later
-- use, through begin or the keep; never shorter, nothing else changed; only a
-- live record under the caller's key, never an erased one; the rule itself to
-- no role); a
-- hold (up to a day) and its end; a lease that ended without an outcome held
-- for 6 hours after its end, and one older than that taken over; letting go;
-- expiry; another key version; the table's checks; erasure for a NIN bound to
-- a patient whose login was deleted (begin never returns it, finish never
-- keeps it, prune erases the answer kept before a deletion completed in the
-- last day, without testing other rows); the prune's limits and what it
-- leaves. Two simultaneous begins on separate connections are proved by
-- services/identity-api/scripts/verify-nin-check-once-runtime.mjs.
-- Rollback-only. Synthetic values only; uuid prefix 137a.
begin;

-- The boundary.
do $$
declare offender text;
begin
  select string_agg(format('%s %s', role_row.rolname, privilege.name), ', ') into offender
    from pg_roles role_row
   cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege(name)
   where role_row.rolname like 'hid\_%' and not role_row.rolsuper
     and not pg_has_role(role_row.oid, (select relowner from pg_class
                                         where oid = 'identity.qoreid_nin_checks'::regclass), 'USAGE')
     and has_table_privilege(role_row.oid, 'identity.qoreid_nin_checks', privilege.name);
  if offender is not null then
    raise exception 'A runtime role holds a privilege on identity.qoreid_nin_checks: %', offender;
  end if;
  if not exists (select 1 from pg_class where oid = 'identity.qoreid_nin_checks'::regclass
                  and relrowsecurity and relforcerowsecurity) then
    raise exception 'Row-level security is not forced on identity.qoreid_nin_checks';
  end if;
  select string_agg(format('%s %s', role_row.rolname, proc.oid::regprocedure), ', ') into offender
    from pg_roles role_row cross join pg_proc proc
   where role_row.rolname like 'hid\_%' and not role_row.rolsuper
     and not pg_has_role(role_row.oid, proc.proowner, 'USAGE')
     and proc.oid in ('identity.begin_qoreid_nin_check(char,char,boolean,text,uuid,integer)'::regprocedure,
                      'identity.finish_qoreid_nin_check(char,uuid,text,char,boolean,bytea,text,integer)'::regprocedure,
                      'identity.keep_qoreid_nin_record(char,text)'::regprocedure,
                      'identity.prune_qoreid_nin_checks(integer)'::regprocedure)
     and has_function_privilege(role_row.oid, proc.oid, 'EXECUTE')
     and role_row.rolname not in ('hid_identity_runtime', 'hid_identity_api_runtime', 'hid_schema_test_runtime');
  if offender is not null then
    raise exception 'A role other than the Identity runtimes may run a NIN check command: %', offender;
  end if;
  if not has_function_privilege('hid_identity_runtime',
         'identity.begin_qoreid_nin_check(char,char,boolean,text,uuid,integer)', 'EXECUTE')
     or not has_function_privilege('hid_identity_runtime',
         'identity.finish_qoreid_nin_check(char,uuid,text,char,boolean,bytea,text,integer)', 'EXECUTE')
     or not has_function_privilege('hid_identity_runtime', 'identity.keep_qoreid_nin_record(char,text)', 'EXECUTE')
     or not has_function_privilege('hid_identity_runtime', 'identity.prune_qoreid_nin_checks(integer)', 'EXECUTE')
     or not has_function_privilege('hid_schema_test_runtime', 'identity.prune_qoreid_nin_checks(integer)', 'EXECUTE') then
    raise exception 'The Identity runtime cannot run the NIN check commands';
  end if;
  select string_agg(role_row.rolname, ', ') into offender
    from pg_roles role_row
   where role_row.rolname like 'hid\_%' and not role_row.rolsuper
     and not pg_has_role(role_row.oid, (select proowner from pg_proc
                                         where oid = 'identity.qoreid_nin_check_erased(char)'::regprocedure), 'USAGE')
     and has_function_privilege(role_row.oid, 'identity.qoreid_nin_check_erased(char)', 'EXECUTE');
  if offender is not null then
    raise exception 'A runtime role may run the erasure test: %', offender;
  end if;
  select string_agg(role_row.rolname, ', ') into offender
    from pg_roles role_row
   where role_row.rolname like 'hid\_%' and not role_row.rolsuper
     and not pg_has_role(role_row.oid, (select proowner from pg_proc
                                         where oid = 'identity.qoreid_nin_record_used(char,text)'::regprocedure), 'USAGE')
     and has_function_privilege(role_row.oid, 'identity.qoreid_nin_record_used(char,text)', 'EXECUTE');
  if offender is not null then
    raise exception 'A runtime role may run the Q115 rule itself: %', offender;
  end if;
  if has_function_privilege('public', 'identity.begin_qoreid_nin_check(char,char,boolean,text,uuid,integer)', 'EXECUTE') then
    raise exception 'PUBLIC may run begin_qoreid_nin_check';
  end if;
end
$$;

-- A patient whose login will be deleted, holding the NIN of lookup 'e...e'
-- (constraints and triggers off for the fixture only: its registration case
-- is not part of this suite).
set local session_replication_role = replica;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('137a0000-0000-4000-8000-000000000001', 'synthetic:nin-check-once:1', 'nin-check-once-1@example.invalid',
   'NIN Check Once', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('137a0000-0000-4000-8000-000000000002', '137a0000-0000-4000-8000-000000000001', 'HID-NCK3A2', 'Nin', 'Once',
   'Nin Once', 'active');
insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
  encryption_key_version, display_hint, verified, verified_at, verification_provider, verification_reference,
  registration_case_id) values
  ('137a0000-0000-4000-8000-000000000003', '137a0000-0000-4000-8000-000000000002', 'nin',
   decode(repeat('ab', 32), 'hex'), repeat('e', 64), 'k1', '****0001', true, clock_timestamp(), 'qoreid', '7001',
   '137a0000-0000-4000-8000-000000000004');
-- A second such patient, holding NIN 'k', whose NIN is held (not answered) when the login is deleted.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('137a0000-0000-4000-8000-000000000011', 'synthetic:nin-check-once:2', 'nin-check-once-2@example.invalid',
   'NIN Check Twice', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('137a0000-0000-4000-8000-000000000012', '137a0000-0000-4000-8000-000000000011', 'HID-NCK3B2', 'Nin', 'Twice',
   'Nin Twice', 'active');
insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
  encryption_key_version, display_hint, verified, verified_at, verification_provider, verification_reference,
  registration_case_id) values
  ('137a0000-0000-4000-8000-000000000013', '137a0000-0000-4000-8000-000000000012', 'nin',
   decode(repeat('ab', 32), 'hex'), repeat('0', 63) || '5', 'k1', '****0002', true, clock_timestamp(), 'qoreid',
   '7002', '137a0000-0000-4000-8000-000000000014');
set local session_replication_role = origin;

-- Results of the steps below, read by the checks as the owner.
create temporary table nin_check_steps (step text primary key, value text) on commit drop;
grant select, insert on nin_check_steps to hid_identity_runtime;

set local role hid_identity_runtime;

-- Without the system context nothing runs.
do $$
begin
  perform identity.begin_qoreid_nin_check(repeat('a', 64), null, true, 'k1',
    '137a0000-0000-4000-8000-0000000000a1', 30);
  raise exception 'begin ran without the system context';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  perform identity.keep_qoreid_nin_record(repeat('a', 64), 'k1');
  raise exception 'keep ran without the system context';
exception when insufficient_privilege then null;
end
$$;
select set_config('app.actor_subject', 'system:auth', true), set_config('app.correlation_id', 'nin-check-once-suite', true);

-- Argument checks.
do $$
declare bad text[];
begin
  foreach bad slice 1 in array array[
    array['short', null, 'true', 'k1', '30'], array[repeat('a', 64), 'nothex', 'true', 'k1', '30'],
    array[repeat('a', 64), null, 'true', '', '30'], array[repeat('a', 64), null, 'true', 'k1', '4'],
    array[repeat('a', 64), null, 'true', 'k1', '301']] loop
    begin
      perform identity.begin_qoreid_nin_check(bad[1], bad[2], bad[3]::boolean, bad[4],
        '137a0000-0000-4000-8000-0000000000a1', bad[5]::integer);
      raise exception 'begin accepted %', bad;
    exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform identity.finish_qoreid_nin_check(repeat('a', 64), '137a0000-0000-4000-8000-0000000000a1', 'record',
      null, true, decode(repeat('ab', 32), 'hex'), 'k1', 92 * 86400);
    raise exception 'finish kept a record past 91 days';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.finish_qoreid_nin_check(repeat('a', 64), '137a0000-0000-4000-8000-0000000000a1', 'no_record',
      null, null, decode(repeat('ab', 32), 'hex'), 'k1', 8 * 86400);
    raise exception 'finish kept "no record" past 7 days';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.finish_qoreid_nin_check(repeat('a', 64), '137a0000-0000-4000-8000-0000000000a1', 'record',
      null, null, decode(repeat('ab', 32), 'hex'), 'k1', 3600);
    raise exception 'finish kept a record without saying whether it is complete';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.finish_qoreid_nin_check(repeat('a', 64), '137a0000-0000-4000-8000-0000000000a1', 'held',
      null, null, null, null, 2 * 86400);
    raise exception 'finish held a NIN for two days';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.finish_qoreid_nin_check(repeat('a', 64), '137a0000-0000-4000-8000-0000000000a1', 'unusable',
      null, null, decode(repeat('ab', 32), 'hex'), 'k1', 8 * 86400);
    raise exception 'finish kept an unusable answer past 7 days';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.finish_qoreid_nin_check(repeat('a', 64), '137a0000-0000-4000-8000-0000000000a1', 'unusable',
      null, true, decode(repeat('ab', 32), 'hex'), 'k1', 86400);
    raise exception 'finish kept an unusable answer as a complete record';
  exception when invalid_parameter_value then null;
  end;
  foreach bad slice 1 in array array[array['short', 'k1'], array[repeat('a', 64), ''], array[repeat('a', 64), null],
    array[null, 'k1']] loop
    begin
      perform identity.keep_qoreid_nin_record(bad[1], bad[2]);
      raise exception 'keep accepted %', bad;
    exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform identity.prune_qoreid_nin_checks(0);
    raise exception 'prune accepted a limit of 0';
  exception when invalid_parameter_value then null;
  end;
end
$$;

-- The lease: the first attempt calls, a second waits, a non-holder records nothing.
insert into nin_check_steps
select 'a first', decision from identity.begin_qoreid_nin_check(repeat('a', 64), null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000a1', 30);
insert into nin_check_steps
select 'a second', decision from identity.begin_qoreid_nin_check(repeat('a', 64), null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000a2', 30);
insert into nin_check_steps
select 'a non-holder finish', identity.finish_qoreid_nin_check(repeat('a', 64), '137a0000-0000-4000-8000-0000000000a2',
  'record', null, true, decode(repeat('ab', 32), 'hex'), 'k1', 90 * 86400)::text;
insert into nin_check_steps
select 'a holder finish', identity.finish_qoreid_nin_check(repeat('a', 64), '137a0000-0000-4000-8000-0000000000a1',
  'record', null, true, decode(repeat('ab', 32), 'hex'), 'k1', 90 * 86400)::text;
insert into nin_check_steps
select 'a finish twice', identity.finish_qoreid_nin_check(repeat('a', 64), '137a0000-0000-4000-8000-0000000000a1',
  'record', null, true, decode(repeat('ab', 32), 'hex'), 'k1', 90 * 86400)::text;
-- A record answers every question and every caller, complete or not.
insert into nin_check_steps
select 'a stored', format('%s %s %s %s', decision, outcome, record_complete, encode(answer_ciphertext, 'hex') = repeat('ab', 32))
  from identity.begin_qoreid_nin_check(repeat('a', 64), repeat('1', 64), true, 'k1',
    '137a0000-0000-4000-8000-0000000000a3', 30);
-- Under another key version it is not reused.
insert into nin_check_steps
select 'a other key', decision from identity.begin_qoreid_nin_check(repeat('a', 64), null, true, 'k2',
  '137a0000-0000-4000-8000-0000000000a4', 30);

-- An incomplete record (from a profile check) serves a caller that does not
-- need a complete one, and is taken over by one that does.
insert into nin_check_steps
select 'b first', decision from identity.begin_qoreid_nin_check(repeat('b', 64), repeat('1', 64), false, 'k1',
  '137a0000-0000-4000-8000-0000000000b1', 30);
insert into nin_check_steps
select 'b finish', identity.finish_qoreid_nin_check(repeat('b', 64), '137a0000-0000-4000-8000-0000000000b1',
  'record', repeat('1', 64), false, decode(repeat('cd', 32), 'hex'), 'k1', 90 * 86400)::text;
insert into nin_check_steps
select 'b partial for profile', decision from identity.begin_qoreid_nin_check(repeat('b', 64), repeat('2', 64), false,
  'k1', '137a0000-0000-4000-8000-0000000000b2', 30);
insert into nin_check_steps
select 'b partial for enrollment', decision from identity.begin_qoreid_nin_check(repeat('b', 64), null, true,
  'k1', '137a0000-0000-4000-8000-0000000000b3', 30);
insert into nin_check_steps
select 'b complete finish', identity.finish_qoreid_nin_check(repeat('b', 64), '137a0000-0000-4000-8000-0000000000b3',
  'record', null, true, decode(repeat('cd', 32), 'hex'), 'k1', 90 * 86400)::text;

-- "No record" for a question answers that question only; asked with the NIN
-- alone, it answers every question.
insert into nin_check_steps
select 'c first', decision from identity.begin_qoreid_nin_check(repeat('c', 64), repeat('1', 64), false, 'k1',
  '137a0000-0000-4000-8000-0000000000c1', 30);
insert into nin_check_steps
select 'c finish', identity.finish_qoreid_nin_check(repeat('c', 64), '137a0000-0000-4000-8000-0000000000c1',
  'no_record', repeat('1', 64), null, decode(repeat('ef', 32), 'hex'), 'k1', 86400)::text;
insert into nin_check_steps
select 'c same question', format('%s %s', decision, outcome) from identity.begin_qoreid_nin_check(repeat('c', 64),
  repeat('1', 64), false, 'k1', '137a0000-0000-4000-8000-0000000000c2', 30);
insert into nin_check_steps
select 'c other question', decision from identity.begin_qoreid_nin_check(repeat('c', 64), repeat('2', 64), false,
  'k1', '137a0000-0000-4000-8000-0000000000c3', 30);
insert into nin_check_steps
select 'c nin only finish', identity.finish_qoreid_nin_check(repeat('c', 64), '137a0000-0000-4000-8000-0000000000c3',
  'rejected', null, null, decode(repeat('ef', 32), 'hex'), 'k1', 86400)::text;
insert into nin_check_steps
select 'c any question', format('%s %s', decision, outcome) from identity.begin_qoreid_nin_check(repeat('c', 64),
  repeat('3', 64), false, 'k1', '137a0000-0000-4000-8000-0000000000c4', 30);

-- A hold refuses new checks; letting go leaves nothing.
insert into nin_check_steps
select 'd first', decision from identity.begin_qoreid_nin_check(repeat('d', 64), null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000d1', 30);
insert into nin_check_steps
select 'd held', identity.finish_qoreid_nin_check(repeat('d', 64), '137a0000-0000-4000-8000-0000000000d1',
  'held', null, null, null, null, 120)::text;
insert into nin_check_steps
select 'd during hold', decision from identity.begin_qoreid_nin_check(repeat('d', 64), null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000d2', 30);
insert into nin_check_steps
select 'f first', decision from identity.begin_qoreid_nin_check(repeat('f', 64), null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000f1', 30);
insert into nin_check_steps
select 'f released', identity.finish_qoreid_nin_check(repeat('f', 64), '137a0000-0000-4000-8000-0000000000f1',
  'released', null, null, null, null, null)::text;

-- An answer HID cannot use ('g'), asked with the NIN alone, answers every question.
insert into nin_check_steps
select 'g first', decision from identity.begin_qoreid_nin_check(repeat('0', 63) || '1', null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000c5', 30);
insert into nin_check_steps
select 'g finish', identity.finish_qoreid_nin_check(repeat('0', 63) || '1', '137a0000-0000-4000-8000-0000000000c5',
  'unusable', null, null, decode(repeat('ef', 32), 'hex'), 'k1', 86400)::text;
insert into nin_check_steps
select 'g any question', format('%s %s', decision, outcome) from identity.begin_qoreid_nin_check(
  repeat('0', 63) || '1', repeat('4', 64), false, 'k1', '137a0000-0000-4000-8000-0000000000c6', 30);
insert into nin_check_steps
select 'g enrollment', format('%s %s', decision, outcome) from identity.begin_qoreid_nin_check(
  repeat('0', 63) || '1', null, true, 'k1', '137a0000-0000-4000-8000-0000000000c7', 30);
-- A hold of a day ('h'), the most finish allows.
insert into nin_check_steps
select 'h first', decision from identity.begin_qoreid_nin_check(repeat('0', 63) || '2', null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000d4', 30);
insert into nin_check_steps
select 'h held a day', identity.finish_qoreid_nin_check(repeat('0', 63) || '2', '137a0000-0000-4000-8000-0000000000d4',
  'held', null, null, null, null, 86400)::text;
-- Two leases that will end without an outcome ('i' just now, 'j' 7 hours ago).
insert into nin_check_steps
select 'i first', decision from identity.begin_qoreid_nin_check(repeat('0', 63) || '3', null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000d5', 30);
insert into nin_check_steps
select 'j first', decision from identity.begin_qoreid_nin_check(repeat('0', 63) || '4', null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000d6', 30);

-- NIN 'k' is held when its patient's login is deleted: the hold stays.
insert into nin_check_steps
select 'k first', decision from identity.begin_qoreid_nin_check(repeat('0', 63) || '5', null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000d0', 30);
insert into nin_check_steps
select 'k held', identity.finish_qoreid_nin_check(repeat('0', 63) || '5', '137a0000-0000-4000-8000-0000000000d0',
  'held', null, null, null, null, 3600)::text;

-- A NIN-only record without everything a sign-up needs ('m', as the desk or
-- a sign-up keeps it): every caller is answered from storage, one that needs
-- a complete record too (it refuses the record as the first caller did, and
-- QoreID is not paid again for the same answer).
insert into nin_check_steps
select 'm first', decision from identity.begin_qoreid_nin_check(repeat('0', 63) || '6', null, false, 'k1',
  '137a0000-0000-4000-8000-0000000000e4', 30);
insert into nin_check_steps
select 'm finish', identity.finish_qoreid_nin_check(repeat('0', 63) || '6', '137a0000-0000-4000-8000-0000000000e4',
  'record', null, false, decode(repeat('cd', 32), 'hex'), 'k1', 90 * 86400)::text;
insert into nin_check_steps
select 'm for enrollment', format('%s %s %s', decision, outcome, record_complete)
  from identity.begin_qoreid_nin_check(repeat('0', 63) || '6', null, true, 'k1',
    '137a0000-0000-4000-8000-0000000000e5', 30);
insert into nin_check_steps
select 'm for profile', format('%s %s %s', decision, outcome, record_complete)
  from identity.begin_qoreid_nin_check(repeat('0', 63) || '6', repeat('5', 64), false, 'k1',
    '137a0000-0000-4000-8000-0000000000e6', 30);

-- QoreID's "not found" (404) that a profile check got ('p') is about the NIN:
-- kept for every question, it answers a sign-up and another profile check.
insert into nin_check_steps
select 'p first', decision from identity.begin_qoreid_nin_check(repeat('0', 63) || '7', repeat('1', 64), false,
  'k1', '137a0000-0000-4000-8000-0000000000e7', 30);
insert into nin_check_steps
select 'p finish', identity.finish_qoreid_nin_check(repeat('0', 63) || '7', '137a0000-0000-4000-8000-0000000000e7',
  'rejected', repeat('1', 64), null, decode(repeat('ef', 32), 'hex'), 'k1', 86400)::text;
insert into nin_check_steps
select 'p for enrollment', format('%s %s', decision, outcome) from identity.begin_qoreid_nin_check(
  repeat('0', 63) || '7', null, true, 'k1', '137a0000-0000-4000-8000-0000000000e8', 30);
insert into nin_check_steps
select 'p other question', format('%s %s', decision, outcome) from identity.begin_qoreid_nin_check(
  repeat('0', 63) || '7', repeat('2', 64), false, 'k1', '137a0000-0000-4000-8000-0000000000e9', 30);

-- Q115 ('q', a profile check's incomplete record first kept 24 hours): each
-- later use keeps it at least 30 days from that use, through begin (a check
-- answered from storage) or the keep (the desk's matched record); a use never
-- shortens a keep; only a live record under the caller's key is kept.
insert into nin_check_steps
select 'q first', decision from identity.begin_qoreid_nin_check(repeat('0', 63) || '8', repeat('3', 64), false,
  'k1', '137a0000-0000-4000-8000-0000000000ea', 30);
insert into nin_check_steps
select 'q finish', identity.finish_qoreid_nin_check(repeat('0', 63) || '8', '137a0000-0000-4000-8000-0000000000ea',
  'record', repeat('3', 64), false, decode(repeat('cd', 32), 'hex'), 'k1', 86400)::text;
insert into nin_check_steps
select 'q used by a check', format('%s %s', decision,
  until between clock_timestamp() + interval '29 days 23 hours' and clock_timestamp() + interval '30 days')
  from identity.begin_qoreid_nin_check(repeat('0', 63) || '8', repeat('3', 64), false, 'k1',
    '137a0000-0000-4000-8000-0000000000eb', 30);
insert into nin_check_steps
select 'q keep', identity.keep_qoreid_nin_record(repeat('0', 63) || '8', 'k1')::text;
insert into nin_check_steps
select 'q keep other key', identity.keep_qoreid_nin_record(repeat('0', 63) || '8', 'k2')::text;
insert into nin_check_steps
select 'q keep not a record', identity.keep_qoreid_nin_record(repeat('c', 64), 'k1')::text;
insert into nin_check_steps
select 'q keep a hold', identity.keep_qoreid_nin_record(repeat('d', 64), 'k1')::text;
insert into nin_check_steps
select 'q keep a running check', identity.keep_qoreid_nin_record(repeat('0', 63) || '3', 'k1')::text;
insert into nin_check_steps
select 'q keep nothing', identity.keep_qoreid_nin_record(repeat('9', 64), 'k1')::text;
-- A use of a record kept 90 days from its first check ('m', used twice
-- above) does not shorten it; nor does a keep.
insert into nin_check_steps
select 'm keep', identity.keep_qoreid_nin_record(repeat('0', 63) || '6', 'k1')::text;

-- The erased NIN ('e'): answered, then its patient's login is deleted.
insert into nin_check_steps
select 'e first', decision from identity.begin_qoreid_nin_check(repeat('e', 64), null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000e1', 30);
insert into nin_check_steps
select 'e finish', identity.finish_qoreid_nin_check(repeat('e', 64), '137a0000-0000-4000-8000-0000000000e1',
  'record', null, true, decode(repeat('ab', 32), 'hex'), 'k1', 90 * 86400)::text;
insert into nin_check_steps
select 'e stored before deletion', decision from identity.begin_qoreid_nin_check(repeat('e', 64), null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000e2', 30);
reset role;

do $$
declare
  expected text[][] := array[
    array['a first', 'call'], array['a second', 'wait'], array['a non-holder finish', 'false'],
    array['a holder finish', 'true'], array['a finish twice', 'false'], array['a stored', 'stored record t t'],
    array['a other key', 'call'],
    array['b first', 'call'], array['b finish', 'true'], array['b partial for profile', 'stored'],
    array['b partial for enrollment', 'call'], array['b complete finish', 'true'],
    array['c first', 'call'], array['c finish', 'true'], array['c same question', 'stored no_record'],
    array['c other question', 'call'], array['c nin only finish', 'true'], array['c any question', 'stored rejected'],
    array['d first', 'call'], array['d held', 'true'], array['d during hold', 'held'],
    array['f first', 'call'], array['f released', 'true'],
    array['g first', 'call'], array['g finish', 'true'], array['g any question', 'stored unusable'],
    array['g enrollment', 'stored unusable'], array['h first', 'call'], array['h held a day', 'true'],
    array['i first', 'call'], array['j first', 'call'], array['k first', 'call'], array['k held', 'true'],
    array['m first', 'call'], array['m finish', 'true'], array['m for enrollment', 'stored record f'],
    array['m for profile', 'stored record f'],
    array['p first', 'call'], array['p finish', 'true'], array['p for enrollment', 'stored rejected'],
    array['p other question', 'stored rejected'],
    array['q first', 'call'], array['q finish', 'true'], array['q used by a check', 'stored t'],
    array['q keep', 'true'], array['m keep', 'true'],
    array['q keep other key', 'false'], array['q keep not a record', 'false'], array['q keep a hold', 'false'],
    array['q keep a running check', 'false'], array['q keep nothing', 'false'],
    array['e first', 'call'], array['e finish', 'true'], array['e stored before deletion', 'stored']];
  pair text[];
  actual text;
begin
  foreach pair slice 1 in array expected loop
    select value into actual from nin_check_steps where step = pair[1];
    if actual is distinct from pair[2] then
      raise exception 'Step "%": expected %, got %', pair[1], pair[2], coalesce(actual, 'nothing');
    end if;
  end loop;
  if exists (select 1 from identity.qoreid_nin_checks where nin_lookup_hmac = repeat('f', 64)) then
    raise exception 'A released check left its row';
  end if;
  -- The stored rows hold no NIN-shaped value, and no question for a record
  -- or QoreID's "not found".
  if exists (select 1 from identity.qoreid_nin_checks
              where (outcome in ('record', 'rejected') and question_hmac is not null)
                 or encode(answer_ciphertext, 'escape') ~ '[0-9]{11}') then
    raise exception 'A stored check is not as recorded';
  end if;
  -- Each record's source is the check's: 'b' was last answered by the NIN
  -- alone, 'm' too; 'q' by a profile check, which the keep left as it was.
  select string_agg(format('%s %s %s', right(nin_lookup_hmac, 1), record_source, record_complete), ', '
           order by nin_lookup_hmac) into actual
    from identity.qoreid_nin_checks
   where nin_lookup_hmac in (repeat('b', 64), repeat('0', 63) || '6', repeat('0', 63) || '8');
  if actual is distinct from '6 nin_only f, 8 profile f, b nin_only t' then
    raise exception 'The records'' sources are %', actual;
  end if;
  -- Q115: 'q' (kept a day at first) is kept 30 days from its last use, the
  -- answer as it was; 'm' (kept 90 days from its first check) still is,
  -- after two uses and a keep.
  if not exists (select 1 from identity.qoreid_nin_checks
                  where nin_lookup_hmac = repeat('0', 63) || '8'
                    and until between clock_timestamp() + interval '29 days 23 hours'
                                  and clock_timestamp() + interval '30 days'
                    and answer_ciphertext = decode(repeat('cd', 32), 'hex') and outcome = 'record') then
    raise exception 'A use did not keep the record 30 days, unchanged';
  end if;
  if not exists (select 1 from identity.qoreid_nin_checks
                  where nin_lookup_hmac = repeat('0', 63) || '6'
                    and until > clock_timestamp() + interval '89 days 23 hours') then
    raise exception 'A use shortened a record kept 90 days from its first check';
  end if;
end
$$;

-- The table's own checks, as its owner.
do $$
begin
  begin
    insert into identity.qoreid_nin_checks (nin_lookup_hmac, state, attempt_id, until)
    values (repeat('9', 64), 'answered', gen_random_uuid(), clock_timestamp() + interval '1 day');
    raise exception 'an answer without its outcome was stored';
  exception when check_violation then null;
  end;
  begin
    insert into identity.qoreid_nin_checks (nin_lookup_hmac, state, attempt_id, outcome, record_complete,
      answer_ciphertext, key_version, question_hmac, until)
    values (repeat('9', 64), 'answered', gen_random_uuid(), 'record', true, decode(repeat('ab', 32), 'hex'), 'k1',
      repeat('1', 64), clock_timestamp() + interval '1 day');
    raise exception 'a record was tied to one question';
  exception when check_violation then null;
  end;
  begin
    insert into identity.qoreid_nin_checks (nin_lookup_hmac, state, attempt_id, until)
    values (repeat('9', 64), 'held', gen_random_uuid(), clock_timestamp() + interval '100 days');
    raise exception 'a row was kept past 91 days';
  exception when check_violation then null;
  end;
  begin
    insert into identity.qoreid_nin_checks (nin_lookup_hmac, state, attempt_id, until)
    values ('70000000001', 'checking', gen_random_uuid(), clock_timestamp());
    raise exception 'a NIN was stored as the key';
  exception when check_violation or string_data_right_truncation then null;
  end;
end
$$;

-- Time passes (as the owner): the hold on 'd' ends, 'b' does not; the lease
-- on 'i' has just ended without an outcome, the ones on 'a' (taken under
-- another key above) and 'j' 7 hours ago.
update identity.qoreid_nin_checks set until = clock_timestamp() - interval '1 second'
 where nin_lookup_hmac in (repeat('d', 64), repeat('0', 63) || '3');
update identity.qoreid_nin_checks set until = clock_timestamp() - interval '7 hours'
 where nin_lookup_hmac in (repeat('a', 64), repeat('0', 63) || '4');
-- The login of the patient holding NIN 'e' is deleted (0096's completion: the
-- login's status and its completed deletion request; fixture without triggers).
set local session_replication_role = replica;
update auth.accounts set status = 'deleted'
 where id in ('137a0000-0000-4000-8000-000000000001', '137a0000-0000-4000-8000-000000000011');
insert into identity.patient_account_deletion_requests (id, account_id, patient_id, requested_session_id, state,
  confirmation_token_sha256, confirmation_expires_at, confirmation_consumed_at, confirmed_at, waiting_period,
  scheduled_for, completed_at, correlation_id) values
  ('137a0000-0000-4000-8000-000000000005', '137a0000-0000-4000-8000-000000000001',
   '137a0000-0000-4000-8000-000000000002', '137a0000-0000-4000-8000-000000000006', 'completed', repeat('7', 64),
   clock_timestamp() + interval '1 hour', clock_timestamp(), clock_timestamp(), interval '0', clock_timestamp(),
   clock_timestamp(), 'nin-check-once-suite'),
  ('137a0000-0000-4000-8000-000000000015', '137a0000-0000-4000-8000-000000000011',
   '137a0000-0000-4000-8000-000000000012', '137a0000-0000-4000-8000-000000000016', 'completed', repeat('8', 64),
   clock_timestamp() + interval '1 hour', clock_timestamp(), clock_timestamp(), interval '0', clock_timestamp(),
   clock_timestamp(), 'nin-check-once-suite');
set local session_replication_role = origin;

set local role hid_identity_runtime;
select set_config('app.actor_subject', 'system:auth', true), set_config('app.correlation_id', 'nin-check-once-suite', true);
-- The erased NIN's answer is never kept longer.
insert into nin_check_steps
select 'e keep after deletion', identity.keep_qoreid_nin_record(repeat('e', 64), 'k1')::text;
-- One expired row by `until` and the erased answer for 'e' (each limited to 1).
insert into nin_check_steps select 'prune one', identity.prune_qoreid_nin_checks(1)::text;
insert into nin_check_steps select 'prune rest', identity.prune_qoreid_nin_checks(100)::text;
insert into nin_check_steps select 'prune again', identity.prune_qoreid_nin_checks(100)::text;
-- 'e' is checked again after the deletion, and its answer is not kept.
insert into nin_check_steps
select 'e after deletion', decision from identity.begin_qoreid_nin_check(repeat('e', 64), null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000e3', 30);
insert into nin_check_steps
select 'e refinish', identity.finish_qoreid_nin_check(repeat('e', 64), '137a0000-0000-4000-8000-0000000000e3',
  'record', null, true, decode(repeat('ab', 32), 'hex'), 'k1', 90 * 86400)::text;
insert into nin_check_steps
select 'd after hold', decision from identity.begin_qoreid_nin_check(repeat('d', 64), null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000d3', 30);
insert into nin_check_steps
select 'h during a day hold', decision from identity.begin_qoreid_nin_check(repeat('0', 63) || '2', null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000d7', 30);
insert into nin_check_steps
select 'i after its lease', format('%s %s', decision,
  until between clock_timestamp() + interval '5 hours 59 minutes' and clock_timestamp() + interval '6 hours')
  from identity.begin_qoreid_nin_check(repeat('0', 63) || '3', null, true, 'k1',
    '137a0000-0000-4000-8000-0000000000d8', 30);
insert into nin_check_steps
select 'i again', decision from identity.begin_qoreid_nin_check(repeat('0', 63) || '3', null, true, 'k1',
  '137a0000-0000-4000-8000-0000000000d9', 30);
insert into nin_check_steps
select 'i late finish', identity.finish_qoreid_nin_check(repeat('0', 63) || '3', '137a0000-0000-4000-8000-0000000000d5',
  'record', null, true, decode(repeat('ab', 32), 'hex'), 'k1', 90 * 86400)::text;
reset role;

do $$
declare
  expected text[][] := array[
    array['e keep after deletion', 'false'],
    array['prune one', '2'], array['prune rest', '2'], array['prune again', '0'],
    array['e after deletion', 'call'], array['e refinish', 'false'], array['d after hold', 'call'],
    array['h during a day hold', 'held'], array['i after its lease', 'held t'], array['i again', 'held'],
    array['i late finish', 'false']];
  pair text[];
  actual text;
begin
  foreach pair slice 1 in array expected loop
    select value into actual from nin_check_steps where step = pair[1];
    if actual is distinct from pair[2] then
      raise exception 'Step "%": expected %, got %', pair[1], pair[2], coalesce(actual, 'nothing');
    end if;
  end loop;
  -- 'a', 'd' and 'j' (expired) and 'e' (erased) were pruned; 'b', 'c' and
  -- 'g' (live answers) stay; 'd' is checking again; 'e' was not kept again;
  -- 'i' is held; the hold on 'k' (a deleted login's NIN) stays.
  if exists (select 1 from identity.qoreid_nin_checks where nin_lookup_hmac in (repeat('a', 64), repeat('e', 64),
               repeat('0', 63) || '4'))
     or (select count(*) from identity.qoreid_nin_checks
          where nin_lookup_hmac in (repeat('b', 64), repeat('c', 64), repeat('0', 63) || '1')
            and state = 'answered') <> 3
     or not exists (select 1 from identity.qoreid_nin_checks where nin_lookup_hmac = repeat('d', 64)
                     and state = 'checking')
     or not exists (select 1 from identity.qoreid_nin_checks where nin_lookup_hmac = repeat('0', 63) || '3'
                     and state = 'held')
     or not exists (select 1 from identity.qoreid_nin_checks where nin_lookup_hmac = repeat('0', 63) || '5'
                     and state = 'held') then
    raise exception 'The prune did not erase exactly the expired and erased rows';
  end if;
end
$$;

rollback;
