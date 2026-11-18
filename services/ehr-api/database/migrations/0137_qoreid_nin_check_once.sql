-- 0137: ask QoreID about a NIN once (owner decisions of 18 November 2026,
-- Q109). QoreID charges every NIN check, answered or not, and on 28 October
-- 2026 one person shows two verified checks in the owner's QoreID logs, both
-- charged. The owner asked for no new limit on staff, facilities or Health ID
-- ("demand might be high in production") but for the same NIN never to be
-- checked again while HID has, or is getting, its answer. Booked as 0137;
-- 0128-0136 are booked by other branches and this file reads nothing they add.
-- This file requires 0001-0127 applied.
--
-- 1. identity.qoreid_nin_checks: one row per NIN, keyed by the NIN lookup
--    HMAC the enrollments already use (NIN_LOOKUP_HMAC_KEY); never the NIN.
--    state 'checking': one attempt holds the check (attempt_id) until
--      `until` (its lease, long enough for QoreID's slowest answer HID still
--      reads); every other attempt for the NIN waits for it instead of
--      calling QoreID. No database connection or lock is held while QoreID
--      answers: the lease is a row, written and committed in its own short
--      transaction. A lease that ends without an outcome (the attempt was
--      stopped, or could not record what QoreID said) means QoreID was asked
--      and probably charged: the next begin turns it into a 6-hour hold.
--    state 'held': the last check was sent and brought no answer HID could
--      keep (an error QoreID may have charged: a few minutes; no answer at
--      all: hours), so a new check of the NIN is refused until `until`
--      instead of being paid again.
--    state 'answered': QoreID's answer, AES-256-GCM ciphertext under
--      Identity's NIN encryption key (key_version), reused by every path until
--      `until`: a record for 30 days (24 hours when a profile check did not
--      match it), "no record", QoreID's "not found" or an answer HID cannot
--      use for 24 hours. A record answers every question; another outcome
--      answers the question it was asked (question_hmac, an HMAC of the
--      details a profile check sent) or, asked with the NIN alone (null),
--      every question.
-- 2. Three SECURITY DEFINER commands for the Identity runtime (system:auth
--    with a correlation id only): identity.begin_qoreid_nin_check (the stored
--    answer, "wait", "held", or the lease to call QoreID), identity.
--    finish_qoreid_nin_check (the holder records the answer, the hold, or
--    lets go; never keeps an answer for a NIN whose patient's login was
--    deleted) and identity.prune_qoreid_nin_checks (erases rows past `until`
--    through the index on `until`, and the answers for the NINs of patients
--    whose login deletion (0096) completed in the last day, found from those
--    deletions, never by testing every row; Identity's patient lifecycle
--    sweeper calls it every tick). begin never returns an answer for such a
--    NIN.
--
-- No existing table, function, policy or grant changes; the new table has no
-- foreign key and no trigger on an existing table, so applying it takes no
-- lock on any existing table. Old Identity images call none of the new
-- commands. Production releases apply migrations only and never re-run
-- runtime-grants.sql, so the grants are made here, for each runtime role that
-- exists, and in runtime-grants.sql, which grants exactly the same.

