-- 0097 Phone and computer notifications (B6; owner decisions of 2026-10-28,
-- migrations pre-approved for this batch, the declaration signed separately):
-- the patient's web push subscriptions and their delivery state. A push
-- carries no data (a "tickle"): the service worker shows the fixed text
-- "Health ID / You have a new notification." and opens Notifications. Main's
-- ADR-060 (proposed there, not implemented) gave the shape; contract
-- b6-contract.md gives the decisions:
--
-- D3  A new table, notification.web_push_subscriptions. The FCM-style
--     notification.device_registrations (0028) is not reused and is left
--     untouched: runtime roles can read it directly, it has no row-level
--     security, a NOT NULL token that cannot be erased and no sign-in binding.
-- D4  The browser's p256dh and auth keys are checked by Identity and
--     discarded: an empty push needs neither, so they are never stored.
-- D5  A subscription belongs to the sign-in (auth.sessions.family_id) that
--     turned it on, and is pushed to only while that sign-in is live: a row
--     of the family not revoked, not idle-expired, not past its absolute end,
--     the account's current token version, the account active (and, for a
--     claim, not temporarily disabled), not deletion-due, the patient active.
--     Signing out ends the sign-in: the website removes the subscription
--     before logout, and independently the server never claims a
--     subscription whose sign-in has ended and erases it in the next sweep
--     (prune). After a new sign-in the patient turns notifications on again.
-- D6  What triggers a push: every new unread patient inbox item, found by
--     polling (the claim). No trigger on notification.inbox_items and no write
--     in the enqueue path: the transactions that enqueue inbox items are not
--     touched and take no new lock. The watermark (delivered_through) is the
--     newest inbox created_at a push covered (or the bind time).
-- D7  At most one push per subscription per 2 minutes; items arriving
--     meanwhile ride the next push. Read items cause none.
-- D8  Retries after 1, 2, 4, 8 and 16 minutes (a Retry-After up to an hour is
--     honoured); the sixth failure drops that round. A 404 or 410 from the
--     push service removes the subscription. Any other refusal drops the
--     round and waits an hour; the third in a row removes the subscription.
-- D11 At most 10 active subscriptions per patient and one per sign-in: an
--     11th evicts the least recently bound one; a new endpoint in the same
--     sign-in replaces that sign-in's old one.
-- D12 From the scheduled deletion time (0096's due check) no subscription is
--     claimed; at completion a trigger on auth.accounts erases them in the
--     completion transaction.
-- D15 The endpoint (a bearer capability) is stored only as AES-256-GCM
--     ciphertext under Identity's contact key and as its SHA-256 (a
--     high-entropy URL: the digest discloses nothing, and the browser can
--     compute it to find "this device"). It is never audited or returned; a
--     removed row keeps neither ciphertext nor digest. Rows are never deleted.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): every prerequisite exists (0001-0096 applied);
--    no object of this migration exists (else "0097: already applied"); the
--    nine function bodies the new ones call or rely on are those 0001-0096
--    gave them (md5 of pg_proc.prosrc; 0097 replaces no function); the CHECKs,
--    indexes, column types and triggers the new bodies rely on are as
--    0001-0096 made them; the applying role, which will own the new table and
--    functions, holds (by ownership, membership or grant, never a
--    superuser's bypass) what the new bodies read and write: it owns
--    identity.patients (row-level security enabled), may select auth.accounts,
--    auth.sessions and notification.inbox_items, update auth.accounts (the
--    lock mode), reference auth.accounts and identity.patients, create a
--    trigger on auth.accounts, insert audit.events, create in schemas
--    notification and identity, use the five schemas and execute the
--    functions called. Then the two locks the new foreign keys and the
--    trigger need are taken (see Locks).
-- 1. The table notification.web_push_subscriptions: row-level security
--    enabled and forced, one policy for its owner, no grant to any role (only
--    the SECURITY DEFINER commands touch it); a guard trigger refuses deletes,
--    any update of a removed row and changes to its identity columns.
-- 2. Functions, each SECURITY DEFINER with search_path pg_catalog, pg_temp
--    (but the guard trigger's, which is plain), PL/pgSQL only, so creating
--    them reads no table:
--    a. internal, granted to no role: identity.web_push_audit,
--       identity.web_push_remove, identity.web_push_sign_in_live and the two
--       trigger functions;
--    b. the patient's identity.subscribe_my_web_push,
--       identity.unsubscribe_my_web_push and
--       identity.list_my_web_push_subscriptions, bound to
--       identity.patient_self_session(subject, session) (42501 without a live
--       patient session);
--    c. the sweeper's identity.claim_web_push_deliveries,
--       identity.record_web_push_outcome and
--       identity.prune_web_push_subscriptions (system:auth only).
--    Every subscribe, unsubscribe, removal and dropped round records its
--    audit.events row (ids, codes and counts only; never an endpoint, digest,
--    key or session id). Deliveries are not audited.
-- 3. The trigger accounts_deleted_web_push on auth.accounts, fired only for
--    the transition to 'deleted' (0096's completion): it erases the account's
--    subscriptions in that transaction and never raises.
-- 4. Post-checks: every new object belongs to the applying role; row-level
--    security is forced with exactly the one policy; the table's ACL holds
--    only its owner; every new function but the guard is SECURITY DEFINER
--    with this search_path; the trigger is the one this file creates; the
--    bodies relied on still have their md5; after the grants, every function
--    ACL is exactly section 5's.
-- 5. Grants, here and in runtime-grants.sql: the six commands to
--    hid_identity_runtime and hid_schema_test_runtime; nothing to the EHR,
--    Lab, Pharmacy or Notification runtimes; no grant on the table; every new
--    function revoked from PUBLIC.
--
-- Locks: SHARE ROW EXCLUSIVE on auth.accounts and identity.patients (the new
-- foreign keys and the trigger), taken up front in that order (0094's and
-- 0096's: registration writes accounts and then patients), NOWAIT every 10 ms
-- for at most 5 seconds (then 55P03, nothing applied), held to commit: they
-- block writes to those two tables (sign-up, sign-in's account updates,
-- profile changes) for the apply, never reads. No existing table is altered;
-- no lock on auth.sessions, notification.inbox_items or audit.events (no
-- foreign key to them, no trigger on them). Measured with pg_locks before
-- commit (the file applied in an open transaction on a copy migrated through
-- 0096): SHARE ROW EXCLUSIVE and ACCESS SHARE on auth.accounts and
-- identity.patients, ACCESS SHARE on their primary keys; ACCESS EXCLUSIVE (and
-- the weaker locks creating them takes) on the new table, its indexes and its
-- TOAST table; ACCESS SHARE on the two new trigger functions; SHARE UPDATE
-- EXCLUSIVE on the six new functions commented; ACCESS EXCLUSIVE on section
-- 0's temporary helper; the catalogs' own locks; no lock on any other
-- application table and none on an existing function. The timings and the
-- busy-table test are in config/production-schema-compatibility.json.
--
-- Old services on this schema: old images call none of the new commands and
-- read nothing new. The new trigger fires only on the transition to
-- 'deleted' (0096's completion) and touches only the new table. EHR, Lab,
-- Pharmacy and Notification use nothing new. Applied migrations 0001 through
-- 0096 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0090's to 0096's helper).
create function pg_temp.web_push_0097_holds(holder oid, object_owner oid, object_acl aclitem[],
  object_type "char", wanted text)
returns boolean
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  with recursive held(role_id) as (
    select holder
    union
    select membership.roleid from pg_catalog.pg_auth_members membership join held on membership.member = held.role_id
  )
  select object_owner in (select held.role_id from held)
    or exists (select 1 from pg_catalog.aclexplode(coalesce(object_acl, pg_catalog.acldefault(object_type, object_owner))) acl
                where acl.privilege_type = wanted
                  and (acl.grantee = 0 or acl.grantee in (select held.role_id from held)))
$$;

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  -- a. Prerequisites (0001-0096).
  if to_regclass('auth.accounts') is null
     or to_regclass('auth.sessions') is null
     or to_regclass('identity.patients') is null
     or to_regclass('notification.inbox_items') is null
     or to_regclass('audit.events') is null
     or to_regclass('identity.patient_account_deletion_requests') is null
     or to_regprocedure('identity.patient_self_session(text,uuid)') is null
     or to_regprocedure('identity.patient_account_deletion_due(uuid)') is null
     or to_regprocedure('identity.complete_patient_account_deletion(uuid,text)') is null
     or to_regprocedure('auth.protect_deleted_account()') is null
     or to_regprocedure('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)') is null
     or to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('platform.current_correlation_id()') is null
     or to_regprocedure('platform.reject_mutation()') is null
     or to_regprocedure('audit.authorize_platform_event()') is null then
    raise exception using errcode = '55000', message = '0097: 0001-0096 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('notification.web_push_subscriptions') is not null
     or exists (select 1 from pg_trigger trigger_row
                 where trigger_row.tgrelid = 'auth.accounts'::regclass
                   and trigger_row.tgname = 'accounts_deleted_web_push')
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where (namespace.nspname, proc.proname) in (
                   ('identity', 'web_push_audit'), ('identity', 'web_push_remove'),
                   ('identity', 'web_push_sign_in_live'),
                   ('notification', 'remove_web_push_for_deleted_account'),
                   ('notification', 'guard_web_push_subscription_mutation'),
                   ('identity', 'subscribe_my_web_push'), ('identity', 'unsubscribe_my_web_push'),
                   ('identity', 'list_my_web_push_subscriptions'), ('identity', 'claim_web_push_deliveries'),
                   ('identity', 'record_web_push_outcome'), ('identity', 'prune_web_push_subscriptions'))) then
    raise exception using errcode = '55000', message = '0097: already applied';
  end if;
  -- c. The bodies the new ones call or rely on, as 0001-0096 left them: the
  -- patient session binding (0096), the deletion due check and completion
  -- (0096; completion sets auth.accounts.status = 'deleted', which fires
  -- section 3), the other auth.accounts trigger (0096), the only inbox writer
  -- (0087), the request context readers and the audit table's triggers.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.patient_self_session(text,uuid)', '378cd66a28347ef82a7faee8d2c65a15'),
      ('identity.patient_account_deletion_due(uuid)', 'b032c1a385770e20e4930534a203863d'),
      ('identity.complete_patient_account_deletion(uuid,text)', 'a668a9b144b76fca197f6602a4097e65'),
      ('auth.protect_deleted_account()', '230114cc840d87d5b23cac8b6337f822'),
      ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', '0b5689f31a3ce00f9313fe1e55244fad'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0097: a function this migration relies on has another body than 0001-0096 gave it: %s', mismatch);
  end if;
  -- d. The CHECKs the liveness test and the trigger's WHEN rely on.
  select string_agg(format('%s.%s: %s', expected.relation_name, expected.what, coalesce(actual.definition, 'missing')), '; ')
    into mismatch
    from (values
      ('auth.accounts', 'accounts_status_check',
       $c$CHECK ((status = ANY (ARRAY['active'::text, 'pending_reset'::text, 'locked'::text, 'disabled'::text, 'deleted'::text])))$c$),
      ('auth.sessions', 'patient_session_identity_binding',
       $c$CHECK (((session_kind = 'patient'::text) = (patient_id IS NOT NULL)))$c$),
      ('auth.sessions', 'sessions_session_kind_check',
       $c$CHECK ((session_kind = ANY (ARRAY['staff'::text, 'patient'::text])))$c$),
      ('auth.sessions', 'sessions_check2', 'CHECK (((revoked_at IS NULL) OR (revocation_reason IS NOT NULL)))'))
         expected(relation_name, what, definition)
    left join (
      select constraint_row.conrelid, constraint_row.conname::text as what,
             pg_get_constraintdef(constraint_row.oid) as definition
        from pg_constraint constraint_row
       where constraint_row.contype = 'c') actual
      on actual.conrelid = expected.relation_name::regclass and actual.what = expected.what
   where actual.definition is distinct from expected.definition;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0097: a CHECK this migration relies on differs from 0001-0096: %s', mismatch);
  end if;
  -- e. The indexes the claim and the liveness test read, the columns they
  -- compare, and the triggers 0096 left on audit.events and auth.accounts.
  select string_agg(expected.what, '; ') into mismatch
    from (values
      ('sessions_family_idx', 'CREATE INDEX sessions_family_idx ON auth.sessions USING btree (family_id, issued_at)'),
      ('notification_inbox_account_idx',
       'CREATE INDEX notification_inbox_account_idx ON notification.inbox_items USING btree (account_id, created_at DESC, id DESC)'),
      ('notification_inbox_unread_idx',
       'CREATE INDEX notification_inbox_unread_idx ON notification.inbox_items USING btree (account_id, created_at DESC, id DESC) WHERE (read_at IS NULL)'))
         expected(what, definition)
   where not exists (select 1 from pg_index index_row
                      where pg_get_indexdef(index_row.indexrelid) = expected.definition);
  if mismatch is null then
    select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
      from (values
        ('notification.inbox_items', 'account_id', 'uuid', true),
        ('notification.inbox_items', 'created_at', 'timestamp with time zone', true),
        ('notification.inbox_items', 'read_at', 'timestamp with time zone', false),
        ('auth.sessions', 'family_id', 'uuid', true),
        ('auth.sessions', 'patient_id', 'uuid', false),
        ('auth.sessions', 'account_token_version', 'bigint', true),
        ('auth.sessions', 'expires_at', 'timestamp with time zone', true),
        ('auth.sessions', 'absolute_expires_at', 'timestamp with time zone', true),
        ('auth.sessions', 'revoked_at', 'timestamp with time zone', false),
        ('auth.accounts', 'token_version', 'bigint', true),
        ('auth.accounts', 'disabled_until', 'timestamp with time zone', false),
        ('auth.accounts', 'status', 'text', true))
           expected(relation_name, column_name, type_name, not_null)
     where not exists (select 1 from pg_attribute attribute_row
                        where attribute_row.attrelid = expected.relation_name::regclass
                          and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                          and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                          and attribute_row.attnotnull = expected.not_null);
  end if;
  if mismatch is null then
    select string_agg(expected.trigger_name, '; ') into mismatch
      from (values
        ('audit.events', 'audit_events_no_mutation',
         'CREATE TRIGGER audit_events_no_mutation BEFORE DELETE OR UPDATE ON audit.events FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()'),
        ('audit.events', 'audit_platform_authority',
         'CREATE TRIGGER audit_platform_authority BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION audit.authorize_platform_event()'),
        ('auth.accounts', 'accounts_deleted_terminal',
         $t$CREATE TRIGGER accounts_deleted_terminal BEFORE UPDATE ON auth.accounts FOR EACH ROW WHEN ((old.status = 'deleted'::text)) EXECUTE FUNCTION auth.protect_deleted_account()$t$))
           expected(relation_name, trigger_name, definition)
     where not exists (select 1 from pg_trigger trigger_row
                        where trigger_row.tgrelid = expected.relation_name::regclass
                          and trigger_row.tgname = expected.trigger_name and trigger_row.tgenabled = 'O'
                          and pg_get_triggerdef(trigger_row.oid) = expected.definition);
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0097: an index, column or trigger this migration relies on differs from 0001-0096: %s', mismatch);
  end if;
  -- f. Privileges, never through a superuser's bypass (production's migrator
  -- has none).
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s lacks %s on %s', holder.rolname, wanted.privilege, relation.oid::regclass) as what
        from (values
          ('identity.patients', 'OWNER'),
          ('auth.accounts', 'SELECT'), ('auth.accounts', 'UPDATE'), ('auth.accounts', 'REFERENCES'),
          ('auth.accounts', 'TRIGGER'), ('identity.patients', 'REFERENCES'),
          ('auth.sessions', 'SELECT'), ('notification.inbox_items', 'SELECT'),
          ('audit.events', 'INSERT')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
        join pg_roles holder on holder.oid = applier
       where case when wanted.privilege = 'OWNER'
               then not pg_temp.web_push_0097_holds(applier, relation.relowner, null::aclitem[], 'r', 'OWNER')
               else not pg_temp.web_push_0097_holds(applier, relation.relowner, relation.relacl, 'r', wanted.privilege) end
      union all
      select format('%s lacks %s on schema %s', holder.rolname, wanted.privilege, namespace.nspname)
        from (values ('notification', 'CREATE'), ('identity', 'CREATE'),
                     ('auth', 'USAGE'), ('identity', 'USAGE'), ('notification', 'USAGE'),
                     ('platform', 'USAGE'), ('audit', 'USAGE')) wanted(schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
        join pg_roles holder on holder.oid = applier
       where not pg_temp.web_push_0097_holds(applier, namespace.nspowner, namespace.nspacl, 'n', wanted.privilege)
      union all
      select format('%s lacks EXECUTE on %s', holder.rolname, proc.oid::regprocedure)
        from (values
          ('identity.patient_self_session(text,uuid)'), ('identity.patient_account_deletion_due(uuid)'),
          ('platform.current_actor_subject()'), ('platform.current_correlation_id()')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
        join pg_roles holder on holder.oid = applier
       where not pg_temp.web_push_0097_holds(applier, proc.proowner, proc.proacl, 'f', 'EXECUTE')
      union all
      -- identity.patients has row-level security enabled (not forced): its
      -- owner reads every row, any other role only what its policies admit.
      select format('row-level security on %s is not as 0001-0096 left it', relation.oid::regclass)
        from pg_class relation
       where relation.oid = 'identity.patients'::regclass
         and (not relation.relrowsecurity or relation.relforcerowsecurity)) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0097: missing privileges: %s', mismatch);
  end if;
  raise notice '0097: owners checked: %', (
    select string_agg(format('%s=%s', owned.what, owned.owner), ', ' order by owned.what)
      from (select relation.oid::regclass::text as what, pg_get_userbyid(relation.relowner) as owner
              from pg_class relation
             where relation.oid in ('auth.accounts'::regclass, 'auth.sessions'::regclass,
               'identity.patients'::regclass, 'notification.inbox_items'::regclass)
            union all
            select 'new table and functions', current_user::text) owned);
end
$$;

-- The locks the new foreign keys and the trigger take, up front and bounded.
do $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table auth.accounts, identity.patients in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0097: auth.accounts or identity.patients stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 1. The patient's web push subscriptions. id is chosen by Identity: it is
-- the ciphertext's associated data. session_family_id is the sign-in
-- (auth.sessions.family_id) the subscription belongs to; no foreign key (a
-- hot table, and a family has no row of its own).
create table notification.web_push_subscriptions (
  id uuid primary key,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  session_family_id uuid not null,
  status text not null default 'active' check (status in ('active', 'removed')),
  endpoint_sha256 char(64) check (endpoint_sha256 is null or endpoint_sha256 ~ '^[0-9a-f]{64}$'),
  endpoint_ciphertext bytea check (endpoint_ciphertext is null or octet_length(endpoint_ciphertext) between 30 and 2100),
  endpoint_key_version text not null check (endpoint_key_version ~ '^[A-Za-z0-9._:-]{1,64}$'),
  push_service text not null check (push_service in ('fcm', 'mozilla', 'apple', 'windows')),
  vapid_key_id char(16) not null check (vapid_key_id ~ '^[0-9a-f]{16}$'),
  -- The newest inbox created_at a push covered, or the bind time.
  delivered_through timestamptz not null,
  -- The newest inbox created_at the push in flight covers (with the lease).
  claimed_through timestamptz,
  last_delivered_at timestamptz,
  delivered_count integer not null default 0 check (delivered_count >= 0),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 6),
  consecutive_rejections smallint not null default 0 check (consecutive_rejections between 0 and 3),
  next_attempt_at timestamptz,
  lease_owner text check (lease_owner is null or lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  lease_expires_at timestamptz,
  last_outcome_code text check (last_outcome_code is null or last_outcome_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  removal_reason text check (removal_reason is null or removal_reason in ('patient_turned_off', 'push_service_gone',
    'session_ended', 'account_closed', 'account_deleted', 'replaced_in_sign_in', 'replaced_by_newer',
    'endpoint_reassigned', 'rejected_repeatedly')),
  created_at timestamptz not null default clock_timestamp(),
  bound_at timestamptz not null default clock_timestamp(),
  removed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  check ((status = 'active') = (endpoint_ciphertext is not null)),
  check ((status = 'active') = (endpoint_sha256 is not null)),
  check ((status = 'active') = (removed_at is null)),
  check ((removed_at is null) = (removal_reason is null)),
  check ((lease_owner is null) = (lease_expires_at is null)),
  check (lease_owner is null or (status = 'active' and claimed_through is not null))
);
-- One active row per endpoint (across accounts) and per sign-in; the
-- commands serialize per account and per endpoint on advisory locks and
-- these indexes are the final duplicate guards.
create unique index web_push_subscriptions_endpoint_uq
  on notification.web_push_subscriptions (endpoint_sha256) where status = 'active';
create unique index web_push_subscriptions_sign_in_uq
  on notification.web_push_subscriptions (session_family_id) where status = 'active';
create index web_push_subscriptions_account_idx
  on notification.web_push_subscriptions (account_id, bound_at) where status = 'active';

-- Never deleted; a removed row is terminal; a row never changes whose it is.
create function notification.guard_web_push_subscription_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'WEB_PUSH_SUBSCRIPTION_NOT_DELETABLE';
  end if;
  if old.status = 'removed' then
    raise exception using errcode = '55000', message = 'WEB_PUSH_SUBSCRIPTION_REMOVED_TERMINAL';
  end if;
  if new.id is distinct from old.id
     or new.account_id is distinct from old.account_id
     or new.patient_id is distinct from old.patient_id
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'WEB_PUSH_SUBSCRIPTION_IMMUTABLE';
  end if;
  return new;
end
$$;
create trigger web_push_subscriptions_guard
  before update or delete on notification.web_push_subscriptions
  for each row execute function notification.guard_web_push_subscription_mutation();

-- Row-level security: one policy for the owner, no grant.
alter table notification.web_push_subscriptions enable row level security;
alter table notification.web_push_subscriptions force row level security;
do $$
begin
  execute format('create policy web_push_subscriptions_owner on notification.web_push_subscriptions '
    || 'for all using (current_user = %L) with check (current_user = %L)', current_user, current_user);
end
$$;
revoke all on notification.web_push_subscriptions from public;

comment on table notification.web_push_subscriptions is
  '0097 (B6): a patient''s web push subscription, bound to the sign-in that turned it on; the endpoint only as AES-256-GCM ciphertext and its SHA-256, both erased on removal; delivery watermark, lease and retry state. Pushes carry no data. Never deleted; only the 0097 SECURITY DEFINER commands touch it.';

-- 2a. One audit row: ids, codes and counts only (never an endpoint, digest,
-- key or session id).
create function identity.web_push_audit(
  requested_actor_type text, requested_subject text, requested_account_id uuid, requested_patient_id uuid,
  requested_action text, requested_outcome text, requested_subscription_id uuid, requested_details jsonb
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details
  ) values (
    coalesce(platform.current_correlation_id(), 'system:web-push'), requested_actor_type,
    case when requested_actor_type = 'system' then null else requested_subject end,
    case when requested_actor_type = 'system' then null else requested_account_id end,
    requested_patient_id, requested_action, requested_outcome, 'web-push-subscription',
    requested_subscription_id::text, 'patient-self', 'application', 'identity-api',
    coalesce(requested_details, '{}'::jsonb)
  );
end
$$;

-- 2a. Remove one active subscription: the ciphertext and the digest erased,
-- the lease and the round cleared, one audit row. True when a row was removed.
create function identity.web_push_remove(requested_subscription_id uuid, requested_reason text,
  requested_actor_type text, requested_subject text, requested_account_id uuid)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  removed_patient uuid;
begin
  update notification.web_push_subscriptions as subscription
     set status = 'removed', endpoint_ciphertext = null, endpoint_sha256 = null,
         removed_at = clock_timestamp(), removal_reason = requested_reason,
         lease_owner = null, lease_expires_at = null, claimed_through = null, next_attempt_at = null,
         updated_at = clock_timestamp(), row_version = subscription.row_version + 1
   where subscription.id = requested_subscription_id and subscription.status = 'active'
  returning subscription.patient_id into removed_patient;
  if not found then
    return false;
  end if;
  perform identity.web_push_audit(requested_actor_type, requested_subject, requested_account_id, removed_patient,
    'identity.patient.web-push.removed', 'success', requested_subscription_id,
    jsonb_build_object('reason', requested_reason));
  return true;
end
$$;

-- 2a. Whether the sign-in a subscription belongs to is live (D5). Strict (the
-- claim) also refuses a temporarily disabled account; the prune does not, so
-- a temporary suspension pauses pushes without erasing the subscription.
create function identity.web_push_sign_in_live(requested_family uuid, requested_account uuid,
  requested_patient uuid, requested_strict boolean)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  return exists (
      select 1
        from auth.sessions session_row
        join auth.accounts account_row on account_row.id = session_row.account_id
        join identity.patients patient_row
          on patient_row.id = session_row.patient_id and patient_row.account_id = account_row.id
       where session_row.family_id = requested_family
         and session_row.account_id = requested_account
         and session_row.patient_id = requested_patient
         and session_row.session_kind = 'patient'
         and session_row.revoked_at is null
         and session_row.expires_at > clock_timestamp()
         and session_row.absolute_expires_at > clock_timestamp()
         and session_row.account_token_version = account_row.token_version
         and account_row.status = 'active'
         and (not coalesce(requested_strict, true)
              or account_row.disabled_until is null or account_row.disabled_until <= clock_timestamp())
         and patient_row.status = 'active')
    and not identity.patient_account_deletion_due(requested_account);
end
$$;

-- 2b. Turn notifications on for this device: store (or rebind) the browser's
-- subscription for the live patient session's sign-in. Under the account's
-- and the endpoint's transaction locks, in this order, so that the two
-- partial unique indexes never collide: (1) another account's active row
-- with this endpoint is removed (endpoint_reassigned: the device changed
-- hands); (2) this sign-in's active row with another endpoint is removed
-- (replaced_in_sign_in); (3) this account's active row with this endpoint is
-- bound to this sign-in and keeps its id (created false); (4) at 10 active
-- rows the least recently bound is removed (replaced_by_newer); (5) the row
-- is inserted (created true). The watermark starts now: older inbox items
-- cause no push.
create function identity.subscribe_my_web_push(requested_subject text, requested_session uuid,
  requested_subscription_id uuid, requested_endpoint_sha256 text, requested_endpoint_ciphertext bytea,
  requested_key_version text, requested_push_service text, requested_vapid_key_id text)
returns table (subscription_id uuid, created boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid;
  account_id_value uuid;
  family_id_value uuid;
  candidate record;
  existing_id uuid;
  existing_family uuid;
  rebound boolean := false;
  active_count integer;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'PATIENT_SESSION_REQUIRED';
  end if;
  if requested_subscription_id is null
     or requested_endpoint_sha256 is null or requested_endpoint_sha256 !~ '^[0-9a-f]{64}$'
     or requested_endpoint_ciphertext is null
     or octet_length(requested_endpoint_ciphertext) not between 30 and 2100
     or requested_key_version is null or requested_key_version !~ '^[A-Za-z0-9._:-]{1,64}$'
     or requested_push_service is null or requested_push_service not in ('fcm', 'mozilla', 'apple', 'windows')
     or requested_vapid_key_id is null or requested_vapid_key_id !~ '^[0-9a-f]{16}$' then
    raise exception using errcode = '22023', message = 'WEB_PUSH_SUBSCRIPTION_INVALID';
  end if;
  select session_row.account_id, session_row.family_id into account_id_value, family_id_value
    from auth.sessions session_row where session_row.id = requested_session;
  perform pg_advisory_xact_lock(hashtextextended('web-push-subscriptions:' || account_id_value::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('web-push-endpoint:' || requested_endpoint_sha256, 0));

  -- (1) The device changed hands: another account's row with this endpoint.
  for candidate in
    select subscription.id from notification.web_push_subscriptions subscription
     where subscription.status = 'active' and subscription.endpoint_sha256 = requested_endpoint_sha256
       and subscription.account_id <> account_id_value
     for update
  loop
    perform identity.web_push_remove(candidate.id, 'endpoint_reassigned', 'system', null, null);
  end loop;
  -- (2) One per sign-in: this sign-in's row with another endpoint.
  for candidate in
    select subscription.id from notification.web_push_subscriptions subscription
     where subscription.status = 'active' and subscription.session_family_id = family_id_value
       and subscription.endpoint_sha256 <> requested_endpoint_sha256
     for update
  loop
    perform identity.web_push_remove(candidate.id, 'replaced_in_sign_in', 'patient', requested_subject, account_id_value);
  end loop;
  -- (3) This endpoint is already this account's: bind it here, keep its id.
  select subscription.id, subscription.session_family_id into existing_id, existing_family
    from notification.web_push_subscriptions subscription
   where subscription.status = 'active' and subscription.endpoint_sha256 = requested_endpoint_sha256
     and subscription.account_id = account_id_value
   for update;
  if existing_id is not null then
    rebound := existing_family is distinct from family_id_value;
    update notification.web_push_subscriptions as subscription
       set session_family_id = family_id_value,
           delivered_through = case when rebound then clock_timestamp() else subscription.delivered_through end,
           attempt_count = 0, consecutive_rejections = 0, next_attempt_at = null,
           vapid_key_id = requested_vapid_key_id, bound_at = clock_timestamp(),
           updated_at = clock_timestamp(), row_version = subscription.row_version + 1
     where subscription.id = existing_id;
    perform identity.web_push_audit('patient', requested_subject, account_id_value, patient_id_value,
      'identity.patient.web-push.subscribed', 'success', existing_id,
      jsonb_build_object('pushService', requested_push_service, 'created', false, 'rebound', rebound));
    return query select existing_id, false;
    return;
  end if;
  -- (4) At most 10 per patient: the least recently bound make room.
  select count(*) into active_count from notification.web_push_subscriptions subscription
   where subscription.status = 'active' and subscription.account_id = account_id_value;
  if active_count >= 10 then
    for candidate in
      select subscription.id from notification.web_push_subscriptions subscription
       where subscription.status = 'active' and subscription.account_id = account_id_value
       order by subscription.bound_at, subscription.id
       limit active_count - 9
       for update
    loop
      perform identity.web_push_remove(candidate.id, 'replaced_by_newer', 'patient', requested_subject, account_id_value);
    end loop;
  end if;
  -- (5) A new subscription; older inbox items cause no push.
  insert into notification.web_push_subscriptions (
    id, account_id, patient_id, session_family_id, status, endpoint_sha256, endpoint_ciphertext,
    endpoint_key_version, push_service, vapid_key_id, delivered_through
  ) values (
    requested_subscription_id, account_id_value, patient_id_value, family_id_value, 'active',
    requested_endpoint_sha256, requested_endpoint_ciphertext, requested_key_version, requested_push_service,
    requested_vapid_key_id, clock_timestamp()
  );
  perform identity.web_push_audit('patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient.web-push.subscribed', 'success', requested_subscription_id,
    jsonb_build_object('pushService', requested_push_service, 'created', true, 'rebound', false));
  return query select requested_subscription_id, true;
end
$$;

-- 2b. Turn notifications off for this device: this account's active row with
-- that endpoint is removed (patient_turned_off). Idempotent: false when there
-- is none.
create function identity.unsubscribe_my_web_push(requested_subject text, requested_session uuid,
  requested_endpoint_sha256 text)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
  target_id uuid;
  removed boolean := false;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'PATIENT_SESSION_REQUIRED';
  end if;
  if requested_endpoint_sha256 is null or requested_endpoint_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'WEB_PUSH_SUBSCRIPTION_INVALID';
  end if;
  select session_row.account_id into account_id_value
    from auth.sessions session_row where session_row.id = requested_session;
  perform pg_advisory_xact_lock(hashtextextended('web-push-subscriptions:' || account_id_value::text, 0));
  select subscription.id into target_id from notification.web_push_subscriptions subscription
   where subscription.status = 'active' and subscription.endpoint_sha256 = requested_endpoint_sha256
     and subscription.account_id = account_id_value
   for update;
  if target_id is not null then
    removed := identity.web_push_remove(target_id, 'patient_turned_off', 'patient', requested_subject, account_id_value);
  end if;
  perform identity.web_push_audit('patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient.web-push.unsubscribed', 'success', target_id, jsonb_build_object('removed', removed));
  return removed;
end
$$;

-- 2b. The account's active subscriptions, most recently bound first; never
-- the endpoint, its ciphertext or a session id. No audit.
create function identity.list_my_web_push_subscriptions(requested_subject text, requested_session uuid)
returns table (subscription_id uuid, endpoint_sha256 text, push_service text, this_sign_in boolean,
  vapid_key_id text, created_at timestamptz, bound_at timestamptz, last_delivered_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid;
  account_id_value uuid;
  family_id_value uuid;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'PATIENT_SESSION_REQUIRED';
  end if;
  select session_row.account_id, session_row.family_id into account_id_value, family_id_value
    from auth.sessions session_row where session_row.id = requested_session;
  return query
    select subscription.id, subscription.endpoint_sha256::text, subscription.push_service,
           subscription.session_family_id = family_id_value, subscription.vapid_key_id::text,
           subscription.created_at, subscription.bound_at, subscription.last_delivered_at
      from notification.web_push_subscriptions subscription
     where subscription.status = 'active' and subscription.account_id = account_id_value
     order by subscription.bound_at desc, subscription.id desc;
end
$$;

-- 2c. The pushes due (system:auth): active subscriptions of this VAPID key,
-- not leased, past their retry time, not pushed in the last 2 minutes, with
-- an unread inbox item newer than their watermark, whose sign-in is live
-- (strict; others are left for the prune). Each is leased with the newest
-- such item as the round's claimed_through. Concurrent workers skip locked
-- rows; at most 500 candidates are examined per call.
create function identity.claim_web_push_deliveries(requested_worker text, requested_limit integer,
  requested_lease_seconds integer, requested_vapid_key_id text)
returns table (subscription_id uuid, endpoint_ciphertext bytea, endpoint_key_version text, push_service text,
  attempt_count integer, claimed_through timestamptz)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  candidate record;
  newest timestamptz;
  leased integer := 0;
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'A system notification context is required';
  end if;
  if requested_worker is null or requested_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     or requested_limit is null or requested_limit not between 1 and 50
     or requested_lease_seconds is null or requested_lease_seconds not between 15 and 600
     or requested_vapid_key_id is null or requested_vapid_key_id !~ '^[0-9a-f]{16}$' then
    raise exception using errcode = '22023', message = 'Invalid web push claim';
  end if;
  for candidate in
    select subscription.id, subscription.account_id, subscription.patient_id, subscription.session_family_id,
           subscription.delivered_through, subscription.endpoint_ciphertext, subscription.endpoint_key_version,
           subscription.push_service, subscription.attempt_count
      from notification.web_push_subscriptions subscription
     where subscription.status = 'active'
       and subscription.vapid_key_id = requested_vapid_key_id
       and (subscription.lease_expires_at is null or subscription.lease_expires_at <= clock_timestamp())
       and (subscription.next_attempt_at is null or subscription.next_attempt_at <= clock_timestamp())
       and (subscription.last_delivered_at is null
            or subscription.last_delivered_at <= clock_timestamp() - interval '2 minutes')
       and exists (select 1 from notification.inbox_items item
                    where item.account_id = subscription.account_id and item.read_at is null
                      and item.created_at > subscription.delivered_through)
     order by coalesce(subscription.next_attempt_at, subscription.bound_at), subscription.id
     limit 500
     for update of subscription skip locked
  loop
    if not identity.web_push_sign_in_live(candidate.session_family_id, candidate.account_id,
             candidate.patient_id, true) then
      continue;
    end if;
    select max(item.created_at) into newest from notification.inbox_items item
     where item.account_id = candidate.account_id and item.read_at is null
       and item.created_at > candidate.delivered_through;
    if newest is null then
      continue;
    end if;
    update notification.web_push_subscriptions as subscription
       set lease_owner = requested_worker,
           lease_expires_at = clock_timestamp() + make_interval(secs => requested_lease_seconds),
           claimed_through = newest, updated_at = clock_timestamp(), row_version = subscription.row_version + 1
     where subscription.id = candidate.id;
    return query select candidate.id, candidate.endpoint_ciphertext, candidate.endpoint_key_version,
      candidate.push_service, candidate.attempt_count::integer, newest;
    leased := leased + 1;
    exit when leased >= requested_limit;
  end loop;
end
$$;

-- 2c. The outcome of one push (system:auth), by the worker holding the
-- lease; anyone else's, or a removed row, answers lease_lost and changes
-- nothing. accepted -> delivered (the watermark advances); gone (404/410 from
-- the push service) -> removed; retry -> retrying after 1, 2, 4, 8, 16
-- minutes (or Retry-After, at most an hour), the sixth -> dropped (the round
-- is given up; the next new item tries again); rejected -> dropped and an
-- hour's wait, the third in a row -> removed.
create function identity.record_web_push_outcome(requested_subscription_id uuid, requested_worker text,
  requested_outcome text, requested_retry_after_seconds integer, requested_safe_code text)
returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_status text;
  current_owner text;
  current_patient uuid;
  current_attempts integer;
  current_rejections integer;
  next_attempt integer;
  next_rejection integer;
  delay_seconds integer;
  outcome_code text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'A system notification context is required';
  end if;
  if requested_outcome is null or requested_outcome not in ('accepted', 'gone', 'retry', 'rejected')
     or (requested_retry_after_seconds is not null and requested_retry_after_seconds not between 0 and 86400)
     or (requested_safe_code is not null and requested_safe_code !~ '^[a-z][a-z0-9_]{1,63}$') then
    raise exception using errcode = '22023', message = 'Invalid web push outcome';
  end if;
  select subscription.status, subscription.lease_owner, subscription.patient_id, subscription.attempt_count,
         subscription.consecutive_rejections
    into current_status, current_owner, current_patient, current_attempts, current_rejections
    from notification.web_push_subscriptions subscription
   where subscription.id = requested_subscription_id
   for update;
  if not found or current_status <> 'active' or current_owner is distinct from requested_worker then
    return 'lease_lost';
  end if;

  if requested_outcome = 'accepted' then
    update notification.web_push_subscriptions as subscription
       set delivered_through = greatest(subscription.delivered_through, subscription.claimed_through),
           last_delivered_at = clock_timestamp(), delivered_count = subscription.delivered_count + 1,
           attempt_count = 0, consecutive_rejections = 0, next_attempt_at = null, last_outcome_code = 'accepted',
           lease_owner = null, lease_expires_at = null, claimed_through = null,
           updated_at = clock_timestamp(), row_version = subscription.row_version + 1
     where subscription.id = requested_subscription_id;
    return 'delivered';
  end if;

  if requested_outcome = 'gone' then
    update notification.web_push_subscriptions as subscription
       set last_outcome_code = coalesce(requested_safe_code, 'gone'), updated_at = clock_timestamp(),
           row_version = subscription.row_version + 1
     where subscription.id = requested_subscription_id;
    perform identity.web_push_remove(requested_subscription_id, 'push_service_gone', 'system', null, null);
    return 'removed';
  end if;

  if requested_outcome = 'retry' then
    next_attempt := current_attempts + 1;
    if next_attempt >= 6 then
      update notification.web_push_subscriptions as subscription
         set delivered_through = greatest(subscription.delivered_through, subscription.claimed_through),
             attempt_count = 0, next_attempt_at = null, last_outcome_code = 'attempts_exhausted',
             lease_owner = null, lease_expires_at = null, claimed_through = null,
             updated_at = clock_timestamp(), row_version = subscription.row_version + 1
       where subscription.id = requested_subscription_id;
      perform identity.web_push_audit('system', null, null, current_patient, 'identity.patient.web-push.dropped',
        'failure', requested_subscription_id,
        jsonb_strip_nulls(jsonb_build_object('reason', 'attempts_exhausted', 'safeCode', requested_safe_code)));
      return 'dropped';
    end if;
    delay_seconds := greatest(least(3600, (60 * power(2, next_attempt - 1))::integer),
                              least(coalesce(requested_retry_after_seconds, 0), 3600));
    outcome_code := coalesce(requested_safe_code, 'retry');
    update notification.web_push_subscriptions as subscription
       set attempt_count = next_attempt,
           next_attempt_at = clock_timestamp() + make_interval(secs => delay_seconds),
           last_outcome_code = outcome_code,
           lease_owner = null, lease_expires_at = null, claimed_through = null,
           updated_at = clock_timestamp(), row_version = subscription.row_version + 1
     where subscription.id = requested_subscription_id;
    return 'retrying';
  end if;

  -- rejected
  next_rejection := current_rejections + 1;
  outcome_code := coalesce(requested_safe_code, 'rejected');
  if next_rejection >= 3 then
    update notification.web_push_subscriptions as subscription
       set last_outcome_code = outcome_code, updated_at = clock_timestamp(),
           row_version = subscription.row_version + 1
     where subscription.id = requested_subscription_id;
    perform identity.web_push_remove(requested_subscription_id, 'rejected_repeatedly', 'system', null, null);
    return 'removed';
  end if;
  update notification.web_push_subscriptions as subscription
     set delivered_through = greatest(subscription.delivered_through, subscription.claimed_through),
         attempt_count = 0, consecutive_rejections = next_rejection,
         next_attempt_at = clock_timestamp() + interval '1 hour', last_outcome_code = outcome_code,
         lease_owner = null, lease_expires_at = null, claimed_through = null,
         updated_at = clock_timestamp(), row_version = subscription.row_version + 1
   where subscription.id = requested_subscription_id;
  perform identity.web_push_audit('system', null, null, current_patient, 'identity.patient.web-push.dropped',
    'failure', requested_subscription_id, jsonb_build_object('reason', 'rejected', 'safeCode', outcome_code));
  return 'dropped';
end
$$;

-- 2c. Erase the subscriptions whose sign-in has ended (system:auth): up to
-- the limit, SKIP LOCKED; account_closed when the account or the patient is
-- not active or the deletion is due, otherwise session_ended. A temporarily
-- disabled account keeps its subscriptions (not strict). Returns the count.
create function identity.prune_web_push_subscriptions(requested_limit integer)
returns integer
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  candidate record;
  reason text;
  removed integer := 0;
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'A system notification context is required';
  end if;
  if requested_limit is null or requested_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Invalid web push prune';
  end if;
  for candidate in
    select subscription.id, subscription.account_id, subscription.patient_id
      from notification.web_push_subscriptions subscription
     where subscription.status = 'active'
       and not identity.web_push_sign_in_live(subscription.session_family_id, subscription.account_id,
             subscription.patient_id, false)
     order by subscription.bound_at, subscription.id
     limit requested_limit
     for update skip locked
  loop
    reason := case
      when exists (select 1 from auth.accounts account_row
                     join identity.patients patient_row on patient_row.account_id = account_row.id
                    where account_row.id = candidate.account_id and patient_row.id = candidate.patient_id
                      and account_row.status = 'active' and patient_row.status = 'active')
           and not identity.patient_account_deletion_due(candidate.account_id)
        then 'session_ended'
      else 'account_closed' end;
    if identity.web_push_remove(candidate.id, reason, 'system', null, null) then
      removed := removed + 1;
    end if;
  end loop;
  return removed;
end
$$;

-- 3. Account deletion (D12): 0096's completion sets auth.accounts.status to
-- 'deleted'; this erases that account's subscriptions in the same
-- transaction. It never raises (completion must not fail on it): any error
-- is reported as a warning with its code only, and the prune erases the rows
-- within a minute (the account is no longer active, so nothing is claimed
-- meanwhile).
create function notification.remove_web_push_for_deleted_account()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  candidate record;
begin
  begin
    for candidate in
      select subscription.id from notification.web_push_subscriptions subscription
       where subscription.account_id = new.id and subscription.status = 'active'
       order by subscription.id
       for update
    loop
      perform identity.web_push_remove(candidate.id, 'account_deleted', 'system', null, null);
    end loop;
  exception when others then
    raise warning using message = format(
      '0097: the web push subscriptions of a deleted account were left for the prune (sqlstate %s)', sqlstate);
  end;
  return null;
end
$$;
create trigger accounts_deleted_web_push
  after update of status on auth.accounts
  for each row when (new.status = 'deleted' and old.status is distinct from 'deleted')
  execute function notification.remove_web_push_for_deleted_account();

-- 5. Grants (here and in runtime-grants.sql).
revoke all on function identity.web_push_audit(text,text,uuid,uuid,text,text,uuid,jsonb),
  identity.web_push_remove(uuid,text,text,text,uuid),
  identity.web_push_sign_in_live(uuid,uuid,uuid,boolean),
  notification.remove_web_push_for_deleted_account(),
  notification.guard_web_push_subscription_mutation(),
  identity.subscribe_my_web_push(text,uuid,uuid,text,bytea,text,text,text),
  identity.unsubscribe_my_web_push(text,uuid,text),
  identity.list_my_web_push_subscriptions(text,uuid),
  identity.claim_web_push_deliveries(text,integer,integer,text),
  identity.record_web_push_outcome(uuid,text,text,integer,text),
  identity.prune_web_push_subscriptions(integer) from public;

do $$
declare grantee text;
begin
  foreach grantee in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant execute on function '
        || 'identity.subscribe_my_web_push(text,uuid,uuid,text,bytea,text,text,text), '
        || 'identity.unsubscribe_my_web_push(text,uuid,text), '
        || 'identity.list_my_web_push_subscriptions(text,uuid), '
        || 'identity.claim_web_push_deliveries(text,integer,integer,text), '
        || 'identity.record_web_push_outcome(uuid,text,text,integer,text), '
        || 'identity.prune_web_push_subscriptions(integer) to %I', grantee);
    end if;
  end loop;
end
$$;

-- 4. Post-checks (after the grants, so the ACLs are the final ones).
do $$
declare
  applier oid := (select oid from pg_roles where rolname = current_user);
  mismatch text;
begin
  -- The table, its indexes and its TOAST table belong to the applier; RLS is
  -- enabled and forced with exactly the one owner policy; only the owner
  -- holds any privilege on it.
  if exists (select 1 from pg_class relation
              where relation.oid in ('notification.web_push_subscriptions'::regclass,
                      'notification.web_push_subscriptions_pkey'::regclass,
                      'notification.web_push_subscriptions_endpoint_uq'::regclass,
                      'notification.web_push_subscriptions_sign_in_uq'::regclass,
                      'notification.web_push_subscriptions_account_idx'::regclass)
                and relation.relowner <> applier)
     or not exists (select 1 from pg_class relation
                     where relation.oid = 'notification.web_push_subscriptions'::regclass
                       and relation.relrowsecurity and relation.relforcerowsecurity)
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid = 'notification.web_push_subscriptions'::regclass) <> 1
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'notification.web_push_subscriptions'::regclass
                       and policy_row.polname = 'web_push_subscriptions_owner'
                       and policy_row.polpermissive and policy_row.polcmd = '*'
                       and policy_row.polroles = '{0}'::oid[]
                       and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                         = format('(CURRENT_USER = %L::name)', current_user)
                       and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid)
                         = format('(CURRENT_USER = %L::name)', current_user))
     or exists (select 1 from pg_class relation,
                  aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                 where relation.oid = 'notification.web_push_subscriptions'::regclass
                   and acl.grantee <> relation.relowner) then
    raise exception using errcode = '55000', message = '0097: the table is not as this file makes it';
  end if;
  -- Every new function belongs to the applier with this search_path; all but
  -- the guard are SECURITY DEFINER.
  select string_agg(proc.oid::regprocedure::text, ', ') into mismatch
    from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
   where (namespace.nspname, proc.proname) in (
           ('identity', 'web_push_audit'), ('identity', 'web_push_remove'), ('identity', 'web_push_sign_in_live'),
           ('notification', 'remove_web_push_for_deleted_account'),
           ('notification', 'guard_web_push_subscription_mutation'),
           ('identity', 'subscribe_my_web_push'), ('identity', 'unsubscribe_my_web_push'),
           ('identity', 'list_my_web_push_subscriptions'), ('identity', 'claim_web_push_deliveries'),
           ('identity', 'record_web_push_outcome'), ('identity', 'prune_web_push_subscriptions'))
     and (proc.proowner <> applier
       or proc.prosecdef <> (proc.proname <> 'guard_web_push_subscription_mutation')
       or proc.prolang <> (select language_row.oid from pg_language language_row where language_row.lanname = 'plpgsql')
       or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]);
  if mismatch is not null
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where (namespace.nspname, proc.proname) in (
           ('identity', 'web_push_audit'), ('identity', 'web_push_remove'), ('identity', 'web_push_sign_in_live'),
           ('notification', 'remove_web_push_for_deleted_account'),
           ('notification', 'guard_web_push_subscription_mutation'),
           ('identity', 'subscribe_my_web_push'), ('identity', 'unsubscribe_my_web_push'),
           ('identity', 'list_my_web_push_subscriptions'), ('identity', 'claim_web_push_deliveries'),
           ('identity', 'record_web_push_outcome'), ('identity', 'prune_web_push_subscriptions'))) <> 11 then
    raise exception using errcode = '55000',
      message = format('0097: a new function is not as this file makes it: %s', coalesce(mismatch, 'count'));
  end if;
  -- The function ACLs: the six commands to the owner and the two runtimes
  -- (each that exists holds EXECUTE), the five internal ones to the owner only;
  -- never PUBLIC.
  select string_agg(format('%s to %s', granted.what, granted.grantee_name), '; ') into mismatch
    from (
      select proc.oid::regprocedure::text as what,
             case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end as grantee_name
        from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where proc.oid in ('identity.web_push_audit(text,text,uuid,uuid,text,text,uuid,jsonb)'::regprocedure,
               'identity.web_push_remove(uuid,text,text,text,uuid)'::regprocedure,
               'identity.web_push_sign_in_live(uuid,uuid,uuid,boolean)'::regprocedure,
               'notification.remove_web_push_for_deleted_account()'::regprocedure,
               'notification.guard_web_push_subscription_mutation()'::regprocedure)
         and acl.grantee <> proc.proowner
      union all
      select proc.oid::regprocedure::text,
             case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
        from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where proc.oid in ('identity.subscribe_my_web_push(text,uuid,uuid,text,bytea,text,text,text)'::regprocedure,
               'identity.unsubscribe_my_web_push(text,uuid,text)'::regprocedure,
               'identity.list_my_web_push_subscriptions(text,uuid)'::regprocedure,
               'identity.claim_web_push_deliveries(text,integer,integer,text)'::regprocedure,
               'identity.record_web_push_outcome(uuid,text,text,integer,text)'::regprocedure,
               'identity.prune_web_push_subscriptions(integer)'::regprocedure)
         and acl.grantee <> proc.proowner
         and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) not in ('hid_identity_runtime', 'hid_schema_test_runtime')
              or acl.privilege_type <> 'EXECUTE')
      union all
      select proc.oid::regprocedure::text, 'missing ' || role_row.rolname
        from pg_proc proc cross join pg_roles role_row
       where proc.oid in ('identity.subscribe_my_web_push(text,uuid,uuid,text,bytea,text,text,text)'::regprocedure,
               'identity.unsubscribe_my_web_push(text,uuid,text)'::regprocedure,
               'identity.list_my_web_push_subscriptions(text,uuid)'::regprocedure,
               'identity.claim_web_push_deliveries(text,integer,integer,text)'::regprocedure,
               'identity.record_web_push_outcome(uuid,text,text,integer,text)'::regprocedure,
               'identity.prune_web_push_subscriptions(integer)'::regprocedure)
         and role_row.rolname in ('hid_identity_runtime', 'hid_schema_test_runtime')
         and not exists (select 1 from aclexplode(proc.proacl) acl
                          where acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')) granted;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0097: a function ACL is not section 5''s: %s', mismatch);
  end if;
  -- The two triggers are the ones this file creates.
  if not exists (select 1 from pg_trigger trigger_row
                  where trigger_row.tgrelid = 'auth.accounts'::regclass
                    and trigger_row.tgname = 'accounts_deleted_web_push' and trigger_row.tgenabled = 'O'
                    and pg_get_triggerdef(trigger_row.oid) = $t$CREATE TRIGGER accounts_deleted_web_push AFTER UPDATE OF status ON auth.accounts FOR EACH ROW WHEN (((new.status = 'deleted'::text) AND (old.status IS DISTINCT FROM 'deleted'::text))) EXECUTE FUNCTION notification.remove_web_push_for_deleted_account()$t$)
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'notification.web_push_subscriptions'::regclass
                       and trigger_row.tgname = 'web_push_subscriptions_guard' and trigger_row.tgenabled = 'O'
                       and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER web_push_subscriptions_guard BEFORE DELETE OR UPDATE ON notification.web_push_subscriptions FOR EACH ROW EXECUTE FUNCTION notification.guard_web_push_subscription_mutation()') then
    raise exception using errcode = '55000', message = '0097: a trigger is not as this file makes it';
  end if;
  -- The bodies relied on are unchanged.
  select string_agg(expected.proc, '; ') into mismatch
    from (values
      ('identity.patient_self_session(text,uuid)', '378cd66a28347ef82a7faee8d2c65a15'),
      ('identity.patient_account_deletion_due(uuid)', 'b032c1a385770e20e4930534a203863d'),
      ('identity.complete_patient_account_deletion(uuid,text)', 'a668a9b144b76fca197f6602a4097e65'),
      ('auth.protect_deleted_account()', '230114cc840d87d5b23cac8b6337f822'),
      ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', '0b5689f31a3ce00f9313fe1e55244fad'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0097: a body relied on changed: %s', mismatch);
  end if;
