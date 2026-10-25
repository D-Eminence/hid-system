\set ON_ERROR_STOP on
-- Opening and accepting a staff invitation (0086 section 5, P4b). Rollback-
-- only. Public commands run as the exact Identity API runtime role in
-- Identity's accountless system context (system:auth and a correlation ID);
-- the signed-in commands in the account-only context of a staff session.
--
--   1. open, link mode: an unknown id; 10 wrong tokens lock the invitation
--      for its lifetime, the right token then answers 'locked'; five wrong
--      typed codes leave link mode working; typed failures reach every
--      pending invitation of the email, capped, and never touch link mode;
--      an earlier send's token or code answers 'superseded' and counts
--      nothing; expired; withdrawn (revoked, facility suspended,
--      organization released, inviter disabled); accepted;
--   2. every account case, including a held membership and an only
--      membership at a suspended facility ('unavailable'), ended memberships
--      only ('dormant_staff', also pending_reset), and a typed-mode dormant
--      case answering link_required with no session;
--   3. prepare's 5 attempts and its answers;
--   4. accept 'new': every row, the strict hash, license_number never
--      written, the session used once; accept 'dormant_staff': password,
--      token version, every session revoked, the ended membership reused;
--      the email race (an account appears for a 'new' email: a patient
--      account answers PATIENT_ACCOUNT, an account with neither record
--      ACCOUNT_UNAVAILABLE, a staff account ACCOUNT_EXISTS) and a change
--      between open and accept (ACCOUNT_CHANGED); a typed email is matched
--      trimmed and lower-cased;
--   5. signed-in preview and accept: email mismatch, a platform role, an
--      existing member, a second facility non-primary, an ended membership
--      reused, one staff audit row at the inviting facility, none on a
--      refusal;
--   6. the control closes every public and signed-in command (55000).
-- See provider-self-enrollment.integration.sql for why FORCE is lifted on
-- the control table when its owner cannot bypass row-level security.
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
  ('d3000000-0000-4000-8000-000000000001', 'synthetic:accept:super', 'super@accept.invalid', 'Accept Super Admin', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d3010000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
   'Acceptance suite super admin');
-- A governed organization with two facilities (one suspended).
insert into identity.organizations (id, name, slug) values
  ('d3020000-0000-4000-8000-000000000001', 'Accept Governed Org', 'accept-governed-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status, status_reason) values
  ('d3030000-0000-4000-8000-000000000001', 'd3020000-0000-4000-8000-000000000001', 'Accept Governed Facility',
   'ACCEPT-GOVERNED', 'Africa/Lagos', true, 'verified', null),
  ('d3030000-0000-4000-8000-000000000002', 'd3020000-0000-4000-8000-000000000001', 'Accept Suspended Facility',
   'ACCEPT-SUSPENDED', 'Africa/Lagos', false, 'suspended', 'Suspended while support investigates');

-- People, by account case, each with the email the facilities invite.
--   11 patient, 12 platform role, 13 inactive staff, 14 unverified staff,
--   15 disabled, 16 locked, 17 suspended until later, 18 a staff row whose
--   account has another email, 19 an account with no patient or staff row,
--   20 existing staff (active governed membership), 21 held membership,
--   22 only membership at the suspended facility, 23 dormant (ended),
--   24 dormant pending_reset, 25 dormant at facility 1 (receptionist).
insert into auth.accounts (id, subject, email, display_name, status, disabled_until, password_hash, password_algorithm)
select ('d3000000-0000-4000-8000-0000000000' || n)::uuid, 'synthetic:accept:person-' || n,
  case n when 18 then 'other-address@accept-people.invalid' else 'person' || n || '@accept-people.invalid' end,
  'Person ' || chr(64 + n - 10), case n when 15 then 'disabled' when 16 then 'locked' when 24 then 'pending_reset'
    else 'active' end,
  case when n = 17 then clock_timestamp() + interval '2 days' end,
  '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('o', 22) || '$' || repeat('l', 43), 'argon2id'
  from generate_series(11, 25) n;
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('d3060000-0000-4000-8000-000000000011', 'd3000000-0000-4000-8000-000000000011', 'HID-ACCPTPAT', 'Person', 'A',
   'Person A', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active)
select ('d3040000-0000-4000-8000-0000000000' || n)::uuid, ('d3000000-0000-4000-8000-0000000000' || n)::uuid,
  'Person ' || chr(64 + n - 10), case n when 18 then 'person18@accept-people.invalid'
    else 'person' || n || '@accept-people.invalid' end,
  case n when 14 then 'pending' else 'verified' end, 'doctor', n <> 13
  from generate_series(12, 25) n where n <> 19;
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d3010000-0000-4000-8000-000000000012', 'd3000000-0000-4000-8000-000000000012', 'support_admin', 'platform',
   'Acceptance suite support person');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active,
   migration_hold_reason)
select ('d3050000-0000-4000-8000-0000000000' || n)::uuid, ('d3040000-0000-4000-8000-0000000000' || n)::uuid,
  ('d3000000-0000-4000-8000-0000000000' || n)::uuid, 'd3020000-0000-4000-8000-000000000001',
  case n when 22 then 'd3030000-0000-4000-8000-000000000002'::uuid else 'd3030000-0000-4000-8000-000000000001'::uuid end,
  'doctor', 'doctor', true, n in (12, 20, 21, 22), case when n = 21 then 'Held during a migration' end
  from generate_series(12, 24) n where n not in (13, 14, 15, 16, 17, 18, 19);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('d3010000-0000-4000-8000-0000000001' || n)::uuid, ('d3000000-0000-4000-8000-0000000000' || n)::uuid, 'doctor',
  'facility', ('d3050000-0000-4000-8000-0000000000' || n)::uuid,
  case n when 22 then 'd3030000-0000-4000-8000-000000000002'::uuid else 'd3030000-0000-4000-8000-000000000001'::uuid end,
  'Acceptance suite governed doctor'
  from generate_series(12, 22) n where n in (12, 20, 21, 22);
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
select gen_random_uuid(), ('d3000000-0000-4000-8000-0000000000' || n)::uuid, gen_random_uuid(),
  encode(sha256(('accept-refresh-' || n)::bytea), 'hex'), gen_random_uuid(), 1, 'password', clock_timestamp(),
  clock_timestamp() + interval '1 hour', clock_timestamp() + interval '8 hours', 'staff'
  from generate_series(20, 25) n;

