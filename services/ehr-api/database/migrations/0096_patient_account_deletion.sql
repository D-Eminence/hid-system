-- 0096 Delete my account (B5; owner decisions of 2026-10-28, migrations
-- pre-approved for this batch, the declaration signed separately): main's
-- 0064 patient login/account deletion lifecycle, adapted to this branch.
--
-- Account deletion closes the authentication login bound to a canonical
-- patient. It revokes credentials, sessions, federated links, the patient
-- access PIN, patient-granted sharing (approvals, PIN grants and 0095's
-- shares) and notification registrations. It does not delete or de-identify
-- the canonical patient, the NIN binding, clinical records, consent and access
-- evidence, audit/security evidence, authentication or notification history:
-- every record class is retained (DATABASE.md 3.5 and 15 gate erasure, so the
-- retention model admits only the `retain` disposition and never purges). A
-- patient may exist without a login, so the patient record stays active for
-- clinical continuity and break-glass is unchanged.
--
-- Decision D11 (contract b45-contract.md): main's rules as they are: a
-- 14-day waiting period the patient can cancel, a 10-minute single-use
-- confirmation token (only its SHA-256 is stored), 5 requests a day and 5
-- confirmation attempts per request, the typed phrase DELETE MY ACCOUNT;
-- legal holds and workforce accounts block deletion. Added on this branch:
-- the workforce test is 0093's (a staff record, an unrevoked
-- auth.account_roles row, or any facility membership); emails when deletion
-- is scheduled, cancelled and completed (durable rows the sweeper sends);
-- inbox notices when it is scheduled, cancelled and blocked; and completion
-- also closes this branch's newer patient-owned items: emergency contacts
-- (deactivated, 'account_deleted', the contact erased as 0084's CHECK
-- requires), open share invitations (cancelled), pending contact changes
-- (invalidated, 'contact_unavailable', the new contact erased as 0094's
-- supersede path does) and pending records-opened emails (suppressed). The
-- recovery hold on the request is Identity's (requireNoRecentRecoveryHold).
--
-- 0. Preconditions (catalog reads only): every prerequisite exists (0001-0095
--    applied); no object of this migration exists (else 55000 "0096: already
--    applied"); the two bodies replaced in section 4 are 0030's and the
--    six bodies the new ones call or rely on are those 0001-0095 gave them
--    (md5 of pg_proc.prosrc); the 36 CHECKs completion's writes must pass
--    (sessions, session events, accounts, federated links, the PIN, grants,
--    access requests, device registrations, emergency contacts, contact
--    changes, share invitations, records-opened notices and the inbox) are
--    as 0001-0095 made them; no trigger named accounts_deleted_terminal
--    exists; the applying role, which will own every new table and
--    function, holds (by ownership, membership or grant, never a superuser's
--    bypass) what the new bodies read and write: it owns the tables with
--    row-level security that completion writes (identity.patients,
--    identity.consent_grants, identity.access_requests,
--    identity.patient_contact_changes, identity.patient_share_invitations,
--    identity.record_access_notices), may update auth.accounts,
--    auth.sessions, auth.external_identities, identity.patient_access_pins,
--    notification.device_registrations and identity.patient_emergency_contacts,
--    insert auth.session_events and audit.events, read the workforce tables,
--    reference auth.accounts and identity.patients, create a trigger on
--    auth.accounts, create in schemas auth, identity and platform and
--    execute every function called; the owner policies of the three tables
--    with forced row-level security that completion writes name it; and it
--    owns the two replaced functions. Every attribute of a replaced function but the body is
--    recorded and compared after the replacement (section 5).
--    Then the two locks the new foreign keys and the trigger need are taken
--    (see Locks).
-- 1. Tables (row-level security forced, one policy for their owner, no grant
--    to any role; only the SECURITY DEFINER commands touch them):
--    a. platform.record_class_retention_policies: the seven record classes,
--       `retain` only, no automatic purge.
--    b. platform.legal_holds, with its guard trigger: released, never
--       deleted or rewritten; no runtime role can place or release one.
--    c. platform.patient_account_deletion_settings: 14 days, 10 minutes, 5
--       requests a day, 5 attempts.
--    d. identity.patient_account_deletion_requests: main's lifecycle
--       (awaiting_confirmation -> pending -> completed, or blocked,
--       cancelled, expired, superseded); one open request per login; never
--       deleted. requested_session_id has no foreign key to auth.sessions
--       (a hot table; the commands bind the session through
--       identity.patient_self_session).
--    e. identity.patient_account_deletion_notices: one email per request and
--       kind (scheduled, cancelled, completed) with its delivery state
--       (pending, delivered, failed, not_sent), lease and retry; never
--       deleted.
-- 2. auth.protect_deleted_account() and the trigger accounts_deleted_terminal
--    on auth.accounts, fired only for a row that is already deleted: a
--    deleted login is never reactivated, given a password, a lower token
--    version or another subject.
-- 3. Functions, each SECURITY DEFINER with search_path pg_catalog, pg_temp:
--    a. identity.patient_account_deletion_due(account) (internal);
--    b. platform.evaluate_patient_account_deletion(account, patient)
--       (internal): the record classes, an active legal hold, 0093's
--       workforce test;
--    c. identity.complete_patient_account_deletion(request, actor)
--       (internal): main's completion and this branch's closures, a
--       'completed' email row, three audit rows and the summary;
--    d. identity.my_account_deletion_status / request_my_account_deletion /
--       confirm_my_account_deletion / cancel_my_account_deletion: bound to
--       identity.patient_self_session(subject, session) (42501 without a
--       live patient session); confirmation denials return a non-disclosing
--       outcome so their audit and attempt counter commit;
--    e. identity.finalize_due_patient_account_deletions(limit) (system:auth,
--       SKIP LOCKED, 1-50);
--    f. identity.claim_account_deletion_notices / record_account_deletion_
--       notice_outcome (system:auth): the recipient is the account's email
--       once verified, whatever the account's status; at most 5 attempts
--       within 24 hours.
--    Internal, granted to no role: a, b, c, identity.account_deletion_audit
--    and the two trigger functions. Every write and every refusal that
--    commits (a confirmation denial, a block) records its audit.events row
--    (ids, codes and counts only; never an address or a token); a refusal
--    that raises (already pending, rate limited, not cancellable) rolls back,
--    and Identity's audit interceptor records it (@AuditFailuresOnly).
-- 4. identity.current_patient_account(text) and
--    identity.patient_self_session(text,uuid), replaced: 0030's bodies with
--    `and not identity.patient_account_deletion_due(a.id)` appended, as main.
--    A login stops working at scheduled_for, before the finalizer runs.
--    Signature, result, language (sql), volatility, SECURITY DEFINER,
--    search_path, owner and ACL are unchanged. The two are created with
--    check_function_bodies off so that creating them reads (and locks) no
--    table; section 5 compares their bodies byte for byte.
-- 5. Post-checks: the replaced functions keep every attribute but the body
--    and their bodies are the ones this file gives them; every new table and
--    function belongs to the applying role; RLS is forced on the five
--    tables; the commands are SECURITY DEFINER with this search_path; the
--    settings row and the seven retention rows exist; the trigger is on
--    auth.accounts.
-- 6. Grants, here and in runtime-grants.sql: the seven commands to
--    hid_identity_runtime and hid_schema_test_runtime; nothing to
--    hid_ehr_runtime; no grant on any table; every new function revoked
--    from PUBLIC. The replaced functions keep their ACLs.
--
-- Inbox (notification.enqueue_patient_inbox_item, resource type
-- account-deletion, the request id): ACCOUNT_DELETION_SCHEDULED
-- {scheduledFor} at confirmation, ACCOUNT_DELETION_CANCELLED {} when a
-- pending deletion is cancelled, ACCOUNT_DELETION_BLOCKED {reasonCode} when
-- blocked at confirmation or finalization. Completion writes none: the login
-- is deleted and the enqueue answers NULL.
--
-- Locks: SHARE ROW EXCLUSIVE on auth.accounts and identity.patients (the new
-- foreign keys and the trigger), taken up front in that order (0094's:
-- registration writes accounts and then patients), NOWAIT every 10 ms for at
-- most 5 seconds (then 55P03, nothing applied), held to commit: they block
-- writes to those two tables (sign-up, sign-in's account updates, profile
-- changes) for the apply, never reads. No existing table is altered; no lock
-- on auth.sessions (no foreign key to it). Replacing the two functions
-- neither waits for nor blocks their calls. Every new body but the two
-- replaced ones and the due check is PL/pgSQL; the three SQL bodies are
-- created with check_function_bodies off, so creating a function reads no
-- table. Measured with pg_locks before commit (the file applied in an open
-- transaction on a copy migrated through 0095): SHARE ROW EXCLUSIVE and
-- ACCESS SHARE on auth.accounts and identity.patients, ACCESS SHARE on their
-- primary keys; ACCESS EXCLUSIVE (and the weaker locks creating them takes)
-- on the five new tables, their indexes and TOAST tables; ACCESS SHARE on
-- platform.reject_mutation, platform.guard_legal_hold_mutation and
-- auth.protect_deleted_account (the triggers); SHARE UPDATE EXCLUSIVE on the
-- four functions commented; ACCESS EXCLUSIVE on section 0's own temporary
-- table and helper and the session's temporary schema; the
-- catalogs' own locks; no lock on any other application table (none on
-- auth.sessions, audit.events, identity.consent_grants, the workforce tables,
-- notification.inbox_items or the 0094/0095 tables) and none on the replaced
-- functions. The timings and the busy-table test are in
-- config/production-schema-compatibility.json.
--
-- Old services on this schema: old images call none of the new commands and
-- read none of the new tables. The replaced patient_self_session and
-- current_patient_account answer exactly as before for any account with no
-- due deletion, and no deletion can be requested before the new Identity
-- image serves it. The new trigger fires only for an account that is
-- already deleted, which no current code changes. EHR, Lab, Pharmacy and
-- Notification are untouched. Applied migrations 0001 through 0095 are
-- immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0090's to 0095's helper).
create function pg_temp.deletion_0096_holds(holder oid, object_owner oid, object_acl aclitem[],
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

create temporary table deletion_0096_replaced as
  select proc.oid, proc.oid::regprocedure::text as what, proc.proowner, proc.proacl, proc.prolang,
         proc.provolatile, proc.prosecdef, proc.proconfig, proc.prorettype, proc.proretset,
         proc.proargnames, proc.proallargtypes
    from pg_proc proc
   where proc.oid in (to_regprocedure('identity.current_patient_account(text)'),
                      to_regprocedure('identity.patient_self_session(text,uuid)'));

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  -- a. Prerequisites (0001-0095).
  if to_regclass('auth.accounts') is null
     or to_regclass('auth.sessions') is null
     or to_regclass('auth.session_events') is null
     or to_regclass('auth.external_identities') is null
     or to_regclass('auth.account_roles') is null
     or to_regclass('identity.patients') is null
     or to_regclass('identity.patient_access_pins') is null
     or to_regclass('identity.consent_grants') is null
     or to_regclass('identity.access_requests') is null
     or to_regclass('identity.staff') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('identity.patient_emergency_contacts') is null
     or to_regclass('identity.patient_contact_changes') is null
     or to_regclass('identity.patient_share_invitations') is null
     or to_regclass('identity.record_access_notices') is null
     or to_regclass('notification.device_registrations') is null
     or to_regclass('notification.inbox_items') is null
     or to_regclass('audit.events') is null
     or to_regprocedure('identity.current_patient_account(text)') is null
     or to_regprocedure('identity.patient_self_session(text,uuid)') is null
     or to_regprocedure('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)') is null
     or to_regprocedure('identity.guard_share_invitation_mutation()') is null then
    raise exception using errcode = '55000', message = '0096: 0001-0095 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('platform.record_class_retention_policies') is not null
     or to_regclass('platform.legal_holds') is not null
     or to_regclass('platform.patient_account_deletion_settings') is not null
     or to_regclass('identity.patient_account_deletion_requests') is not null
     or to_regclass('identity.patient_account_deletion_notices') is not null
     or exists (select 1 from pg_trigger trigger_row
                 where trigger_row.tgrelid = 'auth.accounts'::regclass
                   and trigger_row.tgname = 'accounts_deleted_terminal')
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where (namespace.nspname, proc.proname) in (
                   ('auth', 'protect_deleted_account'), ('platform', 'guard_legal_hold_mutation'),
                   ('identity', 'patient_account_deletion_due'), ('platform', 'evaluate_patient_account_deletion'),
                   ('identity', 'complete_patient_account_deletion'), ('identity', 'account_deletion_audit'),
                   ('identity', 'my_account_deletion_status'), ('identity', 'request_my_account_deletion'),
                   ('identity', 'confirm_my_account_deletion'), ('identity', 'cancel_my_account_deletion'),
                   ('identity', 'finalize_due_patient_account_deletions'),
                   ('identity', 'claim_account_deletion_notices'),
                   ('identity', 'record_account_deletion_notice_outcome'))) then
    raise exception using errcode = '55000', message = '0096: already applied';
  end if;
  -- c. The bodies replaced (section 4), as 0030 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.current_patient_account(text)', '6c264821fe696a8c4c06667e4179b4c3'),
      ('identity.patient_self_session(text,uuid)', 'd4c7aeaf25317d0fae794a2764d7d72b'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0096: a function this migration replaces has another body than 0001-0095 gave it: %s', mismatch);
  end if;
  -- d. The bodies the new ones call or rely on, unchanged: the request
  -- context readers, the inbox enqueue (0087: NULL for a deleted login), the
  -- share invitations' guard (0095: pending and accepted may become
  -- cancelled), the audit table's triggers and the no-delete trigger.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', '0b5689f31a3ce00f9313fe1e55244fad'),
      ('identity.guard_share_invitation_mutation()', '02a241c0f6df3f02e48f4d820ae7cf55'),
      ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0096: a function this migration relies on has another body than 0001-0095 gave it: %s', mismatch);
  end if;
  -- e. The CHECKs completion's writes pass, as 0001-0095 made them.
  select string_agg(format('%s.%s: %s', expected.relation_name, expected.what, coalesce(actual.definition, 'missing')), '; ')
    into mismatch
    from (values
      ('auth.sessions', 'sessions_check2', 'CHECK (((revoked_at IS NULL) OR (revocation_reason IS NOT NULL)))'),
      ('auth.session_events', 'session_events_event_type_check',
       $c$CHECK ((event_type = ANY (ARRAY['login_succeeded'::text, 'login_failed'::text, 'refresh'::text, 'rotated'::text, 'revoked'::text, 'logout'::text, 'expired'::text, 'reuse_detected'::text])))$c$),
      ('auth.session_events', 'session_events_outcome_check',
       $c$CHECK ((outcome = ANY (ARRAY['success'::text, 'denied'::text, 'failure'::text])))$c$),
      ('auth.accounts', 'accounts_status_check',
       $c$CHECK ((status = ANY (ARRAY['active'::text, 'pending_reset'::text, 'locked'::text, 'disabled'::text, 'deleted'::text])))$c$),
      ('auth.accounts', 'accounts_check', 'CHECK (((password_hash IS NULL) = (password_algorithm IS NULL)))'),
      ('auth.accounts', 'accounts_token_version_check', 'CHECK ((token_version > 0))'),
      ('auth.external_identities', 'external_identities_status_check',
       $c$CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'disabled'::text])))$c$),
      ('identity.patient_access_pins', 'patient_access_pins_status_check',
       $c$CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'revoked'::text])))$c$),
      ('identity.patient_access_pins', 'patient_access_pins_check', $c$CHECK (((status = 'active'::text) = (disabled_at IS NULL)))$c$),
      ('identity.patient_access_pins', 'patient_access_pins_check1', $c$CHECK (((status = 'active'::text) = (disabled_reason IS NULL)))$c$),
      ('identity.patient_access_pins', 'patient_access_pins_disabled_reason_check',
       'CHECK (((disabled_reason IS NULL) OR ((length(btrim(disabled_reason)) >= 8) AND (length(btrim(disabled_reason)) <= 500))))'),
      ('identity.consent_grants', 'consent_grants_status_check',
       $c$CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'expired'::text])))$c$),
      ('identity.consent_grants', 'consent_grants_check2',
       $c$CHECK ((((status = 'revoked'::text) = (revoked_at IS NOT NULL)) OR (source_system <> 'hid'::text)))$c$),
      ('identity.access_requests', 'access_requests_status_check',
       $c$CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'revoked'::text, 'expired'::text])))$c$),
      ('identity.access_requests', 'access_requests_check1',
       $c$CHECK ((((status = 'approved'::text) = (approved_at IS NOT NULL)) OR (source_system <> 'hid'::text)))$c$),
      ('notification.device_registrations', 'device_registrations_status_check',
       $c$CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'invalid'::text])))$c$),
      ('notification.device_registrations', 'device_registrations_check',
       $c$CHECK (((status = 'active'::text) = (revoked_at IS NULL)))$c$),
      ('notification.device_registrations', 'device_registrations_check1',
       'CHECK (((revoked_at IS NULL) = (revocation_reason_code IS NULL)))'),
      ('notification.device_registrations', 'device_registrations_revocation_reason_code_check',
       $c$CHECK (((revocation_reason_code IS NULL) OR (revocation_reason_code ~ '^[A-Z][A-Z0-9_]{1,79}$'::text)))$c$),
      ('identity.patient_emergency_contacts', 'patient_emergency_contacts_check1',
       $c$CHECK (((status = 'deactivated'::text) = (deactivated_at IS NOT NULL)))$c$),
      ('identity.patient_emergency_contacts', 'patient_emergency_contacts_check2',
       'CHECK (((deactivated_at IS NULL) = (deactivation_reason IS NULL)))'),
      ('identity.patient_emergency_contacts', 'patient_emergency_contacts_check4',
       $c$CHECK (((status <> 'deactivated'::text) OR ((contact_ciphertext IS NULL) AND (contact_key_version IS NULL) AND (destination_hmac IS NULL))))$c$),
      ('identity.patient_emergency_contacts', 'patient_emergency_contacts_deactivation_reason_check',
       $c$CHECK (((deactivation_reason IS NULL) OR (deactivation_reason = ANY (ARRAY['patient_removed'::text, 'patient_replaced'::text, 'contact_opted_out'::text, 'account_deleted'::text]))))$c$),
      ('identity.patient_contact_changes', 'patient_contact_changes_state_check',
       $c$CHECK ((state = ANY (ARRAY['pending'::text, 'completed'::text, 'invalidated'::text])))$c$),
      ('identity.patient_contact_changes', 'patient_contact_changes_check5',
       $c$CHECK (((state = 'invalidated'::text) = (invalidated_at IS NOT NULL)))$c$),
      ('identity.patient_contact_changes', 'patient_contact_changes_check6',
       'CHECK (((invalidated_at IS NULL) = (invalidation_reason IS NULL)))'),
      ('identity.patient_contact_changes', 'patient_contact_changes_check8',
       $c$CHECK (((state <> 'invalidated'::text) OR (new_ciphertext IS NULL)))$c$),
      ('identity.patient_contact_changes', 'patient_contact_changes_invalidation_reason_check',
       $c$CHECK (((invalidation_reason IS NULL) OR (invalidation_reason = ANY (ARRAY['superseded'::text, 'expired'::text, 'attempts_exhausted'::text, 'delivery_failed'::text, 'contact_unavailable'::text, 'workforce_account'::text]))))$c$),
      ('identity.patient_share_invitations', 'patient_share_invitations_status_check',
       $c$CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'confirmed'::text, 'cancelled'::text, 'expired'::text])))$c$),
      ('identity.patient_share_invitations', 'patient_share_invitations_check7',
       $c$CHECK (((status = 'cancelled'::text) = (cancelled_at IS NOT NULL)))$c$),
      ('identity.record_access_notices', 'record_access_notices_email_status_check',
       $c$CHECK ((email_status = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text, 'not_sent'::text, 'suppressed'::text])))$c$),
      ('identity.record_access_notices', 'record_access_notices_check', 'CHECK (((lease_owner IS NULL) = (lease_expires_at IS NULL)))'),
      ('identity.record_access_notices', 'record_access_notices_check2',
       $c$CHECK (((email_status = 'pending'::text) OR (lease_owner IS NULL)))$c$),
      ('notification.inbox_items', 'inbox_items_notification_code_check',
       $c$CHECK ((notification_code ~ '^[A-Z][A-Z0-9_]{2,79}$'::text))$c$),
      ('notification.inbox_items', 'inbox_items_resource_type_check',
       $c$CHECK (((resource_type IS NULL) OR (resource_type ~ '^[a-z][a-z0-9._:-]{1,63}$'::text)))$c$),
      ('notification.inbox_items', 'inbox_items_metadata_check', $c$CHECK ((jsonb_typeof(metadata) = 'object'::text))$c$))
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
      message = format('0096: a CHECK this migration relies on differs from 0001-0095: %s', mismatch);
  end if;
  -- f. Privileges, never through a superuser's bypass (production's migrator
  -- has none).
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s lacks %s on %s', holder.rolname, wanted.privilege, relation.oid::regclass) as what
        from (values
          ('identity.patients', 'OWNER'), ('identity.consent_grants', 'OWNER'),
          ('identity.access_requests', 'OWNER'), ('identity.patient_contact_changes', 'OWNER'),
          ('identity.patient_share_invitations', 'OWNER'), ('identity.record_access_notices', 'OWNER'),
          ('auth.accounts', 'SELECT'), ('auth.accounts', 'UPDATE'), ('auth.accounts', 'REFERENCES'),
          ('auth.accounts', 'TRIGGER'), ('identity.patients', 'REFERENCES'),
          ('auth.sessions', 'SELECT'), ('auth.sessions', 'UPDATE'),
          ('auth.external_identities', 'SELECT'), ('auth.external_identities', 'UPDATE'),
          ('identity.patient_access_pins', 'SELECT'), ('identity.patient_access_pins', 'UPDATE'),
          ('notification.device_registrations', 'SELECT'), ('notification.device_registrations', 'UPDATE'),
          ('identity.patient_emergency_contacts', 'SELECT'), ('identity.patient_emergency_contacts', 'UPDATE'),
          ('auth.session_events', 'INSERT'), ('audit.events', 'INSERT'),
          ('identity.staff', 'SELECT'), ('identity.staff_facility_memberships', 'SELECT'),
          ('auth.account_roles', 'SELECT')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
        join pg_roles holder on holder.oid = applier
       where case when wanted.privilege = 'OWNER'
               then not pg_temp.deletion_0096_holds(applier, relation.relowner, null::aclitem[], 'r', 'OWNER')
               else not pg_temp.deletion_0096_holds(applier, relation.relowner, relation.relacl, 'r', wanted.privilege) end
      union all
      select format('%s lacks CREATE on schema %s', holder.rolname, namespace.nspname)
        from pg_namespace namespace
        join pg_roles holder on holder.oid = applier
       where namespace.nspname in ('auth', 'identity', 'platform')
         and not pg_temp.deletion_0096_holds(applier, namespace.nspowner, namespace.nspacl, 'n', 'CREATE')
      union all
      select format('%s lacks EXECUTE on %s', holder.rolname, proc.oid::regprocedure)
        from (values
          ('platform.current_actor_subject()'), ('platform.current_correlation_id()'),
          ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)'),
          ('platform.reject_mutation()')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
        join pg_roles holder on holder.oid = applier
       where not pg_temp.deletion_0096_holds(applier, proc.proowner, proc.proacl, 'f', 'EXECUTE')
      union all
      -- The tables with forced row-level security that completion writes
      -- admit their owner through one policy naming it (0094's and 0095's
      -- form); a copy re-owned without its policies would update no row.
      select format('%s is not admitted by the owner policy of %s', holder.rolname, relation.oid::regclass)
        from pg_class relation
        join pg_roles holder on holder.oid = applier
       where relation.oid in ('identity.patient_contact_changes'::regclass,
               'identity.patient_share_invitations'::regclass, 'identity.record_access_notices'::regclass)
         and relation.relforcerowsecurity
         and not exists (select 1 from pg_policy policy_row
                          where policy_row.polrelid = relation.oid and policy_row.polpermissive
                            and policy_row.polcmd = '*' and policy_row.polroles = '{0}'::oid[]
                            and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                              = format('(CURRENT_USER = %L::name)', current_user)
                            and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid)
                              = format('(CURRENT_USER = %L::name)', current_user))
      union all
      select format('%s is not the owner of %s (owner %s)', current_user, replaced.what, pg_get_userbyid(replaced.proowner))
        from deletion_0096_replaced replaced
       where replaced.proowner <> applier) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0096: missing privileges: %s', mismatch);
  end if;
  if (select count(*) from deletion_0096_replaced) <> 2 then
    raise exception using errcode = '55000', message = '0096: the replaced functions were not recorded';
  end if;
  raise notice '0096: owners checked: %', (
    select string_agg(format('%s=%s', owned.what, owned.owner), ', ' order by owned.what)
      from (select replaced.what, pg_get_userbyid(replaced.proowner) as owner from deletion_0096_replaced replaced
            union all
            select relation.oid::regclass::text, pg_get_userbyid(relation.relowner) from pg_class relation
             where relation.oid in ('auth.accounts'::regclass, 'identity.patients'::regclass,
               'identity.consent_grants'::regclass, 'identity.access_requests'::regclass)
            union all
            select 'new tables and functions', current_user::text) owned);
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
          message = '0096: auth.accounts or identity.patients stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 1a. Record-class retention: `retain` only. A non-retain disposition is an