end
$$;
drop function pg_temp.web_push_0097_holds(oid, oid, aclitem[], "char", text);

comment on function identity.subscribe_my_web_push(text,uuid,uuid,text,bytea,text,text,text) is
  '0097 (B6): the live patient session turns notifications on for a browser: the endpoint''s SHA-256 and AES-256-GCM ciphertext, bound to the session''s sign-in; one per sign-in, at most 10 per patient, an endpoint on one account only.';
comment on function identity.unsubscribe_my_web_push(text,uuid,text) is
  '0097 (B6): the live patient session turns notifications off for a browser (by the endpoint''s SHA-256); idempotent.';
comment on function identity.list_my_web_push_subscriptions(text,uuid) is
  '0097 (B6): the account''s active subscriptions (digest, push service, whether bound to this sign-in, key id, times); never the endpoint.';
comment on function identity.claim_web_push_deliveries(text,integer,integer,text) is
  '0097 (B6): system:auth only. Leases the pushes due: a new unread inbox item, not pushed in 2 minutes, retry time passed, sign-in live, this VAPID key (1-50, SKIP LOCKED).';
comment on function identity.record_web_push_outcome(uuid,text,text,integer,text) is
  '0097 (B6): system:auth only. accepted, gone (removes), retry (1-16 minutes, the sixth drops the round), rejected (an hour; the third in a row removes).';
comment on function identity.prune_web_push_subscriptions(integer) is
  '0097 (B6): system:auth only. Erases subscriptions whose sign-in has ended (session_ended) or whose account or patient is closed or deletion-due (account_closed), 1-500, SKIP LOCKED.';
