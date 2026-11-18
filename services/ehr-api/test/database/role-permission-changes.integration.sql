\set ON_ERROR_STOP on
-- 0136 (owner decision Q103 A): the role table's five changes, the staff
-- counts the owner sees before signing, and the prepared undo. Rollback-only.
--   1. after 0001-0136: the thirteen removed rows are gone, the five added
--      rows are there, admin identity.registration.approve and nurse
--      ehr.note.write are kept; each of the five roles holds exactly the
--      permissions listed here (the role-matrix pin for these roles; 0131's
--      identity.patient.open-own-facility row, which 0131's suite pins, is
--      left out);
--   2. back to the table before 0136 for this transaction (the prepared undo
--      docs/rollback/0136_rollback.sql, run here as written, plus taking the
--      five front-desk rows away), and fictional staff at a real hospital and
--      at a sealed QA hospital: one-role and two-role memberships, an
--      inactive membership, a disabled login, a revoked role;
--   3. the read-only counts query docs/rollback/0136_affected_staff_counts.sql,
--      run here as written: for each change, the fictional staff it adds are
--      counted exactly (a membership whose other role keeps the permission
--      after 0136 does not change; an inactive membership, a disabled login
--      and a revoked role are not counted; the sealed hospital is counted
--      apart); its rows say whether each role row is there now;
--   4. 0136 itself, run here as written, applies on that table (its NOTICE
--      lines carry the same numbers), and then for each fictional member,
--      through auth.membership_has_permission (what every service checks):
--      the front desk scans and sees vitals; a doctor loses scan writing,
--      Outreach and the lab and pharmacy work lists but keeps reading jobs
--      and publishing readings, sending to the own laboratory, and the reads
--      of its own orders' progress (ORD-3); a laboratory member loses visits and
--      OCR but keeps its own work; an administrator loses the two work lists
--      but keeps approving new patients and running staff; a member with a
--      second role keeps what that role grants; the nurse is unchanged;
--   5. records processing (0104's trigger, as the Identity runtime): the front
--      desk may now ask for it, doctors and laboratory staff are refused
--      RECORDS_PROCESSING_NOT_ALLOWED, a nurse still may;
--   6. the undo puts back exactly the thirteen rows (and leaves the five
--      front-desk rows), the doctor, laboratory member and administrator get
--      their permissions back, and running it a second time changes nothing.
-- Synthetic values only: uuid prefix c136, @example.invalid addresses.
set plpgsql.variable_conflict = error;
begin;

create temporary table role_change_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;
grant select, insert on role_change_cases to public;
grant usage on sequence role_change_cases_seq_seq to public;
create function pg_temp.expect(case_name text, expected text, actual text) returns void language sql as $$
  insert into role_change_cases (name, expected, actual) values (case_name, expected, coalesce(actual, 'null'));
$$;
grant execute on function pg_temp.expect(text, text, text) to public;

-- A role's permissions as one sorted, space-separated line.
create function pg_temp.role_line(role text) returns text language sql as $$
  select string_agg(permission_code, ' ' order by permission_code) from auth.role_permissions
   where role_code = role and permission_code <> 'identity.patient.open-own-facility';
$$;
-- The thirteen rows 0136 removes and the five it adds.
create function pg_temp.removed_present() returns integer language sql as $$
  select count(*)::integer from auth.role_permissions
   where (role_code, permission_code) in (
     ('doctor', 'ocr.job.write'),
     ('doctor', 'outreach.campaign.read'), ('doctor', 'outreach.campaign.write'),
     ('doctor', 'outreach.registration.read'), ('doctor', 'outreach.registration.write'),
     ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
     ('lab', 'ehr.encounter.read'),
     ('lab', 'ocr.job.read'), ('lab', 'ocr.job.write'), ('lab', 'ocr.validation.write'),
     ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read'));
$$;
create function pg_temp.added_present() returns integer language sql as $$
  select count(*)::integer from auth.role_permissions
   where role_code = 'receptionist'
     and permission_code in ('ehr.document.write', 'ehr.document.read', 'ocr.job.write', 'ocr.job.read',
                             'ehr.vital.read');
$$;

-- 1. The role table after 0001-0136.
select pg_temp.expect('1a the thirteen removed rows are gone', '0', pg_temp.removed_present()::text);
select pg_temp.expect('1b the five front-desk rows are there', '5', pg_temp.added_present()::text);
select pg_temp.expect('1c admin approves new patients, the nurse writes notes', '2',
  (select count(*)::text from auth.role_permissions
    where (role_code, permission_code) in (('admin', 'identity.registration.approve'), ('nurse', 'ehr.note.write'))));
select pg_temp.expect('1d receptionist', 'ehr.document.read ehr.document.write ehr.encounter.read ehr.encounter.write '
  || 'ehr.vital.read identity.authorization.check identity.consent.read identity.consent.write identity.patient.read '
  || 'identity.registration.write ocr.job.read ocr.job.write outreach.campaign.read outreach.campaign.write '
  || 'outreach.registration.read outreach.registration.write', pg_temp.role_line('receptionist'));
select pg_temp.expect('1e doctor', 'ehr.diagnosis.read ehr.diagnosis.write ehr.document.read ehr.document.write '
  || 'ehr.encounter.read ehr.encounter.write ehr.lab-request.read ehr.lab-request.write ehr.note.read ehr.note.write '
  || 'ehr.order-route.send ehr.prescription.read ehr.prescription.write ehr.vital.read ehr.vital.write '
  || 'identity.authorization.check identity.break-glass.write identity.consent.read identity.consent.write '
  || 'identity.patient-access-pin.verify identity.patient.read identity.registration.write lab.import.read '
  || 'lab.import.write lab.result.released.read lab.work-item.accept ocr.job.read ocr.patient.confirm '
  || 'ocr.publication.write ocr.validation.write pharmacy.dispensing.read pharmacy.import.read pharmacy.import.write',
  pg_temp.role_line('doctor'));
select pg_temp.expect('1f lab', 'ehr.document.read ehr.document.write ehr.lab-request.read ehr.lab-request.write '
  || 'identity.authorization.check identity.consent.read identity.consent.write identity.patient.read '
  || 'lab.accession.create lab.accession.read lab.execution.complete lab.execution.read lab.execution.start '
  || 'lab.import.read lab.import.write lab.order-route.receive lab.result.correct lab.result.enter '
  || 'lab.result.entered-in-error lab.result.release lab.result.released.read lab.result.revise-released '
  || 'lab.result.verify lab.specimen.collect lab.specimen.receive lab.specimen.reject lab.work-item.accept '
  || 'lab.work-item.read', pg_temp.role_line('lab'));
select pg_temp.expect('1g admin', 'audit.read identity.registration.approve identity.registration.write '
  || 'lab.accession.read lab.execution.read lab.import.read lab.result.released.read ocr.job.read organization.manage '
  || 'outreach.campaign.read outreach.campaign.write outreach.registration.read outreach.registration.write '
  || 'pharmacy.dispensing.read pharmacy.import.read workforce.manage', pg_temp.role_line('admin'));
select pg_temp.expect('1h nurse (unchanged by 0136)', 'ehr.diagnosis.read ehr.document.read ehr.document.write '
  || 'ehr.encounter.read ehr.encounter.write ehr.lab-request.read ehr.note.read ehr.note.write ehr.prescription.read '
  || 'ehr.vital.read ehr.vital.write identity.authorization.check identity.break-glass.write identity.consent.read '
  || 'identity.consent.write identity.patient-access-pin.verify identity.patient.read identity.registration.write '
  || 'lab.import.read lab.import.write lab.result.released.read lab.work-item.accept lab.work-item.read ocr.job.read '
  || 'ocr.job.write ocr.patient.confirm ocr.publication.write ocr.validation.write outreach.campaign.read '
  || 'outreach.campaign.write outreach.registration.read outreach.registration.write pharmacy.dispensing.read '
  || 'pharmacy.import.read pharmacy.import.write pharmacy.work-item.read', pg_temp.role_line('nurse'));
select pg_temp.expect('1i org_admin holds neither work list (untouched)', '0',
  (select count(*)::text from auth.role_permissions
    where role_code = 'org_admin' and permission_code in ('lab.work-item.read', 'pharmacy.work-item.read')));

-- 2. Back to the table before 0136, for this transaction: the prepared undo as
-- written, then the five front-desk rows taken away.
\ir ../../../../docs/rollback/0136_rollback.sql
delete from auth.role_permissions
 where role_code = 'receptionist'
   and permission_code in ('ehr.document.write', 'ehr.document.read', 'ocr.job.write', 'ocr.job.read', 'ehr.vital.read');
select pg_temp.expect('2a before 0136: the thirteen rows are there', '13', pg_temp.removed_present()::text);
select pg_temp.expect('2b before 0136: no front-desk row yet', '0', pg_temp.added_present()::text);

-- The counts query's answer, kept as rows.
create temporary table counts_seen (
  label text, position integer, change text, row_there_now boolean, real_with_role integer, real_changing integer,
  real_logins integer, sealed_with_role integer, sealed_changing integer
) on commit drop;
create temporary table counts_load (
  position integer, change text, row_there_now boolean, real_with_role integer, real_changing integer,
  real_logins integer, sealed_with_role integer, sealed_changing integer
) on commit drop;

-- 3a. The counts before the fictional staff exist (whatever the database
-- already holds), so 3c compares only what the fixtures add.
\set QUIET on
\pset format csv
\pset tuples_only on
\o /tmp/hid-0136-counts.csv
\ir ../../../../docs/rollback/0136_affected_staff_counts.sql
\o
\pset format aligned
\pset tuples_only off
\copy counts_load from '/tmp/hid-0136-counts.csv' with (format csv)
insert into counts_seen select 'baseline', * from counts_load;
truncate counts_load;
\set QUIET off

-- Fixtures. Organisation O; Hospital F1 (real) and QA Hospital F2 (recorded
-- as a sealed QA facility). Members (n): 1 receptionist; 2 receptionist and
-- nurse; 3 doctor; 4 doctor and nurse; 5 doctor, membership inactive; 6
-- doctor, login disabled; 7 lab; 8 lab, role revoked; 9 admin; 10 admin and
-- doctor; 11 doctor at the sealed F2; 12 nurse. Patient P1, 40 years old.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('c1366000-0000-4000-8000-000000000001', 'Role Change Test Org', 'role-change-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('c1366000-0000-4000-8000-000000000002', 'c1366000-0000-4000-8000-000000000001', 'Role Change Hospital',
   'RC-136-A', 'Africa/Lagos', true, 'verified'),
  ('c1366000-0000-4000-8000-000000000003', 'c1366000-0000-4000-8000-000000000001', 'Role Change QA Hospital',
   'RC-136-Q', 'Africa/Lagos', true, 'verified');
insert into identity.sealed_qa_members (member_kind, member_id) values
  ('facility', 'c1366000-0000-4000-8000-000000000003');
create temporary table rc_member (n integer primary key, facility text, roles text[], membership_active boolean,
  account_status text, revoked boolean) on commit drop;
grant select on rc_member to public;
insert into rc_member values
  (1, '2', array['receptionist'], true, 'active', false),
  (2, '2', array['receptionist', 'nurse'], true, 'active', false),
  (3, '2', array['doctor'], true, 'active', false),
  (4, '2', array['doctor', 'nurse'], true, 'active', false),
  (5, '2', array['doctor'], false, 'active', false),
  (6, '2', array['doctor'], true, 'disabled', false),
  (7, '2', array['lab'], true, 'active', false),
  (8, '2', array['lab'], true, 'active', true),
  (9, '2', array['admin'], true, 'active', false),
  (10, '2', array['admin', 'doctor'], true, 'active', false),
  (11, '3', array['doctor'], true, 'active', false),
  (12, '2', array['nurse'], true, 'active', false);
create function pg_temp.rc_id(kind text, n integer) returns uuid language sql immutable as $$
  select ('c136' || kind || '000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid;
$$;
grant execute on function pg_temp.rc_id(text, integer) to public;
insert into auth.accounts (id, subject, email, display_name, status)
select pg_temp.rc_id('1', n), 'staff:role-change-' || n, 'role-change-' || n || '@example.invalid',
  'Role Change Staff ' || n, account_status
  from rc_member;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select pg_temp.rc_id('2', n), pg_temp.rc_id('1', n), 'Role Change Staff ' || n, 'role-change-' || n || '@example.invalid',
  'verified', roles[1]
  from rc_member;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select pg_temp.rc_id('3', n), pg_temp.rc_id('2', n), pg_temp.rc_id('1', n), 'c1366000-0000-4000-8000-000000000001',
  ('c1366000-0000-4000-8000-00000000000' || facility)::uuid, roles[1], roles[1], true, membership_active
  from rc_member;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason,
  granted_at, revoked_at, revoked_by, revocation_reason)
select ('c1364000-0000-4000-8000-0000000' || lpad((member.n * 10 + role_row.k)::text, 5, '0'))::uuid,
  pg_temp.rc_id('1', member.n), role_row.role_code, 'facility', pg_temp.rc_id('3', member.n),
  ('c1366000-0000-4000-8000-00000000000' || member.facility)::uuid, 'Synthetic 0136 suite role',
  clock_timestamp() - interval '1 day',
  case when member.revoked then clock_timestamp() end,
  case when member.revoked then pg_temp.rc_id('1', 9) end,
  case when member.revoked then 'Synthetic 0136 suite revocation' end
  from rc_member member
  cross join lateral unnest(member.roles) with ordinality role_row(role_code, k);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, status) values
  ('c1365000-0000-4000-8000-000000000001', 'HID-ZQRPCX', 'Role', 'Change Patient', 'Role Change Patient',
   ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '40 years')::date, 'active');