-- 0. Preconditions (catalog reads only; 55000, nothing applied).
do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  if to_regclass('identity.qoreid_nin_checks') is not null
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'identity'
                   and proc.proname in ('begin_qoreid_nin_check', 'finish_qoreid_nin_check',
                                        'prune_qoreid_nin_checks', 'qoreid_nin_check_erased')) then
    raise exception using errcode = '55000', message = '0137: already applied';
  end if;
  -- 0127 (single sign-on, the last migration this file follows) and the
  -- tables the erasure test reads.
  if to_regclass('auth.session_single_sign_on') is null
     or to_regprocedure('auth.guard_session_single_sign_on_change()') is null
     or to_regclass('identity.patient_identifiers') is null
     or to_regclass('identity.patients') is null
     or to_regclass('auth.accounts') is null
     or to_regclass('identity.patient_account_deletion_requests') is null then
    raise exception using errcode = '55000', message = '0137: 0001-0127 must be applied first';
  end if;
  -- The columns the erasure test reads, with the types 0002, 0051 and 0096 gave them.
  select string_agg(format('%s.%s %s', expected.relation_name, expected.column_name,
           coalesce(actual.type_name, 'missing')), '; ')
    into mismatch
    from (values
      ('identity.patient_identifiers', 'lookup_hmac', 'character(64)'),
      ('identity.patient_identifiers', 'identifier_type', 'text'),
      ('identity.patient_identifiers', 'patient_id', 'uuid'),
      ('identity.patients', 'id', 'uuid'),
      ('identity.patients', 'account_id', 'uuid'),
      ('auth.accounts', 'id', 'uuid'),
      ('auth.accounts', 'status', 'text'),
      ('identity.patient_account_deletion_requests', 'patient_id', 'uuid'),
      ('identity.patient_account_deletion_requests', 'state', 'text'),
      ('identity.patient_account_deletion_requests', 'completed_at', 'timestamp with time zone'))
         expected(relation_name, column_name, type_name)
    left join lateral (
      select format_type(attribute.atttypid, attribute.atttypmod) as type_name
        from pg_attribute attribute
       where attribute.attrelid = to_regclass(expected.relation_name)
         and attribute.attname = expected.column_name and not attribute.attisdropped) actual on true
   where actual.type_name is distinct from expected.type_name;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0137: a column this migration reads differs: %s', mismatch);
  end if;
  -- 'deleted' is the login status 0096's completion sets.
  if not exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'auth.accounts'::regclass and constraint_row.contype = 'c'
                    and pg_get_constraintdef(constraint_row.oid) like '%''deleted''::text%') then
    raise exception using errcode = '55000', message = '0137: auth.accounts has no deleted status (0096)';
  end if;
  -- The request context readers the commands call, as 0001-0127 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0137: a function this migration relies on has another body than 0001-0127 gave it: %s', mismatch);
  end if;
  -- The applying role owns the new objects and reads, as their owner, the
  -- two tables with row-level security the erasure test reads (never a
  -- superuser's bypass), and may read auth.accounts. The prune reads 0096's
  -- deletion requests as their owner too: that table forces row-level
  -- security, so its one policy must name the applying role.
  if applier is null
     or not pg_has_role(applier, (select relowner from pg_class
                                   where oid = 'identity.patient_account_deletion_requests'::regclass), 'USAGE')
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'identity.patient_account_deletion_requests'::regclass
                       and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                           = format('(CURRENT_USER = %L::name)', current_user))
     or not pg_has_role(applier, (select relowner from pg_class where oid = 'identity.patient_identifiers'::regclass), 'USAGE')
     or not pg_has_role(applier, (select relowner from pg_class where oid = 'identity.patients'::regclass), 'USAGE')
     or not has_table_privilege(applier, 'auth.accounts', 'SELECT')
     or exists (select 1 from pg_class where oid in ('identity.patient_identifiers'::regclass, 'identity.patients'::regclass)
                                         and relforcerowsecurity)
     or not has_schema_privilege(applier, 'identity', 'CREATE')
     or not has_function_privilege(applier, 'platform.current_actor_subject()', 'EXECUTE')
     or not has_function_privilege(applier, 'platform.current_correlation_id()', 'EXECUTE') then
    raise exception using errcode = '42501', message = '0137: the applying role cannot own and run these commands';
  end if;
end
$$;

