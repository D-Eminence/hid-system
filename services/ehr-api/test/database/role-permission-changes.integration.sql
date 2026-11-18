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
--      their permissions back, and running it a second time changes nothing;
--   7. what follows (the counts' lines 19-23 and 0136's step 3): a clinic with
--      doctors and a front desk only, and a laboratory, are counted as left
--      with nobody who can check a reading; the clinic as one where a reading
--      can be started but never checked or its patient confirmed; their
--      readings not yet checked are counted; and the open records-processing
--      requests of a doctor and a laboratory member are counted, then closed
--      by 0136 (status expired, one audit row each with the plain reason),
--      while a doctor with a nurse role, a direct-care request and an approved
--      request are left as they are.
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
-- The query answers two tables (lines 1-18 with eight columns, lines 19-22
-- with four), which psql writes into one CSV file, read back line by line,
-- and line 23 as a NOTICE and in the session setting
-- zero136.unchecked_readings.
create temporary table counts_raw (line text) on commit drop;
create temporary table consequences_seen (
  label text, position integer, consequence text, real_count bigint, sealed_count bigint
) on commit drop;
create function pg_temp.load_counts(label text) returns void language plpgsql as $$
begin
  insert into counts_seen
  select label, field[1]::integer, field[2], field[3]::boolean, field[4]::integer, field[5]::integer,
         field[6]::integer, field[7]::integer, field[8]::integer
    from (select string_to_array(raw.line, ',') as field from counts_raw raw) parsed
   where cardinality(field) = 8;
  insert into consequences_seen
  select label, field[1]::integer, field[2], field[3]::bigint, field[4]::bigint
    from (select string_to_array(raw.line, ',') as field from counts_raw raw) parsed
   where cardinality(field) = 4;
  -- Line 23 comes from the query's last block, through its session setting.
  insert into consequences_seen
  select label, 23, 'readings not yet checked at the facilities of line 19',
         split_part(current_setting('zero136.unchecked_readings'), '/', 1)::bigint,
         split_part(current_setting('zero136.unchecked_readings'), '/', 2)::bigint;
  if (select count(*) from counts_raw) <> 22
     or (select count(*) from counts_raw raw where cardinality(string_to_array(raw.line, ',')) not in (4, 8)) > 0 then
    raise exception 'the counts query answered % lines, expected 18 and 4', (select count(*) from counts_raw);
  end if;
  truncate counts_raw;
end $$;

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
\copy counts_raw from '/tmp/hid-0136-counts.csv'
select pg_temp.load_counts('baseline');
\set QUIET off

-- Fixtures. Organisation O; Hospital F1 (real) and QA Hospital F2 (recorded
-- as a sealed QA facility); Clinic F4 (real: doctors and a front desk, no
-- nurse or clinician) and Laboratory F5 (real: laboratory staff only).
-- Members (n): 1 receptionist; 2 receptionist and nurse; 3 doctor; 4 doctor
-- and nurse; 5 doctor, membership inactive; 6 doctor, login disabled; 7 lab;
-- 8 lab, role revoked; 9 admin; 10 admin and doctor; 11 doctor at the sealed
-- F2; 12 nurse; 13 doctor at F4; 14 receptionist at F4; 15 lab at F5.
-- Patient P1, 40 years old. OCR jobs: not yet checked at F1 (1), F2 (1), F4
-- (2) and F5 (1); one already checked at F4. Access requests from P1's
-- point of view: pending records processing from 3, 4, 7 and 11; a pending
-- direct-care request from 3; an approved records-processing request from 3.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('c1366000-0000-4000-8000-000000000001', 'Role Change Test Org', 'role-change-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('c1366000-0000-4000-8000-000000000002', 'c1366000-0000-4000-8000-000000000001', 'Role Change Hospital',
   'RC-136-A', 'Africa/Lagos', true, 'verified'),
  ('c1366000-0000-4000-8000-000000000003', 'c1366000-0000-4000-8000-000000000001', 'Role Change QA Hospital',
   'RC-136-Q', 'Africa/Lagos', true, 'verified'),
  ('c1366000-0000-4000-8000-000000000004', 'c1366000-0000-4000-8000-000000000001', 'Role Change Clinic',
   'RC-136-C', 'Africa/Lagos', true, 'verified'),
  ('c1366000-0000-4000-8000-000000000005', 'c1366000-0000-4000-8000-000000000001', 'Role Change Laboratory',
   'RC-136-L', 'Africa/Lagos', true, 'verified');
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
  (12, '2', array['nurse'], true, 'active', false),
  (13, '4', array['doctor'], true, 'active', false),
  (14, '4', array['receptionist'], true, 'active', false),
  (15, '5', array['lab'], true, 'active', false);
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
-- OCR jobs (k, facility, member who started it, status).
insert into ocr.jobs (id, facility_id, document_id, patient_id, source_object_version_id, source_sha256_hex, status,
  idempotency_key, request_sha256, provider, created_by, created_by_membership_id, correlation_id, completed_at)