-- erasure decision and needs a separately approved migration.
create table platform.record_class_retention_policies (
  record_class text primary key check (record_class in (
    'patient_identity', 'nin_identity_binding', 'clinical_record',
    'consent_and_access_evidence', 'audit_security_record',
    'authentication_account_record', 'notification_record'
  )),
  disposition text not null check (disposition = 'retain'),
  automatic_purge boolean not null default false check (automatic_purge = false),
  basis text not null check (length(btrim(basis)) between 8 and 500),
  approval_reference text check (
    approval_reference is null or length(btrim(approval_reference)) between 3 and 200
  ),
  row_version bigint not null default 1 check (row_version > 0),
  updated_at timestamptz not null default clock_timestamp()
);

-- 1b. Legal holds: preservation evidence, released but never deleted or
-- rewritten. No runtime role can place or release a hold.
create table platform.legal_holds (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('patient', 'account')),
  subject_id uuid not null,
  reason text not null check (length(btrim(reason)) between 8 and 500),
  reference text check (reference is null or length(btrim(reference)) between 3 and 200),
  placed_by_account_id uuid references auth.accounts(id) on delete restrict,
  placed_at timestamptz not null default clock_timestamp(),
  released_at timestamptz,
  released_by_account_id uuid references auth.accounts(id) on delete restrict,
  release_reason text check (release_reason is null or length(btrim(release_reason)) between 8 and 500),
  check ((released_at is null) = (release_reason is null)),
  check (released_by_account_id is null or released_at is not null),
  check (released_at is null or released_at >= placed_at)
);
create index legal_holds_active_subject_idx
  on platform.legal_holds (subject_type, subject_id) where released_at is null;