-- 1. The table.
create table identity.qoreid_nin_checks (
  nin_lookup_hmac char(64) primary key check (nin_lookup_hmac ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('checking', 'held', 'answered')),
  attempt_id uuid not null,
  question_hmac char(64) check (question_hmac is null or question_hmac ~ '^[0-9a-f]{64}$'),
  outcome text check (outcome in ('record', 'no_record', 'rejected', 'unusable')),
  record_complete boolean,
  answer_ciphertext bytea check (answer_ciphertext is null or octet_length(answer_ciphertext) between 30 and 262144),
  key_version text check (key_version is null or length(key_version) between 1 and 64),
  until timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  -- An answer, and only an answer, has its outcome, ciphertext and key; a
  -- record says whether it is complete and answers every question.
  constraint qoreid_nin_checks_answer_ck check (
    (state = 'answered') = (outcome is not null)
    and (state = 'answered') = (answer_ciphertext is not null)
    and (state = 'answered') = (key_version is not null)
    and (outcome is not distinct from 'record') = (record_complete is not null)
    and (outcome is distinct from 'record' or question_hmac is null)),
  -- Never kept longer than a record's 30 days (and a day's margin).
  constraint qoreid_nin_checks_until_ck check (until <= updated_at + interval '31 days')
);
create index qoreid_nin_checks_until_idx on identity.qoreid_nin_checks (until);
comment on table identity.qoreid_nin_checks is
  'One QoreID NIN check per NIN lookup HMAC (0137, Q109): the attempt holding it, a hold after a timeout, or the encrypted answer every path reuses until it expires. Never the NIN.';

alter table identity.qoreid_nin_checks enable row level security;
alter table identity.qoreid_nin_checks force row level security;
do $$
begin
  execute format('create policy qoreid_nin_checks_owner on identity.qoreid_nin_checks '
    || 'for all using (current_user = %L) with check (current_user = %L)', current_user, current_user);
end
$$;
revoke all on identity.qoreid_nin_checks from public;

-- 2. The commands.

-- True when the NIN is bound to a patient whose login was deleted (0096's
-- completion): its stored answer is erased and never reused. To no role; the
-- commands below call it as their owner.
create function identity.qoreid_nin_check_erased(requested_lookup_hmac char(64))
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
      from identity.patient_identifiers identifier
      join identity.patients patient_row on patient_row.id = identifier.patient_id
      join auth.accounts account_row on account_row.id = patient_row.account_id
     where identifier.identifier_type = 'nin'
       and identifier.lookup_hmac = requested_lookup_hmac
       and account_row.status = 'deleted')
$$;
revoke all on function identity.qoreid_nin_check_erased(char) from public;

-- Starts one attempt's check of a NIN. decision:
--   'stored'  a usable answer (outcome, record_complete, answer_ciphertext);
--   'call'    this attempt now holds the lease and may ask QoreID once;
--   'wait'    another attempt holds it until `until`: ask again shortly;
--   'held'    the last check brought no answer HID could keep; no new
--             check until `until`. A lease that ended without an outcome
--             becomes such a hold, until 6 hours after the lease's end.
-- An answer is usable while unexpired, under the caller's key version, for a
-- NIN not erased, and: a record when complete or the caller does not need a
-- complete one; another outcome when asked with the NIN alone or for this
-- question. Anything else (expired, another question, an incomplete record
-- for a caller that needs a complete one, another key) is taken over.
create function identity.begin_qoreid_nin_check(
  requested_lookup_hmac char(64), requested_question_hmac char(64), requested_complete boolean,
  requested_key_version text, requested_attempt_id uuid, requested_lease_seconds integer)
