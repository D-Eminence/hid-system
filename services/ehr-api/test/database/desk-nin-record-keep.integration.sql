\set ON_ERROR_STOP on
-- Q108 desk NIN check, D2 (Q110, no migration): the registration desk keeps
-- a stored record its details matched for 90 days from that match
-- (services/identity-api/src/identity/desk-nin-record-keep.ts) through 0137's
-- own commands, in one transaction, as Identity's runtime in the system
-- context:
--   1. identity.begin_qoreid_nin_check with the real key version: the stored
--      record, its row locked;
--   2. the same begin with the key version 'desk-keep-matched-record': 0137
--      hands this attempt the row ("another key version is taken over");
--   3. identity.finish_qoreid_nin_check: the same ciphertext, the same
--      completeness, the real key version, 90 days (7776000 seconds).
-- Anything else rolls the keep back. Cases: a record kept 24 hours is kept
-- 90 days with its ciphertext and key unchanged; an incomplete record stays
-- incomplete; a stored "no record", a check another attempt is running, a
-- hold, a record under another key version and a NIN with no row are left
-- exactly as they were (no lease is left behind). Rollback-only. Synthetic
-- values only; lookups b1-b7.
begin;

-- The rows, as 0137 leaves them (written as their owner's superuser, past row-level security).
insert into identity.qoreid_nin_checks (nin_lookup_hmac, state, attempt_id, question_hmac, outcome, record_complete,
  answer_ciphertext, key_version, until) values
  (repeat('b1', 32), 'answered', gen_random_uuid(), null, 'record', true, decode(repeat('c1', 40), 'hex'), 'k1',
   clock_timestamp() + interval '20 hours'),
  (repeat('b2', 32), 'answered', gen_random_uuid(), null, 'record', false, decode(repeat('c2', 40), 'hex'), 'k1',
   clock_timestamp() + interval '20 hours'),
  (repeat('b3', 32), 'answered', gen_random_uuid(), null, 'no_record', null, decode(repeat('c3', 40), 'hex'), 'k1',
   clock_timestamp() + interval '20 hours'),
  (repeat('b4', 32), 'checking', gen_random_uuid(), null, null, null, null, null,
   clock_timestamp() + interval '2 minutes'),
  (repeat('b5', 32), 'held', gen_random_uuid(), null, null, null, null, null,
   clock_timestamp() + interval '5 minutes'),
  (repeat('b6', 32), 'answered', gen_random_uuid(), null, 'record', true, decode(repeat('c6', 40), 'hex'), 'k0',
   clock_timestamp() + interval '20 hours');

create temporary table keep_before on commit drop as
  select nin_lookup_hmac, state, attempt_id, question_hmac, outcome, record_complete, answer_ciphertext, key_version,
         until, updated_at
    from identity.qoreid_nin_checks where nin_lookup_hmac like 'b%';
create temporary table keep_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;

-- The desk's keep, statement for statement, as Identity's runtime in the system context. Answers 'kept', or
-- 'nothing: <decision> <outcome>' after rolling back whatever the statements did.
create function pg_temp.desk_keep(lookup char(64), key_version text) returns text language plpgsql as $f$
declare
  stored record;
  taken record;
  recorded boolean;
  attempt uuid := gen_random_uuid();
  outcome text;
begin
  set local role hid_identity_runtime;
  perform set_config('app.actor_subject', 'system:auth', true),
    set_config('app.correlation_id', 'desk-keep-suite', true);
  begin
    select * into stored from identity.begin_qoreid_nin_check(lookup, null, false, key_version, gen_random_uuid(), 30);
    if stored.decision is distinct from 'stored' or stored.outcome is distinct from 'record'
       or stored.record_complete is null or stored.answer_ciphertext is null then
      raise exception using errcode = 'P0001',
        message = format('nothing: %s %s', stored.decision, coalesce(stored.outcome, '-'));
    end if;
    select * into taken from identity.begin_qoreid_nin_check(lookup, null, false, 'desk-keep-matched-record',
      attempt, 30);
    if taken.decision is distinct from 'call' then
      raise exception using errcode = 'P0001', message = format('nothing: take-over %s', taken.decision);
    end if;
    select identity.finish_qoreid_nin_check(lookup, attempt, 'record', null, stored.record_complete,
      stored.answer_ciphertext, key_version, 7776000) into recorded;
    if recorded is not true then
      raise exception using errcode = 'P0001', message = 'nothing: not recorded';
    end if;
    outcome := 'kept';
  exception when sqlstate 'P0001' then
    outcome := sqlerrm;
  end;
  reset role;
  return outcome;
end $f$;

create function pg_temp.keep_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.keep_outcomes (name, expected, actual) values (case_name, expected, actual)
$f$;

-- The row as it is now, compared with what it was.
create function pg_temp.keep_row(lookup char(64)) returns text language sql as $f$
  select coalesce((
    select format('%s %s complete=%s same-ciphertext=%s key=%s question=%s until=%s',
      now_row.state, coalesce(now_row.outcome, '-'), coalesce(now_row.record_complete::text, '-'),
      (now_row.answer_ciphertext is not distinct from before_row.answer_ciphertext)::text,
      coalesce(now_row.key_version, '-'),
      coalesce(now_row.question_hmac, '-'),
      case when now_row.until between clock_timestamp() + interval '90 days' - interval '1 minute'
                                  and clock_timestamp() + interval '90 days' then '90 days'
           when now_row.until = before_row.until then 'unchanged'
           else now_row.until::text end)
      from identity.qoreid_nin_checks now_row
      left join pg_temp.keep_before before_row on before_row.nin_lookup_hmac = now_row.nin_lookup_hmac
     where now_row.nin_lookup_hmac = lookup), 'no row')
$f$;

select pg_temp.keep_case('1 a complete record kept 24 hours: kept', 'kept', pg_temp.desk_keep(repeat('b1', 32), 'k1'));
select pg_temp.keep_case('1 ... for 90 days, the same answer under the same key',
  'answered record complete=true same-ciphertext=true key=k1 question=- until=90 days', pg_temp.keep_row(repeat('b1', 32)));
select pg_temp.keep_case('2 an incomplete record: kept', 'kept', pg_temp.desk_keep(repeat('b2', 32), 'k1'));
select pg_temp.keep_case('2 ... still incomplete',
  'answered record complete=false same-ciphertext=true key=k1 question=- until=90 days', pg_temp.keep_row(repeat('b2', 32)));
select pg_temp.keep_case('3 a stored "no record": nothing', 'nothing: stored no_record',
  pg_temp.desk_keep(repeat('b3', 32), 'k1'));
select pg_temp.keep_case('3 ... left as it was',
  'answered no_record complete=- same-ciphertext=true key=k1 question=- until=unchanged', pg_temp.keep_row(repeat('b3', 32)));
select pg_temp.keep_case('4 another attempt is checking the NIN: nothing', 'nothing: wait -',
  pg_temp.desk_keep(repeat('b4', 32), 'k1'));
select pg_temp.keep_case('4 ... its lease left as it was',
  'checking - complete=- same-ciphertext=true key=- question=- until=unchanged', pg_temp.keep_row(repeat('b4', 32)));
select pg_temp.keep_case('5 a held NIN: nothing', 'nothing: held -', pg_temp.desk_keep(repeat('b5', 32), 'k1'));
select pg_temp.keep_case('5 ... still held as it was',
  'held - complete=- same-ciphertext=true key=- question=- until=unchanged', pg_temp.keep_row(repeat('b5', 32)));
select pg_temp.keep_case('6 a record under another key version: nothing', 'nothing: call -',
  pg_temp.desk_keep(repeat('b6', 32), 'k1'));
select pg_temp.keep_case('6 ... left as it was',
  'answered record complete=true same-ciphertext=true key=k0 question=- until=unchanged', pg_temp.keep_row(repeat('b6', 32)));
select pg_temp.keep_case('7 a NIN with no row: nothing', 'nothing: call -', pg_temp.desk_keep(repeat('b7', 32), 'k1'));
select pg_temp.keep_case('7 ... and no lease left behind', 'no row', pg_temp.keep_row(repeat('b7', 32)));

-- Result.
do $$
declare
  failed text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, coalesce(actual, 'null')), E'\n' order by seq)
    into failed
    from pg_temp.keep_outcomes
   where actual is distinct from expected;
  if failed is not null then
    raise exception E'desk NIN record keep suite failed:\n%', failed;
  end if;
  raise notice 'desk NIN record keep suite: % cases passed', (select count(*) from pg_temp.keep_outcomes);
end $$;

rollback;
