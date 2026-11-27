\set ON_ERROR_STOP on
-- 0209 (CHW-1, owner decision Q130 A): the community health worker role, the
-- file itself, run as written (psql \ir) the way the runner runs it inside
-- its transaction. Rollback-only, apart from the dblink extension below. On a
-- migrated database 0209 has run already:
--   1. busy refusals, first, before this transaction locks any table: a
--      second session (dblink) writes auth.role_permissions (ROW EXCLUSIVE:
--      0209's SHARE ROW EXCLUSIVE cannot be had) or reads
--      identity.staff_invitations (ACCESS SHARE: 0209's ACCESS EXCLUSIVE
--      cannot be had), holds audit.events in SHARE mode, or holds
--      identity.staff_attestation_texts (each locked NOWAIT, not left to the
--      statement that uses it): 0209 tries for about 5 seconds (timed) and
--      refuses with 55P03 "0209: ... stayed busy for 5 seconds; nothing
--      applied; run the release again at a quieter time"; when this
--      transaction already holds another file's strong lock (SHARE or ACCESS
--      EXCLUSIVE) it refuses at once (timed: under a second; "... so it does
--      not wait; ..."). Both are the messages the runner's dry run retries,
--      and nothing is applied;
--   2. a second run answers "0209: already applied" (55000);
--   3. 0209 taken away for this transaction (its rows, role and audit rows;
--      the fence, the seven functions and the two checks back to 0001-0153's
--      text, each checked by md5 or text): the half states (the role alone,
--      the fence's rule alone, an audit row alone) and the preconditions (a
--      changed fence, its search_path, its trigger disabled, a fifth trigger,
--      a changed role function, one granted to PUBLIC or WITH GRANT OPTION,
--      the volunteer's codes changed or one inactive, the invitations table
--      owned by another role, a role check without a role of 0001-0153 or
--      letting a null in, a licence check starting with another role or
--      letting a doctor in without a licence, other lanes' roles that are a
--      role of 0001-0153, privileged, missing, dentist out of place, named by
--      a function but not the role check, or licensed in a no-licence list,
--      a changed organization_staff_kinds) refuse, nothing applied; a
--      licensed other lane's role named by the role check alone is accepted;
--   4. 0209 applies on 0001-0153's bodies within its declared locks, holding
--      every one of them: the role with exactly the volunteer's three codes,
--      no other role row changed, the fence and the seven functions as the
--      migrated database had them (md5) with owner, ACL, SECURITY DEFINER
--      and settings unchanged, the two checks, the 4 audit rows as the
--      system actor; everything but one piece (an audit row, the fence's
--      rule, a role row, a role function, the role check) is not "already
--      applied"; and answers "already applied" again;
--   5. on BILL-1's 0162 versions (cashier and billing_officer appended,
--      in/not in for the front desk; simulated here as 0162 makes them) and
--      with DEN-1's 0194 dentist after doctor (their roles active, as those
--      files add them), 0209 applies, keeps every other lane's role and
--      appends the community health worker last.
-- Synthetic values only.
set plpgsql.variable_conflict = error;

