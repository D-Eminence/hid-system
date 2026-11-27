-- 0209 CHW-1 (provisional): community_health_worker, an Outreach-only role
-- for hospitals and clinics. Written on
-- claude/nifty-lovelace-2ib9pm-chw1-role at staging 0cfddcc9 (0001-0153
-- applied: Releases A to C, 0150-0151 and Release E, live). The number is
-- provisional (given at integration, in release order, #258). No migration
-- number appears inside a function body this file makes or changes, so
-- renumbering keeps every md5. The declaration in
-- config/production-schema-compatibility.json is not part of this file and
-- stays as it is until the owner signs it.
--
-- Owner decision Q130 A (19 November 2026): "a new Outreach-only role, for
-- field health workers who register and screen people but never open the
-- clinical record" (docs/EHR_PLANNED_CONTRACT.md, CHW-1). Built at the
-- design note's recommended answers (hid-system #258, comment 7192282694),
-- not yet answered by the owner: no registration number is recorded in this
-- release; export, campaign scope and mixed memberships stay as today;
-- 0086's single "Change role" (identity.change_facility_staff_role) does not
-- offer the role (SX-4's add and remove give it).
--
-- WHAT IT DOES (nothing else)
-- H1 auth.roles: community_health_worker, active ("Community health worker:
--    registers and screens people in outreach campaigns (Outreach only)").
-- H2 auth.role_permissions: three rows, exactly outreach_volunteer's (0115):
--    outreach.campaign.read, outreach.registration.read and
--    outreach.registration.write. No identity.*, ehr.*, lab.*, pharmacy.*,
--    ocr.*, workforce.manage, consent or break-glass code. No other role's
--    row changes and no member is given the role.
-- H3 The 0115 fence (identity.enforce_outreach_tenant_roles(), the function
--    of trigger account_roles_outreach_fence on auth.account_roles) gains one
--    rule, inserted after its three checks and nothing else changed: an
--    active community_health_worker grant (revoked_at null) is refused with
--    P0001 COMMUNITY_HEALTH_WORKER_ONLY_AT_HOSPITAL at platform scope, and at
--    a facility whose organisation is not a hospital or clinic. "Hospital or
--    clinic" is identity.organization_staff_kinds (0126): no kind recorded
--    (Q91 A: governed, legacy and sealed tenants) or a kind hospital or clinic
--    (0126 reads 'other' with ehr or migrate as hospital). At an outreach
--    group the fence's existing rule already refuses it
--    (OUTREACH_GROUP_ROLE_INVALID). A revocation always passes; the FOR SHARE
--    read of the group is kept. CREATE OR REPLACE from the live body (md5
--    pinned before and after), so owner, ACL {owner=X}, SECURITY DEFINER and
--    search_path (pg_catalog, identity, auth, pg_temp; every name the new
--    rule reads is schema-qualified) stay as they are.
-- H4 The staff vocabulary, the 0162/0194 way (CREATE OR REPLACE from each
--    function's current definition, so owner, ACL, SECURITY DEFINER,
--    volatility and search_path stay as they are):
--    identity.staff_invitable_roles(text, text) gains
--      'community_health_worker' at the end of the hospital and clinic list
--      (the branch that also covers 'other' with ehr or migrate); never the
--      laboratory or pharmacy list. identity.staff_role_change_roles (0139,
--      support's list) reads it, so support can add the role at a hospital;
--    six functions whose bodies hold the invitable list and the front desk's
--      "no licence" test join the role to the front desk's unlicensed group,
--      exactly as 0162 does for cashier:
--        R1 the list ('doctor', ..., 'receptionist'[, other lanes' roles])
--           gains 'community_health_worker' at its end;
--        R2 = 'receptionist' becomes in ('receptionist',
--           'community_health_worker') (or 0162's in (...) list gains it);
--        R3 <> 'receptionist' becomes not in (...) the same way;
--      identity.staff_invitation_fields_valid (R1 1, R2 1, R3 1),
--      identity.attach_invited_member (R3 1: accepting a community health
--        worker's invitation writes no licence attestation),
--      identity.add_facility_staff_role (R1 1, R2 7, R3 1),
--      identity.remove_facility_staff_role (R1 1),
--      identity.admin_add_facility_staff_role (R1 1, R2 6, R3 1),
--      identity.admin_remove_facility_staff_role (R1 1).
--      identity.change_facility_staff_role is not changed (the design note's
--      default: SX-4 is the way to give the role).
--    identity.staff_invitations: staff_invitations_role_code_check gains the
--      role at its end and staff_invitations_licence_ck puts it in the
--      no-licence branch, each added NOT VALID and validated under the lock.
--      Every existing row met the narrower rule, so validation cannot fail.
--    Tolerant of the other lanes that edit the same bodies and checks
--    (Billing's 0162 appends cashier and billing_officer and turns R2/R3 into
--    in/not in lists; Dental's 0194 inserts dentist after doctor; radiology
--    may append its roles): the precondition takes each body, removes every
--    role appended after 'receptionist' and dentist after doctor, turns
--    in ('receptionist') and not in ('receptionist') back, and requires the
--    md5 0001-0153 leave (0194's normalising pin). The checks are read the
--    same way (the 0086 text or 0162's after-text, or the same rule with
--    other lanes' roles). The roles taken out are bounded: each is a role
--    the role check names after the front desk, active, never a role of
--    0001-0153 nor a platform, outreach or organisation administrator role,
--    and each role in a no-licence list has no licence body
--    (identity.staff_role_licence_body), so a tampered list that let a
--    licensed or privileged role in refuses. The role is appended after the
--    last role present, so 0194's normaliser still reads every body after
--    this file. The
--    post-check proves each new body is the old body with exactly the
--    insertions above. So 0209 applies before or after 0162 and 0194. (0162
--    as cut on claude/sprint-billing-backend at f804c9e8 pins these bodies
--    exactly, so 0162 refuses after 0209 until it takes the same tolerance,
--    as it already does after 0194.)
-- H5 audit.events, as the system actor (no account, membership, facility or
--    patient), correlation 0209-community-health-worker-role, source
--    hid-0209, provenance migration: one auth.role.add (resource role,
--    community_health_worker) and one auth.role-permission.add per row
--    (resource role-permission, community_health_worker/<code>): 4 rows.
--    Details hold the codes, the migration and the decision; never a name.
--
-- Locks, taken first, NOWAIT, in one attempt made up to 50 times 100 ms apart
-- (about 5 seconds), so the file never waits for one of its locks while
-- holding the others; then 55P03 "0209: ... stayed busy for 5 seconds;
-- nothing applied; run the release again at a quieter time". When this
-- transaction already holds an earlier migration's locks that stop other
-- sessions (the runner's dry run applies every pending file in one
-- transaction), one attempt, no sleep ("... so it does not wait; nothing
-- applied; run the release again at a quieter time"). Measured with pg_locks
-- before commit (community-health-worker-migration.integration.sql compares
-- them):
--   SHARE ROW EXCLUSIVE: auth.roles, auth.permissions, auth.role_permissions
--     (other writers wait; every reader, each request's permission check
--     included, goes on);
--   ACCESS EXCLUSIVE: identity.staff_invitations (its two role checks are
--     replaced; a small table, held for milliseconds);
--   ROW EXCLUSIVE: audit.events (the audit rows);
--   ROW SHARE: auth.accounts, identity.staff_facility_memberships,
--     identity.organizations, identity.facilities, identity.patients (the
--     audit rows' foreign key checks open every table they reference);
--   ACCESS SHARE: identity.staff_attestation_texts (the body check of
--     identity.staff_invitation_fields_valid, a SQL function).
-- Besides tables it locks only indexes, the audit rows' identity sequence and
-- the replaced functions' catalog rows. Those waits (and a row of auth.roles
-- or auth.permissions another session holds FOR UPDATE, which the new rows'
-- foreign key checks meet) are not NOWAIT: the runner's lock_timeout (5 s)
-- ends each (55P03 lock timeout: not a busy refusal; nothing applied).
--
-- Old services on this schema: the old roles answer exactly as before (only
-- the new role is added to the lists). The Staff page's inviteOptions comes
-- from staff_invitable_roles, so an identity-api without CHW-1 would list the
-- role and refuse it (400, its DTOs do not know it); identity-api with CHW-1
-- hides and refuses it (400 STAFF_INVITATION_ROLE_NOT_ALLOWED) while
-- COMMUNITY_HEALTH_WORKER_ENABLED is off, the default. No old service checks
-- the role by name; its three codes are ones every service already reads.
--
-- Undo (not in the ledger; by hand, only if the owner signs it): end any
-- community_health_worker assignment, take the three role rows and the role
-- out, restore the seven functions and the fence from their definitions
-- without the role (the post-check's reverse replacement) and the two checks
-- without it.
--
-- The whole file is one statement (do $chw0209$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (above).
-- 1. Preconditions (55000, or 42501 for ownership; nothing applied):
--    a. markers of the earlier files whose objects it uses only: 0115 (the
--       fence and outreach_volunteer), 0126 (organization_staff_kinds), 0139
--       (the SX-4 functions); c pins every body it reads or rewrites;
--    b. not applied yet ("0209: already applied" when the role is active with
--       exactly its 3 rows, the fence at its after-md5, every replaced body
--       holding the role exactly where this file puts it, both checks naming
--       it, and the 4 audit rows; "0209: the schema is not in the reviewed
--       state" when any of these exists otherwise);
--    c. the fence (md5, SECURITY DEFINER, search_path, ACL with grant
--       option and grantor, its trigger enabled and the 4 triggers of
--       auth.account_roles), 0126's function (md5), the role check (the five
--       roles of 0001-0153 in order, Dental's dentist only after doctor,
--       other lanes' roles only after the front desk, never this one), the
--       roles other lanes appended there (each an active role that is not a
--       role of 0001-0153, nor a platform, outreach or organisation
--       administrator role), the seven functions taken as above (md5 of
--       0001-0153, the insertion points counted, every role appended after
--       the front desk one of those lanes' roles, every role of a front
--       desk's in or not in list one with no licence body, SECURITY DEFINER,
--       search_path and grants with grant option and grantor), the licence
--       check (the rule of 0001-0153, its other no-licence roles among those
--       lanes' roles and with no licence body, never this one);
--    d. outreach_volunteer active with exactly its three codes, and the three
--       codes active;
--    e. one owner (the owner of auth.roles) for every table and function this
--       file changes, which the applier is or inherits from.
-- 2. H1-H5.
-- 3. Post-checks: the role's codes equal outreach_volunteer's exactly; every
--    other role row and role unchanged (row by row); the fence's after-md5,
--    the old body with exactly the one rule, owner, ACL, SECURITY DEFINER and
--    search_path, its trigger and the 4 triggers; the seven functions (each
--    exactly the old body with the insertions, owner, ACL, SECURITY DEFINER,
--    volatility and settings unchanged); what staff_invitable_roles answers
--    for each kind; the two checks (validated, the values found plus the
--    role); the 4 audit rows.

do $chw0209$
declare
  attempt integer := 0;
  holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  chw_role constant text := 'community_health_worker';
  correlation constant text := '0209-community-health-worker-role';
  decision constant text := 'Q130 A (owner, 19 November 2026), CHW-1';
  reason_text constant text :=
    'Owner decision Q130 A (19 November 2026), CHW-1: the community health worker role, Outreach only';
  -- The role's three codes: exactly outreach_volunteer's (0115), in byte order.
  role_codes constant text[] := array['outreach.campaign.read', 'outreach.registration.read',
    'outreach.registration.write'];
  -- The fence (0115) before and after this file: md5 of pg_proc.prosrc.
  fence constant text := 'identity.enforce_outreach_tenant_roles()';
  fence_before_md5 constant text := '2dbe44af75ad22dbb737a1f57f3849e8';
  fence_after_md5 constant text := '0ae11f8897fd82e62a378ee23cf5dad6';
  fence_settings constant text := 'true|search_path=pg_catalog, identity, auth, pg_temp|';
  -- Where the rule goes: after the fence's last check (exactly once in the body).
  fence_anchor constant text := E'  if tenant_state = ''suspended'' then\n'
    || E'    raise exception using errcode = ''P0001'', message = ''OUTREACH_ORGANISER_SUSPENDED'';\n'
    || E'  end if;\n';
  fence_rule constant text := E'  -- The community health worker (CHW-1, Q130 A) is a facility role at a hospital or clinic only. An\n'
    || E'  -- outreach group''s facility refused it above (OUTREACH_GROUP_ROLE_INVALID); here every other scope, and a\n'
    || E'  -- facility whose organisation is recorded as neither (identity.organization_staff_kinds: no kind recorded\n'
    || E'  -- counts as a hospital, Q91 A).\n'
    || E'  if new.role_code = ''community_health_worker''\n'
    || E'     and (new.scope_type is distinct from ''facility''\n'
    || E'       or not exists (select 1 from identity.facilities facility\n'
    || E'                        cross join lateral identity.organization_staff_kinds(facility.organization_id) staff_kinds\n'
    || E'                       where facility.id = new.facility_id\n'
    || E'                         and (coalesce(cardinality(staff_kinds.organization_kinds), 0) = 0\n'
    || E'                           or staff_kinds.organization_kinds && array[''hospital'', ''clinic'']::text[]))) then\n'
    || E'    raise exception using errcode = ''P0001'', message = ''COMMUNITY_HEALTH_WORKER_ONLY_AT_HOSPITAL'';\n'
    || E'  end if;\n';
  kinds_md5 constant text := '2efbf3a5beb8577a60987c378d98f691';
  -- The seven functions: md5 of pg_proc.prosrc as 0001-0153 leave it (other lanes' roles taken out, see normalized
  -- below), how many times each form appears in it (R1 the invitable list, R2 the front desk's "no licence" test, R3
  -- its "licence" test; I the hospital array of staff_invitable_roles), and its SECURITY DEFINER, search_path and
  -- grants (to roles other than the owner): "definer|search_path|grantee:privilege[*]/grantor,...", * marking WITH
  -- GRANT OPTION and the grantor written 'owner' when it is the function's owner.
  role_functions constant jsonb := '[
    {"f": "identity.staff_invitable_roles(text,text)", "base": "b6f4068712d97284fd95d169e3bde0cf",
     "i": 1, "r1": 0, "r2": 0, "r3": 0, "settings": "false|search_path=pg_catalog, pg_temp|"},
    {"f": "identity.staff_invitation_fields_valid(text,text,text,text,text,text)",
     "base": "a19f57eb883418bc352d7a5b0fdab991", "i": 0, "r1": 1, "r2": 1, "r3": 1,
     "settings": "false|search_path=pg_catalog, identity, pg_temp|"},
    {"f": "identity.attach_invited_member(identity.staff_invitations,uuid,uuid,boolean)",
     "base": "b4e714b7c1c3ab2ac402a1ae1e675882", "i": 0, "r1": 0, "r2": 0, "r3": 1,
     "settings": "false|search_path=pg_catalog, identity, auth, platform, pg_temp|"},
    {"f": "identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)",
     "base": "1ca56a2cdd0231341d9f3b48441b2074", "i": 0, "r1": 1, "r2": 7, "r3": 1,
     "settings": "true|search_path=pg_catalog, pg_temp|hid_identity_runtime:EXECUTE/owner"},
    {"f": "identity.remove_facility_staff_role(uuid,bigint,text,text)",
     "base": "8da5860b2edbd3ee7205e4473b30fbc7", "i": 0, "r1": 1, "r2": 0, "r3": 0,
     "settings": "true|search_path=pg_catalog, pg_temp|hid_identity_runtime:EXECUTE/owner"},
    {"f": "identity.admin_add_facility_staff_role(uuid,uuid,bigint,text,text,text,text,text,text,character)",
     "base": "e12a01443fad2b903f22533153810b0f", "i": 0, "r1": 1, "r2": 6, "r3": 1,
     "settings": "true|search_path=pg_catalog, pg_temp|hid_identity_runtime:EXECUTE/owner"},
    {"f": "identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character)",
     "base": "9d326012bf28739a62cef768b613f181", "i": 0, "r1": 1, "r2": 0, "r3": 0,
     "settings": "true|search_path=pg_catalog, pg_temp|hid_identity_runtime:EXECUTE/owner"}]';
  -- The forms, each with other lanes' roles allowed after 'receptionist' (and dentist after doctor in R1).
  r1_form constant text := $re$(\('doctor'(?:, '[a-z_]+')*, 'receptionist'(?:, '[a-z_]+')*)\)$re$;
  in_form constant text := $re$((?:not )?in \('receptionist'(?:, '[a-z_]+')*)\)$re$;
  invitable_form constant text := $re$(array\['doctor'[^\]]*)\]$re$;
  -- A role another lane appended after the front desk, and each role named in such a list.
  appended_form constant text := $re$'receptionist'((?:, '[a-z_]+')+)$re$;
  quoted_role constant text := $re$'([a-z_]+)'$re$;
  -- The roles 0001-0153 hold. Another lane's role (appended after the front desk) is never one of them, nor a
  -- platform, outreach or organisation administrator role.
  roles_of_0153 constant text[] := array['admin', 'clinician', 'doctor', 'document_scanner', 'facility_review_admin',
    'identity_review_admin', 'lab', 'nurse', 'ocr_worker', 'org_admin', 'org_admin_awaiting_review',
    'outreach_organiser', 'outreach_volunteer', 'pharmacist', 'platform_admin', 'platform_operations_admin',
    'platform_super_admin', 'reading_starter', 'receptionist', 'security_auditor', 'support_admin', 'work_list_reader'];
  lane_roles text[];
  found_absent boolean;
  missing text;
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
  owner_oid oid;
  rows_before text;
  roles_before text;
  entry jsonb;
  source text;
  replaced text;
  fence_old_src text;
  before_state jsonb := '{}';
  role_values text[];
  role_values_after text[];
  unlicensed text[];
  unlicensed_after text[];
  licence_values text[];
  applied_functions integer := 0;
begin
  loop
  attempt := attempt + 1;
  begin
  -- 0. The locks, NOWAIT.
  lock table auth.roles, auth.permissions, auth.role_permissions
    in share row exclusive mode nowait;
  lock table identity.staff_invitations
    in access exclusive mode nowait;
  lock table audit.events
    in row exclusive mode nowait;
  lock table auth.accounts, identity.staff_facility_memberships, identity.organizations, identity.facilities,
             identity.patients
    in row share mode nowait;
  lock table identity.staff_attestation_texts
    in access share mode nowait;
  exit;

  exception when lock_not_available then
    if holding then
      raise exception using errcode = '55P03',
        message = '0209: a table 0209 writes or checks (the role table, staff invitations, audit events and the '
          || 'tables their keys reference) is busy, and this transaction already holds an earlier migration''s '
          || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0209: a table 0209 writes or checks (the role table, staff invitations, audit events and the '
          || 'tables their keys reference) stayed busy for 5 seconds; nothing applied; run the release again at a '
          || 'quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- a. Markers of the earlier files whose objects this file uses only: 0115's fence and volunteer, 0126's kinds and
  -- 0139's SX-4 functions (c pins every body).
  if to_regprocedure(fence) is null
     or not exists (select 1 from auth.roles where code = 'outreach_volunteer')
     or to_regprocedure('identity.organization_staff_kinds(uuid)') is null
     or to_regprocedure('identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)') is null
     or to_regprocedure('identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character)') is null then
    raise exception using errcode = '55000', message = '0209: 0115, 0126 and 0139 must be applied first';
  end if;

  -- b. Not applied yet. Applied exactly: the role active with exactly its 3 rows, the fence at its after-md5, every
  -- function holding the role exactly where this file puts it (and otherwise as 0001-0153 and other lanes leave it),
  -- both checks naming it last, and the 4 audit rows.
  if exists (select 1 from auth.roles where code = chw_role)
     or exists (select 1 from auth.role_permissions where role_code = chw_role)
     or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(fence)) = fence_after_md5
     or exists (select 1 from jsonb_array_elements(role_functions) fn
                 where (select proc.prosrc from pg_proc proc where proc.oid = to_regprocedure(fn.value->>'f'))
                       like '%''community_health_worker''%')
     or exists (select 1 from pg_constraint constraint_row
                 where constraint_row.conrelid = 'identity.staff_invitations'::regclass
                   and constraint_row.conname in ('staff_invitations_role_code_check', 'staff_invitations_licence_ck')
                   and pg_get_constraintdef(constraint_row.oid) like '%''community_health_worker''%')
     or exists (select 1 from audit.events event_row where event_row.correlation_id = correlation) then
    if (select count(*) from auth.roles where code = chw_role and active) = 1
       and (select string_agg(grant_row.permission_code, ',' order by grant_row.permission_code collate "C")
              from auth.role_permissions grant_row where grant_row.role_code = chw_role)
           is not distinct from array_to_string(role_codes, ',')
       and (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(fence)) = fence_after_md5
       and not exists (
             select 1 from jsonb_array_elements(role_functions) fn
              left join lateral (select proc.prosrc from pg_proc proc
                                  where proc.oid = to_regprocedure(fn.value->>'f')) current_body on true
              where current_body.prosrc is null
                 or md5(regexp_replace(regexp_replace(regexp_replace(regexp_replace(current_body.prosrc,
                      $re$'receptionist'(, '[a-z_]+')+$re$, $re$'receptionist'$re$, 'g'),
                      $re$not in \('receptionist'\)$re$, $re$<> 'receptionist'$re$, 'g'),
                      $re$ in \('receptionist'\)$re$, $re$ = 'receptionist'$re$, 'g'),
                      $re$'doctor', 'dentist'$re$, $re$'doctor'$re$, 'g')) is distinct from fn.value->>'base'
                 or (length(current_body.prosrc) - length(replace(current_body.prosrc, '''community_health_worker''', '')))
                    / length('''community_health_worker''')
                    <> (fn.value->>'i')::integer + (fn.value->>'r1')::integer + (fn.value->>'r2')::integer
                       + (fn.value->>'r3')::integer)
       and (select count(*) from pg_constraint constraint_row
             where constraint_row.conrelid = 'identity.staff_invitations'::regclass and constraint_row.convalidated
               and constraint_row.conname in ('staff_invitations_role_code_check', 'staff_invitations_licence_ck')
               and pg_get_constraintdef(constraint_row.oid) like '%''community_health_worker''::text]%') = 2
       and (select count(*) from audit.events event_row where event_row.correlation_id = correlation) = 4 then
      raise exception using errcode = '55000', message = '0209: already applied';
    end if;
    raise exception using errcode = '55000',
      message = '0209: the schema is not in the reviewed state (the community health worker role, its rows, the '
        || 'fence''s rule, a role list or check naming it, or 0209''s audit rows exist, with other content than 0209 '
        || 'leaves); nothing applied';
  end if;

  -- c. The fence, its trigger and 0126's kinds as 0001-0153 leave them.
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(fence)) is distinct from fence_before_md5
     or (select proc.prosecdef::text || '|' || coalesce(array_to_string(proc.proconfig, ';'), '') || '|'
                || coalesce((select string_agg(granted.entry, ',' order by granted.entry collate "C")
                               from (select case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
                                              || ':' || acl.privilege_type
                                              || case when acl.is_grantable then '*' else '' end || '/'
                                              || case when acl.grantor = proc.proowner then 'owner'
                                                      else pg_get_userbyid(acl.grantor) end as entry
                                       from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                                      where acl.grantee <> proc.proowner) granted), '')
           from pg_proc proc where proc.oid = to_regprocedure(fence)) is distinct from fence_settings
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'auth.account_roles'::regclass
                       and trigger_row.tgname = 'account_roles_outreach_fence' and not trigger_row.tgisinternal
                       and trigger_row.tgenabled = 'O' and trigger_row.tgfoid = to_regprocedure(fence))
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = 'auth.account_roles'::regclass and not trigger_row.tgisinternal) <> 4 then
    raise exception using errcode = '55000',
      message = '0209: identity.enforce_outreach_tenant_roles or its trigger is not as 0115 made it; nothing applied';
  end if;
  if (select proc.prosrc from pg_proc proc where proc.oid = to_regprocedure(fence)) is null
     or (select (length(proc.prosrc) - length(replace(proc.prosrc, fence_anchor, ''))) / length(fence_anchor)
           from pg_proc proc where proc.oid = to_regprocedure(fence)) <> 1 then
    raise exception using errcode = '55000', message = '0209: the fence does not end as 0115 made it; nothing applied';
  end if;
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = to_regprocedure('identity.organization_staff_kinds(uuid)')) is distinct from kinds_md5 then
    raise exception using errcode = '55000',
      message = '0209: identity.organization_staff_kinds is not as 0126 made it; nothing applied';
  end if;
  -- The role check: the five roles of 0001-0153 in their order, perhaps with Dental's dentist after doctor and other
  -- lanes' roles after the front desk, each once, never this one.
  select array_agg(found.value[1] order by found.ord) into role_values
    from pg_constraint constraint_row,
         regexp_matches(pg_get_constraintdef(constraint_row.oid), $re$'([a-z_]+)'::text$re$, 'g')
           with ordinality found(value, ord)
   where constraint_row.conrelid = 'identity.staff_invitations'::regclass
     and constraint_row.conname = 'staff_invitations_role_code_check';
  if role_values is null
     or array_to_string(role_values, ',') !~ '^doctor,(dentist,)?nurse,lab,pharmacist,receptionist(,[a-z_]+)*$'
     or chw_role = any(role_values)
     or (select count(distinct value) from unnest(role_values) value) <> cardinality(role_values)
     or (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
          where constraint_row.conrelid = 'identity.staff_invitations'::regclass
            and constraint_row.conname = 'staff_invitations_role_code_check')
        is distinct from 'CHECK ((role_code = ANY (ARRAY['
          || (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
                from unnest(role_values) with ordinality v(value, ord)) || '])))' then
    raise exception using errcode = '55000',
      message = '0209: identity.staff_invitations.staff_invitations_role_code_check is not the role list of 0001-0153 '
        || '(other lanes'' roles aside); nothing applied';
  end if;
  -- The roles other lanes appended (after the front desk): each a new, active role, never one of 0001-0153's roles,
  -- dentist (Dental's place is after doctor), a platform, outreach or organisation administrator role; Dental's
  -- dentist, when named, an active role.
  lane_roles := role_values[array_position(role_values, 'receptionist') + 1:];
  select string_agg(listed.value, ', ' order by listed.ord) into missing
    from unnest(lane_roles || case when 'dentist' = any(role_values) then array['dentist'] else array[]::text[] end)
         with ordinality listed(value, ord)
   where (listed.ord <= cardinality(lane_roles)
          and (listed.value = any(roles_of_0153 || 'dentist'::text) or listed.value like 'platform\_%'
               or listed.value like 'outreach\_%' or listed.value like 'org\_admin%'))
      or not exists (select 1 from auth.roles role_row where role_row.code = listed.value and role_row.active);
  if missing is not null then
    raise exception using errcode = '55000',
      message = '0209: identity.staff_invitations.staff_invitations_role_code_check names roles another lane cannot '
        || 'have added (a role of 0001-0153, a platform, outreach or organisation administrator role, or one that is '
        || 'not an active role): ' || missing || '; nothing applied';
  end if;
  -- The seven functions as 0001-0153 leave them, once another lane's roles are taken out (see the header), each form
  -- counted where it now stands, and their settings and grants (grant option and grantor included). Every role
  -- appended after the front desk is one of the role check's other lanes' roles, dentist after doctor only when the
  -- role check names it, and every role in a front desk's in or not in list has no licence body. The runtime grant is
  -- expected only where hid_identity_runtime exists, as 0139 grants it (a fresh build creates the runtime roles after
  -- the migrations, so there 0139 granted nothing).
  select string_agg(fn.value->>'f', ', ') into missing
    from jsonb_array_elements(role_functions) fn
    left join lateral (select proc.prosrc, proc.prosecdef, proc.proconfig, proc.proacl, proc.proowner
                         from pg_proc proc where proc.oid = to_regprocedure(fn.value->>'f')) current_body on true
   where current_body.prosrc is null
      or md5(regexp_replace(regexp_replace(regexp_replace(regexp_replace(current_body.prosrc,
           $re$'receptionist'(, '[a-z_]+')+$re$, $re$'receptionist'$re$, 'g'),
           $re$not in \('receptionist'\)$re$, $re$<> 'receptionist'$re$, 'g'),
           $re$ in \('receptionist'\)$re$, $re$ = 'receptionist'$re$, 'g'),
           $re$'doctor', 'dentist'$re$, $re$'doctor'$re$, 'g')) is distinct from fn.value->>'base'
      or (select count(*) from regexp_matches(current_body.prosrc, invitable_form, 'g')) <> (fn.value->>'i')::integer
      or (select count(*) from regexp_matches(current_body.prosrc, r1_form, 'g')) <> (fn.value->>'r1')::integer
      or (select count(*) from regexp_matches(current_body.prosrc, in_form, 'g') found(value)
           where found.value[1] not like 'not %')
         + (length(current_body.prosrc) - length(replace(current_body.prosrc, '= ''receptionist''', '')))
           / length('= ''receptionist''') <> (fn.value->>'r2')::integer
      or (select count(*) from regexp_matches(current_body.prosrc, in_form, 'g') found(value)
           where found.value[1] like 'not %')
         + (length(current_body.prosrc) - length(replace(current_body.prosrc, '<> ''receptionist''', '')))
           / length('<> ''receptionist''') <> (fn.value->>'r3')::integer
      or exists (select 1 from regexp_matches(current_body.prosrc, appended_form, 'g') appended(value)
                   cross join lateral regexp_matches(appended.value[1], quoted_role, 'g') named(value)
                  where not (named.value[1] = any(lane_roles)))
      or (strpos(current_body.prosrc, $r$'doctor', 'dentist'$r$) > 0 and not ('dentist' = any(role_values)))
      or exists (select 1 from regexp_matches(current_body.prosrc, in_form, 'g') listed(value)
                   cross join lateral regexp_matches(listed.value[1], quoted_role, 'g') named(value)
                  where identity.staff_role_licence_body(named.value[1]) is not null)
      or current_body.prosecdef::text || '|' || coalesce(array_to_string(current_body.proconfig, ';'), '') || '|'
         || coalesce((select string_agg(granted.entry, ',' order by granted.entry collate "C")
                        from (select case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
                                       || ':' || acl.privilege_type
                                       || case when acl.is_grantable then '*' else '' end || '/'
                                       || case when acl.grantor = current_body.proowner then 'owner'
                                               else pg_get_userbyid(acl.grantor) end as entry
                                from aclexplode(coalesce(current_body.proacl,
                                                         acldefault('f', current_body.proowner))) acl
                               where acl.grantee <> current_body.proowner) granted), '')
         is distinct from case when exists (select 1 from pg_catalog.pg_roles where rolname = 'hid_identity_runtime')
                               then fn.value->>'settings'
                               else regexp_replace(fn.value->>'settings', '\|hid_identity_runtime:EXECUTE/owner$', '|')
                          end;
  if missing is not null then
    raise exception using errcode = '55000',
      message = '0209: these functions differ from 0001-0153 (other lanes'' roles aside), name a role the role check '
        || 'does not add, or give a licensed role no licence, or are missing: ' || missing;
  end if;
  -- The licence check: the front desk (0086's text), or the front desk and other lanes' unlicensed roles (0162's
  -- form), in the no-licence branch, the same roles in the licence branch; each of them a role with no licence body
  -- and, after the front desk, one of the role check's other lanes' roles; never this role.
  select array_agg(found.value[1] order by found.ord) into licence_values
    from pg_constraint constraint_row,
         regexp_matches(pg_get_constraintdef(constraint_row.oid), $re$'([a-z_]+)'::text$re$, 'g')
           with ordinality found(value, ord)
   where constraint_row.conrelid = 'identity.staff_invitations'::regclass
     and constraint_row.conname = 'staff_invitations_licence_ck';
  unlicensed := licence_values[1:coalesce(cardinality(licence_values), 0) / 2];
  if licence_values is null
     or cardinality(licence_values) % 2 <> 0
     or unlicensed[1] is distinct from 'receptionist'
     or licence_values[cardinality(licence_values) / 2 + 1:] is distinct from unlicensed
     or chw_role in (select unnest(unlicensed))
     or exists (select 1 from unnest(unlicensed[2:]) listed(value) where not (listed.value = any(lane_roles)))
     or exists (select 1 from unnest(unlicensed) listed(value)
                 where identity.staff_role_licence_body(listed.value) is not null)
     or (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
          where constraint_row.conrelid = 'identity.staff_invitations'::regclass
            and constraint_row.conname = 'staff_invitations_licence_ck')
        is distinct from (case when cardinality(unlicensed) = 1
          then 'CHECK ((((role_code = ''receptionist''::text) AND (licence_body IS NULL) AND (licence_number IS NULL)) '
            || 'OR ((role_code <> ''receptionist''::text) AND (licence_body = identity.staff_role_licence_body(role_code)) '
            || 'AND identity.licence_number_valid(licence_number))))'
          else 'CHECK ((((role_code = ANY (ARRAY[' || (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
                                                       from unnest(unlicensed) with ordinality v(value, ord))
            || '])) AND (licence_body IS NULL) AND (licence_number IS NULL)) OR ((role_code <> ALL (ARRAY['
            || (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
                  from unnest(unlicensed) with ordinality v(value, ord))
            || '])) AND (licence_body = identity.staff_role_licence_body(role_code)) '
            || 'AND identity.licence_number_valid(licence_number))))' end) then
    raise exception using errcode = '55000',
      message = '0209: identity.staff_invitations.staff_invitations_licence_ck is not the licence rule of 0001-0153 '
        || '(other lanes'' unlicensed roles aside); nothing applied';
  end if;

  -- d. The volunteer's three codes (this role's), active.
  if not exists (select 1 from auth.roles role_row where role_row.code = 'outreach_volunteer' and role_row.active)
     or (select string_agg(grant_row.permission_code, ',' order by grant_row.permission_code collate "C")
           from auth.role_permissions grant_row where grant_row.role_code = 'outreach_volunteer')
        is distinct from array_to_string(role_codes, ',')
     or (select count(*) from auth.permissions permission_row
          where permission_row.code = any(role_codes) and permission_row.active) <> 3 then
    raise exception using errcode = '55000',
      message = '0209: outreach_volunteer or its three codes are not as 0115 made them; nothing applied';
  end if;

  -- e. One owner for every table and function this file changes, which the applier is or inherits from (CREATE OR
  -- REPLACE and ALTER TABLE need ownership).
  owner_oid := (select relation.relowner from pg_class relation where relation.oid = 'auth.roles'::regclass);
  with foreign_owned as (
         select expected.table_name as what
           from (values ('auth.role_permissions'), ('audit.events'), ('identity.staff_invitations')) expected(table_name)
          where not exists (select 1 from pg_class relation
                             where relation.oid = to_regclass(expected.table_name) and relation.relowner = owner_oid)
         union all
         select expected.signature
           from (select fence union all select fn.value->>'f' from jsonb_array_elements(role_functions) fn)
                expected(signature)
          where not exists (select 1 from pg_proc proc
                             where proc.oid = to_regprocedure(expected.signature) and proc.proowner = owner_oid))
  select exists (select 1 from foreign_owned), (select string_agg(foreign_owned.what, ', ') from foreign_owned)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '42501',
      message = format('0209: these are not owned by %s, the owner of auth.roles: %s',
        coalesce(pg_get_userbyid(owner_oid), 'nobody'), missing);
  end if;
  if not (applier = owner_oid or pg_has_role(applier, owner_oid, 'USAGE')) then
    raise exception using errcode = '42501',
      message = format('0209: %s must own, or inherit from, %s', current_user, pg_get_userbyid(owner_oid));
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into rows_before from auth.role_permissions grant_row;
  select string_agg(to_jsonb(role_row)::text, ',' order by role_row.code collate "C")
    into roles_before from auth.roles role_row;
  -- Each function's body, owner, ACL, SECURITY DEFINER, volatility and settings before (the post-check compares).
  select jsonb_object_agg(target.signature, jsonb_build_object('src', proc.prosrc, 'owner', proc.proowner::text,
           'acl', coalesce(proc.proacl::text, ''), 'definer', proc.prosecdef, 'volatile', proc.provolatile,
           'config', coalesce(proc.proconfig::text, '')))
    into before_state
    from (select fence union all select fn.value->>'f' from jsonb_array_elements(role_functions) fn) target(signature)
    join pg_proc proc on proc.oid = to_regprocedure(target.signature);
  fence_old_src := before_state->fence->>'src';

  -- 2. H1 the role, H2 its rows.
  insert into auth.roles (code, description) values
    ('community_health_worker',
     'Community health worker: registers and screens people in outreach campaigns (Outreach only)');
  insert into auth.role_permissions (role_code, permission_code) values
    ('community_health_worker', 'outreach.campaign.read'),
    ('community_health_worker', 'outreach.registration.read'),
    ('community_health_worker', 'outreach.registration.write');

  -- H3 the fence: its live definition with the one rule after its last check.
  source := pg_get_functiondef(to_regprocedure(fence));
  if (length(source) - length(replace(source, fence_anchor, ''))) / length(fence_anchor) <> 1 then
    raise exception using errcode = '55000', message = '0209: the fence does not end as 0115 made it; nothing applied';
  end if;
  execute replace(source, fence_anchor, fence_anchor || fence_rule);

  -- H4 the staff vocabulary: each function from its current definition with its insertions.
  for entry in select value from jsonb_array_elements(role_functions) loop
    source := pg_get_functiondef(to_regprocedure(entry->>'f'));
    if (select count(*) from regexp_matches(source, invitable_form, 'g')) <> (entry->>'i')::integer
       or (select count(*) from regexp_matches(source, r1_form, 'g')) <> (entry->>'r1')::integer then
      raise exception using errcode = '55000',
        message = '0209: ' || (entry->>'f') || ' does not name the roles as 0001-0153 do; nothing applied';
    end if;
    replaced := source;
    if (entry->>'i')::integer = 1 then
      replaced := regexp_replace(replaced, invitable_form, $re$\1, 'community_health_worker']$re$);
    end if;
    replaced := regexp_replace(replaced, r1_form, $re$\1, 'community_health_worker')$re$, 'g');
    replaced := regexp_replace(replaced, in_form, $re$\1, 'community_health_worker')$re$, 'g');
    replaced := replace(replaced, $r$= 'receptionist'$r$, $r$in ('receptionist', 'community_health_worker')$r$);
    replaced := replace(replaced, $r$<> 'receptionist'$r$, $r$not in ('receptionist', 'community_health_worker')$r$);
    execute replaced;
    applied_functions := applied_functions + 1;
  end loop;

  -- The two checks: the values found, with the role at the end of the role list and of the no-licence list.
  role_values_after := role_values || chw_role;
  unlicensed_after := unlicensed || chw_role;
  alter table identity.staff_invitations drop constraint staff_invitations_role_code_check;
  alter table identity.staff_invitations drop constraint staff_invitations_licence_ck;
  execute format('alter table identity.staff_invitations add constraint staff_invitations_role_code_check '
    || 'check (role_code in (%s)) not valid',
    (select string_agg(quote_literal(value), ', ' order by ord) from unnest(role_values_after) with ordinality v(value, ord)));
  execute format('alter table identity.staff_invitations add constraint staff_invitations_licence_ck '
    || 'check ((role_code in (%1$s) and licence_body is null and licence_number is null) '
    || 'or (role_code not in (%1$s) and licence_body = identity.staff_role_licence_body(role_code) '
    || 'and identity.licence_number_valid(licence_number))) not valid',
    (select string_agg(quote_literal(value), ', ' order by ord) from unnest(unlicensed_after) with ordinality v(value, ord)));
  alter table identity.staff_invitations validate constraint staff_invitations_role_code_check;
  alter table identity.staff_invitations validate constraint staff_invitations_licence_ck;

  -- H5 the audit rows.
  insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details)
  values (correlation, 'system', 'auth.role.add', 'success', 'role', chw_role, 'healthcare-operations', reason_text,
          'migration', 'hid-0209', jsonb_build_object('roleCode', chw_role, 'permissionCodes', to_jsonb(role_codes),
            'migration', '0209', 'decision', decision));
  insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details)
  select correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission',
         grant_row.role_code || '/' || grant_row.permission_code, 'healthcare-operations', reason_text, 'migration',
         'hid-0209', jsonb_build_object('roleCode', grant_row.role_code, 'permissionCode', grant_row.permission_code,
           'migration', '0209', 'decision', decision)
    from auth.role_permissions grant_row
   where grant_row.role_code = chw_role
   order by grant_row.permission_code collate "C";

  -- 3. Post-checks.
  -- The role and its rows: exactly the volunteer's codes; every other row and role unchanged.
  if (select string_agg(grant_row.permission_code, ',' order by grant_row.permission_code collate "C")
        from auth.role_permissions grant_row where grant_row.role_code = chw_role)
     is distinct from (select string_agg(grant_row.permission_code, ',' order by grant_row.permission_code collate "C")
                         from auth.role_permissions grant_row where grant_row.role_code = 'outreach_volunteer')
     or (select count(*) from auth.role_permissions grant_row where grant_row.role_code = chw_role) <> 3
     or not exists (select 1 from auth.roles role_row where role_row.code = chw_role and role_row.active) then
    raise exception using errcode = '55000', message = '0209: post-check failed: the role and its three rows';
  end if;
  if (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                        ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
        from auth.role_permissions grant_row where grant_row.role_code <> chw_role)
     is distinct from rows_before
     or (select string_agg(to_jsonb(role_row)::text, ',' order by role_row.code collate "C")
           from auth.roles role_row where role_row.code <> chw_role) is distinct from roles_before then
    raise exception using errcode = '55000', message = '0209: post-check failed: another role or role row changed';
  end if;
  -- The fence: the old body with exactly the one rule, at its pinned md5; owner, ACL, SECURITY DEFINER, volatility
  -- and settings unchanged; its trigger still enabled and calling it; auth.account_roles' 4 triggers.
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(fence)) is distinct from fence_after_md5
     or (select replace(proc.prosrc, fence_rule, '') from pg_proc proc where proc.oid = to_regprocedure(fence))
        is distinct from fence_old_src
     or exists (select 1 from pg_proc proc
                 where proc.oid = to_regprocedure(fence)
                   and (proc.proowner::text is distinct from before_state->fence->>'owner'
                     or coalesce(proc.proacl::text, '') is distinct from before_state->fence->>'acl'
                     or proc.prosecdef is distinct from (before_state->fence->>'definer')::boolean
                     or proc.provolatile::text is distinct from before_state->fence->>'volatile'
                     or coalesce(proc.proconfig::text, '') is distinct from before_state->fence->>'config'))
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'auth.account_roles'::regclass
                       and trigger_row.tgname = 'account_roles_outreach_fence' and not trigger_row.tgisinternal
                       and trigger_row.tgenabled = 'O' and trigger_row.tgfoid = to_regprocedure(fence))
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = 'auth.account_roles'::regclass and not trigger_row.tgisinternal) <> 4 then
    raise exception using errcode = '55000', message = '0209: post-check failed: the fence';
  end if;
  -- Each function is its old body with exactly the insertions (the same replacements applied to the old body give
  -- the new one; taking the role out and turning the singleton lists back gives the old one), the role appears exactly
  -- once per insertion, and its owner, ACL, SECURITY DEFINER, volatility and settings are unchanged.
  select string_agg(fn.value->>'f', ', ') into missing
    from jsonb_array_elements(role_functions) fn
    left join pg_proc proc on proc.oid = to_regprocedure(fn.value->>'f')
   where proc.oid is null
      or proc.prosrc is distinct from replace(replace(regexp_replace(regexp_replace(regexp_replace(
           before_state->(fn.value->>'f')->>'src',
           invitable_form, case when (fn.value->>'i')::integer = 1 then $re$\1, 'community_health_worker']$re$
                                else $re$\1]$re$ end),
           r1_form, $re$\1, 'community_health_worker')$re$, 'g'),
           in_form, $re$\1, 'community_health_worker')$re$, 'g'),
           $r$= 'receptionist'$r$, $r$in ('receptionist', 'community_health_worker')$r$),
           $r$<> 'receptionist'$r$, $r$not in ('receptionist', 'community_health_worker')$r$)
      or regexp_replace(regexp_replace(replace(proc.prosrc, ', ''community_health_worker''', ''),
           $re$not in \('receptionist'\)$re$, $re$<> 'receptionist'$re$, 'g'),
           $re$ in \('receptionist'\)$re$, $re$ = 'receptionist'$re$, 'g')
         is distinct from before_state->(fn.value->>'f')->>'src'
      or (length(proc.prosrc) - length(replace(proc.prosrc, '''community_health_worker''', '')))
         / length('''community_health_worker''')
         <> (fn.value->>'i')::integer + (fn.value->>'r1')::integer + (fn.value->>'r2')::integer
            + (fn.value->>'r3')::integer
      or proc.proowner::text is distinct from before_state->(fn.value->>'f')->>'owner'
      or coalesce(proc.proacl::text, '') is distinct from before_state->(fn.value->>'f')->>'acl'
      or proc.prosecdef is distinct from (before_state->(fn.value->>'f')->>'definer')::boolean
      or proc.provolatile::text is distinct from before_state->(fn.value->>'f')->>'volatile'
      or coalesce(proc.proconfig::text, '') is distinct from before_state->(fn.value->>'f')->>'config';
  if missing is not null or applied_functions <> 7 then
    raise exception using errcode = '55000', message = '0209: post-check failed: ' || coalesce(missing, 'the functions');
  end if;
  -- What staff_invitable_roles answers: the role last at hospitals and clinics (and 'other' with ehr or migrate),
  -- never at a laboratory, a pharmacy or anything else.
  if (identity.staff_invitable_roles('hospital', null))[cardinality(identity.staff_invitable_roles('hospital', null))]
       is distinct from chw_role
     or identity.staff_invitable_roles('clinic', null) is distinct from identity.staff_invitable_roles('hospital', null)
     or identity.staff_invitable_roles('other', 'ehr') is distinct from identity.staff_invitable_roles('hospital', null)
     or identity.staff_invitable_roles('other', 'migrate') is distinct from identity.staff_invitable_roles('hospital', null)
     or chw_role = any(identity.staff_invitable_roles('laboratory', null))
     or chw_role = any(identity.staff_invitable_roles('pharmacy', null))
     or chw_role = any(identity.staff_invitable_roles('other', 'laboratory'))
     or chw_role = any(identity.staff_invitable_roles('other', 'pharmacy'))
     or chw_role = any(identity.staff_invitable_roles('other', 'outreach'))
     or chw_role = any(identity.staff_invitable_roles('other', null)) then
    raise exception using errcode = '55000', message = '0209: post-check failed: identity.staff_invitable_roles';
  end if;
  -- The two checks: validated, the values found plus the role.
  if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
       where constraint_row.conrelid = 'identity.staff_invitations'::regclass and constraint_row.convalidated
         and constraint_row.conname = 'staff_invitations_role_code_check')
     is distinct from 'CHECK ((role_code = ANY (ARRAY['
       || (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
             from unnest(role_values_after) with ordinality v(value, ord)) || '])))'
     or (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
          where constraint_row.conrelid = 'identity.staff_invitations'::regclass and constraint_row.convalidated
            and constraint_row.conname = 'staff_invitations_licence_ck')
     is distinct from 'CHECK ((((role_code = ANY (ARRAY['
       || (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
             from unnest(unlicensed_after) with ordinality v(value, ord))
       || '])) AND (licence_body IS NULL) AND (licence_number IS NULL)) OR ((role_code <> ALL (ARRAY['
       || (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
             from unnest(unlicensed_after) with ordinality v(value, ord))
       || '])) AND (licence_body = identity.staff_role_licence_body(role_code)) '
       || 'AND identity.licence_number_valid(licence_number))))' then
    raise exception using errcode = '55000', message = '0209: post-check failed: the invitation role checks';
  end if;
  -- The 4 audit rows, as the system actor with no account, membership, facility or patient.
  if (select count(*) from audit.events event_row
       where event_row.correlation_id = correlation and event_row.actor_type = 'system'
         and event_row.actor_account_id is null and event_row.actor_membership_id is null
         and event_row.facility_id is null and event_row.patient_id is null and event_row.source_system = 'hid-0209'
         and event_row.provenance = 'migration') <> 4
     or (select count(*) from audit.events event_row
          where event_row.correlation_id = correlation and event_row.action = 'auth.role.add'
            and event_row.resource_type = 'role' and event_row.resource_id = chw_role) <> 1
     or (select count(*) from audit.events event_row
          where event_row.correlation_id = correlation and event_row.action = 'auth.role-permission.add'
            and event_row.resource_type = 'role-permission'
            and event_row.resource_id in (select chw_role || '/' || code from unnest(role_codes) code)) <> 3 then
    raise exception using errcode = '55000', message = '0209: post-check failed: the audit rows';
  end if;

  raise notice '0209: role community_health_worker (Outreach only: outreach.campaign.read, outreach.registration.read, outreach.registration.write), invitable at hospitals and clinics with no licence, the fence''s hospital-only rule, 4 audit rows.';
end
$chw0209$;
