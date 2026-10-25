\set ON_ERROR_STOP on
-- The lock order of 0086 section 5 (P4b, FEA R1, S14), in its serial orders.
-- Rollback-only. Every P4b writer locks the organization's self-service
-- application row first (release FOR UPDATE, review and support's changes FOR
-- NO KEY UPDATE, every staff and invitation command and the review gate FOR
-- SHARE), so concurrent ones run as if in one of these orders; each order
-- must leave a consistent state:
--
--   1. a release, then an open, a prepare and an accept of an invitation
--      opened before it: withdrawn, the session gone, nothing written;
--   2. an accept, then a release: the new member's membership ended, its role
--      revoked and its sessions revoked;
--   3. a role change, then a release: no unrevoked role on an ended
--      membership; a release, then a role change: refused, nothing granted;
--   4. an account disable, then a review: refused (23514), nothing granted;
--      a review, then a disable: the grants stand, the account cannot sign in.
-- A single connection cannot hold two transactions, so the races themselves
-- (an accept and a role change blocked behind a release, a review behind a
-- disable, each completing without 40P01) are run with two connections by
-- the build's concurrency harness, recorded in the build report.
begin;

do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;

insert into auth.accounts (id, subject, email, display_name, status) values
  ('d5000000-0000-4000-8000-000000000001', 'synthetic:race:super', 'super@race.invalid', 'Race Super Admin', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d5010000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
   'Concurrency suite super admin');