-- dblink is created before the transaction (creating it inside would lock its
-- result type at ACCESS EXCLUSIVE, which 0209 reads as "this transaction holds
-- an earlier migration's locks") and dropped again at the end.
select exists (select 1 from pg_available_extensions where name = 'dblink') as m209_dblink_available,
       not exists (select 1 from pg_extension where extname = 'dblink') as m209_dblink_create \gset
\if :m209_dblink_available
\if :m209_dblink_create
create extension dblink with schema public;
\endif
\endif

begin;

\set run0209 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../../database/migrations/0209_community_health_worker_role.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'

-- A case: stops the suite at once when it fails. (Functions only until 1 is
-- done: a temporary table or sequence would be a relation this transaction
-- holds at ACCESS EXCLUSIVE.)
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0209 community health worker migration suite failed: %: expected [%] got [%]', case_name,
      expected, coalesce(actual, 'null');
  end if;
  raise notice '0209 suite: % passed', case_name;
end
$$;
-- The runner's test for a file's own busy refusal (dry-run-attempts.mjs), or the answer.
create function pg_temp.answer(sqlstate text, message text) returns text language sql immutable as $$
  select case when sqlstate = '55P03' and message ~ '^0209: '
                   and message ~ '(so it does not wait|stayed busy for 5 seconds)(; nothing applied)?; run the release again at a quieter time$'
              then 'busy refusal: ' || substring(message from '(so it does not wait|stayed busy for 5 seconds)')
              when sqlstate = '00000' then 'applied'
              else sqlstate || ' ' || message end;
$$;
-- What 0209 makes, in one line.
create function pg_temp.made0209() returns text language sql as $$
  select (select count(*) from auth.roles where code = 'community_health_worker') || ' role, '
      || (select count(*) from auth.role_permissions where role_code = 'community_health_worker') || ' role rows, '
      || (select count(*) from audit.events where correlation_id = '0209-community-health-worker-role') || ' audit rows, '
      || (select count(*) from pg_proc where pronamespace = 'identity'::regnamespace
            and prosrc like '%''community_health_worker''%') || ' functions, '
      || (select count(*) from pg_constraint where conrelid = 'identity.staff_invitations'::regclass
            and conname in ('staff_invitations_role_code_check', 'staff_invitations_licence_ck')
            and pg_get_constraintdef(oid) like '%community_health_worker%') || ' checks';
$$;
-- The fence and the seven functions 0209 changes.
create function pg_temp.changed_functions() returns text[] language sql immutable as $$
  select array['identity.enforce_outreach_tenant_roles()', 'identity.staff_invitable_roles(text,text)',
    'identity.staff_invitation_fields_valid(text,text,text,text,text,text)',
    'identity.attach_invited_member(identity.staff_invitations,uuid,uuid,boolean)',
    'identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)',
    'identity.remove_facility_staff_role(uuid,bigint,text,text)',
    'identity.admin_add_facility_staff_role(uuid,uuid,bigint,text,text,text,text,text,text,character)',
    'identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character)'];
$$;
-- Their bodies (md5), and separately their owner, ACL, SECURITY DEFINER, volatility and settings, in that order.
create function pg_temp.bodies() returns text language sql as $$
  select string_agg(md5(proc.prosrc), ',' order by signature.n)
    from unnest(pg_temp.changed_functions()) with ordinality signature(name, n)
    join pg_proc proc on proc.oid = to_regprocedure(signature.name);
$$;
create function pg_temp.settings() returns text language sql as $$
  select string_agg(proc.proowner::text || ':' || coalesce(proc.proacl::text, '') || ':' || proc.prosecdef || ':'
                    || proc.provolatile::text || ':' || coalesce(proc.proconfig::text, ''), ',' order by signature.n)
    from unnest(pg_temp.changed_functions()) with ordinality signature(name, n)
    join pg_proc proc on proc.oid = to_regprocedure(signature.name);
$$;
create function pg_temp.checks() returns text language sql as $$
  select string_agg(pg_get_constraintdef(oid), ' | ' order by conname)
    from pg_constraint where conrelid = 'identity.staff_invitations'::regclass
     and conname in ('staff_invitations_role_code_check', 'staff_invitations_licence_ck');
$$;

-- 1. Busy refusals. Each run is timed: a busy refusal waits about 5 seconds (50 tries 100 ms apart) unless this
-- transaction holds an earlier file's lock, when it refuses at once. A lock 0209 did not take NOWAIT would wait for
-- lock_timeout instead (set here so that such a wait fails the case rather than hanging the suite).
\if :m209_dblink_available
set local lock_timeout = '8s';
-- How long since the time read before the run: 'waited' (at least 4.5 s), 'at once' (under 1 s), or the seconds.
create function pg_temp.elapsed(started double precision) returns text language sql as $$
  select case when extract(epoch from clock_timestamp()) - started >= 4.5 then 'waited'
              when extract(epoch from clock_timestamp()) - started < 1 then 'at once'
              else round((extract(epoch from clock_timestamp()) - started)::numeric, 1)::text || ' s' end;
$$;
select pg_temp.expect('1a this transaction holds no strong table lock yet', '0',
  (select count(*)::text from pg_locks held
    where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
      and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')));
select public.dblink_connect('m209_blocker',
  format('dbname=%s user=%s host=%s port=%s', quote_ident(current_database()), quote_ident(current_user),
         coalesce(nullif(btrim(split_part(current_setting('unix_socket_directories'), ',', 1)), ''), '127.0.0.1'),
         current_setting('port'))) as connected \gset
select pg_temp.made0209() as made_before_busy \gset
select public.dblink_exec('m209_blocker', 'begin') as began \gset
select public.dblink_exec('m209_blocker', 'lock table auth.role_permissions in row exclusive mode') as blocked \gset
select extract(epoch from clock_timestamp()) as started \gset
:run0209
select pg_temp.expect('1b auth.role_permissions written by another session: 0209 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | waited | ' || :'made_before_busy',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.elapsed(:started) || ' | '
  || pg_temp.made0209());
savepoint holding;
lock table ehr.catalog_versions in share mode;
select extract(epoch from clock_timestamp()) as started \gset
:run0209
select pg_temp.elapsed(:started) as elapsed_holding \gset
select pg_temp.made0209() as made_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1c the same while this transaction holds an earlier file''s lock: 0209 refuses at once',
  'busy refusal: so it does not wait | at once | ' || :'made_before_busy',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'elapsed_holding' || ' | '
  || :'made_holding');
savepoint holding;
lock table ehr.catalog_versions in access exclusive mode;
select extract(epoch from clock_timestamp()) as started \gset
:run0209
select pg_temp.elapsed(:started) as elapsed_holding \gset
select pg_temp.made0209() as made_holding \gset
rollback to savepoint holding;
select pg_temp.expect('1c2 the same while this transaction holds an earlier file''s ACCESS EXCLUSIVE lock: at once',
  'busy refusal: so it does not wait | at once | ' || :'made_before_busy',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || :'elapsed_holding' || ' | '
  || :'made_holding');
select public.dblink_exec('m209_blocker', 'rollback') as ended \gset
select public.dblink_exec('m209_blocker', 'begin') as began \gset
select public.dblink_exec('m209_blocker', 'lock table identity.staff_invitations in access share mode') as blocked \gset
select extract(epoch from clock_timestamp()) as started \gset
:run0209
select pg_temp.expect('1d identity.staff_invitations read by another session: 0209 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | waited | ' || :'made_before_busy',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.elapsed(:started) || ' | '
  || pg_temp.made0209());
select public.dblink_exec('m209_blocker', 'rollback') as ended \gset
-- The audit rows' table and the attestation texts are locked NOWAIT too (not left to the statements that use them).
select public.dblink_exec('m209_blocker', 'begin') as began \gset
select public.dblink_exec('m209_blocker', 'lock table audit.events in share mode') as blocked \gset
select extract(epoch from clock_timestamp()) as started \gset
:run0209
select pg_temp.expect('1e audit.events held in SHARE mode by another session: 0209 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | waited | ' || :'made_before_busy',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.elapsed(:started) || ' | '
  || pg_temp.made0209());
select public.dblink_exec('m209_blocker', 'rollback') as ended \gset
select public.dblink_exec('m209_blocker', 'begin') as began \gset
select public.dblink_exec('m209_blocker', 'lock table identity.staff_attestation_texts in access exclusive mode')
  as blocked \gset
select extract(epoch from clock_timestamp()) as started \gset
:run0209
select pg_temp.expect('1f identity.staff_attestation_texts held by another session: 0209 tries for 5 seconds, then refuses',
  'busy refusal: stayed busy for 5 seconds | waited | ' || :'made_before_busy',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.elapsed(:started) || ' | '
  || pg_temp.made0209());
select public.dblink_exec('m209_blocker', 'rollback') as ended \gset
select public.dblink_disconnect('m209_blocker') as disconnected \gset
\else
\echo '0209 suite: dblink is not available on this server, so 1 (the busy refusals) is skipped'
\endif

-- 2. Already applied.
select pg_temp.expect('2a the migrated database holds 0209',
  '1 role, 3 role rows, 4 audit rows, 8 functions, 2 checks', pg_temp.made0209());
:run0209
select pg_temp.expect('2b a second run: already applied, nothing changed',
  '55000 0209: already applied | 1 role, 3 role rows, 4 audit rows, 8 functions, 2 checks',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0209());
-- What the runner left, to compare with 4.
select pg_temp.bodies() as bodies_applied \gset
select pg_temp.settings() as settings_applied \gset
select pg_temp.checks() as checks_applied \gset

-- The locks 0209 adds, on tables that were there before it ran.
create temporary table locks_seen (label text, table_name text, mode text);
create function pg_temp.record_locks(label text) returns void language sql as $$
  insert into locks_seen
  select label, namespace.nspname || '.' || relation.relname, held.mode
    from pg_locks held
    join pg_class relation on relation.oid = held.relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
   where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
     and relation.relkind in ('r', 'p', 'v', 'm')
     and namespace.nspname not in ('pg_catalog', 'information_schema', 'migration')
     and namespace.nspname not like 'pg_temp%' and namespace.nspname not like 'pg_toast%';
$$;
create function pg_temp.lock_rank(mode text) returns integer language sql immutable as $$
  select array_position(array['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock',
    'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'], mode);
$$;
-- 0209's Locks paragraph.
create temporary table declared_locks (table_name text, mode text);
insert into declared_locks values
  ('auth.roles', 'ShareRowExclusiveLock'), ('auth.permissions', 'ShareRowExclusiveLock'),
  ('auth.role_permissions', 'ShareRowExclusiveLock'), ('identity.staff_invitations', 'AccessExclusiveLock'),
  ('audit.events', 'RowExclusiveLock'), ('auth.accounts', 'RowShareLock'),
  ('identity.staff_facility_memberships', 'RowShareLock'), ('identity.organizations', 'RowShareLock'),
  ('identity.facilities', 'RowShareLock'), ('identity.patients', 'RowShareLock'),
  ('identity.staff_attestation_texts', 'AccessShareLock');
-- Locks 0209 added beyond its header's ('' when none), and the declared ones it does not hold ('' when none).
create function pg_temp.undeclared() returns text language sql as $$
  select coalesce(string_agg(added.table_name || ' ' || added.mode, ', ' order by added.table_name, added.mode), '')
    from (select after_run.table_name, after_run.mode from locks_seen after_run where after_run.label = 'after'
          except
          select before_run.table_name, before_run.mode from locks_seen before_run where before_run.label = 'before') added
   where not exists (select 1 from declared_locks declared
                      where declared.table_name = added.table_name
                        and pg_temp.lock_rank(declared.mode) >= pg_temp.lock_rank(added.mode));
$$;
create function pg_temp.unheld() returns text language sql as $$
  select coalesce(string_agg(declared.table_name || ' ' || declared.mode, ', ' order by declared.table_name), '')
    from declared_locks declared
   where not exists (select 1 from locks_seen held where held.label = 'after'
                      and held.table_name = declared.table_name and held.mode = declared.mode);
$$;

-- 3. 0209 taken away for this transaction: its rows and role, its audit rows (triggers off: the audit log is
-- append-only), the fence's rule, the seven functions' insertions (the post-check's reverse replacement) and the two
-- checks as 0086 made them.
-- The fence's rule taken out (the fence as 0115 made it).
create function pg_temp.drop0209_fence() returns void language plpgsql as $$
declare
  source text;
  rule_start integer;
  rule_end integer;
  rule_tail constant text := E'COMMUNITY_HEALTH_WORKER_ONLY_AT_HOSPITAL'';\n  end if;\n';
begin
  source := pg_get_functiondef('identity.enforce_outreach_tenant_roles()'::regprocedure);
  rule_start := strpos(source, '  -- The community health worker (CHW-1');
  rule_end := strpos(source, rule_tail) + length(rule_tail);
  execute overlay(source placing '' from rule_start for rule_end - rule_start);
end
$$;
-- One role function without the role (the post-check's reverse replacement).
create function pg_temp.drop0209_function(signature text) returns void language plpgsql as $$
declare
  source text;
begin
  source := replace(pg_get_functiondef(signature::regprocedure), ', ''community_health_worker''', '');
  source := regexp_replace(source, $re$not in \('receptionist'\)$re$, $re$<> 'receptionist'$re$, 'g');
  source := regexp_replace(source, $re$ in \('receptionist'\)$re$, $re$ = 'receptionist'$re$, 'g');
  execute source;
end
$$;
create function pg_temp.drop0209() returns void language plpgsql as $$
declare
  signature text;
begin
  delete from auth.role_permissions where role_code = 'community_health_worker';
  delete from auth.roles where code = 'community_health_worker';
  perform set_config('session_replication_role', 'replica', true);
  delete from audit.events where correlation_id = '0209-community-health-worker-role';
  perform set_config('session_replication_role', 'origin', true);
  perform pg_temp.drop0209_fence();
  foreach signature in array (pg_temp.changed_functions())[2:] loop
    perform pg_temp.drop0209_function(signature);
  end loop;
  alter table identity.staff_invitations drop constraint staff_invitations_role_code_check;
  alter table identity.staff_invitations drop constraint staff_invitations_licence_ck;
  alter table identity.staff_invitations add constraint staff_invitations_role_code_check
    check (role_code in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist'));
  alter table identity.staff_invitations add constraint staff_invitations_licence_ck
    check ((role_code = 'receptionist' and licence_body is null and licence_number is null)
        or (role_code <> 'receptionist' and licence_body = identity.staff_role_licence_body(role_code)
            and identity.licence_number_valid(licence_number)));
end
$$;
select pg_temp.drop0209();
select pg_temp.expect('3a the state before 0209: 0001-0153''s bodies (0115, 0086, 0139) and checks again',
  '0 role, 0 role rows, 0 audit rows, 0 functions, 0 checks|'
  || '2dbe44af75ad22dbb737a1f57f3849e8,b6f4068712d97284fd95d169e3bde0cf,a19f57eb883418bc352d7a5b0fdab991,'
  || 'b4e714b7c1c3ab2ac402a1ae1e675882,1ca56a2cdd0231341d9f3b48441b2074,8da5860b2edbd3ee7205e4473b30fbc7,'
  || 'e12a01443fad2b903f22533153810b0f,9d326012bf28739a62cef768b613f181|'
  || 'CHECK ((((role_code = ''receptionist''::text) AND (licence_body IS NULL) AND (licence_number IS NULL)) OR ((role_code <> ''receptionist''::text) AND (licence_body = identity.staff_role_licence_body(role_code)) AND identity.licence_number_valid(licence_number)))) | '
  || 'CHECK ((role_code = ANY (ARRAY[''doctor''::text, ''nurse''::text, ''lab''::text, ''pharmacist''::text, ''receptionist''::text])))',
  pg_temp.made0209() || '|' || pg_temp.bodies() || '|' || pg_temp.checks());
select pg_temp.expect('3b the functions'' owner, ACL, SECURITY DEFINER, volatility and settings are as the runner left them',
  :'settings_applied', pg_temp.settings());
select pg_temp.expect('3c the fence holds no community health worker rule',
  'false', (select (prosrc like '%COMMUNITY_HEALTH_WORKER%')::text from pg_proc
             where oid = 'identity.enforce_outreach_tenant_roles()'::regprocedure));
create temporary table rows_before on commit drop as
  select role_code, permission_code, granted_at from auth.role_permissions;
create temporary table roles_before on commit drop as select to_jsonb(role_row) as role_json from auth.roles role_row;

-- The refusals of 3's preconditions, and helpers that rebuild a check or edit a function (made before the savepoint
-- each case rolls back to).
create function pg_temp.refused(kind text, detail text default null) returns text language sql immutable as $$
  select case kind
    when 'fence' then '55000 0209: identity.enforce_outreach_tenant_roles or its trigger is not as 0115 made it; '
                      || 'nothing applied'
    when 'functions' then '55000 0209: these functions differ from 0001-0153 (other lanes'' roles aside), name a role '
                          || 'the role check does not add, or give a licensed role no licence, or are missing: ' || detail
    when 'volunteer' then '55000 0209: outreach_volunteer or its three codes are not as 0115 made them; nothing applied'
    when 'role check' then '55000 0209: identity.staff_invitations.staff_invitations_role_code_check is not the role '
                           || 'list of 0001-0153 (other lanes'' roles aside); nothing applied'
    when 'lane roles' then '55000 0209: identity.staff_invitations.staff_invitations_role_code_check names roles '
                           || 'another lane cannot have added (a role of 0001-0153, a platform, outreach or organisation '
                           || 'administrator role, or one that is not an active role): ' || detail || '; nothing applied'
    when 'licence check' then '55000 0209: identity.staff_invitations.staff_invitations_licence_ck is not the licence '
                              || 'rule of 0001-0153 (other lanes'' unlicensed roles aside); nothing applied'
  end;
$$;
-- A role check, or a licence check, naming these roles (the licence check's no-licence roles in both branches).
create function pg_temp.set_role_check(roles text[]) returns void language plpgsql as $$
begin
  alter table identity.staff_invitations drop constraint staff_invitations_role_code_check;
  execute format('alter table identity.staff_invitations add constraint staff_invitations_role_code_check '
    || 'check (role_code in (%s))', (select string_agg(quote_literal(r), ', ' order by n)
                                       from unnest(roles) with ordinality v(r, n)));
end
$$;
create function pg_temp.set_licence_check(unlicensed text[]) returns void language plpgsql as $$
begin
  alter table identity.staff_invitations drop constraint staff_invitations_licence_ck;
  execute format('alter table identity.staff_invitations add constraint staff_invitations_licence_ck '
    || 'check ((role_code in (%1$s) and licence_body is null and licence_number is null) '
    || 'or (role_code not in (%1$s) and licence_body = identity.staff_role_licence_body(role_code) '
    || 'and identity.licence_number_valid(licence_number)))',
    (select string_agg(quote_literal(r), ', ' order by n) from unnest(unlicensed) with ordinality v(r, n)));
end
$$;
-- One role function's text changed (find and replace, every occurrence).
create function pg_temp.edit_function(signature text, find text, replacement text) returns void language plpgsql as $$
begin
  execute replace(pg_get_functiondef(signature::regprocedure), find, replacement);
end
$$;
savepoint s209;
-- Half states.
insert into auth.roles (code, description) values ('community_health_worker', 'Half state');
:run0209
rollback to savepoint s209;
select pg_temp.expect('3d the role alone: not in the reviewed state, nothing applied',
  '55000 0209: the schema is not in the reviewed state (the community health worker role, its rows, the fence''s rule, a role list or check naming it, or 0209''s audit rows exist, with other content than 0209 leaves); nothing applied | 0 role, 0 role rows, 0 audit rows, 0 functions, 0 checks',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0209());
do $$
begin
  execute replace(pg_get_functiondef('identity.remove_facility_staff_role(uuid,bigint,text,text)'::regprocedure),
    $r$'receptionist')$r$, $r$'receptionist', 'community_health_worker')$r$);
end $$;
:run0209
rollback to savepoint s209;
select pg_temp.expect('3e a role function naming the role alone: not in the reviewed state',
  '55000 0209: the schema is not in the reviewed state (the community health worker role, its rows, the fence''s rule, a role list or check naming it, or 0209''s audit rows exist, with other content than 0209 leaves); nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
set local session_replication_role = replica;
insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use,
  reason, provenance, source_system, details)
values ('0209-community-health-worker-role', 'system', 'auth.role.add', 'success', 'role', 'community_health_worker',
  'healthcare-operations', 'Synthetic half state of the 0209 suite', 'migration', 'hid-0209', '{}');
set local session_replication_role = origin;
:run0209
rollback to savepoint s209;
select pg_temp.expect('3f an audit row alone: not in the reviewed state',
  '55000 0209: the schema is not in the reviewed state (the community health worker role, its rows, the fence''s rule, a role list or check naming it, or 0209''s audit rows exist, with other content than 0209 leaves); nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
-- Preconditions.
do $$
begin
  execute regexp_replace(pg_get_functiondef('identity.enforce_outreach_tenant_roles()'::regprocedure),
    '\mbegin\M', 'begin /* changed */');
end $$;
:run0209
rollback to savepoint s209;
select pg_temp.expect('3g the fence changed: refused',
  '55000 0209: identity.enforce_outreach_tenant_roles or its trigger is not as 0115 made it; nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table auth.account_roles disable trigger account_roles_outreach_fence;
:run0209
rollback to savepoint s209;
select pg_temp.expect('3h the fence''s trigger disabled: refused',
  '55000 0209: identity.enforce_outreach_tenant_roles or its trigger is not as 0115 made it; nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
do $$
begin
  execute regexp_replace(pg_get_functiondef('identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)'::regprocedure),
    '\mbegin\M', 'begin /* changed */');
end $$;
:run0209
rollback to savepoint s209;
select pg_temp.expect('3i a role function changed: refused',
  '55000 0209: these functions differ from 0001-0153 (other lanes'' roles aside), name a role the role check does not add, or give a licensed role no licence, or are missing: identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
insert into auth.role_permissions (role_code, permission_code) values ('outreach_volunteer', 'outreach.campaign.write');
:run0209
rollback to savepoint s209;
select pg_temp.expect('3j the volunteer''s codes changed: refused',
  '55000 0209: outreach_volunteer or its three codes are not as 0115 made them; nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table identity.staff_invitations drop constraint staff_invitations_role_code_check;
alter table identity.staff_invitations add constraint staff_invitations_role_code_check
  check (role_code in ('doctor', 'nurse', 'pharmacist', 'receptionist'));
:run0209
rollback to savepoint s209;
select pg_temp.expect('3k a role check without a role of 0001-0153: refused',
  '55000 0209: identity.staff_invitations.staff_invitations_role_code_check is not the role list of 0001-0153 (other lanes'' roles aside); nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table identity.staff_invitations drop constraint staff_invitations_licence_ck;
alter table identity.staff_invitations add constraint staff_invitations_licence_ck
  check ((role_code in ('receptionist', 'nurse') and licence_body is null and licence_number is null)
      or (role_code not in ('receptionist') and licence_body = identity.staff_role_licence_body(role_code)
          and identity.licence_number_valid(licence_number)));
:run0209
rollback to savepoint s209;
select pg_temp.expect('3l a licence check whose two branches differ: refused',
  '55000 0209: identity.staff_invitations.staff_invitations_licence_ck is not the licence rule of 0001-0153 (other lanes'' unlicensed roles aside); nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
do $$
begin
  execute regexp_replace(pg_get_functiondef('identity.organization_staff_kinds(uuid)'::regprocedure),
    'select\M', 'select /* changed */ ');
end $$;
:run0209
rollback to savepoint s209;
select pg_temp.expect('3m organization_staff_kinds changed: refused',
  '55000 0209: identity.organization_staff_kinds is not as 0126 made it; nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
-- Each further precondition refusing on its own (the others met).
alter function identity.enforce_outreach_tenant_roles() set search_path = pg_catalog, pg_temp;
:run0209
rollback to savepoint s209;
select pg_temp.expect('3o the fence''s search_path changed: refused', pg_temp.refused('fence'),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
create trigger m209_fifth_trigger after insert on auth.account_roles for each row
  execute function identity.enforce_outreach_tenant_roles();
:run0209
rollback to savepoint s209;
select pg_temp.expect('3p a fifth trigger on auth.account_roles: refused', pg_temp.refused('fence'),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
grant execute on function identity.remove_facility_staff_role(uuid,bigint,text,text) to public;
:run0209
rollback to savepoint s209;
select pg_temp.expect('3q a role function granted to PUBLIC: refused',
  pg_temp.refused('functions', 'identity.remove_facility_staff_role(uuid,bigint,text,text)'),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
grant execute on function identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)
  to hid_identity_runtime with grant option;
:run0209
rollback to savepoint s209;
select pg_temp.expect('3r the runtime''s grant on a role function made WITH GRANT OPTION: refused',
  pg_temp.refused('functions', 'identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)'),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
update auth.permissions set active = false where code = 'outreach.registration.write';
:run0209
rollback to savepoint s209;
select pg_temp.expect('3s one of the volunteer''s codes inactive: refused', pg_temp.refused('volunteer'),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table identity.staff_invitations owner to hid_identity_runtime;
:run0209
rollback to savepoint s209;
select pg_temp.expect('3t identity.staff_invitations owned by another role: refused (42501)',
  format('42501 0209: these are not owned by %s, the owner of auth.roles: identity.staff_invitations',
    (select pg_get_userbyid(relowner) from pg_class where oid = 'auth.roles'::regclass)),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table identity.staff_invitations drop constraint staff_invitations_role_code_check;
alter table identity.staff_invitations add constraint staff_invitations_role_code_check
  check (role_code in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist') or role_code is null);
:run0209
rollback to savepoint s209;
select pg_temp.expect('3u a role check that also lets a null role in: refused', pg_temp.refused('role check'),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
insert into auth.roles (code, description) values ('cashier', 'Synthetic other lane''s role');
select pg_temp.set_role_check(array['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier']);
select pg_temp.set_licence_check(array['cashier', 'receptionist']);
:run0209
rollback to savepoint s209;
select pg_temp.expect('3v a licence check whose no-licence list starts with another role: refused',
  pg_temp.refused('licence check'), pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
-- Other lanes' roles are bounded: never a licensed role without a licence, a role of 0001-0153, a privileged role,
-- or a role that is not there.
select pg_temp.set_licence_check(array['receptionist', 'doctor']);
:run0209
rollback to savepoint s209;
select pg_temp.expect('3w a licence check that lets a doctor in without a licence: refused',
  pg_temp.refused('licence check'), pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
insert into auth.roles (code, description) values ('cashier', 'Synthetic other lane''s role');
select pg_temp.set_licence_check(array['receptionist', 'cashier']);
:run0209
rollback to savepoint s209;
select pg_temp.expect('3wa a licence check naming an unlicensed role the role check does not: refused',
  pg_temp.refused('licence check'), pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.set_role_check(array['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'admin']);
:run0209
rollback to savepoint s209;
select pg_temp.expect('3x a role check that makes admin invitable: refused', pg_temp.refused('lane roles', 'admin'),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.set_role_check(array['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'platform_auditor',
  'radiographer']);
insert into auth.roles (code, description) values ('platform_auditor', 'Synthetic privileged role');
:run0209
rollback to savepoint s209;
select pg_temp.expect('3y a role check naming a platform role and a role that does not exist: refused',
  pg_temp.refused('lane roles', 'platform_auditor, radiographer'),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
insert into auth.roles (code, description) values ('dentist', 'Synthetic other lane''s role');
select pg_temp.set_role_check(array['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'dentist']);
:run0209
rollback to savepoint s209;
select pg_temp.expect('3z a role check naming dentist after the front desk (its place is after doctor): refused',
  pg_temp.refused('lane roles', 'dentist'), pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
insert into auth.roles (code, description) values ('cashier', 'Synthetic other lane''s role');
select pg_temp.edit_function('identity.remove_facility_staff_role(uuid,bigint,text,text)',
  $r$'receptionist')$r$, $r$'receptionist', 'cashier')$r$);
:run0209
rollback to savepoint s209;
select pg_temp.expect('3za a role function appending a role the role check does not name: refused',
  pg_temp.refused('functions', 'identity.remove_facility_staff_role(uuid,bigint,text,text)'),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
insert into auth.roles (code, description) values ('dentist', 'Synthetic other lane''s role');
select pg_temp.edit_function('identity.remove_facility_staff_role(uuid,bigint,text,text)',
  $r$('doctor', 'nurse'$r$, $r$('doctor', 'dentist', 'nurse'$r$);
:run0209
rollback to savepoint s209;
select pg_temp.expect('3zb a role function naming dentist after doctor while the role check does not: refused',
  pg_temp.refused('functions', 'identity.remove_facility_staff_role(uuid,bigint,text,text)'),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
-- A licensed other lane's role (named by the role check, active, with a licence body) in a no-licence list.
insert into auth.roles (code, description) values ('radiographer', 'Synthetic licensed other lane''s role');
select pg_temp.set_role_check(array['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'radiographer']);
select pg_temp.edit_function('identity.staff_role_licence_body(text)', $r$    when 'pharmacist' then 'PCN'$r$,
  E'    when ''pharmacist'' then ''PCN''\n    when ''radiographer'' then ''RRBN''');
savepoint s209_licensed;
select pg_temp.edit_function('identity.staff_invitation_fields_valid(text,text,text,text,text,text)',
  $r$= 'receptionist'$r$, $r$in ('receptionist', 'radiographer')$r$);
:run0209
rollback to savepoint s209_licensed;
select pg_temp.expect('3zc a role function giving a licensed role no licence: refused',
  pg_temp.refused('functions', 'identity.staff_invitation_fields_valid(text,text,text,text,text,text)'),
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.set_licence_check(array['receptionist', 'radiographer']);
:run0209
rollback to savepoint s209_licensed;
select pg_temp.expect('3zd a licence check giving a licensed role no licence: refused',
  pg_temp.refused('licence check'), pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0209
select pg_temp.expect('3ze with a licensed other lane''s role named by the role check only, 0209 applies',
  'applied | 1 role, 3 role rows, 4 audit rows, 8 functions, 2 checks',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0209());
rollback to savepoint s209;
select pg_temp.expect('3n nothing of 0209 is left after the refusals',
  '0 role, 0 role rows, 0 audit rows, 0 functions, 0 checks', pg_temp.made0209());

-- 4. On 0001-0153's bodies, measuring the locks.
delete from locks_seen;
select pg_temp.record_locks('before');
:run0209
select pg_temp.record_locks('after');
select pg_temp.expect('4a 0209 applies', 'applied | 1 role, 3 role rows, 4 audit rows, 8 functions, 2 checks',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | ' || pg_temp.made0209());
select pg_temp.expect('4b 0209 takes no lock beyond its header''s, and holds every one it declares', '|',
  pg_temp.undeclared() || '|' || pg_temp.unheld());
select pg_temp.expect('4c the role holds exactly the volunteer''s codes; no other role row or role changed',
  'outreach.campaign.read,outreach.registration.read,outreach.registration.write|true|0|0|true',
  (select string_agg(permission_code, ',' order by permission_code collate "C") from auth.role_permissions
    where role_code = 'community_health_worker')
  || '|' || ((select string_agg(permission_code, ',' order by permission_code collate "C") from auth.role_permissions
               where role_code = 'community_health_worker')
             = (select string_agg(permission_code, ',' order by permission_code collate "C") from auth.role_permissions
                 where role_code = 'outreach_volunteer'))::text
  || '|' || (select count(*) from (select role_code, permission_code, granted_at from auth.role_permissions
                                     where role_code <> 'community_health_worker'
                                   except select * from rows_before) changed)
  || '|' || (select count(*) from (select role_code, permission_code, granted_at from rows_before
                                   except select role_code, permission_code, granted_at from auth.role_permissions) gone)
  || '|' || ((select count(*) from auth.roles role_row where role_row.code <> 'community_health_worker'
                and not exists (select 1 from roles_before where roles_before.role_json = to_jsonb(role_row))) = 0
             and exists (select 1 from auth.roles where code = 'community_health_worker' and active
                          and description = 'Community health worker: registers and screens people in outreach campaigns (Outreach only)'))::text);
select pg_temp.expect('4d the fence and the seven functions are exactly what the runner left (md5), with the same settings',
  :'bodies_applied' || '|' || :'settings_applied', pg_temp.bodies() || '|' || pg_temp.settings());
select pg_temp.expect('4e the fence''s after-md5 and its trigger', '0ae11f8897fd82e62a378ee23cf5dad6|O|4',
  (select md5(prosrc) from pg_proc where oid = 'identity.enforce_outreach_tenant_roles()'::regprocedure)
  || '|' || (select tgenabled::text from pg_trigger where tgrelid = 'auth.account_roles'::regclass
               and tgname = 'account_roles_outreach_fence'
               and tgfoid = 'identity.enforce_outreach_tenant_roles()'::regprocedure)
  || '|' || (select count(*) from pg_trigger where tgrelid = 'auth.account_roles'::regclass and not tgisinternal));
select pg_temp.expect('4f the two checks are what the runner left, validated', :'checks_applied' || '|2',
  pg_temp.checks() || '|' || (select count(*) from pg_constraint where conrelid = 'identity.staff_invitations'::regclass
    and conname in ('staff_invitations_role_code_check', 'staff_invitations_licence_ck') and convalidated));
select pg_temp.expect('4g the staff vocabulary: last at hospitals and clinics; never at laboratories or pharmacies',
  '{doctor,nurse,lab,pharmacist,receptionist,community_health_worker}|{doctor,nurse,lab,pharmacist,receptionist,community_health_worker}|{doctor,nurse,lab,pharmacist,receptionist,community_health_worker}|{lab,receptionist}|{pharmacist,receptionist}|{lab,receptionist}|{}|null',
  identity.staff_invitable_roles('hospital', null)::text || '|' || identity.staff_invitable_roles('clinic', 'ehr')::text
  || '|' || identity.staff_invitable_roles('other', 'migrate')::text
  || '|' || identity.staff_invitable_roles('laboratory', null)::text
  || '|' || identity.staff_invitable_roles('pharmacy', null)::text
  || '|' || identity.staff_invitable_roles('other', 'laboratory')::text
  || '|' || identity.staff_invitable_roles('other', 'outreach')::text
  || '|' || coalesce(identity.staff_role_licence_body('community_health_worker'), 'null'));
select pg_temp.expect('4h the front desk''s and the community health worker''s invitation fields are valid without a licence; with one (or a number alone), not',
  'true|true|false|false|false',
  identity.staff_invitation_fields_valid('Efe Fieldworker', 'efe@example.invalid', 'community_health_worker', null,
    null, 'facility-staff-attestation-v1')::text
  || '|' || identity.staff_invitation_fields_valid('Efe Fieldworker', 'efe@example.invalid', 'receptionist', null,
    null, 'facility-staff-attestation-v1')::text
  || '|' || identity.staff_invitation_fields_valid('Efe Fieldworker', 'efe@example.invalid', 'community_health_worker',
    'MDCN', 'MDCN/1', 'facility-staff-attestation-v1')::text
  || '|' || identity.staff_invitation_fields_valid('Efe Fieldworker', 'efe@example.invalid', 'nurse', null,
    null, 'facility-staff-attestation-v1')::text
  || '|' || identity.staff_invitation_fields_valid('Efe Fieldworker', 'efe@example.invalid', 'community_health_worker',
    null, 'CHPRBN/12', 'facility-staff-attestation-v1')::text);
select pg_temp.expect('4i the audit rows: one role, three rows, as the system actor with no account, facility or patient',
  'auth.role-permission.add:3,auth.role.add:1/4|community_health_worker/outreach.campaign.read,community_health_worker/outreach.registration.read,community_health_worker/outreach.registration.write',
  (select string_agg(action || ':' || n, ',' order by action collate "C") from (select action, count(*) as n
     from audit.events where correlation_id = '0209-community-health-worker-role' group by action) counted)
  || '/' || (select count(*) from audit.events where correlation_id = '0209-community-health-worker-role'
              and actor_type = 'system' and actor_account_id is null and actor_membership_id is null
              and facility_id is null and patient_id is null and provenance = 'migration'
              and source_system = 'hid-0209' and details->>'migration' = '0209'
              and details->>'decision' = 'Q130 A (owner, 19 November 2026), CHW-1')
  || '|' || (select string_agg(resource_id, ',' order by resource_id) from audit.events
              where correlation_id = '0209-community-health-worker-role' and action = 'auth.role-permission.add'));
-- Near-complete half states: everything 0209 leaves but one piece is not "already applied".
savepoint near_applied;
set local session_replication_role = replica;
delete from audit.events where correlation_id = '0209-community-health-worker-role' and action = 'auth.role.add';
set local session_replication_role = origin;
:run0209
rollback to savepoint near_applied;
select pg_temp.expect('4ja all of 0209 but one audit row: not in the reviewed state',
  '55000 0209: the schema is not in the reviewed state (the community health worker role, its rows, the fence''s rule, a role list or check naming it, or 0209''s audit rows exist, with other content than 0209 leaves); nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.drop0209_fence();
:run0209
rollback to savepoint near_applied;
select pg_temp.expect('4jb all of 0209 but the fence''s rule: not in the reviewed state',
  '55000 0209: the schema is not in the reviewed state (the community health worker role, its rows, the fence''s rule, a role list or check naming it, or 0209''s audit rows exist, with other content than 0209 leaves); nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
delete from auth.role_permissions
 where role_code = 'community_health_worker' and permission_code = 'outreach.registration.write';
:run0209
rollback to savepoint near_applied;
select pg_temp.expect('4jc all of 0209 but one of the role''s rows: not in the reviewed state',
  '55000 0209: the schema is not in the reviewed state (the community health worker role, its rows, the fence''s rule, a role list or check naming it, or 0209''s audit rows exist, with other content than 0209 leaves); nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
select pg_temp.drop0209_function('identity.admin_add_facility_staff_role(uuid,uuid,bigint,text,text,text,text,text,text,character)');
:run0209
rollback to savepoint near_applied;
select pg_temp.expect('4jd all of 0209 but one role function: not in the reviewed state',
  '55000 0209: the schema is not in the reviewed state (the community health worker role, its rows, the fence''s rule, a role list or check naming it, or 0209''s audit rows exist, with other content than 0209 leaves); nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
alter table identity.staff_invitations drop constraint staff_invitations_role_code_check;
alter table identity.staff_invitations add constraint staff_invitations_role_code_check
  check (role_code in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist'));
:run0209
rollback to savepoint near_applied;
select pg_temp.expect('4je all of 0209 but the role check: not in the reviewed state',
  '55000 0209: the schema is not in the reviewed state (the community health worker role, its rows, the fence''s rule, a role list or check naming it, or 0209''s audit rows exist, with other content than 0209 leaves); nothing applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
:run0209
select pg_temp.expect('4j and answers already applied again', '55000 0209: already applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint s209;

-- 5. On BILL-1's 0162 versions (cashier and billing_officer appended to the lists, "in"/"not in" for the front desk,
-- the two at hospitals and cashier at laboratories and pharmacies, both checks), as 0162 makes them, with DEN-1's
-- 0194 dentist after doctor in the role lists and the role check; their roles as those files add them (active).
insert into auth.roles (code, description) values
  ('cashier', 'Synthetic: Billing''s cashier (0162)'), ('billing_officer', 'Synthetic: Billing''s billing officer (0162)'),
  ('dentist', 'Synthetic: Dental''s dentist (0194)');
do $$
declare
  signature text;
  source text;
begin
  foreach signature in array (pg_temp.changed_functions())[3:] loop
    source := pg_get_functiondef(signature::regprocedure);
    source := replace(source, $r$('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist')$r$,
      $r$('doctor', 'dentist', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier', 'billing_officer')$r$);
    source := replace(source, $r$= 'receptionist'$r$, $r$in ('receptionist', 'cashier', 'billing_officer')$r$);
    source := replace(source, $r$<> 'receptionist'$r$, $r$not in ('receptionist', 'cashier', 'billing_officer')$r$);
    execute source;
  end loop;
  -- 0162's own text of the invitable roles (its B5), with 0194's dentist.
  create or replace function identity.staff_invitable_roles(target_organization_type text, target_product_code text)
  returns text[]
  language sql immutable parallel safe
  set search_path = pg_catalog, pg_temp
  as $invitable$
  select case
    when target_organization_type in ('hospital', 'clinic')
      or (target_organization_type = 'other' and target_product_code in ('ehr', 'migrate'))
      then array['doctor', 'dentist', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier', 'billing_officer']
    when target_organization_type = 'laboratory'
      or (target_organization_type = 'other' and target_product_code = 'laboratory')
      then array['lab', 'receptionist', 'cashier']
    when target_organization_type = 'pharmacy'
      or (target_organization_type = 'other' and target_product_code = 'pharmacy')
      then array['pharmacist', 'receptionist', 'cashier']
    else array[]::text[]
  end
$invitable$;
end $$;
alter table identity.staff_invitations drop constraint staff_invitations_role_code_check;
alter table identity.staff_invitations drop constraint staff_invitations_licence_ck;
alter table identity.staff_invitations add constraint staff_invitations_role_code_check
  check (role_code in ('doctor', 'dentist', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier', 'billing_officer'));
alter table identity.staff_invitations add constraint staff_invitations_licence_ck
  check ((role_code in ('receptionist', 'cashier', 'billing_officer') and licence_body is null
          and licence_number is null)
      or (role_code not in ('receptionist', 'cashier', 'billing_officer')
          and licence_body = identity.staff_role_licence_body(role_code)
          and identity.licence_number_valid(licence_number)));
select pg_temp.expect('5a the other lanes'' versions are in place (simulated): 0162''s licence check, byte for byte',
  'CHECK ((((role_code = ANY (ARRAY[''receptionist''::text, ''cashier''::text, ''billing_officer''::text])) AND (licence_body IS NULL) AND (licence_number IS NULL)) OR ((role_code <> ALL (ARRAY[''receptionist''::text, ''cashier''::text, ''billing_officer''::text])) AND (licence_body = identity.staff_role_licence_body(role_code)) AND identity.licence_number_valid(licence_number))))',
  (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'identity.staff_invitations'::regclass
     and conname = 'staff_invitations_licence_ck'));
:run0209
select pg_temp.expect('5b 0209 applies after 0162 and 0194 and keeps their roles',
  'applied | {doctor,dentist,nurse,lab,pharmacist,receptionist,cashier,billing_officer,community_health_worker}|{lab,receptionist,cashier}|{pharmacist,receptionist,cashier}',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE') || ' | '
  || identity.staff_invitable_roles('hospital', 'ehr')::text || '|' || identity.staff_invitable_roles('laboratory', 'ehr')::text
  || '|' || identity.staff_invitable_roles('pharmacy', 'ehr')::text);
select pg_temp.expect('5c both checks keep every role found and add the community health worker last',
  'CHECK ((((role_code = ANY (ARRAY[''receptionist''::text, ''cashier''::text, ''billing_officer''::text, ''community_health_worker''::text])) AND (licence_body IS NULL) AND (licence_number IS NULL)) OR ((role_code <> ALL (ARRAY[''receptionist''::text, ''cashier''::text, ''billing_officer''::text, ''community_health_worker''::text])) AND (licence_body = identity.staff_role_licence_body(role_code)) AND identity.licence_number_valid(licence_number)))) | '
  || 'CHECK ((role_code = ANY (ARRAY[''doctor''::text, ''dentist''::text, ''nurse''::text, ''lab''::text, ''pharmacist''::text, ''receptionist''::text, ''cashier''::text, ''billing_officer''::text, ''community_health_worker''::text])))',
  pg_temp.checks());
select pg_temp.expect('5d each role function keeps the other lanes'' text: the list with the role last (5), the in and not in lists with it (4 and 4)',
  '5/4/4',
  (select count(*) from pg_proc where pronamespace = 'identity'::regnamespace
     and prosrc like $r$%('doctor', 'dentist', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier', 'billing_officer', 'community_health_worker')%$r$)
  || '/' || (select count(*) from pg_proc where pronamespace = 'identity'::regnamespace
     and prosrc like $r$% in ('receptionist', 'cashier', 'billing_officer', 'community_health_worker')%$r$)
  || '/' || (select count(*) from pg_proc where pronamespace = 'identity'::regnamespace
     and prosrc like $r$%not in ('receptionist', 'cashier', 'billing_officer', 'community_health_worker')%$r$));
:run0209
select pg_temp.expect('5e and answers already applied again', '55000 0209: already applied',
  pg_temp.answer(:'LAST_ERROR_SQLSTATE', :'LAST_ERROR_MESSAGE'));
rollback to savepoint s209;

rollback;

\if :m209_dblink_available
\if :m209_dblink_create
drop extension dblink;
\endif
\endif