select ('c1367000-0000-4000-8000-0000000000' || lpad(job.k::text, 2, '0'))::uuid,
  ('c1366000-0000-4000-8000-00000000000' || job.facility)::uuid,
  ('c1368000-0000-4000-8000-0000000000' || lpad(job.k::text, 2, '0'))::uuid,
  'c1365000-0000-4000-8000-000000000001', 'role-change-version-' || job.k, repeat('a', 64), job.status,
  'role-change-job-0136-' || job.k, repeat('b', 64), 'textract', pg_temp.rc_id('1', job.member),
  pg_temp.rc_id('3', job.member), 'role-change-job-' || job.k,
  case when job.status = 'validated' then clock_timestamp() end
  from (values (1, '2', 2, 'awaiting_validation'), (2, '3', 11, 'awaiting_validation'), (3, '4', 13, 'awaiting_validation'),
               (4, '4', 13, 'queued'), (5, '4', 13, 'validated'), (6, '5', 15, 'extracted'))
       job(k, facility, member, status);
-- Access requests (k, member, purpose, status).
insert into identity.access_requests (id, patient_id, staff_id, membership_id, facility_id, scope, reason, status,
  requested_duration_minutes, purpose_of_use, approved_by_patient_id, approved_at, correlation_id)
select ('c1369000-0000-4000-8000-0000000000' || lpad(request.k::text, 2, '0'))::uuid,
  'c1365000-0000-4000-8000-000000000001', pg_temp.rc_id('2', request.member), pg_temp.rc_id('3', request.member),
  ('c1366000-0000-4000-8000-00000000000' || (select facility from rc_member where n = request.member))::uuid,
  'read_records', 'Turn paper records into the digital record (OCR)', request.status, 60, request.purpose,
  case when request.status = 'approved' then 'c1365000-0000-4000-8000-000000000001'::uuid end,
  case when request.status = 'approved' then clock_timestamp() end, 'role-change-request-' || request.k
  from (values (1, 3, 'healthcare-operations', 'pending'), (2, 4, 'healthcare-operations', 'pending'),
               (3, 7, 'healthcare-operations', 'pending'), (4, 11, 'healthcare-operations', 'pending'),
               (5, 3, 'direct-care', 'pending'), (6, 3, 'healthcare-operations', 'approved'))
       request(k, member, purpose, status);
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
\copy counts_raw from '/tmp/hid-0136-counts.csv'
select pg_temp.load_counts('before');
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
    (1, 'receptionist gains ehr.document.write', '3/2/2/0/0', false),
    (2, 'receptionist gains ehr.document.read', '3/2/2/0/0', false),
    (3, 'receptionist gains ocr.job.write', '3/2/2/0/0', false),
    (4, 'receptionist gains ocr.job.read', '3/2/2/0/0', false),
    (5, 'receptionist gains ehr.vital.read', '3/2/2/0/0', false),
    (6, 'doctor loses ocr.job.write', '4/3/3/1/1', true),
    (7, 'doctor loses outreach.campaign.read', '4/2/2/1/1', true),
    (8, 'doctor loses outreach.campaign.write', '4/2/2/1/1', true),
    (9, 'doctor loses outreach.registration.read', '4/2/2/1/1', true),
    (10, 'doctor loses outreach.registration.write', '4/2/2/1/1', true),
    (11, 'doctor loses lab.work-item.read', '4/3/3/1/1', true),
    (12, 'doctor loses pharmacy.work-item.read', '4/3/3/1/1', true),
    (13, 'lab loses ehr.encounter.read', '2/2/2/0/0', true),
    (14, 'lab loses ocr.job.read', '2/2/2/0/0', true),
    (15, 'lab loses ocr.job.write', '2/2/2/0/0', true),
    (16, 'lab loses ocr.validation.write', '2/2/2/0/0', true),
    (17, 'admin loses lab.work-item.read', '2/2/2/0/0', true),
    (18, 'admin loses pharmacy.work-item.read', '2/2/2/0/0', true)) wanted(position, change, counts, there);