create function platform.guard_legal_hold_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' or old.released_at is not null
     or new.id is distinct from old.id
     or new.subject_type is distinct from old.subject_type
     or new.subject_id is distinct from old.subject_id
     or new.reason is distinct from old.reason
     or new.reference is distinct from old.reference
     or new.placed_by_account_id is distinct from old.placed_by_account_id
     or new.placed_at is distinct from old.placed_at then
    raise exception using errcode = '55000', message = 'LEGAL_HOLD_IMMUTABLE';
  end if;
  return new;
end
$$;
create trigger legal_holds_guarded_mutation
  before update or delete on platform.legal_holds
  for each row execute function platform.guard_legal_hold_mutation();

-- 1c. Product configuration, not a legal retention period. The waiting period
-- is the patient's cancellation window; zero completes at confirmation.
create table platform.patient_account_deletion_settings (
  singleton boolean primary key default true check (singleton),
  waiting_period interval not null check (
    waiting_period >= interval '0' and waiting_period <= interval '90 days'
  ),
  confirmation_ttl interval not null check (
    confirmation_ttl between interval '1 minute' and interval '30 minutes'
  ),
  max_requests_per_day integer not null check (max_requests_per_day between 1 and 20),
  max_confirmation_attempts smallint not null check (max_confirmation_attempts between 1 and 10),
  reason text not null check (length(btrim(reason)) between 8 and 500),
  row_version bigint not null default 1 check (row_version > 0),
  updated_at timestamptz not null default clock_timestamp()
);

