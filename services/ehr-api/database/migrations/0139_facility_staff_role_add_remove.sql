-- 0139: add or remove one role for a staff member (SX-4, Akos N-2a and
-- N-2c, Release B; the planned contract's "SX-4: Add or remove one role for
-- a staff member"). Owner decision Q129 A (19 November 2026): facility
-- administrators add and remove roles for their own staff; at governed
-- facilities (QA Hospital included) Health ID support does it, with a
-- licence check. Booked as 0139 on hid-system#258; numbers are given in
-- merge order at the Release B cut-off. This file requires 0001-0137
-- applied, and the owners of the two openers it replaces (D6) able to lock
-- identity.staff_facility_memberships.
--
-- One membership may already hold several roles (auth.account_roles); until
-- now the screens could only replace them with one role (0086's
-- identity.change_facility_staff_role, unchanged here). SX-4 adds two
-- narrower commands beside it, for the facility administrator and for
-- support.
--
-- D1 Permission platform.facility-staff.manage (auth.permissions), given to
--    every role that holds platform.principal.manage when this file runs
--    (today platform_admin and platform_super_admin).
-- D2 Attestation text platform-staff-role-v1 (identity.staff_attestation_texts,
--    append-only): what a licence support checked when it added a role
--    records.
-- D3 identity.staff_licence_attestations accepts support's licence check:
--    its verification_method may also be how support checked the licence
--    (regulator_register, in_person, officer_match, cac_registered_contact
--    or other: identity-api's VERIFICATION_METHODS), with no attesting
--    membership, no review application and no invitation. The two CHECK
--    constraints are replaced; facility_attestation and platform_review are
--    unchanged. Every existing row satisfies the new constraints (they only
--    add a third case), and ADD CONSTRAINT checks them.
-- D4 Four helpers, SECURITY INVOKER, EXECUTE revoked from PUBLIC and granted
--    to nobody: they run only inside the definers below, as their owner.
--      identity.staff_role_change_roles(uuid)       the staff roles support
--                                                   may add at a facility
--      identity.staff_role_change_member(...)       the membership, locked,
--                                                   and today's refusals
--      identity.staff_role_change_apply(...)        the change itself
--      identity.staff_role_licences(uuid)           one row per licensed
--                                                   active role, for the reads
-- D5 Four commands, SECURITY DEFINER, EXECUTE to hid_identity_runtime only:
--      identity.add_facility_staff_role(...)        the administrator, add
--      identity.remove_facility_staff_role(...)     the administrator, remove
--      identity.admin_add_facility_staff_role(...)  support, add
--      identity.admin_remove_facility_staff_role(...) support, remove
--    and two reads, SECURITY DEFINER, the same grant:
--      identity.list_facility_staff_licences()      the Staff page
--      identity.admin_list_facility_staff_licences(uuid) support's staff view
-- D6 The two commands that make a grant from a staff role are replaced
--    (md5-pinned; CREATE OR REPLACE keeps each one's owner, grants and
--    comment; only the lines marked 0139 (D6) are added, which the
--    post-check proves):
--      identity.open_own_facility_patient (0131): its 24-hour refusal after
--        a revoked own-facility grant now needs the patient's own
--        revocation (revoked_by is the patient's account, which only
--        identity.revoke_my_consent_grant records). A remove's revocation
--        below, and 0086's end of a membership, no longer refuse every
--        clinician at the facility for 24 hours.
--      both it and identity.activate_break_glass (0123; 0132's break-glass
--        by match reference calls it) first take FOR SHARE on the caller's
--        membership. That conflicts with a remove's FOR NO KEY UPDATE, so
--        an open waits for a remove in flight and then reads the
--        permission after it, and a remove waits for an open in flight and
--        then revokes the grant it made. Opens by the same member do not
--        wait for each other. That lock is checked against each opener's
--        owner, which CREATE OR REPLACE keeps, and FOR SHARE needs UPDATE on
--        a column of the table: section 0 refuses (55000, nothing applied),
--        naming the owner, unless each owner has it, and the post-check
--        checks it again.
--
-- What a command does (identity.staff_role_change_apply)
--   Add inserts one auth.account_roles row for the membership; for a
--   licensed role (doctor, nurse, lab, pharmacist) also one licence
--   attestation tied to that grant (role_grant_id): the administrator's
--   facility_attestation, or support's check with its method. Remove revokes
--   that one role ("Role removed by the facility administrator" or "Role
--   removed by Health ID support"). Other roles are untouched. The
--   membership's version goes up by one either way.
--   Refused, in this order, after the caller's own checks: not held (remove)
--   or already held (add), the member's last role (remove), no role left for
--   membership_role (remove; see below), then a version that is not the
--   membership's (40001). So a retried remove answers
--   FACILITY_STAFF_ROLE_NOT_HELD, not a version conflict.
--   The two role columns of the membership (membership_role, app_role) are
--   what the staff session lists as roles today (identity-api's staff
--   context query), and membership_role is the requester's role a patient
--   sees on an access request and a PIN-use notice (0128). An add leaves
--   them as they are. A remove of the role one of them names moves that
--   column to the first role still held, in alphabetical order, so the
--   session and the patient never see a role that was removed. When
--   membership_role names the role removed and every role still held would
--   collide with another membership of the same person here
--   (staff_memberships_scoped_uq, which covers ended memberships), the
--   remove is refused (FACILITY_STAFF_ROLE_COLUMN_CONFLICT, before the
--   version check): end the membership and invite the person again.
--   A remove then closes the member's open records-processing requests that
--   can no longer be used, exactly as 0136 step 4 does: pending,
--   healthcare-operations, not break-glass, not held for migration, and the
--   membership no longer holds ocr.job.write here. Status 'expired' and one
--   identity.access-request.close audit row each (system actor, ids only).
--   It also revokes the member's unexpired active consent grants that the
--   roles left no longer allow: 0131's own-facility grants
--   (authorization_method own_facility) when no role still held here has
--   identity.patient.open-own-facility, and break-glass grants when none has
--   identity.break-glass.write. The roles are read directly (auth.roles,
--   auth.role_permissions, auth.permissions, all active), not through the
--   account's state, so a disabled account keeps what its roles allow.
--   Status 'revoked', revoked_by the caller, the remove's own reason, and one
--   identity.consent-grant.close audit row each with the patient (as 0086's
--   end_facility_staff_membership writes it: the administrator as a staff
--   actor; support as the system actor, since a platform row may not name a
--   patient). Patient-approved and PIN grants are the patient's and stay.
--   Such a revocation does not stop the facility's other clinicians from
--   opening the patient (D6).
--   Other permissions are read on every request, so the rest of a change
--   applies from the member's next request; nobody is signed out.
--
-- The administrator's commands
--   Admission is 0086's identity.staff_management_actor(true): a staff
--   session at the X-Facility-ID facility holding workforce.manage, at a
--   self-signed-up facility (42501 STAFF_MANAGEMENT_NOT_AVAILABLE
--   elsewhere), which support has reviewed (FACILITY_REVIEW_PENDING). Add is
--   also closed with the staff-invitations control, as 0086's role change
--   is; remove is not, as removing a member is not. The role is one of the
--   facility's invitable roles (identity.staff_invitable_roles); the licence
--   matches the role (STAFF_INVITATION_INVALID otherwise); the reason is 8 to
--   500 characters. The administrator's own membership, the facility
--   administrator's membership (org_admin, org_admin_awaiting_review),
--   ended memberships and platform accounts are refused as in 0086. The
--   recovery hold is identity-api's, in the same transaction. One
--   identity.facility-staff.role-add or .role-remove audit row on success,
--   with the membership, role, reason, roles before and after, and never a
--   licence number.
-- Support's commands
--   Need platform.admin.access and platform.facility-staff.manage (42501
--   ADMIN_PERMISSION_DENIED). Any facility: the roles allowed are those of
--   the organisation's recorded kinds (0126's identity.organization_staff_kinds;
--   none recorded counts as a hospital, Q91 A), and none at an outreach
--   group's facility. A licensed role needs the licence and how support
--   checked it; the front desk needs neither. Support may change an
--   administrator's membership at a governed facility (never the
--   administrator roles themselves, which are not staff roles). At a
--   self-signed-up facility (an organisation with a self-service
--   application, as 0086's identity.staff_management_actor finds it) the
--   administrator's clinical role is 0086 S12's (support's
--   administrator-role command, which keeps self_service_granted_role and
--   signs the administrator out), so the administrator's membership is
--   refused there (FACILITY_STAFF_ADMINISTRATOR). Its own account and
--   platform accounts are refused. The QA seal holds through 0123's
--   triggers: a membership of the QA facility belongs to a QA account.
--   identity-api writes support's
--   admin.facility-staff.role-add or .role-remove audit row in the same
--   transaction, as for every support command.
-- Idempotency
--   Add needs an Idempotency-Key (16-128 URL-safe characters) and the
--   request's SHA-256; support's remove does too. Both are kept in
--   auth.admin_command_idempotency (0027, append-only) under their own
--   operation names, keyed by the caller's account. The same key and request
--   answer the stored result with replayed true; the same key with another
--   request is 23505 IDEMPOTENCY_KEY_REUSED. A transaction-scoped advisory
--   lock on the caller and key makes a concurrent retry wait and replay.
--
-- Locks: ACCESS EXCLUSIVE on identity.staff_licence_attestations (its
-- constraints are replaced; a small table); ROW EXCLUSIVE on
-- auth.permissions, auth.role_permissions and identity.staff_attestation_texts
-- (rows inserted); ROW SHARE on auth.roles (the foreign key check of the new
-- auth.role_permissions rows); and ACCESS SHARE on auth.account_roles,
-- auth.accounts and identity.staff_facility_memberships (named by the SQL
-- functions' bodies, which are parsed when created) and on
-- auth.admin_command_idempotency (three functions declare its %rowtype:
-- plpgsql's validator builds that type at CREATE, and the type cache opens
-- the table with a lock it releases at once, so pg_locks before commit does
-- not show it); held to commit. That is every existing table this file locks
-- (pg_locks before commit, plus that one), at the strongest mode it takes.
-- Taken first, together, NOWAIT: a busy table fails the attempt at once and
-- its subtransaction releases what it took; the attempt is made again every
-- 100 ms for at most 5 seconds, then 55P03 (nothing applied). When this
-- transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run), one attempt and no
-- sleep: 55P03 at once, nothing applied.
--
-- Old services on this schema: today's identity-api calls none of the new
-- functions and reads the attestations only through 0086's functions, which
-- show a support check's method as they show any other. The identity-api of
-- this branch needs this file for its four new routes and for the Staff
-- page's licences (it answers 503 STAFF_MANAGEMENT_UNAVAILABLE for those
-- without it).
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 0b. Locks, NOWAIT (55P03 and nothing applied).
-- 1. The permission and the attestation text (D1, D2).
-- 2. The attestation constraints (D3).
-- 3. The helpers (D4).
-- 4. The commands and the reads (D5).
-- 4b. The two openers, replaced (D6).
-- 5. Grants (here and in runtime-grants.sql).
-- 6. Post-checks.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regclass('auth.session_facility_selection') is null
     or to_regprocedure('identity.qoreid_nin_record_used(character,text)') is null then
    raise exception using errcode = '55000', message = '0139: 0001-0137 must be applied first';
  end if;
  if to_regprocedure('identity.staff_role_change_apply(identity.staff_facility_memberships,bigint,text,text,text,text,text,text,uuid,uuid,text)') is not null
     or to_regprocedure('identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)') is not null
     or exists (select 1 from auth.permissions where code = 'platform.facility-staff.manage') then
    raise exception using errcode = '55000', message = '0139: already applied';
  end if;
  -- The bodies this file calls, mirrors or replaces, as 0086, 0115, 0126, 0027, 0131 and 0123 left them.
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('identity.staff_management_actor(boolean)', '677d7d0d0d5e5ebaef13940b1d1ce395'),
      ('identity.staff_invitable_roles(text,text)', 'b6f4068712d97284fd95d169e3bde0cf'),
      ('identity.staff_role_licence_body(text)', '1d6531b60beaf640a46342be8380eac3'),
      ('identity.normalize_licence_number(text)', 'fc59dd5d458cb8ce0cf720cadcb233e4'),
      ('identity.licence_number_valid(text)', '239ec2b4727934e2c9e7d41e86964885'),
      ('identity.licence_number_hint(text)', 'e60b48d39d795692d113f34f1aa94956'),
      ('identity.organization_staff_kinds(uuid)', '2efbf3a5beb8577a60987c378d98f691'),
      ('identity.enforce_review_before_facility_role()', '990d708e6655adaa0d5dca16be7054bb'),
      ('identity.enforce_outreach_tenant_roles()', '2dbe44af75ad22dbb737a1f57f3849e8'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('auth.account_has_platform_permission(uuid,text)', '2145c72b864abf1b69d23d96265e5ba7'),
      ('platform.require_control_enabled(text)', '90887489d15eab24f8f71b145bb02320'),
      -- Replaced in 4b (D6), as 0131 and 0123 left them.
      ('identity.open_own_facility_patient(text,uuid)', '7e5d49ff292a03fb92f0395681be365d'),
      ('identity.activate_break_glass(text,text,integer)', '585d55fe4f7b5773cea96ae8729cc99c')
    ) expected(signature, body_md5)
   where to_regprocedure(expected.signature) is null
      or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0139: these functions are not as this file reads them: ' || mismatch;
  end if;
  -- D6: the openers' FOR SHARE runs as each one's owner, which CREATE OR REPLACE keeps; it needs UPDATE.
  select string_agg(format('the owner of %s, %s,', opener.signature, pg_get_userbyid(proc.proowner)), ' and '
                    order by opener.position) into mismatch
    from (values (1, 'identity.open_own_facility_patient(text,uuid)'),
                 (2, 'identity.activate_break_glass(text,text,integer)')) opener(position, signature)
    join pg_proc proc on proc.oid = to_regprocedure(opener.signature)
   where not has_any_column_privilege(proc.proowner, 'identity.staff_facility_memberships'::regclass, 'UPDATE');
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = '0139: ' || mismatch || ' may not lock identity.staff_facility_memberships (FOR SHARE needs UPDATE); nothing applied';
  end if;
  select string_agg(expected.constraint_name, ', ') into mismatch
    from (values
      ('staff_licence_attestations_verification_method_check',
       'CHECK ((verification_method = ANY (ARRAY[''facility_attestation''::text, ''platform_review''::text])))'),
      ('staff_licence_attestations_method_ck',
       'CHECK ((((verification_method = ''facility_attestation''::text) AND (attested_by_membership_id IS NOT NULL) AND (review_application_id IS NULL)) OR ((verification_method = ''platform_review''::text) AND (attested_by_membership_id IS NULL) AND (review_application_id IS NOT NULL) AND (invitation_id IS NULL))))')
    ) expected(constraint_name, definition)
   where (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
           where constraint_row.conrelid = 'identity.staff_licence_attestations'::regclass
             and constraint_row.conname = expected.constraint_name) is distinct from expected.definition;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0139: these constraints of identity.staff_licence_attestations are not as this file replaces them: ' || mismatch;
  end if;
  select string_agg(expected.table_name || '.' || expected.column_name, ', ') into mismatch
    from (values
      ('auth.account_roles', 'role_code', 'text'), ('auth.account_roles', 'scope_type', 'text'),
      ('auth.account_roles', 'membership_id', 'uuid'), ('auth.account_roles', 'facility_id', 'uuid'),
      ('auth.account_roles', 'revoked_at', 'timestamp with time zone'), ('auth.account_roles', 'revoked_by', 'uuid'),
      ('auth.account_roles', 'revocation_reason', 'text'), ('auth.account_roles', 'grant_reason', 'text'),
      ('auth.account_roles', 'row_version', 'bigint'),
      ('identity.staff_facility_memberships', 'membership_role', 'text'),
      ('identity.staff_facility_memberships', 'app_role', 'text'),
      ('identity.staff_facility_memberships', 'row_version', 'bigint'),
      ('identity.access_requests', 'purpose_of_use', 'text'),
      ('identity.access_requests', 'break_glass', 'boolean'),
      ('identity.access_requests', 'migration_hold_reason', 'text'),
      ('identity.access_requests', 'scope', 'text'),
      ('identity.staff_licence_attestations', 'verification_method', 'text'),
      ('identity.staff_licence_attestations', 'role_grant_id', 'uuid'),
      ('identity.outreach_organisations', 'facility_id', 'uuid'),
      ('auth.admin_command_idempotency', 'response', 'jsonb'),
      ('identity.consent_grants', 'membership_id', 'uuid'), ('identity.consent_grants', 'status', 'text'),
      ('identity.consent_grants', 'expires_at', 'timestamp with time zone'),
      ('identity.consent_grants', 'authorization_method', 'text'), ('identity.consent_grants', 'break_glass', 'boolean'),
      ('identity.consent_grants', 'scope', 'text'), ('identity.consent_grants', 'revoked_reason', 'text'),
      ('identity.organization_applications', 'approval_mode', 'text'),
      ('identity.organization_applications', 'self_service_released_at', 'timestamp with time zone'))
      expected(table_name, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = to_regclass(expected.table_name)
                        and attribute.attname = expected.column_name and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0139: these columns are not as this file reads them: ' || mismatch;
  end if;
  if not exists (select 1 from auth.permissions where code = 'platform.principal.manage')
     or not exists (select 1 from auth.permissions where code = 'platform.admin.access')
     or not exists (select 1 from auth.permissions where code = 'workforce.manage')
     or not exists (select 1 from auth.permissions where code = 'ocr.job.write')
     or not exists (select 1 from auth.permissions where code = 'identity.patient.open-own-facility')
     or not exists (select 1 from auth.permissions where code = 'identity.break-glass.write')
     or not exists (select 1 from identity.staff_attestation_texts where version = 'facility-staff-attestation-v1') then
    raise exception using errcode = '55000', message = '0139: a permission or attestation text this file reads is missing';
  end if;
end
$$;

-- 0b. Locks (see Locks), NOWAIT, at most 5 s; one attempt when this
-- transaction already holds an earlier migration's locks.
do $locks$
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
begin
  loop
    attempt := attempt + 1;
    begin
      lock table identity.staff_licence_attestations in access exclusive mode nowait;
      lock table auth.permissions, auth.role_permissions, identity.staff_attestation_texts in row exclusive mode nowait;
      lock table auth.roles in row share mode nowait;
      lock table auth.account_roles, auth.accounts, identity.staff_facility_memberships, auth.admin_command_idempotency
        in access share mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0139: the licence attestations or a table it reads is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0139: the licence attestations or a table it reads stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 1. The permission (D1) and the attestation text (D2).
insert into auth.permissions (code, description) values
  ('platform.facility-staff.manage', 'Add or remove one role for a staff member at any facility, with a licence check');

insert into auth.role_permissions (role_code, permission_code)
select holder.role_code, 'platform.facility-staff.manage'
  from auth.role_permissions holder
 where holder.permission_code = 'platform.principal.manage'
 order by holder.role_code;

insert into identity.staff_attestation_texts (version, text) values
  ('platform-staff-role-v1',
   'Health ID support checked this licence when it added the role, and recorded how it checked.');

-- 2. The attestation constraints (D3).
alter table identity.staff_licence_attestations
  drop constraint staff_licence_attestations_verification_method_check,
  drop constraint staff_licence_attestations_method_ck,
  add constraint staff_licence_attestations_verification_method_check check (verification_method in (
    'facility_attestation', 'platform_review',
    'regulator_register', 'in_person', 'officer_match', 'cac_registered_contact', 'other')),
  add constraint staff_licence_attestations_method_ck check (
    (verification_method = 'facility_attestation' and attested_by_membership_id is not null
      and review_application_id is null)
    or (verification_method = 'platform_review' and attested_by_membership_id is null
      and review_application_id is not null and invitation_id is null)
    or (verification_method in ('regulator_register', 'in_person', 'officer_match', 'cac_registered_contact', 'other')
      and attested_by_membership_id is null and review_application_id is null and invitation_id is null));

-- 3. The helpers (D4). SECURITY INVOKER: they run as the definers' owner.

-- The staff roles support may add at a facility: those of the organisation's
-- recorded kinds (a hospital when none is recorded, Q91 A), none at an
-- outreach group's facility or an unknown facility. Sorted.
create function identity.staff_role_change_roles(target_facility_id uuid)
returns text[]
language plpgsql stable
set search_path = pg_catalog, pg_temp
as $$
declare
  target_organization uuid;
  kinds text[];
begin
  select facility.organization_id into target_organization
    from identity.facilities facility where facility.id = target_facility_id;
  if target_organization is null
     or exists (select 1 from identity.outreach_organisations organisation
                 where organisation.facility_id = target_facility_id) then
    return array[]::text[];
  end if;
  select coalesce(staff_kinds.organization_kinds, array[]::text[]) into kinds
    from identity.organization_staff_kinds(target_organization) staff_kinds;
  if coalesce(cardinality(kinds), 0) = 0 then
    kinds := array['hospital'];
  end if;
  return coalesce((select array_agg(distinct allowed.role_code order by allowed.role_code)
                     from unnest(kinds) kind(code)
                     cross join lateral unnest(identity.staff_invitable_roles(kind.code, null)) allowed(role_code)),
                  array[]::text[]);
end
$$;

-- The membership a command changes, locked FOR NO KEY UPDATE, after the
-- refusals of 0086's role change, in its order: not at this facility
-- (P0002 FACILITY_STAFF_NOT_FOUND), the caller's own (FACILITY_STAFF_SELF),
-- the facility administrator's (FACILITY_STAFF_ADMINISTRATOR, unless
-- administrators_allowed), ended (FACILITY_STAFF_ALREADY_ENDED), a platform
-- account (FACILITY_STAFF_PLATFORM_ACCOUNT).
create function identity.staff_role_change_member(
  target_membership_id uuid,
  target_facility_id uuid,
  actor_account uuid,
  administrators_allowed boolean
) returns identity.staff_facility_memberships
language plpgsql volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  member identity.staff_facility_memberships%rowtype;
begin
  select membership.* into member from identity.staff_facility_memberships membership
   where membership.id = target_membership_id and membership.facility_id = target_facility_id
   for no key update;
  if member.id is null then
    raise exception using errcode = 'P0002', message = 'FACILITY_STAFF_NOT_FOUND';
  end if;
  if member.account_id = actor_account then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_SELF';
  end if;
  if not administrators_allowed
     and exists (select 1 from auth.account_roles assignment
                  where assignment.membership_id = member.id and assignment.revoked_at is null
                    and assignment.role_code in ('org_admin', 'org_admin_awaiting_review')) then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ADMINISTRATOR';
  end if;
  if not member.active then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ALREADY_ENDED';
  end if;
  if exists (select 1 from auth.account_roles assignment
              where assignment.account_id = member.account_id and assignment.scope_type = 'platform'
                and assignment.revoked_at is null) then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_PLATFORM_ACCOUNT';
  end if;
  return member;
end
$$;

-- The change (see "What a command does"). requested_action is 'add' or
-- 'remove'; for an add of a licensed role the licence, the method and the
-- attestation text are given, else they are null. The caller has validated
-- them; the table's constraints check them again.
create function identity.staff_role_change_apply(
  member identity.staff_facility_memberships,
  expected_version bigint,
  requested_action text,
  requested_role text,
  licence_body text,
  licence_number text,
  verification_method text,
  attestation_version text,
  attester_account uuid,
  attester_membership uuid,
  change_reason text,
  out row_version bigint,
  out roles text[],
  out previous_roles text[],
  out requests_closed integer,
  out grants_revoked integer
) returns record
language plpgsql volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  observed timestamptz := clock_timestamp();
  grant_id uuid;
  person_name text;
  member_subject text;
  next_app_role text;
  next_membership_role text;
  own_facility_lost boolean;
  break_glass_lost boolean;
  closed record;
begin
  if requested_action not in ('add', 'remove') then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';
  end if;
  perform 1 from auth.account_roles assignment
   where assignment.membership_id = member.id and assignment.revoked_at is null
   order by assignment.id
   for update;
  select coalesce(array_agg(assignment.role_code order by assignment.role_code), array[]::text[])
    into previous_roles
    from auth.account_roles assignment
   where assignment.membership_id = member.id and assignment.scope_type = 'facility'
     and assignment.revoked_at is null;
  if requested_action = 'add' and requested_role = any(previous_roles) then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ROLE_ALREADY_HELD';
  end if;
  if requested_action = 'remove' and not (requested_role = any(previous_roles)) then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ROLE_NOT_HELD';
  end if;
  if requested_action = 'remove' and cardinality(previous_roles) = 1 then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_LAST_ROLE';
  end if;
  -- No role left can take membership_role (staff_memberships_scoped_uq).
  if requested_action = 'remove' and member.membership_role = requested_role
     and not exists (select 1 from unnest(previous_roles) held(role_code)
                      where held.role_code <> requested_role
                        and not exists (select 1 from identity.staff_facility_memberships other
                                         where other.staff_id = member.staff_id
                                           and other.organization_id = member.organization_id
                                           and other.facility_id = member.facility_id and other.id <> member.id
                                           and other.membership_role = held.role_code)) then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ROLE_COLUMN_CONFLICT';
  end if;
  if expected_version is null or member.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Facility staff membership version conflict';
  end if;

  if requested_action = 'add' then
    grant_id := gen_random_uuid();
    insert into auth.account_roles (
      id, account_id, role_code, scope_type, membership_id, facility_id, granted_by, grant_reason
    ) values (
      grant_id, member.account_id, requested_role, 'facility', member.id, member.facility_id, attester_account,
      change_reason
    );
    if licence_body is not null then
      select btrim(left(coalesce(account.display_name, staff.full_name), 200)) into person_name
        from identity.staff staff join auth.accounts account on account.id = staff.account_id
       where staff.id = member.staff_id;
      insert into identity.staff_licence_attestations (
        organization_id, facility_id, account_id, staff_id, membership_id, role_code, role_grant_id,
        licence_body, licence_number, attested_person_name, verification_method,
        attested_by_account_id, attested_by_membership_id, attestation_version, attested_at, correlation_id
      ) values (
        member.organization_id, member.facility_id, member.account_id, member.staff_id, member.id,
        requested_role, grant_id, licence_body, licence_number, person_name, verification_method,
        attester_account, attester_membership, attestation_version, observed, platform.current_correlation_id()
      );
    end if;
    select array_agg(held.role_code order by held.role_code) into roles
      from unnest(previous_roles || requested_role) held(role_code);
  else
    update auth.account_roles assignment
       set revoked_at = observed, revoked_by = attester_account, revocation_reason = change_reason,
           row_version = assignment.row_version + 1
     where assignment.membership_id = member.id and assignment.scope_type = 'facility'
       and assignment.role_code = requested_role and assignment.revoked_at is null;
    roles := array_remove(previous_roles, requested_role);
  end if;

  -- The two role columns the staff session lists (see "What a command does").
  next_app_role := case when requested_action = 'remove' and member.app_role = requested_role
    then roles[1] else member.app_role end;
  next_membership_role := member.membership_role;
  if requested_action = 'remove' and member.membership_role = requested_role then
    select held.role_code into next_membership_role
      from unnest(roles) held(role_code)
     where not exists (select 1 from identity.staff_facility_memberships other
                        where other.staff_id = member.staff_id and other.organization_id = member.organization_id
                          and other.facility_id = member.facility_id and other.id <> member.id
                          and other.membership_role = held.role_code)
     order by held.role_code
     limit 1;
  end if;
  update identity.staff_facility_memberships membership
     set membership_role = next_membership_role, app_role = next_app_role,
         updated_at = observed, row_version = membership.row_version + 1
   where membership.id = member.id
   returning membership.row_version into row_version;

  requests_closed := 0;
  if requested_action = 'remove' then
    select account.subject into member_subject from auth.accounts account where account.id = member.account_id;
    with closed_request as (
      update identity.access_requests request_row
         set status = 'expired', updated_at = clock_timestamp(), row_version = request_row.row_version + 1
       where request_row.membership_id = member.id and request_row.status = 'pending'
         and request_row.purpose_of_use = 'healthcare-operations'
         and not request_row.break_glass and request_row.migration_hold_reason is null
         and not coalesce(auth.membership_has_permission(member_subject, member.id, request_row.facility_id,
                            'ocr.job.write'), false)
      returning request_row.id, request_row.patient_id, request_row.facility_id, request_row.scope
    ), audited as (
      insert into audit.events (
        correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type, resource_id,
        purpose_of_use, reason, provenance, source_system, details
      )
      select platform.current_correlation_id(), 'system', closed_request.facility_id, closed_request.patient_id,
             'identity.access-request.close', 'success', 'access-request', closed_request.id::text,
             'healthcare-operations', 'This staff member can no longer process records', 'application',
             'identity-api',
             jsonb_build_object('status', 'expired', 'scope', closed_request.scope, 'cause', 'role-removed')
        from closed_request
      returning 1
    )
    select count(*)::integer into requests_closed from audited;
  end if;

  -- The grants the roles left no longer allow (see "What a command does").
  grants_revoked := 0;
  if requested_action = 'remove' then
    select
      not exists (select 1 from auth.account_roles assignment
                    join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
                    join auth.role_permissions holder on holder.role_code = assignment.role_code
                    join auth.permissions permission_row
                      on permission_row.code = holder.permission_code and permission_row.active
                   where assignment.membership_id = member.id and assignment.facility_id = member.facility_id
                     and assignment.scope_type = 'facility' and assignment.revoked_at is null
                     and holder.permission_code = 'identity.patient.open-own-facility'),
      not exists (select 1 from auth.account_roles assignment
                    join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
                    join auth.role_permissions holder on holder.role_code = assignment.role_code
                    join auth.permissions permission_row
                      on permission_row.code = holder.permission_code and permission_row.active
                   where assignment.membership_id = member.id and assignment.facility_id = member.facility_id
                     and assignment.scope_type = 'facility' and assignment.revoked_at is null
                     and holder.permission_code = 'identity.break-glass.write')
      into own_facility_lost, break_glass_lost;
    if own_facility_lost or break_glass_lost then
      for closed in
        update identity.consent_grants grant_row
           set status = 'revoked', revoked_at = observed, revoked_by = attester_account,
               revoked_reason = change_reason, updated_at = observed, row_version = grant_row.row_version + 1
         where grant_row.membership_id = member.id and grant_row.status = 'active'
           and grant_row.expires_at > observed
           and ((own_facility_lost and grant_row.authorization_method = 'own_facility')
             or (break_glass_lost and (grant_row.break_glass or grant_row.scope = 'break_glass')))
        returning grant_row.id, grant_row.patient_id, grant_row.facility_id, grant_row.break_glass
      loop
        grants_revoked := grants_revoked + 1;
        insert into audit.events (
          correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
          organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
          purpose_of_use, reason, provenance, source_system, details
        ) values (
          platform.current_correlation_id(),
          case when attester_membership is null then 'system' else 'staff' end,
          case when attester_membership is null then null else platform.current_actor_subject() end,
          case when attester_membership is null then null else attester_account end,
          attester_membership, member.organization_id, closed.facility_id, closed.patient_id,
          'identity.consent-grant.close', 'success', 'consent-grant', closed.id::text,
          'healthcare-operations', change_reason, 'application', 'identity-api',
          jsonb_build_object('existing_closure', false, 'membershipId', member.id, 'cause', 'role-removed',
            'access', case when closed.break_glass then 'break_glass' else 'own_facility' end)
        );
      end loop;
    end if;
  end if;
end
$$;

-- One row per active licensed role of the facility's active memberships,
-- with the latest attestation tied to that grant (none: the licence fields
-- are null). Never the licence number itself.
create function identity.staff_role_licences(target_facility_id uuid)
returns table (
  membership_id uuid,
  role_code text,
  licence_body text,
  licence_number_hint text,
  vouched_by_name text,
  vouched_at timestamptz,
  verification_method text
)
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  select grant_row.membership_id, grant_row.role_code,
    coalesce(latest.licence_body, identity.staff_role_licence_body(grant_row.role_code)),
    case when latest.licence_number is null then null else identity.licence_number_hint(latest.licence_number) end,
    coalesce(attester.display_name, attester.email), latest.attested_at, latest.verification_method
    from auth.account_roles grant_row
    join identity.staff_facility_memberships membership
      on membership.id = grant_row.membership_id and membership.facility_id = target_facility_id
     and membership.active
    left join lateral (
      select attestation.licence_body, attestation.licence_number, attestation.attested_at,
        attestation.verification_method, attestation.attested_by_account_id
        from identity.staff_licence_attestations attestation
       where attestation.role_grant_id = grant_row.id
       order by attestation.recorded_at desc, attestation.id desc
       limit 1
    ) latest on true
    left join auth.accounts attester on attester.id = latest.attested_by_account_id
   where grant_row.scope_type = 'facility' and grant_row.revoked_at is null
     and grant_row.facility_id = target_facility_id
     and identity.staff_role_licence_body(grant_row.role_code) is not null
   order by grant_row.membership_id, grant_row.role_code
$$;

revoke all on function identity.staff_role_change_roles(uuid),
  identity.staff_role_change_member(uuid,uuid,uuid,boolean),
  identity.staff_role_change_apply(identity.staff_facility_memberships,bigint,text,text,text,text,text,text,uuid,uuid,text),
  identity.staff_role_licences(uuid) from public;

-- 4. The commands and the reads (D5).

-- The facility administrator adds one role (see "The administrator's commands").
create function identity.add_facility_staff_role(
  requested_membership_id uuid,
  expected_version bigint,
  requested_role text,
  requested_licence_body text,
  requested_licence_number text,
  requested_attestation_version text,
  requested_reason text,
  requested_idempotency_key text,
  requested_request_sha256 char(64)
) returns table (membership_id uuid, row_version bigint, roles text[], replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  reason text := btrim(coalesce(requested_reason, ''));
  normalized_number text := case when requested_licence_number is null then null
    else identity.normalize_licence_number(requested_licence_number) end;
  prior auth.admin_command_idempotency%rowtype;
  member identity.staff_facility_memberships%rowtype;
  changed record;
begin
  select * into actor from identity.staff_management_actor(true);
  perform platform.require_control_enabled('staff_invitations_enabled');
  if actor.review_state <> 'reviewed' then
    raise exception using errcode = 'P0001', message = 'FACILITY_REVIEW_PENDING';
  end if;
  if requested_idempotency_key is null
     or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'FACILITY_STAFF_REASON_INVALID';
  end if;
  if requested_role is null
     or requested_role not in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist')
     or not ((requested_role = 'receptionist' and requested_licence_body is null and normalized_number is null)
       or (requested_role <> 'receptionist'
         and requested_licence_body is not distinct from identity.staff_role_licence_body(requested_role)
         and identity.licence_number_valid(normalized_number)))
     or requested_attestation_version is null
     or requested_attestation_version not like 'facility-staff-attestation-%'
     or not exists (select 1 from identity.staff_attestation_texts attestation
                     where attestation.version = requested_attestation_version) then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';
  end if;
  if not (requested_role = any(identity.staff_invitable_roles(actor.organization_type, actor.product_code))) then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_ROLE_NOT_ALLOWED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'identity.facility-staff.role-add:' || actor.account_id::text || ':' || requested_idempotency_key, 139));
  select command.* into prior from auth.admin_command_idempotency command
   where command.actor_account_id = actor.account_id and command.operation = 'identity.facility-staff.role-add'
     and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_request_sha256
       or prior.response->>'facilityId' is distinct from actor.facility_id::text then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query select (prior.response->>'membershipId')::uuid, (prior.response->>'version')::bigint,
      array(select jsonb_array_elements_text(prior.response->'roles')), true;
    return;
  end if;

  member := identity.staff_role_change_member(requested_membership_id, actor.facility_id, actor.account_id, false);
  changed := identity.staff_role_change_apply(member, expected_version, 'add', requested_role,
    case when requested_role = 'receptionist' then null else requested_licence_body end,
    case when requested_role = 'receptionist' then null else normalized_number end,
    case when requested_role = 'receptionist' then null else 'facility_attestation' end,
    case when requested_role = 'receptionist' then null else requested_attestation_version end,
    actor.account_id, actor.membership_id,
    case when requested_role = 'receptionist' then 'Role added by the facility administrator'
      else 'Role added by the facility administrator; licence vouched by the facility administrator' end);
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.account_id,
    actor.membership_id, actor.organization_id, actor.facility_id,
    'identity.facility-staff.role-add', 'success', 'staff-membership', member.id::text,
    'healthcare-operations', reason, 'application', 'identity-api',
    jsonb_build_object('membershipId', member.id, 'roleCode', requested_role,
      'licenceBody', case when requested_role = 'receptionist' then null else requested_licence_body end,
      'previousRoles', to_jsonb(changed.previous_roles), 'roles', to_jsonb(changed.roles))
  );
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (
    actor.account_id, 'identity.facility-staff.role-add', requested_idempotency_key, requested_request_sha256,
    jsonb_build_object('membershipId', member.id, 'facilityId', actor.facility_id,
      'version', changed.row_version, 'roles', to_jsonb(changed.roles))
  );
  return query select member.id, changed.row_version, changed.roles, false;
