\set ON_ERROR_STOP on
-- 0199-0202 (ROS-1, Release D; owner decisions Q242-Q247 A, Q193 A, Q149 A and
-- the recommended Q-ROS-8 A to Q-ROS-15 A, not yet answered by the owner):
-- licence renewals, leave and department in-charges, the codes, the duty
-- roster. Every function runs as identity-api's login role
-- (hid_identity_api_runtime) in the context identity-api's withTransaction
-- sets (healthcare-operations). Needs 0001-0153, NUR-1's 0170-0177 (and what
-- they need) and 0199-0202 applied and the runtime roles bootstrapped.
-- Rollback-only, apart from section 11, which commits its own fictional rows
-- through dblink (two sessions at once) and removes them again. Fictional
-- people, places and identifiers only; ids start e199.
--
--   1. who holds the three codes (0201);
--   2. the licence list: statuses, 0139's licence rule, who may read it;
--   3. renewals: each status boundary (60, 31, 30, 0, -1 days), licence year
--      and expiry date, the date rules, a withdrawn latest renewal, a new
--      licence number, a role removed and added again, a member from before
--      0086, self-recorded, replay and reuse, before support's review, another
--      facility; withdraw; one member's history; the export's rows;
--   4. department in-charges: name, already, limit of 5, who may, end;
--   5. leave: ask, overlap, dates, department, cancel rules, who decides
--      (administrator, in-charge of that department only, never one's own),
--      decided list;
--   6. the roster: weeks, make, who edits, drafts hidden, save (kept, added,
--      removed), member, shift and day rules, overlap and rest across two
--      departments in both orders, exactly 8 hours, a night across midnight
--      (equal to 0176's ehr.clinical_shift_window), approved leave, the leave
--      clash and its removal, publish, change and publish again, started
--      duties;
--   7. attendance: the window, not published, own refused, swapped with a
--      cover, every mark kept; who is on duty now; my duties;
--   8. idempotent replays, reused keys and version conflicts;
--   9. no runtime role reads or writes a new table or runs a helper; fixed
--      search_path; a temporary table made by the caller changes nothing;
--      append-only and never-deleted tables;
--  10. audit: rows for every route, and never a name, licence number, leave
--      type, leave dates or reason;
--  11. two sessions at once (dblink): overlapping leave requests and
--      overlapping duties, one wins.
--
-- Each case records its outcome; the suite fails at the end listing every
-- case whose outcome differs.
begin;

do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;

-- 0. Fixtures. Platform super admin (opens sign-up and reviews).
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1990000-0000-4000-8000-000000000001', 'synthetic:hr:super', 'super@hr-suite.invalid', 'Hr Super Admin', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('e1991000-0000-4000-8000-000000000001', 'e1990000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
   'Workforce suite super admin');

-- Sign-ups: 1 hospital (reviewed; its administrator keeps doctor with MDCN/1990), 3 hospital (pending).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:hr:super', true),
  set_config('app.correlation_id', 'hr-open-controls', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'), 'Workforce suite opens facility sign-up');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'hr-signup-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare
  signup record;
  application_id uuid;
  current_application record;
  activated record;
begin
  for signup in select * from (values
      (1, 'ehr', 'hospital', 'RC9941990001', 'Ada Hrsuite Admin', 'ada@hr-hospital.invalid', 'Ada Hrsuite Hospital Ltd'),
      (3, 'ehr', 'hospital', 'RC9941990003', 'Chidi Hrsuite Admin', 'chidi@hr-pending.invalid', 'Chidi Hrsuite Hospital Ltd')
    ) as rows(n, product, kind, cac, admin_name, admin_email, legal_name) order by n loop
    application_id := identity.submit_self_service_organization_application(signup.product, signup.kind,
      signup.cac, signup.admin_name, signup.admin_email);
    select * into current_application from identity.public_get_organization_application(
      signup.cac, signup.admin_email, signup.product);
    perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
      'verified', '9942' || signup.n, signup.cac, signup.legal_name, 'Private Company Limited by Shares',
      '2018-08-0' || signup.n, signup.n || ' Workforce Suite Road, Lagos', 'active');
    perform identity.begin_self_service_provider_enrollment(signup.cac, signup.admin_email, signup.product,
      ('e1999000-0000-4000-8000-00000000000' || signup.n)::uuid,
      encode(sha256(('hr-otp-' || signup.n)::bytea), 'hex'), signup.admin_name, signup.kind);
    perform identity.verify_organization_profile_completion_challenge(
      ('e1999000-0000-4000-8000-00000000000' || signup.n)::uuid, encode(sha256(('hr-otp-' || signup.n)::bytea), 'hex'),
      encode(sha256(('hr-session-' || signup.n)::bytea), 'hex'));
    select * into activated from identity.activate_self_service_provider_enrollment(
      encode(sha256(('hr-session-' || signup.n)::bytea), 'hex'),
      '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
    perform set_config('hid.test.w_app_' || signup.n, application_id::text, true);
    perform set_config('hid.test.w_facility_' || signup.n, activated.facility_id::text, true);
    perform set_config('hid.test.w_account_' || signup.n, activated.account_id::text, true);
    perform set_config('hid.test.w_org_' || signup.n, activated.organization_id::text, true);
  end loop;
end $$;
select set_config('app.actor_subject', 'synthetic:hr:super', true),
  set_config('app.correlation_id', 'hr-review-0001', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
do $$
declare listed record;
begin
  select * into listed from identity.admin_list_self_service_facilities('unreviewed') item
   where item.application_id = current_setting('hid.test.w_app_1')::uuid;
  perform identity.admin_review_self_service_facility(listed.application_id, listed.row_version,
    'Checked the company and its administrator', 'doctor', 'regulator_register', 'MDCN', 'MDCN/1990');
end $$;
reset role;
select set_config('hid.test.w_membership_' || n,
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.w_account_' || n)::uuid), true)
  from unnest(array[1, 3]) n;

-- A governed hospital (no sign-up, no profile): F2.
insert into identity.organizations (id, name, slug) values
  ('e1990000-0000-4000-8000-000000000011', 'Workforce Governed Group', 'workforce-governed-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1990000-0000-4000-8000-000000000012', 'e1990000-0000-4000-8000-000000000011', 'Workforce Governed Hospital',
   'HR-GOV', 'Africa/Lagos', true, 'verified');

-- Members (owner SQL). F1: m1 nurse Amaka, m2 doctor Bayo, m3 receptionist Chika, m4 lab Dayo (from before 0086:
-- no licence on record), m5 pharmacist Ebere, m6 nurse Femi (maternity in-charge), m7 cashier Gozie (no workforce
-- code), m8 admin Hadiza, m10 doctor and nurse Ikenna, m11 nurse Jumoke (ended membership), m12-m16 nurses (the
-- in-charge limit). F2: m9 nurse Kunle, m13 admin Lola (governed administrator).
create temporary table w_people (n integer primary key, facility text, role_codes text[], name text) on commit drop;
insert into w_people values
  (1, 'f1', array['nurse'], 'Amaka Hrone'), (2, 'f1', array['doctor'], 'Bayo Hrtwo'),
  (3, 'f1', array['receptionist'], 'Chika Hrthree'), (4, 'f1', array['lab'], 'Dayo Hrfour'),
  (5, 'f1', array['pharmacist'], 'Ebere Hrfive'), (6, 'f1', array['nurse'], 'Femi Hrsix'),
  (7, 'f1', array['cashier'], 'Gozie Hrseven'), (8, 'f1', array['admin'], 'Hadiza Hreight'),
  (9, 'f2', array['nurse'], 'Kunle Hrnine'), (10, 'f1', array['doctor', 'nurse'], 'Ikenna Hrten'),
  (11, 'f1', array['nurse'], 'Jumoke Hreleven'), (13, 'f2', array['admin'], 'Lola Hrthirteen'),
  (12, 'f1', array['nurse'], 'Musa Hrtwelve'), (14, 'f1', array['nurse'], 'Ngozi Hrfourteen'),
  (15, 'f1', array['nurse'], 'Obi Hrfifteen'), (16, 'f1', array['nurse'], 'Peju Hrsixteen');
create function pg_temp.facility_of(label text) returns uuid language sql as $f$
  select case label when 'f1' then current_setting('hid.test.w_facility_1')::uuid
                    when 'f3' then current_setting('hid.test.w_facility_3')::uuid
                    else 'e1990000-0000-4000-8000-000000000012'::uuid end
$f$;
create function pg_temp.org_of(label text) returns uuid language sql as $f$
  select case label when 'f1' then current_setting('hid.test.w_org_1')::uuid
                    when 'f3' then current_setting('hid.test.w_org_3')::uuid
                    else 'e1990000-0000-4000-8000-000000000011'::uuid end
$f$;
create function pg_temp.account(n integer) returns uuid language sql immutable as $f$
  select ('e1990100-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.member(n integer) returns uuid language sql immutable as $f$
  select ('e1990300-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
insert into auth.accounts (id, subject, email, display_name, status)
select pg_temp.account(n), 'synthetic:hr:member-' || n, 'member' || n || '@hr-people.invalid', name, 'active'
  from w_people;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1990200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, pg_temp.account(n), name,
  'member' || n || '@hr-people.invalid', 'verified', role_codes[1]
  from w_people;
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
select pg_temp.member(n), ('e1990200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, pg_temp.account(n),
  pg_temp.org_of(facility), pg_temp.facility_of(facility), role_codes[1], role_codes[1], true, true
  from w_people;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e1992000-0000-4000-8000-0000000' || lpad(n::text, 2, '0') || lpad(role_position::text, 3, '0'))::uuid,
  pg_temp.account(n), role_code, 'facility', pg_temp.member(n), pg_temp.facility_of(facility), 'Workforce suite member'
  from w_people, unnest(role_codes) with ordinality as granted(role_code, role_position);
update identity.staff_facility_memberships set active = false where id = pg_temp.member(11);
create function pg_temp.grant_of(n integer, role text) returns uuid language sql as $f$
  select grant_row.id from auth.account_roles grant_row
   where grant_row.membership_id = pg_temp.member(n) and grant_row.role_code = role and grant_row.revoked_at is null
$f$;
-- Licence attestations (0086's facility_attestation by the administrator): m1 NMCN/1001, m2 MDCN/2002, m5 PCN/5005,
-- m6 NMCN/6006, m10 MDCN/1010 and NMCN/1011, m11 NMCN/1111. m4 has none.
create function pg_temp.attest(n integer, role text, body text, number text) returns void language sql as $f$
  insert into identity.staff_licence_attestations (organization_id, facility_id, account_id, staff_id, membership_id,
    role_code, role_grant_id, licence_body, licence_number, attested_person_name, verification_method,
    attested_by_account_id, attested_by_membership_id, attestation_version, attested_at, correlation_id)
  select pg_temp.org_of('f1'), pg_temp.facility_of('f1'), pg_temp.account(n),
    ('e1990200-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, pg_temp.member(n), role,
    pg_temp.grant_of(n, role), body, number, (select name from pg_temp.w_people where w_people.n = attest.n),
    'facility_attestation', current_setting('hid.test.w_account_1')::uuid,
    current_setting('hid.test.w_membership_1')::uuid, 'facility-staff-attestation-v1', clock_timestamp(),
    'hr-suite-attest-' || n || '-' || role
$f$;
select pg_temp.attest(1, 'nurse', 'NMCN', 'NMCN/1001'), pg_temp.attest(2, 'doctor', 'MDCN', 'MDCN/2002'),
  pg_temp.attest(5, 'pharmacist', 'PCN', 'PCN/5005'), pg_temp.attest(6, 'nurse', 'NMCN', 'NMCN/6006'),
  pg_temp.attest(10, 'doctor', 'MDCN', 'MDCN/1010'), pg_temp.attest(10, 'nurse', 'NMCN', 'NMCN/1011'),
  pg_temp.attest(11, 'nurse', 'NMCN', 'NMCN/1111');
-- F1's profile departments (0114 codes).
insert into identity.facility_profiles (facility_id, trading_name, ownership, care_level, address_line, city, state_code,
  lga, gps_latitude, gps_longitude, phone_e164, email, bed_count, operating_hours, emergency_24h, departments,
  services_offered, smoh_licence_number, has_registry_id, has_nhia_accreditation, medical_director_name,
  medical_director_mdcn, expected_staff, migrating_records, needs_interoperability, source)
values (pg_temp.facility_of('f1'), 'Workforce Hospital', 'private', 'secondary', '1 Synthetic Road', 'Ikeja', 'LA',
  'Ikeja', 6.6, 3.35, '+2348000000199', 'hr-hospital@example.invalid', 20, '24 hours', true,
  array['general_outpatient', 'emergency', 'maternity'], 'Fictional services', 'SYN-LIC-199', false, false,
  'Synthetic Director', 'SYN-MDCN-199', 10, false, false, 'facility_administrator');
-- NUR-1's clinical shifts at F1 (Lagos times): Morning 07:30-14:30, Afternoon 14:00-21:00, Night 20:30-08:00, Late
-- 16:00-22:00 (exactly 8 hours after the night ends), Early late 15:30-21:30 (7 and a half), Old (inactive). One at F2.
insert into ehr.clinical_shifts (id, facility_id, name, starts_at, ends_at, active, created_by_membership_id,
  updated_by_membership_id)
select ('e1990600-0000-4000-8000-00000000000' || shift.n)::uuid, pg_temp.facility_of(shift.facility), shift.name,
  shift.starts::time, shift.ends::time, shift.active,
  case shift.facility when 'f1' then current_setting('hid.test.w_membership_1')::uuid else pg_temp.member(13) end,
  case shift.facility when 'f1' then current_setting('hid.test.w_membership_1')::uuid else pg_temp.member(13) end
  from (values (1, 'f1', 'Morning', '07:30', '14:30', true), (2, 'f1', 'Afternoon', '14:00', '21:00', true),
               (3, 'f1', 'Night', '20:30', '08:00', true), (4, 'f1', 'Late', '16:00', '22:00', true),
               (5, 'f1', 'Early late', '15:30', '21:30', true), (6, 'f1', 'Old', '09:00', '17:00', false),
               (7, 'f2', 'Day', '08:00', '16:00', true)) as shift(n, facility, name, starts, ends, active);
create function pg_temp.shift(n integer) returns uuid language sql immutable as $f$
  select ('e1990600-0000-4000-8000-00000000000' || n)::uuid
$f$;

-- Dates: this Lagos week's Monday (w0), next week's (w1), and today.
select set_config('hid.test.today', ((clock_timestamp() at time zone 'Africa/Lagos')::date)::text, true);
select set_config('hid.test.w0', (current_setting('hid.test.today')::date
  - (extract(isodow from current_setting('hid.test.today')::date)::integer - 1))::text, true);
create function pg_temp.today() returns date language sql as $f$ select current_setting('hid.test.today')::date $f$;
create function pg_temp.w0() returns date language sql as $f$ select current_setting('hid.test.w0')::date $f$;
create function pg_temp.w1() returns date language sql as $f$ select current_setting('hid.test.w0')::date + 7 $f$;
create function pg_temp.d(value date) returns text language sql as $f$ select to_char(value, 'YYYY-MM-DD') $f$;

create temporary table w_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
create temporary table w_ids (name text primary key, id uuid, version bigint) on commit drop;
grant select, insert, update on pg_temp.w_outcomes, pg_temp.w_ids to hid_identity_api_runtime;
grant usage on sequence pg_temp.w_outcomes_seq_seq to hid_identity_api_runtime;
grant select on pg_temp.w_people to hid_identity_api_runtime;

create function pg_temp.check_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.w_outcomes (name, expected, actual) values (case_name, expected, coalesce(actual, '(null)'))
$f$;
create function pg_temp.keep(label text, value uuid, row_version bigint default null) returns void language sql as $f$
  insert into pg_temp.w_ids (name, id, version) values (label, value, row_version)
  on conflict (name) do update set id = excluded.id, version = excluded.version
$f$;
create function pg_temp.id(label text) returns uuid language sql as $f$ select id from pg_temp.w_ids where name = label $f$;
create function pg_temp.ver(label text) returns bigint language sql as $f$
  select version from pg_temp.w_ids where name = label
$f$;
-- The session of member n (n = 0: F1's administrator; n = 30: F3's pending administrator).
create function pg_temp.act(n integer) returns void language sql as $f$
  select set_config('app.actor_subject', case n when 0 then 'org-onboarding:' || current_setting('hid.test.w_account_1')
                                                when 30 then 'org-onboarding:' || current_setting('hid.test.w_account_3')
                                                else 'synthetic:hr:member-' || n end, true),
    set_config('app.membership_id', case n when 0 then current_setting('hid.test.w_membership_1')
                                           when 30 then current_setting('hid.test.w_membership_3')
                                           else pg_temp.member(n)::text end, true),
    set_config('app.facility_id', case n when 0 then current_setting('hid.test.w_facility_1')
                                         when 30 then current_setting('hid.test.w_facility_3')
                                         else (select pg_temp.facility_of(facility)::text from pg_temp.w_people
                                                where w_people.n = act.n) end, true),
    set_config('app.correlation_id', 'hr-suite-' || n || '-' || (random() * 1e9)::bigint, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$f$;
create function pg_temp.key(label text) returns text language sql immutable as $f$ select 'hr-suite-idem-key-' || label $f$;
create function pg_temp.sha(label text) returns text language sql immutable as $f$
  select encode(sha256(convert_to(label, 'UTF8')), 'hex')
$f$;
create function pg_temp.y() returns integer language sql as $f$ select extract(year from pg_temp.today())::integer $f$;

-- Wrappers: each sets the session, calls one function as the current role and answers one line (or the error).
create function pg_temp.lic_list(n integer) returns text language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.act(n);
  select string_agg(format('%s:%s:%s', right(row_value.membership_id::text, 2), coalesce(row_value.role_code, '-'),
           coalesce(row_value.status, '-')), ',' order by row_value.membership_id, row_value.role_code)
    into answer from identity.staff_licence_status_list() row_value
   where row_value.membership_id is distinct from current_setting('hid.test.w_membership_1')::uuid;
  return answer;
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.lic_record(n integer, target uuid, role text, period text, licence_year integer,
  valid_until date, how text, checked_on date, label text, keep_as text default null) returns text
language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.staff_licence_renewal_record(target, role, period, licence_year, valid_until, how,
    checked_on, 'facility-licence-renewal-v1', pg_temp.key(label),
    pg_temp.sha(format('%s|%s|%s|%s|%s|%s|%s|%s', label, target, role, period, licence_year, valid_until, how, checked_on)));
  if keep_as is not null and answer.renewal is not null then
    perform pg_temp.keep(keep_as, (answer.renewal->>'renewalId')::uuid);
  end if;
  return answer.outcome || '/' || answer.replayed || '/' || coalesce(answer.licence->>'status', '-') || '/'
    || coalesce(answer.licence->>'validUntil', '-') || '/' || coalesce(answer.renewal->>'selfRecorded', '-');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.lic_withdraw(n integer, renewal uuid, reason text, label text) returns text
language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.staff_licence_renewal_withdraw(renewal, reason, pg_temp.key(label), pg_temp.sha(label));
  return answer.outcome || '/' || answer.replayed || '/' || coalesce(answer.licence->>'status', '-');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.lic_status(n integer, target integer, role text) returns text language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.act(n);
  select row_value.status || coalesce('/' || (row_value.licence->>'daysLeft'), '')
    into answer from identity.staff_licence_status_list() row_value
   where row_value.membership_id = case target when 0 then current_setting('hid.test.w_membership_1')::uuid
                                               else pg_temp.member(target) end
     and row_value.role_code = role;
  return answer;
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.in_charge_add(n integer, department text, target integer, label text) returns text
language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.workforce_in_charge_add(department, pg_temp.member(target), pg_temp.key(label),
    pg_temp.sha(label));
  if answer.in_charge is not null then
    perform pg_temp.keep(label, (answer.in_charge->>'inChargeId')::uuid, (answer.in_charge->>'rowVersion')::bigint);
  end if;
  return answer.outcome || '/' || answer.replayed;
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.in_charge_end(n integer, in_charge uuid, row_version bigint, label text) returns text
language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.workforce_in_charge_end(in_charge, row_version, pg_temp.key(label), pg_temp.sha(label));
  return answer.outcome || '/' || answer.replayed || '/'
    || case when answer.in_charge is null then '-' else (answer.in_charge->>'endedAt' is not null)::text end;
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.leave_ask(n integer, leave_type text, starts date, ends date, department text, label text)
returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.staff_leave_request_create(leave_type, starts, ends, department, pg_temp.key(label),
    pg_temp.sha(label));
  if answer.leave_request is not null then
    perform pg_temp.keep(label, (answer.leave_request->>'leaveRequestId')::uuid,
      (answer.leave_request->>'rowVersion')::bigint);
  end if;
  return answer.outcome || '/' || answer.replayed || coalesce('/' || (answer.leave_request->>'days'), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.leave_decide(n integer, leave_label text, decision text, label text,
  row_version bigint default null) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.staff_leave_request_decide(pg_temp.id(leave_label), decision,
    coalesce(row_version, pg_temp.ver(leave_label)), pg_temp.key(label), pg_temp.sha(label));
  if answer.leave_request is not null then
    perform pg_temp.keep(leave_label, pg_temp.id(leave_label), (answer.leave_request->>'rowVersion')::bigint);
  end if;
  return answer.outcome || '/' || answer.replayed || coalesce('/' || (answer.details->>'dates'), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.leave_cancel(n integer, leave_label text, label text) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.staff_leave_request_cancel(pg_temp.id(leave_label), pg_temp.ver(leave_label),
    pg_temp.key(label), pg_temp.sha(label));
  if answer.leave_request is not null then
    perform pg_temp.keep(leave_label, pg_temp.id(leave_label), (answer.leave_request->>'rowVersion')::bigint);
  end if;
  return answer.outcome || '/' || answer.replayed;
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.leave_to_decide(n integer, status text, department text default null) returns text
language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.staff_leave_requests_to_decide(status, department);
  return answer.outcome || '/' || coalesce((select string_agg(right(item->>'membershipId', 2) || ':' || (item->>'leaveType')
                                                               || ':' || (item->>'status'), ',' order by ord)
                                              from jsonb_array_elements(answer.body->'items') with ordinality x(item, ord)), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.roster_create(n integer, department text, week date, label text) returns text
language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.duty_roster_create(department, week, pg_temp.key(label), pg_temp.sha(label));
  if answer.roster is not null then
    perform pg_temp.keep(department || '@' || week, (answer.roster->>'rosterId')::uuid,
      (answer.roster->>'rowVersion')::bigint);
  end if;
  return answer.outcome || '/' || answer.replayed || coalesce('/' || (answer.roster->>'status'), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
-- Save a roster's duties: entries 'member:shift:dayoffset' (from the roster's week start).
create function pg_temp.roster_set(n integer, roster_label text, entries text[], label text,
  row_version bigint default null) returns text language plpgsql as $f$
declare answer record; week date := split_part(roster_label, '@', 2)::date;
begin
  perform pg_temp.act(n);
  select * into answer from identity.duty_roster_assignments_set(pg_temp.id(roster_label),
    coalesce(row_version, pg_temp.ver(roster_label)),
    coalesce((select jsonb_agg(jsonb_build_object('membershipId', pg_temp.member(split_part(entry, ':', 1)::integer),
                'shiftId', pg_temp.shift(split_part(entry, ':', 2)::integer),
                'dutyDate', pg_temp.d(week + split_part(entry, ':', 3)::integer)) order by ord)
                from unnest(entries) with ordinality x(entry, ord)), '[]'::jsonb),
    pg_temp.key(label), pg_temp.sha(label));
  if answer.roster is not null then
    perform pg_temp.keep(roster_label, pg_temp.id(roster_label), (answer.roster->>'rowVersion')::bigint);
  end if;
  return answer.outcome || '/' || answer.replayed
    || coalesce('/' || (answer.changes->>'added') || '+' || (answer.changes->>'removed') || '-'
                || (answer.changes->>'kept'), '')
    || coalesce('/' || right(answer.details->>'membershipId', 2) || ':' || right(answer.details->>'shiftId', 1) || ':'
                || ((answer.details->>'dutyDate')::date - week), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.roster_publish(n integer, roster_label text, label text, row_version bigint default null)
returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.duty_roster_publish(pg_temp.id(roster_label),
    coalesce(row_version, pg_temp.ver(roster_label)), pg_temp.key(label), pg_temp.sha(label));
  if answer.roster is not null then
    perform pg_temp.keep(roster_label, pg_temp.id(roster_label), (answer.roster->>'rowVersion')::bigint);
  end if;
  return answer.outcome || '/' || answer.replayed || coalesce('/' || (answer.roster->>'publishCount') || '/'
    || (answer.roster->>'changedSincePublished'), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.roster_read(n integer, roster_label text) returns jsonb language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.duty_roster_read(pg_temp.id(roster_label));
  return jsonb_build_object('outcome', answer.outcome) || coalesce(answer.roster, '{}'::jsonb);
exception when others then return jsonb_build_object('outcome', sqlstate || ' ' || sqlerrm);
end $f$;
create function pg_temp.duty(roster_label text, member_n integer, shift_n integer, day_offset integer) returns uuid
language sql security definer as $f$
  select duty.id from identity.duty_roster_assignments duty
   where duty.roster_id = pg_temp.id(roster_label) and duty.membership_id = pg_temp.member(member_n)
     and duty.shift_id = pg_temp.shift(shift_n) and duty.duty_date = split_part(roster_label, '@', 2)::date + day_offset
     and duty.status = 'active'
$f$;
create function pg_temp.duty_version(duty uuid) returns bigint language sql security definer as $f$
  select row_version from identity.duty_roster_assignments where id = duty
$f$;
create function pg_temp.mark(n integer, roster_label text, duty uuid, attendance text, cover integer, label text,
  row_version bigint default null) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.duty_roster_attendance_mark(pg_temp.id(roster_label), duty,
    coalesce(row_version, pg_temp.duty_version(duty)), attendance,
    case when cover is null then null else pg_temp.member(cover) end, pg_temp.key(label), pg_temp.sha(label));
  return answer.outcome || '/' || answer.replayed || coalesce('/' || (answer.assignment->>'attendance'), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;

-- 1. Who holds the three codes (0201).
select pg_temp.check_case('1a the codes by role here',
  'admin:leave.request,roster.manage,roster.read|cashier:|doctor:leave.request,roster.read|lab:leave.request,roster.read|nurse:leave.request,roster.read|org_admin:leave.request,roster.manage,roster.read|pharmacist:leave.request,roster.read|receptionist:leave.request,roster.read',
  (select string_agg(role_row.code || ':' || coalesce((select string_agg(replace(grant_row.permission_code, 'workforce.', ''), ','
            order by grant_row.permission_code) from auth.role_permissions grant_row
           where grant_row.role_code = role_row.code and (grant_row.permission_code like 'workforce.roster.%'
             or grant_row.permission_code like 'workforce.leave.%')), ''), '|' order by role_row.code)
     from auth.roles role_row
    where role_row.code in ('admin', 'cashier', 'doctor', 'lab', 'nurse', 'org_admin', 'pharmacist', 'receptionist')));
select pg_temp.check_case('1b F1''s administrator holds workforce.manage and the roster codes', 't/t/t',
  (select format('%s/%s/%s', identity.workforce_member_holds(current_setting('hid.test.w_membership_1')::uuid, 'workforce.manage'),
     identity.workforce_member_holds(current_setting('hid.test.w_membership_1')::uuid, 'workforce.roster.manage'),
     identity.workforce_member_holds(current_setting('hid.test.w_membership_1')::uuid, 'workforce.leave.request'))));

-- 2. The licence list.
set local role hid_identity_api_runtime;
select pg_temp.check_case('2a the list: every active member here, each licensed role''s status (m4 lab: no licence on record; m3, m7, m8 hold none; m11 ended is left out)',
  '01:nurse:not_recorded,02:doctor:not_recorded,03:-:-,04:lab:no_licence,05:pharmacist:not_recorded,06:nurse:not_recorded,07:-:-,08:-:-,10:doctor:not_recorded,10:nurse:not_recorded,12:nurse:no_licence,14:nurse:no_licence,15:nurse:no_licence,16:nurse:no_licence',
  pg_temp.lic_list(0));
select pg_temp.check_case('2b the administrator''s own doctor licence (support''s review) is listed', 'not_recorded',
  pg_temp.lic_status(0, 0, 'doctor'));
select pg_temp.check_case('2c a nurse cannot see the list', '42501 STAFF_MANAGEMENT_PERMISSION_DENIED', pg_temp.lic_list(1));
select pg_temp.check_case('2d a governed facility''s administrator: not available there (Q-ROS-14 A)',
  '42501 STAFF_MANAGEMENT_NOT_AVAILABLE', pg_temp.lic_list(13));
select pg_temp.check_case('2e a pending facility''s administrator may read the list (only its own administrator)', 'ok',
  (select case when answer ~ '^[0-9a-f]{2}:-:-$' then 'ok' else coalesce(answer, 'none') end
     from (select pg_temp.lic_list(30) as answer) answered));
reset role;
select pg_temp.check_case('2f the list agrees with 0139''s licence per role (body and number hint)', 'true',
  ((select string_agg(format('%s/%s/%s/%s', membership_id, role_code, licence_body, coalesce(number_hint, '-')), ','
             order by membership_id, role_code)
      from identity.staff_licence_status_rows(pg_temp.facility_of('f1'), pg_temp.today()) where role_code is not null)
   = (select string_agg(format('%s/%s/%s/%s', membership_id, role_code, licence_body, coalesce(licence_number_hint, '-')),
             ',' order by membership_id, role_code)
        from identity.staff_role_licences(pg_temp.facility_of('f1'))))::text);


-- 3. Renewals.
select pg_temp.check_case('3a each status boundary (60, 31, 30, 0 and -1 days left), and none recorded',
  'valid|expiring_60|expiring_60|expiring_30|expiring_30|expired|not_recorded',
  (select string_agg(identity.staff_licence_status_of(pg_temp.today() + days, pg_temp.today()), '|' order by position)
     from unnest(array[61, 60, 31, 30, 0, -1]) with ordinality x(days, position))
  || '|' || identity.staff_licence_status_of(null, pg_temp.today()));
select set_config('hid.test.year_end_status', identity.staff_licence_status_of(make_date(pg_temp.y(), 12, 31),
  pg_temp.today()) || '/' || (make_date(pg_temp.y(), 12, 31) - pg_temp.today()), true);
set local role hid_identity_api_runtime;
select pg_temp.check_case('3b a licence year: valid to 31 December, checked on the register',
  'recorded/false/valid/' || (pg_temp.y() + 1) || '-12-31/false',
  pg_temp.lic_record(0, pg_temp.member(1), 'nurse', 'licence_year', pg_temp.y() + 1, null, 'regulator_register',
    pg_temp.today(), 'r1', 'r1'));
select pg_temp.check_case('3c the same Idempotency-Key and request: the first answer, replayed',
  'recorded/true/valid/' || (pg_temp.y() + 1) || '-12-31/false',
  pg_temp.lic_record(0, pg_temp.member(1), 'nurse', 'licence_year', pg_temp.y() + 1, null, 'regulator_register',
    pg_temp.today(), 'r1'));
select pg_temp.check_case('3d the same key with another request: refused, nothing recorded', 'key_reused/false/-/-/-',
  pg_temp.lic_record(0, pg_temp.member(2), 'doctor', 'expiry_date', null, pg_temp.today() + 30, 'certificate_seen',
    pg_temp.today(), 'r1'));
select pg_temp.check_case('3e an expiry date 30 days ahead, checked 3 days ago: expires within 30 days',
  'recorded/false/expiring_30/' || pg_temp.d(pg_temp.today() + 30) || '/false',
  pg_temp.lic_record(0, pg_temp.member(2), 'doctor', 'expiry_date', null, pg_temp.today() + 30, 'certificate_seen',
    pg_temp.today() - 3, 'r2', 'r2'));
select pg_temp.check_case('3f a later renewal 45 days ahead is the latest: expires within 60 days',
  'recorded/false/expiring_60/' || pg_temp.d(pg_temp.today() + 45) || '/false',
  pg_temp.lic_record(0, pg_temp.member(2), 'doctor', 'expiry_date', null, pg_temp.today() + 45, 'in_person',
    pg_temp.today(), 'r3', 'r3'));
select pg_temp.check_case('3g the latest withdrawn: the one before counts again', 'withdrawn/false/expiring_30',
  pg_temp.lic_withdraw(0, pg_temp.id('r3'), 'wrong_dates', 'w3'));
select pg_temp.check_case('3h withdrawn again (another key): refused', 'already_withdrawn/false/-',
  pg_temp.lic_withdraw(0, pg_temp.id('r3'), 'other', 'w3-again'));
select pg_temp.check_case('3i the withdrawal replayed', 'withdrawn/true/expiring_30',
  pg_temp.lic_withdraw(0, pg_temp.id('r3'), 'wrong_dates', 'w3'));
select pg_temp.check_case('3j the other one withdrawn too: no renewal recorded', 'withdrawn/false/not_recorded',
  pg_temp.lic_withdraw(0, pg_temp.id('r2'), 'wrong_member', 'w2'));
select pg_temp.check_case('3k an expiry date already past (yesterday) may be recorded: expired',
  'recorded/false/expired/' || pg_temp.d(pg_temp.today() - 1) || '/false',
  pg_temp.lic_record(0, pg_temp.member(5), 'pharmacist', 'expiry_date', null, pg_temp.today() - 1, 'regulator_register',
    pg_temp.today(), 'r5'));
select pg_temp.check_case('3l 60 days ahead: expires within 60 days, 60 days left', 'expiring_60/60',
  (select pg_temp.lic_status(0, 6, 'nurse')
     from (select pg_temp.lic_record(0, pg_temp.member(6), 'nurse', 'expiry_date', null, pg_temp.today() + 60,
             'certificate_seen', pg_temp.today() - 90, 'r6')) recorded));
select pg_temp.check_case('3m this year''s licence: valid to 31 December this year',
  current_setting('hid.test.year_end_status'),
  (select pg_temp.lic_status(0, 10, 'nurse')
     from (select pg_temp.lic_record(0, pg_temp.member(10), 'nurse', 'licence_year', pg_temp.y(), null,
             'regulator_register', pg_temp.today(), 'r10n')) recorded)::text);
select pg_temp.check_case('3n m10''s doctor licence renewed (100 days)', 'valid/100',
  (select pg_temp.lic_status(0, 10, 'doctor')
     from (select pg_temp.lic_record(0, pg_temp.member(10), 'doctor', 'expiry_date', null, pg_temp.today() + 100,
             'in_person', pg_temp.today(), 'r10d')) recorded));
reset role;
-- m10's nurse role removed and added again with the same licence; a new licence number for m10's doctor role.
update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = current_setting('hid.test.w_account_1')::uuid,
  revocation_reason = 'Workforce suite removes the role' where id = pg_temp.grant_of(10, 'nurse');
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('e1992000-0000-4000-8000-000000010099', pg_temp.account(10), 'nurse', 'facility', pg_temp.member(10),
  pg_temp.facility_of('f1'), 'Workforce suite adds the role again');
select pg_temp.attest(10, 'nurse', 'NMCN', 'NMCN 1011');
select pg_temp.attest(10, 'doctor', 'MDCN', 'MDCN/7777');
set local role hid_identity_api_runtime;
select pg_temp.check_case('3o the role removed and added again with the same licence: the renewal still counts',
  current_setting('hid.test.year_end_status'), pg_temp.lic_status(0, 10, 'nurse'));
select pg_temp.check_case('3p a new licence number: no renewal recorded', 'not_recorded', pg_temp.lic_status(0, 10, 'doctor'));
select pg_temp.check_case('3q a licensed role with no licence on record (before 0086): refused',
  'licence_not_on_record/false/-/-/-',
  pg_temp.lic_record(0, pg_temp.member(4), 'lab', 'licence_year', pg_temp.y(), null, 'in_person', pg_temp.today(), 'r4'));
select pg_temp.check_case('3r a role the member does not hold: refused', 'licence_not_on_record/false/-/-/-',
  pg_temp.lic_record(0, pg_temp.member(3), 'nurse', 'licence_year', pg_temp.y(), null, 'in_person', pg_temp.today(), 'r3x'));
select pg_temp.check_case('3s another facility''s member and an ended membership: not here',
  'not_found/false/-/-/-|not_found/false/-/-/-',
  pg_temp.lic_record(0, pg_temp.member(9), 'nurse', 'licence_year', pg_temp.y(), null, 'in_person', pg_temp.today(), 'r9')
  || '|' || pg_temp.lic_record(0, pg_temp.member(11), 'nurse', 'licence_year', pg_temp.y(), null, 'in_person',
    pg_temp.today(), 'r11'));
select pg_temp.check_case('3t the date rules: year +4, year -2, 401 days ago, past 5 years, checked tomorrow, checked 91 days ago',
  'dates_invalid|dates_invalid|dates_invalid|dates_invalid|dates_invalid|dates_invalid',
  split_part(pg_temp.lic_record(0, pg_temp.member(6), 'nurse', 'licence_year', pg_temp.y() + 4, null, 'in_person',
    pg_temp.today(), 'd1'), '/', 1) || '|'
  || split_part(pg_temp.lic_record(0, pg_temp.member(6), 'nurse', 'licence_year', pg_temp.y() - 2, null, 'in_person',
    pg_temp.today(), 'd2'), '/', 1) || '|'
  || split_part(pg_temp.lic_record(0, pg_temp.member(6), 'nurse', 'expiry_date', null, pg_temp.today() - 401, 'in_person',
    pg_temp.today(), 'd3'), '/', 1) || '|'
  || split_part(pg_temp.lic_record(0, pg_temp.member(6), 'nurse', 'expiry_date', null,
    (pg_temp.today() + interval '5 years')::date + 1, 'in_person', pg_temp.today(), 'd4'), '/', 1) || '|'
  || split_part(pg_temp.lic_record(0, pg_temp.member(6), 'nurse', 'expiry_date', null, pg_temp.today() + 10, 'in_person',
    pg_temp.today() + 1, 'd5'), '/', 1) || '|'
  || split_part(pg_temp.lic_record(0, pg_temp.member(6), 'nurse', 'expiry_date', null, pg_temp.today() + 10, 'in_person',
    pg_temp.today() - 91, 'd6'), '/', 1));
select pg_temp.check_case('3u last year''s licence and 400 days ago are allowed', 'recorded|recorded',
  split_part(pg_temp.lic_record(0, pg_temp.member(6), 'nurse', 'licence_year', pg_temp.y() - 1, null, 'in_person',
    pg_temp.today(), 'd7'), '/', 1) || '|'
  || split_part(pg_temp.lic_record(0, pg_temp.member(6), 'nurse', 'expiry_date', null, pg_temp.today() - 400, 'in_person',
    pg_temp.today(), 'd8'), '/', 1));
select pg_temp.check_case('3v the administrator''s own renewal: allowed and marked self-recorded (Q-ROS-13 A)',
  'recorded/false/valid/' || pg_temp.d(pg_temp.today() + 200) || '/true',
  pg_temp.lic_record(0, current_setting('hid.test.w_membership_1')::uuid, 'doctor', 'expiry_date', null,
    pg_temp.today() + 200, 'certificate_seen', pg_temp.today(), 'r0'));
select pg_temp.check_case('3w before support''s review: refused', 'review_pending/false/-/-/-',
  pg_temp.lic_record(30, current_setting('hid.test.w_membership_3')::uuid, 'doctor', 'licence_year', pg_temp.y(), null,
    'in_person', pg_temp.today(), 'r30'));
select pg_temp.check_case('3x a nurse cannot record one', '42501 STAFF_MANAGEMENT_PERMISSION_DENIED',
  pg_temp.lic_record(1, pg_temp.member(1), 'nurse', 'licence_year', pg_temp.y(), null, 'in_person', pg_temp.today(), 'r1n'));
select pg_temp.check_case('3y another facility''s or an unknown renewal: not here', 'not_found/false/-',
  pg_temp.lic_withdraw(0, 'e1990999-0000-4000-8000-000000000001', 'other', 'w-unknown'));
select pg_temp.check_case('3z a reason outside the list: invalid', '22023 LICENCE_RENEWAL_INVALID',
  pg_temp.lic_withdraw(0, pg_temp.id('r1'), 'typo', 'w-typo'));
select pg_temp.check_case('3za one member''s licences with every renewal, newest first, withdrawn ones marked',
  'found/1/45:wrong_dates|30:wrong_member',
  (select answer.outcome || '/' || jsonb_array_length(answer.member->'licences') || '/'
          || (select string_agg(((renewal->>'validUntil')::date - pg_temp.today()) || ':'
                                || coalesce(renewal->'withdrawn'->>'reasonCode', '-'), '|' order by ord)
                from jsonb_array_elements(answer.member->'licences'->0->'renewals') with ordinality x(renewal, ord))
     from (select * from (select pg_temp.act(0)) acted, identity.staff_licence_member_read(pg_temp.member(2))) answer));
select pg_temp.check_case('3zb another facility''s member: not here', 'not_found',
  (select answer.outcome from (select pg_temp.act(0)) acted, identity.staff_licence_member_read(pg_temp.member(9)) answer));
select pg_temp.check_case('3zc the export: one row per licence, the last 4 characters only, no member without a licensed role',
  '12/t/f/1001',
  (select format('%s/%s/%s/%s', count(*), bool_and(number_hint is null or length(number_hint) = 4),
            bool_or(member_name = 'Chika Hrthree'),
            max(number_hint) filter (where member_name = 'Amaka Hrone'))
     from (select pg_temp.act(0)) acted, identity.staff_licence_export_rows()));

-- 4. Department in-charges.
select pg_temp.check_case('4a the administrator names Femi in charge of maternity', 'named/false',
  pg_temp.in_charge_add(0, 'maternity', 6, 'ic6'));
select pg_temp.check_case('4b replayed', 'named/true', pg_temp.in_charge_add(0, 'maternity', 6, 'ic6'));
select pg_temp.check_case('4c already in charge', 'already/false', pg_temp.in_charge_add(0, 'maternity', 6, 'ic6-again'));
select pg_temp.check_case('4d the cashier (no roster code), another facility''s nurse and an ended member: not valid',
  'member_invalid/false|member_invalid/false|member_invalid/false',
  pg_temp.in_charge_add(0, 'maternity', 7, 'ic7') || '|' || pg_temp.in_charge_add(0, 'maternity', 9, 'ic9') || '|'
  || pg_temp.in_charge_add(0, 'maternity', 11, 'ic11'));
select pg_temp.check_case('4e a department not in the profile', 'department_invalid/false',
  pg_temp.in_charge_add(0, 'dental', 6, 'ic-dental'));
select pg_temp.check_case('4f a nurse cannot name in-charges', '42501 IN_CHARGE_SETUP_NOT_ALLOWED',
  pg_temp.in_charge_add(1, 'maternity', 1, 'ic-by-nurse'));
select pg_temp.check_case('4g the admin role names five in emergency, the sixth is refused',
  'named/false|named/false|named/false|named/false|named/false|limit_reached/false',
  pg_temp.in_charge_add(8, 'emergency', 12, 'ice12') || '|' || pg_temp.in_charge_add(8, 'emergency', 14, 'ice14') || '|'
  || pg_temp.in_charge_add(8, 'emergency', 15, 'ice15') || '|' || pg_temp.in_charge_add(8, 'emergency', 16, 'ice16') || '|'
  || pg_temp.in_charge_add(8, 'emergency', 1, 'ice1') || '|' || pg_temp.in_charge_add(8, 'emergency', 2, 'ice2'));
select pg_temp.check_case('4h the list, every profile department in the profile''s order (a reader)',
  'general_outpatient:0|emergency:5|maternity:1',
  (select string_agg((department->>'departmentCode') || ':' || jsonb_array_length(department->'inCharges'), '|'
            order by ord)
     from (select pg_temp.act(1)) acted,
          jsonb_array_elements(identity.workforce_in_charge_list()->'departments') with ordinality x(department, ord)));
create function pg_temp.in_charge_list(n integer) returns text language plpgsql as $f$
begin
  perform pg_temp.act(n);
  return jsonb_array_length(identity.workforce_in_charge_list()->'departments')::text;
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
select pg_temp.check_case('4i2 the cashier cannot see who is in charge', '42501 DUTY_ROSTER_NOT_ALLOWED',
  pg_temp.in_charge_list(7));
select pg_temp.check_case('4j end Amaka''s emergency in-charge: a stale version, then ended, then not there',
  'changed/false/-|ended/false/true|not_found/false/-',
  pg_temp.in_charge_end(0, pg_temp.id('ice1'), 7, 'ice1-end-stale') || '|'
  || pg_temp.in_charge_end(0, pg_temp.id('ice1'), 1, 'ice1-end') || '|'
  || pg_temp.in_charge_end(0, pg_temp.id('ice1'), 2, 'ice1-end-again'));
select pg_temp.check_case('4k an in-charge cannot end in-charges', '42501 IN_CHARGE_SETUP_NOT_ALLOWED',
  pg_temp.in_charge_end(6, pg_temp.id('ic6'), 1, 'ic6-end-by-self'));

-- 5. Leave.
select pg_temp.check_case('5a Amaka asks for annual leave sent to maternity', 'requested/false/3',
  pg_temp.leave_ask(1, 'annual', pg_temp.w1() + 9, pg_temp.w1() + 11, 'maternity', 'L1'));
select pg_temp.check_case('5b replayed', 'requested/true/3',
  pg_temp.leave_ask(1, 'annual', pg_temp.w1() + 9, pg_temp.w1() + 11, 'maternity', 'L1'));
select pg_temp.check_case('5c overlapping her own requested leave', 'overlaps/false',
  pg_temp.leave_ask(1, 'sick', pg_temp.w1() + 11, pg_temp.w1() + 12, null, 'L1-overlap'));
select pg_temp.check_case('5d the date rules: 31 days ago, an end before the start, 366 days',
  'dates_invalid/false|dates_invalid/false|dates_invalid/false',
  pg_temp.leave_ask(1, 'sick', pg_temp.today() - 31, pg_temp.today() - 31, null, 'Ld1') || '|'
  || pg_temp.leave_ask(1, 'annual', pg_temp.w1() + 40, pg_temp.w1() + 39, null, 'Ld2') || '|'
  || pg_temp.leave_ask(1, 'study', pg_temp.w1() + 40, pg_temp.w1() + 405, null, 'Ld3'));
select pg_temp.check_case('5e sick leave recorded 30 days late, sent to emergency', 'requested/false/2',
  pg_temp.leave_ask(2, 'sick', pg_temp.today() - 30, pg_temp.today() - 29, 'emergency', 'L2'));
select pg_temp.check_case('5f a department not in the profile', 'department_invalid/false',
  pg_temp.leave_ask(2, 'annual', pg_temp.w1() + 20, pg_temp.w1() + 21, 'dental', 'Ldental'));
select pg_temp.check_case('5g the cashier cannot ask for leave here', '42501 LEAVE_REQUEST_NOT_ALLOWED',
  pg_temp.leave_ask(7, 'annual', pg_temp.w1() + 20, pg_temp.w1() + 21, null, 'L7'));
create function pg_temp.leave_mine(n integer) returns text language plpgsql as $f$
declare answer jsonb;
begin
  perform pg_temp.act(n);
  answer := identity.staff_leave_requests_mine();
  return coalesce((select string_agg((item->>'leaveType') || ':' || (item->>'status'), ',' order by ord)
                     from jsonb_array_elements(answer->'items') with ordinality x(item, ord)), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
select pg_temp.check_case('5h my leave (with the type)', 'annual:requested', pg_temp.leave_mine(1));
select pg_temp.check_case('5i the maternity in-charge sees leave sent to maternity', 'listed/01:annual:requested',
  pg_temp.leave_to_decide(6, 'requested'));
select pg_temp.check_case('5j a doctor who is not an in-charge: not allowed', '42501 LEAVE_DECISION_NOT_ALLOWED',
  pg_temp.leave_to_decide(2, 'requested'));
select pg_temp.check_case('5k the administrator sees every request, earliest first', 'listed/02:sick:requested,01:annual:requested',
  pg_temp.leave_to_decide(0, 'requested'));
select pg_temp.check_case('5l the in-charge asking for another department, or one not in the profile',
  '42501 LEAVE_DECISION_NOT_ALLOWED|department_invalid/',
  pg_temp.leave_to_decide(6, 'requested', 'emergency') || '|' || pg_temp.leave_to_decide(6, 'requested', 'dental'));
select pg_temp.check_case('5m the maternity in-charge cannot decide leave sent to emergency', 'decision_not_allowed/false',
  pg_temp.leave_decide(6, 'L2', 'approve', 'L2-by-6'));
select pg_temp.check_case('5n nobody decides their own leave', 'requested/false/1|own_decision/false',
  pg_temp.leave_ask(6, 'annual', pg_temp.w1() + 14, pg_temp.w1() + 14, 'maternity', 'L6') || '|'
  || pg_temp.leave_decide(6, 'L6', 'approve', 'L6-by-6'));
select pg_temp.check_case('5o a stale version, approved, then already decided, and a replay',
  'changed/false|approved/false|already_decided/false|approved/true',
  pg_temp.leave_decide(6, 'L1', 'approve', 'L1-approve-stale', 9) || '|'
  || pg_temp.leave_decide(6, 'L1', 'approve', 'L1-approve') || '|'
  || pg_temp.leave_decide(6, 'L1', 'decline', 'L1-decline') || '|'
  || pg_temp.leave_decide(6, 'L1', 'approve', 'L1-approve'));
select pg_temp.check_case('5p someone else cannot cancel Amaka''s leave', 'not_found/false',
  pg_temp.leave_cancel(2, 'L1', 'L1-cancel-by-2'));
select pg_temp.check_case('5q approved leave cancelled before it starts', 'cancelled/false',
  pg_temp.leave_cancel(1, 'L1', 'L1-cancel'));
select pg_temp.check_case('5r sick leave that has started, once approved, cannot be cancelled',
  'approved/false|cancel_not_allowed/false',
  pg_temp.leave_decide(0, 'L2', 'approve', 'L2-approve') || '|' || pg_temp.leave_cancel(2, 'L2', 'L2-cancel'));
select pg_temp.check_case('5s Femi''s own leave approved by the administrator, then declined is refused',
  'approved/false|already_decided/false',
  pg_temp.leave_decide(0, 'L6', 'approve', 'L6-approve') || '|' || pg_temp.leave_decide(0, 'L6', 'decline', 'L6-decline'));
select pg_temp.check_case('5t decided leave (the administrator; never their own)',
  'listed/02:sick:approved,01:annual:cancelled,06:annual:approved', pg_temp.leave_to_decide(0, 'decided'));

-- 6. The duty roster.
select pg_temp.check_case('6a weeks: not a Monday, 27 weeks ahead, 9 weeks ago are refused; 8 weeks ago is allowed',
  'week_invalid/false|week_invalid/false|week_invalid/false|created/false/draft',
  pg_temp.roster_create(0, 'general_outpatient', pg_temp.w1() + 1, 'g-tue') || '|'
  || pg_temp.roster_create(0, 'general_outpatient', pg_temp.w0() + 189, 'g-27') || '|'
  || pg_temp.roster_create(0, 'general_outpatient', pg_temp.w0() - 63, 'g-9ago') || '|'
  || pg_temp.roster_create(0, 'general_outpatient', pg_temp.w0() - 56, 'g-8ago'));
select pg_temp.check_case('6b a facility with no profile departments', 'no_departments/false',
  pg_temp.roster_create(13, 'emergency', pg_temp.w1(), 'gov-roster'));
select pg_temp.check_case('6c a department not in the profile', 'department_invalid/false',
  pg_temp.roster_create(0, 'dental', pg_temp.w1(), 'dental-roster'));
select pg_temp.check_case('6d a nurse who is not an in-charge cannot make one', 'edit_not_allowed/false',
  pg_temp.roster_create(1, 'maternity', pg_temp.w1(), 'm-by-1'));
select pg_temp.check_case('6e the maternity in-charge makes next week''s: created, replayed, already there',
  'created/false/draft|created/true/draft|already_exists/false/draft',
  pg_temp.roster_create(6, 'maternity', pg_temp.w1(), 'm-w1') || '|' || pg_temp.roster_create(6, 'maternity', pg_temp.w1(), 'm-w1')
  || '|' || pg_temp.roster_create(6, 'maternity', pg_temp.w1(), 'm-w1-again'));
select pg_temp.check_case('6f but not emergency''s; the administrator does', 'edit_not_allowed/false|created/false/draft',
  pg_temp.roster_create(6, 'emergency', pg_temp.w1(), 'e-by-6') || '|'
  || pg_temp.roster_create(0, 'emergency', pg_temp.w1(), 'e-w1'));
create function pg_temp.roster_list(n integer, week date) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.duty_roster_list(week);
  return answer.outcome || '/' || coalesce((select string_agg((item->>'departmentCode') || ':' || (item->>'status') || ':'
                                                               || (item->>'canEdit'), ',' order by ord)
                                              from jsonb_array_elements(answer.body->'items') with ordinality x(item, ord)), '')
    || '/' || coalesce(answer.body->>'inChargeOf', '-');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
select pg_temp.check_case('6g the week''s list: drafts hidden from a reader; the in-charge sees maternity''s; the administrator every department',
  'listed//[]|listed/maternity:draft:true/["maternity"]|listed/emergency:draft:true,general_outpatient:none:true,maternity:draft:true/[]',
  pg_temp.roster_list(1, pg_temp.w1()) || '|' || pg_temp.roster_list(6, pg_temp.w1()) || '|'
  || pg_temp.roster_list(0, pg_temp.w1()));
select pg_temp.check_case('6h a draft is not found for a reader; found for its in-charge, with the draft rule',
  'not_found|found/true/8.00/draft',
  (pg_temp.roster_read(1, 'maternity@' || pg_temp.w1()))->>'outcome' || '|'
  || (select (r->>'outcome') || '/' || (r->>'canEdit') || '/' || (r->'rules'->>'minRestHours') || '/'
             || (r->'rules'->>'status') from (select pg_temp.roster_read(6, 'maternity@' || pg_temp.w1()) r) x));
select pg_temp.check_case('6i save Amaka''s Monday morning: added; replayed; saved again unchanged; a stale version',
  'saved/false/1+0-0|saved/true/1+0-0|saved/false/0+0-1|changed/false',
  pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['1:1:0'], 's1') || '|'
  || pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['1:1:0'], 's1') || '|'
  || pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['1:1:0'], 's1b') || '|'
  || pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['1:1:0'], 's1c', 1));
select pg_temp.check_case('6j the member, shift and day rules (the first refused duty named)',
  'member_invalid/false/09:1:1|shift_invalid/false/01:6:1|shift_invalid/false/01:7:1|date_outside_week/false/01:1:7',
  pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['1:1:0', '9:1:1'], 's2') || '|'
  || pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['1:1:0', '1:6:1'], 's3') || '|'
  || pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['1:1:0', '1:7:1'], 's4') || '|'
  || pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['1:1:0', '1:1:7'], 's5'));
select pg_temp.check_case('6k an overlap in another department (emergency, Monday afternoon): refused, nothing saved',
  'overlap/false/01:2:0|0', pg_temp.roster_set(0, 'emergency@' || pg_temp.w1(), array['3:1:0', '1:2:0'], 's6') || '|'
  || (select count(*)::text from (select 1) one where pg_temp.duty('emergency@' || pg_temp.w1(), 3, 1, 0) is not null));
select pg_temp.check_case('6l a night across midnight: saved',
  'saved/false/1+0-1', pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['1:1:0', '2:3:1'], 's7'));
reset role;
select pg_temp.check_case('6m the night''s Lagos window: 20:30 to 08:00 the next day, in UTC',
  pg_temp.d(pg_temp.w1() + 1) || 'T19:30:00Z/' || pg_temp.d(pg_temp.w1() + 2) || 'T07:00:00Z',
  (select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '/'
          || to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
     from identity.duty_roster_assignments where id = pg_temp.duty('maternity@' || pg_temp.w1(), 2, 3, 1)));
select pg_temp.check_case('6n the window equals 0176''s ehr.clinical_shift_window for every shift on every day of the week',
  '0', (select count(*)::text from generate_series(1, 6) shift_n, generate_series(0, 6) day_offset
          where (select row(window_row.starts, window_row.ends) from identity.duty_roster_shift_window(
                   pg_temp.shift(shift_n), pg_temp.w1() + day_offset) window_row)
                is distinct from (select row(window_row.starts, window_row.ends) from ehr.clinical_shift_window(
                   pg_temp.shift(shift_n), pg_temp.w1() + day_offset) window_row)));
select pg_temp.check_case('6n2 rest_until is the end plus the draft 480 minutes', '480',
  (select (extract(epoch from rest_until - ends_at) / 60)::integer::text from identity.duty_roster_assignments
    where id = pg_temp.duty('maternity@' || pg_temp.w1(), 2, 3, 1)));
set local role hid_identity_api_runtime;
select pg_temp.check_case('6o 7 and a half hours after the night (another department): too short',
  'rest_too_short/false/02:5:2', pg_temp.roster_set(0, 'emergency@' || pg_temp.w1(), array['2:5:2'], 's8'));
select pg_temp.check_case('6o2 exactly 8 hours after the night: allowed',
  'saved/false/1+0-2', pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['1:1:0', '2:3:1', '2:4:2'], 's8b'));
select pg_temp.check_case('6p the other order: a night ending 7 and a half hours before a saved duty',
  'saved/false/1+0-0|rest_too_short/false/05:3:5',
  pg_temp.roster_set(0, 'emergency@' || pg_temp.w1(), array['5:5:6'], 's9') || '|'
  || pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['1:1:0', '2:3:1', '2:4:2', '5:3:5'], 's10'));
select pg_temp.check_case('6q approved leave blocks a duty that day', 'requested/false/1|approved/false|member_on_leave/false/03:1:3',
  pg_temp.leave_ask(3, 'annual', pg_temp.w1() + 3, pg_temp.w1() + 3, 'maternity', 'L3') || '|'
  || pg_temp.leave_decide(6, 'L3', 'approve', 'L3-approve') || '|'
  || pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['1:1:0', '2:3:1', '2:4:2', '3:1:3'], 's11'));
select pg_temp.check_case('6r approving leave over a rostered duty is refused with its dates; allowed once the duty is off',
  'requested/false/1|clashes_with_roster/false/["' || pg_temp.d(pg_temp.w1()) || '"]|saved/false/0+1-2|approved/false',
  pg_temp.leave_ask(1, 'annual', pg_temp.w1(), pg_temp.w1(), 'maternity', 'L4') || '|'
  || pg_temp.leave_decide(6, 'L4', 'approve', 'L4-approve') || '|'
  || pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['2:3:1', '2:4:2'], 's12') || '|'
  || pg_temp.leave_decide(6, 'L4', 'approve', 'L4-approve-2'));
select pg_temp.check_case('6s the in-charge sees who is unavailable in the week, never the type',
  '01:' || pg_temp.d(pg_temp.w1()) || ':leave_approved|03:' || pg_temp.d(pg_temp.w1() + 3) || ':leave_approved|false',
  (select string_agg(right(item->>'membershipId', 2) || ':' || (item->>'from') || ':' || (item->>'kind'), '|' order by ord)
          || '|' || bool_or(item ? 'leaveType')::text
     from jsonb_array_elements(pg_temp.roster_read(6, 'maternity@' || pg_temp.w1())->'unavailable')
          with ordinality x(item, ord)));
select pg_temp.check_case('6t an empty roster cannot be published', 'created/false/draft|empty/false',
  pg_temp.roster_create(0, 'general_outpatient', pg_temp.w1(), 'g-w1') || '|'
  || pg_temp.roster_publish(0, 'general_outpatient@' || pg_temp.w1(), 'p-g'));
select pg_temp.check_case('6u publish, again unchanged, change it, publish again',
  'published/false/1/false|unchanged/false/1/false|saved/false/1+0-2|true|published/false/2/false|published/true/2/false',
  pg_temp.roster_publish(6, 'maternity@' || pg_temp.w1(), 'p-m1') || '|'
  || pg_temp.roster_publish(6, 'maternity@' || pg_temp.w1(), 'p-m1-again') || '|'
  || pg_temp.roster_set(6, 'maternity@' || pg_temp.w1(), array['2:3:1', '2:4:2', '6:1:4'], 's13') || '|'
  || (pg_temp.roster_read(6, 'maternity@' || pg_temp.w1())->>'changedSincePublished') || '|'
  || pg_temp.roster_publish(6, 'maternity@' || pg_temp.w1(), 'p-m2') || '|'
  || pg_temp.roster_publish(6, 'maternity@' || pg_temp.w1(), 'p-m2'));
select pg_temp.check_case('6v a reader sees the published roster, not editable, with no unavailable list',
  'found/false/3/0|listed/maternity:published:false/[]',
  (select (r->>'outcome') || '/' || (r->>'canEdit') || '/' || jsonb_array_length(r->'assignments') || '/'
          || jsonb_array_length(r->'unavailable') from (select pg_temp.roster_read(1, 'maternity@' || pg_temp.w1()) r) x)
  || '|' || pg_temp.roster_list(1, pg_temp.w1()));
select pg_temp.check_case('6w a duty whose shift has started cannot be added (last week)',
  'created/false/draft|shift_started/false/08:1:0',
  pg_temp.roster_create(0, 'emergency', pg_temp.w0() - 7, 'e-w-1') || '|'
  || pg_temp.roster_set(0, 'emergency@' || (pg_temp.w0() - 7), array['8:1:0'], 's14'));
-- Running duties this week (owner SQL, through the guard): Ebere on emergency, Femi and Bayo on maternity.
select pg_temp.check_case('6x this week''s rosters', 'created/false/draft|created/false/draft',
  pg_temp.roster_create(0, 'emergency', pg_temp.w0(), 'e-w0') || '|' || pg_temp.roster_create(6, 'maternity', pg_temp.w0(), 'm-w0'));
reset role;
insert into identity.duty_roster_assignments (roster_id, facility_id, membership_id, account_id, shift_id, duty_date,
  starts_at, ends_at, rest_until, added_by_membership_id, added_by_account_id)
select pg_temp.id(running.roster_label), pg_temp.facility_of('f1'), pg_temp.member(running.n), pg_temp.account(running.n),
  pg_temp.shift(1), pg_temp.today(), clock_timestamp() - interval '2 hours', clock_timestamp() + interval '2 hours',
  clock_timestamp() + interval '2 hours', current_setting('hid.test.w_membership_1')::uuid,
  current_setting('hid.test.w_account_1')::uuid
  from (values ('emergency@' || pg_temp.w0(), 5), ('maternity@' || pg_temp.w0(), 6),
               ('maternity@' || pg_temp.w0(), 3)) running(roster_label, n);
select pg_temp.keep('duty5', (select id from identity.duty_roster_assignments
  where roster_id = pg_temp.id('emergency@' || pg_temp.w0()) and membership_id = pg_temp.member(5)));
select pg_temp.keep('duty6', (select id from identity.duty_roster_assignments
  where roster_id = pg_temp.id('maternity@' || pg_temp.w0()) and membership_id = pg_temp.member(6)));
select pg_temp.keep('duty3', (select id from identity.duty_roster_assignments
  where roster_id = pg_temp.id('maternity@' || pg_temp.w0()) and membership_id = pg_temp.member(3)));
update pg_temp.w_ids set version = (select row_version from identity.duty_rosters where id = pg_temp.w_ids.id)
 where name in ('emergency@' || pg_temp.w0(), 'maternity@' || pg_temp.w0());
set local role hid_identity_api_runtime;

-- 7. Attendance, on duty now, my duties.
select pg_temp.keep('nowhere@' || pg_temp.w1(), 'e1990999-0000-4000-8000-000000000003');
select pg_temp.check_case('7a not on a draft roster', 'not_published/false',
  pg_temp.mark(0, 'emergency@' || pg_temp.w0(), pg_temp.id('duty5'), 'present', null, 'a0'));
select pg_temp.check_case('7b publish this week''s and remove a running duty: refused', 'published/false/1/false|published/false/1/false|shift_started/false/05:1:'
    || (pg_temp.today() - pg_temp.w0()),
  pg_temp.roster_publish(0, 'emergency@' || pg_temp.w0(), 'p-e0') || '|'
  || pg_temp.roster_publish(6, 'maternity@' || pg_temp.w0(), 'p-m0') || '|'
  || pg_temp.roster_set(0, 'emergency@' || pg_temp.w0(), array[]::text[], 's15'));
select pg_temp.check_case('7c the maternity in-charge cannot mark emergency''s; the administrator marks Ebere present; replayed; stale',
  'edit_not_allowed/false|marked/false/present|marked/true/present|changed/false',
  pg_temp.mark(6, 'emergency@' || pg_temp.w0(), pg_temp.id('duty5'), 'present', null, 'a1') || '|'
  || pg_temp.mark(0, 'emergency@' || pg_temp.w0(), pg_temp.id('duty5'), 'present', null, 'a2') || '|'
  || pg_temp.mark(0, 'emergency@' || pg_temp.w0(), pg_temp.id('duty5'), 'present', null, 'a2') || '|'
  || pg_temp.mark(0, 'emergency@' || pg_temp.w0(), pg_temp.id('duty5'), 'absent', null, 'a3', 1));
select pg_temp.check_case('7d swapped: the cover must be someone else here',
  'cover_invalid/false|cover_invalid/false|marked/false/swapped',
  pg_temp.mark(0, 'emergency@' || pg_temp.w0(), pg_temp.id('duty5'), 'swapped', 5, 'a4') || '|'
  || pg_temp.mark(0, 'emergency@' || pg_temp.w0(), pg_temp.id('duty5'), 'swapped', 9, 'a5') || '|'
  || pg_temp.mark(0, 'emergency@' || pg_temp.w0(), pg_temp.id('duty5'), 'swapped', 1, 'a6'));
select pg_temp.check_case('7e swapped without a cover, or present with one: invalid', '22023 WORKFORCE_INVALID|22023 WORKFORCE_INVALID',
  pg_temp.mark(0, 'emergency@' || pg_temp.w0(), pg_temp.id('duty5'), 'swapped', null, 'a7') || '|'
  || pg_temp.mark(0, 'emergency@' || pg_temp.w0(), pg_temp.id('duty5'), 'present', 1, 'a8'));
select pg_temp.check_case('7f never one''s own duty; another editor marks it',
  'own_not_allowed/false|marked/false/absent|marked/false/present',
  pg_temp.mark(6, 'maternity@' || pg_temp.w0(), pg_temp.id('duty6'), 'present', null, 'a9') || '|'
  || pg_temp.mark(0, 'maternity@' || pg_temp.w0(), pg_temp.id('duty6'), 'absent', null, 'a10') || '|'
  || pg_temp.mark(6, 'maternity@' || pg_temp.w0(), pg_temp.id('duty3'), 'present', null, 'a11'));
select pg_temp.check_case('7g a duty days away is not open yet; unknown duty and roster',
  'not_open/false|assignment_not_found/false|not_found/false',
  pg_temp.mark(6, 'maternity@' || pg_temp.w1(), pg_temp.duty('maternity@' || pg_temp.w1(), 2, 3, 1), 'present', null, 'a12')
  || '|' || pg_temp.mark(6, 'maternity@' || pg_temp.w1(), 'e1990999-0000-4000-8000-000000000002', 'present', null, 'a13', 1)
  || '|' || pg_temp.mark(6, 'nowhere@' || pg_temp.w1(), pg_temp.id('duty3'), 'present', null, 'a14'));
create function pg_temp.on_duty(n integer, department text default null) returns text language plpgsql as $f$
declare answer record;
begin
  perform pg_temp.act(n);
  select * into answer from identity.duty_roster_on_duty(department);
  return answer.outcome || '/' || coalesce((select string_agg((item->>'departmentCode') || ':'
           || right(item->>'membershipId', 2) || ':' || (item->>'attendance') || ':'
           || coalesce(right(item->>'coveringForMembershipId', 2), '-'), ',' order by ord)
           from jsonb_array_elements(answer.body->'items') with ordinality x(item, ord)), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
select pg_temp.check_case('7h on duty now: the cover for Ebere, Chika present, Femi absent left out; one department; a wrong one',
  'listed/emergency:01:swapped:05,maternity:03:present:-|listed/maternity:03:present:-|department_invalid/',
  pg_temp.on_duty(1) || '|' || pg_temp.on_duty(1, 'maternity') || '|' || pg_temp.on_duty(1, 'dental'));
create function pg_temp.my_duties(n integer) returns text language plpgsql as $f$
declare answer jsonb;
begin
  perform pg_temp.act(n);
  answer := identity.duty_roster_my_duties();
  return coalesce((select string_agg((item->>'departmentCode') || ':' || (item->>'shiftName') || ':'
           || ((item->>'dutyDate')::date - pg_temp.w0()), ',' order by ord)
           from jsonb_array_elements(answer->'items') with ordinality x(item, ord)), '');
exception when others then return sqlstate || ' ' || sqlerrm;
end $f$;
select pg_temp.check_case('7i my duties: published ones only (Ebere''s Sunday duty is on a draft); the cashier has none',
  'maternity:Night:8,maternity:Late:9|emergency:Morning:' || (pg_temp.today() - pg_temp.w0()) || '|',
  pg_temp.my_duties(2) || '|' || pg_temp.my_duties(5) || '|' || pg_temp.my_duties(7));
reset role;
select pg_temp.check_case('7j every mark is kept', 'present,swapped',
  (select string_agg(attendance, ',' order by at, id) from identity.duty_roster_events
    where kind = 'attendance_marked' and assignment_id = pg_temp.id('duty5')));
set local role hid_identity_api_runtime;

-- 8. Keys across files, and the cashier on the roster.
select pg_temp.check_case('8a a leave request''s key reused on a roster save: refused', 'key_reused/false',
  pg_temp.roster_set(0, 'general_outpatient@' || pg_temp.w1(), array['8:1:2'], 'L2-approve'));
select pg_temp.check_case('8b any active member may be on the roster (the cashier)', 'saved/false/1+0-0',
  pg_temp.roster_set(0, 'general_outpatient@' || pg_temp.w1(), array['7:1:2'], 's16'));
select pg_temp.check_case('8c the cashier sees no roster (no code)', '42501 DUTY_ROSTER_NOT_ALLOWED',
  pg_temp.roster_list(7, pg_temp.w1()));

-- 9. Privileges, search_path, temporary tables, append-only.
reset role;
create function pg_temp.try_as_runtime(statement text) returns text language plpgsql as $f$
begin
  execute 'set local role hid_identity_api_runtime';
  execute statement;
  execute 'reset role';
  return 'allowed';
exception when others then
  execute 'reset role';
  return sqlstate;
end $f$;
select pg_temp.check_case('9a no runtime role reads or writes any new table',
  '42501|42501|42501|42501|42501|42501|42501|42501|42501|42501|42501',
  (select string_agg(pg_temp.try_as_runtime(format('select 1 from %s limit 1', name)), '|' order by name)
     from unnest(array['identity.staff_licence_renewals', 'identity.staff_licence_renewal_withdrawals',
       'identity.workforce_department_in_charges', 'identity.staff_leave_requests', 'identity.workforce_events',
       'identity.duty_roster_rules', 'identity.duty_rosters', 'identity.duty_roster_assignments',
       'identity.duty_roster_events']) name)
  || '|' || pg_temp.try_as_runtime('insert into identity.staff_leave_requests default values')
  || '|' || pg_temp.try_as_runtime('update identity.duty_roster_rules set min_rest_minutes = 0'));
select pg_temp.check_case('9b the runtime executes the 21 route functions and none of the 20 helpers', '21/0',
  (select count(*) filter (where proc.prosecdef and has_function_privilege('hid_identity_api_runtime', proc.oid, 'EXECUTE'))
          || '/' || count(*) filter (where not proc.prosecdef
                                        and has_function_privilege('hid_identity_api_runtime', proc.oid, 'EXECUTE'))
     from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'identity'
      and (proc.proname like 'staff\_licence\_status%' or proc.proname like 'staff\_licence\_renewal%'
           or proc.proname in ('staff_licence_member_read', 'staff_licence_export_rows', 'staff_licence_audit')
           or proc.proname like 'workforce\_%' or proc.proname like 'staff\_leave\_%' or proc.proname like 'duty\_roster\_%')));
select pg_temp.check_case('9c every new function has the fixed search_path and no PUBLIC EXECUTE', '0',
  (select count(*)::text from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'identity'
      and (proc.proname like 'staff\_licence\_status%' or proc.proname like 'staff\_licence\_renewal%'
           or proc.proname in ('staff_licence_member_read', 'staff_licence_export_rows', 'staff_licence_audit')
           or proc.proname like 'workforce\_%' or proc.proname like 'staff\_leave\_%' or proc.proname like 'duty\_roster\_%')
      and (proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']
           or has_function_privilege('public', proc.oid, 'EXECUTE'))));
set local role hid_identity_api_runtime;
create function pg_temp.snapshot() returns text language sql as $f$
  select md5(pg_temp.lic_list(0) || pg_temp.leave_to_decide(0, 'decided') || pg_temp.roster_list(0, pg_temp.w1())
    || pg_temp.on_duty(1) || pg_temp.my_duties(2) || pg_temp.leave_mine(1) || pg_temp.in_charge_list(1)
    || ((pg_temp.roster_read(6, 'maternity@' || pg_temp.w1())) - 'outcome')::text)
$f$;
select pg_temp.snapshot() as before_temp_tables \gset
create temporary table staff_leave_requests (id uuid, status text, facility_id uuid, account_id uuid);
create temporary table duty_roster_assignments (id uuid, status text, facility_id uuid, account_id uuid);
create temporary table staff_facility_memberships (id uuid, active boolean, facility_id uuid);
create temporary table facility_profiles (facility_id uuid, departments text[]);
create temporary table staff_licence_renewals (id uuid);
create temporary table workforce_department_in_charges (id uuid);
insert into pg_temp.facility_profiles values (pg_temp.facility_of('f1'), array['dental']);
insert into pg_temp.staff_facility_memberships values (pg_temp.member(9), true, pg_temp.facility_of('f1'));
select pg_temp.check_case('9d temporary tables named like the new and read tables change no answer', :'before_temp_tables',
  pg_temp.snapshot());
reset role;
drop table pg_temp.staff_leave_requests, pg_temp.duty_roster_assignments, pg_temp.staff_facility_memberships,
  pg_temp.facility_profiles, pg_temp.staff_licence_renewals, pg_temp.workforce_department_in_charges;
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'allowed';
exception when others then
  return sqlstate;
end $f$;
select pg_temp.check_case('9e append-only and never deleted, even for the owner (UPDATE, DELETE, TRUNCATE)',
  '55000|55000|55000|55000|55000|55000|55000|55000|55000|55000',
  pg_temp.try('update identity.staff_licence_renewals set checked_how = ''in_person''') || '|'
  || pg_temp.try('delete from identity.staff_licence_renewal_withdrawals') || '|'
  || pg_temp.try('truncate identity.staff_licence_renewals cascade') || '|'
  || pg_temp.try('update identity.workforce_events set to_status = ''ended''') || '|'
  || pg_temp.try('delete from identity.staff_leave_requests') || '|'
  || pg_temp.try('delete from identity.workforce_department_in_charges') || '|'
  || pg_temp.try('delete from identity.duty_rosters') || '|'
  || pg_temp.try('delete from identity.duty_roster_assignments') || '|'
  || pg_temp.try('update identity.duty_roster_events set kept_count = 0') || '|'
  || pg_temp.try('delete from identity.duty_roster_rules'));
select pg_temp.check_case('9f the guard is the database''s own: an overlapping duty written directly is refused', '55000',
  pg_temp.try(format('insert into identity.duty_roster_assignments (roster_id, facility_id, membership_id, account_id,
     shift_id, duty_date, starts_at, ends_at, rest_until, added_by_membership_id, added_by_account_id)
     select roster_id, facility_id, membership_id, account_id, %L, duty_date, starts_at + interval ''1 hour'',
       ends_at + interval ''1 hour'', ends_at, added_by_membership_id, added_by_account_id
       from identity.duty_roster_assignments where id = %L', pg_temp.shift(2), pg_temp.id('duty5'))));

-- 10. Audit.
select pg_temp.check_case('10a a success row for each route''s action',
  'identity.duty-roster.assignments-set|identity.duty-roster.attendance|identity.duty-roster.create|identity.duty-roster.in-charge-add|identity.duty-roster.in-charge-end|identity.duty-roster.list|identity.duty-roster.my-duties|identity.duty-roster.on-duty|identity.duty-roster.publish|identity.duty-roster.read|identity.staff-leave.approve|identity.staff-leave.cancel|identity.staff-leave.list-mine|identity.staff-leave.list-to-decide|identity.staff-leave.request|identity.staff-licence.export|identity.staff-licence.list|identity.staff-licence.member-read|identity.staff-licence.renewal-record|identity.staff-licence.renewal-withdraw',
  (select string_agg(distinct action, '|' order by action) from audit.events
    where outcome = 'success' and source_system = 'identity-api'
      and (action like 'identity.staff-licence.%' or action like 'identity.staff-leave.%'
           or action like 'identity.duty-roster.%')));
select pg_temp.check_case('10b refusals the functions answer are written too (denied or failure)', 'true',
  ((select count(*) from audit.events where outcome in ('denied', 'failure')
      and (action like 'identity.staff-licence.%' or action like 'identity.staff-leave.%'
           or action like 'identity.duty-roster.%')) >= 40)::text);
select pg_temp.check_case('10c no row holds a name, a licence number, a leave type key, leave dates or a reason key', '0',
  (select count(*)::text from audit.events event_row
    where (event_row.action like 'identity.staff-licence.%' or event_row.action like 'identity.staff-leave.%'
           or event_row.action like 'identity.duty-roster.%')
      and (event_row.details::text ~ '(Amaka|Bayo|Chika|Dayo|Ebere|Femi|Gozie|Hadiza|Ikenna|Hrsuite|Hrone|NMCN|MDCN|MLSCN|PCN)'
           or event_row.details ?| array['leaveType', 'startsOn', 'endsOn', 'reason', 'name', 'licenceNumber', 'numberHint']
           or event_row.reason is not null
           or (event_row.action like 'identity.staff-leave.%'
               and exists (select 1 from identity.staff_leave_requests leave_row
                            where event_row.details::text like '%' || to_char(leave_row.starts_on, 'YYYY-MM-DD') || '%'
                               or event_row.details::text like '%' || to_char(leave_row.ends_on, 'YYYY-MM-DD') || '%')))));
select pg_temp.check_case('10d every row is a staff row at its facility, for healthcare operations, by identity-api', '0',
  (select count(*)::text from audit.events
    where (action like 'identity.staff-licence.%' or action like 'identity.staff-leave.%' or action like 'identity.duty-roster.%')
      and (actor_type <> 'staff' or facility_id is null or purpose_of_use <> 'healthcare-operations'
           or patient_id is not null or actor_membership_id is null)));

-- The outcome.
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatch
    from pg_temp.w_outcomes where actual is distinct from expected;
  if mismatch is not null then
    raise exception E'0199-0202 workforce:\n%', mismatch;
  end if;
  raise notice '0199-0202 workforce: % cases passed', (select count(*) from pg_temp.w_outcomes);
end $$;

rollback;
