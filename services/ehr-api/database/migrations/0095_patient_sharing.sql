-- 0095 Patient sharing (B4; owner decisions of 2026-10-28, migrations
-- pre-approved for this batch, the declaration signed separately): a patient
-- shares their record with a verified clinician they find by name, invites a
-- provider who is not on Health ID yet by email, and is told when a
-- facility's staff open their record.
--
-- Decisions (contract b45-contract.md section 0):
-- D1 Levels map onto the existing grant model, no new scope: view_only and
--    clinical_review are read_records, clinical_collaboration is
--    write_records (which identity.has_active_consent_grant already treats as
--    including read); purpose_of_use is always direct-care; the level is a
--    label in a side table.
-- D2 Durations 24h, 7d, 30d; until_revoked is 365 days, because
--    consent_grants.expires_at is NOT NULL and no grant should never end.
-- D3 The grantee is one clinician at one facility (one membership), eligible
--    when: identity.has_active_membership holds for its account; it has an
--    unrevoked facility-scoped auth.account_roles row doctor, clinician or
--    nurse; auth.membership_has_permission(..., 'identity.consent.write');
--    and its facility's self-service state is none or 'reviewed' (never
--    'pending' or 'released'). A facility in its first 30 days after review
--    is allowed and flagged new.
-- D4 The search shows the least a directory needs: the clinician's name,
--    role, facility, organisation and whether the facility is new; never an
--    email, phone, licence or id but the membership id the share names. A
--    contains-match on the staff name, facility or organisation (3-80
--    characters, % _ \ escaped as 0086's directory does), at most 25
--    candidates (Identity keeps 10 whose name is a person's name). The
--    audit row holds the result count only.
-- D5 Sharing again with the same membership replaces the earlier patient
--    share, in the same transaction ('Replaced by a new share'); grants that
--    did not come from a patient share are left alone.
-- D7 An invitation is an offer both sides confirm: creating one never reads
--    a workforce table (no oracle of who is registered); the invitee accepts
--    from the provider portal with a verified sign-in email equal to the
--    invited address at an eligible membership; the patient then confirms
--    and only then is the grant created, its duration counted from then.
-- D8 Per patient at most 20 open invitations (pending or accepted) and 5 new
--    in any 24 hours; per address, across all patients, at most 3 emails in
--    24 hours (past it the invitation is created, no email is sent, and the
--    patient sees "delivery not confirmed"); an invitation lives 30 days.
-- D9 "Your records were opened": at most one notice per patient, facility
--    and Africa/Lagos day, at most 10 a day per patient, written on the first
--    allowed staff authorization of the day that carries a grant (standard,
--    share or PIN; never break-glass, which already notifies). The inbox
--    notice names the facility; the email names nothing and goes only to a
--    verified account email with notifications on (0063's rule).
-- D10 The clinician learns of a share by an email (Identity, after commit)
--    and by a "Shared with you" list (the patient's Health ID and name, the
--    disclosure a lookup gives once consent exists).
--
-- 0. Preconditions (catalog reads only): every prerequisite exists; no
--    object of this migration exists (else 55000 "0095: already applied");
--    the body replaced in section 4 and the 17 bodies the new ones call or
--    rely on are byte for byte the ones measured on 0001-0094 (md5 of
--    pg_proc.prosrc); the consent_grants CHECKs the grants written here must
--    pass, the two authorization-method CHECKs and the inbox's code and
--    resource-type CHECKs are as 0003, 0033, 0072 and 0037 made them; the
--    applying role, which will own every new table and function, holds (by
--    ownership, membership or grant, never a superuser's bypass) what the
--    new bodies read, write and call: it owns identity.patients and
--    identity.consent_grants (both have row-level security, so a role that
--    does not own them would not see their rows), reads the workforce tables,
--    auth.accounts, identity.facilities, identity.organizations and
--    identity.organization_applications, inserts audit.events, creates in
--    schema identity and executes every function called (the inbox enqueue
--    is granted to no role, so it must own it); and it owns the replaced
--    function. Every attribute of the replaced function but the body is
--    recorded and compared after the replacement (section 5).
--    Then the two locks the new foreign keys need are taken (see Locks).
-- 1. Tables:
--    a. identity.patient_share_invitations: the patient's invitation to an
--       address (lowercased, 3-254 characters, one @), an optional name (never
--       emailed), level and duration, an 8-character reference, status
--       pending -> accepted -> confirmed, or cancelled / expired, with the
--       accepting membership and account, the grant it became, the email's
--       delivery outcome (pending, sent, failed, not_sent), the
--       Idempotency-Key and the request digest. One open invitation per
--       patient and address. Identity fields never change and closed
--       statuses are terminal (guard trigger); never deleted.
--    b. identity.patient_consent_shares: per grant that came from a patient
--       share (search) or a confirmed invitation, its level, duration,
--       membership, the share it replaced and the Idempotency-Key; never
--       changed or deleted.
--    c. identity.record_access_notices: one row per patient, facility and
--       Lagos day, with the grant, the access kind (standard, share, pin),
--       the inbox item and the email's state (pending, delivered, failed,
--       not_sent, suppressed) with its lease and retry; never deleted.
-- 2. Row-level security forced on the three tables, one policy for their
--    owner and no grant: only the SECURITY DEFINER commands touch them.
-- 3. Functions, each SECURITY DEFINER with search_path pg_catalog, pg_temp;
--    the patient commands bound to identity.patient_self_session(subject,
--    session) (42501 without a live patient session), the staff ones to the
--    request's subject, membership and facility (platform.current_*), the
--    system ones to system:auth. Every write and refusal that commits records
--    its audit.events row in the same transaction, with ids, codes and
--    counts only (never an address, name or search text):
--    a. identity.search_share_providers (P1).
--    b. identity.create_my_consent_share (P2): under the patient's advisory
--       lock patient-access-pin:<patient> (0087's), replays an
--       Idempotency-Key with the same digest (55000 IDEMPOTENCY_KEY_REUSED
--       otherwise), refuses a 21st share in 24 hours (P0001) and a membership
--       that is unknown, not eligible or the patient's own account (P0002),
--       then writes the grant (request_id null, granted_by_patient_id the
--       patient, direct-care, starts now), its side row, and D5's revoke.
--    c. identity.list_my_share_invitations / create_my_share_invitation /
--       record_my_share_invitation_delivery / cancel_my_share_invitation /
--       confirm_my_share_invitation (P4-P7).
--    d. identity.list_shared_with_me / list_share_invitations_for_me /
--       accept_share_invitation (S1-S3), identity.consent.write at the
--       caller's membership; accepting enqueues SHARE_INVITATION_ACCEPTED.
--    e. identity.expire_share_invitations (system:auth): pending and
--       accepted invitations past their end become expired, each with
--       SHARE_INVITATION_EXPIRED.
--    f. identity.note_record_access (D9), identity.claim_record_access_alerts
--       and identity.record_record_access_alert_outcome (system:auth; at most
--       5 attempts within 24 hours of the access).
--    Internal, granted to no role: identity.share_provider_eligible (D3),
--    identity.share_staff_actor, identity.write_patient_share,
--    identity.close_expired_share_invitations, identity.share_audit and the
--    guard trigger function.
-- 4. identity.patient_self_access_history (0087), replaced: 0087's body, and
--    each item gains shareLevel, shareDuration and clinicianName (null
--    unless the grant came from a patient share or a confirmed invitation).
--    Every 0087 key, the 50-item limit and the order are unchanged.
-- 5. Post-checks: the replaced function keeps its owner, ACL, language,
--    volatility, SECURITY DEFINER and search_path and its body is the one
--    this file gives it; every new table and function belongs to the
--    applying role; RLS is forced on the three tables; the commands are
--    SECURITY DEFINER with this search_path.
-- 6. Grants, here and in runtime-grants.sql: the 14 commands to
--    hid_identity_runtime and hid_schema_test_runtime; nothing to
--    hid_ehr_runtime; no grant on any table; every new function revoked
--    from PUBLIC. The replaced function keeps its ACL.
--
-- Locks: SHARE ROW EXCLUSIVE on identity.patients and identity.consent_grants
-- (the new foreign keys), taken up front in that order (approval and the PIN
-- write patients' rows' dependents after reading patients), NOWAIT every 10
-- ms for at most 5 seconds (then 55P03, nothing applied), held to commit:
-- they block writes to those two tables (sign-up, approvals, PIN uses,
-- break-glass, revocations) for the apply, never reads. No existing table is
-- altered; replacing the history function neither waits for nor blocks its
-- calls. Every new body is PL/pgSQL, so creating it reads no table. Measured
-- with pg_locks before commit (the file applied in an open transaction on a
-- copy migrated through 0094): SHARE ROW EXCLUSIVE and ACCESS SHARE on
-- identity.patients and identity.consent_grants, ACCESS SHARE on their primary
-- keys; ACCESS EXCLUSIVE (and the weaker locks creating them takes) on the
-- three new tables, their indexes and TOAST tables; ACCESS SHARE on
-- platform.reject_mutation and identity.guard_share_invitation_mutation (the
-- triggers); SHARE UPDATE EXCLUSIVE on four new functions (their comments);
-- ACCESS EXCLUSIVE on section 0's own temporary table and helper and the
-- session's temporary schema; the catalogs' own locks; no lock on any other
-- application table (none on audit.events, auth.accounts, the workforce
-- tables, notification.inbox_items or identity.facilities) and none on the
-- replaced function. The timings and the busy-table test are in
-- config/production-schema-compatibility.json.
--
-- Old services on this schema: every change is additive. The previous
-- Identity image calls none of the new functions and reads none of the new
-- tables; its access history passes the three new keys through unchanged
-- (publishAccessHistory spreads every key) and the website treats them as
-- optional; EHR, Lab, Pharmacy and Notification are untouched. Applied
-- migrations 0001 through 0094 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0090's to 0094's helper).
create function pg_temp.sharing_0095_holds(holder oid, object_owner oid, object_acl aclitem[],
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

create temporary table sharing_0095_replaced as
  select proc.oid, proc.oid::regprocedure::text as what, proc.proowner, proc.proacl, proc.prolang,
         proc.provolatile, proc.prosecdef, proc.proconfig, proc.prorettype, proc.proretset,
         proc.proargnames, proc.proallargtypes
    from pg_proc proc
   where proc.oid = to_regprocedure('identity.patient_self_access_history(text,uuid)');

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  -- a. Prerequisites.
  if to_regclass('identity.patients') is null
     or to_regclass('identity.consent_grants') is null
     or to_regclass('identity.facilities') is null
     or to_regclass('identity.organizations') is null
     or to_regclass('identity.organization_applications') is null
     or to_regclass('identity.staff') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('auth.accounts') is null
     or to_regclass('auth.account_roles') is null
     or to_regclass('audit.events') is null
     or to_regclass('notification.inbox_items') is null
     or to_regclass('identity.patient_contact_changes') is null
     or to_regprocedure('identity.patient_self_session(text,uuid)') is null
     or to_regprocedure('identity.patient_self_access_history(text,uuid)') is null
     or to_regprocedure('identity.revoke_my_consent_grant(text,uuid,uuid,text)') is null
     or to_regprocedure('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)') is null
     or to_regprocedure('integration.verified_notification_recipient(uuid)') is null
     or to_regprocedure('identity.facility_self_service_state(uuid)') is null
     or to_regprocedure('identity.self_service_on_probation(uuid)') is null then
    raise exception using errcode = '55000', message = '0095: 0001-0094 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('identity.patient_share_invitations') is not null
     or to_regclass('identity.patient_consent_shares') is not null
     or to_regclass('identity.record_access_notices') is not null
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where (namespace.nspname, proc.proname) in (
                   ('identity', 'search_share_providers'), ('identity', 'create_my_consent_share'),
                   ('identity', 'list_my_share_invitations'), ('identity', 'create_my_share_invitation'),
                   ('identity', 'record_my_share_invitation_delivery'), ('identity', 'cancel_my_share_invitation'),
                   ('identity', 'confirm_my_share_invitation'), ('identity', 'list_shared_with_me'),
                   ('identity', 'list_share_invitations_for_me'), ('identity', 'accept_share_invitation'),
                   ('identity', 'expire_share_invitations'), ('identity', 'note_record_access'),
                   ('identity', 'claim_record_access_alerts'), ('identity', 'record_record_access_alert_outcome'),
                   ('identity', 'share_provider_eligible'), ('identity', 'share_staff_actor'),
                   ('identity', 'write_patient_share'), ('identity', 'close_expired_share_invitations'),
                   ('identity', 'share_audit'), ('identity', 'guard_share_invitation_mutation'))) then
    raise exception using errcode = '55000', message = '0095: already applied';
  end if;
  -- c. The body replaced (section 4), as 0087 left it.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.patient_self_access_history(text,uuid)', '7d5b6361e7afb2d417b4d1beef577e79'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0095: the function this migration replaces has another body than 0001-0094 gave it: %s', mismatch);
  end if;
  -- d. The bodies the new ones call or rely on, unchanged: the request
  -- context readers, the patient session (0030), the membership, permission
  -- and consent checks behind eligibility and every staff read (0008, 0010,
  -- 0012), the patient's revoke (0087, which ends a share as it ends an
  -- approval), the inbox enqueue (0087), the self-service state and
  -- probation readers (0086) and the state reader they rest on, the verified recipient
  -- rule (0063), the audit table's trigger and the no-delete trigger.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('identity.patient_self_session(text,uuid)', 'd4c7aeaf25317d0fae794a2764d7d72b'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '8b12ce866ee75cce411a2721795ffb92'),
      ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', '0b5689f31a3ce00f9313fe1e55244fad'),
      ('identity.revoke_my_consent_grant(text,uuid,uuid,text)', '247cc02f4309418c68bca5bfc41b676f'),
      ('identity.facility_self_service_state(uuid)', '3cfd1518c546c621c64589da4b3bd3a9'),
      ('identity.self_service_on_probation(uuid)', 'aadd6c3062207fbceb0667401bde8b89'),
      ('identity.organization_self_service_state(uuid)', 'c67aa5224b2aa3d95e4415e26787d470'),
      ('integration.verified_notification_recipient(uuid)', 'efaab7b01d5773a7a63fbdee7eb18a40'),
      ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0095: a function this migration relies on has another body than 0001-0094 gave it: %s', mismatch);
  end if;
  -- e. The consent_grants CHECKs every grant written here passes (scope,
  -- status, expiry after start, the revoked pair, break-glass, grantor,
  -- authorization method, PIN scope), the access requests' authorization
  -- method (0033) the history and the access kind read, and the inbox's
  -- code, resource type and metadata CHECKs the new codes pass (0037).
  select string_agg(format('%s: %s', expected.what, coalesce(actual.definition, 'missing')), '; ')
    into mismatch
    from (values
      ('consent_grants_scope_check',
       $c$CHECK ((scope = ANY (ARRAY['read_records'::text, 'write_records'::text, 'break_glass'::text])))$c$),
      ('consent_grants_status_check',
       $c$CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'expired'::text])))$c$),
      ('consent_grants_check', 'CHECK ((expires_at > starts_at))'),
      ('consent_grants_check2',
       $c$CHECK ((((status = 'revoked'::text) = (revoked_at IS NOT NULL)) OR (source_system <> 'hid'::text)))$c$),
      ('consent_grants_check3',
       $c$CHECK ((((scope = 'break_glass'::text) = break_glass) OR (source_system <> 'hid'::text)))$c$),
      ('consent_grants_grantor_is_patient_ck',
       'CHECK (((granted_by_patient_id IS NULL) OR (granted_by_patient_id = patient_id)))'),
      ('consent_grants_authorization_method_ck',
       $c$CHECK (((authorization_method IS NULL) OR (authorization_method = 'patient_access_pin'::text)))$c$),
      ('access_requests_authorization_method_ck',
       $c$CHECK (((authorization_method IS NULL) OR (authorization_method = 'patient_access_pin'::text)))$c$),
      ('consent_grants_pin_scope_ck',
       $c$CHECK (((authorization_method IS DISTINCT FROM 'patient_access_pin'::text) OR ((scope = 'read_records'::text) AND (purpose_of_use = 'direct-care'::text) AND (break_glass = false))))$c$),
      ('inbox_items_notification_code_check', $c$CHECK ((notification_code ~ '^[A-Z][A-Z0-9_]{2,79}$'::text))$c$),
      ('inbox_items_resource_type_check',
       $c$CHECK (((resource_type IS NULL) OR (resource_type ~ '^[a-z][a-z0-9._:-]{1,63}$'::text)))$c$),
      ('inbox_items_metadata_check', $c$CHECK ((jsonb_typeof(metadata) = 'object'::text))$c$))
         expected(what, definition)
    left join (
      select constraint_row.conname::text as what, pg_get_constraintdef(constraint_row.oid) as definition
        from pg_constraint constraint_row
       where constraint_row.conrelid in ('identity.consent_grants'::regclass, 'identity.access_requests'::regclass,
                                         'notification.inbox_items'::regclass)
         and constraint_row.contype = 'c') actual
      on actual.what = expected.what
   where actual.definition is distinct from expected.definition;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0095: a CHECK this migration relies on differs from 0001-0094: %s', mismatch);
  end if;
  -- f. Privileges, never through a superuser's bypass (production's migrator
  -- has none).
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s lacks %s on %s', holder.rolname, wanted.privilege, relation.oid::regclass) as what
        from (values
          ('identity.patients', 'OWNER'), ('identity.consent_grants', 'OWNER'),
          ('identity.staff', 'SELECT'), ('identity.staff_facility_memberships', 'SELECT'),
          ('auth.account_roles', 'SELECT'), ('auth.accounts', 'SELECT'), ('identity.facilities', 'SELECT'),
          ('identity.organizations', 'SELECT'), ('identity.organization_applications', 'SELECT'),
          ('audit.events', 'INSERT')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
        join pg_roles holder on holder.oid = applier
       where case when wanted.privilege = 'OWNER'
               then not pg_temp.sharing_0095_holds(applier, relation.relowner, null::aclitem[], 'r', 'OWNER')
               else not pg_temp.sharing_0095_holds(applier, relation.relowner, relation.relacl, 'r', wanted.privilege) end
      union all
      select format('%s lacks CREATE on schema %s', holder.rolname, namespace.nspname)
        from pg_namespace namespace
        join pg_roles holder on holder.oid = applier
       where namespace.nspname = 'identity'
         and not pg_temp.sharing_0095_holds(applier, namespace.nspowner, namespace.nspacl, 'n', 'CREATE')
      union all
      select format('%s lacks EXECUTE on %s', holder.rolname, proc.oid::regprocedure)
        from (values
          ('identity.patient_self_session(text,uuid)'), ('platform.current_actor_subject()'),
          ('platform.current_correlation_id()'), ('platform.current_facility_id()'),
          ('platform.current_membership_id()'), ('platform.current_purpose_of_use()'),
          ('identity.has_active_membership(text,uuid,uuid)'), ('auth.membership_has_permission(text,uuid,uuid,text)'),
          ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)'),
          ('integration.verified_notification_recipient(uuid)'), ('identity.facility_self_service_state(uuid)'),
          ('identity.self_service_on_probation(uuid)'), ('identity.organization_self_service_state(uuid)'),
          ('platform.reject_mutation()')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
        join pg_roles holder on holder.oid = applier
       where not pg_temp.sharing_0095_holds(applier, proc.proowner, proc.proacl, 'f', 'EXECUTE')
      union all
      select format('%s is not the owner of %s (owner %s)', current_user, replaced.what, pg_get_userbyid(replaced.proowner))
        from sharing_0095_replaced replaced
       where replaced.proowner <> applier) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0095: missing privileges: %s', mismatch);
  end if;
  if (select count(*) from sharing_0095_replaced) <> 1 then
    raise exception using errcode = '55000', message = '0095: the replaced function was not recorded';
  end if;
  raise notice '0095: owners checked: %', (
    select string_agg(format('%s=%s', owned.what, owned.owner), ', ' order by owned.what)
      from (select replaced.what, pg_get_userbyid(replaced.proowner) as owner from sharing_0095_replaced replaced
            union all
            select relation.oid::regclass::text, pg_get_userbyid(relation.relowner) from pg_class relation
             where relation.oid in ('identity.patients'::regclass, 'identity.consent_grants'::regclass)
            union all
            select 'new tables and functions', current_user::text) owned);