end
$$;

-- The facility administrator removes one role. No Idempotency-Key: a retry
-- after success answers FACILITY_STAFF_ROLE_NOT_HELD.
create function identity.remove_facility_staff_role(
  requested_membership_id uuid,
  expected_version bigint,
  requested_role text,
  requested_reason text
) returns table (membership_id uuid, row_version bigint, roles text[], requests_closed integer,
  grants_revoked integer)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  reason text := btrim(coalesce(requested_reason, ''));
  member identity.staff_facility_memberships%rowtype;
  changed record;
begin
  select * into actor from identity.staff_management_actor(true);
  if actor.review_state <> 'reviewed' then
    raise exception using errcode = 'P0001', message = 'FACILITY_REVIEW_PENDING';
  end if;
  if length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'FACILITY_STAFF_REASON_INVALID';
  end if;
  if requested_role is null or requested_role not in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist') then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';
  end if;
  if not (requested_role = any(identity.staff_invitable_roles(actor.organization_type, actor.product_code))) then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_ROLE_NOT_ALLOWED';
  end if;
  member := identity.staff_role_change_member(requested_membership_id, actor.facility_id, actor.account_id, false);
  changed := identity.staff_role_change_apply(member, expected_version, 'remove', requested_role,
    null, null, null, null, actor.account_id, actor.membership_id, 'Role removed by the facility administrator');
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.account_id,
    actor.membership_id, actor.organization_id, actor.facility_id,
    'identity.facility-staff.role-remove', 'success', 'staff-membership', member.id::text,
    'healthcare-operations', reason, 'application', 'identity-api',
    jsonb_build_object('membershipId', member.id, 'roleCode', requested_role,
      'previousRoles', to_jsonb(changed.previous_roles), 'roles', to_jsonb(changed.roles),
      'requestsClosed', changed.requests_closed, 'grantsRevoked', changed.grants_revoked)
  );
  return query select member.id, changed.row_version, changed.roles, changed.requests_closed,
    changed.grants_revoked;