-- Sign-ups: 1 hospital and 2 laboratory, both reviewed ('none'), their first
-- 30 days ended (more invitations than 10 a day here).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:accept:super', true),
  set_config('app.correlation_id', 'accept-open-controls', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'), 'Acceptance suite opens facility sign-up');
select platform.admin_set_control('staff_invitations_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'staff_invitations_enabled'), 'Acceptance suite opens staff invitations');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'accept-signup-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  signup record;
  application_id uuid;
  current_application record;
  activated record;
begin
  for signup in select * from (values
      (1, 'ehr', 'hospital', 'RC9930003001', 'Ada Accept Admin', 'ada@accept-hospital.invalid', 'Ada Accept Hospital Ltd'),
      (2, 'laboratory', 'laboratory', 'RC9930003002', 'Bola Accept Admin', 'bola@accept-lab.invalid', 'Bola Accept Laboratory Ltd')
    ) as rows(n, product, kind, cac, admin_name, admin_email, legal_name) order by n loop
    application_id := identity.submit_self_service_organization_application(signup.product, signup.kind,
      signup.cac, signup.admin_name, signup.admin_email);
    select * into current_application from identity.public_get_organization_application(
      signup.cac, signup.admin_email, signup.product);
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
      'verified', '9930' || signup.n, signup.cac, signup.legal_name, 'Private Company Limited by Shares',
      '2018-06-0' || signup.n, signup.n || ' Acceptance Suite Road, Lagos', 'active');
    perform identity.begin_self_service_provider_enrollment(signup.cac, signup.admin_email, signup.product,
      ('d3900000-0000-4000-8000-00000000000' || signup.n)::uuid,
      encode(sha256(('accept-otp-' || signup.n)::bytea), 'hex'), signup.admin_name, signup.kind);
    perform identity.verify_organization_profile_completion_challenge(
      ('d3900000-0000-4000-8000-00000000000' || signup.n)::uuid, encode(sha256(('accept-otp-' || signup.n)::bytea), 'hex'),
      encode(sha256(('accept-session-' || signup.n)::bytea), 'hex'));
    select * into activated from identity.activate_self_service_provider_enrollment(
      encode(sha256(('accept-session-' || signup.n)::bytea), 'hex'),
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    perform set_config('hid.test.a_app_' || signup.n, application_id::text, true);
    perform set_config('hid.test.a_facility_' || signup.n, activated.facility_id::text, true);
    perform set_config('hid.test.a_account_' || signup.n, activated.account_id::text, true);
    perform set_config('hid.test.a_org_' || signup.n, activated.organization_id::text, true);
  end loop;
end $$;
select set_config('app.actor_subject', 'synthetic:accept:super', true),
  set_config('app.correlation_id', 'accept-review-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare n integer; listed record; reviewed record;
begin
  foreach n in array array[1, 2] loop
    select * into listed from identity.admin_list_self_service_facilities('unreviewed') item
     where item.application_id = current_setting('hid.test.a_app_' || n)::uuid;
    select * into reviewed from identity.admin_review_self_service_facility(listed.application_id, listed.row_version,
      'Checked the company and its administrator', 'none', 'cac_registered_contact', null, null);
    perform identity.admin_end_self_service_probation(listed.application_id, reviewed.row_version,
      'Acceptance suite needs the normal limits');
  end loop;
end $$;
reset role;
select set_config('hid.test.a_membership_' || n,
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.a_account_' || n)::uuid), true)
  from generate_series(1, 2) n;
-- Person 25 once worked at facility 1 as a receptionist (an ended membership).
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values ('d3050000-0000-4000-8000-000000000025', 'd3040000-0000-4000-8000-000000000025',
  'd3000000-0000-4000-8000-000000000025', current_setting('hid.test.a_org_1')::uuid,
  current_setting('hid.test.a_facility_1')::uuid, 'receptionist', 'receptionist', true, false);

create function pg_temp.as_admin(n integer, correlation text) returns void language sql as $f$
  select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.a_account_' || n), true),
    set_config('app.membership_id', current_setting('hid.test.a_membership_' || n), true),
    set_config('app.facility_id', current_setting('hid.test.a_facility_' || n), true),
    set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$f$;
create function pg_temp.as_public(correlation text) returns void language sql as $f$
  select set_config('app.actor_subject', 'system:auth', true), set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true), set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', '', true);
$f$;
create function pg_temp.as_person(n integer, correlation text) returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:accept:person-' || n, true), set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true), set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$f$;
create function pg_temp.hmac(label text) returns char(64) language sql as $f$
  select encode(sha256(('accept-' || label)::bytea), 'hex')::char(64)
$f$;
create function pg_temp.invite(n integer, k integer, invitee_email text, role_code text default 'receptionist',
  licence_body text default null, licence_number text default null, invitee_name text default 'Invited Person')
returns uuid language sql as $f$
  select created.invitation_id from identity.create_staff_invitation(
    ('d3970000-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid, ('d3960000-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid,
    invitee_name, invitee_email, role_code, licence_body, licence_number, 'facility-staff-attestation-v1',
    'accept-suite-key-' || lpad(k::text, 6, '0'), pg_temp.hmac('request-' || k), pg_temp.hmac('link-' || k),
    pg_temp.hmac('code-' || k || '-' || invitee_email), 'v1') created
$f$;
create function pg_temp.open_link(k integer, token text, session_label text) returns record language sql as $f$
  select opened from identity.open_staff_invitation(('d3970000-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid,
    pg_temp.hmac(token), null, null, pg_temp.hmac(session_label)) opened
$f$;
create function pg_temp.open_code(invitee_email text, code_label text, session_label text) returns record language sql as $f$
  select opened from identity.open_staff_invitation(null, null, invitee_email, pg_temp.hmac(code_label),
    pg_temp.hmac(session_label)) opened
$f$;
create function pg_temp.result_of(opened record) returns text language plpgsql as $f$
begin return opened.result; end $f$;
grant execute on function pg_temp.as_admin(integer,text), pg_temp.as_public(text), pg_temp.as_person(integer,text),
  pg_temp.hmac(text), pg_temp.invite(integer,integer,text,text,text,text,text), pg_temp.open_link(integer,text,text),
  pg_temp.open_code(text,text,text), pg_temp.result_of(record) to hid_identity_api_runtime;

-- Invitations: facility 1 invites people 11-25 (k = n) and a few more; facility
-- 2 invites person 23 too (k = 123).
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'accept-invite-1');
select pg_temp.invite(1, n, 'person' || n || '@accept-people.invalid') from generate_series(11, 25) n;
select pg_temp.invite(1, 30, 'locked.out@accept-people.invalid');
select pg_temp.invite(1, 31, 'typed.tries@accept-people.invalid');
select pg_temp.invite(1, 32, 'new.doctor@accept-people.invalid', 'doctor', 'MDCN', 'mdcn 32/32', 'Nkechi Okafor');
select pg_temp.invite(1, 33, 'race@accept-people.invalid');
select pg_temp.invite(1, 34, 'withdrawn@accept-people.invalid');
select pg_temp.invite(1, 35, 'superseded@accept-people.invalid');
select pg_temp.invite(1, 36, 'expired@accept-people.invalid');
select pg_temp.as_admin(2, 'accept-invite-2');
select pg_temp.invite(2, 123, 'person23@accept-people.invalid', 'lab', 'MLSCN', 'ML 23');
select pg_temp.invite(2, 131, 'typed.tries@accept-people.invalid');
reset role;

-- 1. Open: link failures, typed failures, superseded, expired, withdrawn.
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-open-0001');
do $$
declare
  opened record;
  attempt integer;
begin
  -- An unknown invitation id.
  select * into opened from identity.open_staff_invitation('d3970000-0000-4000-8000-0000000009ff', pg_temp.hmac('link-30'),
    null, null, pg_temp.hmac('session-unknown')) as result;
  if opened.result <> 'invalid' or opened.facility_name is not null then
    raise exception 'An unknown invitation answered %', row_to_json(opened);
  end if;
  for attempt in 1..10 loop
    select * into opened from identity.open_staff_invitation('d3970000-0000-4000-8000-000000000030',
      pg_temp.hmac('wrong-link-' || attempt), null, null, pg_temp.hmac('session-30')) as result;
    if opened.result <> 'invalid' then
      raise exception 'Wrong link token % answered %', attempt, opened.result;
    end if;
  end loop;
  select * into opened from identity.open_staff_invitation('d3970000-0000-4000-8000-000000000030', pg_temp.hmac('link-30'),
    null, null, pg_temp.hmac('session-30')) as result;
  if opened.result <> 'locked' or opened.facility_name <> 'Ada Accept Hospital Ltd' then
    raise exception 'The right token after 10 failures answered %', row_to_json(opened);
  end if;
  -- Typed mode: five wrong codes for typed.tries (invited by both facilities);
  -- both invitations count them; then the right code no longer matches, but
  -- link mode still works.
  for attempt in 1..6 loop
    select * into opened from identity.open_staff_invitation(null, null, 'typed.tries@accept-people.invalid',
      pg_temp.hmac('wrong-code-' || attempt), pg_temp.hmac('session-31')) as result;
    if opened.result <> 'invalid' then
      raise exception 'Wrong typed code % answered %', attempt, opened.result;
    end if;
  end loop;
  select * into opened from identity.open_staff_invitation(null, null, ' Typed.Tries@accept-people.invalid ',
    pg_temp.hmac('code-31-typed.tries@accept-people.invalid'), pg_temp.hmac('session-31')) as result;
  if opened.result <> 'invalid' then
    raise exception 'The right code after 5 typed failures answered %', opened.result;
  end if;
  -- An email with no invitation runs the same statement and answers the same.
  select * into opened from identity.open_staff_invitation(null, null, 'nobody@accept-people.invalid',
    pg_temp.hmac('wrong-code-1'), pg_temp.hmac('session-nobody')) as result;
  if opened.result <> 'invalid' then
    raise exception 'An uninvited email answered %', opened.result;
  end if;
  select * into opened from identity.open_staff_invitation('d3970000-0000-4000-8000-000000000031', pg_temp.hmac('link-31'),
    null, null, pg_temp.hmac('session-31')) as result;
  if opened.result <> 'ready' or opened.account_case <> 'new' or opened.session_expires_at is null
     or opened.link_required then
    raise exception 'Link mode after 5 typed failures answered %', row_to_json(opened);
  end if;
end $$;
reset role;
do $$ begin
  if (select failed_link_attempts from identity.staff_invitations where id = 'd3970000-0000-4000-8000-000000000030') <> 10
     or (select array_agg(failed_typed_attempts order by id) from identity.staff_invitations
          where invitee_email = 'typed.tries@accept-people.invalid') <> array[5, 5]
     or (select failed_link_attempts from identity.staff_invitations where id = 'd3970000-0000-4000-8000-000000000031') <> 0
     or exists (select 1 from identity.staff_invitations where id = 'd3970000-0000-4000-8000-000000000030'
                 and session_hmac is not null) then
    raise exception 'The open counters are wrong';
  end if;
end $$;
-- Superseded: facility 1 resends invitation 35; the old token and old code
-- answer 'superseded' and count nothing; the new ones work.
update identity.staff_invitations set last_sent_at = clock_timestamp() - interval '2 minutes'
 where id = 'd3970000-0000-4000-8000-000000000035';
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'accept-resend-35');
select * from identity.resend_staff_invitation('d3970000-0000-4000-8000-000000000035', 1,
  'd3960000-0000-4000-8000-000000000135', pg_temp.hmac('link-35-new'),
  pg_temp.hmac('code-35-new-superseded@accept-people.invalid'), 'v1');
select pg_temp.as_public('accept-open-0002');
do $$
declare opened record;
begin
  select * into opened from identity.open_staff_invitation('d3970000-0000-4000-8000-000000000035', pg_temp.hmac('link-35'),
    null, null, pg_temp.hmac('session-35')) as result;
  if opened.result <> 'superseded' then raise exception 'An old link answered %', opened.result; end if;
  select * into opened from identity.open_staff_invitation(null, null, 'superseded@accept-people.invalid',
    pg_temp.hmac('code-35-superseded@accept-people.invalid'), pg_temp.hmac('session-35')) as result;
  if opened.result <> 'superseded' then raise exception 'An old code answered %', opened.result; end if;
  -- The typed email is matched trimmed and lower-cased by the database.
  select * into opened from identity.open_staff_invitation(null, null, '  SuperSeded@Accept-People.invalid ',
    pg_temp.hmac('code-35-new-superseded@accept-people.invalid'), pg_temp.hmac('session-35')) as result;
  if opened.result <> 'ready' or opened.account_case <> 'new' or opened.link_required then
    raise exception 'The new code answered %', row_to_json(opened);
  end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.staff_invitations where id = 'd3970000-0000-4000-8000-000000000035'
              and (failed_link_attempts <> 0 or failed_typed_attempts <> 0)) then
    raise exception 'A superseded token or code was counted';
  end if;
end $$;
-- Expired and withdrawn.
update identity.staff_invitations set expires_at = clock_timestamp() - interval '1 minute'
 where id = 'd3970000-0000-4000-8000-000000000036';
set local role hid_identity_api_runtime;
select pg_temp.as_admin(1, 'accept-revoke-34');
select * from identity.revoke_staff_invitation('d3970000-0000-4000-8000-000000000034', 1);
select pg_temp.as_public('accept-open-0003');
do $$
declare opened record;
begin
  select * into opened from identity.open_staff_invitation('d3970000-0000-4000-8000-000000000036', pg_temp.hmac('link-36'),
    null, null, pg_temp.hmac('session-36')) as result;
  if opened.result <> 'expired' then raise exception 'An expired invitation answered %', opened.result; end if;
  select * into opened from identity.open_staff_invitation('d3970000-0000-4000-8000-000000000034', pg_temp.hmac('link-34'),
    null, null, pg_temp.hmac('session-34')) as result;
  if opened.result <> 'withdrawn' then raise exception 'A revoked invitation answered %', opened.result; end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from identity.staff_invitations where id = 'd3970000-0000-4000-8000-000000000036'
                  and status = 'expired' and expired_at is not null) then
    raise exception 'Opening an expired invitation did not mark it expired';
  end if;
end $$;
-- Withdrawn when the facility is suspended, the inviter disabled, or the
-- organization no longer reviewed (each undone after its check, by owner SQL).
update identity.facilities set active = false, lifecycle_status = 'suspended', status_reason = 'Suspended for the check'
 where id = current_setting('hid.test.a_facility_2')::uuid;
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-open-0004');
do $$ begin
  if pg_temp.result_of(pg_temp.open_link(123, 'link-123', 'session-123')) <> 'withdrawn' then
    raise exception 'An invitation of a suspended facility was not withdrawn';
  end if;
end $$;
reset role;
update identity.facilities set active = true, lifecycle_status = 'verified', status_reason = null
 where id = current_setting('hid.test.a_facility_2')::uuid;
update auth.accounts set status = 'disabled' where id = current_setting('hid.test.a_account_2')::uuid;
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-open-0005');
do $$ begin
  if pg_temp.result_of(pg_temp.open_link(123, 'link-123', 'session-123')) <> 'withdrawn' then
    raise exception 'An invitation of a disabled inviter was not withdrawn';
  end if;
end $$;
reset role;
update auth.accounts set status = 'active' where id = current_setting('hid.test.a_account_2')::uuid;
update identity.organization_applications set self_service_reviewed_at = null, self_service_reviewed_by_account_id = null,
  self_service_review_note = null, self_service_granted_role = null, self_service_verification_method = null,
  self_service_probation_ended_at = null, self_service_probation_ended_by_account_id = null,
  self_service_probation_end_reason = null
 where id = current_setting('hid.test.a_app_2')::uuid;
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-open-0006');
do $$ begin
  if pg_temp.result_of(pg_temp.open_link(123, 'link-123', 'session-123')) <> 'withdrawn' then
    raise exception 'An invitation of an organization no longer reviewed was not withdrawn';
  end if;
end $$;
reset role;
update identity.organization_applications set self_service_reviewed_at = clock_timestamp() - interval '1 day',
  self_service_reviewed_by_account_id = 'd3000000-0000-4000-8000-000000000001',
  self_service_review_note = 'Checked the company and its administrator', self_service_granted_role = 'none',
  self_service_verification_method = 'cac_registered_contact'
 where id = current_setting('hid.test.a_app_2')::uuid;

-- 2. Account cases (link mode), and typed mode for a dormant account.
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-open-cases');
do $$
declare
  expected record;
  opened record;
begin
  for expected in select * from (values
      (11, 'patient_account'), (12, 'unavailable'), (13, 'unavailable'), (14, 'unavailable'), (15, 'unavailable'),
      (16, 'unavailable'), (17, 'unavailable'), (18, 'unavailable'), (19, 'unavailable'), (20, 'existing_staff'),
      (21, 'unavailable'), (22, 'unavailable'), (23, 'dormant_staff'), (24, 'dormant_staff'), (25, 'dormant_staff'),
      (32, 'new')
    ) as rows(n, account_case) order by n loop
    select * into opened from identity.open_staff_invitation(('d3970000-0000-4000-8000-' || lpad(expected.n::text, 12, '0'))::uuid,
      pg_temp.hmac('link-' || expected.n), null, null, pg_temp.hmac('session-' || expected.n)) as result;
    if opened.result <> 'ready' or opened.account_case <> expected.account_case
       or (opened.session_expires_at is not null) <> (expected.account_case in ('new', 'dormant_staff'))
       or opened.link_required or opened.facility_name <> 'Ada Accept Hospital Ltd'
       or opened.inviter_name <> 'Ada Accept Admin' or opened.role_code is null then
      raise exception 'Person % answered % instead of %', expected.n, row_to_json(opened), expected.account_case;
    end if;
  end loop;
  -- An existing member of the inviting facility.
  select * into opened from identity.open_staff_invitation(null, null, 'person23@accept-people.invalid',
    pg_temp.hmac('code-23-person23@accept-people.invalid'), pg_temp.hmac('session-23-typed')) as result;
  if opened.result <> 'ready' or opened.account_case <> 'dormant_staff' or not opened.link_required
     or opened.session_expires_at is not null then
    raise exception 'Typed mode for a dormant account answered %', row_to_json(opened);
  end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from identity.staff_invitations where session_hmac is not null
       and id in (select ('d3970000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(11, 25) n))
     <> 3
     or not exists (select 1 from identity.staff_invitations where id = 'd3970000-0000-4000-8000-000000000023'
                     and session_hmac = encode(sha256('accept-session-23'::bytea), 'hex')
                     and session_account_case = 'dormant_staff'
                     and session_account_id = 'd3000000-0000-4000-8000-000000000023'
                     and session_account_row_version = 1 and session_account_token_version = 1)
     or (select count(*) from audit.events where action = 'identity.staff-invitation.open'
          and correlation_id = 'accept-open-cases') <> 17
     or exists (select 1 from audit.events where action = 'identity.staff-invitation.open'
                 and (details <> jsonb_build_object('invitationId', resource_id) or actor_type <> 'system'
                   or facility_id is null)) then
    raise exception 'The open sessions or their audit rows are wrong';
  end if;
end $$;
-- An already member.
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values ('d3050000-0000-4000-8000-000000000120', 'd3040000-0000-4000-8000-000000000020',
  'd3000000-0000-4000-8000-000000000020', current_setting('hid.test.a_org_2')::uuid,
  current_setting('hid.test.a_facility_2')::uuid, 'lab', 'lab', false, true);
set local role hid_identity_api_runtime;
select pg_temp.as_admin(2, 'accept-invite-member');
do $$ begin
  perform pg_temp.invite(2, 120, 'person20@accept-people.invalid');
  raise exception 'A member was invited';
exception when raise_exception then
  if sqlerrm <> 'STAFF_INVITATION_ALREADY_MEMBER' then raise; end if;
end $$;
reset role;
-- The account case function directly: already_member.
do $$ begin
  if (select account_case from identity.staff_invitation_account_case('person20@accept-people.invalid',
       current_setting('hid.test.a_facility_2')::uuid)) <> 'already_member' then
    raise exception 'An active member is not already_member';
  end if;
end $$;

-- 3. Prepare: 5 attempts, then the session ends.
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-prepare');
do $$
declare prepared record; attempt integer;
begin
  for attempt in 1..5 loop
    select * into prepared from identity.prepare_staff_invitation_acceptance(pg_temp.hmac('session-31'));
    if prepared.result <> 'ready' or prepared.account_case <> 'new' then
      raise exception 'Prepare % answered %', attempt, row_to_json(prepared);
    end if;
  end loop;
  select * into prepared from identity.prepare_staff_invitation_acceptance(pg_temp.hmac('session-31'));
  if prepared.result <> 'invalid' then raise exception 'A sixth prepare answered %', prepared.result; end if;
  select * into prepared from identity.prepare_staff_invitation_acceptance(pg_temp.hmac('session-31'));
  if prepared.result <> 'invalid' then raise exception 'An ended session answered %', prepared.result; end if;
  select * into prepared from identity.prepare_staff_invitation_acceptance(pg_temp.hmac('no-such-session'));
  if prepared.result <> 'invalid' then raise exception 'An unknown session answered %', prepared.result; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.staff_invitations where id = 'd3970000-0000-4000-8000-000000000031'
              and session_hmac is not null) then
    raise exception 'The session survived its sixth prepare';
  end if;
end $$;

-- 4. Accept 'new' (a doctor with a licence).
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-new-0001');
do $$
declare prepared record; accepted record;
begin
  select * into prepared from identity.prepare_staff_invitation_acceptance(pg_temp.hmac('session-32'));
  if prepared.result <> 'ready' or prepared.account_case <> 'new' then
    raise exception 'Prepare for the new doctor answered %', row_to_json(prepared);
  end if;
  begin
    perform identity.accept_staff_invitation_with_password(pg_temp.hmac('session-32'), '$2b$10$' || repeat('x', 53));
    raise exception 'A bcrypt hash was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.accept_staff_invitation_with_password(pg_temp.hmac('session-32'),
      '$argon2id$v=19$m=19456,t=2,p=1$' || repeat('x', 22) || '$' || repeat('y', 43));
    raise exception 'A weak argon2id hash was accepted';
  exception when invalid_parameter_value then null;
  end;
  select * into accepted from identity.accept_staff_invitation_with_password(pg_temp.hmac('session-32'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('n', 22) || '$' || repeat('d', 43));
  if accepted.account_case <> 'new' or accepted.role_code <> 'doctor' or accepted.facility_name <> 'Ada Accept Hospital Ltd'
     or accepted.facility_id <> current_setting('hid.test.a_facility_1')::uuid
     or accepted.organization_id <> current_setting('hid.test.a_org_1')::uuid then
    raise exception 'Accepting the new doctor answered %', row_to_json(accepted);
  end if;
  perform set_config('hid.test.new_account', accepted.account_id::text, true);
  perform set_config('hid.test.new_membership', accepted.membership_id::text, true);
  begin
    perform identity.accept_staff_invitation_with_password(pg_temp.hmac('session-32'),
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('n', 22) || '$' || repeat('d', 43));
    raise exception 'A session was used twice';
  exception when raise_exception then
    if sqlerrm <> 'STAFF_INVITATION_SESSION_INVALID' then raise; end if;
  end;
  if pg_temp.result_of(pg_temp.open_link(32, 'link-32', 'session-32-again')) <> 'accepted' then
    raise exception 'An accepted invitation did not answer accepted';
  end if;
end $$;
reset role;
do $$
declare
  account auth.accounts%rowtype;
  staff identity.staff%rowtype;
  membership identity.staff_facility_memberships%rowtype;
  role_row auth.account_roles%rowtype;
  attestation identity.staff_licence_attestations%rowtype;
  invitation identity.staff_invitations%rowtype;
  event audit.events%rowtype;
begin
  select * into account from auth.accounts where id = current_setting('hid.test.new_account')::uuid;
  select * into staff from identity.staff where account_id = account.id;
  select * into membership from identity.staff_facility_memberships where id = current_setting('hid.test.new_membership')::uuid;
  select * into role_row from auth.account_roles where membership_id = membership.id;
  select * into attestation from identity.staff_licence_attestations where membership_id = membership.id;
  select * into invitation from identity.staff_invitations where id = 'd3970000-0000-4000-8000-000000000032';
  select * into event from audit.events where action = 'identity.staff-invitation.accept' and resource_id = invitation.id::text;
  if account.subject <> 'staff-invitation:' || account.id or account.email <> 'new.doctor@accept-people.invalid'
     or account.display_name <> 'Nkechi Okafor' or account.password_algorithm <> 'argon2id'
     or account.password_hash not like '$argon2id$v=19$m=65536,t=3,p=1$%' or account.status <> 'active'
     or account.password_changed_at is null or account.email_verified_at is null then
    raise exception 'The new account is wrong: %', row_to_json(account);
  end if;
  if staff.full_name <> 'Nkechi Okafor' or staff.email <> account.email or staff.verification_status <> 'verified'
     or staff.default_role <> 'doctor' or not staff.active or staff.license_number is not null then
    raise exception 'The new staff record is wrong: %', row_to_json(staff);
  end if;
  if membership.membership_role <> 'doctor' or membership.app_role <> 'doctor' or not membership.is_primary
     or not membership.active or membership.facility_id <> current_setting('hid.test.a_facility_1')::uuid then
    raise exception 'The new membership is wrong: %', row_to_json(membership);
  end if;
  if role_row.role_code <> 'doctor' or role_row.granted_by <> current_setting('hid.test.a_account_1')::uuid
     or role_row.grant_reason <> 'Staff invitation accepted; licence vouched by the facility administrator'
     or role_row.revoked_at is not null then
    raise exception 'The new role row is wrong: %', row_to_json(role_row);
  end if;
  if attestation.verification_method <> 'facility_attestation' or attestation.licence_body <> 'MDCN'
     or attestation.licence_number <> 'MDCN 32/32' or attestation.licence_key <> 'MDCN:3232'
     or attestation.attested_person_name <> 'Nkechi Okafor' or attestation.role_grant_id <> role_row.id
     or attestation.attested_by_account_id <> current_setting('hid.test.a_account_1')::uuid
     or attestation.attested_by_membership_id <> current_setting('hid.test.a_membership_1')::uuid
     or attestation.attested_at <> invitation.attested_at or attestation.invitation_id <> invitation.id
     or attestation.attestation_version <> 'facility-staff-attestation-v1' then
    raise exception 'The attestation is wrong: %', row_to_json(attestation);
  end if;
  if invitation.status <> 'accepted' or invitation.accepted_account_id <> account.id
     or invitation.accepted_membership_id <> membership.id or invitation.accepted_account_case <> 'new'
     or invitation.session_hmac is not null then
    raise exception 'The accepted invitation is wrong: %', row_to_json(invitation);
  end if;
  if event.actor_type <> 'system' or event.facility_id <> membership.facility_id
     or event.organization_id <> membership.organization_id
     or event.details <> jsonb_build_object('invitationId', invitation.id, 'roleCode', 'doctor', 'licenceBody', 'MDCN') then
    raise exception 'The accept audit row is wrong: %', row_to_json(event);
  end if;
  if not auth.membership_has_permission(account.subject, membership.id, membership.facility_id, 'identity.break-glass.write')
     or auth.membership_has_permission(account.subject, membership.id, membership.facility_id, 'workforce.manage') then
    raise exception 'The new doctor''s permissions are wrong';
  end if;
end $$;

-- Accept 'dormant_staff' (person 25, who once worked at facility 1).
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-dormant-0001');
do $$
declare prepared record; accepted record;
begin
  select * into prepared from identity.prepare_staff_invitation_acceptance(pg_temp.hmac('session-25'));
  if prepared.result <> 'ready' or prepared.account_case <> 'dormant_staff' then
    raise exception 'Prepare for the dormant person answered %', row_to_json(prepared);
  end if;
  select * into accepted from identity.accept_staff_invitation_with_password(pg_temp.hmac('session-25'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('r', 22) || '$' || repeat('s', 43));
  if accepted.account_case <> 'dormant_staff' or accepted.account_id <> 'd3000000-0000-4000-8000-000000000025'
     or accepted.membership_id <> 'd3050000-0000-4000-8000-000000000025' then
    raise exception 'Accepting the dormant person answered %', row_to_json(accepted);
  end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from auth.accounts where id = 'd3000000-0000-4000-8000-000000000025'
                  and status = 'active' and token_version = 2 and row_version = 2
                  and password_hash like '$argon2id$v=19$m=65536,t=3,p=1$rrr%' and password_changed_at is not null)
     or exists (select 1 from auth.sessions where account_id = 'd3000000-0000-4000-8000-000000000025' and revoked_at is null)
     or not exists (select 1 from auth.sessions where account_id = 'd3000000-0000-4000-8000-000000000025'
                     and revocation_reason = 'password_set_by_staff_invitation')
     or (select count(*) from identity.staff_facility_memberships where account_id = 'd3000000-0000-4000-8000-000000000025') <> 1
     or not exists (select 1 from identity.staff_facility_memberships where id = 'd3050000-0000-4000-8000-000000000025'
                     and active and membership_role = 'receptionist' and is_primary and row_version = 2) then
    raise exception 'The dormant acceptance left the wrong state';
  end if;
end $$;

-- The email race: an account appears for a 'new' email between open and
-- accept (here, a patient enrollment by owner SQL): the acceptance answers
-- that the email belongs to a patient account; then, with the patient record
-- gone, an account with neither a staff nor a patient record is unavailable.
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-race-0001');
select pg_temp.result_of(pg_temp.open_link(33, 'link-33', 'session-33'));
reset role;
insert into auth.accounts (id, subject, email, display_name, status)
values ('d3000000-0000-4000-8000-000000000033', 'synthetic:accept:race', 'race@accept-people.invalid', 'Race Person', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('d3060000-0000-4000-8000-000000000033', 'd3000000-0000-4000-8000-000000000033', 'HID-ACCPTRCE', 'Race', 'Person',
   'Race Person', 'active');
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-race-0002');
do $$ begin
  perform identity.accept_staff_invitation_with_password(pg_temp.hmac('session-33'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('n', 22) || '$' || repeat('d', 43));
  raise exception 'A new email that gained a patient account was accepted';
exception when raise_exception then
  if sqlerrm <> 'STAFF_INVITATION_PATIENT_ACCOUNT' then raise; end if;
end $$;
reset role;
delete from identity.patients where id = 'd3060000-0000-4000-8000-000000000033';
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-race-0002b');
do $$ begin
  perform identity.accept_staff_invitation_with_password(pg_temp.hmac('session-33'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('n', 22) || '$' || repeat('d', 43));
  raise exception 'A new email that gained an account was accepted';
exception when raise_exception then
  if sqlerrm <> 'STAFF_INVITATION_ACCOUNT_UNAVAILABLE' then raise; end if;
end $$;
reset role;
-- The account becomes a staff member elsewhere: the case is then
-- existing_staff, and a 'new' session answers ACCOUNT_EXISTS.
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
values ('d3040000-0000-4000-8000-000000000033', 'd3000000-0000-4000-8000-000000000033', 'Race Person',
  'race@accept-people.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values ('d3050000-0000-4000-8000-000000000033', 'd3040000-0000-4000-8000-000000000033',
  'd3000000-0000-4000-8000-000000000033', 'd3020000-0000-4000-8000-000000000001',
  'd3030000-0000-4000-8000-000000000001', 'doctor', 'doctor', true, true);
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-race-0003');
do $$ begin
  perform identity.accept_staff_invitation_with_password(pg_temp.hmac('session-33'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('n', 22) || '$' || repeat('d', 43));
  raise exception 'A new email that gained a staff account was accepted';
exception when raise_exception then
  if sqlerrm <> 'STAFF_INVITATION_ACCOUNT_EXISTS' then raise; end if;
end $$;
do $$
declare prepared record;
begin
  select * into prepared from identity.prepare_staff_invitation_acceptance(pg_temp.hmac('session-33'));
  if prepared.result <> 'account_exists' then
    raise exception 'Prepare after the race answered %', prepared.result;
  end if;
end $$;
reset role;
-- The account changes between open and accept (dormant person 24's token version).
update auth.accounts set token_version = token_version + 1 where id = 'd3000000-0000-4000-8000-000000000024';
set local role hid_identity_api_runtime;
select pg_temp.as_public('accept-changed-0001');
do $$ begin
  perform identity.accept_staff_invitation_with_password(pg_temp.hmac('session-24'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('n', 22) || '$' || repeat('d', 43));
  raise exception 'An account changed since the open was accepted';
exception when raise_exception then
  if sqlerrm <> 'STAFF_INVITATION_ACCOUNT_CHANGED' then raise; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from identity.staff_facility_memberships where account_id = 'd3000000-0000-4000-8000-000000000024'
              and facility_id = current_setting('hid.test.a_facility_1')::uuid)
     or (select token_version from auth.accounts where id = 'd3000000-0000-4000-8000-000000000024') <> 2 then
    raise exception 'A refused acceptance wrote something';
  end if;
end $$;

-- 5. Signed in on their own host: person 20 (existing staff at the governed
-- facility) accepts facility 1's invitation; person 23 (dormant) is invited
-- by facility 2 but signs in as nobody here; person 12 holds a platform role.
set local role hid_identity_api_runtime;
do $$
declare
  previewed record;
  accepted record;
begin
  -- Email mismatch (link mode): person 20 opens person 23's link.
  perform pg_temp.as_person(20, 'accept-signed-in-0001');
  select * into previewed from identity.preview_staff_invitation_for_account('d3970000-0000-4000-8000-000000000123',
    pg_temp.hmac('link-123'), null);
  if previewed.result <> 'email_mismatch' then raise exception 'A mismatched email answered %', previewed.result; end if;
  -- A platform role: unavailable.
  perform pg_temp.as_person(12, 'accept-signed-in-0002');
  select * into previewed from identity.preview_staff_invitation_for_account('d3970000-0000-4000-8000-000000000012',
    pg_temp.hmac('link-12'), null);
  if previewed.result <> 'unavailable' then raise exception 'A platform account answered %', previewed.result; end if;
  -- Wrong token, then the right one; typed mode with the account's own email.
  perform pg_temp.as_person(20, 'accept-signed-in-0003');
  select * into previewed from identity.preview_staff_invitation_for_account('d3970000-0000-4000-8000-000000000020',
    pg_temp.hmac('wrong-link'), null);
  if previewed.result <> 'invalid' then raise exception 'A wrong signed-in token answered %', previewed.result; end if;
  select * into previewed from identity.preview_staff_invitation_for_account(null, null,
    pg_temp.hmac('code-20-person20@accept-people.invalid'));
  if previewed.result <> 'ready' or previewed.facility_id <> current_setting('hid.test.a_facility_1')::uuid
     or previewed.inviter_name <> 'Ada Accept Admin' or previewed.role_code <> 'receptionist' then
    raise exception 'The typed signed-in preview answered %', row_to_json(previewed);
  end if;
  begin
    perform identity.preview_staff_invitation_for_account('d3970000-0000-4000-8000-000000000020', pg_temp.hmac('link-20'),
      pg_temp.hmac('code-20-person20@accept-people.invalid'));
    raise exception 'Both modes at once were accepted';
  exception when invalid_parameter_value then null;
  end;
  select * into accepted from identity.accept_staff_invitation_for_account('d3970000-0000-4000-8000-000000000020',
    pg_temp.hmac('link-20'), null);
  if accepted.result <> 'ready' or accepted.membership_id is null
     or accepted.facility_id <> current_setting('hid.test.a_facility_1')::uuid or accepted.role_code <> 'receptionist' then
    raise exception 'The signed-in accept answered %', row_to_json(accepted);
  end if;
  perform set_config('hid.test.signed_in_membership', accepted.membership_id::text, true);
  select * into accepted from identity.accept_staff_invitation_for_account('d3970000-0000-4000-8000-000000000020',
    pg_temp.hmac('link-20'), null);
  if accepted.result <> 'accepted' then raise exception 'A second signed-in accept answered %', accepted.result; end if;
  -- Already a member: person 20 at facility 2 (the lab membership above).
  perform pg_temp.as_person(20, 'accept-signed-in-0004');
end $$;
reset role;
do $$
declare event audit.events%rowtype;
begin
  if not exists (select 1 from identity.staff_facility_memberships
                  where id = current_setting('hid.test.signed_in_membership')::uuid and not is_primary and active
                    and account_id = 'd3000000-0000-4000-8000-000000000020')
     or not exists (select 1 from identity.staff_facility_memberships
                     where id = 'd3050000-0000-4000-8000-000000000020' and is_primary and active) then
    raise exception 'The signed-in acceptance did not add a non-primary membership';
  end if;
  if (select count(*) from audit.events where action = 'identity.staff-invitation.accept'
       and resource_id = 'd3970000-0000-4000-8000-000000000020') <> 1 then
    raise exception 'The signed-in acceptance was not audited exactly once';
  end if;
  select * into event from audit.events where action = 'identity.staff-invitation.accept'
    and resource_id = 'd3970000-0000-4000-8000-000000000020';
  if event.actor_type <> 'staff' or event.actor_account_id <> 'd3000000-0000-4000-8000-000000000020'
     or event.actor_membership_id <> current_setting('hid.test.signed_in_membership')::uuid
     or event.facility_id <> current_setting('hid.test.a_facility_1')::uuid
     or event.details ? 'accountCase' then
    raise exception 'The signed-in accept audit row is wrong: %', row_to_json(event);
  end if;
  if exists (select 1 from audit.events where facility_id = 'd3030000-0000-4000-8000-000000000001'
              and correlation_id like 'accept-signed-in-%') then
    raise exception 'A signed-in command wrote a row at the person''s own facility';
  end if;
  if exists (select 1 from audit.events where correlation_id in ('accept-signed-in-0001', 'accept-signed-in-0002')) then
    raise exception 'A refused signed-in command wrote an audit row';
  end if;
end $$;
-- Reuse of an ended membership through the signed-in path: person 22's only
-- membership is at the suspended facility; after support reactivates it, the
-- person is existing staff, and facility 2 had once employed them.
update identity.facilities set active = true, lifecycle_status = 'verified', status_reason = null
 where id = 'd3030000-0000-4000-8000-000000000002';
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values ('d3050000-0000-4000-8000-000000000122', 'd3040000-0000-4000-8000-000000000022',
  'd3000000-0000-4000-8000-000000000022', current_setting('hid.test.a_org_2')::uuid,
  current_setting('hid.test.a_facility_2')::uuid, 'lab', 'lab', false, false);
set local role hid_identity_api_runtime;
select pg_temp.as_admin(2, 'accept-invite-22');
select pg_temp.invite(2, 222, 'person22@accept-people.invalid', 'lab', 'MLSCN', 'ML 22');
select pg_temp.as_person(22, 'accept-signed-in-0005');
do $$
declare accepted record;
begin
  select * into accepted from identity.accept_staff_invitation_for_account('d3970000-0000-4000-8000-000000000222',
    pg_temp.hmac('link-222'), null);
  if accepted.result <> 'ready' or accepted.membership_id <> 'd3050000-0000-4000-8000-000000000122' then
    raise exception 'The ended membership was not reused: %', row_to_json(accepted);
  end if;
end $$;
-- Already a member (person 20 at facility 2, invited by owner SQL around the
-- command's own refusal).
reset role;
insert into identity.staff_invitations (id, organization_id, facility_id, invited_by_account_id, invited_by_membership_id,
  invitee_name, invitee_email, role_code, licence_body, licence_number, attestation_version, attested_at,
  link_token_hmac, email_code_hmac, key_version, last_sent_at, last_send_id, expires_at, idempotency_key,
  request_sha256, correlation_id)
values ('d3970000-0000-4000-8000-000000000220', current_setting('hid.test.a_org_2')::uuid,
  current_setting('hid.test.a_facility_2')::uuid, current_setting('hid.test.a_account_2')::uuid,
  current_setting('hid.test.a_membership_2')::uuid, 'Person J', 'person20@accept-people.invalid', 'receptionist', null, null,
  'facility-staff-attestation-v1', clock_timestamp(), pg_temp.hmac('link-220'), pg_temp.hmac('code-220'), 'v1',
  clock_timestamp(), gen_random_uuid(), clock_timestamp() + interval '7 days', 'accept-suite-seeded-member',
  repeat('b', 64), 'accept-suite-seed');
set local role hid_identity_api_runtime;
select pg_temp.as_person(20, 'accept-signed-in-0006');
do $$ begin
  if (select previewed.result from identity.preview_staff_invitation_for_account('d3970000-0000-4000-8000-000000000220',
        pg_temp.hmac('link-220'), null) previewed) <> 'already_member' then
    raise exception 'An existing member was not answered already_member';
  end if;
end $$;
reset role;

-- 6. The control closes every public and signed-in command.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:accept:super', true),
  set_config('app.correlation_id', 'accept-close', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select platform.admin_set_control('staff_invitations_enabled', false,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'staff_invitations_enabled'), 'Acceptance suite closes staff invitations');
do $$
declare attempt integer;
begin
  for attempt in 1..5 loop
    if attempt <= 3 then perform pg_temp.as_public('accept-closed-' || attempt);
    else perform pg_temp.as_person(20, 'accept-closed-' || attempt); end if;
    begin
      case attempt
        when 1 then perform identity.open_staff_invitation('d3970000-0000-4000-8000-000000000011', pg_temp.hmac('link-11'),
          null, null, pg_temp.hmac('session-closed'));
        when 2 then perform identity.prepare_staff_invitation_acceptance(pg_temp.hmac('session-23'));
        when 3 then perform identity.accept_staff_invitation_with_password(pg_temp.hmac('session-23'),
          '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('n', 22) || '$' || repeat('d', 43));
        when 4 then perform identity.preview_staff_invitation_for_account('d3970000-0000-4000-8000-000000000220',
          pg_temp.hmac('link-220'), null);
        else perform identity.accept_staff_invitation_for_account('d3970000-0000-4000-8000-000000000220',
          pg_temp.hmac('link-220'), null);
      end case;
      raise exception 'Closed command % ran', attempt;
    exception when object_not_in_prerequisite_state then
      if sqlerrm <> 'PLATFORM_CONTROL_DISABLED:staff_invitations_enabled' then raise; end if;
    end;
  end loop;
end $$;
reset role;

rollback;