set local session_replication_role = origin;

-- 3b. The counts with the fictional staff, before 0136.
\set QUIET on
\pset format csv
\pset tuples_only on
\o /tmp/hid-0136-counts.csv
\ir ../../../../docs/rollback/0136_affected_staff_counts.sql
\o
\pset format aligned
\pset tuples_only off
\copy counts_load from '/tmp/hid-0136-counts.csv' with (format csv)
insert into counts_seen select 'before', * from counts_load;
truncate counts_load;
\set QUIET off

-- 3c. What the fixtures add to each count: real memberships with the role,
-- real memberships that change, real logins that change, sealed memberships
-- with the role, sealed memberships that change; and whether the row is there.
select pg_temp.expect('3c ' || lpad(wanted.position::text, 2, '0') || ' ' || wanted.change,
  wanted.counts || ' there=' || wanted.there,
  (select (before.real_with_role - baseline.real_with_role) || '/' || (before.real_changing - baseline.real_changing)
          || '/' || (before.real_logins - baseline.real_logins) || '/'
          || (before.sealed_with_role - baseline.sealed_with_role) || '/'
          || (before.sealed_changing - baseline.sealed_changing) || ' there=' || before.row_there_now
     from counts_seen before join counts_seen baseline on baseline.position = before.position
    where before.label = 'before' and baseline.label = 'baseline' and before.position = wanted.position
      and before.change = wanted.change and baseline.change = wanted.change))
  from (values
    (1, 'receptionist gains ehr.document.write', '2/1/1/0/0', false),
    (2, 'receptionist gains ehr.document.read', '2/1/1/0/0', false),
    (3, 'receptionist gains ocr.job.write', '2/1/1/0/0', false),
    (4, 'receptionist gains ocr.job.read', '2/1/1/0/0', false),
    (5, 'receptionist gains ehr.vital.read', '2/1/1/0/0', false),
    (6, 'doctor loses ocr.job.write', '3/2/2/1/1', true),
    (7, 'doctor loses outreach.campaign.read', '3/1/1/1/1', true),
    (8, 'doctor loses outreach.campaign.write', '3/1/1/1/1', true),
    (9, 'doctor loses outreach.registration.read', '3/1/1/1/1', true),
    (10, 'doctor loses outreach.registration.write', '3/1/1/1/1', true),
    (11, 'doctor loses lab.work-item.read', '3/2/2/1/1', true),
    (12, 'doctor loses pharmacy.work-item.read', '3/2/2/1/1', true),
    (13, 'lab loses ehr.encounter.read', '1/1/1/0/0', true),
    (14, 'lab loses ocr.job.read', '1/1/1/0/0', true),
    (15, 'lab loses ocr.job.write', '1/1/1/0/0', true),
    (16, 'lab loses ocr.validation.write', '1/1/1/0/0', true),
    (17, 'admin loses lab.work-item.read', '2/2/2/0/0', true),
    (18, 'admin loses pharmacy.work-item.read', '2/2/2/0/0', true)) wanted(position, change, counts, there);