end
$$;

-- Support adds one role at any facility (see "Support's commands").
create function identity.admin_add_facility_staff_role(
  requested_facility_id uuid,
  requested_membership_id uuid,
  expected_version bigint,
  requested_role text,
  requested_licence_body text,
  requested_licence_number text,
  requested_verification_method text,
  requested_reason text,
  requested_idempotency_key text,
  requested_request_sha256 char(64)
) returns table (membership_id uuid, row_version bigint, roles text[], previous_roles text[], replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  reason text := btrim(coalesce(requested_reason, ''));
  normalized_number text := case when requested_licence_number is null then null
    else identity.normalize_licence_number(requested_licence_number) end;
  prior auth.admin_command_idempotency%rowtype;
  member identity.staff_facility_memberships%rowtype;
  changed record;
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or not auth.account_has_platform_permission(actor_account, 'platform.facility-staff.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_idempotency_key is null
     or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'FACILITY_STAFF_REASON_INVALID';
  end if;
  if requested_role is null
     or requested_role not in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist')
     or not ((requested_role = 'receptionist' and requested_licence_body is null and normalized_number is null
               and requested_verification_method is null)
       or (requested_role <> 'receptionist'
         and requested_licence_body is not distinct from identity.staff_role_licence_body(requested_role)
         and identity.licence_number_valid(normalized_number)
         and coalesce(requested_verification_method in
           ('regulator_register', 'in_person', 'officer_match', 'cac_registered_contact', 'other'), false))) then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'admin.facility-staff.role-add:' || actor_account::text || ':' || requested_idempotency_key, 139));
  select command.* into prior from auth.admin_command_idempotency command
   where command.actor_account_id = actor_account and command.operation = 'admin.facility-staff.role-add'
     and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_request_sha256
       or prior.response->>'facilityId' is distinct from requested_facility_id::text then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query select (prior.response->>'membershipId')::uuid, (prior.response->>'version')::bigint,
      array(select jsonb_array_elements_text(prior.response->'roles')),
      array(select jsonb_array_elements_text(prior.response->'previousRoles')), true;
    return;
  end if;

  if not exists (select 1 from identity.facilities facility where facility.id = requested_facility_id) then
    raise exception using errcode = 'P0002', message = 'ADMIN_FACILITY_NOT_FOUND';
  end if;
  if not (requested_role = any(identity.staff_role_change_roles(requested_facility_id))) then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_ROLE_NOT_ALLOWED';
  end if;
  -- A self-signed-up facility's administrator: 0086 S12's command, not this one.
  member := identity.staff_role_change_member(requested_membership_id, requested_facility_id, actor_account,
    not exists (select 1 from identity.facilities facility
                  join identity.organization_applications application
                    on application.organization_id = facility.organization_id
                 where facility.id = requested_facility_id and application.approval_mode = 'self_service'
                   and application.reviewed_by_account_id is null
                   and (application.status = 'approved' or application.self_service_released_at is not null)));
  changed := identity.staff_role_change_apply(member, expected_version, 'add', requested_role,
    case when requested_role = 'receptionist' then null else requested_licence_body end,
    case when requested_role = 'receptionist' then null else normalized_number end,
    case when requested_role = 'receptionist' then null else requested_verification_method end,
    case when requested_role = 'receptionist' then null else 'platform-staff-role-v1' end,
    actor_account, null,
    case when requested_role = 'receptionist' then 'Role added by Health ID support'
      else 'Role added by Health ID support; licence checked by Health ID support' end);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (
    actor_account, 'admin.facility-staff.role-add', requested_idempotency_key, requested_request_sha256,
    jsonb_build_object('membershipId', member.id, 'facilityId', requested_facility_id,
      'version', changed.row_version, 'roles', to_jsonb(changed.roles),
      'previousRoles', to_jsonb(changed.previous_roles))
  );
  return query select member.id, changed.row_version, changed.roles, changed.previous_roles, false;