-- 3e. What follows: real/sealed counts the fixtures add to lines 19-23.
select pg_temp.expect('3e ' || wanted.position || ' ' || wanted.consequence, wanted.counts,
  (select (before.real_count - baseline.real_count) || '/' || (before.sealed_count - baseline.sealed_count)
     from consequences_seen before join consequences_seen baseline on baseline.position = before.position
    where before.label = 'before' and baseline.label = 'baseline' and before.position = wanted.position
      and before.consequence = wanted.consequence and baseline.consequence = wanted.consequence))
  from (values
    -- F4 (doctors and a desk) and F5 (laboratory); sealed F2 (a doctor only). F1 keeps its nurses.
    (19, 'facilities where staff can check a reading today and nobody can after 0136', '2/1'),
    -- F4: the desk can start a reading there and nobody can check it. F5 and F2: nobody can start one.
    (20, 'facilities where after 0136 staff can start a reading and nobody can check it', '1/0'),
    (21, 'facilities where after 0136 staff can start a reading and nobody can confirm its patient', '1/0'),
    -- The doctor (3) and the laboratory member (7); the sealed doctor (11). Not the doctor with
    -- a nurse role (4), the direct-care request or the approved one.
    (22, 'open records-processing requests from staff who lose ocr.job.write (0136 closes them)', '2/1'),
    -- F4's two and F5's one (F4's checked job and F1's job are not counted); F2's one.
    (23, 'readings not yet checked at the facilities of line 19', '3/1'))
    wanted(position, consequence, counts);
select pg_temp.expect('3d the counts answer eighteen rows, numbers only',
  '18 rows; columns position change row_there_now real_with_role real_changing real_logins sealed_with_role sealed_changing',
  (select count(*) || ' rows' from counts_seen where label = 'before')
  || '; columns position change row_there_now real_with_role real_changing real_logins sealed_with_role sealed_changing');

-- 4. 0136 as written, on the table before it (its NOTICE lines are the counts).
\ir ../../database/migrations/0136_role_permission_changes.sql
select pg_temp.expect('4a 0136 applied: removed rows', '0', pg_temp.removed_present()::text);
select pg_temp.expect('4b 0136 applied: added rows', '5', pg_temp.added_present()::text);
select pg_temp.expect('4c 0136 closed the records-processing requests of the doctor, the laboratory member and the sealed doctor',
  '1 expired, 2 pending, 3 expired, 4 expired, 5 pending, 6 approved',
  (select string_agg(right(id::text, 1) || ' ' || status, ', ' order by id) from identity.access_requests
    where id::text like 'c1369000-%'));
select pg_temp.expect('4d one audit row per closed request: system, the plain reason, no staff or patient detail beyond ids',
  '3 system identity.access-request.close success This staff member can no longer process records migration',
  (select count(*) || ' ' || min(actor_type) || ' ' || min(action) || ' ' || min(outcome) || ' ' || min(reason) || ' '
          || min(provenance)
     from audit.events
    where resource_type = 'access-request' and resource_id like 'c1369000-%' and correlation_id = '0136-role-permission-changes'
      and actor_subject is null and patient_id = 'c1365000-0000-4000-8000-000000000001'));
select pg_temp.expect('4e the count 0136 printed for line 22 is the number it closed', '3',
  (select (sum(before.real_count + before.sealed_count) - sum(baseline.real_count + baseline.sealed_count))::text
     from consequences_seen before join consequences_seen baseline on baseline.position = before.position
    where before.label = 'before' and baseline.label = 'baseline' and before.position = 22));

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

-- What the owner signs for the front desk (contract, "Before signing"): with
-- the patient's access, the desk can open the patient's stored documents at
-- the facility (ehr.document.read: list and download) and the text read from
-- them (ocr.job.read: extractions, validations, publications), but holds no
-- clinical note, diagnosis or prescription read.
select pg_temp.expect('4f the front desk (1) reads documents and reading text, and no clinical record',
  'ehr.document.read ocr.job.read - - - -',
  pg_temp.holding(1, array['ehr.document.read', 'ocr.job.read', 'ehr.note.read', 'ehr.diagnosis.read',
    'ehr.prescription.read', 'ehr.lab-request.read']));

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