select pg_temp.expect('3d the counts answer eighteen rows, numbers only',
  '18 rows; columns position change row_there_now real_with_role real_changing real_logins sealed_with_role sealed_changing',
  (select count(*) || ' rows' from counts_seen where label = 'before')
  || '; columns position change row_there_now real_with_role real_changing real_logins sealed_with_role sealed_changing');

-- 4. 0136 as written, on the table before it (its NOTICE lines are the counts).
\ir ../../database/migrations/0136_role_permission_changes.sql
select pg_temp.expect('4a 0136 applied: removed rows', '0', pg_temp.removed_present()::text);
select pg_temp.expect('4b 0136 applied: added rows', '5', pg_temp.added_present()::text);

-- Each fictional member's permissions at its facility, as every service reads
-- them.
create function pg_temp.holds(n integer, permission text) returns boolean language sql as $$
  select coalesce(auth.membership_has_permission('staff:role-change-' || n, pg_temp.rc_id('3', n),
    ('c1366000-0000-4000-8000-00000000000' || (select facility from rc_member where rc_member.n = $1))::uuid,
    permission), false);
$$;
create function pg_temp.holding(n integer, permissions text[]) returns text language sql as $$
  select coalesce(string_agg(case when pg_temp.holds(n, wanted) then wanted else '-' end, ' '
                             order by ordinal), '')
    from unnest(permissions) with ordinality wanted(wanted, ordinal);
