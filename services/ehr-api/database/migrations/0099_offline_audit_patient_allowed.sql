-- 0099 Offline audit: may this staff session record an offline event about
-- this patient? (OFFLINE-CONTRACT.md amendment A10 item 1, after the review of
-- hid-system#131; owner decisions D1-D15 of 2026-10-29; the declaration signed
-- separately.) The EHR API's offline audit ingest (C2) accepts an event that
-- names a patient only if the caller's account, membership and facility once
-- held a consent grant for that patient; an unrelated patient answers as a
-- missing one (rejected: PATIENT_NOT_FOUND). This file adds the one check C2
-- asks, and nothing else: no table, policy, trigger or existing function
-- changes. Until it is applied, C2 answers 503 OFFLINE_AUDIT_UNAVAILABLE to a
-- request with a patient event and writes nothing (A10 item 1); session
-- events (unlock, wipe) never ask it.
--
-- D1 One function, ehr.offline_audit_patient_allowed(requested_patient_id),
--    true when identity.consent_grants holds a row with that patient_id whose
--    account_id, membership_id and facility_id are the request context's
--    (platform.current_account_id(), platform.current_membership_id(),
--    platform.current_facility_id(), the context the EHR API sets for every
--    request and the one consent_grants_actor_read compares), with scope
--    read_records or write_records, not break_glass, no migration_hold_reason
--    and starts_at <= now(). Anything else, a null argument included, is
--    false (not STRICT, so null answers false, never null). The account comes
--    from the actor subject through auth.account_id_for_subject, so a
--    disabled, temporarily disabled or deleted account gets false.
-- D2 Status, revoked_at and expires_at are deliberately ignored. An offline
--    read happens while the grant is open and may reach the server hours
--    later, after the grant expired, was revoked by the patient or closed by
--    the clinician. Its audit row must still be accepted: the audit records
--    what happened on the device, and the ingest is never gated on current
--    consent (A10 item 1: "expired or revoked grants still count"). The check
--    only stops a session from writing audit rows about a patient it never
--    had access to.
-- D3 Break-glass is excluded (owner decision D5 of 2026-10-29: break-glass,
--    emergency, records are never written to a device). No offline read can
--    come from a break-glass grant, so an event naming a patient whose only
--    grant was break-glass is refused. Both the scope and the flag are
--    tested: consent_grants_check3 binds scope = 'break_glass' to break_glass
--    only for source_system 'hid', and a legacy row may carry one without the
--    other.
-- D4 A grant held by the cutover (migration_hold_reason set) never authorized
--    a read, and one that has not started could not have authorized one yet,
--    so neither counts.
-- D5 It answers true or false about the caller's own grants only: the rows it
--    reads are among those consent_grants_actor_read already shows the
--    caller's account, membership and facility, and it returns no row.
--    Whether the session and membership are live is the EHR API's request
--    guard's question, as on every EHR route; this file reads only grants.
-- D6 The sealed demo (0098) is unchanged and needs nothing here: a grant links
--    a facility and a patient on the same side of the boundary
--    (consent_grants_sealed_demo, G1), so a demo session gets true only for a
--    demo patient and a real session only for a real one. No 0098 object is
--    read or changed.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0098 applied (0098's table and seal
--    trigger among the objects checked; the ledger is not read, so a dry run
--    of several pending files passes) and every object relied on exists (else
--    "0099: 0001-0098 must be applied first"); no function of this name
--    exists in schema ehr (else "0099: already applied"); the five bodies the
--    new one calls (the three context readers, platform.current_actor_subject
--    and auth.account_id_for_subject) are byte for byte the ones 0001-0098
--    gave them (md5 of pg_proc.prosrc); the eight columns it reads have the
--    types and NOT NULLs 0003 gave them and the scope CHECK and
--    consent_grants_check3 are 0003's; the applying role is the owner of
--    ehr.context_allows or a member of it that inherits its privileges and
--    may SET ROLE to it, and both may create in schema ehr; that owner may
--    read identity.consent_grants (ownership, membership or grant, never a
--    superuser's bypass) and execute the helpers.
-- 1. The function: SQL, STABLE, SECURITY DEFINER with search_path
--    pg_catalog, pg_temp (every name in the body is qualified), owned by
--    ehr.context_allows's owner (the applier, or, if the applier is a member,
--    given to that owner), so it reads identity.consent_grants as the existing
--    consent gate (ehr.context_allows, identity.has_active_consent_grant)
--    does. hid_ehr_runtime holds no privilege on any Identity table and gains
--    none. Whether or not that owner bypasses row-level security, the answer
--    is the same: the body's predicate includes consent_grants_actor_read's.
--    It reads consent_grants_authorization_idx (patient_id, membership_id,
--    facility_id, ...).
-- 2. Grants, here and in runtime-grants.sql: EXECUTE to hid_ehr_runtime only
--    (when the role exists; the ehr-api login inherits it); revoked from
--    PUBLIC; nothing to the Identity, Lab, Pharmacy, OCR, Outreach,
--    Notification or schema-test runtimes.
-- 3. Post-checks: exactly one function of this name; its owner is
--    ehr.context_allows's; SECURITY DEFINER, STABLE, SQL, not STRICT, this
--    search_path, boolean result, one uuid argument; its ACL holds only its
--    owner and, when the role exists, EXECUTE for hid_ehr_runtime.
--
-- Locks: creating a SQL function parses and analyzes its body
-- (check_function_bodies), which takes ACCESS SHARE on identity.consent_grants
-- until commit: the weakest lock, which conflicts only with ACCESS EXCLUSIVE
-- (DROP, TRUNCATE, most ALTER TABLE, VACUUM FULL) and never with a read or a
-- write, so sign-in, consent and clinical traffic do not wait. No other lock
-- on any application table, none on an existing function. Measured with
-- pg_locks before commit (the file applied in an open transaction on a copy
-- migrated through 0098): ACCESS SHARE on identity.consent_grants (and none
-- with check_function_bodies off, so it is the body's validation), SHARE
-- UPDATE EXCLUSIVE on the new function (its comment), ACCESS SHARE on schema
-- ehr and on the role hid_ehr_runtime (the grant), ACCESS EXCLUSIVE on the
-- session's own temporary schema (section 0's helper), the catalogs' own
-- locks; nothing else. Behind a held ACCESS EXCLUSIVE on the table the apply
-- waits the runner's lock_timeout (5 s), stops with 55P03 and applies nothing.
--
-- Old services on this schema: nothing calls the new function until the C2
-- follow-up of hid-system#131 ships; no image reads anything that changed.
-- Applied migrations 0001 through 0098 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0097's helper).
create function pg_temp.offline_audit_0099_holds(holder oid, object_owner oid, object_acl aclitem[],
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
  gate_owner oid;
begin
  -- a. Prerequisites (0001-0098).
  if to_regclass('identity.consent_grants') is null
     or to_regclass('identity.sealed_demo_members') is null
     or to_regprocedure('identity.consent_grants_sealed_demo()') is null
     or to_regprocedure('ehr.context_allows(uuid,uuid,text)') is null
     or to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('platform.current_account_id()') is null
     or to_regprocedure('platform.current_membership_id()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'identity.consent_grants'::regclass
                       and trigger_row.tgname = 'consent_grants_sealed_demo') then
    raise exception using errcode = '55000', message = '0099: 0001-0098 must be applied first';
  end if;
  -- b. Not applied yet.
  if exists (select 1 from pg_proc proc
              where proc.pronamespace = 'ehr'::regnamespace and proc.proname = 'offline_audit_patient_allowed') then
    raise exception using errcode = '55000', message = '0099: already applied';
  end if;
  -- c. The bodies the new one calls, as 0001-0098 left them: the context
  -- readers (0001, 0002) and the account lookup (0008).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0099: a function this migration relies on has another body than 0001-0098 gave it: %s', mismatch);
  end if;
  -- d. The columns the body reads and the CHECKs that give scope and
  -- break_glass their meaning.
  select string_agg(format('identity.consent_grants.%s', expected.column_name), '; ') into mismatch
    from (values
      ('patient_id', 'uuid', true),
      ('account_id', 'uuid', true),
      ('membership_id', 'uuid', true),
      ('facility_id', 'uuid', false),
      ('scope', 'text', true),
      ('break_glass', 'boolean', true),
      ('migration_hold_reason', 'text', false),
      ('starts_at', 'timestamp with time zone', true))
         expected(column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = 'identity.consent_grants'::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is null then
    select string_agg(expected.what, '; ') into mismatch
      from (values
        ('consent_grants_scope_check',
         $c$CHECK ((scope = ANY (ARRAY['read_records'::text, 'write_records'::text, 'break_glass'::text])))$c$),
        ('consent_grants_check3',
         $c$CHECK ((((scope = 'break_glass'::text) = break_glass) OR (source_system <> 'hid'::text)))$c$))
           expected(what, definition)
     where not exists (select 1 from pg_constraint constraint_row
                        where constraint_row.conrelid = 'identity.consent_grants'::regclass
                          and constraint_row.contype = 'c' and constraint_row.conname = expected.what
                          and pg_get_constraintdef(constraint_row.oid) = expected.definition);
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0099: a column or CHECK this migration relies on differs from 0001-0098: %s', mismatch);
  end if;
  -- e. Ownership and privileges, never through a superuser's bypass
  -- (production's migrator has none). The new function will belong to
  -- ehr.context_allows's owner.
  gate_owner := (select proc.proowner from pg_proc proc where proc.oid = 'ehr.context_allows(uuid,uuid,text)'::regprocedure);
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not %s and may not act as it (INHERIT and SET)', current_user, pg_get_userbyid(gate_owner))
             as what
       where applier <> gate_owner
         and not (pg_has_role(applier, gate_owner, 'USAGE') and pg_has_role(applier, gate_owner, 'SET'))
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(wanted.holder), wanted.privilege, namespace.nspname)
        from (values (applier, 'ehr', 'CREATE'), (gate_owner, 'ehr', 'CREATE'),
                     (gate_owner, 'ehr', 'USAGE'), (gate_owner, 'identity', 'USAGE'),
                     (gate_owner, 'platform', 'USAGE'), (gate_owner, 'auth', 'USAGE'))
               wanted(holder, schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.offline_audit_0099_holds(wanted.holder, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks SELECT on %s', pg_get_userbyid(gate_owner), relation.oid::regclass)
        from pg_class relation
       where relation.oid = 'identity.consent_grants'::regclass
         and not pg_temp.offline_audit_0099_holds(gate_owner, relation.relowner, relation.relacl, 'r', 'SELECT')
      union all
      select format('%s lacks EXECUTE on %s', pg_get_userbyid(gate_owner), proc.oid::regprocedure)
        from (values ('platform.current_account_id()'), ('platform.current_membership_id()'),
                     ('platform.current_facility_id()'), ('platform.current_actor_subject()'),
                     ('auth.account_id_for_subject(text)')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
       where not pg_temp.offline_audit_0099_holds(gate_owner, proc.proowner, proc.proacl, 'f', 'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0099: missing privileges: %s', mismatch);
  end if;
  raise notice '0099: owners checked: ehr.context_allows=%, identity.consent_grants=%, applier=%',
    pg_get_userbyid(gate_owner),
    (select pg_get_userbyid(relation.relowner) from pg_class relation
      where relation.oid = 'identity.consent_grants'::regclass),
    current_user;
end
$$;

-- 1. The function.
create function ehr.offline_audit_patient_allowed(requested_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
      from identity.consent_grants grant_row
     where grant_row.patient_id = requested_patient_id
       and grant_row.account_id = platform.current_account_id()
       and grant_row.membership_id = platform.current_membership_id()
       and grant_row.facility_id = platform.current_facility_id()
       and grant_row.scope in ('read_records', 'write_records')
       and not grant_row.break_glass
       and grant_row.migration_hold_reason is null
       and grant_row.starts_at <= now()
  )
$$;

comment on function ehr.offline_audit_patient_allowed(uuid) is
  'C2 offline audit (OFFLINE-CONTRACT A10 item 1): whether the request context''s account, membership and facility ever held a started, non-break-glass, non-held read or write grant for the patient. Ignores status and expiry on purpose.';

-- The owner of ehr.context_allows owns it (a no-op when the applier is that
-- owner, as on every database built by one migration login).
do $$
declare
  gate_owner oid := (select proc.proowner from pg_proc proc
                      where proc.oid = 'ehr.context_allows(uuid,uuid,text)'::regprocedure);
begin
  if (select proc.proowner from pg_proc proc
       where proc.oid = 'ehr.offline_audit_patient_allowed(uuid)'::regprocedure) <> gate_owner then
    execute format('alter function ehr.offline_audit_patient_allowed(uuid) owner to %I', pg_get_userbyid(gate_owner));
  end if;
end
$$;

-- 2. Grants (here and in runtime-grants.sql).
revoke all on function ehr.offline_audit_patient_allowed(uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.offline_audit_patient_allowed(uuid) to hid_ehr_runtime;
  end if;
end
$$;

-- 3. Post-checks (after the grants, so the ACL is the final one).
do $$
declare
  mismatch text;
begin
  select format('owner=%s definer=%s volatile=%s language=%s strict=%s config=%s result=%s arguments=%s',
           pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile, language_row.lanname,
           proc.proisstrict, proc.proconfig, proc.prorettype::regtype, proc.proargtypes::regtype[])
    into mismatch
    from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
   where proc.oid = 'ehr.offline_audit_patient_allowed(uuid)'::regprocedure
     and (proc.proowner <> (select gate.proowner from pg_proc gate
                             where gate.oid = 'ehr.context_allows(uuid,uuid,text)'::regprocedure)
       or not proc.prosecdef or proc.provolatile <> 's' or language_row.lanname <> 'sql' or proc.proisstrict
       or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]
       or proc.prorettype <> 'boolean'::regtype or proc.pronargs <> 1
       or proc.proargtypes[0] <> 'uuid'::regtype);
  if mismatch is not null
     or (select count(*) from pg_proc proc
          where proc.pronamespace = 'ehr'::regnamespace and proc.proname = 'offline_audit_patient_allowed') <> 1 then
    raise exception using errcode = '55000',
      message = format('0099: the function is not as this file makes it: %s', coalesce(mismatch, 'count'));
  end if;
  select string_agg(granted.what, '; ') into mismatch
    from (
      select case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
             || ' ' || acl.privilege_type as what
        from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where proc.oid = 'ehr.offline_audit_patient_allowed(uuid)'::regprocedure
         and acl.grantee <> proc.proowner
         and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime' or acl.privilege_type <> 'EXECUTE')
      union all
      select 'missing hid_ehr_runtime EXECUTE'
        from pg_roles role_row
       where role_row.rolname = 'hid_ehr_runtime'
         and not exists (select 1 from pg_proc proc, aclexplode(proc.proacl) acl
                          where proc.oid = 'ehr.offline_audit_patient_allowed(uuid)'::regprocedure
                            and acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')) granted;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0099: the function''s ACL is not section 2''s: %s', mismatch);
  end if;
end
$$;
