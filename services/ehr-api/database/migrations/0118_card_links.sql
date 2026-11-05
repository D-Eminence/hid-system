-- 0118 Card links: a patient sends their Health ID card by email, and the
-- person it goes to opens it with a one-time code (Akos handover step 8; the
-- design and critique of 2026-11-04, the owner's answers of 2026-11-04 "all
-- recommended"). ON BY DEFAULT since the owner's decision of 4 Nov 2026,
-- after legal approval (NDPA, D13): identity-api, ehr-api and
-- notification-api serve it unless CARD_LINKS_ENABLED=false, which switches
-- a service off. The declaration is signed separately. Written on 0116
-- (claude/patient-entries-0116, on 0103 34d69557), then released on 0105 and
-- 0116 (0001-0105, then 0116, then this file): it uses nothing 0104-0115 or
-- 0117 add, and every object it reads is of 0001-0103 or 0116, unchanged by
-- 0104 and 0105 (the pins below were re-measured on a 0001-0105 and 0116
-- database; 0104 replaced identity.has_active_consent_grant, which nothing
-- here calls or pins). No migration number appears in a function body, so a
-- renumber touches file names and ledgers only.
--
-- What a patient can do: send a link to any email address (no Health ID
-- account needed), for 24 hours or 7 days, choosing "Card only" (the card
-- face, blood group, genotype and allergies) or "Card and records" (also
-- completed visits, signed notes, older records, the health information they
-- entered and the records they added, including anything added while the link
-- is open). The email holds only the link; the link opens nothing until the
-- person asks for a 6-digit code, which goes to the same address, works once
-- for 10 minutes with 5 tries, and only in the browser that asked for it.
-- Each right code opens one 30-minute read-only view; a link has at most one
-- live view. The patient sees every link, every open (inbox, Activity "using
-- the link sent to a•••", and an email on the first open each Lagos day), is
-- emailed on every new link, and can end any link at once.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0116 applied (ehr.create_my_patient_entry's
--    body and the patient_entries_read policy are the marker); nothing of
--    this file exists (else 55000 "0118: already applied"); the bodies the
--    new ones call or rely on are byte for byte those of 0001-0105 and 0116
--    (md5 of pg_proc.prosrc): identity.patient_self_session and
--    identity.patient_account_deletion_due (0096),
--    identity.current_patient_account (0096, which identity-api calls for the
--    own-address check), notification.enqueue_patient_inbox_item (0087),
--    integration.verified_notification_recipient (0063),
--    ehr.patient_self_context (0083), ehr.imported_record_read_context
--    (0061), identity.complete_patient_account_deletion (0096, which sets
--    auth.accounts.status = 'deleted' and so fires section 4's trigger), the
--    platform.current_* readers, platform.reject_mutation,
--    audit.authorize_platform_event, and the body section 5 replaces
--    (identity.patient_self_access_log, 0093); the inbox CHECKs the new
--    codes pass (0037), the audit.events CHECKs the new rows pass (0064) with
--    the authority trigger; the policy set of the eleven EHR tables that get
--    a card-link read policy (27 policies, 0030, 0061, 0062, 0094, 0116); the
--    two triggers on auth.accounts (0096, 0097); and the applying role, which
--    will own every new table and function, owns identity.patients,
--    identity.patient_identifiers, auth.accounts (the trigger), the eleven
--    EHR tables (CREATE POLICY) and the replaced function, holds INSERT on
--    audit.events, SELECT and UPDATE on notification.inbox_items (the open
--    notices' grouping and the hint's erasure) and CREATE on schemas identity
--    and ehr, and may run every
--    function the new bodies call, never through a superuser's bypass.
-- 1. Locks (see Locks).
-- 2. Tables, each with row-level security forced, one policy for its owner
--    and no grant (only the SECURITY DEFINER commands touch them), never
--    deleted or truncated (platform.reject_mutation):
--    a. identity.card_shares: the link. The patient, a reference
--       (XXXX-XXXX, shown to both sides), the scope (card, card_and_records),
--       the duration (24h, 7d; 30 days is not offered in v1), the consent
--       text shown (consent_version), the recipient's address and optional
--       private label encrypted together by identity-api (erased when the
--       link ends), a keyed HMAC of the address (caps, blocks) and a masked
--       hint (kept 12 months after the end, then erased), a keyed HMAC of the
--       256-bit link token (the token itself is never stored), the end and
--       its reason, the link that replaced it, the lock, dead codes, the
--       email's outcome, opens, the Idempotency-Key and request digest. One
--       live link per patient and address. A link that is not emailed (a
--       blocked or capped address) is recorded already ended (not_sent), so
--       it replaces nothing. A guard trigger keeps the
--       identity fields, lets an ended link only lose its address data, and
--       never brings it back.
--    b. identity.card_share_codes: one 6-digit code (only its keyed HMAC),
--       10 minutes, 5 tries, single use, bound to the browser that asked for
--       it (the SHA-256 of a cookie secret), one live code per link; the
--       requesting network's keyed HMAC (erased after 30 days).
--    c. identity.card_share_views: one 30-minute view per right code, by the
--       SHA-256 of a cookie secret; at most one live view per link.
--    d. identity.card_share_patient_emails: the security notice to the
--       patient on every new link (created) and the first open of each link
--       each Lagos day (opened), with lease and retry.
--    e. identity.card_share_address_blocks: addresses (by HMAC) whose owner
--       pressed "Stop these emails"; kept until removed.
-- 3. Commands, SECURITY DEFINER with search_path pg_catalog, pg_temp. Every
--    write and every refusal that commits records its audit.events row in
--    the same transaction, with ids, codes and counts only (never an
--    address, hint, label, code or token):
--    a. the patient's (bound to identity.patient_self_session):
--       create_my_card_share, list_my_card_shares, end_my_card_share,
--       record_my_card_share_delivery;
--    b. the receiver's (system:auth, identity-api's public routes):
--       issue_card_share_code, record_card_share_code_delivery,
--       verify_card_share_code, card_share_view, end_card_share_view,
--       stop_card_share_emails;
--    c. the sweeper's (system:auth): close_expired_card_shares (ends,
--       erases, and applies retention, the hint also in the patient's
--       notices), claim_card_share_emails (with whether the link itself was
--       emailed, for E8's wording), record_card_share_email_outcome;
--    d. EHR: ehr.card_share_read_context (the read policies' test) and
--       ehr.card_share_view_context (the receiver's records read, audited;
--       ehr-api calls it first, then turns the transaction read only).
--    Opens of one link within 30 minutes share one inbox notice (opens
--    counted, unread again), so one push per link per 30 minutes.
-- 4. auth.accounts trigger accounts_deleted_card_shares (0097's clause):
--    when a login is deleted, every link of its patient ends
--    (account_deleted) and is anonymised at once (hint, address HMAC and
--    network data erased, the hint also from the patient's card-link
--    notices), and pending emails are suppressed.
-- 5. identity.patient_self_access_log (0093), replaced: 0093's body plus
--    three kinds, card_opened (actorKind card_recipient), card_shared (with
--    reason not_sent when the link was not emailed) and card_ended (every
--    ending with its reason: the patient's, patient_ended or replaced, and
--    the system's, actorKind system), each with the link's hint as actorName
--    while it is kept.
-- 6. Grants, here and in runtime-grants.sql: the 13 identity commands to
--    hid_identity_runtime and hid_schema_test_runtime; the two EHR functions
--    to hid_ehr_runtime and hid_schema_test_runtime (a read policy's
--    function needs EXECUTE by the reader); nothing else; every new function
--    revoked from PUBLIC. The replaced function keeps its ACL.
-- 7. Post-checks: owners, forced row-level security and policies, SECURITY
--    DEFINER and search_path, the replaced function's attributes and new
--    body.
-- 8. Last: a SELECT-only policy <table>_card_share_read on each of the eleven
--    EHR tables, copying the patient's own read: completed visits, signed or
--    amended notes and their current revision, the imported history (0061,
--    0062), and active patient entries (0116) for "Card and records"; the
--    patient-reported health information (0094) for both scopes. No existing
--    policy or function body of those tables changes.
--
-- Locks: SHARE ROW EXCLUSIVE on auth.accounts (the trigger) and then
-- identity.patients (the foreign keys), taken first, NOWAIT every 10 ms for
-- at most 5 seconds (then 55P03 and nothing applied), held to commit: sign-up,
-- sign-in's account updates and profile writes wait for the apply, reads do
-- not. Last, ACCESS EXCLUSIVE on the eleven EHR tables in a fixed order
-- (CREATE POLICY), taken the same way and held to commit: every chart read
-- and write waits for the rest of the apply. Measured on a copy (see the
-- declaration); measure again on a production-sized copy before release.
--
-- Old services on this schema: every change is additive. Today's images call
-- none of the new functions; the new read policies are false outside a
-- card-share transaction, which no image sets; old Identity images and the
-- website drop unknown Activity kinds. The new images touch the new objects
-- while CARD_LINKS_ENABLED is on, which is the default, so they run before
-- this migration only with CARD_LINKS_ENABLED=false. Applied migrations
-- 0001-0105 and 0116 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0094's helper).
create function pg_temp.card_links_holds(holder oid, object_owner oid, object_acl aclitem[],
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

-- The eleven EHR tables that get a card-link read policy, in lock order.
create function pg_temp.card_links_tables()
returns regclass[]
language sql immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['ehr.encounters', 'ehr.clinical_notes', 'ehr.clinical_note_revisions', 'ehr.imported_medical_records',
    'ehr.imported_medical_record_versions', 'ehr.imported_medical_record_files', 'ehr.imported_patient_health_profiles',
    'ehr.imported_attachment_bindings', 'ehr.imported_attachment_scan_events', 'ehr.patient_reported_health_profiles',
    'ehr.patient_entries']::regclass[]
$$;

create temporary table card_links_replaced as
  select proc.oid, proc.oid::regprocedure::text as what, proc.proowner, proc.proacl, proc.prolang,
         proc.provolatile, proc.prosecdef, proc.proconfig, proc.prorettype, proc.proretset,
         proc.proargnames, proc.proallargtypes
    from pg_proc proc
   where proc.oid = to_regprocedure('identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint)');

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  -- a. Prerequisites: 0116 (its create command's body and read policy).
  if to_regclass('ehr.patient_entries') is null
     or to_regprocedure('ehr.create_my_patient_entry(text,text,text,date,text,text,text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = 'ehr.create_my_patient_entry(text,text,text,date,text,text,text)'::regprocedure)
        is distinct from '280b73ca5151f73ffac6256bf81110af'
     or not exists (select 1 from pg_policies policy
                     where policy.schemaname = 'ehr' and policy.tablename = 'patient_entries'
                       and policy.policyname = 'patient_entries_read')
     or to_regclass('identity.patients') is null or to_regclass('identity.patient_identifiers') is null
     or to_regclass('auth.accounts') is null or to_regclass('audit.events') is null
     or to_regclass('notification.inbox_items') is null
     or to_regprocedure('identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint)') is null then
    raise exception using errcode = '55000', message = '0118: 0001-0105 and 0116 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('identity.card_shares') is not null
     or to_regclass('identity.card_share_codes') is not null
     or to_regclass('identity.card_share_views') is not null
     or to_regclass('identity.card_share_patient_emails') is not null
     or to_regclass('identity.card_share_address_blocks') is not null
     or exists (select 1 from pg_trigger trigger_row
                 where trigger_row.tgrelid = 'auth.accounts'::regclass
                   and trigger_row.tgname = 'accounts_deleted_card_shares')
     or exists (select 1 from pg_policy policy
                 where policy.polrelid = any (pg_temp.card_links_tables())
                   and policy.polname like '%card_share%')
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname in ('identity', 'ehr') and proc.proname like '%card_share%') then
    raise exception using errcode = '55000', message = '0118: already applied';
  end if;
  -- c. The bodies the new ones call or rely on, and the one section 5
  -- replaces, as 0001-0105 and 0116 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.patient_self_session(text,uuid)', '378cd66a28347ef82a7faee8d2c65a15'),
      ('identity.patient_account_deletion_due(uuid)', 'b032c1a385770e20e4930534a203863d'),
      ('identity.current_patient_account(text)', 'c6a720c38e084e19d04147bb1146592d'),
      ('identity.complete_patient_account_deletion(uuid,text)', 'a668a9b144b76fca197f6602a4097e65'),
      ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', '0b5689f31a3ce00f9313fe1e55244fad'),
      ('integration.verified_notification_recipient(uuid)', 'efaab7b01d5773a7a63fbdee7eb18a40'),
      ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'),
      ('ehr.imported_record_read_context(uuid)', 'eabd4af535ecf91508eae6003836e427'),
      ('notification.remove_web_push_for_deleted_account()', 'a81115fd8acdc16113b8bb9314d8d212'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'),
      ('identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint)', '774de1706eef07e5cb52af783be47401'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- Their security attributes: the session, deletion and recipient checks
  -- and the inbox writer run as their owner.
  if mismatch is null then
    select string_agg(expected.proc, '; ') into mismatch
      from (values
        ('identity.patient_self_session(text,uuid)', '{"search_path=pg_catalog, pg_temp"}'),
        ('identity.patient_account_deletion_due(uuid)', '{"search_path=pg_catalog, pg_temp"}'),
        ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)',
         '{"search_path=pg_catalog, notification, identity, auth, pg_temp"}'),
        ('integration.verified_notification_recipient(uuid)', '{search_path=pg_catalog}'))
           expected(proc, config)
     where not exists (select 1 from pg_proc proc
                        where proc.oid = to_regprocedure(expected.proc)
                          and proc.prosecdef and proc.proconfig = expected.config::text[]);
    if mismatch is not null then mismatch := 'attributes of ' || mismatch; end if;
  end if;
  -- d. The inbox CHECKs the new codes pass (0037) and the audit rules the
  -- new rows pass (0064).
  if mismatch is null
     and (select count(*) from pg_constraint constraint_row
           where constraint_row.conrelid = 'notification.inbox_items'::regclass and constraint_row.contype = 'c'
             and constraint_row.convalidated
             and (constraint_row.conname, pg_get_constraintdef(constraint_row.oid)) in (
               ('inbox_items_notification_code_check', $c$CHECK ((notification_code ~ '^[A-Z][A-Z0-9_]{2,79}$'::text))$c$),
               ('inbox_items_resource_type_check',
                $c$CHECK (((resource_type IS NULL) OR (resource_type ~ '^[a-z][a-z0-9._:-]{1,63}$'::text)))$c$),
               ('inbox_items_metadata_check', $c$CHECK ((jsonb_typeof(metadata) = 'object'::text))$c$))) <> 3 then
    mismatch := 'the notification.inbox_items CHECKs the new codes pass';
  end if;
  if mismatch is null
     and (select count(*) from pg_constraint constraint_row
           where constraint_row.conrelid = 'audit.events'::regclass and constraint_row.contype = 'c'
             and constraint_row.convalidated
             and (constraint_row.conname, md5(pg_get_constraintdef(constraint_row.oid))) in (
               ('audit_actor_type_ck', 'd630642d19ec60d7d0cfab2d90533dba'),
               ('audit_actor_facility_ck', 'd74856f4b11b9e7e378d1a586f3a284b'),
               ('audit_platform_scope_ck', 'bc5f610696515dc7475eadde912e0a30'),
               ('events_correlation_id_check', '9066882d9638362e3e51196825b0a764'),
               ('events_outcome_check', '8ec48394933b68472efacffc62cfeda2'),
               ('events_provenance_check', '6bf802bf3aa55c42b5c3752b204fbad1'),
               ('events_details_check', '13e7eaeabe2055f5d8a517bf0fc75a88'),
               ('events_action_check', 'a3aa891e6aa8e44df4b69cb2eaff7c10'))) <> 8 then
    mismatch := 'the audit.events constraints the new rows must pass';
  end if;
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'audit.events'::regclass
             and trigger_row.tgname = 'audit_platform_authority' and trigger_row.tgenabled = 'O'
             and pg_get_triggerdef(trigger_row.oid) =
               'CREATE TRIGGER audit_platform_authority BEFORE INSERT ON audit.events '
               || 'FOR EACH ROW EXECUTE FUNCTION audit.authorize_platform_event()') <> 1 then
    mismatch := 'the trigger audit_platform_authority';
  end if;
  -- e. The policy set of the eleven tables (27 policies, as 0030, 0061,
  -- 0062, 0094 and 0116 left them).
  if mismatch is null
     and (select md5(string_agg(format('%s|%s|%s|%s|%s|%s', policy.polrelid::regclass, policy.polname, policy.polcmd,
            policy.polpermissive,
            regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '^\(CURRENT_USER = ''[^'']*''::name\)$', 'owner'),
            regexp_replace(coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), ''),
              '^\(CURRENT_USER = ''[^'']*''::name\)$', 'owner')), E'\n'
            order by policy.polrelid::regclass::text, policy.polname))
           from pg_policy policy where policy.polrelid = any (pg_temp.card_links_tables()))
        is distinct from 'e7a425cab84af02c5d288224cdd65111' then
    mismatch := 'the read policies of the eleven EHR tables';
  end if;
  -- f. The two triggers on auth.accounts (0096's terminal guard, 0097's
  -- deletion clause, which section 4 copies).
  if mismatch is null
     and (select string_agg(pg_get_triggerdef(trigger_row.oid), E'\n' order by trigger_row.tgname)
           from pg_trigger trigger_row
          where trigger_row.tgrelid = 'auth.accounts'::regclass and not trigger_row.tgisinternal)
        is distinct from
          'CREATE TRIGGER accounts_deleted_terminal BEFORE UPDATE ON auth.accounts FOR EACH ROW WHEN '
          || '((old.status = ''deleted''::text)) EXECUTE FUNCTION auth.protect_deleted_account()' || E'\n'
          || 'CREATE TRIGGER accounts_deleted_web_push AFTER UPDATE OF status ON auth.accounts FOR EACH ROW WHEN '
          || '(((new.status = ''deleted''::text) AND (old.status IS DISTINCT FROM ''deleted''::text))) '
          || 'EXECUTE FUNCTION notification.remove_web_push_for_deleted_account()' then
    mismatch := 'the triggers on auth.accounts';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0118: an object this migration relies on differs from 0001-0105 and 0116: %s', mismatch);
  end if;
  -- g. Privileges, never through a superuser's bypass (production's
  -- migrator has none).
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s lacks %s on %s', holder.rolname, wanted.privilege, relation.oid::regclass) as what
        from (values ('identity.patients', 'OWNER'), ('identity.patient_identifiers', 'OWNER'),
                     ('auth.accounts', 'OWNER'), ('audit.events', 'INSERT'), ('notification.inbox_items', 'SELECT'),
                     ('notification.inbox_items', 'UPDATE')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
        join pg_roles holder on holder.oid = applier
       where case when wanted.privilege = 'OWNER'
               then not pg_temp.card_links_holds(applier, relation.relowner, null::aclitem[], 'r', 'OWNER')
               else not pg_temp.card_links_holds(applier, relation.relowner, relation.relacl, 'r', wanted.privilege) end
      union all
      select format('%s does not own %s', holder.rolname, relation.oid::regclass)
        from pg_class relation
        join pg_roles holder on holder.oid = applier
       where relation.oid = any (pg_temp.card_links_tables())
         and not pg_temp.card_links_holds(applier, relation.relowner, null::aclitem[], 'r', 'OWNER')
      union all
      select format('%s lacks CREATE on schema %s', holder.rolname, namespace.nspname)
        from pg_namespace namespace
        join pg_roles holder on holder.oid = applier
       where namespace.nspname in ('identity', 'ehr')
         and not pg_temp.card_links_holds(applier, namespace.nspowner, namespace.nspacl, 'n', 'CREATE')
      union all
      select format('%s lacks EXECUTE on %s', holder.rolname, proc.oid::regprocedure)
        from (values
          ('identity.patient_self_session(text,uuid)'), ('identity.patient_account_deletion_due(uuid)'),
          ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)'),
          ('integration.verified_notification_recipient(uuid)'), ('platform.current_correlation_id()'),
          ('platform.current_actor_subject()'), ('platform.current_purpose_of_use()'),
          ('platform.reject_mutation()')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
        join pg_roles holder on holder.oid = applier
       where not pg_temp.card_links_holds(applier, proc.proowner, proc.proacl, 'f', 'EXECUTE')
      union all
      select format('%s is not the owner of %s (owner %s)', current_user, replaced.what, pg_get_userbyid(replaced.proowner))
        from card_links_replaced replaced
       where replaced.proowner <> applier) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0118: missing privileges: %s', mismatch);
  end if;
  if (select count(*) from card_links_replaced) <> 1 then
    raise exception using errcode = '55000', message = '0118: the replaced function was not recorded';
  end if;
  raise notice '0118: owners checked: %', (
    select string_agg(format('%s=%s', owned.what, owned.owner), ', ' order by owned.what)
      from (select relation.oid::regclass::text as what, pg_get_userbyid(relation.relowner)::text as owner
              from pg_class relation
             where relation.oid in ('identity.patients'::regclass, 'auth.accounts'::regclass)
            union all
            select 'new tables and functions', current_user::text) owned);
end
$$;

-- 1. The locks the trigger and the foreign keys take, up front and bounded:
-- auth.accounts, then identity.patients (registration's order).
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
          message = '0118: auth.accounts or identity.patients stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 2a. The links.
create table identity.card_shares (
  id uuid primary key,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  reference char(9) not null unique check (reference ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  scope text not null check (scope in ('card', 'card_and_records')),
  duration_preset text not null check (duration_preset in ('24h', '7d')),
  consent_version text not null check (consent_version ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  recipient_ciphertext bytea check (recipient_ciphertext is null or octet_length(recipient_ciphertext) between 30 and 2048),
  recipient_key_version text check (recipient_key_version is null or recipient_key_version ~ '^[A-Za-z0-9._:-]{1,64}$'),
  recipient_hmac char(64) check (recipient_hmac is null or recipient_hmac ~ '^[0-9a-f]{64}$'),
  recipient_hint text check (recipient_hint is null
    or (length(recipient_hint) between 6 and 120 and recipient_hint ~ '^[^@[:space:][:cntrl:]]•••@[^@[:space:][:cntrl:]]+$')),
  token_hmac char(64) not null unique check (token_hmac ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_reason text check (ended_reason in ('patient_ended', 'replaced', 'expired', 'account_deleted',
    'patient_inactive', 'address_blocked', 'too_many_wrong_codes', 'not_sent')),
  replaced_by uuid references identity.card_shares(id) on delete restrict,
  locked_until timestamptz,
  lock_count integer not null default 0 check (lock_count between 0 and 2),
  dead_codes integer not null default 0 check (dead_codes between 0 and 3),
  delivery_outcome text not null check (delivery_outcome in ('pending', 'sent', 'not_sent', 'failed')),
  delivery_recorded_at timestamptz,
  open_count integer not null default 0 check (open_count >= 0),
  last_opened_at timestamptz,
  anonymised_at timestamptz,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  row_version bigint not null default 1 check (row_version > 0),
  updated_at timestamptz not null default clock_timestamp(),
  constraint card_shares_idempotency_uq unique (patient_id, idempotency_key),
  constraint card_shares_duration_ck check (expires_at = created_at + case duration_preset
    when '24h' then interval '24 hours' else interval '7 days' end),
  constraint card_shares_end_ck check ((ended_at is null) = (ended_reason is null)),
  -- Live: the address is held encrypted; ended: it is erased.
  constraint card_shares_recipient_ck check (
    (ended_at is null and recipient_ciphertext is not null and recipient_key_version is not null
      and recipient_hmac is not null and recipient_hint is not null)
    or (ended_at is not null and recipient_ciphertext is null and recipient_key_version is null)),
  constraint card_shares_anonymised_ck check ((anonymised_at is null)
    or (ended_at is not null and recipient_hmac is null and recipient_hint is null)),
  constraint card_shares_replaced_ck check (replaced_by is null or ended_reason = 'replaced')
);
create unique index card_shares_live_address_uq
  on identity.card_shares (patient_id, recipient_hmac) where ended_at is null;
create index card_shares_patient_idx on identity.card_shares (patient_id, created_at desc);
create index card_shares_recipient_idx on identity.card_shares (recipient_hmac, created_at) where recipient_hmac is not null;
create index card_shares_due_idx on identity.card_shares (expires_at) where ended_at is null;
create index card_shares_retention_idx on identity.card_shares (ended_at) where anonymised_at is null and ended_at is not null;

-- 2b. Codes.
create table identity.card_share_codes (
  id uuid primary key,
  share_id uuid not null references identity.card_shares(id) on delete restrict,
  verifier_hmac char(64) not null check (verifier_hmac ~ '^[0-9a-f]{64}$'),
  key_version text not null check (key_version ~ '^[A-Za-z0-9._:-]{1,64}$'),
  requester_sha256 char(64) not null check (requester_sha256 ~ '^[0-9a-f]{64}$'),
  network_hmac char(64) check (network_hmac is null or network_hmac ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  max_attempts integer not null default 5 check (max_attempts = 5),
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  delivery_outcome text not null default 'pending' check (delivery_outcome in ('pending', 'sent', 'failed')),
  consumed_at timestamptz,
  invalidated_at timestamptz,
  invalidated_reason text check (invalidated_reason in ('resend', 'expired', 'attempts_exhausted', 'delivery_failed',
    'share_ended', 'share_locked')),
  constraint card_share_codes_expiry_ck check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
  constraint card_share_codes_invalidated_ck check ((invalidated_at is null) = (invalidated_reason is null)),
  constraint card_share_codes_terminal_ck check (consumed_at is null or invalidated_at is null)
);
create unique index card_share_codes_live_uq
  on identity.card_share_codes (share_id) where consumed_at is null and invalidated_at is null;
create index card_share_codes_share_idx on identity.card_share_codes (share_id, created_at desc);
create index card_share_codes_network_idx on identity.card_share_codes (created_at) where network_hmac is not null;

-- 2c. Views.
create table identity.card_share_views (
  id uuid primary key,
  share_id uuid not null references identity.card_shares(id) on delete restrict,
  code_id uuid not null unique references identity.card_share_codes(id) on delete restrict,
  secret_sha256 char(64) not null unique check (secret_sha256 ~ '^[0-9a-f]{64}$'),
  network_hmac char(64) check (network_hmac is null or network_hmac ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_reason text check (ended_reason in ('closed', 'expired', 'share_ended', 'replaced')),
  constraint card_share_views_expiry_ck check (expires_at = created_at + interval '30 minutes'),
  constraint card_share_views_end_ck check ((ended_at is null) = (ended_reason is null))
);
create unique index card_share_views_live_uq on identity.card_share_views (share_id) where ended_at is null;
create index card_share_views_share_idx on identity.card_share_views (share_id, created_at desc);
create index card_share_views_network_idx on identity.card_share_views (created_at) where network_hmac is not null;

-- 2d. The patient's emails: a new link (created) and the first open of a link each Lagos day (opened).
create table identity.card_share_patient_emails (
  id uuid primary key,
  share_id uuid not null references identity.card_shares(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  kind text not null check (kind in ('created', 'opened')),
  notice_day date not null,
  occurred_at timestamptz not null,
  email_status text not null check (email_status in ('pending', 'delivered', 'failed', 'not_sent', 'suppressed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  lease_owner text check (lease_owner is null or lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  provider text check (provider is null or provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  safe_code text check (safe_code is null or safe_code ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  unique (share_id, kind, notice_day),
  check ((lease_owner is null) = (lease_expires_at is null)),
  check (email_status <> 'pending' or next_attempt_at is not null),
  check (email_status = 'pending' or lease_owner is null)
);
create index card_share_patient_emails_due_idx
  on identity.card_share_patient_emails (next_attempt_at) where email_status = 'pending';
create index card_share_patient_emails_patient_idx on identity.card_share_patient_emails (patient_id);

-- 2e. Addresses whose owner asked us to stop (by HMAC only), until removed.
create table identity.card_share_address_blocks (
  id uuid primary key,
  recipient_hmac char(64) not null check (recipient_hmac ~ '^[0-9a-f]{64}$'),
  source text not null check (source in ('recipient', 'support')),
  created_at timestamptz not null default clock_timestamp(),
  removed_at timestamptz
);
create unique index card_share_address_blocks_live_uq
  on identity.card_share_address_blocks (recipient_hmac) where removed_at is null;

comment on table identity.card_shares is
  '0118: a card link a patient sent by email. The address is encrypted and erased at the end; the hint and address HMAC are erased 12 months after the end, or at once when the login is deleted. Never deleted.';
comment on table identity.card_share_codes is
  '0118: one-time codes for a card link (keyed HMAC only), 10 minutes, 5 tries, single use, bound to the asking browser. Never deleted.';
comment on table identity.card_share_views is
  '0118: 30-minute read-only views of a card link (SHA-256 of the cookie secret only); at most one live view per link. Never deleted.';
comment on table identity.card_share_patient_emails is
  '0118: the patient''s new-link and first-open-of-the-day emails and their delivery state. Never deleted.';
comment on table identity.card_share_address_blocks is
  '0118: addresses (keyed HMAC only) that asked to stop card emails; kept until removed. Never deleted.';

-- Guards: identity fields never change; an end is final and erases the
-- address; counters only grow; nothing is deleted or truncated.
create function identity.guard_card_share_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if (new.id, new.patient_id, new.reference, new.scope, new.duration_preset, new.consent_version, new.token_hmac,
      new.created_at, new.expires_at, new.idempotency_key, new.request_sha256)
     is distinct from
     (old.id, old.patient_id, old.reference, old.scope, old.duration_preset, old.consent_version, old.token_hmac,
      old.created_at, old.expires_at, old.idempotency_key, old.request_sha256) then
    raise exception using errcode = '55000', message = 'A card link''s identity fields never change';
  end if;
  if old.ended_at is not null
     and ((new.ended_at, new.ended_reason) is distinct from (old.ended_at, old.ended_reason)
       or (old.replaced_by is not null and new.replaced_by is distinct from old.replaced_by)
       or new.recipient_ciphertext is not null or new.open_count <> old.open_count
       or new.lock_count <> old.lock_count) then
    raise exception using errcode = '55000', message = 'An ended card link stays ended';
  end if;
  if old.ended_at is null and new.replaced_by is not null then
    raise exception using errcode = '55000', message = 'Only an ended card link names its replacement';
  end if;
  if (new.recipient_hmac is distinct from old.recipient_hmac and new.recipient_hmac is not null)
     or (new.recipient_hint is distinct from old.recipient_hint and new.recipient_hint is not null)
     or ((new.recipient_hmac is null or new.recipient_hint is null) and new.ended_at is null)
     or (old.anonymised_at is not null and new.anonymised_at is distinct from old.anonymised_at) then
    raise exception using errcode = '55000', message = 'A card link''s address data is only erased, after it ends';
  end if;
  if new.open_count < old.open_count or new.lock_count < old.lock_count then
    raise exception using errcode = '55000', message = 'A card link''s counters only grow';
  end if;
  if old.delivery_outcome <> 'pending' and new.delivery_outcome is distinct from old.delivery_outcome then
    raise exception using errcode = '55000', message = 'A card link''s delivery outcome is recorded once';
  end if;
  return new;
end
$$;
create trigger card_shares_guard before update on identity.card_shares
  for each row execute function identity.guard_card_share_mutation();

create function identity.guard_card_share_code_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if (new.id, new.share_id, new.verifier_hmac, new.key_version, new.requester_sha256, new.created_at, new.expires_at,
      new.max_attempts)
     is distinct from
     (old.id, old.share_id, old.verifier_hmac, old.key_version, old.requester_sha256, old.created_at, old.expires_at,
      old.max_attempts)
     or new.failed_attempts < old.failed_attempts
     or (old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at)
     or (old.invalidated_at is not null
       and (new.invalidated_at, new.invalidated_reason) is distinct from (old.invalidated_at, old.invalidated_reason))
     or ((old.consumed_at is not null or old.invalidated_at is not null) and new.failed_attempts <> old.failed_attempts)
     or (new.network_hmac is distinct from old.network_hmac and new.network_hmac is not null)
     or (old.delivery_outcome <> 'pending' and new.delivery_outcome is distinct from old.delivery_outcome) then
    raise exception using errcode = '55000', message = 'A card link code changes only forward';
  end if;
  return new;
end
$$;
create trigger card_share_codes_guard before update on identity.card_share_codes
  for each row execute function identity.guard_card_share_code_mutation();

create function identity.guard_card_share_view_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if (new.id, new.share_id, new.code_id, new.secret_sha256, new.created_at, new.expires_at)
     is distinct from (old.id, old.share_id, old.code_id, old.secret_sha256, old.created_at, old.expires_at)
     or (old.ended_at is not null and (new.ended_at, new.ended_reason) is distinct from (old.ended_at, old.ended_reason))
     or (new.network_hmac is distinct from old.network_hmac and new.network_hmac is not null) then
    raise exception using errcode = '55000', message = 'A card link view only ends';
  end if;
  return new;
end
$$;
create trigger card_share_views_guard before update on identity.card_share_views
  for each row execute function identity.guard_card_share_view_mutation();

create function identity.guard_card_share_block_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if (new.id, new.recipient_hmac, new.source, new.created_at) is distinct from
     (old.id, old.recipient_hmac, old.source, old.created_at)
     or (old.removed_at is not null and new.removed_at is distinct from old.removed_at) then
    raise exception using errcode = '55000', message = 'An address block is only removed';
  end if;
  return new;
end
$$;
create trigger card_share_address_blocks_guard before update on identity.card_share_address_blocks
  for each row execute function identity.guard_card_share_block_mutation();

do $$
declare table_name text;
begin
  foreach table_name in array array['card_shares', 'card_share_codes', 'card_share_views', 'card_share_patient_emails',
      'card_share_address_blocks'] loop
    execute format('create trigger %I before delete on identity.%I for each row execute function platform.reject_mutation()',
      table_name || '_no_delete', table_name);
    execute format('create trigger %I before truncate on identity.%I for each statement execute function platform.reject_mutation()',
      table_name || '_no_truncate', table_name);
    execute format('alter table identity.%I enable row level security', table_name);
    execute format('alter table identity.%I force row level security', table_name);
    execute format('create policy %I on identity.%I for all using (current_user = %L) with check (current_user = %L)',
      table_name || '_owner', table_name, current_user, current_user);
    execute format('revoke all on identity.%I from public', table_name);
  end loop;
end
$$;

-- 3. Internal helpers (granted to no role).

-- One audit row: ids, codes and counts only. System rows carry no subject or account.
create function identity.card_share_audit(requested_actor_type text, requested_subject text, requested_account_id uuid,
  requested_patient_id uuid, requested_action text, requested_outcome text, requested_share_id uuid,
  requested_details jsonb)
returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id, action, outcome, resource_type,
    resource_id, purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), requested_actor_type,
    case when requested_actor_type = 'system' then null else requested_subject end,
    case when requested_actor_type = 'system' then null else requested_account_id end,
    requested_patient_id, requested_action, requested_outcome, 'card-share', requested_share_id::text,
    case when requested_actor_type = 'patient' then 'patient-self' end, 'application', 'identity-api',
    coalesce(requested_details, '{}'::jsonb)
  );
end
$$;

-- Whether the patient may still have links: active, with a login that is
-- active and not due for deletion. 'active', 'patient_inactive' or 'account_deleted'.
create function identity.card_share_patient_state(requested_patient uuid)
returns text
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_status text;
  account_value uuid;
  account_status text;
begin
  select patient.status, account.id, account.status into patient_status, account_value, account_status
    from identity.patients patient left join auth.accounts account on account.id = patient.account_id
   where patient.id = requested_patient;
  if account_value is null or account_status = 'deleted' or identity.patient_account_deletion_due(account_value) then
    return 'account_deleted';
  end if;
  if patient_status is distinct from 'active' or account_status is distinct from 'active' then
    return 'patient_inactive';
  end if;
  return 'active';
end
$$;

-- Ends a live link: the address erased, its view and live code ended.
create function identity.end_card_share_row(requested_share uuid, requested_reason text)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update identity.card_shares
     set ended_at = clock_timestamp(), ended_reason = requested_reason, recipient_ciphertext = null,
         recipient_key_version = null, locked_until = null, updated_at = clock_timestamp(), row_version = row_version + 1
   where id = requested_share and ended_at is null;
  if not found then return false; end if;
  update identity.card_share_views
     set ended_at = clock_timestamp(), ended_reason = 'share_ended'
   where share_id = requested_share and ended_at is null;
  update identity.card_share_codes
     set invalidated_at = clock_timestamp(), invalidated_reason = 'share_ended'
   where share_id = requested_share and consumed_at is null and invalidated_at is null;
  return true;
end
$$;

-- Ends a link that has passed its end or whose patient can no longer share,
-- with its audit row. Returns whether it ended it.
create function identity.close_card_share_if_due(requested_share identity.card_shares)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  state text;
begin
  if requested_share.ended_at is not null then return true; end if;
  if requested_share.expires_at <= clock_timestamp() then
    perform identity.end_card_share_row(requested_share.id, 'expired');
    perform identity.card_share_audit('system', null, null, requested_share.patient_id, 'identity.card-share.expire',
      'success', requested_share.id, '{}'::jsonb);
    return true;
  end if;
  state := identity.card_share_patient_state(requested_share.patient_id);
  if state <> 'active' then
    perform identity.end_card_share_row(requested_share.id, state);
    perform identity.card_share_audit('system', null, null, requested_share.patient_id, 'identity.card-share.end',
      'success', requested_share.id, jsonb_build_object('reason', state));
    return true;
  end if;
  return false;
end
$$;

-- A link as the patient's list shows it; the service decrypts the address and label.
create function identity.card_share_item(requested_share identity.card_shares)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'id', requested_share.id,
    'reference', requested_share.reference,
    'scope', requested_share.scope,
    'recipientCiphertext', encode(requested_share.recipient_ciphertext, 'base64'),
    'recipientKeyVersion', requested_share.recipient_key_version,
    'recipientHint', requested_share.recipient_hint,
    'duration', requested_share.duration_preset,
    'createdAt', requested_share.created_at,
    'expiresAt', requested_share.expires_at,
    'status', case
      when requested_share.ended_at is not null and requested_share.ended_reason = 'expired' then 'expired'
      when requested_share.ended_at is not null then 'ended'
      when requested_share.expires_at <= clock_timestamp() then 'expired'
      when requested_share.locked_until > clock_timestamp() then 'locked'
      else 'active' end,
    'endedAt', coalesce(requested_share.ended_at,
      case when requested_share.expires_at <= clock_timestamp() then requested_share.expires_at end),
    'endedReason', coalesce(requested_share.ended_reason,
      case when requested_share.expires_at <= clock_timestamp() then 'expired' end),
    'lockedUntil', case when requested_share.ended_at is null and requested_share.locked_until > clock_timestamp()
      then requested_share.locked_until end,
    -- Blocked, capped and failed read the same to the patient (the reason is in the audit only).
    'delivery', case requested_share.delivery_outcome when 'sent' then 'sent' when 'pending' then 'pending'
      else 'not_sent' end,
    'openCount', requested_share.open_count,
    'lastOpenedAt', requested_share.last_opened_at)
$$;

-- The card face a live view shows: the identity half (the EHR answers the rest).
create function identity.card_share_card(requested_share identity.card_shares, requested_view identity.card_share_views)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'viewId', requested_view.id,
    'viewExpiresAt', requested_view.expires_at,
    'fullName', patient.full_name,
    'healthId', patient.hid_code,
    'ninVerified', exists (select 1 from identity.patient_identifiers identifier
                            where identifier.patient_id = patient.id and identifier.identifier_type = 'nin'
                              and identifier.verified),
    'sharedByFirstName', patient.first_name,
    'recipientHint', requested_share.recipient_hint,
    'reference', requested_share.reference,
    'scope', requested_share.scope,
    'expiresAt', requested_share.expires_at)
    from identity.patients patient
   where patient.id = requested_share.patient_id
$$;

-- An email to the patient, when they have a verified address with notifications on (0063's rule).
create function identity.queue_card_share_patient_email(requested_share identity.card_shares, requested_kind text)
returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if not exists (select 1 from integration.verified_notification_recipient(requested_share.patient_id)) then return; end if;
  insert into identity.card_share_patient_emails (id, share_id, patient_id, kind, notice_day, occurred_at, email_status,
    next_attempt_at)
  values (gen_random_uuid(), requested_share.id, requested_share.patient_id, requested_kind,
    (clock_timestamp() at time zone 'Africa/Lagos')::date, clock_timestamp(), 'pending', clock_timestamp())
  on conflict (share_id, kind, notice_day) do nothing;
end
$$;

-- The system:auth context of the receiver's and the sweeper's commands.
create function identity.require_card_share_system()
returns void
language plpgsql stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'A system card-link context is required';
  end if;
end
$$;

-- 3a. The patient sends a link. identity-api has normalised the address,
-- refused the patient's own sign-in address, encrypted {email, label} with
-- the share id as associated data, and keyed the address and the token.
create function identity.create_my_card_share(
  requested_subject text, requested_session uuid, requested_share_id uuid, requested_recipient_hmac text,
  requested_recipient_hint text, requested_recipient_ciphertext bytea, requested_key_version text,
  requested_token_hmac text, requested_scope text, requested_duration text, requested_consent_version text,
  requested_idempotency_key text, requested_request_sha256 text
) returns table (outcome text, share_id uuid, reference text, created_at timestamptz, expires_at timestamptz,
  replaced_share_id uuid, send_email boolean, address_cap_reached boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
  existing identity.card_shares%rowtype;
  previous identity.card_shares%rowtype;
  created identity.card_shares%rowtype;
  blocked boolean;
  capped boolean;
  send boolean;
  reference_value text;
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  random_bytes bytea;
  created_value timestamptz := clock_timestamp();
  hex constant text := '^[0-9a-f]{64}$';
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_share_id is null
     or coalesce(requested_recipient_hmac !~ hex, true) or coalesce(requested_token_hmac !~ hex, true)
     or requested_recipient_hint is null or length(requested_recipient_hint) not between 6 and 120
     or requested_recipient_hint !~ '^[^@[:space:][:cntrl:]]•••@[^@[:space:][:cntrl:]]+$'
     or requested_recipient_ciphertext is null or octet_length(requested_recipient_ciphertext) not between 30 and 2048
     or coalesce(requested_key_version !~ '^[A-Za-z0-9._:-]{1,64}$', true)
     or requested_scope is null or requested_scope not in ('card', 'card_and_records')
     or requested_duration is null or requested_duration not in ('24h', '7d')
     or coalesce(requested_consent_version !~ '^[a-z0-9][a-z0-9._-]{2,63}$', true)
     or coalesce(requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$', true)
     or coalesce(requested_request_sha256 !~ hex, true) then
    raise exception using errcode = '22023', message = 'CARD_SHARE_REQUEST_INVALID';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('card-share:' || patient_id_value::text, 0));
  select * into existing from identity.card_shares share
   where share.patient_id = patient_id_value and share.idempotency_key = requested_idempotency_key;
  if found then
    if existing.request_sha256 <> requested_request_sha256 then
      raise exception using errcode = '55000', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query select 'replayed'::text, existing.id, existing.reference::text, existing.created_at, existing.expires_at,
      (select share.id from identity.card_shares share where share.replaced_by = existing.id), false, false;
    return;
  end if;
  -- This patient's links past their end are closed first.
  for previous in select * from identity.card_shares share
                   where share.patient_id = patient_id_value and share.ended_at is null
                     and share.expires_at <= clock_timestamp()
                   for update loop
    perform identity.close_card_share_if_due(previous);
  end loop;
  if (select count(*) from identity.card_shares share
       where share.patient_id = patient_id_value and share.recipient_hmac = requested_recipient_hmac
         and share.created_at > clock_timestamp() - interval '24 hours') >= 2 then
    raise exception using errcode = 'P0001', message = 'CARD_SHARE_ADDRESS_LIMITED';
  end if;
  if (select count(*) from identity.card_shares share
       where share.patient_id = patient_id_value and share.created_at > clock_timestamp() - interval '24 hours') >= 5 then
    raise exception using errcode = 'P0001', message = 'CARD_SHARE_CREATE_LIMITED';
  end if;
  if (select count(*) from identity.card_shares share
       where share.patient_id = patient_id_value and share.ended_at is null
         and share.recipient_hmac <> requested_recipient_hmac) >= 20 then
    raise exception using errcode = '55000', message = 'CARD_SHARE_LIVE_LIMIT';
  end if;
  -- Across all patients: a blocked address gets nothing; past 50 link emails
  -- in 24 hours the link is made but not emailed (ops alert, never silent).
  perform pg_advisory_xact_lock(hashtextextended('card-share-address:' || requested_recipient_hmac, 0));
  blocked := exists (select 1 from identity.card_share_address_blocks block
                      where block.recipient_hmac = requested_recipient_hmac and block.removed_at is null);
  capped := (select count(*) from identity.card_shares share
              where share.recipient_hmac = requested_recipient_hmac and share.delivery_outcome <> 'not_sent'
                and share.created_at > clock_timestamp() - interval '24 hours') >= 50;
  send := not blocked and not capped;
  loop
    random_bytes := uuid_send(gen_random_uuid());
    reference_value := '';
    for position in 0..7 loop
      if position = 4 then reference_value := reference_value || '-'; end if;
      reference_value := reference_value || substr(alphabet, 1 + (get_byte(random_bytes, position) % 32), 1);
    end loop;
    exit when not exists (select 1 from identity.card_shares share where share.reference = reference_value);
  end loop;
  -- Sending again to the same address ends the earlier link (owner, 2), when this one is emailed. A link that
  -- is not emailed (a blocked or capped address) is recorded already ended, as not_sent, its address erased:
  -- nobody holds its token, so it replaces nothing and never counts as live (review F6).
  previous := null;
  if send then
    select * into previous from identity.card_shares share
     where share.patient_id = patient_id_value and share.recipient_hmac = requested_recipient_hmac
       and share.ended_at is null
     for update;
    if found then
      perform identity.end_card_share_row(previous.id, 'replaced');
    end if;
  end if;
  insert into identity.card_shares (id, patient_id, reference, scope, duration_preset, consent_version,
    recipient_ciphertext, recipient_key_version, recipient_hmac, recipient_hint, token_hmac, created_at, expires_at,
    ended_at, ended_reason, delivery_outcome, delivery_recorded_at, idempotency_key, request_sha256)
  values (requested_share_id, patient_id_value, reference_value, requested_scope, requested_duration,
    requested_consent_version, case when send then requested_recipient_ciphertext end,
    case when send then requested_key_version end, requested_recipient_hmac,
    requested_recipient_hint, requested_token_hmac, created_value,
    created_value + case requested_duration when '24h' then interval '24 hours' else interval '7 days' end,
    case when send then null else created_value end, case when send then null else 'not_sent' end,
    case when send then 'pending' else 'not_sent' end, case when send then null else created_value end,
    requested_idempotency_key, requested_request_sha256)
  returning * into created;
  if previous.id is not null then
    update identity.card_shares set replaced_by = created.id, updated_at = clock_timestamp(), row_version = row_version + 1
     where id = previous.id;
    perform identity.card_share_audit('patient', requested_subject, account_id_value, patient_id_value,
      'identity.card-share.replace', 'success', previous.id, jsonb_build_object('replacedBy', created.id));
  end if;
  perform identity.queue_card_share_patient_email(created, 'created');
  perform identity.card_share_audit('patient', requested_subject, account_id_value, patient_id_value,
    'identity.card-share.create', 'success', created.id,
    jsonb_strip_nulls(jsonb_build_object('scope', created.scope, 'duration', created.duration_preset,
      'consentVersion', created.consent_version, 'emailSent', send, 'replaced', previous.id is not null,
      'notSentReason', case when blocked then 'address_blocked' when capped then 'address_cap' end)));
  return query select 'created'::text, created.id, created.reference::text, created.created_at, created.expires_at,
    previous.id, send, capped;
end
$$;

-- 3a. The patient's links: live ones and those ended in the last 30 days.
create function identity.list_my_card_shares(requested_subject text, requested_session uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
begin
  if patient_id_value is null then return null; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(identity.card_share_item(listed) order by listed.created_at desc, listed.id desc)
      from identity.card_shares listed
     where listed.id in (select share.id from identity.card_shares share
                          where share.patient_id = patient_id_value
                            and coalesce(share.ended_at, least(share.expires_at, clock_timestamp()))
                                  > clock_timestamp() - interval '30 days'
                          order by share.created_at desc, share.id desc
                          limit 50)), '[]'::jsonb),
    'createdToday', (select count(*) from identity.card_shares share
                      where share.patient_id = patient_id_value
                        and share.created_at > clock_timestamp() - interval '24 hours'),
    'liveCount', (select count(*) from identity.card_shares share
                   where share.patient_id = patient_id_value and share.ended_at is null
                     and share.expires_at > clock_timestamp()));
end
$$;

-- 3a. The patient ends a link at once; ending one already ended answers it as it is.
create function identity.end_my_card_share(requested_subject text, requested_session uuid, requested_share_id uuid)
returns table (outcome text, item jsonb)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
  share identity.card_shares%rowtype;
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('card-share:' || patient_id_value::text, 0));
  select * into share from identity.card_shares candidate
   where candidate.id = requested_share_id and candidate.patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'CARD_SHARE_NOT_FOUND';
  end if;
  if share.ended_at is not null or share.expires_at <= clock_timestamp() then
    perform identity.close_card_share_if_due(share);
    select * into share from identity.card_shares candidate where candidate.id = requested_share_id;
    return query select 'already_ended'::text, identity.card_share_item(share);
    return;
  end if;
  perform identity.end_card_share_row(share.id, 'patient_ended');
  perform identity.card_share_audit('patient', requested_subject, account_id_value, patient_id_value,
    'identity.card-share.end', 'success', share.id, jsonb_build_object('reason', 'patient_ended'));
  select * into share from identity.card_shares candidate where candidate.id = requested_share_id;
  return query select 'ended'::text, identity.card_share_item(share);
end
$$;

-- 3a. The new link's email outcome (identity-api, after commit).
create function identity.record_my_card_share_delivery(requested_subject text, requested_session uuid,
  requested_share_id uuid, requested_outcome text, requested_provider text, requested_safe_code text)
returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
  outcome_value text := case requested_outcome when 'accepted' then 'sent' when 'definitive_failure' then 'failed' end;
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_outcome is null or requested_outcome not in ('accepted', 'definitive_failure', 'unknown')
     or (requested_provider is not null and requested_provider !~ '^[a-z][a-z0-9_-]{1,63}$')
     or (requested_safe_code is not null and requested_safe_code !~ '^[a-z0-9_]{1,64}$') then
    raise exception using errcode = '22023', message = 'Invalid delivery outcome';
  end if;
  if outcome_value is null then return; end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  update identity.card_shares share
     set delivery_outcome = outcome_value, delivery_recorded_at = clock_timestamp(), updated_at = clock_timestamp(),
         row_version = share.row_version + 1
   where share.id = requested_share_id and share.patient_id = patient_id_value and share.delivery_outcome = 'pending';
  if found then
    perform identity.card_share_audit('patient', requested_subject, account_id_value, patient_id_value,
      'identity.card-share.delivery', case when outcome_value = 'failed' then 'failure' else 'success' end,
      requested_share_id, jsonb_strip_nulls(jsonb_build_object('outcome', requested_outcome,
        'provider', requested_provider, 'safeCode', requested_safe_code)));
  end if;
end
$$;

-- 3b. "Email me a code". Unknown, ended and expired links answer the same
-- 'ended'. At most one code a minute, 3 an hour and 6 a Lagos day per link.
create function identity.issue_card_share_code(requested_token_hmac text, requested_code_id uuid,
  requested_verifier_hmac text, requested_key_version text, requested_requester_sha256 text,
  requested_network_hmac text)
returns table (outcome text, retry_after_seconds integer, share_id uuid, code_id uuid, recipient_ciphertext bytea,
  recipient_key_version text, recipient_hint text, reference text, code_expires_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  share identity.card_shares%rowtype;
  hex constant text := '^[0-9a-f]{64}$';
  now_value timestamptz := clock_timestamp();
  lagos_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  last_code timestamptz;
  hour_count integer;
  oldest_in_hour timestamptz;
  day_count integer;
  wait integer;
  reason text;
begin
  perform identity.require_card_share_system();
  if coalesce(requested_token_hmac !~ hex, true) or requested_code_id is null
     or coalesce(requested_verifier_hmac !~ hex, true) or coalesce(requested_key_version !~ '^[A-Za-z0-9._:-]{1,64}$', true)
     or coalesce(requested_requester_sha256 !~ hex, true)
     or (requested_network_hmac is not null and requested_network_hmac !~ hex) then
    raise exception using errcode = '22023', message = 'CARD_SHARE_REQUEST_INVALID';
  end if;
  select * into share from identity.card_shares candidate where candidate.token_hmac = requested_token_hmac for update;
  if not found or share.ended_at is not null or identity.close_card_share_if_due(share) then
    return query select 'ended'::text, null::integer, null::uuid, null::uuid, null::bytea, null::text, null::text,
      null::text, null::timestamptz;
    return;
  end if;
  if share.locked_until > now_value then
    return query select 'locked'::text, greatest(1, ceil(extract(epoch from share.locked_until - now_value))::integer),
      null::uuid, null::uuid, null::bytea, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;
  select max(code.created_at), count(*) filter (where code.created_at > now_value - interval '1 hour'),
         min(code.created_at) filter (where code.created_at > now_value - interval '1 hour'),
         count(*) filter (where (code.created_at at time zone 'Africa/Lagos')::date = lagos_today)
    into last_code, hour_count, oldest_in_hour, day_count
    from identity.card_share_codes code where code.share_id = share.id;
  if last_code > now_value - interval '60 seconds' then
    wait := ceil(extract(epoch from last_code + interval '60 seconds' - now_value))::integer; reason := 'resend_wait';
  elsif hour_count >= 3 then
    wait := ceil(extract(epoch from oldest_in_hour + interval '1 hour' - now_value))::integer; reason := 'hourly_limit';
  elsif day_count >= 6 then
    wait := ceil(extract(epoch from ((lagos_today + 1)::timestamp at time zone 'Africa/Lagos') - now_value))::integer;
    reason := 'daily_limit';
  end if;
  if reason is not null then
    perform identity.card_share_audit('system', null, null, share.patient_id, 'identity.card-share.code.issue',
      'denied', share.id, jsonb_build_object('reason', reason, 'codesThisHour', hour_count, 'codesToday', day_count));
    return query select 'limited'::text, greatest(1, wait), null::uuid, null::uuid, null::bytea, null::text, null::text,
      null::text, null::timestamptz;
    return;
  end if;
  update identity.card_share_codes code
     set invalidated_at = now_value, invalidated_reason = case when code.expires_at <= now_value then 'expired' else 'resend' end
   where code.share_id = share.id and code.consumed_at is null and code.invalidated_at is null;
  insert into identity.card_share_codes (id, share_id, verifier_hmac, key_version, requester_sha256, network_hmac,
    created_at, expires_at)
  values (requested_code_id, share.id, requested_verifier_hmac, requested_key_version, requested_requester_sha256,
    requested_network_hmac, now_value, now_value + interval '10 minutes');
  perform identity.card_share_audit('system', null, null, share.patient_id, 'identity.card-share.code.issue',
    'success', share.id, jsonb_build_object('codesThisHour', hour_count + 1, 'codesToday', day_count + 1));
  return query select 'issued'::text, null::integer, share.id, requested_code_id, share.recipient_ciphertext,
    share.recipient_key_version, share.recipient_hint, share.reference::text, now_value + interval '10 minutes';
end
$$;

-- 3b. A code's email outcome: a definitive failure ends the code, so a new one can be asked for.
create function identity.record_card_share_code_delivery(requested_code_id uuid, requested_outcome text)
returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform identity.require_card_share_system();
  if requested_outcome is null or requested_outcome not in ('accepted', 'definitive_failure', 'unknown') then
    raise exception using errcode = '22023', message = 'Invalid delivery outcome';
  end if;
  if requested_outcome = 'unknown' then return; end if;
  update identity.card_share_codes code
     set delivery_outcome = case requested_outcome when 'accepted' then 'sent' else 'failed' end,
         invalidated_at = case when requested_outcome = 'definitive_failure' and code.consumed_at is null
                                    and code.invalidated_at is null then clock_timestamp() else code.invalidated_at end,
         invalidated_reason = case when requested_outcome = 'definitive_failure' and code.consumed_at is null
                                    and code.invalidated_at is null then 'delivery_failed' else code.invalidated_reason end
   where code.id = requested_code_id and code.delivery_outcome = 'pending';
end
$$;

-- 3b. "Open the card": the code typed in the browser that asked for it.
-- Wrong: a try used; 5 kill the code; 3 dead codes lock the link for an
-- hour (the patient is told); a second lock ends the link (told once). A
-- right code dead-code count starts again. Right: one view of 30 minutes,
-- any earlier view of the link ended.
create function identity.verify_card_share_code(requested_token_hmac text, requested_verifier_hmac text,
  requested_requester_sha256 text, requested_view_id uuid, requested_view_secret_sha256 text,
  requested_network_hmac text)
returns table (outcome text, attempts_left integer, retry_after_seconds integer, card jsonb, networks_today integer)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  share identity.card_shares%rowtype;
  code identity.card_share_codes%rowtype;
  view_row identity.card_share_views%rowtype;
  hex constant text := '^[0-9a-f]{64}$';
  now_value timestamptz := clock_timestamp();
  failed integer;
  dead integer;
  locks integer;
  answer text;
  notice_id uuid;
begin
  perform identity.require_card_share_system();
  if coalesce(requested_token_hmac !~ hex, true) or coalesce(requested_verifier_hmac !~ hex, true)
     or coalesce(requested_requester_sha256 !~ hex, true) or requested_view_id is null
     or coalesce(requested_view_secret_sha256 !~ hex, true)
     or (requested_network_hmac is not null and requested_network_hmac !~ hex) then
    raise exception using errcode = '22023', message = 'CARD_SHARE_REQUEST_INVALID';
  end if;
  select * into share from identity.card_shares candidate where candidate.token_hmac = requested_token_hmac for update;
  if not found or share.ended_at is not null or identity.close_card_share_if_due(share) then
    return query select 'ended'::text, null::integer, null::integer, null::jsonb, null::integer;
    return;
  end if;
  if share.locked_until > now_value then
    return query select 'locked'::text, null::integer,
      greatest(1, ceil(extract(epoch from share.locked_until - now_value))::integer), null::jsonb, null::integer;
    return;
  end if;
  select * into code from identity.card_share_codes candidate
   where candidate.share_id = share.id and candidate.consumed_at is null and candidate.invalidated_at is null
   for update;
  if not found then
    perform identity.card_share_audit('system', null, null, share.patient_id, 'identity.card-share.open.refused',
      'denied', share.id, jsonb_build_object('reason', 'no_live_code'));
    return query select 'code_expired'::text, null::integer, null::integer, null::jsonb, null::integer;
    return;
  end if;
  if code.expires_at <= now_value then
    update identity.card_share_codes set invalidated_at = now_value, invalidated_reason = 'expired' where id = code.id;
    perform identity.card_share_audit('system', null, null, share.patient_id, 'identity.card-share.open.refused',
      'denied', share.id, jsonb_build_object('reason', 'code_expired'));
    return query select 'code_expired'::text, null::integer, null::integer, null::jsonb, null::integer;
    return;
  end if;
  -- A right code from another browser counts as a wrong try (critique 6).
  if code.verifier_hmac <> requested_verifier_hmac or code.requester_sha256 <> requested_requester_sha256 then
    failed := code.failed_attempts + 1;
    dead := share.dead_codes;
    locks := share.lock_count;
    answer := 'wrong';
    if failed >= 5 then
      update identity.card_share_codes
         set failed_attempts = failed, invalidated_at = now_value, invalidated_reason = 'attempts_exhausted'
       where id = code.id;
      dead := dead + 1;
      answer := 'code_expired';
      if dead >= 3 then
        locks := locks + 1;
        dead := 0;
        if locks = 1 then
          update identity.card_shares
             set dead_codes = 0, lock_count = 1, locked_until = now_value + interval '1 hour',
                 updated_at = now_value, row_version = row_version + 1
           where id = share.id;
          perform notification.enqueue_patient_inbox_item(share.patient_id, 'SHARED_CARD_LOCKED', 'card-share', share.id,
            jsonb_build_object('recipientHint', share.recipient_hint, 'reference', share.reference));
          answer := 'locked';
        else
          update identity.card_shares set dead_codes = 0, lock_count = 2, updated_at = now_value,
                 row_version = row_version + 1
           where id = share.id;
          perform identity.end_card_share_row(share.id, 'too_many_wrong_codes');
          perform notification.enqueue_patient_inbox_item(share.patient_id, 'SHARED_CARD_ENDED', 'card-share', share.id,
            jsonb_build_object('recipientHint', share.recipient_hint, 'reference', share.reference,
              'reason', 'too_many_wrong_codes'));
          perform identity.card_share_audit('system', null, null, share.patient_id, 'identity.card-share.end',
            'success', share.id, jsonb_build_object('reason', 'too_many_wrong_codes'));
          answer := 'ended';
        end if;
      else
        update identity.card_shares set dead_codes = dead, updated_at = now_value, row_version = row_version + 1
         where id = share.id;
      end if;
    else
      update identity.card_share_codes set failed_attempts = failed where id = code.id;
    end if;
    perform identity.card_share_audit('system', null, null, share.patient_id, 'identity.card-share.open.refused',
      'denied', share.id, jsonb_build_object('reason', 'wrong_code', 'attemptsLeft', greatest(0, 5 - failed),
        'deadCodes', dead, 'locks', locks));
    return query select answer, case when answer = 'wrong' then 5 - failed end,
      case when answer = 'locked' then 3600 end, null::jsonb, null::integer;
    return;
  end if;
  update identity.card_share_codes set consumed_at = now_value where id = code.id;
  update identity.card_share_views set ended_at = now_value, ended_reason = 'replaced'
   where share_id = share.id and ended_at is null;
  insert into identity.card_share_views (id, share_id, code_id, secret_sha256, network_hmac, created_at, expires_at)
  values (requested_view_id, share.id, code.id, requested_view_secret_sha256, requested_network_hmac, now_value,
    now_value + interval '30 minutes')
  returning * into view_row;
  update identity.card_shares
     set open_count = open_count + 1, last_opened_at = now_value, dead_codes = 0, updated_at = now_value,
         row_version = row_version + 1
   where id = share.id
  returning * into share;
  perform identity.card_share_audit('system', null, null, share.patient_id, 'identity.card-share.open', 'success',
    share.id, jsonb_build_object('scope', share.scope, 'openCount', share.open_count));
  -- One notice, so one push, per link per 30 minutes (critique 12): an open within 30 minutes of the notice's
  -- first counts into it (opens) and makes it unread again; 0097 pushes only for an item newer than the last push.
  -- Activity still lists every open.
  select item.id into notice_id from notification.inbox_items item
    join identity.patients patient on patient.account_id = item.account_id
   where patient.id = share.patient_id and item.created_at > now_value - interval '30 minutes'
     and item.notification_code = 'SHARED_CARD_OPENED' and item.resource_type = 'card-share'
     and item.resource_id = share.id
   order by item.created_at desc
   limit 1
   for update of item;
  if notice_id is not null then
    update notification.inbox_items
       set read_at = null, metadata = metadata || jsonb_build_object('opens', coalesce((metadata->>'opens')::integer, 1) + 1)
     where id = notice_id;
  else
    perform notification.enqueue_patient_inbox_item(share.patient_id, 'SHARED_CARD_OPENED', 'card-share', share.id,
      jsonb_build_object('recipientHint', share.recipient_hint, 'reference', share.reference, 'opens', 1));
  end if;
  perform identity.queue_card_share_patient_email(share, 'opened');
  return query select 'opened'::text, null::integer, null::integer, identity.card_share_card(share, view_row),
    (select count(distinct view_seen.network_hmac)::integer from identity.card_share_views view_seen
      where view_seen.share_id = share.id and view_seen.created_at > now_value - interval '24 hours');
end
$$;

-- 3b. The card again for a live view (the page checks every 30 seconds).
create function identity.card_share_view(requested_view_id uuid, requested_secret_sha256 text)
returns table (outcome text, card jsonb)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  view_row identity.card_share_views%rowtype;
  share identity.card_shares%rowtype;
begin
  perform identity.require_card_share_system();
  select * into view_row from identity.card_share_views candidate
   where candidate.id = requested_view_id and candidate.secret_sha256 = requested_secret_sha256
   for update;
  if not found or view_row.ended_at is not null then
    return query select 'ended'::text, null::jsonb;
    return;
  end if;
  select * into share from identity.card_shares candidate where candidate.id = view_row.share_id for update;
  if share.ended_at is not null or identity.close_card_share_if_due(share) then
    return query select 'ended'::text, null::jsonb;
    return;
  end if;
  if view_row.expires_at <= clock_timestamp() then
    update identity.card_share_views set ended_at = clock_timestamp(), ended_reason = 'expired' where id = view_row.id;
    return query select 'ended'::text, null::jsonb;
    return;
  end if;
  return query select 'live'::text, identity.card_share_card(share, view_row);
end
$$;

-- 3b. "Close": the view ends. Unknown or ended views answer the same.
create function identity.end_card_share_view(requested_view_id uuid, requested_secret_sha256 text)
returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform identity.require_card_share_system();
  update identity.card_share_views
     set ended_at = clock_timestamp(), ended_reason = 'closed'
   where id = requested_view_id and secret_sha256 = requested_secret_sha256 and ended_at is null;
  return 'closed';
end
$$;

-- 3b. "Stop these emails" (the stop link in the link and code emails;
-- identity-api checks its keyed tag): the address is blocked and every live
-- link to it ends; each patient is told.
create function identity.stop_card_share_emails(requested_share_id uuid)
returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  hmac_value text;
  live identity.card_shares%rowtype;
begin
  perform identity.require_card_share_system();
  select share.recipient_hmac into hmac_value from identity.card_shares share where share.id = requested_share_id;
  if hmac_value is null then return 'unknown'; end if;
  perform pg_advisory_xact_lock(hashtextextended('card-share-address:' || hmac_value, 0));
  if exists (select 1 from identity.card_share_address_blocks block
              where block.recipient_hmac = hmac_value and block.removed_at is null) then
    return 'already_blocked';
  end if;
  insert into identity.card_share_address_blocks (id, recipient_hmac, source) values (gen_random_uuid(), hmac_value, 'recipient');
  for live in select * from identity.card_shares share
               where share.recipient_hmac = hmac_value and share.ended_at is null
               order by share.id for update loop
    perform identity.end_card_share_row(live.id, 'address_blocked');
    perform notification.enqueue_patient_inbox_item(live.patient_id, 'SHARED_CARD_STOPPED', 'card-share', live.id,
      jsonb_build_object('recipientHint', live.recipient_hint, 'reference', live.reference));
    perform identity.card_share_audit('system', null, null, live.patient_id, 'identity.card-share.end', 'success',
      live.id, jsonb_build_object('reason', 'address_blocked'));
  end loop;
  return 'blocked';
end
$$;

-- 3c. The sweeper: links past their end close; views and codes past theirs
-- end; network data older than 30 days and the hint and address HMAC of links
-- ended over 12 months ago are erased, the hint also from the patient's notices.
create function identity.close_expired_card_shares(requested_limit integer)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  limit_value integer := least(greatest(coalesce(requested_limit, 100), 1), 500);
  share identity.card_shares%rowtype;
  closed integer := 0;
  views_ended integer;
  codes_ended integer;
  networks_erased integer;
  anonymised integer;
begin
  perform identity.require_card_share_system();
  for share in select * from identity.card_shares candidate
                where candidate.ended_at is null and candidate.expires_at <= clock_timestamp()
                order by candidate.expires_at, candidate.id
                limit limit_value
                for update skip locked loop
    if identity.close_card_share_if_due(share) then closed := closed + 1; end if;
  end loop;
  update identity.card_share_views set ended_at = clock_timestamp(), ended_reason = 'expired'
   where ended_at is null and expires_at <= clock_timestamp();
  get diagnostics views_ended = row_count;
  update identity.card_share_codes set invalidated_at = clock_timestamp(), invalidated_reason = 'expired'
   where consumed_at is null and invalidated_at is null and expires_at <= clock_timestamp();
  get diagnostics codes_ended = row_count;
  update identity.card_share_codes set network_hmac = null
   where network_hmac is not null and created_at <= clock_timestamp() - interval '30 days';
  get diagnostics networks_erased = row_count;
  update identity.card_share_views set network_hmac = null
   where network_hmac is not null and created_at <= clock_timestamp() - interval '30 days';
  get diagnostics anonymised = row_count;
  networks_erased := networks_erased + anonymised;
  -- The hint goes from the link and from the patient's notices about it (review F4).
  with anonymised_rows as (
    update identity.card_shares
       set recipient_hmac = null, recipient_hint = null, anonymised_at = clock_timestamp(), updated_at = clock_timestamp(),
           row_version = row_version + 1
     where id in (select candidate.id from identity.card_shares candidate
                   where candidate.anonymised_at is null and candidate.ended_at is not null
                     and candidate.ended_at <= clock_timestamp() - interval '12 months'
                   order by candidate.ended_at limit limit_value)
    returning id, patient_id
  ), stripped as (
    update notification.inbox_items item
       set metadata = item.metadata - 'recipientHint'
      from anonymised_rows done
      join identity.patients patient on patient.id = done.patient_id
     where item.account_id = patient.account_id and item.resource_type = 'card-share' and item.resource_id = done.id
       and item.metadata ? 'recipientHint'
    returning item.id
  )
  select count(*) into anonymised from anonymised_rows;
  if anonymised > 0 or networks_erased > 0 then
    perform identity.card_share_audit('system', null, null, null, 'identity.card-share.retention', 'success', null,
      jsonb_build_object('anonymised', anonymised, 'networksErased', networks_erased));
  end if;
  return jsonb_build_object('closed', closed, 'viewsEnded', views_ended, 'codesEnded', codes_ended,
    'networksErased', networks_erased, 'anonymised', anonymised);
end
$$;

-- 3c. The patient emails due: the recipient is checked again by 0063's
-- rule; at most 5 attempts within 24 hours. Each says whether the link itself was emailed.
create function identity.claim_card_share_emails(requested_worker text, requested_limit integer,
  requested_lease_seconds integer)
returns table (email_id uuid, kind text, recipient text, reference text, recipient_hint text, occurred_at timestamptz,
  link_expires_at timestamptz, attempt_count integer, link_emailed boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  email identity.card_share_patient_emails%rowtype;
  share identity.card_shares%rowtype;
  recipient_value text;
  limit_value integer := least(greatest(coalesce(requested_limit, 10), 1), 50);
  leased integer := 0;
begin
  perform identity.require_card_share_system();
  if requested_worker is null or requested_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     or requested_lease_seconds is null or requested_lease_seconds not between 15 and 600 then
    raise exception using errcode = '22023', message = 'Invalid notification claim';
  end if;
  for email in
    select * from identity.card_share_patient_emails candidate
     where candidate.email_status = 'pending' and candidate.next_attempt_at <= clock_timestamp()
       and (candidate.lease_expires_at is null or candidate.lease_expires_at <= clock_timestamp())
     order by candidate.next_attempt_at, candidate.id
     limit 500
     for update skip locked
  loop
    if email.attempt_count >= 5 or email.occurred_at <= clock_timestamp() - interval '24 hours' then
      update identity.card_share_patient_emails
         set email_status = 'failed', safe_code = case when email.attempt_count >= 5 then 'attempts_exhausted'
               else 'window_elapsed' end, updated_at = clock_timestamp(), row_version = row_version + 1
       where id = email.id;
      continue;
    end if;
    select lower(btrim(candidate.email)) into recipient_value
      from integration.verified_notification_recipient(email.patient_id) candidate;
    if recipient_value is null then
      update identity.card_share_patient_emails
         set email_status = 'not_sent', safe_code = 'no_recipient', updated_at = clock_timestamp(),
             row_version = row_version + 1
       where id = email.id;
      continue;
    end if;
    select * into share from identity.card_shares candidate where candidate.id = email.share_id;
    update identity.card_share_patient_emails
       set lease_owner = requested_worker,
           lease_expires_at = clock_timestamp() + make_interval(secs => requested_lease_seconds),
           attempt_count = attempt_count + 1, updated_at = clock_timestamp(), row_version = row_version + 1
     where id = email.id;
    -- link_emailed: whether the link itself went out (sent, or not yet known); E8 is worded by it (review F6).
    return query select email.id, email.kind, recipient_value, share.reference::text, share.recipient_hint,
      email.occurred_at, share.expires_at, email.attempt_count + 1, share.delivery_outcome in ('pending', 'sent');
    leased := leased + 1;
    exit when leased >= limit_value;
  end loop;
end
$$;

-- 3c. The outcome of one patient email.
create function identity.record_card_share_email_outcome(requested_email_id uuid, requested_worker text,
  requested_outcome text, requested_provider text, requested_safe_code text)
returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  email identity.card_share_patient_emails%rowtype;
  provider_value text := case when requested_provider ~ '^[a-z][a-z0-9_-]{1,63}$' then requested_provider end;
  safe_code_value text := case when requested_safe_code ~ '^[a-z0-9_]{1,64}$' then requested_safe_code end;
  next_status text;
  retry_at timestamptz;
begin
  perform identity.require_card_share_system();
  if requested_outcome is null or requested_outcome not in ('accepted', 'definitive_failure', 'unknown') then
    raise exception using errcode = '22023', message = 'Invalid delivery outcome';
  end if;
  select * into email from identity.card_share_patient_emails candidate
   where candidate.id = requested_email_id and candidate.lease_owner = requested_worker
     and candidate.email_status = 'pending'
   for update;
  if not found then return 'stale_lease'; end if;
  retry_at := clock_timestamp() + make_interval(secs => least(3600, power(2, email.attempt_count)::integer * 60));
  if requested_outcome = 'accepted' then
    next_status := 'delivered';
  elsif requested_outcome = 'definitive_failure' or email.attempt_count >= 5
     or retry_at >= email.occurred_at + interval '24 hours' then
    next_status := 'failed';
  else
    next_status := 'pending';
  end if;
  update identity.card_share_patient_emails
     set email_status = next_status, lease_owner = null, lease_expires_at = null,
         next_attempt_at = case when next_status = 'pending' then retry_at else next_attempt_at end,
         provider = coalesce(provider_value, provider), safe_code = safe_code_value,
         updated_at = clock_timestamp(), row_version = row_version + 1
   where id = email.id;
  return next_status;
end
$$;

-- 3d. EHR: whether the current transaction is a live card-link view of this
-- patient. Only in a card-share transaction (ehr-api's
-- withCardShareTransaction: app.purpose_of_use 'card-share', a correlation
-- id, app.card_view_digest the SHA-256 of a live view's cookie secret) with
-- no patient, account, session, facility or membership set, so it never
-- combines with a patient's or a clinician's context. 'card' (the
-- patient-reported health information) is read under both scopes; 'records'
-- only under "Card and records".
create function ehr.card_share_read_context(requested_patient uuid, requested_part text)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  digest text := nullif(current_setting('app.card_view_digest', true), '');
begin
  if requested_patient is null or requested_part is null or requested_part not in ('card', 'records')
     or digest is null or digest !~ '^[0-9a-f]{64}$'
     or current_setting('app.purpose_of_use', true) is distinct from 'card-share'
     or nullif(current_setting('app.correlation_id', true), '') is null
     or coalesce(current_setting('app.patient_id', true), '') <> ''
     or coalesce(current_setting('app.account_id', true), '') <> ''
     or coalesce(current_setting('app.session_id', true), '') <> ''
     or coalesce(current_setting('app.facility_id', true), '') <> ''
     or coalesce(current_setting('app.membership_id', true), '') <> ''
     or coalesce(current_setting('app.self_authorized_until', true), '') <> '' then
    return false;
  end if;
  return exists (
    select 1
      from identity.card_share_views view_row
      join identity.card_shares share on share.id = view_row.share_id
      join identity.patients patient on patient.id = share.patient_id
      join auth.accounts account on account.id = patient.account_id
     where view_row.secret_sha256 = digest
       and view_row.ended_at is null and view_row.expires_at > statement_timestamp()
       and share.ended_at is null and share.expires_at > statement_timestamp()
       and share.patient_id = requested_patient
       and (requested_part = 'card' or share.scope = 'card_and_records')
       and patient.status = 'active' and account.status = 'active'
       and not identity.patient_account_deletion_due(account.id));
end
$$;

-- 3d. EHR: the live view of this transaction's digest, audited
-- (ehr.card-share.records.read, actor system); 55000 CARD_SHARE_VIEW_ENDED otherwise.
create function ehr.card_share_view_context()
returns table (patient_id uuid, share_id uuid, view_id uuid, scope text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  digest text := nullif(current_setting('app.card_view_digest', true), '');
  found_patient uuid;
  found_share uuid;
  found_view uuid;
  found_scope text;
begin
  if digest is null or digest !~ '^[0-9a-f]{64}$'
     or current_setting('app.purpose_of_use', true) is distinct from 'card-share'
     or nullif(current_setting('app.correlation_id', true), '') is null then
    raise exception using errcode = '42501', message = 'A card-share context is required';
  end if;
  select share.patient_id, share.id, view_row.id, share.scope
    into found_patient, found_share, found_view, found_scope
    from identity.card_share_views view_row
    join identity.card_shares share on share.id = view_row.share_id
   where view_row.secret_sha256 = digest;
  if found_patient is null or not ehr.card_share_read_context(found_patient, 'card') then
    raise exception using errcode = '55000', message = 'CARD_SHARE_VIEW_ENDED';
  end if;
  insert into audit.events (correlation_id, actor_type, patient_id, action, outcome, resource_type, resource_id,
    provenance, source_system, details)
  values (platform.current_correlation_id(), 'system', found_patient, 'ehr.card-share.records.read', 'success',
    'card-share', found_share::text, 'application', 'ehr-api', jsonb_build_object('scope', found_scope));
  return query select found_patient, found_share, found_view, found_scope;
end
$$;

-- 4. When a login is deleted (0096's completion), its patient's links end
-- and are anonymised at once (also the hint in their notices); pending emails are suppressed.
create function identity.close_card_shares_for_deleted_account()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  share identity.card_shares%rowtype;
  ended integer := 0;
  patient_value uuid;
begin
  for share in select candidate.* from identity.card_shares candidate
                 join identity.patients patient on patient.id = candidate.patient_id
                where patient.account_id = new.id
                order by candidate.id for update of candidate loop
    patient_value := share.patient_id;
    if identity.end_card_share_row(share.id, 'account_deleted') then ended := ended + 1; end if;
    update identity.card_shares
       set recipient_hmac = null, recipient_hint = null, anonymised_at = clock_timestamp(),
           updated_at = clock_timestamp(), row_version = row_version + 1
     where id = share.id and anonymised_at is null;
    update identity.card_share_codes set network_hmac = null where share_id = share.id and network_hmac is not null;
    update identity.card_share_views set network_hmac = null where share_id = share.id and network_hmac is not null;
    update identity.card_share_patient_emails
       set email_status = 'suppressed', lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp(),
           row_version = row_version + 1
     where share_id = share.id and email_status = 'pending';
  end loop;
  -- Nothing links the deleted patient to a receiver's address, in the notices either (review F4).
  update notification.inbox_items item
     set metadata = item.metadata - 'recipientHint'
   where item.account_id = new.id and item.resource_type = 'card-share' and item.metadata ? 'recipientHint';
  if patient_value is not null then
    insert into audit.events (correlation_id, actor_type, patient_id, action, outcome, resource_type, provenance,
      source_system, details)
    values (coalesce(platform.current_correlation_id(), 'card-share-account-deleted'), 'system', patient_value,
      'identity.card-share.anonymise', 'success', 'card-share', 'application', 'identity-api',
      jsonb_build_object('ended', ended, 'reason', 'account_deleted'));
  end if;
  return null;
end
$$;
create trigger accounts_deleted_card_shares
  after update of status on auth.accounts
  for each row when (new.status = 'deleted' and old.status is distinct from 'deleted')
  execute function identity.close_card_shares_for_deleted_account();

-- 5. The access log (0093), replaced: card links in Activity.
create or replace function identity.patient_self_access_log(
  requested_subject text, requested_session uuid, requested_limit integer,
  before_occurred_at timestamptz, before_sequence_id bigint
) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  bounded_limit integer := least(greatest(coalesce(requested_limit, 50), 1), 100);
  scan_cap constant integer := 2000;
  scanned integer;
  oldest_cursor text;
  all_islands jsonb;
  island_count integer;
  take_count integer;
  next_cursor jsonb;
  entries jsonb;
begin
  if patient_id_value is null then return null; end if;
  if (before_occurred_at is null) <> (before_sequence_id is null) then
    raise exception using errcode = '22023', message = 'ACCESS_LOG_CURSOR_INVALID';
  end if;
  with raw as materialized (
    select event.sequence_id, event.event_id, event.occurred_at, event.action, event.outcome,
           event.provenance, event.actor_type, event.actor_account_id, event.actor_membership_id,
           event.facility_id, event.resource_id,
           -- Card links only: why a link ended, or that it was not emailed.
           case when event.action = 'identity.card-share.replace' then 'replaced'
                when event.action = 'identity.card-share.expire' then 'expired'
                when event.action = 'identity.card-share.end' then event.details->>'reason'
                when event.action = 'identity.card-share.create' and event.details->>'emailSent' = 'false'
                  then 'not_sent' end as card_reason
      from audit.events event
     where event.patient_id = patient_id_value
       and (before_occurred_at is null
         or (event.occurred_at, event.sequence_id) < (before_occurred_at, before_sequence_id))
     order by event.occurred_at desc, event.sequence_id desc
     limit scan_cap
  ), classified as materialized (
    -- Materialized, so that each row's kind is computed once.
    select raw.*, kinds.kind
      from raw
      cross join lateral (select case
        when raw.outcome <> 'success' or raw.provenance <> 'application' then null
        -- The interceptor's rows and the authorization checks, most of a
        -- chart's rows, without a regular expression.
        when raw.action like 'api.%' or raw.action like '%.request'
          or raw.action = 'identity.authorization.check' then null
        -- Card links (0118): opens by the person the link went to, the
        -- patient's sends, and every ending, the patient's (ended, replaced by
        -- a new link to the same address) and the system's (expired, a second
        -- lock, the address asked to stop, the patient can no longer share).
        when raw.actor_type = 'system' and raw.action = 'identity.card-share.open' then 'card_opened'
        when raw.actor_type = 'patient' and raw.action = 'identity.card-share.create' then 'card_shared'
        when raw.actor_type = 'patient' and raw.action in ('identity.card-share.end', 'identity.card-share.replace')
          then 'card_ended'
        when raw.actor_type = 'system' and raw.action in ('identity.card-share.end', 'identity.card-share.expire')
          then 'card_ended'
        when raw.actor_type = 'staff' and raw.action = 'identity.break-glass.activate' then 'emergency_access'
        when raw.actor_type = 'patient' and raw.action = 'identity.access-request.approve' then 'access_granted'
        when raw.actor_type = 'staff' and raw.action = 'identity.patient-access-pin.verify' then 'access_granted'
        when raw.actor_type = 'staff' and raw.action = 'identity.consent-grant.close' then 'access_ended'
        when raw.actor_type = 'patient' and raw.action = 'identity.consent-grant.patient-revoke' then 'access_ended'
        when raw.actor_type not in ('staff', 'system', 'workload') then null
        when raw.action ~ ('^(ehr\.((encounter|note|note-revision|vital|vital-correction|diagnosis|prescription'
            || '|lab-request)\.(create|update)|note\.import-ocr|document\.upload\.complete'
            || '|order-route\.(send|withdraw))'
            || '|lab\.(result\.(enter|correct|verify|release|revise-released|entered-in-error)'
            || '|specimen\.(collect|receive|reject)|accession\.create|execution\.(start|complete)'
            || '|import\.create|imported-evidence\.create|work-item\.accept'
            || '|order-route\.(cannot-complete|wrong-patient|wrong-patient-correction))'
            || '|pharmacy\.(dispensing\.(create|reverse)|import\.create|imported-medication-evidence\.create'
            || '|work-item\.accept|order-route\.(cannot-complete|wrong-patient|wrong-patient-correction)))$')
          then 'changed'
        when raw.action ~ ('^(ehr\.((encounter|note|note-revision|vital|vital-correction|diagnosis|prescription'
            || '|lab-request|document|order-route)\.(read|list)|document\.(download|ocr-source\.read)'
            || '|imported\.records\.read|emergency\.records\.read'
            || '|imported\.attachment\.download|staff\.chat\.evidence\.read|record\.read)'
            || '|identity\.(patient\.lookup|staff\.chat\.profile\.read)'
            || '|lab\.((work-item|accession|execution|import)\.(read|list)|result\.(history|released)\.read'
            || '|staff\.chat\.released-results\.read|order-route\.(read|accept))'
            || '|pharmacy\.((work-item|dispensing|import)\.(read|list)|order-route\.(read|accept))'
            || '|ocr\.(job\.read|(extraction|validation|publication)\.list))$')
          then 'viewed'
      end as kind) kinds
     where kinds.kind is not null
  ), flagged as (
    select classified.*,
      case when classified.kind in ('viewed', 'changed')
            and lag(classified.kind) over ordered = classified.kind
            and lag(classified.actor_type) over ordered = classified.actor_type
            and lag(classified.actor_account_id) over ordered is not distinct from classified.actor_account_id
            and lag(classified.facility_id) over ordered is not distinct from classified.facility_id
            and lag(classified.occurred_at) over ordered - classified.occurred_at < interval '10 minutes'
           then 0 else 1 end as starts_island
      from classified
    window ordered as (order by classified.occurred_at desc, classified.sequence_id desc)
  ), numbered as (
    select flagged.*,
      sum(flagged.starts_island) over (order by flagged.occurred_at desc, flagged.sequence_id desc
        rows unbounded preceding) as island
      from flagged
  ), islands as (
    select numbered.island,
      (array_agg(numbered.event_id order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as event_id,
      max(numbered.occurred_at) as newest_at,
      (array_agg(numbered.occurred_at order by numbered.occurred_at, numbered.sequence_id))[1] as oldest_at,
      (array_agg(numbered.sequence_id order by numbered.occurred_at, numbered.sequence_id))[1] as oldest_sequence,
      (array_agg(numbered.kind order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as kind,
      (array_agg(numbered.actor_type order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as actor_type,
      (array_agg(numbered.actor_membership_id order by numbered.occurred_at desc, numbered.sequence_id desc))[1]
        as actor_membership_id,
      (array_agg(numbered.facility_id order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as facility_id,
      (array_agg(numbered.resource_id order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as resource_id,
      (array_agg(numbered.card_reason order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as card_reason
      from numbered
     group by numbered.island
  )
  select (select count(*) from raw),
         (select to_char(raw.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || raw.sequence_id
            from raw order by raw.occurred_at, raw.sequence_id limit 1),
         coalesce((select jsonb_agg(jsonb_build_object(
              'id', islands.event_id::text,
              'at', to_char(islands.newest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'action', islands.kind,
              'actorKind', case
                when islands.kind = 'card_opened' then 'card_recipient'
                when islands.actor_type = 'patient' then 'patient'
                when islands.actor_type = 'staff' and islands.actor_membership_id is not null then 'clinician'
                when islands.actor_type = 'staff' then 'support'
                when islands.facility_id is not null then 'facility'
                else 'system' end,
              'membership', case when islands.actor_type = 'staff' then islands.actor_membership_id end,
              'facility', islands.facility_id,
              'share', case when islands.kind in ('card_opened', 'card_shared', 'card_ended') then islands.resource_id end,
              'reason', case when islands.kind in ('card_shared', 'card_ended') then islands.card_reason end,
              'cursor', to_char(islands.oldest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                || '|' || islands.oldest_sequence)
            order by islands.island) from islands), '[]'::jsonb)
    into scanned, oldest_cursor, all_islands;
  island_count := jsonb_array_length(all_islands);
  -- An entry is complete once an older entry follows it in the rows read,
  -- or once every row was read.
  if island_count > bounded_limit then
    take_count := bounded_limit;
    next_cursor := to_jsonb(all_islands -> (take_count - 1) ->> 'cursor');
  elsif scanned >= scan_cap then
    take_count := case when island_count > 1 then island_count - 1 else island_count end;
    next_cursor := case when take_count >= 1 and take_count < island_count
      then to_jsonb(all_islands -> (take_count - 1) ->> 'cursor') else to_jsonb(oldest_cursor) end;
  else
    take_count := island_count;
    next_cursor := null;
  end if;
  -- Names only for the entries returned: the clinician's (staff record of
  -- the membership the row names) and the facility's.
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', element.value->>'id', 'at', element.value->>'at', 'action', element.value->>'action',
      'actorKind', element.value->>'actorKind',
      'actorName', case when element.value->>'actorKind' = 'clinician' then (
        select staff_record.full_name
          from identity.staff_facility_memberships membership
          join identity.staff staff_record on staff_record.id = membership.staff_id
         where membership.id = (element.value->>'membership')::uuid)
        -- A card link's masked address (a•••@gmail.com), while it is kept.
        when element.value->>'share' is not null then (
        select share.recipient_hint from identity.card_shares share
         where share.id::text = element.value->>'share' and share.patient_id = patient_id_value) end,
      'facilityName', (select facility.name from identity.facilities facility
                        where facility.id = (element.value->>'facility')::uuid))
      -- A card link's ending carries its reason, and a send that was not emailed says so (review F5, F6).
      || case when element.value->>'reason' is not null
           then jsonb_build_object('reason', element.value->>'reason') else '{}'::jsonb end
      order by element.ordinality), '[]'::jsonb) into entries
    from jsonb_array_elements(all_islands) with ordinality element(value, ordinality)
   where element.ordinality <= take_count;
  return jsonb_build_object('events', entries, 'next', case when next_cursor is null then null else
    jsonb_build_object('occurredAt', split_part(next_cursor #>> '{}', '|', 1),
                       'sequenceId', split_part(next_cursor #>> '{}', '|', 2)::bigint) end);
end
$$;

-- 6. Grants (here and in runtime-grants.sql).
revoke all on function
  identity.guard_card_share_mutation(), identity.guard_card_share_code_mutation(),
  identity.guard_card_share_view_mutation(), identity.guard_card_share_block_mutation(),
  identity.card_share_audit(text,text,uuid,uuid,text,text,uuid,jsonb), identity.card_share_patient_state(uuid),
  identity.end_card_share_row(uuid,text), identity.close_card_share_if_due(identity.card_shares),
  identity.card_share_item(identity.card_shares), identity.card_share_card(identity.card_shares,identity.card_share_views),
  identity.queue_card_share_patient_email(identity.card_shares,text), identity.require_card_share_system(),
  identity.create_my_card_share(text,uuid,uuid,text,text,bytea,text,text,text,text,text,text,text),
  identity.list_my_card_shares(text,uuid), identity.end_my_card_share(text,uuid,uuid),
  identity.record_my_card_share_delivery(text,uuid,uuid,text,text,text),
  identity.issue_card_share_code(text,uuid,text,text,text,text), identity.record_card_share_code_delivery(uuid,text),
  identity.verify_card_share_code(text,text,text,uuid,text,text), identity.card_share_view(uuid,text),
  identity.end_card_share_view(uuid,text), identity.stop_card_share_emails(uuid),
  identity.close_expired_card_shares(integer), identity.claim_card_share_emails(text,integer,integer),
  identity.record_card_share_email_outcome(uuid,text,text,text,text),
  ehr.card_share_read_context(uuid,text), ehr.card_share_view_context(),
  identity.close_card_shares_for_deleted_account() from public;
do $$
declare grantee text;
begin
  foreach grantee in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant execute on function '
        || 'identity.create_my_card_share(text,uuid,uuid,text,text,bytea,text,text,text,text,text,text,text), '
        || 'identity.list_my_card_shares(text,uuid), identity.end_my_card_share(text,uuid,uuid), '
        || 'identity.record_my_card_share_delivery(text,uuid,uuid,text,text,text), '
        || 'identity.issue_card_share_code(text,uuid,text,text,text,text), '
        || 'identity.record_card_share_code_delivery(uuid,text), '
        || 'identity.verify_card_share_code(text,text,text,uuid,text,text), identity.card_share_view(uuid,text), '
        || 'identity.end_card_share_view(uuid,text), identity.stop_card_share_emails(uuid), '
        || 'identity.close_expired_card_shares(integer), identity.claim_card_share_emails(text,integer,integer), '
        || 'identity.record_card_share_email_outcome(uuid,text,text,text,text) to %I', grantee);
    end if;
  end loop;
  foreach grantee in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant execute on function ehr.card_share_read_context(uuid,text), ehr.card_share_view_context() '
        || 'to %I', grantee);
    end if;
  end loop;
end
$$;

comment on function identity.create_my_card_share(text,uuid,uuid,text,text,bytea,text,text,text,text,text,text,text) is
  '0118: the patient sends a card link: created or replayed; ends the live link to the same address (replaced) when the new one is emailed; 2 a day per address, 5 a day, 20 live; a link to a blocked or capped address is not emailed and is recorded ended (not_sent).';
comment on function identity.issue_card_share_code(text,uuid,text,text,text,text) is
  '0118: "Email me a code": issued, ended (unknown, ended or expired alike), locked or limited (1 a minute, 3 an hour, 6 a Lagos day).';
comment on function identity.verify_card_share_code(text,text,text,uuid,text,text) is
  '0118: "Open the card": opened (one 30-minute view), wrong, code_expired, locked (3 dead codes) or ended (unknown, ended, or a second lock).';
comment on function ehr.card_share_read_context(uuid,text) is
  '0118: true only in a card-share transaction whose digest names a live view of this patient''s live link; records only under "Card and records".';
comment on function ehr.card_share_view_context() is
  '0118: the live card-link view of this transaction, audited as ehr.card-share.records.read; 55000 CARD_SHARE_VIEW_ENDED otherwise.';

-- 7. Post-checks.
do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  select string_agg(relation.oid::regclass::text, ', ') into mismatch
    from pg_class relation
   where relation.oid in ('identity.card_shares'::regclass, 'identity.card_share_codes'::regclass,
       'identity.card_share_views'::regclass, 'identity.card_share_patient_emails'::regclass,
       'identity.card_share_address_blocks'::regclass)
     and (relation.relowner <> applier or not relation.relrowsecurity or not relation.relforcerowsecurity
       or (select count(*) from pg_policy policy where policy.polrelid = relation.oid) <> 1
       or exists (select 1 from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                   where acl.grantee <> relation.relowner));
  if mismatch is null then
    select string_agg(proc.oid::regprocedure::text, ', ') into mismatch
      from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
     where namespace.nspname in ('identity', 'ehr')
       and (proc.proname like '%card_share%' or proc.proname = 'close_card_shares_for_deleted_account')
       and (proc.proowner <> applier
         or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]
         or (proc.proname not like 'guard_%' and proc.proname <> 'require_card_share_system' and not proc.prosecdef));
  end if;
  if mismatch is null
     and (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
           where namespace.nspname in ('identity', 'ehr')
             and (proc.proname like '%card_share%' or proc.proname = 'close_card_shares_for_deleted_account')) <> 28 then
    mismatch := 'the number of new functions';
  end if;
  -- The replaced access log: every attribute but the body as before, and this file's body.
  if mismatch is null then
    select string_agg(replaced.what, ', ') into mismatch
      from card_links_replaced replaced
      join pg_proc proc on proc.oid = replaced.oid
     where (proc.proowner, proc.proacl::text, proc.prolang, proc.provolatile, proc.prosecdef, proc.proconfig::text,
            proc.prorettype, proc.proretset, proc.proargnames::text, proc.proallargtypes::text)
           is distinct from
           (replaced.proowner, replaced.proacl::text, replaced.prolang, replaced.provolatile, replaced.prosecdef,
            replaced.proconfig::text, replaced.prorettype, replaced.proretset, replaced.proargnames::text,
            replaced.proallargtypes::text)
        or md5(proc.prosrc) <> 'd88bbd9bb0a231d655f7f8a34f2a0f9c';
  end if;
  if mismatch is null
     and (select pg_get_triggerdef(trigger_row.oid) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'auth.accounts'::regclass and trigger_row.tgname = 'accounts_deleted_card_shares')
        is distinct from
          'CREATE TRIGGER accounts_deleted_card_shares AFTER UPDATE OF status ON auth.accounts FOR EACH ROW WHEN '
          || '(((new.status = ''deleted''::text) AND (old.status IS DISTINCT FROM ''deleted''::text))) '
          || 'EXECUTE FUNCTION identity.close_card_shares_for_deleted_account()' then
    mismatch := 'the trigger accounts_deleted_card_shares';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0118: post-check failed: %s', mismatch);
  end if;
end
$$;

-- 8. Last: the read policies, under ACCESS EXCLUSIVE on the eleven tables,
-- taken up front in a fixed order and bounded.
do $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.encounters, ehr.clinical_notes, ehr.clinical_note_revisions, ehr.imported_medical_records,
        ehr.imported_medical_record_versions, ehr.imported_medical_record_files, ehr.imported_patient_health_profiles,
        ehr.imported_attachment_bindings, ehr.imported_attachment_scan_events, ehr.patient_reported_health_profiles,
        ehr.patient_entries in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0118: the EHR record tables stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;
create policy encounters_card_share_read on ehr.encounters
  for select using (status = 'completed' and ehr.card_share_read_context(patient_id, 'records'));
create policy clinical_notes_card_share_read on ehr.clinical_notes
  for select using (status in ('signed', 'amended') and ehr.card_share_read_context(patient_id, 'records'));
create policy clinical_note_revisions_card_share_read on ehr.clinical_note_revisions
  for select using (ehr.card_share_read_context(patient_id, 'records') and exists (
    select 1 from ehr.clinical_notes n
     where n.id = clinical_note_revisions.clinical_note_id and n.patient_id = clinical_note_revisions.patient_id
       and n.facility_id = clinical_note_revisions.facility_id and n.current_revision_no = clinical_note_revisions.revision_no
       and n.status in ('signed', 'amended')));
create policy imported_medical_records_card_share_read on ehr.imported_medical_records
  for select using (ehr.card_share_read_context(patient_id, 'records'));
create policy imported_medical_record_versions_card_share_read on ehr.imported_medical_record_versions
  for select using (ehr.card_share_read_context(patient_id, 'records'));
create policy imported_medical_record_files_card_share_read on ehr.imported_medical_record_files
  for select using (ehr.card_share_read_context(patient_id, 'records'));
create policy imported_patient_health_profiles_card_share_read on ehr.imported_patient_health_profiles
  for select using (ehr.card_share_read_context(patient_id, 'records'));
create policy imported_attachment_bindings_card_share_read on ehr.imported_attachment_bindings
  for select using (ehr.card_share_read_context(patient_id, 'records'));
create policy imported_attachment_scan_events_card_share_read on ehr.imported_attachment_scan_events
  for select using (ehr.card_share_read_context(patient_id, 'records'));
create policy patient_reported_health_profiles_card_share_read on ehr.patient_reported_health_profiles
  for select using (ehr.card_share_read_context(patient_id, 'card'));
create policy patient_entries_card_share_read on ehr.patient_entries
  for select using (status = 'active' and ehr.card_share_read_context(patient_id, 'records'));

-- The eleven new policies as written, and the 27 before them unchanged.
do $$
begin
  if (select count(*) from pg_policy policy
       where policy.polrelid = any (pg_temp.card_links_tables()) and policy.polname like '%\_card\_share\_read'
         and policy.polcmd = 'r' and policy.polpermissive) <> 11
     or (select md5(string_agg(format('%s|%s|%s|%s|%s|%s', policy.polrelid::regclass, policy.polname, policy.polcmd,
            policy.polpermissive,
            regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '^\(CURRENT_USER = ''[^'']*''::name\)$', 'owner'),
            regexp_replace(coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), ''),
              '^\(CURRENT_USER = ''[^'']*''::name\)$', 'owner')), E'\n'
            order by policy.polrelid::regclass::text, policy.polname))
           from pg_policy policy
          where policy.polrelid = any (pg_temp.card_links_tables()) and policy.polname not like '%\_card\_share\_read')
        is distinct from 'e7a425cab84af02c5d288224cdd65111' then
    raise exception using errcode = '55000', message = '0118: post-check failed: the read policies of the eleven EHR tables';
  end if;
end
$$;
drop function pg_temp.card_links_tables();
drop function pg_temp.card_links_holds(oid, oid, aclitem[], "char", text);
drop table card_links_replaced;