$$;
grant execute on function pg_temp.holds(integer, text), pg_temp.holding(integer, text[]) to public;

create function pg_temp.check_members(stage text) returns void language plpgsql as $$
declare
  desk text[] := array['ehr.document.write', 'ehr.document.read', 'ocr.job.write', 'ocr.job.read', 'ehr.vital.read'];
  doctor_lost text[] := array['ocr.job.write', 'outreach.campaign.read', 'outreach.campaign.write',
    'outreach.registration.read', 'outreach.registration.write', 'lab.work-item.read', 'pharmacy.work-item.read'];
  doctor_kept text[] := array['ocr.job.read', 'ocr.validation.write', 'ocr.patient.confirm', 'ocr.publication.write',
    'lab.work-item.accept', 'ehr.lab-request.read', 'ehr.prescription.read', 'lab.result.released.read',
    'ehr.prescription.write', 'ehr.lab-request.write', 'ehr.order-route.send', 'ehr.document.write'];
  lab_lost text[] := array['ehr.encounter.read', 'ocr.job.read', 'ocr.job.write', 'ocr.validation.write'];
  lab_kept text[] := array['lab.work-item.read', 'lab.work-item.accept', 'lab.order-route.receive', 'lab.result.enter',
    'lab.result.release', 'ehr.lab-request.read', 'ehr.lab-request.write'];
  admin_lost text[] := array['lab.work-item.read', 'pharmacy.work-item.read'];
  admin_kept text[] := array['identity.registration.approve', 'workforce.manage', 'organization.manage', 'audit.read'];
  nurse_all text[] := array['ehr.note.write', 'ocr.job.write', 'outreach.campaign.read', 'lab.work-item.read',
    'pharmacy.work-item.read', 'ehr.vital.read'];
  after boolean := stage = 'after 0136';
  function_of text;