end
$$;

-- Support removes one role at any facility.
create function identity.admin_remove_facility_staff_role(
  requested_facility_id uuid,
  requested_membership_id uuid,
  expected_version bigint,
  requested_role text,
  requested_reason text,
  requested_idempotency_key text,
  requested_request_sha256 char(64)
) returns table (membership_id uuid, row_version bigint, roles text[], previous_roles text[],
  requests_closed integer, grants_revoked integer, replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  reason text := btrim(coalesce(requested_reason, ''));
  prior auth.admin_command_idempotency%rowtype;
  member identity.staff_facility_memberships%rowtype;
  changed record;
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or not auth.account_has_platform_permission(actor_account, 'platform.facility-staff.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_idempotency_key is null
     or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'FACILITY_STAFF_REASON_INVALID';
  end if;
  if requested_role is null or requested_role not in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist') then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'admin.facility-staff.role-remove:' || actor_account::text || ':' || requested_idempotency_key, 139));
  select command.* into prior from auth.admin_command_idempotency command
   where command.actor_account_id = actor_account and command.operation = 'admin.facility-staff.role-remove'
     and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_request_sha256
       or prior.response->>'facilityId' is distinct from requested_facility_id::text then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query select (prior.response->>'membershipId')::uuid, (prior.response->>'version')::bigint,
      array(select jsonb_array_elements_text(prior.response->'roles')),
      array(select jsonb_array_elements_text(prior.response->'previousRoles')),
      (prior.response->>'requestsClosed')::integer, (prior.response->>'grantsRevoked')::integer, true;
    return;
  end if;

  if not exists (select 1 from identity.facilities facility where facility.id = requested_facility_id) then
    raise exception using errcode = 'P0002', message = 'ADMIN_FACILITY_NOT_FOUND';
  end if;
  if not (requested_role = any(identity.staff_role_change_roles(requested_facility_id))) then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_ROLE_NOT_ALLOWED';
  end if;
  -- A self-signed-up facility's administrator: 0086 S12's command, not this one.
  member := identity.staff_role_change_member(requested_membership_id, requested_facility_id, actor_account,
    not exists (select 1 from identity.facilities facility
                  join identity.organization_applications application
                    on application.organization_id = facility.organization_id
                 where facility.id = requested_facility_id and application.approval_mode = 'self_service'
                   and application.reviewed_by_account_id is null
                   and (application.status = 'approved' or application.self_service_released_at is not null)));
  changed := identity.staff_role_change_apply(member, expected_version, 'remove', requested_role,
    null, null, null, null, actor_account, null, 'Role removed by Health ID support');
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (
    actor_account, 'admin.facility-staff.role-remove', requested_idempotency_key, requested_request_sha256,
    jsonb_build_object('membershipId', member.id, 'facilityId', requested_facility_id,
      'version', changed.row_version, 'roles', to_jsonb(changed.roles),
      'previousRoles', to_jsonb(changed.previous_roles), 'requestsClosed', changed.requests_closed,
      'grantsRevoked', changed.grants_revoked)
  );
  return query select member.id, changed.row_version, changed.roles, changed.previous_roles,
    changed.requests_closed, changed.grants_revoked, false;
end
$$;

-- The Staff page's licences: the administrator's own facility, as
-- identity.list_facility_staff() is admitted.
create function identity.list_facility_staff_licences()
returns table (
  membership_id uuid,
  role_code text,
  licence_body text,
  licence_number_hint text,
  vouched_by_name text,
  vouched_at timestamptz,
  verification_method text
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
begin
  select * into actor from identity.staff_management_actor(false);
  return query select * from identity.staff_role_licences(actor.facility_id);
end
$$;

-- Support's staff view's licences, admitted as identity.admin_list_facility_staff is.
create function identity.admin_list_facility_staff_licences(target_facility_id uuid)
returns table (
  membership_id uuid,
  role_code text,
  licence_body text,
  licence_number_hint text,
  vouched_by_name text,
  vouched_at timestamptz,
  verification_method text
)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or not auth.account_has_platform_permission(actor_account, 'platform.principal.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  return query select * from identity.staff_role_licences(target_facility_id);
end
$$;

-- 4b. The two openers, replaced (D6): 0131's identity.open_own_facility_patient
-- and 0123's identity.activate_break_glass, as signed, with only the lines
-- marked 0139 (D6) added. CREATE OR REPLACE keeps each one's owner, grants
-- and comment; the post-check proves that removing the marked lines gives
-- back the signed body.
create or replace function identity.open_own_facility_patient(requested_hid text, requested_patient_id uuid)
returns table (outcome text, consent_grant_id uuid, subject_patient_id uuid, grant_status text,
  expires_at timestamptz, existing_grant boolean, basis text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  actor_correlation text := platform.current_correlation_id();
  actor_staff uuid;
  actor_organization uuid;
  patient_value uuid;
  basis_value text;
  refusal text;
  grant_value uuid;
  grant_expires timestamptz;
  reused boolean := false;
  grant_minutes constant integer := 1440;
  grant_reason constant text := 'Opened as this facility''s patient';
begin
  -- 0139 (D6): wait for a role removal in flight on this membership, so the
  -- permission below is read once it has committed, and its revocation sees
  -- any grant this call makes.
  perform 1 from identity.staff_facility_memberships membership where membership.id = actor_membership for share;
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
                                           'identity.patient.open-own-facility') then
    raise exception using errcode = '42501', message = 'OWN_FACILITY_ACCESS_NOT_PERMITTED';
  end if;
  if platform.current_purpose_of_use() is distinct from 'direct-care'
     or not exists (select 1 from identity.purpose_of_use_codes where code = 'direct-care' and active) then
    raise exception using errcode = '22023', message = 'OWN_FACILITY_ACCESS_DIRECT_CARE_ONLY';
  end if;
  if (requested_hid is null) = (requested_patient_id is null)
     or (requested_hid is not null and upper(btrim(requested_hid)) !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$') then
    raise exception using errcode = '22023', message = 'OWN_FACILITY_ACCESS_INVALID';
  end if;
  select membership.staff_id, membership.organization_id into actor_staff, actor_organization
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.account_id = actor_account
     and membership.facility_id = actor_facility and membership.active
     and membership.migration_hold_reason is null;
  if actor_staff is null then
    raise exception using errcode = '42501', message = 'OWN_FACILITY_ACCESS_NOT_PERMITTED';
  end if;

  select patient.id into patient_value
    from identity.patients patient
   where patient.status = 'active'
     and ((requested_hid is not null and upper(patient.hid_code) = upper(btrim(requested_hid)))
          or (requested_patient_id is not null and patient.id = requested_patient_id))
     and identity.sealed_demo_facility(actor_facility) = identity.sealed_demo_patient(patient.id)
     and identity.sealed_qa_facility(actor_facility) = identity.sealed_qa_patient(patient.id)
   limit 1;

  if patient_value is null then
    refusal := 'not_found';
  else
    perform pg_advisory_xact_lock(hashtextextended(
      'own-facility-open:' || actor_membership::text || ':' || patient_value::text, 0));
    if exists (
      select 1
        from identity.consent_directives directive
        join identity.consent_directive_versions directive_version
          on directive_version.directive_id = directive.id
         and directive_version.version_no = directive.current_version
       where directive.patient_id = patient_value
         and directive_version.status = 'active'
         and directive_version.provision_type = 'deny'
         and directive_version.starts_at <= clock_timestamp()
         and (directive_version.expires_at is null or directive_version.expires_at > clock_timestamp())
         and (directive_version.facility_id is null or directive_version.facility_id = actor_facility)
         and (cardinality(directive_version.actions) = 0
              or directive_version.actions && array['read_records', 'write_records']::text[])
         and (cardinality(directive_version.purposes) = 0 or 'direct-care' = any (directive_version.purposes))
         and (directive_version.grantee_type = 'all'
              or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = actor_facility)
              or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = actor_organization)
              or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = actor_staff))) then
      refusal := 'deny_directive';
    elsif exists (
      select 1 from identity.consent_grants revoked
       where revoked.patient_id = patient_value and revoked.facility_id = actor_facility
         and revoked.authorization_method = 'own_facility' and revoked.status = 'revoked'
         and revoked.revoked_at > clock_timestamp() - interval '24 hours'
         -- 0139 (D6): the patient's own revocation only (revoke_my_consent_grant
         -- records the patient's account), not a role removal's or a membership end's.
         and revoked.revoked_by = (select patient.account_id from identity.patients patient
                                    where patient.id = patient_value)) then
      refusal := 'revoked_by_patient';
    else
      basis_value := identity.own_facility_basis(patient_value, actor_facility);
      if basis_value is null then
        refusal := 'not_own_facility';
      end if;
    end if;
  end if;

  if refusal is not null then
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
      actor_organization, actor_facility, patient_value, 'identity.patient.open-own-facility', 'denied',
      'patient', patient_value::text, 'direct-care', 'application', 'identity-api',
      jsonb_build_object('refusal', refusal,
        'identifiedBy', case when requested_hid is not null then 'health_id' else 'patient_id' end)
    );
    return query select case when refusal = 'not_found' then 'not_found' else 'refused' end,
      null::uuid, null::uuid, null::text, null::timestamptz, false, null::text;
    return;
  end if;

  select grant_row.id, grant_row.expires_at into grant_value, grant_expires
    from identity.consent_grants grant_row
   where grant_row.patient_id = patient_value and grant_row.account_id = actor_account
     and grant_row.membership_id = actor_membership and grant_row.facility_id = actor_facility
     and grant_row.authorization_method = 'own_facility' and grant_row.status = 'active'
     and grant_row.expires_at > clock_timestamp() and grant_row.migration_hold_reason is null
   order by grant_row.expires_at desc
   limit 1;
  if grant_value is null then
    grant_value := pg_catalog.gen_random_uuid();
    grant_expires := current_timestamp + make_interval(mins => grant_minutes);
    insert into identity.consent_grants (
      id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
      scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass,
      correlation_id, authorization_method
    ) values (
      grant_value, null, patient_value, actor_staff, actor_account, actor_membership, actor_facility,
      'write_records', 'direct-care', 'active', grant_reason, current_timestamp, grant_expires, false,
      actor_correlation, 'own_facility'
    );
  else
    reused := true;
  end if;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, patient_value, 'identity.patient.open-own-facility', 'success',
    'consent-grant', grant_value::text, 'direct-care', 'application', 'identity-api',
    jsonb_build_object('basis', basis_value, 'existing_grant', reused, 'expires_at', grant_expires,
      'scope', 'write_records', 'duration_minutes', grant_minutes,
      'identifiedBy', case when requested_hid is not null then 'health_id' else 'patient_id' end)
  );
  return query select 'opened'::text, grant_value, patient_value, 'active'::text, grant_expires, reused,
    'own-facility'::text;