returns table (decision text, outcome text, record_complete boolean, answer_ciphertext bytea, until timestamptz)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  check_row identity.qoreid_nin_checks%rowtype;
  lease_end timestamptz;
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'QOREID_NIN_CHECK_DENIED';
  end if;
  if requested_lookup_hmac is null or requested_lookup_hmac !~ '^[0-9a-f]{64}$'
     or (requested_question_hmac is not null and requested_question_hmac !~ '^[0-9a-f]{64}$')
     or requested_complete is null or requested_attempt_id is null
     or requested_key_version is null or length(requested_key_version) not between 1 and 64
     or requested_lease_seconds is null or requested_lease_seconds not between 5 and 300 then
    raise exception using errcode = '22023', message = 'QOREID_NIN_CHECK_INVALID';
  end if;
  lease_end := clock_timestamp() + make_interval(secs => requested_lease_seconds);
  -- A first check of the NIN takes the lease at once. A concurrent insert of
  -- the same NIN waits for this one's commit and then finds its row.
  insert into identity.qoreid_nin_checks (nin_lookup_hmac, state, attempt_id, question_hmac, until)
  values (requested_lookup_hmac, 'checking', requested_attempt_id, requested_question_hmac, lease_end)
  on conflict (nin_lookup_hmac) do nothing;
  if found then
    return query select 'call'::text, null::text, null::boolean, null::bytea, lease_end;
    return;
  end if;
  select * into check_row from identity.qoreid_nin_checks where nin_lookup_hmac = requested_lookup_hmac for update;
  if not found then
    -- Erased between the insert and this read: the next call starts afresh.
    return query select 'wait'::text, null::text, null::boolean, null::bytea, clock_timestamp();
    return;
  end if;
  -- QoreID was asked under this lease and nothing was recorded: it probably
  -- charged, so the NIN is held, not checked again at once.
  if check_row.state = 'checking' and check_row.until <= clock_timestamp()
     and check_row.until + interval '6 hours' > clock_timestamp() then
    update identity.qoreid_nin_checks
       set state = 'held', until = check_row.until + interval '6 hours', updated_at = clock_timestamp()
     where nin_lookup_hmac = requested_lookup_hmac;
    return query select 'held'::text, null::text, null::boolean, null::bytea, check_row.until + interval '6 hours';
    return;
  end if;
  if check_row.until > clock_timestamp() then
    if check_row.state = 'checking' then
      return query select 'wait'::text, null::text, null::boolean, null::bytea, check_row.until;
      return;
    end if;
    if check_row.state = 'held' then
      return query select 'held'::text, null::text, null::boolean, null::bytea, check_row.until;
      return;
    end if;
    if check_row.key_version = requested_key_version
       and not identity.qoreid_nin_check_erased(requested_lookup_hmac)
       and ((check_row.outcome = 'record' and (check_row.record_complete or not requested_complete))
            or (check_row.outcome <> 'record'
                and (check_row.question_hmac is null or check_row.question_hmac = requested_question_hmac))) then
      return query select 'stored'::text, check_row.outcome, check_row.record_complete,
        check_row.answer_ciphertext, check_row.until;
      return;
    end if;
  end if;
  update identity.qoreid_nin_checks
     set state = 'checking', attempt_id = requested_attempt_id, question_hmac = requested_question_hmac,
         outcome = null, record_complete = null, answer_ciphertext = null, key_version = null,
         until = lease_end, updated_at = clock_timestamp()
   where nin_lookup_hmac = requested_lookup_hmac;
  return query select 'call'::text, null::text, null::boolean, null::bytea, lease_end;
end
$$;
revoke all on function identity.begin_qoreid_nin_check(char, char, boolean, text, uuid, integer) from public;