end
$$;

-- The locks the new foreign keys take, up front and bounded.
do $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table identity.patients, identity.consent_grants in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0095: identity.patients or identity.consent_grants stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 1a. Invitations to a provider who may not be on Health ID yet.
create table identity.patient_share_invitations (
  id uuid primary key,
  reference char(8) not null unique check (reference ~ '^[A-Z2-9]{8}$'),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  invitee_email text not null check (invitee_email = lower(btrim(invitee_email))
    and length(invitee_email) between 3 and 254
    and invitee_email ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'),
  invitee_name text check (invitee_name is null
    or (invitee_name ~ '^[^[:cntrl:]<>@]{1,120}$' and invitee_name = btrim(invitee_name))),
  level text not null check (level in ('view_only', 'clinical_review', 'clinical_collaboration')),
  duration_preset text not null check (duration_preset in ('24h', '7d', '30d', 'until_revoked')),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'confirmed', 'cancelled', 'expired')),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_membership_id uuid,
  accepted_account_id uuid,
  confirmed_at timestamptz,
  consent_grant_id uuid references identity.consent_grants(id) on delete restrict,
  cancelled_at timestamptz,
  expired_at timestamptz,
  delivery_outcome text not null check (delivery_outcome in ('pending', 'sent', 'failed', 'not_sent')),
  delivery_recorded_at timestamptz,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  row_version bigint not null default 1 check (row_version > 0),
  updated_at timestamptz not null default clock_timestamp(),
  unique (patient_id, idempotency_key),
  check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  -- Each status carries its facts and no other status's.
  check ((accepted_at is null) = (accepted_membership_id is null)),
  check ((accepted_at is null) = (accepted_account_id is null)),
  check (status <> 'pending' or accepted_at is null),
  check (status not in ('accepted', 'confirmed') or accepted_at is not null),
  check ((status = 'confirmed') = (confirmed_at is not null)),
  check ((status = 'confirmed') = (consent_grant_id is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((status = 'expired') = (expired_at is not null))
);
create unique index patient_share_invitations_open_uq
  on identity.patient_share_invitations (patient_id, invitee_email) where status in ('pending', 'accepted');
create index patient_share_invitations_recipient_idx
  on identity.patient_share_invitations (invitee_email, created_at desc);
create index patient_share_invitations_patient_idx
  on identity.patient_share_invitations (patient_id, created_at desc);
create index patient_share_invitations_due_idx
  on identity.patient_share_invitations (expires_at) where status in ('pending', 'accepted');

-- 1b. The grants that came from a patient share or a confirmed invitation.
create table identity.patient_consent_shares (
  consent_grant_id uuid primary key references identity.consent_grants(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  membership_id uuid not null,
  level text not null check (level in ('view_only', 'clinical_review', 'clinical_collaboration')),
  duration_preset text not null check (duration_preset in ('24h', '7d', '30d', 'until_revoked')),
  created_via text not null check (created_via in ('search', 'invitation')),
  invitation_id uuid unique references identity.patient_share_invitations(id) on delete restrict,
  replaced_consent_grant_id uuid references identity.consent_grants(id) on delete restrict,
  idempotency_key text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) check (request_sha256 is null or request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (patient_id, idempotency_key),
  check ((created_via = 'invitation') = (invitation_id is not null)),
  check ((created_via = 'search') = (idempotency_key is not null)),
  check ((idempotency_key is null) = (request_sha256 is null))
);
create index patient_consent_shares_membership_idx
  on identity.patient_consent_shares (patient_id, membership_id);
create index patient_consent_shares_patient_time_idx
  on identity.patient_consent_shares (patient_id, created_at desc);
create trigger patient_consent_shares_immutable
  before update or delete on identity.patient_consent_shares
  for each row execute function platform.reject_mutation();

-- 1c. "Your records were opened": one row per patient, facility and Lagos day.
create table identity.record_access_notices (
  id uuid primary key,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null,
  membership_id uuid not null,
  consent_grant_id uuid not null,
  notice_day date not null,
  access_kind text not null check (access_kind in ('standard', 'share', 'pin')),
  first_access_at timestamptz not null,
  inbox_item_id uuid,
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
  unique (patient_id, facility_id, notice_day),
  check ((lease_owner is null) = (lease_expires_at is null)),
  check (email_status <> 'pending' or next_attempt_at is not null),
  check (email_status = 'pending' or lease_owner is null)
);
create index record_access_notices_due_idx
  on identity.record_access_notices (next_attempt_at) where email_status = 'pending';
create trigger record_access_notices_no_delete
  before delete on identity.record_access_notices
  for each row execute function platform.reject_mutation();

comment on table identity.patient_share_invitations is
  '0095: a patient''s invitation to share their record with a provider by email; an offer the invitee accepts and the patient confirms. Never deleted.';
comment on table identity.patient_consent_shares is
  '0095: the level, duration and origin of each consent grant a patient made by sharing (search) or by confirming an invitation. Immutable.';
comment on table identity.record_access_notices is
  '0095: one "your records were opened" notice per patient, facility and Africa/Lagos day, and its email''s delivery state.';

-- The invitation's guard: identity fields never change, closed statuses are
-- terminal, an acceptance is never rewritten.
create function identity.guard_share_invitation_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Share invitations are never deleted';
  end if;
  if (new.id, new.reference, new.patient_id, new.invitee_email, new.invitee_name, new.level, new.duration_preset,
      new.created_at, new.expires_at, new.idempotency_key, new.request_sha256)
     is distinct from
     (old.id, old.reference, old.patient_id, old.invitee_email, old.invitee_name, old.level, old.duration_preset,
      old.created_at, old.expires_at, old.idempotency_key, old.request_sha256) then
    raise exception using errcode = '55000', message = 'A share invitation''s identity fields never change';
  end if;
  if old.status in ('confirmed', 'cancelled', 'expired') and new.status is distinct from old.status then
    raise exception using errcode = '55000', message = 'A closed share invitation stays closed';
  end if;
  if old.accepted_at is not null
     and (new.accepted_at, new.accepted_membership_id, new.accepted_account_id)
       is distinct from (old.accepted_at, old.accepted_membership_id, old.accepted_account_id) then
    raise exception using errcode = '55000', message = 'A share invitation''s acceptance never changes';
  end if;
  if (old.status, new.status) not in (('pending', 'pending'), ('pending', 'accepted'), ('pending', 'cancelled'),
      ('pending', 'expired'), ('accepted', 'accepted'), ('accepted', 'confirmed'), ('accepted', 'cancelled'),
      ('accepted', 'expired'), ('confirmed', 'confirmed'), ('cancelled', 'cancelled'), ('expired', 'expired')) then
    raise exception using errcode = '55000', message = 'This share invitation status change is not allowed';
  end if;
  return new;
end
$$;
create trigger patient_share_invitations_guard
  before update or delete on identity.patient_share_invitations
  for each row execute function identity.guard_share_invitation_mutation();

-- 2. Row-level security.
alter table identity.patient_share_invitations enable row level security;
alter table identity.patient_share_invitations force row level security;
alter table identity.patient_consent_shares enable row level security;
alter table identity.patient_consent_shares force row level security;
alter table identity.record_access_notices enable row level security;
alter table identity.record_access_notices force row level security;
do $$
begin
  execute format('create policy patient_share_invitations_owner on identity.patient_share_invitations for all '
    || 'using (current_user = %L) with check (current_user = %L)', current_user, current_user);
  execute format('create policy patient_consent_shares_owner on identity.patient_consent_shares for all '
    || 'using (current_user = %L) with check (current_user = %L)', current_user, current_user);
  execute format('create policy record_access_notices_owner on identity.record_access_notices for all '
    || 'using (current_user = %L) with check (current_user = %L)', current_user, current_user);
end
$$;
revoke all on identity.patient_share_invitations, identity.patient_consent_shares, identity.record_access_notices
  from public;

-- 3. Internal helpers (granted to no role).

-- One audit row: ids, codes and counts only.
create function identity.share_audit(
  requested_actor_type text, requested_subject text, requested_account_id uuid, requested_membership_id uuid,
  requested_facility_id uuid, requested_patient_id uuid, requested_action text, requested_outcome text,
  requested_resource_type text, requested_resource_id uuid, requested_purpose text, requested_details jsonb
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id, facility_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), requested_actor_type,
    case when requested_actor_type = 'system' then null else requested_subject end,
    requested_account_id, requested_membership_id, requested_facility_id, requested_patient_id,
    requested_action, requested_outcome, requested_resource_type, requested_resource_id::text, requested_purpose,
    'application', 'identity-api', coalesce(requested_details, '{}'::jsonb)
  );
end
$$;

-- D3: a membership a patient may share with.
create function identity.share_provider_eligible(requested_membership uuid)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  return exists (
    select 1
      from identity.staff_facility_memberships membership
      join auth.accounts account on account.id = membership.account_id
     where membership.id = requested_membership
       and identity.has_active_membership(account.subject, membership.id, membership.facility_id)
       and exists (select 1 from auth.account_roles assignment
                    where assignment.account_id = membership.account_id
                      and assignment.membership_id = membership.id
                      and assignment.facility_id = membership.facility_id
                      and assignment.scope_type = 'facility'
                      and assignment.revoked_at is null
                      and assignment.role_code in ('doctor', 'clinician', 'nurse'))
       and auth.membership_has_permission(account.subject, membership.id, membership.facility_id,
             'identity.consent.write')
       and coalesce(identity.facility_self_service_state(membership.facility_id), 'reviewed') = 'reviewed'
  );
end
$$;

-- The clinical role a share names: doctor before clinician before nurse.
create function identity.share_provider_role(requested_membership uuid)
returns text
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  return (select assignment.role_code
    from auth.account_roles assignment
    join identity.staff_facility_memberships membership
      on membership.id = assignment.membership_id and membership.account_id = assignment.account_id
     and membership.facility_id = assignment.facility_id
   where assignment.membership_id = requested_membership and assignment.scope_type = 'facility'
     and assignment.revoked_at is null and assignment.role_code in ('doctor', 'clinician', 'nurse')
   order by array_position(array['doctor', 'clinician', 'nurse'], assignment.role_code)
   limit 1);
end
$$;

-- The staff caller of a staff route: the request's subject, membership and
-- facility, with an active membership, the account and organization; 42501
-- otherwise.
create function identity.share_staff_actor()
returns table (actor_subject text, actor_account_id uuid, actor_membership_id uuid, actor_facility_id uuid,
  actor_organization_id uuid, actor_email text, actor_email_verified boolean)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  subject_value text := platform.current_actor_subject();
  membership_value uuid := platform.current_membership_id();
  facility_value uuid := platform.current_facility_id();
begin
  if subject_value is null or membership_value is null or facility_value is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'direct-care'
     or not identity.has_active_membership(subject_value, membership_value, facility_value) then
    raise exception using errcode = '42501', message = 'A staff direct-care context is required';
  end if;
  return query
    select subject_value, account.id, membership.id, membership.facility_id, membership.organization_id,
           account.email, account.email_verified_at is not null
      from identity.staff_facility_memberships membership
      join auth.accounts account on account.id = membership.account_id
     where membership.id = membership_value and membership.facility_id = facility_value
       and account.subject = subject_value;
end
$$;

-- The grant a patient share or a confirmed invitation makes, with its side
-- row and D5's replacement. The caller holds the patient's advisory lock and
-- has checked eligibility.
create function identity.write_patient_share(
  requested_patient_id uuid, requested_account_id uuid, requested_subject text, requested_membership_id uuid,
  requested_level text, requested_duration text, requested_created_via text, requested_invitation_id uuid,
  requested_idempotency_key text, requested_request_sha256 text
) returns table (consent_grant_id uuid, scope text, starts_at timestamptz, expires_at timestamptz,
  replaced_consent_grant_id uuid, staff_id uuid, facility_id uuid, grantee_account_id uuid)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  membership_row identity.staff_facility_memberships%rowtype;
  grant_id_value uuid := gen_random_uuid();
  scope_value text := case requested_level when 'clinical_collaboration' then 'write_records' else 'read_records' end;
  starts_value timestamptz := clock_timestamp();
  expires_value timestamptz;
  replaced_value uuid;
begin
  expires_value := starts_value + case requested_duration
    when '24h' then interval '24 hours' when '7d' then interval '7 days'
    when '30d' then interval '30 days' when 'until_revoked' then interval '365 days' end;
  select * into membership_row from identity.staff_facility_memberships where id = requested_membership_id;
  -- D5: the patient's latest choice replaces their earlier share to this membership.
  select share.consent_grant_id into replaced_value
    from identity.patient_consent_shares share
    join identity.consent_grants grant_row on grant_row.id = share.consent_grant_id
   where share.patient_id = requested_patient_id and share.membership_id = requested_membership_id
     and grant_row.status = 'active' and grant_row.expires_at > starts_value
   order by grant_row.created_at desc
   limit 1
   for update of grant_row;
  if replaced_value is not null then
    update identity.consent_grants
       set status = 'revoked', revoked_at = starts_value, revoked_by = requested_account_id,
           revoked_reason = 'Replaced by a new share', updated_at = starts_value, row_version = row_version + 1
     where id = replaced_value;
    -- Any other active share to this membership (none is ever left by this
    -- command) ends too, so there are never two.
    update identity.consent_grants grant_row
       set status = 'revoked', revoked_at = starts_value, revoked_by = requested_account_id,
           revoked_reason = 'Replaced by a new share', updated_at = starts_value, row_version = row_version + 1
      from identity.patient_consent_shares share
     where share.consent_grant_id = grant_row.id and share.patient_id = requested_patient_id
       and share.membership_id = requested_membership_id and grant_row.status = 'active'
       and grant_row.expires_at > starts_value;
  end if;
  insert into identity.consent_grants (
    id, request_id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
    granted_by_patient_id, reason, starts_at, expires_at, break_glass, correlation_id, purpose_of_use,
    authorization_method
  ) values (
    grant_id_value, null, requested_patient_id, membership_row.staff_id, membership_row.account_id,
    membership_row.id, membership_row.facility_id, scope_value, 'active', requested_patient_id,
    'Shared by the patient', starts_value, expires_value, false, platform.current_correlation_id(),
    'direct-care', null
  );
  insert into identity.patient_consent_shares (
    consent_grant_id, patient_id, membership_id, level, duration_preset, created_via, invitation_id,
    replaced_consent_grant_id, idempotency_key, request_sha256
  ) values (
    grant_id_value, requested_patient_id, requested_membership_id, requested_level, requested_duration,
    requested_created_via, requested_invitation_id, replaced_value, requested_idempotency_key,
    requested_request_sha256
  );
  perform identity.share_audit('patient', requested_subject, requested_account_id, null, membership_row.facility_id,
    requested_patient_id, 'identity.consent-grant.patient-share', 'success', 'consent-grant', grant_id_value,
    'patient-self', jsonb_build_object('scope', scope_value, 'level', requested_level, 'duration', requested_duration,
      'via', requested_created_via, 'replaced', replaced_value is not null,
      'replacedConsentGrantId', replaced_value));
  return query select grant_id_value, scope_value, starts_value, expires_value, replaced_value,
    membership_row.staff_id, membership_row.facility_id, membership_row.account_id;
end
$$;

-- Pending and accepted invitations past their end become expired, each with
-- SHARE_INVITATION_EXPIRED and a system audit row. One patient's, or any
-- (requested_patient null), at most requested_limit.
create function identity.close_expired_share_invitations(requested_patient_id uuid, requested_limit integer)
returns integer
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  invitation record;
  closed integer := 0;
begin
  for invitation in
    select candidate.id, candidate.patient_id
      from identity.patient_share_invitations candidate
     where candidate.status in ('pending', 'accepted') and candidate.expires_at <= clock_timestamp()
       and (requested_patient_id is null or candidate.patient_id = requested_patient_id)
     order by candidate.expires_at, candidate.id
     limit least(greatest(coalesce(requested_limit, 100), 1), 500)
     for update skip locked
  loop
    update identity.patient_share_invitations
       set status = 'expired', expired_at = clock_timestamp(), updated_at = clock_timestamp(),
           row_version = row_version + 1
     where id = invitation.id;
    perform notification.enqueue_patient_inbox_item(invitation.patient_id, 'SHARE_INVITATION_EXPIRED',
      'share-invitation', invitation.id, '{}'::jsonb);
    perform identity.share_audit('system', null, null, null, null, invitation.patient_id,
      'identity.share-invitation.expire', 'success', 'share-invitation', invitation.id, null, '{}'::jsonb);
    closed := closed + 1;
  end loop;
  return closed;
end
$$;

-- 3a. P1: find a clinician to share with (D3, D4).
create function identity.search_share_providers(requested_subject text, requested_session uuid, requested_query text)
returns table (membership_id uuid, clinician_name text, role_code text, facility_name text,
  organization_name text, new_on_health_id boolean)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
  pattern text;
  candidate record;
  found_count integer := 0;
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if not coalesce(length(btrim(requested_query)) between 3 and 80, false) then
    raise exception using errcode = '22023', message = 'SHARE_SEARCH_QUERY_INVALID';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  pattern := '%' || replace(replace(replace(btrim(requested_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  for candidate in
    select membership.id, staff.full_name, facility.id as facility_id, facility.name as facility_name,
           organization.name as organization_name
      from identity.staff_facility_memberships membership
      join identity.staff staff on staff.id = membership.staff_id and staff.account_id = membership.account_id
      join identity.facilities facility on facility.id = membership.facility_id
      join identity.organizations organization on organization.id = membership.organization_id
     where membership.active and staff.active and facility.active and organization.active
       and membership.migration_hold_reason is null
       and membership.account_id <> account_id_value
       and (staff.full_name ilike pattern escape '\' or facility.name ilike pattern escape '\'
         or organization.name ilike pattern escape '\')
       and exists (select 1 from auth.account_roles assignment
                    where assignment.membership_id = membership.id and assignment.account_id = membership.account_id
                      and assignment.facility_id = membership.facility_id and assignment.scope_type = 'facility'
                      and assignment.revoked_at is null and assignment.role_code in ('doctor', 'clinician', 'nurse'))
     order by staff.full_name, membership.id
     limit 200
  loop
    if identity.share_provider_eligible(candidate.id) then
      found_count := found_count + 1;
      return query select candidate.id, candidate.full_name, identity.share_provider_role(candidate.id),
        candidate.facility_name, candidate.organization_name, identity.self_service_on_probation(candidate.facility_id);
      exit when found_count >= 25;
    end if;
  end loop;
  perform identity.share_audit('patient', requested_subject, account_id_value, null, null, patient_id_value,
    'identity.share-providers.search', 'success', 'share-provider-search', null, 'patient-self',
    jsonb_build_object('resultCount', found_count));
end
$$;

-- 3b. P2: share with a clinician found by search.
create function identity.create_my_consent_share(
  requested_subject text, requested_session uuid, requested_membership_id uuid, requested_level text,
  requested_duration text, requested_idempotency_key text, requested_request_sha256 text
) returns table (consent_grant_id uuid, membership_id uuid, scope text, level text, duration_preset text,
  starts_at timestamptz, expires_at timestamptz, clinician_name text, facility_name text,
  replaced_consent_grant_id uuid, replayed boolean, notify_email text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
  share_row identity.patient_consent_shares%rowtype;
  written record;
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_level is null or requested_level not in ('view_only', 'clinical_review', 'clinical_collaboration')
     or requested_duration is null or requested_duration not in ('24h', '7d', '30d', 'until_revoked')
     or requested_membership_id is null
     or coalesce(requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$', true)
     or coalesce(requested_request_sha256 !~ '^[0-9a-f]{64}$', true) then
    raise exception using errcode = '22023', message = 'SHARE_REQUEST_INVALID';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  -- Serialize with PIN use, revocation and other shares of this patient (0087's key).
  perform pg_advisory_xact_lock(hashtextextended('patient-access-pin:' || patient_id_value::text, 0));
  select * into share_row from identity.patient_consent_shares share
   where share.patient_id = patient_id_value and share.idempotency_key = requested_idempotency_key;
  if found then
    if share_row.request_sha256 is distinct from requested_request_sha256 then
      raise exception using errcode = '55000', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query
      select grant_row.id, share_row.membership_id, grant_row.scope, share_row.level, share_row.duration_preset,
             grant_row.starts_at, grant_row.expires_at, staff.full_name, facility.name,
             share_row.replaced_consent_grant_id, true, null::text
        from identity.consent_grants grant_row
        join identity.staff staff on staff.id = grant_row.staff_id
        join identity.facilities facility on facility.id = grant_row.facility_id
       where grant_row.id = share_row.consent_grant_id;
    return;
  end if;
  if (select count(*) from identity.patient_consent_shares share
       where share.patient_id = patient_id_value and share.created_at > clock_timestamp() - interval '24 hours') >= 20 then
    raise exception using errcode = 'P0001', message = 'SHARE_CREATE_LIMITED';
  end if;
  if not identity.share_provider_eligible(requested_membership_id)
     or exists (select 1 from identity.staff_facility_memberships membership
                 where membership.id = requested_membership_id and membership.account_id = account_id_value) then
    raise exception using errcode = 'P0002', message = 'SHARE_PROVIDER_UNAVAILABLE';
  end if;
  select * into written from identity.write_patient_share(patient_id_value, account_id_value, requested_subject,
    requested_membership_id, requested_level, requested_duration, 'search', null, requested_idempotency_key,
    requested_request_sha256);
  return query
    select written.consent_grant_id, requested_membership_id, written.scope, requested_level, requested_duration,
           written.starts_at, written.expires_at, staff.full_name, facility.name, written.replaced_consent_grant_id,
           false, case when account.email_verified_at is not null then lower(account.email) end
      from identity.staff staff
      join identity.facilities facility on facility.id = written.facility_id
      join auth.accounts account on account.id = written.grantee_account_id
     where staff.id = written.staff_id;
end
$$;

-- 3c. P4: the patient's invitations, open ones and those ended in 30 days.
create function identity.list_my_share_invitations(requested_subject text, requested_session uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  items jsonb;
  created_today integer;
begin
  if patient_id_value is null then return null; end if;
  select coalesce(jsonb_agg(entries.item order by entries.created_at desc, entries.id desc), '[]'::jsonb) into items
    from (
      select invitation.id, invitation.created_at, jsonb_build_object(
          'invitationId', invitation.id,
          'reference', invitation.reference,
          'inviteeEmail', invitation.invitee_email,
          'inviteeName', invitation.invitee_name,
          'level', invitation.level,
          'duration', invitation.duration_preset,
          'status', shown.status,
          'createdAt', invitation.created_at,
          'expiresAt', invitation.expires_at,
          'acceptedAt', invitation.accepted_at,
          'deliveryOutcome', case invitation.delivery_outcome when 'sent' then 'sent' when 'pending' then 'pending'
                               else 'not_confirmed' end,
          'offer', case when shown.status = 'accepted' then jsonb_build_object(
              'clinicianName', staff.full_name,
              'role', identity.share_provider_role(invitation.accepted_membership_id),
              'facilityName', facility.name,
              'organizationName', organization.name,
              'newOnHealthId', identity.self_service_on_probation(facility.id)) end,
          'consentGrantId', case when shown.status = 'confirmed' then invitation.consent_grant_id end) as item
        from identity.patient_share_invitations invitation
        cross join lateral (select case when invitation.status in ('pending', 'accepted')
                                          and invitation.expires_at <= clock_timestamp() then 'expired'
                                        else invitation.status end as status) shown
        left join identity.staff_facility_memberships membership on membership.id = invitation.accepted_membership_id
        left join identity.staff staff on staff.id = membership.staff_id
        left join identity.facilities facility on facility.id = membership.facility_id
        left join identity.organizations organization on organization.id = membership.organization_id
       where invitation.patient_id = patient_id_value
         and (shown.status in ('pending', 'accepted')
           or coalesce(invitation.confirmed_at, invitation.cancelled_at, invitation.expired_at, invitation.expires_at)
                > clock_timestamp() - interval '30 days')
       order by invitation.created_at desc, invitation.id desc
       limit 50) entries;
  select count(*) into created_today from identity.patient_share_invitations invitation
   where invitation.patient_id = patient_id_value and invitation.created_at > clock_timestamp() - interval '24 hours';
  return jsonb_build_object('items', items,
    'limits', jsonb_build_object('maxOpen', 20, 'maxNewPerDay', 5, 'remainingToday', greatest(0, 5 - created_today)));
end
$$;

-- 3c. P5: invite a provider by email. Reads no workforce table and no
-- account: the answer is the same whether or not the address is registered.
create function identity.create_my_share_invitation(
  requested_subject text, requested_session uuid, requested_email text, requested_name text, requested_level text,
  requested_duration text, requested_idempotency_key text, requested_request_sha256 text
) returns table (invitation_id uuid, reference text, status text, expires_at timestamptz, send_email boolean,
  replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
  email_value text := lower(btrim(coalesce(requested_email, '')));
  name_value text := nullif(btrim(coalesce(requested_name, '')), '');
  existing identity.patient_share_invitations%rowtype;
  id_value uuid := gen_random_uuid();
  reference_value text;
  alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';
  random_bytes bytea;
  send boolean;
  created_value timestamptz := clock_timestamp();
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if coalesce(requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$', true)
     or coalesce(requested_request_sha256 !~ '^[0-9a-f]{64}$', true)
     or requested_level is null or requested_level not in ('view_only', 'clinical_review', 'clinical_collaboration')
     or requested_duration is null or requested_duration not in ('24h', '7d', '30d', 'until_revoked')
     or (name_value is not null and name_value !~ '^[^[:cntrl:]<>@]{1,120}$') then
    raise exception using errcode = '22023', message = 'SHARE_INVITATION_REQUEST_INVALID';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('patient-share-invitations:' || patient_id_value::text, 0));
  select * into existing from identity.patient_share_invitations invitation
   where invitation.patient_id = patient_id_value and invitation.idempotency_key = requested_idempotency_key;
  if found then
    if existing.request_sha256 is distinct from requested_request_sha256 then
      raise exception using errcode = '55000', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query select existing.id, existing.reference::text, existing.status, existing.expires_at, false, true;
    return;
  end if;
  if length(email_value) not between 3 and 254 or email_value !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$' then
    raise exception using errcode = '22023', message = 'SHARE_INVITATION_EMAIL_INVALID';
  end if;
  -- This patient's invitations already past their end are closed first, so
  -- that an ended invitation never holds the address or a slot.
  perform identity.close_expired_share_invitations(patient_id_value, 50);
  if exists (select 1 from identity.patient_share_invitations invitation
              where invitation.patient_id = patient_id_value and invitation.invitee_email = email_value
                and invitation.status in ('pending', 'accepted')) then
    raise exception using errcode = '55000', message = 'SHARE_INVITATION_ALREADY_OPEN';
  end if;
  if (select count(*) from identity.patient_share_invitations invitation
       where invitation.patient_id = patient_id_value and invitation.status in ('pending', 'accepted')) >= 20 then
    raise exception using errcode = '55000', message = 'SHARE_INVITATION_TOO_MANY_OPEN';
  end if;
  if (select count(*) from identity.patient_share_invitations invitation
       where invitation.patient_id = patient_id_value
         and invitation.created_at > clock_timestamp() - interval '24 hours') >= 5 then
    raise exception using errcode = 'P0001', message = 'SHARE_INVITATION_LIMITED';
  end if;
  -- D8: at most 3 emails to one address in 24 hours, across all patients.
  perform pg_advisory_xact_lock(hashtextextended('patient-share-invitation:' || email_value, 0));
  send := (select count(*) from identity.patient_share_invitations invitation
            where invitation.invitee_email = email_value and invitation.delivery_outcome <> 'not_sent'
              and invitation.created_at > clock_timestamp() - interval '24 hours') < 3;
  loop
    random_bytes := uuid_send(gen_random_uuid());
    reference_value := '';
    for position in 0..7 loop
      reference_value := reference_value || substr(alphabet, 1 + (get_byte(random_bytes, position) % 34), 1);
    end loop;
    exit when not exists (select 1 from identity.patient_share_invitations invitation
                           where invitation.reference = reference_value);
  end loop;
  insert into identity.patient_share_invitations (
    id, reference, patient_id, invitee_email, invitee_name, level, duration_preset, status, created_at, expires_at,
    delivery_outcome, delivery_recorded_at, idempotency_key, request_sha256
  ) values (
    id_value, reference_value, patient_id_value, email_value, name_value, requested_level, requested_duration,
    'pending', created_value, created_value + interval '30 days',
    case when send then 'pending' else 'not_sent' end, case when send then null else created_value end,
    requested_idempotency_key, requested_request_sha256
  );
  perform identity.share_audit('patient', requested_subject, account_id_value, null, null, patient_id_value,
    'identity.share-invitation.create', 'success', 'share-invitation', id_value, 'patient-self',
    jsonb_build_object('level', requested_level, 'duration', requested_duration, 'emailSent', send));
  return query select id_value, reference_value, 'pending'::text, created_value + interval '30 days', send, false;
end
$$;

-- 3c. P5's email outcome (Identity, after commit).
create function identity.record_my_share_invitation_delivery(
  requested_subject text, requested_session uuid, requested_invitation_id uuid, requested_outcome text,
  requested_provider text, requested_safe_code text
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
  outcome_value text := case requested_outcome when 'accepted' then 'sent' when 'definitive_failure' then 'failed'
                          when 'unknown' then 'pending' end;
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if outcome_value is null
     or (requested_provider is not null and requested_provider !~ '^[a-z][a-z0-9_-]{1,63}$')
     or (requested_safe_code is not null and requested_safe_code !~ '^[a-z0-9_]{1,64}$') then
    raise exception using errcode = '22023', message = 'Invalid delivery outcome';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  update identity.patient_share_invitations invitation
     set delivery_outcome = outcome_value, delivery_recorded_at = clock_timestamp(), updated_at = clock_timestamp(),
         row_version = invitation.row_version + 1
   where invitation.id = requested_invitation_id and invitation.patient_id = patient_id_value
     and invitation.delivery_outcome = 'pending';
  if found then
    perform identity.share_audit('patient', requested_subject, account_id_value, null, null, patient_id_value,
      'identity.share-invitation.delivery', case when outcome_value = 'failed' then 'failure' else 'success' end,
      'share-invitation', requested_invitation_id, 'patient-self',
      jsonb_strip_nulls(jsonb_build_object('outcome', requested_outcome, 'provider', requested_provider,
        'safeCode', requested_safe_code)));
  end if;
end
$$;

-- 3c. P6: cancel an invitation (declines an accepted offer).
create function identity.cancel_my_share_invitation(requested_subject text, requested_session uuid,
  requested_invitation_id uuid)
returns table (invitation_id uuid, status text, replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
  invitation identity.patient_share_invitations%rowtype;
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  select * into invitation from identity.patient_share_invitations candidate
   where candidate.id = requested_invitation_id and candidate.patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SHARE_INVITATION_NOT_FOUND';
  end if;
  if invitation.status = 'cancelled' then
    return query select invitation.id, 'cancelled'::text, true;
    return;
  end if;
  if invitation.status not in ('pending', 'accepted') or invitation.expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'SHARE_INVITATION_NOT_CANCELLABLE';
  end if;
  update identity.patient_share_invitations
     set status = 'cancelled', cancelled_at = clock_timestamp(), updated_at = clock_timestamp(),
         row_version = row_version + 1
   where id = invitation.id;
  perform identity.share_audit('patient', requested_subject, account_id_value, null, null, patient_id_value,
    'identity.share-invitation.cancel', 'success', 'share-invitation', invitation.id, 'patient-self',
    jsonb_build_object('wasAccepted', invitation.status = 'accepted'));
  return query select invitation.id, 'cancelled'::text, false;
end
$$;

-- 3c. P7: the patient confirms an accepted offer; the grant starts now.
create function identity.confirm_my_share_invitation(requested_subject text, requested_session uuid,
  requested_invitation_id uuid)
returns table (invitation_id uuid, consent_grant_id uuid, scope text, level text, duration_preset text,
  starts_at timestamptz, expires_at timestamptz, clinician_name text, facility_name text,
  replaced_consent_grant_id uuid, replayed boolean, notify_email text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
  invitation identity.patient_share_invitations%rowtype;
  written record;
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('patient-access-pin:' || patient_id_value::text, 0));
  select * into invitation from identity.patient_share_invitations candidate
   where candidate.id = requested_invitation_id and candidate.patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SHARE_INVITATION_NOT_FOUND';
  end if;
  if invitation.status = 'confirmed' then
    return query
      select invitation.id, grant_row.id, grant_row.scope, share.level, share.duration_preset, grant_row.starts_at,
             grant_row.expires_at, staff.full_name, facility.name, share.replaced_consent_grant_id, true, null::text
        from identity.consent_grants grant_row
        join identity.patient_consent_shares share on share.consent_grant_id = grant_row.id
        join identity.staff staff on staff.id = grant_row.staff_id
        join identity.facilities facility on facility.id = grant_row.facility_id
       where grant_row.id = invitation.consent_grant_id;
    return;
  end if;
  if invitation.status <> 'accepted' or invitation.expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'SHARE_INVITATION_NOT_ACCEPTED';
  end if;
  -- The accepting clinician must still be eligible and still sign in with
  -- the invited, verified address; otherwise the invitation is unchanged.
  if not identity.share_provider_eligible(invitation.accepted_membership_id)
     or not exists (select 1 from identity.staff_facility_memberships membership
                      join auth.accounts account on account.id = membership.account_id
                     where membership.id = invitation.accepted_membership_id
                       and account.id = invitation.accepted_account_id
                       and account.id <> account_id_value
                       and account.email_verified_at is not null
                       and lower(account.email) = invitation.invitee_email) then
    raise exception using errcode = '55000', message = 'SHARE_PROVIDER_UNAVAILABLE';
  end if;
  select * into written from identity.write_patient_share(patient_id_value, account_id_value, requested_subject,
    invitation.accepted_membership_id, invitation.level, invitation.duration_preset, 'invitation', invitation.id,
    null, null);
  update identity.patient_share_invitations
     set status = 'confirmed', confirmed_at = written.starts_at, consent_grant_id = written.consent_grant_id,
         updated_at = clock_timestamp(), row_version = row_version + 1
   where id = invitation.id;
  perform identity.share_audit('patient', requested_subject, account_id_value, null, written.facility_id,
    patient_id_value, 'identity.share-invitation.confirm', 'success', 'share-invitation', invitation.id,
    'patient-self', jsonb_build_object('consentGrantId', written.consent_grant_id));
  return query
    select invitation.id, written.consent_grant_id, written.scope, invitation.level, invitation.duration_preset,
           written.starts_at, written.expires_at, staff.full_name, facility.name, written.replaced_consent_grant_id,
           false, case when account.email_verified_at is not null then lower(account.email) end
      from identity.staff staff
      join identity.facilities facility on facility.id = written.facility_id
      join auth.accounts account on account.id = written.grantee_account_id
     where staff.id = written.staff_id;
end
$$;

-- 3d. S1: the active patient shares to the caller's membership.
create function identity.list_shared_with_me()
returns table (consent_grant_id uuid, patient_id uuid, hid text, full_name text, level text, duration_preset text,
  scope text, starts_at timestamptz, expires_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
  listed integer;
begin
  select * into actor from identity.share_staff_actor();
  if actor.actor_account_id is null
     or not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id, actor.actor_facility_id,
              'identity.consent.write') then
    raise exception using errcode = '42501', message = 'SHARE_PERMISSION_DENIED';
  end if;
  return query
    select grant_row.id, patient.id, patient.hid_code, patient.full_name, share.level, share.duration_preset,
           grant_row.scope, grant_row.starts_at, grant_row.expires_at
      from identity.consent_grants grant_row
      join identity.patient_consent_shares share on share.consent_grant_id = grant_row.id
      join identity.patients patient on patient.id = grant_row.patient_id
     where grant_row.membership_id = actor.actor_membership_id
       and grant_row.facility_id = actor.actor_facility_id
       and grant_row.account_id = actor.actor_account_id
       and grant_row.status = 'active' and grant_row.starts_at <= clock_timestamp()
       and grant_row.expires_at > clock_timestamp() and patient.status = 'active'
     order by grant_row.starts_at desc, grant_row.id desc
     limit 100;
  get diagnostics listed = row_count;
  perform identity.share_audit('staff', actor.actor_subject, actor.actor_account_id, actor.actor_membership_id,
    actor.actor_facility_id, null, 'identity.shared-with-me.list', 'success', 'consent-grant', null, 'direct-care',
    jsonb_build_object('count', listed));
end
$$;

-- 3d. S2: the invitations addressed to the caller's verified sign-in email.
-- No patient identity before the patient confirms.
create function identity.list_share_invitations_for_me()
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  eligible boolean;
  items jsonb := '[]'::jsonb;
begin
  select * into actor from identity.share_staff_actor();
  if actor.actor_account_id is null then
    raise exception using errcode = '42501', message = 'SHARE_PERMISSION_DENIED';
  end if;
  eligible := identity.share_provider_eligible(actor.actor_membership_id);
  if eligible and actor.actor_email_verified and actor.actor_email is not null then
    select coalesce(jsonb_agg(entries.item order by entries.created_at desc, entries.id desc), '[]'::jsonb) into items
      from (
        select invitation.id, invitation.created_at, jsonb_build_object(
            'invitationId', invitation.id, 'reference', invitation.reference, 'inviteeName', invitation.invitee_name,
            'level', invitation.level, 'duration', invitation.duration_preset,
            'createdAt', invitation.created_at, 'expiresAt', invitation.expires_at) as item
          from identity.patient_share_invitations invitation
         where invitation.invitee_email = lower(actor.actor_email) and invitation.status = 'pending'
           and invitation.expires_at > clock_timestamp()
         order by invitation.created_at desc, invitation.id desc
         limit 50) entries;
  end if;
  perform identity.share_audit('staff', actor.actor_subject, actor.actor_account_id, actor.actor_membership_id,
    actor.actor_facility_id, null, 'identity.share-invitation.list-mine', 'success', 'share-invitation', null,
    'direct-care', jsonb_build_object('eligible', eligible, 'count', jsonb_array_length(items)));
  return jsonb_build_object('eligible', eligible, 'items', items);
end
$$;

-- 3d. S3: the invitee accepts at their current membership.
create function identity.accept_share_invitation(requested_invitation_id uuid)
returns table (invitation_id uuid, status text, accepted_at timestamptz, replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
  invitation identity.patient_share_invitations%rowtype;
  facility_name_value text;
begin
  select * into actor from identity.share_staff_actor();
  if actor.actor_account_id is null then
    raise exception using errcode = '42501', message = 'SHARE_PERMISSION_DENIED';
  end if;
  select * into invitation from identity.patient_share_invitations candidate
   where candidate.id = requested_invitation_id
   for update;
  -- Unknown, or not addressed to the caller's verified sign-in email: the
  -- same answer (Identity's interceptor records the refusal).
  if not found or not actor.actor_email_verified or actor.actor_email is null
     or invitation.invitee_email <> lower(actor.actor_email) then
    raise exception using errcode = 'P0002', message = 'SHARE_INVITATION_NOT_FOUND';
  end if;
  if not identity.share_provider_eligible(actor.actor_membership_id) then
    raise exception using errcode = '42501', message = 'SHARE_PROVIDER_NOT_ELIGIBLE';
  end if;
  if invitation.status = 'accepted' and invitation.accepted_membership_id = actor.actor_membership_id then
    return query select invitation.id, 'accepted'::text, invitation.accepted_at, true;
    return;
  end if;
  if invitation.status <> 'pending' or invitation.expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'SHARE_INVITATION_NOT_PENDING';
  end if;
  update identity.patient_share_invitations
     set status = 'accepted', accepted_at = clock_timestamp(), accepted_membership_id = actor.actor_membership_id,
         accepted_account_id = actor.actor_account_id, updated_at = clock_timestamp(), row_version = row_version + 1
   where id = invitation.id
   returning * into invitation;
  select facility.name into facility_name_value from identity.facilities facility where facility.id = actor.actor_facility_id;
  perform notification.enqueue_patient_inbox_item(invitation.patient_id, 'SHARE_INVITATION_ACCEPTED',
    'share-invitation', invitation.id, jsonb_strip_nulls(jsonb_build_object('facilityName', facility_name_value)));
  perform identity.share_audit('staff', actor.actor_subject, actor.actor_account_id, actor.actor_membership_id,
    actor.actor_facility_id, invitation.patient_id, 'identity.share-invitation.accept', 'success', 'share-invitation',
    invitation.id, 'direct-care', '{}'::jsonb);
  return query select invitation.id, 'accepted'::text, invitation.accepted_at, false;
end
$$;

-- 3e. The sweep: pending and accepted invitations past their end.
create function identity.expire_share_invitations(requested_limit integer)
returns integer
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'A system context is required';
  end if;
  return identity.close_expired_share_invitations(null, least(greatest(coalesce(requested_limit, 100), 1), 500));
end
$$;

-- 3f. D9: a staff authorization allowed by a grant notes "your records were
-- opened" once per patient, facility and Lagos day (10 a day at most).
create function identity.note_record_access(requested_consent_grant_id uuid)
returns text
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  subject_value text := platform.current_actor_subject();
  membership_value uuid := platform.current_membership_id();
  facility_value uuid := platform.current_facility_id();
  account_id_value uuid;
  grant_row identity.consent_grants%rowtype;
  day_value date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  kind_value text;
  notice_id_value uuid := gen_random_uuid();
  inbox_id_value uuid;
  facility_name_value text;
  recipient_exists boolean;
begin
  select account.id into account_id_value from auth.accounts account where account.subject = subject_value;
  if account_id_value is null or membership_value is null or facility_value is null
     or platform.current_correlation_id() is null then
    return 'not_applicable';
  end if;
  select * into grant_row from identity.consent_grants candidate
   where candidate.id = requested_consent_grant_id and candidate.membership_id = membership_value
     and candidate.facility_id = facility_value and candidate.account_id = account_id_value
     and candidate.status = 'active' and candidate.starts_at <= clock_timestamp()
     and candidate.expires_at > clock_timestamp() and not candidate.break_glass and candidate.scope <> 'break_glass'
     and candidate.migration_hold_reason is null;
  if not found then
    perform identity.share_audit('staff', subject_value, account_id_value, membership_value, facility_value, null,
      'identity.record-access-notice.note', 'denied', 'consent-grant', null, platform.current_purpose_of_use(),
      jsonb_build_object('reason', 'not_applicable'));
    return 'not_applicable';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('record-access-notice:' || grant_row.patient_id::text, 0));
  if exists (select 1 from identity.record_access_notices notice
              where notice.patient_id = grant_row.patient_id and notice.facility_id = facility_value
                and notice.notice_day = day_value) then
    return 'already_noted';
  end if;
  if (select count(*) from identity.record_access_notices notice
       where notice.patient_id = grant_row.patient_id and notice.notice_day = day_value) >= 10 then
    return 'capped';
  end if;
  kind_value := case
    when grant_row.authorization_method = 'patient_access_pin' then 'pin'
    when exists (select 1 from identity.patient_consent_shares share where share.consent_grant_id = grant_row.id)
      then 'share'
    else 'standard' end;
  select facility.name into facility_name_value from identity.facilities facility where facility.id = facility_value;
  inbox_id_value := notification.enqueue_patient_inbox_item(grant_row.patient_id, 'RECORDS_OPENED', 'record-access',
    notice_id_value, jsonb_strip_nulls(jsonb_build_object('facilityName', facility_name_value, 'accessKind', kind_value)));
  recipient_exists := exists (select 1 from integration.verified_notification_recipient(grant_row.patient_id));
  insert into identity.record_access_notices (
    id, patient_id, facility_id, membership_id, consent_grant_id, notice_day, access_kind, first_access_at,
    inbox_item_id, email_status, next_attempt_at
  ) values (
    notice_id_value, grant_row.patient_id, facility_value, membership_value, grant_row.id, day_value, kind_value,
    clock_timestamp(), inbox_id_value, case when recipient_exists then 'pending' else 'not_sent' end,
    case when recipient_exists then clock_timestamp() end
  );
  perform identity.share_audit('staff', subject_value, account_id_value, membership_value, facility_value,
    grant_row.patient_id, 'identity.record-access-notice.note', 'success', 'record-access', notice_id_value,
    platform.current_purpose_of_use(), jsonb_build_object('accessKind', kind_value));
  return 'noted';
end
$$;

-- 3f. The records-opened emails due (system:auth): the recipient is checked
-- again by 0063's rule; none is not_sent. At most 5 attempts within 24 hours.
create function identity.claim_record_access_alerts(requested_worker text, requested_limit integer,
  requested_lease_seconds integer)
returns table (notice_id uuid, recipient text, occurred_at timestamptz, attempt_count integer)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  notice identity.record_access_notices%rowtype;
  recipient_value text;
  limit_value integer := least(greatest(coalesce(requested_limit, 10), 1), 50);
  leased integer := 0;
begin
  if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'A system notification context is required';
  end if;
  if requested_worker is null or requested_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     or requested_lease_seconds is null or requested_lease_seconds not between 15 and 600 then
    raise exception using errcode = '22023', message = 'Invalid notification claim';
  end if;
  for notice in
    select * from identity.record_access_notices candidate
     where candidate.email_status = 'pending' and candidate.next_attempt_at <= clock_timestamp()
       and (candidate.lease_expires_at is null or candidate.lease_expires_at <= clock_timestamp())
     order by candidate.next_attempt_at, candidate.id
     limit 500
     for update skip locked
  loop
    if notice.attempt_count >= 5 or notice.first_access_at <= clock_timestamp() - interval '24 hours' then
      update identity.record_access_notices
         set email_status = 'failed', lease_owner = null, lease_expires_at = null,
             safe_code = case when notice.attempt_count >= 5 then 'attempts_exhausted' else 'window_elapsed' end,
             updated_at = clock_timestamp(), row_version = row_version + 1
       where id = notice.id;
      perform identity.share_audit('system', null, null, null, notice.facility_id, notice.patient_id,
        'identity.record-access-notice.email.failed', 'failure', 'record-access', notice.id, null,
        jsonb_build_object('reason', case when notice.attempt_count >= 5 then 'attempts_exhausted'
          else 'window_elapsed' end));
      continue;
    end if;
    select lower(btrim(candidate.email)) into recipient_value
      from integration.verified_notification_recipient(notice.patient_id) candidate;
    if recipient_value is null then
      update identity.record_access_notices
         set email_status = 'not_sent', lease_owner = null, lease_expires_at = null, safe_code = 'no_recipient',
             updated_at = clock_timestamp(), row_version = row_version + 1
       where id = notice.id;
      perform identity.share_audit('system', null, null, null, notice.facility_id, notice.patient_id,
        'identity.record-access-notice.email.suppressed', 'success', 'record-access', notice.id, null,
        jsonb_build_object('reason', 'no_recipient'));
      continue;
    end if;
    update identity.record_access_notices
       set lease_owner = requested_worker,
           lease_expires_at = clock_timestamp() + make_interval(secs => requested_lease_seconds),
           attempt_count = attempt_count + 1, updated_at = clock_timestamp(), row_version = row_version + 1
     where id = notice.id;
    return query select notice.id, recipient_value, notice.first_access_at, notice.attempt_count + 1;
    leased := leased + 1;
    exit when leased >= limit_value;
  end loop;
end
$$;

-- 3f. The outcome of one records-opened email.
create function identity.record_record_access_alert_outcome(requested_notice_id uuid, requested_worker text,
  requested_outcome text, requested_provider text, requested_safe_code text)
returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  notice identity.record_access_notices%rowtype;
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
  select * into notice from identity.record_access_notices candidate
   where candidate.id = requested_notice_id and candidate.lease_owner = requested_worker
     and candidate.email_status = 'pending'
   for update;
  if not found then return 'stale_lease'; end if;
  retry_at := clock_timestamp() + make_interval(secs => least(3600, power(2, notice.attempt_count)::integer * 60));
  if requested_outcome = 'accepted' then
    next_status := 'delivered';
  elsif requested_outcome = 'definitive_failure' or notice.attempt_count >= 5
     or retry_at >= notice.first_access_at + interval '24 hours' then
    next_status := 'failed';
  else
    next_status := 'pending';
  end if;
  update identity.record_access_notices
     set email_status = next_status, lease_owner = null, lease_expires_at = null,
         next_attempt_at = case when next_status = 'pending' then retry_at else next_attempt_at end,
         provider = coalesce(provider_value, provider), safe_code = safe_code_value,
         updated_at = clock_timestamp(), row_version = row_version + 1
   where id = notice.id;
  perform identity.share_audit('system', null, null, null, notice.facility_id, notice.patient_id,
    case next_status when 'delivered' then 'identity.record-access-notice.email.delivered'
      when 'failed' then 'identity.record-access-notice.email.failed'
      else 'identity.record-access-notice.email.retry-scheduled' end,
    case when next_status = 'delivered' then 'success' else 'failure' end, 'record-access', notice.id, null,
    jsonb_strip_nulls(jsonb_build_object('attempt', notice.attempt_count, 'provider', provider_value,
      'safeCode', safe_code_value)));
  return next_status;
end
$$;

-- 4. The access history (0087), replaced: 0087's body and three keys from
-- the share a grant came from. Signature, SECURITY DEFINER, STABLE,
-- search_path and result type are 0030's, so CREATE OR REPLACE keeps the
-- owner and the grants.
create or replace function identity.patient_self_access_history(requested_subject text, requested_session uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare patient uuid; result jsonb;
begin
  patient := identity.patient_self_session(requested_subject,requested_session);
  if patient is null then return null; end if;
  select jsonb_build_object('items',coalesce(jsonb_agg(entries.item order by entries.created_at desc,entries.id desc),
      '[]'::jsonb)) into result from (
    select jsonb_build_object('consentGrantId',g.id,'scope',g.scope,'purpose',g.purpose_of_use,
      'status',case when g.status='active' and g.expires_at<=statement_timestamp() then 'expired' else g.status end,
      'startsAt',g.starts_at,'expiresAt',g.expires_at,'reason',g.reason,'facilityName',f.name,
      'breakGlass',g.break_glass or g.scope='break_glass',
      'revocableByPatient',labelled.revocable,
      'shareLevel',s.level,'shareDuration',s.duration_preset,
      'clinicianName',case when s.consent_grant_id is not null then st.full_name end) as item, g.created_at, g.id
    from identity.consent_grants g join identity.facilities f on f.id=g.facility_id
    left join identity.patient_consent_shares s on s.consent_grant_id=g.id
    left join identity.staff st on st.id=g.staff_id and s.consent_grant_id is not null
    cross join lateral (select g.status='active' and g.expires_at>statement_timestamp()
        and not g.break_glass and g.scope<>'break_glass'
        and (g.granted_by_patient_id is not distinct from patient
          or g.authorization_method is not distinct from 'patient_access_pin') as revocable) labelled
    where g.patient_id=patient order by labelled.revocable desc,g.created_at desc,g.id desc limit 50
  ) entries;
  return result;
end;
$$;

-- 5. Post-checks.
do $$
declare mismatch text;
begin
  select string_agg(replaced.what, ', ') into mismatch
    from sharing_0095_replaced replaced
    join pg_proc proc on proc.oid = replaced.oid
   where (proc.proowner, proc.proacl, proc.prolang, proc.provolatile, proc.prosecdef, proc.proconfig,
          proc.prorettype, proc.proretset, proc.proargnames, proc.proallargtypes)
     is distinct from (replaced.proowner, replaced.proacl, replaced.prolang, replaced.provolatile,
          replaced.prosecdef, replaced.proconfig, replaced.prorettype, replaced.proretset,
          replaced.proargnames, replaced.proallargtypes);
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0095: a replaced function changed more than its body: %s', mismatch);
  end if;
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none')), '; ') into mismatch
    from (values
      ('identity.patient_self_access_history(text,uuid)', '0aef8026c24f923c1612280447f99b66'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0095: the replaced body is not the one this file gives: %s', mismatch);
  end if;
  if exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where (namespace.nspname, proc.proname) in (
                ('identity', 'search_share_providers'), ('identity', 'create_my_consent_share'),
                ('identity', 'list_my_share_invitations'), ('identity', 'create_my_share_invitation'),
                ('identity', 'record_my_share_invitation_delivery'), ('identity', 'cancel_my_share_invitation'),
                ('identity', 'confirm_my_share_invitation'), ('identity', 'list_shared_with_me'),
                ('identity', 'list_share_invitations_for_me'), ('identity', 'accept_share_invitation'),
                ('identity', 'expire_share_invitations'), ('identity', 'note_record_access'),
                ('identity', 'claim_record_access_alerts'), ('identity', 'record_record_access_alert_outcome'),
                ('identity', 'share_provider_eligible'), ('identity', 'share_provider_role'),
                ('identity', 'share_staff_actor'), ('identity', 'write_patient_share'),
                ('identity', 'close_expired_share_invitations'), ('identity', 'share_audit'))
                and (proc.proowner <> (select oid from pg_roles where rolname = current_user)
                  or not proc.prosecdef or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]))
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'identity' and proc.proname in ('search_share_providers', 'create_my_consent_share',
            'list_my_share_invitations', 'create_my_share_invitation', 'record_my_share_invitation_delivery',
            'cancel_my_share_invitation', 'confirm_my_share_invitation', 'list_shared_with_me',
            'list_share_invitations_for_me', 'accept_share_invitation', 'expire_share_invitations', 'note_record_access',
            'claim_record_access_alerts', 'record_record_access_alert_outcome', 'share_provider_eligible',
            'share_provider_role', 'share_staff_actor', 'write_patient_share', 'close_expired_share_invitations',
            'share_audit')) <> 20
     or not exists (select 1 from pg_proc proc where proc.oid = 'identity.guard_share_invitation_mutation()'::regprocedure
                     and proc.proowner = (select oid from pg_roles where rolname = current_user)
                     and proc.proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[])
     or exists (select 1 from pg_class relation
                 where relation.oid in ('identity.patient_share_invitations'::regclass,
                   'identity.patient_consent_shares'::regclass, 'identity.record_access_notices'::regclass)
                   and (relation.relowner <> (select oid from pg_roles where rolname = current_user)
                     or not relation.relrowsecurity or not relation.relforcerowsecurity)) then
    raise exception using errcode = '55000', message = '0095: a new table or function is not as this file makes it';
  end if;
end
$$;
drop function pg_temp.sharing_0095_holds(oid, oid, aclitem[], "char", text);
drop table pg_temp.sharing_0095_replaced;

-- 6. Grants (here and in runtime-grants.sql).
revoke all on function identity.share_audit(text,text,uuid,uuid,uuid,uuid,text,text,text,uuid,text,jsonb),
  identity.share_provider_eligible(uuid),
  identity.share_provider_role(uuid),
  identity.share_staff_actor(),
  identity.write_patient_share(uuid,uuid,text,uuid,text,text,text,uuid,text,text),
  identity.close_expired_share_invitations(uuid,integer),
  identity.guard_share_invitation_mutation(),
  identity.search_share_providers(text,uuid,text),
  identity.create_my_consent_share(text,uuid,uuid,text,text,text,text),
  identity.list_my_share_invitations(text,uuid),
  identity.create_my_share_invitation(text,uuid,text,text,text,text,text,text),
  identity.record_my_share_invitation_delivery(text,uuid,uuid,text,text,text),
  identity.cancel_my_share_invitation(text,uuid,uuid),
  identity.confirm_my_share_invitation(text,uuid,uuid),
  identity.list_shared_with_me(),
  identity.list_share_invitations_for_me(),
  identity.accept_share_invitation(uuid),
  identity.expire_share_invitations(integer),
  identity.note_record_access(uuid),
  identity.claim_record_access_alerts(text,integer,integer),
  identity.record_record_access_alert_outcome(uuid,text,text,text,text) from public;

do $$
declare grantee text;
begin
  foreach grantee in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant execute on function identity.search_share_providers(text,uuid,text), '
        || 'identity.create_my_consent_share(text,uuid,uuid,text,text,text,text), '
        || 'identity.list_my_share_invitations(text,uuid), '
        || 'identity.create_my_share_invitation(text,uuid,text,text,text,text,text,text), '
        || 'identity.record_my_share_invitation_delivery(text,uuid,uuid,text,text,text), '
        || 'identity.cancel_my_share_invitation(text,uuid,uuid), '
        || 'identity.confirm_my_share_invitation(text,uuid,uuid), '
        || 'identity.list_shared_with_me(), '
        || 'identity.list_share_invitations_for_me(), '
        || 'identity.accept_share_invitation(uuid), '
        || 'identity.expire_share_invitations(integer), '
        || 'identity.note_record_access(uuid), '
        || 'identity.claim_record_access_alerts(text,integer,integer), '
        || 'identity.record_record_access_alert_outcome(uuid,text,text,text,text) to %I', grantee);
    end if;
  end loop;
end
$$;

comment on function identity.search_share_providers(text,uuid,text) is
  '0095: the live patient session''s search for a clinician to share with: at most 25 eligible memberships whose clinician, facility or organisation name contains the query (3-80 characters); name, role, facility, organisation and whether the facility is new only.';
comment on function identity.create_my_consent_share(text,uuid,uuid,text,text,text,text) is
  '0095: the live patient session shares their record with an eligible membership at a level (view_only, clinical_review: read_records; clinical_collaboration: write_records) for 24h, 7d, 30d or until revoked (365 days); replaces the earlier share to that membership; idempotent by key.';
comment on function identity.create_my_share_invitation(text,uuid,text,text,text,text,text,text) is
  '0095: the live patient session invites an address to share; reads no workforce table or account, so the answer is the same whether or not the address is registered; at most 20 open, 5 a day, 3 emails a day per address.';
comment on function identity.note_record_access(uuid) is
  '0095: a staff authorization allowed by a non-emergency grant notes "your records were opened" once per patient, facility and Africa/Lagos day (at most 10 a day): an inbox item naming the facility and, for a verified email with notifications on, an email naming nothing.';