end
$$;

create or replace function identity.activate_break_glass(
  requested_hid text,
  requested_reason text,
  requested_duration_minutes integer
)
returns table (
  access_request_id uuid,
  consent_grant_id uuid,
  subject_patient_id uuid,
  grant_status text,
  expires_at timestamptz,
  existing_grant boolean
)
language plpgsql
security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  actor_correlation_id text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_staff_id uuid;
  actor_organization_id uuid;
  patient_id_value uuid;
  request_id_value uuid;
  grant_id_value uuid;
  grant_expires_at timestamptz;
  replayed boolean := false;
begin
  -- 0139 (D6): wait for a role removal in flight on this membership, so the
  -- permission below is read once it has committed, and its revocation sees
  -- any grant this call makes.
  perform 1 from identity.staff_facility_memberships membership where membership.id = actor_membership_id for share;
  if actor_account_id is null
     or actor_membership_id is null
     or actor_facility_id is null
     or actor_correlation_id is null
     or not auth.membership_has_permission(
       actor_subject, actor_membership_id, actor_facility_id, 'identity.break-glass.write'
     ) then
    raise exception using errcode = '42501', message = 'Authorized break-glass context is required';
  end if;
  if actor_purpose is distinct from 'emergency'
     or not exists (
       select 1 from identity.purpose_of_use_codes purpose
       where purpose.code = 'emergency' and purpose.active
     ) then
    raise exception using errcode = '22023', message = 'Break-glass requires the emergency purpose of use';
  end if;
  if requested_duration_minutes is null or requested_duration_minutes not between 5 and 240 then
    raise exception using errcode = '22023', message = 'Invalid break-glass duration';
  end if;
  if length(coalesce(btrim(requested_reason), '')) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'An explicit break-glass reason is required';
  end if;

  select membership.staff_id, membership.organization_id
    into actor_staff_id, actor_organization_id
  from identity.staff_facility_memberships membership
  where membership.id = actor_membership_id
    and membership.account_id = actor_account_id
    and membership.facility_id = actor_facility_id;
  if actor_staff_id is null then
    raise exception using errcode = '42501', message = 'Exact staff membership is required';
  end if;

  select patient_row.id
    into patient_id_value
  from identity.patients patient_row
  where upper(patient_row.hid_code) = upper(btrim(requested_hid))
    and patient_row.status = 'active'
    and identity.sealed_demo_facility(actor_facility_id) = identity.sealed_demo_patient(patient_row.id)
    and identity.sealed_qa_facility(actor_facility_id) = identity.sealed_qa_patient(patient_row.id)
  limit 1;
  if patient_id_value is null then
    raise exception using errcode = 'P0002', message = 'Patient is not available';
  end if;

  -- Serialize this actor's activation window across patients and facilities.
  perform pg_advisory_xact_lock(hashtextextended(actor_account_id::text || ':emergency-rate', 0));

  perform pg_advisory_xact_lock(hashtextextended(
    patient_id_value::text || ':' || actor_membership_id::text || ':break-glass', 0
  ));

  select grant_row.request_id, grant_row.id, grant_row.expires_at
    into request_id_value, grant_id_value, grant_expires_at
  from identity.consent_grants grant_row
  where grant_row.patient_id = patient_id_value
    and grant_row.account_id = actor_account_id
    and grant_row.membership_id = actor_membership_id
    and grant_row.facility_id = actor_facility_id
    and grant_row.scope = 'break_glass'
    and grant_row.purpose_of_use = 'emergency'
    and grant_row.status = 'active'
    and grant_row.expires_at > clock_timestamp()
    and grant_row.migration_hold_reason is null
  order by grant_row.expires_at desc
  limit 1;

  if grant_id_value is null then
    -- Replays preserve access without consuming another activation. New grants
    -- are bounded to ten per account per rolling hour, including closed grants.
    if (select count(*) from identity.consent_grants recent
        where recent.account_id = actor_account_id and recent.break_glass
          and recent.starts_at > clock_timestamp() - interval '1 hour') >= 10 then
      raise exception using errcode = 'P0001', message = 'Emergency activation rate limit reached';
    end if;
    request_id_value := gen_random_uuid();
    grant_id_value := gen_random_uuid();
    grant_expires_at := clock_timestamp() + make_interval(mins => requested_duration_minutes);

    insert into identity.access_requests (
      id, patient_id, staff_id, membership_id, facility_id, scope,
      purpose_of_use, reason, status, requested_duration_minutes,
      break_glass, approved_at, correlation_id
    ) values (
      request_id_value, patient_id_value, actor_staff_id, actor_membership_id,
      actor_facility_id, 'break_glass', 'emergency', btrim(requested_reason),
      'approved', requested_duration_minutes, true, clock_timestamp(), actor_correlation_id
    );

    insert into identity.consent_grants (
      id, request_id, patient_id, staff_id, account_id, membership_id,
      facility_id, scope, purpose_of_use, status, reason, starts_at,
      expires_at, break_glass, correlation_id
    ) values (
      grant_id_value, request_id_value, patient_id_value, actor_staff_id,
      actor_account_id, actor_membership_id, actor_facility_id, 'break_glass',
      'emergency', 'active', btrim(requested_reason), clock_timestamp(),
      grant_expires_at, true, actor_correlation_id
    );
  else
    replayed := true;
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    actor_membership_id, organization_id, facility_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'staff', actor_subject, actor_account_id,
    actor_membership_id, actor_organization_id, actor_facility_id, patient_id_value,
    case when replayed then 'identity.break-glass.replay' else 'identity.break-glass.activate' end,
    'success', 'consent-grant', grant_id_value::text, 'emergency',
    btrim(requested_reason), 'application', 'identity-api',
    jsonb_build_object(
      'access_request_id', request_id_value,
      'duration_minutes', requested_duration_minutes,
      'expires_at', grant_expires_at,
      'existing_grant', replayed,
      'review_required', true
    )
  );

  if not replayed then
    -- Audit, grant and patient-notification intent commit atomically. No
    -- emergency reason, HID, demographics or record content enters delivery.
    insert into identity.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id, patient_id,
      correlation_id, payload
    ) values (
      'EmergencyAccessActivated', grant_id_value, 1, actor_facility_id,
      patient_id_value, actor_correlation_id,
      jsonb_build_object('consentGrantId', grant_id_value, 'reviewRequired', true)
    );
  end if;

  return query select
    request_id_value, grant_id_value, patient_id_value, 'active'::text,
    grant_expires_at, replayed;