-- 1d. The deletion lifecycle, one row per request.
create table identity.patient_account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.accounts(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  -- No foreign key to auth.sessions (a hot table): the commands bind the
  -- session through identity.patient_self_session.
  requested_session_id uuid not null,
  state text not null check (state in (
    'awaiting_confirmation', 'pending', 'blocked', 'cancelled',
    'completed', 'expired', 'superseded'
  )),
  -- Only the SHA-256 of the single-use confirmation token is stored.
  confirmation_token_sha256 char(64) not null unique
    check (confirmation_token_sha256 ~ '^[0-9a-f]{64}$'),
  confirmation_expires_at timestamptz not null,
  confirmation_failed_attempts smallint not null default 0
    check (confirmation_failed_attempts between 0 and 10),
  confirmation_consumed_at timestamptz,
  requested_at timestamptz not null default clock_timestamp(),
  confirmed_at timestamptz,
  waiting_period interval check (waiting_period is null or waiting_period >= interval '0'),
  scheduled_for timestamptz,
  blocked_at timestamptz,
  blocked_reason_code text check (blocked_reason_code is null or blocked_reason_code in (
    'LEGAL_HOLD', 'RETENTION_POLICY_UNAVAILABLE', 'WORKFORCE_ACCOUNT'
  )),
  cancelled_at timestamptz,
  closed_at timestamptz,
  completed_at timestamptz,
  retention_decision jsonb not null default '{}'::jsonb check (jsonb_typeof(retention_decision) = 'object'),
  completion_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(completion_summary) = 'object'),
  correlation_id text not null check (
    length(correlation_id) between 8 and 128
    and correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  row_version bigint not null default 1 check (row_version > 0),
  updated_at timestamptz not null default clock_timestamp(),
  check (confirmation_expires_at > requested_at),
  check (state <> 'awaiting_confirmation'
    or (confirmation_consumed_at is null and confirmed_at is null)),
  check (state not in ('pending', 'completed') or (
    confirmed_at is not null and confirmation_consumed_at is not null
    and waiting_period is not null and scheduled_for is not null)),
  check (state <> 'pending' or (completed_at is null and cancelled_at is null)),
  check ((state = 'completed') = (completed_at is not null)),
  check ((state = 'blocked') = (blocked_at is not null and blocked_reason_code is not null)),
  check ((state = 'cancelled') = (cancelled_at is not null)),
  check ((state in ('expired', 'superseded')) = (closed_at is not null))
);
-- At most one open deletion lifecycle per login; the commands serialize on an
-- advisory lock and this index is the final duplicate guard.
create unique index patient_account_deletion_open_uq
  on identity.patient_account_deletion_requests (account_id)
  where state in ('awaiting_confirmation', 'pending');
create index patient_account_deletion_due_idx
  on identity.patient_account_deletion_requests (scheduled_for)
  where state = 'pending';
create index patient_account_deletion_account_idx
  on identity.patient_account_deletion_requests (account_id, requested_at desc);
create trigger patient_account_deletion_requests_no_delete
  before delete on identity.patient_account_deletion_requests
  for each row execute function platform.reject_mutation();

-- 1e. The deletion emails: one per request and kind, sent by the sweeper.
create table identity.patient_account_deletion_notices (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references identity.patient_account_deletion_requests(id) on delete restrict,
  kind text not null check (kind in ('scheduled', 'cancelled', 'completed')),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed', 'not_sent')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  lease_owner text check (lease_owner is null or lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  provider text check (provider is null or provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  safe_code text check (safe_code is null or safe_code ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  unique (request_id, kind),
  check ((lease_owner is null) = (lease_expires_at is null)),
  check (status <> 'pending' or next_attempt_at is not null),
  check (status = 'pending' or lease_owner is null)
);
create index patient_account_deletion_notices_due_idx
  on identity.patient_account_deletion_notices (next_attempt_at) where status = 'pending';
create trigger patient_account_deletion_notices_no_delete
  before delete on identity.patient_account_deletion_notices
  for each row execute function platform.reject_mutation();

-- Row-level security: one policy for the owner, no grant.
alter table platform.record_class_retention_policies enable row level security;
alter table platform.record_class_retention_policies force row level security;
alter table platform.legal_holds enable row level security;
alter table platform.legal_holds force row level security;
alter table platform.patient_account_deletion_settings enable row level security;
alter table platform.patient_account_deletion_settings force row level security;
alter table identity.patient_account_deletion_requests enable row level security;
alter table identity.patient_account_deletion_requests force row level security;
alter table identity.patient_account_deletion_notices enable row level security;
alter table identity.patient_account_deletion_notices force row level security;
do $$
begin
  execute format('create policy record_class_retention_policies_owner on platform.record_class_retention_policies '
    || 'for all using (current_user = %L) with check (current_user = %L)', current_user, current_user);
  execute format('create policy legal_holds_owner on platform.legal_holds '
    || 'for all using (current_user = %L) with check (current_user = %L)', current_user, current_user);
  execute format('create policy patient_account_deletion_settings_owner on platform.patient_account_deletion_settings '
    || 'for all using (current_user = %L) with check (current_user = %L)', current_user, current_user);
  execute format('create policy patient_account_deletion_requests_owner on identity.patient_account_deletion_requests '
    || 'for all using (current_user = %L) with check (current_user = %L)', current_user, current_user);
  execute format('create policy patient_account_deletion_notices_owner on identity.patient_account_deletion_notices '
    || 'for all using (current_user = %L) with check (current_user = %L)', current_user, current_user);
end
$$;
revoke all on platform.record_class_retention_policies, platform.legal_holds,
  platform.patient_account_deletion_settings, identity.patient_account_deletion_requests,
  identity.patient_account_deletion_notices from public;

insert into platform.record_class_retention_policies (record_class, disposition, automatic_purge, basis)
select record_class, 'retain', false,
  'No approved retention or erasure policy exists; retain without automatic purge (DATABASE.md 3.5 and 15)'
from unnest(array[
  'patient_identity', 'nin_identity_binding', 'clinical_record',
  'consent_and_access_evidence', 'audit_security_record',
  'authentication_account_record', 'notification_record'
]) as record_class;
insert into platform.patient_account_deletion_settings (
  singleton, waiting_period, confirmation_ttl, max_requests_per_day,
  max_confirmation_attempts, reason
) values (
  true, interval '14 days', interval '10 minutes', 5, 5,
  'Initial product cancellation window; not a legal retention period'
);

comment on table identity.patient_account_deletion_requests is
  '0096 (main 0064): the patient login/account deletion lifecycle. Deletion closes the login only; patient identity, NIN binding, clinical, consent, audit, authentication and notification records are retained. Never deleted.';
comment on table identity.patient_account_deletion_notices is
  '0096: the scheduled, cancelled and completed emails of a deletion request and their delivery state. Never deleted.';
comment on table platform.record_class_retention_policies is
  '0096 (main 0064): record-class retention. Only retain is representable until an erasure policy is approved under DATABASE.md section 15.';
comment on table platform.legal_holds is
  '0096 (main 0064): active holds block patient account deletion; holds are released, never deleted.';
comment on table platform.patient_account_deletion_settings is
  '0096 (main 0064): the patient''s cancellation window, the confirmation lifetime and the request and attempt limits; not a legal retention period.';

-- 2. A deleted login is terminal: never reactivated, given a password, a
-- lower token version or another subject. The trigger fires only for a row
-- already deleted, so every other account update runs no trigger code.
create function auth.protect_deleted_account()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status = 'deleted' and (
       new.status is distinct from 'deleted'
       or (new.password_hash is not null and new.password_hash is distinct from old.password_hash)
       or new.token_version < old.token_version
       or new.subject is distinct from old.subject
     ) then
    raise exception using errcode = '55000', message = 'ACCOUNT_DELETED_TERMINAL';
  end if;
  return new;
end
$$;
create trigger accounts_deleted_terminal
  before update on auth.accounts
  for each row when (old.status = 'deleted')
  execute function auth.protect_deleted_account();

-- 3. Functions. The SQL due check is created without reading its table.
do $$ begin perform set_config('hid.m0096_check_function_bodies', current_setting('check_function_bodies'), true); end $$;
set local check_function_bodies = off;

-- 3a. Whether the login has a confirmed deletion that is due.
create function identity.patient_account_deletion_due(requested_account uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1 from identity.patient_account_deletion_requests request_row
     where request_row.account_id = requested_account
       and request_row.state = 'pending'
       and request_row.scheduled_for <= statement_timestamp()
  )
$$;

-- 4. The two patient resolvers, replaced (0030's bodies, the due check
-- appended, as main 0064): the login is unusable from scheduled_for.
create or replace function identity.current_patient_account(requested_subject text)
returns table(account_id uuid, subject text, email text, display_name text, patient_id uuid)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select a.id, a.subject, a.email, a.display_name, p.id
  from auth.accounts a join identity.patients p on p.account_id = a.id
  where a.subject = requested_subject and a.status = 'active'
    and (a.disabled_until is null or a.disabled_until <= statement_timestamp())
    and p.status = 'active'
    and not identity.patient_account_deletion_due(a.id)
$$;

create or replace function identity.patient_self_session(requested_subject text, requested_session uuid)
returns uuid language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p.id from auth.accounts a
  join auth.sessions s on s.account_id = a.id
  join identity.patients p on p.account_id = a.id and p.id = s.patient_id
  where a.subject = requested_subject
    and requested_subject = nullif(current_setting('app.actor_subject', true), '')
    and nullif(current_setting('app.correlation_id', true), '') is not null
    and s.id = requested_session and s.session_kind = 'patient'
    and s.revoked_at is null and s.expires_at > statement_timestamp()
    and s.absolute_expires_at > statement_timestamp()
    and s.account_token_version = a.token_version
    and a.status = 'active'
    and (a.disabled_until is null or a.disabled_until <= statement_timestamp())
    and p.status = 'active'
    and not identity.patient_account_deletion_due(a.id)
$$;

do $$ begin perform set_config('check_function_bodies', current_setting('hid.m0096_check_function_bodies'), true); end $$;

-- One audit row: ids, codes and counts only.
create function identity.account_deletion_audit(
  requested_actor_type text, requested_subject text, requested_account_id uuid, requested_patient_id uuid,
  requested_action text, requested_outcome text, requested_resource_type text, requested_resource_id uuid,
  requested_details jsonb
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), requested_actor_type,
    case when requested_actor_type = 'system' then null else requested_subject end,
    case when requested_actor_type = 'system' then null else requested_account_id end,
    requested_patient_id, requested_action, requested_outcome, requested_resource_type, requested_resource_id::text,
    'patient-self', 'application', 'identity-api', coalesce(requested_details, '{}'::jsonb)
  );