begin
  function_of := array_to_string(desk, ' ');
  perform pg_temp.expect(stage || ': front desk (1) scans and sees vitals',
    case when after then function_of else '- - - - -' end, pg_temp.holding(1, desk));
  perform pg_temp.expect(stage || ': front desk with a nurse role (2) has them either way', function_of,
    pg_temp.holding(2, desk));
  perform pg_temp.expect(stage || ': doctor (3) loses scan writing, Outreach and the work lists',
    case when after then '- - - - - - -' else array_to_string(doctor_lost, ' ') end, pg_temp.holding(3, doctor_lost));
  perform pg_temp.expect(stage || ': doctor (3) keeps reading jobs, publishing, sending and its orders'' progress',
    array_to_string(doctor_kept, ' '), pg_temp.holding(3, doctor_kept));
  perform pg_temp.expect(stage || ': doctor with a nurse role (4) keeps them through the nurse role',
    array_to_string(doctor_lost, ' '), pg_temp.holding(4, doctor_lost));
  perform pg_temp.expect(stage || ': lab member (7) loses visits and OCR',
    case when after then '- - - -' else array_to_string(lab_lost, ' ') end, pg_temp.holding(7, lab_lost));
  perform pg_temp.expect(stage || ': lab member (7) keeps its own work', array_to_string(lab_kept, ' '),
    pg_temp.holding(7, lab_kept));
  perform pg_temp.expect(stage || ': admin (9) loses the two work lists',
    case when after then '- -' else array_to_string(admin_lost, ' ') end, pg_temp.holding(9, admin_lost));
  perform pg_temp.expect(stage || ': admin (9) keeps approving new patients and running staff',
    array_to_string(admin_kept, ' '), pg_temp.holding(9, admin_kept));
  perform pg_temp.expect(stage || ': admin and doctor (10) loses the work lists from both roles',
    case when after then '- -' else array_to_string(admin_lost, ' ') end, pg_temp.holding(10, admin_lost));
  perform pg_temp.expect(stage || ': admin and doctor (10) keeps Outreach through the admin role',
    'outreach.campaign.read outreach.registration.write',
    pg_temp.holding(10, array['outreach.campaign.read', 'outreach.registration.write']));
  perform pg_temp.expect(stage || ': nurse (12) unchanged', array_to_string(nurse_all, ' '),
    pg_temp.holding(12, nurse_all));
  perform pg_temp.expect(stage || ': inactive membership (5), disabled login (6), revoked role (8) hold nothing',
    '- - -', pg_temp.holding(5, array['ehr.encounter.read']) || ' ' || pg_temp.holding(6, array['ehr.encounter.read'])
      || ' ' || pg_temp.holding(8, array['lab.work-item.read']));