end;
$$;

-- 5. Grants (here and in runtime-grants.sql).
revoke all on function
  identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character),
  identity.remove_facility_staff_role(uuid,bigint,text,text),
  identity.admin_add_facility_staff_role(uuid,uuid,bigint,text,text,text,text,text,text,character),
  identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character),
  identity.list_facility_staff_licences(),
  identity.admin_list_facility_staff_licences(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function
      identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character),
      identity.remove_facility_staff_role(uuid,bigint,text,text),
      identity.admin_add_facility_staff_role(uuid,uuid,bigint,text,text,text,text,text,text,character),
      identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character),
      identity.list_facility_staff_licences(),
      identity.admin_list_facility_staff_licences(uuid) to hid_identity_runtime;
  end if;
end
$$;

comment on function identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character) is
  'SX-4 (0139): the facility administrator adds one role to a member, with the licence for a licensed role.';
comment on function identity.remove_facility_staff_role(uuid,bigint,text,text) is
  'SX-4 (0139): the facility administrator removes one role from a member, never the last.';
comment on function identity.admin_add_facility_staff_role(uuid,uuid,bigint,text,text,text,text,text,text,character) is
  'SX-4 (0139): Health ID support adds one role to a member at any facility, with its licence check.';
comment on function identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character) is
  'SX-4 (0139): Health ID support removes one role from a member at any facility, never the last.';