-- Sign-ups: 1 and 2 (reviewed, released below), 3 (reviewed after its
-- administrator is disabled), 4 (reviewed, then disabled).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:race:super', true),
  set_config('app.correlation_id', 'race-open-controls', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'), 'Concurrency suite opens facility sign-up');
select platform.admin_set_control('staff_invitations_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'staff_invitations_enabled'), 'Concurrency suite opens staff invitations');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'race-signup-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  n integer;
  application_id uuid;
  current_application record;
  activated record;
begin
  for n in 1..4 loop
    application_id := identity.submit_self_service_organization_application('ehr', 'hospital', 'RC995000500' || n,
      'Race Admin ' || chr(64 + n), 'admin' || n || '@race-hospital.invalid');
    select * into current_application from identity.public_get_organization_application('RC995000500' || n,
      'admin' || n || '@race-hospital.invalid', 'ehr');
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version, 'verified',
      '9950' || n, 'RC995000500' || n, 'Race Hospital ' || chr(64 + n) || ' Ltd', 'Private Company Limited by Shares',
      '2015-0' || n || '-01', n || ' Race Road, Lagos', 'active');
    perform identity.begin_self_service_provider_enrollment('RC995000500' || n, 'admin' || n || '@race-hospital.invalid',
      'ehr', ('d5900000-0000-4000-8000-00000000000' || n)::uuid, encode(sha256(('race-otp-' || n)::bytea), 'hex'),
      'Race Admin ' || chr(64 + n), 'hospital');
    perform identity.verify_organization_profile_completion_challenge(('d5900000-0000-4000-8000-00000000000' || n)::uuid,
      encode(sha256(('race-otp-' || n)::bytea), 'hex'), encode(sha256(('race-session-' || n)::bytea), 'hex'));
    select * into activated from identity.activate_self_service_provider_enrollment(
      encode(sha256(('race-session-' || n)::bytea), 'hex'),
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    perform set_config('hid.test.r_app_' || n, application_id::text, true);
    perform set_config('hid.test.r_facility_' || n, activated.facility_id::text, true);
    perform set_config('hid.test.r_account_' || n, activated.account_id::text, true);
  end loop;
end $$;
select set_config('app.actor_subject', 'synthetic:race:super', true),
  set_config('app.correlation_id', 'race-review-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare n integer; listed record;
begin
  foreach n in array array[1, 2, 4] loop
    select * into listed from identity.admin_list_self_service_facilities('unreviewed') item
     where item.application_id = current_setting('hid.test.r_app_' || n)::uuid;
    perform identity.admin_review_self_service_facility(listed.application_id, listed.row_version,
      'Checked the company and its administrator', 'none', 'cac_registered_contact', null, null);
  end loop;
end $$;
reset role;
select set_config('hid.test.r_membership_' || n, (select id::text from identity.staff_facility_memberships
  where account_id = current_setting('hid.test.r_account_' || n)::uuid), true) from generate_series(1, 4) n;

create function pg_temp.as_admin(n integer, correlation text) returns void language sql as $f$
  select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.r_account_' || n), true),
    set_config('app.membership_id', current_setting('hid.test.r_membership_' || n), true),
    set_config('app.facility_id', current_setting('hid.test.r_facility_' || n), true),
    set_config('app.correlation_id', correlation, true), set_config('app.purpose_of_use', 'healthcare-operations', true);
$f$;
create function pg_temp.as_public(correlation text) returns void language sql as $f$
  select set_config('app.actor_subject', 'system:auth', true), set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true), set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', '', true);
$f$;
create function pg_temp.as_super(correlation text) returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:race:super', true), set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true), set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$f$;
create function pg_temp.release(n integer) returns void language plpgsql as $f$
declare facility_version bigint; account_version bigint;
begin
  perform pg_temp.as_super('race-release-' || n);
  select facility.row_version into facility_version from identity.facilities facility
   where facility.id = current_setting('hid.test.r_facility_' || n)::uuid;
  select account.row_version into account_version from auth.accounts account
   where account.id = current_setting('hid.test.r_account_' || n)::uuid;
  perform identity.admin_transition_facility(current_setting('hid.test.r_facility_' || n)::uuid, facility_version,
    'suspended', 'Concurrency suite suspends the facility', 'race-suspend-' || n, repeat('a', 64));
  perform auth.admin_transition_account(current_setting('hid.test.r_account_' || n)::uuid, account_version,
    'disabled', 'Concurrency suite disables the administrator', 'race-disable-' || n, repeat('b', 64));
  perform identity.admin_release_self_service_facility(current_setting('hid.test.r_app_' || n)::uuid,
    (select item.row_version from identity.admin_list_self_service_facilities('all') item
      where item.application_id = current_setting('hid.test.r_app_' || n)::uuid),
    'Concurrency suite releases the sign-up', false);
end $f$;
create function pg_temp.invite(n integer, k integer, invitee_email text, role_code text, body text, number text)
returns void language sql as $f$
  select pg_temp.as_admin(n, 'race-invite-' || k);
  select identity.create_staff_invitation(('d5970000-0000-4000-8000-00000000000' || k)::uuid,
    ('d5960000-0000-4000-8000-00000000000' || k)::uuid, 'Race Invitee', invitee_email, role_code, body, number,
    'facility-staff-attestation-v1', 'race-suite-key-0000' || k, encode(sha256(('race-request-' || k)::bytea), 'hex'),
    encode(sha256(('race-link-' || k)::bytea), 'hex'), encode(sha256(('race-code-' || k)::bytea), 'hex'), 'v1');
$f$;
grant execute on function pg_temp.as_admin(integer,text), pg_temp.as_public(text), pg_temp.as_super(text),
  pg_temp.release(integer), pg_temp.invite(integer,integer,text,text,text,text) to hid_identity_api_runtime;

-- 1. A release, then the open session's prepare and accept, then an open.
set local role hid_identity_api_runtime;
select pg_temp.invite(1, 1, 'first@race-people.invalid', 'nurse', 'NMCN', 'RN 1');
select pg_temp.as_public('race-open-1');
select result from identity.open_staff_invitation('d5970000-0000-4000-8000-000000000001',
  encode(sha256('race-link-1'::bytea), 'hex'), null, null, encode(sha256('race-open-1'::bytea), 'hex'));
select pg_temp.release(1);
select pg_temp.as_public('race-after-release-1');
do $$
declare answer record;
begin
  select * into answer from identity.prepare_staff_invitation_acceptance(encode(sha256('race-open-1'::bytea), 'hex'));
  if answer.result <> 'invalid' then raise exception 'Prepare after a release answered %', answer.result; end if;
  begin
    perform identity.accept_staff_invitation_with_password(encode(sha256('race-open-1'::bytea), 'hex'),
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('c', 22) || '$' || repeat('d', 43));
    raise exception 'An accept after a release was accepted';
  exception when raise_exception then
    if sqlerrm <> 'STAFF_INVITATION_SESSION_INVALID' then raise; end if;
  end;
  select * into answer from identity.open_staff_invitation('d5970000-0000-4000-8000-000000000001',
    encode(sha256('race-link-1'::bytea), 'hex'), null, null, encode(sha256('race-open-1b'::bytea), 'hex'));
  if answer.result <> 'withdrawn' then raise exception 'Open after a release answered %', answer.result; end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from identity.staff_invitations where id = 'd5970000-0000-4000-8000-000000000001'
                  and status = 'revoked' and revoke_kind = 'release' and session_hmac is null)
     or exists (select 1 from auth.accounts where email = 'first@race-people.invalid') then
    raise exception 'A release before the accept left the wrong state';
  end if;
end $$;

-- 2. An accept, then a release.
set local role hid_identity_api_runtime;
select pg_temp.invite(2, 2, 'second@race-people.invalid', 'doctor', 'MDCN', 'MDCN/2');
select pg_temp.as_public('race-accept-2');
select result from identity.open_staff_invitation('d5970000-0000-4000-8000-000000000002',
  encode(sha256('race-link-2'::bytea), 'hex'), null, null, encode(sha256('race-open-2'::bytea), 'hex'));
select result from identity.prepare_staff_invitation_acceptance(encode(sha256('race-open-2'::bytea), 'hex'));
select account_case from identity.accept_staff_invitation_with_password(encode(sha256('race-open-2'::bytea), 'hex'),
  '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('c', 22) || '$' || repeat('d', 43));
reset role;
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
select gen_random_uuid(), account.id, gen_random_uuid(), encode(sha256('race-member-session'::bytea), 'hex'),
  gen_random_uuid(), account.token_version, 'password', clock_timestamp(), clock_timestamp() + interval '1 hour',
  clock_timestamp() + interval '8 hours', 'staff'
  from auth.accounts account where account.email = 'second@race-people.invalid';
set local role hid_identity_api_runtime;
select pg_temp.invite(2, 3, 'third@race-people.invalid', 'receptionist', null, null);
-- 3 (first order): the member's role is changed, then the facility released.
select pg_temp.as_admin(2, 'race-role-before-release');
select role_code from identity.change_facility_staff_role((select listed.membership_id from identity.list_facility_staff() listed
  where not listed.is_self), 1, 'nurse', 'NMCN', 'RN 22', 'facility-staff-attestation-v1', 'Role before the release');
select pg_temp.release(2);
reset role;
do $$ begin
  if exists (select 1 from identity.staff_facility_memberships membership
              join auth.accounts account on account.id = membership.account_id
             where account.email = 'second@race-people.invalid' and membership.active)
     or exists (select 1 from auth.account_roles assignment
                 join auth.accounts account on account.id = assignment.account_id
                where account.email = 'second@race-people.invalid' and assignment.revoked_at is null)
     or exists (select 1 from auth.sessions session_row
                 join auth.accounts account on account.id = session_row.account_id
                where account.email = 'second@race-people.invalid' and session_row.revoked_at is null)
     or not exists (select 1 from identity.staff_invitations where id = 'd5970000-0000-4000-8000-000000000003'
                     and status = 'revoked' and revoke_kind = 'release') then
    raise exception 'A release after the accept left the member''s access';
  end if;
end $$;

-- 3. A role change, then a release (facility 2 is released already; the
-- member's role was changed before it): no unrevoked role on an ended
-- membership anywhere; and a release, then a role change: refused.
do $$ begin
  if exists (select 1 from auth.account_roles assignment
              join identity.staff_facility_memberships membership on membership.id = assignment.membership_id
             where assignment.revoked_at is null and not membership.active
               and membership.organization_id in (select organization_id from identity.organization_applications
                                                    where id in (current_setting('hid.test.r_app_1')::uuid,
                                                      current_setting('hid.test.r_app_2')::uuid))) then
    raise exception 'An ended membership kept an unrevoked role';
  end if;
end $$;
set local role hid_identity_api_runtime;
select pg_temp.as_admin(2, 'race-role-after-release');
do $$ begin
  perform identity.change_facility_staff_role((select listed.membership_id from identity.list_facility_staff() listed
    where not listed.is_self limit 1), 1, 'nurse', 'NMCN', 'RN 2', 'facility-staff-attestation-v1', 'Role after the release');
  raise exception 'A role change ran after the release';
exception when insufficient_privilege then null;
end $$;
reset role;

-- 4. A disable, then a review: refused, nothing granted. A review, then a
-- disable: the account cannot sign in, its grants stand.
set local role hid_identity_api_runtime;
select pg_temp.as_super('race-disable-3');
select account_id from auth.admin_transition_account(current_setting('hid.test.r_account_3')::uuid, 1, 'disabled',
  'Concurrency suite disables before review', 'race-disable-before-review', repeat('c', 64));
do $$ begin
  perform identity.admin_review_self_service_facility(current_setting('hid.test.r_app_3')::uuid,
    (select item.row_version from identity.admin_list_self_service_facilities('all') item
      where item.application_id = current_setting('hid.test.r_app_3')::uuid),
    'Checked the company and its administrator', 'none', 'officer_match', null, null);
  raise exception 'A disabled administrator''s facility was reviewed';
exception when check_violation then
  if sqlerrm <> 'SELF_SERVICE_FACILITY_REVIEW_REQUIRES_ACTIVE' then raise; end if;
end $$;
select account_id from auth.admin_transition_account(current_setting('hid.test.r_account_4')::uuid,
  (select account.row_version from auth.accounts account where account.id = current_setting('hid.test.r_account_4')::uuid),
  'disabled', 'Concurrency suite disables after review', 'race-disable-after-review', repeat('d', 64));
reset role;
do $$ begin
  if exists (select 1 from auth.account_roles where account_id = current_setting('hid.test.r_account_3')::uuid
              and role_code <> 'org_admin_awaiting_review' and revoked_at is null)
     or exists (select 1 from identity.organization_applications where id = current_setting('hid.test.r_app_3')::uuid
                 and self_service_reviewed_at is not null)
     or not exists (select 1 from auth.account_roles where account_id = current_setting('hid.test.r_account_4')::uuid
                     and role_code = 'org_admin' and revoked_at is null)
     or auth.membership_has_permission('org-onboarding:' || current_setting('hid.test.r_account_4'),
          current_setting('hid.test.r_membership_4')::uuid, current_setting('hid.test.r_facility_4')::uuid, 'workforce.manage') then
    raise exception 'The disable and review orders left the wrong state';
  end if;
end $$;

rollback;