end
$$;

-- 3b. Retention and legal-hold evaluation records which record classes are
-- preserved; it cannot approve erasure because only `retain` exists. The
-- workforce test is 0093's: a staff record, an unrevoked role or any
-- facility membership.
create function platform.evaluate_patient_account_deletion(requested_account uuid, requested_patient uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  required_classes constant text[] := array[
    'patient_identity', 'nin_identity_binding', 'clinical_record',
    'consent_and_access_evidence', 'audit_security_record',
    'authentication_account_record', 'notification_record'
  ];
  policies jsonb;
  policy_count integer;
  active_hold boolean;
  workforce boolean;
  reason_code text;
begin
  select coalesce(jsonb_object_agg(policy.record_class, jsonb_build_object(
           'disposition', policy.disposition,
           'automaticPurge', policy.automatic_purge,
           'approvedPolicy', policy.approval_reference is not null)), '{}'::jsonb),
         count(*)
    into policies, policy_count
    from platform.record_class_retention_policies policy
   where policy.record_class = any(required_classes)
     and policy.disposition = 'retain' and not policy.automatic_purge;

  select exists (
    select 1 from platform.legal_holds hold
     where hold.released_at is null
       and ((hold.subject_type = 'patient' and hold.subject_id = requested_patient)
         or (hold.subject_type = 'account' and hold.subject_id = requested_account))
  ) into active_hold;

  select exists (select 1 from identity.staff staff_row where staff_row.account_id = requested_account)
      or exists (select 1 from auth.account_roles assignment
                  where assignment.account_id = requested_account and assignment.revoked_at is null)
      or exists (select 1 from identity.staff_facility_memberships membership
                  where membership.account_id = requested_account)
    into workforce;

  reason_code := case
    when active_hold then 'LEGAL_HOLD'
    when policy_count <> cardinality(required_classes) then 'RETENTION_POLICY_UNAVAILABLE'
    when workforce then 'WORKFORCE_ACCOUNT'
    else null
  end;

  return jsonb_build_object(
    'allowed', reason_code is null,
    'reasonCode', reason_code,
    'legalHold', active_hold,
    'recordClasses', policies,
    'accountActions', case when reason_code is null then jsonb_build_array(
      'revoke_sessions', 'clear_password_credential', 'revoke_federated_identities',
      'revoke_patient_access_pin', 'revoke_patient_granted_access',
      'expire_pending_access_requests', 'revoke_notification_devices',
      'deactivate_emergency_contacts', 'cancel_share_invitations',
      'invalidate_pending_contact_changes', 'suppress_record_access_emails', 'close_login'
    ) else '[]'::jsonb end,
    'evaluatedAt', clock_timestamp()
  );
end
$$;

-- 3c. Internal completion. Callers are the confirmation (zero waiting
-- period) and the system finalizer; granted to no role.
create function identity.complete_patient_account_deletion(requested_request_id uuid, requested_actor_subject text)
returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  request_row identity.patient_account_deletion_requests%rowtype;
  decision jsonb;
  correlation text := platform.current_correlation_id();
  actor_type_value text := case when requested_actor_subject is null then 'system' else 'patient' end;
  sessions_revoked integer := 0;
  identities_revoked integer := 0;
  pins_revoked integer := 0;
  grants_revoked integer := 0;
  requests_expired integer := 0;
  devices_revoked integer := 0;
  contacts_deactivated integer := 0;
  invitations_cancelled integer := 0;
  contact_changes_invalidated integer := 0;
  record_access_emails_suppressed integer := 0;
  summary jsonb;
begin
  if correlation is null then
    raise exception using errcode = '42501', message = 'A correlated lifecycle context is required';
  end if;
  select * into request_row from identity.patient_account_deletion_requests candidate
   where candidate.id = requested_request_id for update;
  if not found then return 'not_found'; end if;
  if request_row.state <> 'pending' then return 'not_pending'; end if;
  if request_row.scheduled_for > clock_timestamp() then return 'not_due'; end if;

  -- 0059's lock order: the account, then the patient's dependents.
  perform 1 from auth.accounts account where account.id = request_row.account_id for update;

  -- A hold placed (or a workforce role given) during the waiting period
  -- blocks finalization.
  decision := platform.evaluate_patient_account_deletion(request_row.account_id, request_row.patient_id);
  if not (decision->>'allowed')::boolean then
    update identity.patient_account_deletion_requests
       set state = 'blocked', blocked_at = clock_timestamp(),
           blocked_reason_code = decision->>'reasonCode', retention_decision = decision,
           updated_at = clock_timestamp(), row_version = row_version + 1
     where id = request_row.id;
    perform identity.account_deletion_audit(actor_type_value, requested_actor_subject, request_row.account_id,
      request_row.patient_id, 'identity.patient-account-deletion.blocked', 'denied', 'patient-account-deletion',
      request_row.id, jsonb_build_object('reasonCode', decision->>'reasonCode', 'stage', 'finalization'));
    perform notification.enqueue_patient_inbox_item(request_row.patient_id, 'ACCOUNT_DELETION_BLOCKED',
      'account-deletion', request_row.id, jsonb_build_object('reasonCode', decision->>'reasonCode'));
    return 'blocked';
  end if;

  with revoked as (
    update auth.sessions as session_row
       set revoked_at = clock_timestamp(), revocation_reason = 'patient_account_deleted',
           row_version = session_row.row_version + 1
     where session_row.account_id = request_row.account_id and session_row.revoked_at is null
    returning session_row.id
  ), events as (
    insert into auth.session_events (session_id, account_id, event_type, outcome, correlation_id, details)
    select revoked.id, request_row.account_id, 'revoked', 'success', correlation,
      jsonb_build_object('reason', 'patient_account_deleted')
      from revoked
    returning 1
  )
  select count(*) into sessions_revoked from events;

  update auth.external_identities as identity_row
     set status = 'revoked', revoked_at = coalesce(identity_row.revoked_at, clock_timestamp())
   where identity_row.account_id = request_row.account_id and identity_row.status <> 'revoked';
  get diagnostics identities_revoked = row_count;

  -- Serialize with staff PIN verification exactly as PIN revocation does.
  perform pg_advisory_xact_lock(hashtextextended('patient-access-pin:' || request_row.patient_id::text, 0));
  update identity.patient_access_pins as pin_row
     set status = 'revoked', disabled_at = clock_timestamp(),
         disabled_reason = 'The patient login was deleted', updated_at = clock_timestamp(),
         row_version = pin_row.row_version + 1
   where pin_row.patient_id = request_row.patient_id and pin_row.status <> 'revoked';
  get diagnostics pins_revoked = row_count;

  -- Only access the patient granted is closed (approvals, PIN grants and
  -- 0095's shares). Break-glass grants and any workforce authorization that
  -- does not depend on the patient are untouched.
  update identity.consent_grants as grant_row
     set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = request_row.account_id,
         revoked_reason = 'The patient login was deleted', updated_at = clock_timestamp(),
         row_version = grant_row.row_version + 1
   where grant_row.patient_id = request_row.patient_id
     and grant_row.status = 'active'
     and grant_row.break_glass = false
     and grant_row.scope <> 'break_glass'
     and (grant_row.granted_by_patient_id = request_row.patient_id
       or grant_row.authorization_method = 'patient_access_pin');
  get diagnostics grants_revoked = row_count;

  update identity.access_requests as access_row
     set status = 'expired', updated_at = clock_timestamp(), row_version = access_row.row_version + 1
   where access_row.patient_id = request_row.patient_id
     and access_row.status = 'pending' and access_row.break_glass = false;
  get diagnostics requests_expired = row_count;

  update notification.device_registrations as device_row
     set status = 'revoked', revoked_at = clock_timestamp(),
         revocation_reason_code = 'PATIENT_ACCOUNT_DELETED', updated_at = clock_timestamp(),
         row_version = device_row.row_version + 1
   where device_row.account_id = request_row.account_id and device_row.status = 'active';
  get diagnostics devices_revoked = row_count;

  -- This branch's patient-owned items (D11).
  update identity.patient_emergency_contacts as contact_row
     set status = 'deactivated', deactivated_at = clock_timestamp(), deactivation_reason = 'account_deleted',
         contact_ciphertext = null, contact_key_version = null, destination_hmac = null,
         updated_at = clock_timestamp(), row_version = contact_row.row_version + 1
   where contact_row.patient_id = request_row.patient_id and contact_row.status <> 'deactivated';
  get diagnostics contacts_deactivated = row_count;

  update identity.patient_share_invitations as invitation_row
     set status = 'cancelled', cancelled_at = clock_timestamp(), updated_at = clock_timestamp(),
         row_version = invitation_row.row_version + 1
   where invitation_row.patient_id = request_row.patient_id and invitation_row.status in ('pending', 'accepted');
  get diagnostics invitations_cancelled = row_count;

  update identity.patient_contact_changes as change_row
     set state = 'invalidated', invalidated_at = clock_timestamp(), invalidation_reason = 'contact_unavailable',
         new_ciphertext = null, row_version = change_row.row_version + 1
   where change_row.patient_id = request_row.patient_id and change_row.state = 'pending';
  get diagnostics contact_changes_invalidated = row_count;

  update identity.record_access_notices as notice_row
     set email_status = 'suppressed', lease_owner = null, lease_expires_at = null, safe_code = 'account_deleted',
         updated_at = clock_timestamp(), row_version = notice_row.row_version + 1
   where notice_row.patient_id = request_row.patient_id and notice_row.email_status = 'pending';
  get diagnostics record_access_emails_suppressed = row_count;

  update auth.accounts as account_row
     set status = 'deleted', password_hash = null, password_algorithm = null,
         password_changed_at = clock_timestamp(), disabled_until = null,
         token_version = account_row.token_version + 1,
         row_version = account_row.row_version + 1, updated_at = clock_timestamp()
   where account_row.id = request_row.account_id;

  summary := jsonb_build_object(
    'sessionsRevoked', sessions_revoked, 'federatedIdentitiesRevoked', identities_revoked,
    'accessPinRevoked', pins_revoked > 0, 'patientGrantsRevoked', grants_revoked,
    'pendingAccessRequestsExpired', requests_expired, 'notificationDevicesRevoked', devices_revoked,
    'emergencyContactsDeactivated', contacts_deactivated, 'shareInvitationsCancelled', invitations_cancelled,
    'contactChangesInvalidated', contact_changes_invalidated,
    'recordAccessEmailsSuppressed', record_access_emails_suppressed,
    'patientIdentityRetained', true, 'clinicalRecordsRetained', true, 'auditRecordsRetained', true
  );
  update identity.patient_account_deletion_requests
     set state = 'completed', completed_at = clock_timestamp(), retention_decision = decision,
         completion_summary = summary, updated_at = clock_timestamp(), row_version = row_version + 1
   where id = request_row.id;
  -- The completed email (durable; the address stays on the closed login).
  insert into identity.patient_account_deletion_notices (request_id, kind, status, next_attempt_at)
  values (request_row.id, 'completed', 'pending', clock_timestamp())
  on conflict (request_id, kind) do nothing;

  perform identity.account_deletion_audit(actor_type_value, requested_actor_subject, request_row.account_id,
    request_row.patient_id, 'identity.patient-account-deletion.sessions-revoked', 'success',
    'patient-account-deletion', request_row.id,
    jsonb_build_object('sessionsRevoked', sessions_revoked, 'federatedIdentitiesRevoked', identities_revoked,
      'accessPinRevoked', pins_revoked > 0));
  perform identity.account_deletion_audit(actor_type_value, requested_actor_subject, request_row.account_id,
    request_row.patient_id, 'identity.patient-account-deletion.access-revoked', 'success',
    'patient-account-deletion', request_row.id,
    jsonb_build_object('patientGrantsRevoked', grants_revoked, 'pendingAccessRequestsExpired', requests_expired,
      'notificationDevicesRevoked', devices_revoked, 'emergencyContactsDeactivated', contacts_deactivated,
      'shareInvitationsCancelled', invitations_cancelled, 'contactChangesInvalidated', contact_changes_invalidated,
      'recordAccessEmailsSuppressed', record_access_emails_suppressed, 'breakGlassUnchanged', true));
  perform identity.account_deletion_audit(actor_type_value, requested_actor_subject, request_row.account_id,
    request_row.patient_id, 'identity.patient-account-deletion.completed', 'success',
    'patient-account-deletion', request_row.id,
    jsonb_build_object('summary', summary, 'recordClasses', decision->'recordClasses'));
  return 'completed';
end
$$;

-- 3d. The live patient session's deletion status (NULL without one).
create function identity.my_account_deletion_status(requested_subject text, requested_session uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
  settings_row platform.patient_account_deletion_settings%rowtype;
  request_row identity.patient_account_deletion_requests%rowtype;
  effective_state text;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then return null; end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  select * into settings_row from platform.patient_account_deletion_settings settings where settings.singleton;
  if not found then
    raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_SETTINGS_UNAVAILABLE';
  end if;
  select * into request_row from identity.patient_account_deletion_requests candidate
   where candidate.account_id = account_id_value
   order by candidate.requested_at desc, candidate.id desc limit 1;
  effective_state := case
    when request_row.id is null then null
    when request_row.state = 'awaiting_confirmation'
      and request_row.confirmation_expires_at <= statement_timestamp() then 'expired'
    else request_row.state
  end;
  return jsonb_build_object(
    'waitingPeriodSeconds', extract(epoch from settings_row.waiting_period)::bigint,
    'confirmationTtlSeconds', extract(epoch from settings_row.confirmation_ttl)::bigint,
    'request', case when request_row.id is null then null else jsonb_build_object(
      'requestId', request_row.id,
      'state', effective_state,
      'requestedAt', request_row.requested_at,
      'confirmationExpiresAt', case when effective_state = 'awaiting_confirmation'
        then request_row.confirmation_expires_at end,
      'scheduledFor', request_row.scheduled_for,
      'blockedReasonCode', request_row.blocked_reason_code,
      'cancelledAt', request_row.cancelled_at,
      'cancellable', effective_state in ('awaiting_confirmation', 'pending')
    ) end
  );
end
$$;

-- 3d. Start a deletion: a single-use confirmation token's SHA-256, 10 minutes.
create function identity.request_my_account_deletion(requested_subject text, requested_session uuid,
  requested_token_sha256 text)
returns table(request_id uuid, confirmation_expires_at timestamptz, waiting_period_seconds bigint)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid;
  account_id_value uuid;
  settings_row platform.patient_account_deletion_settings%rowtype;
  new_request uuid := gen_random_uuid();
  expires_at_value timestamptz;
  recent_requests integer;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_token_sha256 is null or requested_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid deletion confirmation verifier';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('patient-account-deletion:' || account_id_value::text, 0));

  select * into settings_row from platform.patient_account_deletion_settings settings where settings.singleton;
  if not found then
    raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_SETTINGS_UNAVAILABLE';
  end if;
  if exists (select 1 from identity.patient_account_deletion_requests candidate
              where candidate.account_id = account_id_value and candidate.state = 'pending') then
    raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_ALREADY_PENDING';
  end if;
  select count(*) into recent_requests from identity.patient_account_deletion_requests candidate
   where candidate.account_id = account_id_value
     and candidate.requested_at > clock_timestamp() - interval '1 day';
  if recent_requests >= settings_row.max_requests_per_day then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_DELETION_RATE_LIMITED';
  end if;

  -- A newer request invalidates any earlier unconsumed confirmation token.
  update identity.patient_account_deletion_requests as candidate
     set state = 'superseded', closed_at = clock_timestamp(),
         updated_at = clock_timestamp(), row_version = candidate.row_version + 1
   where candidate.account_id = account_id_value and candidate.state = 'awaiting_confirmation';

  expires_at_value := clock_timestamp() + settings_row.confirmation_ttl;
  insert into identity.patient_account_deletion_requests (
    id, account_id, patient_id, requested_session_id, state,
    confirmation_token_sha256, confirmation_expires_at, correlation_id
  ) values (
    new_request, account_id_value, patient_id_value, requested_session, 'awaiting_confirmation',
    requested_token_sha256, expires_at_value, platform.current_correlation_id()
  );
  perform identity.account_deletion_audit('patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient-account-deletion.requested', 'success', 'patient-account-deletion', new_request,
    jsonb_build_object('confirmationExpiresAt', expires_at_value,
      'waitingPeriodSeconds', extract(epoch from settings_row.waiting_period)::bigint));
  return query select new_request, expires_at_value, extract(epoch from settings_row.waiting_period)::bigint;
end
$$;

-- 3d. Confirm with the token and the typed phrase. Invalid, expired and
-- replayed confirmations return a non-disclosing outcome so their denial
-- audit and attempt counter commit; Identity converts it after commit.
create function identity.confirm_my_account_deletion(requested_subject text, requested_session uuid,
  requested_request_id uuid, requested_token_sha256 text, requested_confirmation text)
returns table(outcome text, request_id uuid, request_state text, scheduled_for timestamptz, blocked_reason_code text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid;
  account_id_value uuid;
  settings_row platform.patient_account_deletion_settings%rowtype;
  request_row identity.patient_account_deletion_requests%rowtype;
  decision jsonb;
  denial text;
  scheduled_value timestamptz;
  completion text;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('patient-account-deletion:' || account_id_value::text, 0));
  select * into settings_row from platform.patient_account_deletion_settings settings where settings.singleton;
  if not found then
    raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_SETTINGS_UNAVAILABLE';
  end if;

  select * into request_row from identity.patient_account_deletion_requests candidate
   where candidate.id = requested_request_id and candidate.account_id = account_id_value
     and candidate.patient_id = patient_id_value
   for update;

  if not found then
    denial := 'unknown_request';
  elsif request_row.state <> 'awaiting_confirmation' then
    denial := 'not_awaiting_confirmation';
  elsif request_row.confirmation_expires_at <= clock_timestamp() then
    denial := 'expired';
    update identity.patient_account_deletion_requests
       set state = 'expired', closed_at = clock_timestamp(),
           updated_at = clock_timestamp(), row_version = row_version + 1
     where id = request_row.id;
  elsif requested_token_sha256 is null
     or requested_token_sha256 is distinct from request_row.confirmation_token_sha256
     or upper(regexp_replace(btrim(coalesce(requested_confirmation, '')), '\s+', ' ', 'g'))
        <> 'DELETE MY ACCOUNT' then
    denial := 'invalid_proof';
    update identity.patient_account_deletion_requests
       set confirmation_failed_attempts = confirmation_failed_attempts + 1,
           state = case when confirmation_failed_attempts + 1 >= settings_row.max_confirmation_attempts
             then 'expired' else state end,
           closed_at = case when confirmation_failed_attempts + 1 >= settings_row.max_confirmation_attempts
             then clock_timestamp() else closed_at end,
           updated_at = clock_timestamp(), row_version = row_version + 1
     where id = request_row.id;
  end if;

  if denial is not null then
    perform identity.account_deletion_audit('patient', requested_subject, account_id_value, patient_id_value,
      'identity.patient-account-deletion.confirmation-rejected', 'denied', 'patient-account-deletion',
      requested_request_id, jsonb_build_object('reason', denial));
    return query select case when denial = 'expired' then 'expired' else 'invalid' end,
      requested_request_id, null::text, null::timestamptz, null::text;
    return;
  end if;

  -- The token is consumed in the same update that leaves
  -- awaiting_confirmation, so it can never be replayed.
  perform identity.account_deletion_audit('patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient-account-deletion.verified', 'success', 'patient-account-deletion', request_row.id,
    jsonb_build_object('proof', 'recent-authentication+single-use-token+typed-confirmation'));

  decision := platform.evaluate_patient_account_deletion(account_id_value, patient_id_value);
  perform identity.account_deletion_audit('patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient-account-deletion.retention-evaluated',
    case when (decision->>'allowed')::boolean then 'success' else 'denied' end,
    'patient-account-deletion', request_row.id,
    jsonb_build_object('allowed', decision->'allowed', 'reasonCode', decision->'reasonCode',
      'legalHold', decision->'legalHold', 'recordClasses', decision->'recordClasses'));

  if not (decision->>'allowed')::boolean then
    update identity.patient_account_deletion_requests
       set state = 'blocked', confirmation_consumed_at = clock_timestamp(),
           confirmed_at = clock_timestamp(), blocked_at = clock_timestamp(),
           blocked_reason_code = decision->>'reasonCode', retention_decision = decision,
           updated_at = clock_timestamp(), row_version = row_version + 1
     where id = request_row.id;
    perform identity.account_deletion_audit('patient', requested_subject, account_id_value, patient_id_value,
      'identity.patient-account-deletion.blocked', 'denied', 'patient-account-deletion', request_row.id,
      jsonb_build_object('reasonCode', decision->>'reasonCode', 'stage', 'confirmation'));
    perform notification.enqueue_patient_inbox_item(patient_id_value, 'ACCOUNT_DELETION_BLOCKED',
      'account-deletion', request_row.id, jsonb_build_object('reasonCode', decision->>'reasonCode'));
    return query select 'blocked'::text, request_row.id, 'blocked'::text, null::timestamptz,
      decision->>'reasonCode';
    return;
  end if;

  scheduled_value := clock_timestamp() + settings_row.waiting_period;
  update identity.patient_account_deletion_requests
     set state = 'pending', confirmation_consumed_at = clock_timestamp(),
         confirmed_at = clock_timestamp(), waiting_period = settings_row.waiting_period,
         scheduled_for = scheduled_value, retention_decision = decision,
         updated_at = clock_timestamp(), row_version = row_version + 1
   where id = request_row.id;
  perform identity.account_deletion_audit('patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient-account-deletion.scheduled', 'success', 'patient-account-deletion', request_row.id,
    jsonb_build_object('scheduledFor', scheduled_value,
      'waitingPeriodSeconds', extract(epoch from settings_row.waiting_period)::bigint));

  if settings_row.waiting_period = interval '0' then
    completion := identity.complete_patient_account_deletion(request_row.id, requested_subject);
    if completion = 'completed' then
      return query select 'completed'::text, request_row.id, 'completed'::text, scheduled_value, null::text;
      return;
    end if;
    return query select completion, request_row.id,
      (select candidate.state from identity.patient_account_deletion_requests candidate where candidate.id = request_row.id),
      scheduled_value,
      (select candidate.blocked_reason_code from identity.patient_account_deletion_requests candidate
        where candidate.id = request_row.id);
    return;
  end if;
  -- The scheduled email and inbox notice (D11).
  insert into identity.patient_account_deletion_notices (request_id, kind, status, next_attempt_at)
  values (request_row.id, 'scheduled', 'pending', clock_timestamp())
  on conflict (request_id, kind) do nothing;
  perform notification.enqueue_patient_inbox_item(patient_id_value, 'ACCOUNT_DELETION_SCHEDULED',
    'account-deletion', request_row.id, jsonb_build_object('scheduledFor', scheduled_value));
  return query select 'pending'::text, request_row.id, 'pending'::text, scheduled_value, null::text;
end
$$;

-- 3d. Cancel during the waiting period (or before confirmation). Replays
-- answer replayed; a due, completed, blocked or expired request is 55000.
create function identity.cancel_my_account_deletion(requested_subject text, requested_session uuid,
  requested_request_id uuid)
returns table(request_id uuid, request_state text, replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid;
  account_id_value uuid;
  request_row identity.patient_account_deletion_requests%rowtype;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('patient-account-deletion:' || account_id_value::text, 0));
  select * into request_row from identity.patient_account_deletion_requests candidate
   where candidate.id = requested_request_id and candidate.account_id = account_id_value
     and candidate.patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'The deletion request is unavailable';
  end if;
  if request_row.state = 'cancelled' then
    return query select request_row.id, 'cancelled'::text, true;
    return;
  end if;
  if request_row.state not in ('awaiting_confirmation', 'pending')
     or (request_row.state = 'pending' and request_row.scheduled_for <= clock_timestamp()) then
    raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_NOT_CANCELLABLE';
  end if;
  update identity.patient_account_deletion_requests
     set state = 'cancelled', cancelled_at = clock_timestamp(),
         updated_at = clock_timestamp(), row_version = row_version + 1
   where id = request_row.id;
  perform identity.account_deletion_audit('patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient-account-deletion.cancelled', 'success', 'patient-account-deletion', request_row.id,
    jsonb_build_object('previousState', request_row.state));
  -- A scheduled deletion that is cancelled is told (cancelling before
  -- confirmation sends nothing).
  if request_row.state = 'pending' then
    insert into identity.patient_account_deletion_notices (request_id, kind, status, next_attempt_at)
    values (request_row.id, 'cancelled', 'pending', clock_timestamp())
    on conflict (request_id, kind) do nothing;
    perform notification.enqueue_patient_inbox_item(patient_id_value, 'ACCOUNT_DELETION_CANCELLED',
      'account-deletion', request_row.id, '{}'::jsonb);
  end if;
  return query select request_row.id, 'cancelled'::text, false;
end
$$;

-- 3e. The system finalizer for due requests; concurrent workers skip locked rows.
create function identity.finalize_due_patient_account_deletions(requested_limit integer)
returns table(request_id uuid, outcome text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  due_id uuid;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'A system lifecycle context is required';
  end if;
  for due_id in
    select candidate.id from identity.patient_account_deletion_requests candidate
     where candidate.state = 'pending' and candidate.scheduled_for <= clock_timestamp()
     order by candidate.scheduled_for, candidate.id
     limit least(greatest(coalesce(requested_limit, 10), 1), 50)
     for update skip locked
  loop
    return query select due_id, identity.complete_patient_account_deletion(due_id, null);
  end loop;
end
$$;

-- 3f. The deletion emails due (system:auth): the recipient is the account's
-- email once verified, whatever the account's status (a completed account is
-- deleted); none is not_sent. A scheduled email whose request is no longer
-- pending is not sent. At most 5 attempts within 24 hours.
create function identity.claim_account_deletion_notices(requested_worker text, requested_limit integer,
  requested_lease_seconds integer)
returns table (notice_id uuid, request_id uuid, kind text, recipient text, scheduled_for timestamptz,
  attempt_count integer)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  notice identity.patient_account_deletion_notices%rowtype;
  request_row identity.patient_account_deletion_requests%rowtype;
  recipient_value text;
  limit_value integer := least(greatest(coalesce(requested_limit, 10), 1), 50);
  leased integer := 0;
  closed_code text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'A system notification context is required';
  end if;
  if requested_worker is null or requested_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     or requested_lease_seconds is null or requested_lease_seconds not between 15 and 600 then
    raise exception using errcode = '22023', message = 'Invalid notification claim';
  end if;
  for notice in
    select * from identity.patient_account_deletion_notices candidate
     where candidate.status = 'pending' and candidate.next_attempt_at <= clock_timestamp()
       and (candidate.lease_expires_at is null or candidate.lease_expires_at <= clock_timestamp())
     order by candidate.next_attempt_at, candidate.id
     limit 500
     for update skip locked
  loop
    select * into request_row from identity.patient_account_deletion_requests candidate
     where candidate.id = notice.request_id;
    closed_code := case
      when notice.attempt_count >= 5 then 'attempts_exhausted'
      when notice.created_at <= clock_timestamp() - interval '24 hours' then 'window_elapsed'
      else null end;
    if closed_code is not null then
      update identity.patient_account_deletion_notices
         set status = 'failed', lease_owner = null, lease_expires_at = null, safe_code = closed_code,
             updated_at = clock_timestamp(), row_version = row_version + 1
       where id = notice.id;
      perform identity.account_deletion_audit('system', null, null, request_row.patient_id,
        'identity.patient-account-deletion.email.failed', 'failure', 'patient-account-deletion-notice', notice.id,
        jsonb_build_object('kind', notice.kind, 'reason', closed_code));
      continue;
    end if;
    select lower(btrim(account.email)) into recipient_value
      from auth.accounts account
     where account.id = request_row.account_id and account.email_verified_at is not null
       and nullif(btrim(account.email), '') is not null;
    if recipient_value is null or (notice.kind = 'scheduled' and request_row.state <> 'pending') then
      closed_code := case when recipient_value is null then 'no_recipient' else 'request_closed' end;
      update identity.patient_account_deletion_notices
         set status = 'not_sent', lease_owner = null, lease_expires_at = null, safe_code = closed_code,
             updated_at = clock_timestamp(), row_version = row_version + 1
       where id = notice.id;
      perform identity.account_deletion_audit('system', null, null, request_row.patient_id,
        'identity.patient-account-deletion.email.suppressed', 'success', 'patient-account-deletion-notice', notice.id,
        jsonb_build_object('kind', notice.kind, 'reason', closed_code));
      continue;
    end if;
    update identity.patient_account_deletion_notices
       set lease_owner = requested_worker,
           lease_expires_at = clock_timestamp() + make_interval(secs => requested_lease_seconds),
           attempt_count = attempt_count + 1, updated_at = clock_timestamp(), row_version = row_version + 1
     where id = notice.id;
    return query select notice.id, notice.request_id, notice.kind, recipient_value, request_row.scheduled_for,
      notice.attempt_count + 1;
    leased := leased + 1;
    exit when leased >= limit_value;
  end loop;
end
$$;

-- 3f. The outcome of one deletion email.
create function identity.record_account_deletion_notice_outcome(requested_notice_id uuid, requested_worker text,
  requested_outcome text, requested_provider text, requested_safe_code text)
returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  notice identity.patient_account_deletion_notices%rowtype;
  patient_id_value uuid;
  provider_value text := case when requested_provider ~ '^[a-z][a-z0-9_-]{1,63}$' then requested_provider end;
  safe_code_value text := case when requested_safe_code ~ '^[a-z0-9_]{1,64}$' then requested_safe_code end;
  next_status text;
  retry_at timestamptz;
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'A system notification context is required';
  end if;
  if requested_outcome is null or requested_outcome not in ('accepted', 'definitive_failure', 'unknown') then
    raise exception using errcode = '22023', message = 'Invalid delivery outcome';
  end if;
  select * into notice from identity.patient_account_deletion_notices candidate
   where candidate.id = requested_notice_id and candidate.lease_owner = requested_worker
     and candidate.status = 'pending'
   for update;
  if not found then return 'stale_lease'; end if;
  select request_row.patient_id into patient_id_value
    from identity.patient_account_deletion_requests request_row where request_row.id = notice.request_id;
  retry_at := clock_timestamp() + make_interval(secs => least(3600, power(2, notice.attempt_count)::integer * 60));
  if requested_outcome = 'accepted' then
    next_status := 'delivered';
  elsif requested_outcome = 'definitive_failure' or notice.attempt_count >= 5
     or retry_at >= notice.created_at + interval '24 hours' then
    next_status := 'failed';
  else
    next_status := 'pending';
  end if;
  update identity.patient_account_deletion_notices
     set status = next_status, lease_owner = null, lease_expires_at = null,
         next_attempt_at = case when next_status = 'pending' then retry_at else next_attempt_at end,
         provider = coalesce(provider_value, provider), safe_code = safe_code_value,
         updated_at = clock_timestamp(), row_version = row_version + 1
   where id = notice.id;
  perform identity.account_deletion_audit('system', null, null, patient_id_value,
    case next_status when 'delivered' then 'identity.patient-account-deletion.email.delivered'
      when 'failed' then 'identity.patient-account-deletion.email.failed'
      else 'identity.patient-account-deletion.email.retry-scheduled' end,
    case when next_status = 'delivered' then 'success' else 'failure' end,
    'patient-account-deletion-notice', notice.id,
    jsonb_strip_nulls(jsonb_build_object('kind', notice.kind, 'attempt', notice.attempt_count,
      'provider', provider_value, 'safeCode', safe_code_value)));
  return next_status;
end
$$;

-- 5. Post-checks.
do $$
declare mismatch text;
begin
  select string_agg(replaced.what, ', ') into mismatch
    from deletion_0096_replaced replaced
    join pg_proc proc on proc.oid = replaced.oid
   where (proc.proowner, proc.proacl, proc.prolang, proc.provolatile, proc.prosecdef, proc.proconfig,
          proc.prorettype, proc.proretset, proc.proargnames, proc.proallargtypes)
     is distinct from (replaced.proowner, replaced.proacl, replaced.prolang, replaced.provolatile,
          replaced.prosecdef, replaced.proconfig, replaced.prorettype, replaced.proretset,
          replaced.proargnames, replaced.proallargtypes);
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0096: a replaced function changed more than its body: %s', mismatch);
  end if;
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none')), '; ') into mismatch
    from (values
      ('identity.current_patient_account(text)', 'c6a720c38e084e19d04147bb1146592d'),
      ('identity.patient_self_session(text,uuid)', '378cd66a28347ef82a7faee8d2c65a15'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0096: a replaced body is not the one this file gives: %s', mismatch);
  end if;
  if current_setting('check_function_bodies') is distinct from current_setting('hid.m0096_check_function_bodies') then
    raise exception using errcode = '55000', message = '0096: check_function_bodies was not restored';
  end if;
  if exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where (namespace.nspname, proc.proname) in (
                ('identity', 'patient_account_deletion_due'), ('platform', 'evaluate_patient_account_deletion'),
                ('identity', 'complete_patient_account_deletion'), ('identity', 'account_deletion_audit'),
                ('identity', 'my_account_deletion_status'), ('identity', 'request_my_account_deletion'),
                ('identity', 'confirm_my_account_deletion'), ('identity', 'cancel_my_account_deletion'),
                ('identity', 'finalize_due_patient_account_deletions'),
                ('identity', 'claim_account_deletion_notices'),
                ('identity', 'record_account_deletion_notice_outcome'))
                and (proc.proowner <> (select oid from pg_roles where rolname = current_user)
                  or not proc.prosecdef or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]))
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where (namespace.nspname, proc.proname) in (
                ('identity', 'patient_account_deletion_due'), ('platform', 'evaluate_patient_account_deletion'),
                ('identity', 'complete_patient_account_deletion'), ('identity', 'account_deletion_audit'),
                ('identity', 'my_account_deletion_status'), ('identity', 'request_my_account_deletion'),
                ('identity', 'confirm_my_account_deletion'), ('identity', 'cancel_my_account_deletion'),
                ('identity', 'finalize_due_patient_account_deletions'),
                ('identity', 'claim_account_deletion_notices'),
                ('identity', 'record_account_deletion_notice_outcome'))) <> 11
     or exists (select 1 from pg_proc proc
                 where proc.oid in ('auth.protect_deleted_account()'::regprocedure,
                                    'platform.guard_legal_hold_mutation()'::regprocedure)
                   and (proc.proowner <> (select oid from pg_roles where rolname = current_user)
                     or proc.prosecdef or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]))
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'auth.accounts'::regclass
                       and trigger_row.tgname = 'accounts_deleted_terminal'
                       and trigger_row.tgfoid = 'auth.protect_deleted_account()'::regprocedure
                       and trigger_row.tgenabled = 'O')
     or exists (select 1 from pg_class relation
                 where relation.oid in ('platform.record_class_retention_policies'::regclass,
                   'platform.legal_holds'::regclass, 'platform.patient_account_deletion_settings'::regclass,
                   'identity.patient_account_deletion_requests'::regclass,
                   'identity.patient_account_deletion_notices'::regclass)
                   and (relation.relowner <> (select oid from pg_roles where rolname = current_user)
                     or not relation.relrowsecurity or not relation.relforcerowsecurity))
     or (select count(*) from platform.record_class_retention_policies policy
          where policy.disposition = 'retain' and not policy.automatic_purge) <> 7
     or not exists (select 1 from platform.patient_account_deletion_settings settings
                     where settings.singleton and settings.waiting_period = interval '14 days'
                       and settings.confirmation_ttl = interval '10 minutes'
                       and settings.max_requests_per_day = 5 and settings.max_confirmation_attempts = 5) then
    raise exception using errcode = '55000', message = '0096: a new table, function or trigger is not as this file makes it';
  end if;