end $$;
select pg_temp.check_members('after 0136');

-- 5. Records processing (0104's trigger), as the Identity API runtime.
create function pg_temp.ask_records_processing(n integer) returns text language plpgsql as $$
declare
  outcome record;
begin
  perform set_config('app.actor_subject', 'staff:role-change-' || n, true),
    set_config('app.facility_id', 'c1366000-0000-4000-8000-000000000002', true),
    set_config('app.membership_id', pg_temp.rc_id('3', n)::text, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true),
    set_config('app.correlation_id', 'role-change-records-processing-' || n, true);
  select * into outcome from identity.create_access_request('HID-ZQRPCX', 'read_records',
    'Turn paper records into the digital record (OCR)', 60);
  return 'ok ' || outcome.request_status || ' ' || outcome.request_purpose;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.ask_records_processing(integer) to public;
set local role hid_identity_api_runtime;
select pg_temp.expect('5a the front desk (1) may ask for records processing', 'ok pending healthcare-operations',
  pg_temp.ask_records_processing(1));
select pg_temp.expect('5b a doctor (3) is refused', '42501 RECORDS_PROCESSING_NOT_ALLOWED',
  pg_temp.ask_records_processing(3));
select pg_temp.expect('5c a laboratory member (7) is refused', '42501 RECORDS_PROCESSING_NOT_ALLOWED',
  pg_temp.ask_records_processing(7));
select pg_temp.expect('5d a nurse (12) still may', 'ok pending healthcare-operations',
  pg_temp.ask_records_processing(12));
reset role;

-- 6. The prepared undo, as written: exactly the thirteen rows back, the five
-- front-desk rows left; twice changes nothing.
\ir ../../../../docs/rollback/0136_rollback.sql
select pg_temp.expect('6a undo: the thirteen rows are back', '13', pg_temp.removed_present()::text);
select pg_temp.expect('6b undo: the front-desk rows stay', '5', pg_temp.added_present()::text);
select pg_temp.expect('6c undo: doctor, lab member and admin get their permissions back',
  'ocr.job.write lab.work-item.read | ehr.encounter.read ocr.job.write | lab.work-item.read pharmacy.work-item.read',
  pg_temp.holding(3, array['ocr.job.write', 'lab.work-item.read']) || ' | '
  || pg_temp.holding(7, array['ehr.encounter.read', 'ocr.job.write']) || ' | '
  || pg_temp.holding(9, array['lab.work-item.read', 'pharmacy.work-item.read']));
create temporary table rows_after_undo on commit drop as
  select role_code, permission_code from auth.role_permissions;
\ir ../../../../docs/rollback/0136_rollback.sql
select pg_temp.expect('6d undo a second time: the table is the same', '0 0',
  (select count(*) from (select role_code, permission_code from auth.role_permissions
                         except select role_code, permission_code from rows_after_undo) more)
  || ' ' || (select count(*) from (select role_code, permission_code from rows_after_undo
                                   except select role_code, permission_code from auth.role_permissions) fewer));

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, actual), E'\n' order by seq) into failures
    from role_change_cases where expected is distinct from actual;
  if failures is not null then
    raise exception E'0136 role changes suite failed:\n%', failures;
  end if;
  raise notice '0136 role changes suite: % cases passed', (select count(*) from role_change_cases);
end $$;

rollback;