-- 6. Post-checks.
do $$
declare
  runtime_exists boolean := exists (select 1 from pg_roles where rolname = 'hid_identity_runtime');
  function_name text;
  mismatch text;
begin
  if (select array_agg(holder.role_code order by holder.role_code) from auth.role_permissions holder
       where holder.permission_code = 'platform.facility-staff.manage')
     is distinct from (select array_agg(holder.role_code order by holder.role_code) from auth.role_permissions holder
                        where holder.permission_code = 'platform.principal.manage') then
    raise exception using errcode = '55000', message = '0139 post-check: platform.facility-staff.manage is not held by exactly the platform.principal.manage roles';
  end if;
  if not exists (select 1 from identity.staff_attestation_texts where version = 'platform-staff-role-v1') then
    raise exception using errcode = '55000', message = '0139 post-check: the attestation text is missing';
  end if;
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.conrelid = 'identity.staff_licence_attestations'::regclass
         and constraint_row.conname in ('staff_licence_attestations_verification_method_check',
                                        'staff_licence_attestations_method_ck')
         and constraint_row.convalidated) <> 2 then
    raise exception using errcode = '55000', message = '0139 post-check: the attestation constraints are not in place';
  end if;
  foreach function_name in array array[
    'identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)',
    'identity.remove_facility_staff_role(uuid,bigint,text,text)',
    'identity.admin_add_facility_staff_role(uuid,uuid,bigint,text,text,text,text,text,text,character)',
    'identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character)',
    'identity.list_facility_staff_licences()',
    'identity.admin_list_facility_staff_licences(uuid)'] loop
    if not exists (select 1 from pg_proc proc where proc.oid = to_regprocedure(function_name)
                    and proc.prosecdef and proc.proconfig = array['search_path=pg_catalog, pg_temp'])
       or has_function_privilege('public', function_name, 'EXECUTE')
       or (runtime_exists and not has_function_privilege('hid_identity_runtime', function_name, 'EXECUTE')) then
      raise exception using errcode = '55000', message = '0139 post-check: ' || function_name || ' is not as intended';
    end if;
  end loop;
  foreach function_name in array array[
    'identity.staff_role_change_roles(uuid)',
    'identity.staff_role_change_member(uuid,uuid,uuid,boolean)',
    'identity.staff_role_change_apply(identity.staff_facility_memberships,bigint,text,text,text,text,text,text,uuid,uuid,text)',
    'identity.staff_role_licences(uuid)'] loop
    if not exists (select 1 from pg_proc proc where proc.oid = to_regprocedure(function_name)
                    and not proc.prosecdef and proc.proconfig = array['search_path=pg_catalog, pg_temp'])
       or has_function_privilege('public', function_name, 'EXECUTE')
       or (runtime_exists and has_function_privilege('hid_identity_runtime', function_name, 'EXECUTE')) then
      raise exception using errcode = '55000', message = '0139 post-check: ' || function_name || ' is not as intended';
    end if;
  end loop;
  -- D6: each replaced opener is its signed body plus only the marked lines,
  -- with its settings, owner and grants as before.
  if md5(replace(replace((select prosrc from pg_proc where oid = 'identity.open_own_facility_patient(text,uuid)'::regprocedure),
           $d6$  -- 0139 (D6): wait for a role removal in flight on this membership, so the
  -- permission below is read once it has committed, and its revocation sees
  -- any grant this call makes.
  perform 1 from identity.staff_facility_memberships membership where membership.id = actor_membership for share;
$d6$, ''), $d6$
         -- 0139 (D6): the patient's own revocation only (revoke_my_consent_grant
         -- records the patient's account), not a role removal's or a membership end's.
         and revoked.revoked_by = (select patient.account_id from identity.patients patient
                                    where patient.id = patient_value)$d6$, '')) <> '7e5d49ff292a03fb92f0395681be365d'
     or md5(replace((select prosrc from pg_proc where oid = 'identity.activate_break_glass(text,text,integer)'::regprocedure),
           $d6$  -- 0139 (D6): wait for a role removal in flight on this membership, so the
  -- permission below is read once it has committed, and its revocation sees
  -- any grant this call makes.
  perform 1 from identity.staff_facility_memberships membership where membership.id = actor_membership_id for share;
$d6$, '')) <> '585d55fe4f7b5773cea96ae8729cc99c'
     or (select array[prosecdef::text, array_to_string(proconfig, ';')] from pg_proc
          where oid = 'identity.open_own_facility_patient(text,uuid)'::regprocedure)
        is distinct from array['true', 'search_path=pg_catalog, pg_temp']
     or (select array[prosecdef::text, array_to_string(proconfig, ';')] from pg_proc
          where oid = 'identity.activate_break_glass(text,text,integer)'::regprocedure)
        is distinct from array['true', 'search_path=identity, auth, audit, platform, pg_temp']
     or has_function_privilege('public', 'identity.open_own_facility_patient(text,uuid)', 'EXECUTE')
     or has_function_privilege('public', 'identity.activate_break_glass(text,text,integer)', 'EXECUTE') then
    raise exception using errcode = '55000', message = '0139 post-check: a replaced opener is not its signed body plus 0139''s lines';
  end if;
  -- D6: and each one's owner may still take its FOR SHARE (as in 0).
  select string_agg(format('the owner of %s, %s,', opener.signature, pg_get_userbyid(proc.proowner)), ' and '
                    order by opener.position) into mismatch
    from (values (1, 'identity.open_own_facility_patient(text,uuid)'),
                 (2, 'identity.activate_break_glass(text,text,integer)')) opener(position, signature)
    join pg_proc proc on proc.oid = to_regprocedure(opener.signature)
   where not has_any_column_privilege(proc.proowner, 'identity.staff_facility_memberships'::regclass, 'UPDATE');
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = '0139 post-check: ' || mismatch || ' may not lock identity.staff_facility_memberships (FOR SHARE needs UPDATE)';
  end if;
end
$$;