-- The holder of the lease records what came of its check, and only while it
-- still holds it (another attempt that took over an expired lease wins):
--   'record', 'no_record', 'rejected', 'unusable'  the answer, kept
--     requested_seconds (a record at most 31 days, the others at most 7
--     days); never kept for a NIN whose patient's login was deleted (the
--     holder's row is removed instead);
--   'held'      sent with no answer HID could keep: no new check for
--     requested_seconds (at most a day);
--   'released'  nothing reached QoreID's check (the token request failed,
--     the connection could not be opened, QoreID's 401 or 429): nothing is
--     kept.
-- True when recorded.
create function identity.finish_qoreid_nin_check(
  requested_lookup_hmac char(64), requested_attempt_id uuid, requested_result text,
  requested_question_hmac char(64), requested_complete boolean, requested_ciphertext bytea,
  requested_key_version text, requested_seconds integer)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'QOREID_NIN_CHECK_DENIED';
  end if;
  if requested_lookup_hmac is null or requested_lookup_hmac !~ '^[0-9a-f]{64}$' or requested_attempt_id is null
     or requested_result is null
     or requested_result not in ('record', 'no_record', 'rejected', 'unusable', 'held', 'released')
     or (requested_question_hmac is not null and requested_question_hmac !~ '^[0-9a-f]{64}$')
     or (requested_result in ('record', 'no_record', 'rejected', 'unusable') and (
           requested_ciphertext is null or requested_key_version is null
           or (requested_result = 'record') <> (requested_complete is not null)
           or requested_seconds is null
           or requested_seconds not between 60 and
              case when requested_result = 'record' then 31 * 86400 else 7 * 86400 end))
     or (requested_result = 'held' and (requested_seconds is null or requested_seconds not between 1 and 86400)) then
    raise exception using errcode = '22023', message = 'QOREID_NIN_CHECK_INVALID';
  end if;
  if requested_result = 'released' then
    delete from identity.qoreid_nin_checks
     where nin_lookup_hmac = requested_lookup_hmac and attempt_id = requested_attempt_id and state = 'checking';
    return found;
  end if;
  if requested_result = 'held' then
    update identity.qoreid_nin_checks
       set state = 'held', until = clock_timestamp() + make_interval(secs => requested_seconds),
           updated_at = clock_timestamp()
     where nin_lookup_hmac = requested_lookup_hmac and attempt_id = requested_attempt_id and state = 'checking';
    return found;
  end if;
  if identity.qoreid_nin_check_erased(requested_lookup_hmac) then
    delete from identity.qoreid_nin_checks
     where nin_lookup_hmac = requested_lookup_hmac and attempt_id = requested_attempt_id and state = 'checking';
    return false;
  end if;
  update identity.qoreid_nin_checks
     set state = 'answered', outcome = requested_result,
         question_hmac = case when requested_result = 'record' then null else requested_question_hmac end,
         record_complete = case when requested_result = 'record' then requested_complete end,
         answer_ciphertext = requested_ciphertext, key_version = requested_key_version,
         until = clock_timestamp() + make_interval(secs => requested_seconds), updated_at = clock_timestamp()
   where nin_lookup_hmac = requested_lookup_hmac and attempt_id = requested_attempt_id and state = 'checking';
  return found;
end
$$;
revoke all on function identity.finish_qoreid_nin_check(char, uuid, text, char, boolean, bytea, text, integer) from public;

-- Erases up to requested_limit rows past `until` (an expired answer or hold,
-- or a lease that ended more than 6 hours ago), found through the index on
-- `until`, and up to requested_limit
-- answers for the NINs of patients whose login deletion (0096) completed in
-- the last day, found from those deletion requests (few) through the NIN
-- identifiers and this table's primary key: no row is tested on every tick.
-- An answer kept before the deletion is erased within a minute of it; begin
-- never returns, and finish never keeps, an answer for such a NIN, so one
-- missed while the sweeper was stopped is never used and expires. The
-- sweeper's; rows another transaction holds are left for the next tick.
create function identity.prune_qoreid_nin_checks(requested_limit integer)
returns integer
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  removed integer;
  erased integer;
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'QOREID_NIN_CHECK_DENIED';
  end if;
  if requested_limit is null or requested_limit not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'QOREID_NIN_CHECK_INVALID';
  end if;
  delete from identity.qoreid_nin_checks check_row
   where check_row.nin_lookup_hmac in (
     select candidate.nin_lookup_hmac
       from identity.qoreid_nin_checks candidate
      where candidate.until <= clock_timestamp()
        -- A lease that ended without an outcome stands as a hold (begin's
        -- 6 hours after its end) until then: never pruned into a free check.
        and (candidate.state <> 'checking' or candidate.until <= clock_timestamp() - interval '6 hours')
      order by candidate.until
      limit requested_limit
      for update skip locked);
  get diagnostics removed = row_count;
  delete from identity.qoreid_nin_checks check_row
   where check_row.nin_lookup_hmac in (
     select candidate.nin_lookup_hmac
       from identity.patient_account_deletion_requests request_row
       join identity.patient_identifiers identifier
         on identifier.patient_id = request_row.patient_id and identifier.identifier_type = 'nin'
       join identity.qoreid_nin_checks candidate
         on candidate.nin_lookup_hmac = identifier.lookup_hmac and candidate.state = 'answered'
      where request_row.state = 'completed'
        and request_row.completed_at > clock_timestamp() - interval '1 day'
        and identity.qoreid_nin_check_erased(candidate.nin_lookup_hmac)
      limit requested_limit
      for update of candidate skip locked);
  get diagnostics erased = row_count;
  return removed + erased;