end
$$;
drop function pg_temp.deletion_0096_holds(oid, oid, aclitem[], "char", text);
drop table pg_temp.deletion_0096_replaced;

-- 6. Grants (here and in runtime-grants.sql).
revoke all on function auth.protect_deleted_account(),
  platform.guard_legal_hold_mutation(),
  identity.patient_account_deletion_due(uuid),
  identity.account_deletion_audit(text,text,uuid,uuid,text,text,text,uuid,jsonb),
  platform.evaluate_patient_account_deletion(uuid,uuid),
  identity.complete_patient_account_deletion(uuid,text),
  identity.my_account_deletion_status(text,uuid),
  identity.request_my_account_deletion(text,uuid,text),
  identity.confirm_my_account_deletion(text,uuid,uuid,text,text),
  identity.cancel_my_account_deletion(text,uuid,uuid),
  identity.finalize_due_patient_account_deletions(integer),
  identity.claim_account_deletion_notices(text,integer,integer),
  identity.record_account_deletion_notice_outcome(uuid,text,text,text,text) from public;

do $$
declare grantee text;
begin
  foreach grantee in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant execute on function identity.my_account_deletion_status(text,uuid), '
        || 'identity.request_my_account_deletion(text,uuid,text), '
        || 'identity.confirm_my_account_deletion(text,uuid,uuid,text,text), '
        || 'identity.cancel_my_account_deletion(text,uuid,uuid), '
        || 'identity.finalize_due_patient_account_deletions(integer), '
        || 'identity.claim_account_deletion_notices(text,integer,integer), '
        || 'identity.record_account_deletion_notice_outcome(uuid,text,text,text,text) to %I', grantee);
    end if;
  end loop;
end
$$;

comment on function identity.request_my_account_deletion(text,uuid,text) is
  '0096 (main 0064): the live patient session starts deleting its login: a single-use confirmation token (its SHA-256 only), 10 minutes; at most 5 a day; refused while a deletion is scheduled.';
comment on function identity.confirm_my_account_deletion(text,uuid,uuid,text,text) is
  '0096 (main 0064): the token and DELETE MY ACCOUNT schedule the deletion after the waiting period (14 days), or block it (legal hold, retention policy, workforce account); denials return a non-disclosing outcome.';
comment on function identity.finalize_due_patient_account_deletions(integer) is
  '0096 (main 0064): system:auth only. Completes due deletions (1-50, SKIP LOCKED): sessions, federated links, PIN, patient-granted access, pending requests, devices, emergency contacts, share invitations, pending contact changes and records-opened emails closed; the login deleted; every record retained.';
comment on function identity.claim_account_deletion_notices(text,integer,integer) is
  '0096: system:auth only. Leases the scheduled, cancelled and completed deletion emails due, to the account''s verified email.';