end
$$;
revoke all on function identity.prune_qoreid_nin_checks(integer) from public;

-- 3. Grants (here and in runtime-grants.sql): the three commands to the
-- Identity runtime and the schema test runtime; nothing to any other runtime;
-- no grant on the table or the erasure test.
do $$
declare runtime_role text;
begin
  foreach runtime_role in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function identity.begin_qoreid_nin_check(char, char, boolean, text, uuid, integer), '
        || 'identity.finish_qoreid_nin_check(char, uuid, text, char, boolean, bytea, text, integer), '
        || 'identity.prune_qoreid_nin_checks(integer) to %I', runtime_role);
    end if;
  end loop;
end
$$;

-- 4. Post-checks: the applying role owns everything new; row-level security
-- is forced with the one owner policy; the table's ACL holds only its owner;
-- every function is SECURITY DEFINER with this search_path; and only the two
-- runtimes above may execute the three commands (nobody the erasure test).
do $$
declare offender text;
begin
  if (select relowner from pg_class where oid = 'identity.qoreid_nin_checks'::regclass)
       <> (select oid from pg_roles where rolname = current_user)
     or not exists (select 1 from pg_class where oid = 'identity.qoreid_nin_checks'::regclass
                     and relrowsecurity and relforcerowsecurity)
     or (select count(*) from pg_policy where polrelid = 'identity.qoreid_nin_checks'::regclass) <> 1 then
    raise exception using errcode = '55000', message = '0137: the table is not as created';
  end if;
  select string_agg(coalesce(grantee.rolname, 'PUBLIC') || ' ' || privilege.privilege_type, ', ') into offender
    from pg_class table_row
   cross join aclexplode(coalesce(table_row.relacl, acldefault('r', table_row.relowner))) privilege
    left join pg_roles grantee on grantee.oid = privilege.grantee
   where table_row.oid = 'identity.qoreid_nin_checks'::regclass and privilege.grantee <> table_row.relowner;
  if offender is not null then
    raise exception using errcode = '55000', message = format('0137: a role holds a privilege on the table: %s', offender);
  end if;
  select string_agg(proc.oid::regprocedure::text, ', ') into offender
    from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
   where namespace.nspname = 'identity'
     and proc.proname in ('begin_qoreid_nin_check', 'finish_qoreid_nin_check', 'prune_qoreid_nin_checks',
                          'qoreid_nin_check_erased')
     and (not proc.prosecdef or proc.proowner <> (select oid from pg_roles where rolname = current_user)
          or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']);
  if offender is not null then
    raise exception using errcode = '55000', message = format('0137: a function is not as created: %s', offender);
  end if;
  select string_agg(format('%s %s', coalesce(grantee.rolname, 'PUBLIC'), proc.oid::regprocedure), ', ') into offender
    from pg_proc proc
    join pg_namespace namespace on namespace.oid = proc.pronamespace
   cross join aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
    left join pg_roles grantee on grantee.oid = privilege.grantee
   where namespace.nspname = 'identity'
     and proc.proname in ('begin_qoreid_nin_check', 'finish_qoreid_nin_check', 'prune_qoreid_nin_checks',
                          'qoreid_nin_check_erased')
     and privilege.grantee <> proc.proowner
     and not (grantee.rolname in ('hid_identity_runtime', 'hid_schema_test_runtime')
              and proc.proname <> 'qoreid_nin_check_erased');
  if offender is not null then
    raise exception using errcode = '55000', message = format('0137: a role may execute a function it must not: %s', offender);
  end if;
end
$$;
