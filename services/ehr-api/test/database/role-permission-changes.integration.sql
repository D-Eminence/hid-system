\set ON_ERROR_STOP on
-- 0136 (owner decisions Q103 A, Q111 A, Q112 A, Q113 A): the role table's
-- changes, the staff counts DevOps runs before signing, the owner's maximums
-- and the stop, and the prepared undo. Rollback-only.
--   1. after 0001-0136: the twelve removed rows are gone, the eight added rows
--      and the three new codes are there, the rows kept on purpose are there
--      (doctors keep ocr.job.write, ocr.validation.write and
--      ocr.patient.confirm, Q111 A); each of the six roles holds exactly the
--      permissions listed here (the role-matrix pin for these roles; 0131's
--      identity.patient.open-own-facility row, which 0131's suite pins, is
--      left out);
--   2. back to the table before 0136 for this transaction (the prepared undo
--      docs/rollback/0136_rollback.sql, run here as written, then the rows
--      and codes 0136 added taken away), and fictional staff at a real
--      hospital, a real clinic, a real laboratory, a real front-desk-only
--      clinic and a sealed QA hospital: one-role and two-role memberships, an
--      inactive membership, a disabled login, a revoked role;
--   3. the read-only counts file docs/rollback/0136_affected_staff_counts.sql,
--      run here as written: for each of its 26 lines, what the fictional
--      staff add is counted exactly (a membership whose other role keeps the
--      permission does not change; an inactive membership, a disabled login
--      and a revoked role are not counted; the sealed hospital is counted
--      apart); with the owner's maximums set as 0136 sets them, the same
--      block passes at the counted numbers and names each line that is
--      higher, or not filled in (Q113 A);
--   4. 0136 itself, run here as written: its maximums are 0 at real
--      facilities (Q113 A: no real staff active yet), so with fictional
--      staff at real facilities affected it stops (55000, "0136 stopped,
--      nothing was changed"), and its count is the counts file's, number for
--      number. (A fresh build, with only the sealed tenants' staff, applies
--      it: see 1.) The
--      suite then lets the rest of the file run (psql ON_ERROR_ROLLBACK
--      undoes only the stop; the migration runner, which runs the file as
--      one transaction, applies nothing) and checks, for each fictional
--      member, through auth.membership_has_permission (what every service
--      checks): the front desk scans, starts readings and sees its own
--      uploads and vitals, with neither full read nor any clinical read;
--      doctors keep checking and confirming (ocr.job.write) but cannot start
--      a reading (no ocr.job.start); nurses and clinicians start readings as
--      before; laboratory staff lose visits and OCR; administrators lose the
--      two work lists; a member with a second role keeps what that role
--      grants;
--   5. records processing (0104's trigger, as the Identity runtime): the
--      front desk and doctors may ask for it, laboratory staff are refused
--      RECORDS_PROCESSING_NOT_ALLOWED, a nurse still may;
--   6. the undo, as written, gives doctors, laboratory staff and
--      administrators back what they could do before 0136 (with ocr.job.start
--      for doctors and laboratory staff), leaves the front-desk rows, and a
--      second run changes nothing;
--   7. what follows: the laboratory is counted as left with nobody who can
--      check a reading, the front-desk-only clinic as one where a reading can
--      be started but never checked or its patient confirmed, the
--      laboratory's reading not yet checked is counted, and the laboratory
--      member's open records-processing request is counted and closed by
--      0136 (status expired, one audit row with the plain reason), while the
--      doctors' requests, a direct-care request and an approved request are
--      left as they are; after 0136 the counts file refuses to count again.
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
-- The twelve rows 0136 removes, the eight it adds and the three codes it creates.
create function pg_temp.removed_present() returns integer language sql as $$
  select count(*)::integer from auth.role_permissions
   where (role_code, permission_code) in (
     ('doctor', 'outreach.campaign.read'), ('doctor', 'outreach.campaign.write'),
     ('doctor', 'outreach.registration.read'), ('doctor', 'outreach.registration.write'),
     ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
     ('lab', 'ehr.encounter.read'),
     ('lab', 'ocr.job.read'), ('lab', 'ocr.job.write'), ('lab', 'ocr.validation.write'),
     ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read'));
$$;
create function pg_temp.added_present() returns integer language sql as $$
  select count(*)::integer from auth.role_permissions
   where (role_code, permission_code) in (
     ('receptionist', 'ehr.document.write'), ('receptionist', 'ehr.document.read-own'),
     ('receptionist', 'ocr.job.write'), ('receptionist', 'ocr.job.start'),
     ('receptionist', 'ocr.job.read-own'), ('receptionist', 'ehr.vital.read'),
     ('nurse', 'ocr.job.start'), ('clinician', 'ocr.job.start'));
$$;
create function pg_temp.codes_present() returns integer language sql as $$
  select count(*)::integer from auth.permissions
   where code in ('ocr.job.start', 'ocr.job.read-own', 'ehr.document.read-own') and active;
$$;

-- 1. The role table after 0001-0136.
select pg_temp.expect('1a the twelve removed rows are gone', '0', pg_temp.removed_present()::text);
select pg_temp.expect('1b the eight added rows and the three new codes are there', '8 3',
  pg_temp.added_present() || ' ' || pg_temp.codes_present());
select pg_temp.expect('1c kept: admin approves new patients, the nurse writes notes, doctors check and confirm readings',
  '5', (select count(*)::text from auth.role_permissions
    where (role_code, permission_code) in (('admin', 'identity.registration.approve'), ('nurse', 'ehr.note.write'),
                                           ('doctor', 'ocr.job.write'), ('doctor', 'ocr.validation.write'),
                                           ('doctor', 'ocr.patient.confirm'))));
select pg_temp.expect('1d receptionist', 'ehr.document.read-own ehr.document.write ehr.encounter.read '
  || 'ehr.encounter.write ehr.vital.read identity.authorization.check identity.consent.read identity.consent.write '
  || 'identity.patient.read identity.registration.write ocr.job.read-own ocr.job.start ocr.job.write '
  || 'outreach.campaign.read outreach.campaign.write outreach.registration.read outreach.registration.write',
  pg_temp.role_line('receptionist'));
select pg_temp.expect('1e doctor', 'ehr.diagnosis.read ehr.diagnosis.write ehr.document.read ehr.document.write '
  || 'ehr.encounter.read ehr.encounter.write ehr.lab-request.read ehr.lab-request.write ehr.note.read ehr.note.write '
  || 'ehr.order-route.send ehr.prescription.read ehr.prescription.write ehr.vital.read ehr.vital.write '
  || 'identity.authorization.check identity.break-glass.write identity.consent.read identity.consent.write '
  || 'identity.patient-access-pin.verify identity.patient.read identity.registration.write lab.import.read '
  || 'lab.import.write lab.result.released.read lab.work-item.accept ocr.job.read ocr.job.write ocr.patient.confirm '
  || 'ocr.publication.write ocr.validation.write pharmacy.dispensing.read pharmacy.import.read pharmacy.import.write',
  pg_temp.role_line('doctor'));
select pg_temp.expect('1f lab', 'ehr.document.read ehr.document.write ehr.lab-request.read ehr.lab-request.write '
  || 'identity.authorization.check identity.consent.read identity.consent.write identity.patient.read '
  || 'lab.accession.create lab.accession.read lab.execution.complete lab.execution.read lab.execution.start '
  || 'lab.import.read lab.import.write lab.order-route.receive lab.result.correct lab.result.enter '
  || 'lab.result.entered-in-error lab.result.release lab.result.released.read lab.result.revise-released '
  || 'lab.result.verify lab.specimen.collect lab.specimen.receive lab.specimen.reject lab.work-item.accept '
  || 'lab.work-item.read', pg_temp.role_line('lab'));
select pg_temp.expect('1g admin (keeps ocr.job.read: unchanged by Q112 A)', 'audit.read identity.registration.approve '
  || 'identity.registration.write lab.accession.read lab.execution.read lab.import.read lab.result.released.read '
  || 'ocr.job.read organization.manage outreach.campaign.read outreach.campaign.write outreach.registration.read '
  || 'outreach.registration.write pharmacy.dispensing.read pharmacy.import.read workforce.manage',
  pg_temp.role_line('admin'));
select pg_temp.expect('1h nurse (gains ocr.job.start only)', 'ehr.diagnosis.read ehr.document.read ehr.document.write '
  || 'ehr.encounter.read ehr.encounter.write ehr.lab-request.read ehr.note.read ehr.note.write ehr.prescription.read '
  || 'ehr.vital.read ehr.vital.write identity.authorization.check identity.break-glass.write identity.consent.read '
  || 'identity.consent.write identity.patient-access-pin.verify identity.patient.read identity.registration.write '
  || 'lab.import.read lab.import.write lab.result.released.read lab.work-item.accept lab.work-item.read ocr.job.read '
  || 'ocr.job.start ocr.job.write ocr.patient.confirm ocr.publication.write ocr.validation.write outreach.campaign.read '
  || 'outreach.campaign.write outreach.registration.read outreach.registration.write pharmacy.dispensing.read '
  || 'pharmacy.import.read pharmacy.import.write pharmacy.work-item.read', pg_temp.role_line('nurse'));
select pg_temp.expect('1i clinician (gains ocr.job.start only)', 'ehr.diagnosis.read ehr.diagnosis.write '
  || 'ehr.document.read ehr.document.write ehr.encounter.read ehr.encounter.write ehr.lab-request.read '
  || 'ehr.lab-request.write ehr.note.read ehr.note.write ehr.order-route.send ehr.prescription.read '
  || 'ehr.prescription.write ehr.vital.read ehr.vital.write identity.authorization.check identity.break-glass.write '
  || 'identity.consent.read identity.consent.write identity.patient-access-pin.verify identity.patient.read '
  || 'identity.registration.write lab.import.read lab.import.write lab.result.released.read lab.work-item.accept '
  || 'lab.work-item.read ocr.job.read ocr.job.start ocr.job.write ocr.patient.confirm ocr.publication.write '
  || 'ocr.validation.write outreach.campaign.read outreach.campaign.write outreach.registration.read '
  || 'outreach.registration.write pharmacy.dispensing.read pharmacy.import.read pharmacy.import.write '
  || 'pharmacy.work-item.read', pg_temp.role_line('clinician'));
select pg_temp.expect('1j who holds the new codes', 'ehr.document.read-own: receptionist | ocr.job.read-own: '
  || 'receptionist | ocr.job.start: clinician nurse receptionist',
  (select string_agg(code || ': ' || holders, ' | ' order by code)
     from (select permission_code as code, string_agg(role_code, ' ' order by role_code) as holders
             from auth.role_permissions
            where permission_code in ('ocr.job.start', 'ocr.job.read-own', 'ehr.document.read-own')
            group by permission_code) held));
select pg_temp.expect('1k org_admin holds neither work list (untouched)', '0',
  (select count(*)::text from auth.role_permissions
    where role_code = 'org_admin' and permission_code in ('lab.work-item.read', 'pharmacy.work-item.read')));

-- 2. Back to the table before 0136, for this transaction: the prepared undo as
-- written, then everything 0136 added taken away.
\ir ../../../../docs/rollback/0136_rollback.sql
delete from auth.role_permissions
 where permission_code in ('ocr.job.start', 'ocr.job.read-own', 'ehr.document.read-own')
    or (role_code = 'receptionist' and permission_code in ('ehr.document.write', 'ocr.job.write', 'ehr.vital.read'));
delete from auth.permissions where code in ('ocr.job.start', 'ocr.job.read-own', 'ehr.document.read-own');
select pg_temp.expect('2a before 0136: the twelve rows are there', '12', pg_temp.removed_present()::text);
select pg_temp.expect('2b before 0136: no added row or new code yet', '0 0',
  pg_temp.added_present() || ' ' || pg_temp.codes_present());

-- The counts file's answer, kept by label: the count block leaves it in the
-- session setting zero136.counts (one JSON object per line).
create temporary table counts_seen (
  label text, line integer, what text, real_count bigint, logins bigint, sealed_count bigint
) on commit drop;
create function pg_temp.keep_counts(label text) returns void language sql as $$
  insert into counts_seen
  select label, counted.line, counted.what, counted.real_count, counted.logins, counted.sealed_count
    from jsonb_to_recordset(current_setting('zero136.counts')::jsonb)
         counted(line integer, what text, real_count bigint, logins bigint, sealed_count bigint);
$$;
-- The owner's maximums as 0136 carries them, built from a kept count; the
-- caller may lower one line or leave one unfilled.
create function pg_temp.set_maximums(label text, lower_line integer default null, lower_logins boolean default false,
                                     unfilled_line integer default null) returns void language sql as $$
  select set_config('zero136.owner_maximums', jsonb_agg(jsonb_build_object(
           'line', seen.line,
           'real_count', case when seen.line = unfilled_line then null
                              when seen.line = lower_line and not lower_logins then seen.real_count - 1
                              else seen.real_count end,
           'logins', case when seen.line = unfilled_line then null
                          when seen.line = lower_line and lower_logins then seen.logins - 1
                          else seen.logins end))::text, false)
    from counts_seen seen where seen.label = set_maximums.label and seen.line <= 24;
$$;

-- 3a. The counts before the fictional staff exist (whatever the database
-- already holds), so 3c compares only what the fixtures add. No maximums:
-- the count block only counts, as when DevOps runs the file.
select set_config('zero136.owner_maximums', '', false);
\set QUIET on
\o /dev/null
\ir ../../../../docs/rollback/0136_affected_staff_counts.sql
\o
\set QUIET off
select pg_temp.keep_counts('baseline');
select pg_temp.expect('3a the counts file answers 26 lines and compares nothing without maximums', '26 no',
  (select count(*) from counts_seen where label = 'baseline') || ' ' || current_setting('zero136.maximums_checked'));

-- Fixtures. Organisation O; Hospital F1 (real) and QA Hospital F2 (recorded
-- as a sealed QA facility); Clinic F4 (real: doctors and a front desk, no
-- nurse or clinician), Laboratory F5 (real: laboratory staff only) and
-- Desk F6 (real: a front desk only).
-- Members (n): 1 receptionist; 2 receptionist and nurse; 3 doctor; 4 doctor
-- and nurse; 5 doctor, membership inactive; 6 doctor, login disabled; 7 lab;
-- 8 lab, role revoked; 9 admin; 10 admin and doctor; 11 doctor at the sealed
-- F2; 12 nurse; 13 doctor at F4; 14 receptionist at F4; 15 lab at F5;
-- 16 clinician; 17 receptionist at F6.
-- Patient P1, 40 years old. OCR readings: not yet checked at F1 (1), F2 (1),
-- F4 (2) and F5 (1); one already checked at F4. Access requests from P1's
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
   'RC-136-L', 'Africa/Lagos', true, 'verified'),
  ('c1366000-0000-4000-8000-000000000006', 'c1366000-0000-4000-8000-000000000001', 'Role Change Desk',
   'RC-136-D', 'Africa/Lagos', true, 'verified');
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
  (15, '5', array['lab'], true, 'active', false),
  (16, '2', array['clinician'], true, 'active', false),
  (17, '6', array['receptionist'], true, 'active', false);
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
-- OCR readings (k, facility, member who started it, status).
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
\o /dev/null
\ir ../../../../docs/rollback/0136_affected_staff_counts.sql
\o
\set QUIET off
select pg_temp.keep_counts('before');

-- 3c. What the fixtures add to each line: at real facilities / staff logins
-- at real facilities / at the sealed QA and demo tenants.
select pg_temp.expect('3c ' || lpad(wanted.line::text, 2, '0') || ' ' || wanted.what, wanted.counts,
  (select (before.real_count - baseline.real_count) || '/'
          || coalesce((before.logins - baseline.logins)::text, '-') || '/'
          || (before.sealed_count - baseline.sealed_count)
     from counts_seen before join counts_seen baseline on baseline.line = before.line
    where before.label = 'before' and baseline.label = 'baseline' and before.line = wanted.line
      and before.what = wanted.what and baseline.what = wanted.what))
  from (values
    -- The desk members 1, 14 and 17; 2 is a nurse too, who already holds
    -- write, vitals and the full reads, but not the two new -own codes or
    -- ocr.job.start.
    (1, 'receptionist gains ehr.document.write', '3/3/0'),
    (2, 'receptionist gains ehr.document.read-own', '4/4/0'),
    (3, 'receptionist gains ocr.job.write', '3/3/0'),
    (4, 'receptionist gains ocr.job.start', '4/4/0'),
    (5, 'receptionist gains ocr.job.read-own', '4/4/0'),
    (6, 'receptionist gains ehr.vital.read', '3/3/0'),
    -- Nurses 2, 4 and 12, clinician 16.
    (7, 'nurse gains ocr.job.start', '3/3/0'),
    (8, 'clinician gains ocr.job.start', '1/1/0'),
    -- Doctors 3, 4, 10 and 13 (5 and 6 are not active), and 11 sealed: 4
    -- keeps Outreach and the lab and pharmacy lists as a nurse, 10 keeps
    -- Outreach as an administrator.
    (9, 'doctor loses outreach.campaign.read', '2/2/1'),
    (10, 'doctor loses outreach.campaign.write', '2/2/1'),
    (11, 'doctor loses outreach.registration.read', '2/2/1'),
    (12, 'doctor loses outreach.registration.write', '2/2/1'),
    (13, 'doctor loses lab.work-item.read', '3/3/1'),
    (14, 'doctor loses pharmacy.work-item.read', '3/3/1'),
    -- Laboratory members 7 and 15 (8's role is revoked).
    (15, 'lab loses ehr.encounter.read', '2/2/0'),
    (16, 'lab loses ocr.job.read', '2/2/0'),
    (17, 'lab loses ocr.job.write', '2/2/0'),
    (18, 'lab loses ocr.validation.write', '2/2/0'),
    -- Administrators 9 and 10.
    (19, 'admin loses lab.work-item.read', '2/2/0'),
    (20, 'admin loses pharmacy.work-item.read', '2/2/0'),
    -- Doctors 3, 10 and 13, and 11 sealed; not 4, who starts readings as a nurse.
    (21, 'doctors who can start a reading today and cannot after 0136', '3/3/1'),
    -- F5 (the laboratory). F4's doctor and F2's sealed doctor keep checking (Q111 A).
    (22, 'facilities where staff can check a reading today and nobody can after 0136', '1/-/0'),
    -- F6 (a front desk only): the desk can start a reading there and nobody can check it.
    (23, 'facilities where after 0136 staff can start a reading and nobody can check it', '1/-/0'),
    (24, 'facilities where after 0136 staff can start a reading and nobody can confirm its patient', '1/-/0'),
    -- The laboratory member 7 only; doctors 3, 4 and 11 keep ocr.job.write.
    (25, 'open records-processing requests from staff who lose ocr.job.write (0136 closes them)', '1/-/0'),
    -- F5's one reading (F1's, F2's and F4's facilities can still check theirs).
    (26, 'readings not yet checked at the facilities of line 22', '1/-/0'))
    wanted(line, what, counts);
select pg_temp.expect('3d the counts hold numbers only: five fields per line, no id', '26 lines; line what real_count logins sealed_count',
  (select count(*) || ' lines' from counts_seen where label = 'before')
  || '; ' || (select string_agg(key, ' ' order by array_position(array['line', 'what', 'real_count', 'logins',
                                                                        'sealed_count'], key))
                from (select distinct jsonb_object_keys(value) as key
                        from jsonb_array_elements(current_setting('zero136.counts')::jsonb)) keys));

-- 3e. The owner's maximums (Q113 A), through the same count block: at the
-- counted numbers it passes; one line higher than its maximum, in either
-- number, or not filled in while it touches anyone, is named.
select pg_temp.set_maximums('before');
\set QUIET on
\o /dev/null
\ir ../../../../docs/rollback/0136_affected_staff_counts.sql
\o
\set QUIET off
select pg_temp.expect('3e at the counted numbers: compared, nothing over', 'yes []',
  current_setting('zero136.maximums_checked') || ' [' || current_setting('zero136.over_maximums') || ']');
select pg_temp.set_maximums('before', lower_line => 3);
\set QUIET on
\o /dev/null
\ir ../../../../docs/rollback/0136_affected_staff_counts.sql
\o
\set QUIET off
select pg_temp.expect('3f one more front-desk member than the owner saw: line 3 is named',
  format('line 3 (receptionist gains ocr.job.write) is now %s (%s staff logins), more than the owner''s %s (%s)',
         seen.real_count, seen.logins, seen.real_count - 1, seen.logins),
  current_setting('zero136.over_maximums'))
  from counts_seen seen where seen.label = 'before' and seen.line = 3;
select pg_temp.set_maximums('before', lower_line => 21, lower_logins => true);
\set QUIET on
\o /dev/null
\ir ../../../../docs/rollback/0136_affected_staff_counts.sql
\o
\set QUIET off
select pg_temp.expect('3g more staff logins than the owner saw, same memberships: line 21 is named',
  format('line 21 (doctors who can start a reading today and cannot after 0136) is now %s (%s staff logins), '
         || 'more than the owner''s %s (%s)', seen.real_count, seen.logins, seen.real_count, seen.logins - 1),
  current_setting('zero136.over_maximums'))
  from counts_seen seen where seen.label = 'before' and seen.line = 21;
select pg_temp.set_maximums('before', unfilled_line => 23);
\set QUIET on
\o /dev/null
\ir ../../../../docs/rollback/0136_affected_staff_counts.sql
\o
\set QUIET off
select pg_temp.expect('3h a line not filled in while it touches a facility: line 23 is named',
  format('line 23 (facilities where after 0136 staff can start a reading and nobody can check it) is now %s '
         || 'and the owner''s maximum is not filled in', seen.real_count),
  current_setting('zero136.over_maximums'))
  from counts_seen seen where seen.label = 'before' and seen.line = 23;
select pg_temp.set_maximums('before', lower_line => 25);
\set QUIET on
\o /dev/null
\ir ../../../../docs/rollback/0136_affected_staff_counts.sql
\o
\set QUIET off
select pg_temp.expect('3i lines 25 and 26 are printed only, never compared', 'yes []',
  current_setting('zero136.maximums_checked') || ' [' || current_setting('zero136.over_maximums') || ']');
-- A list missing a line is refused before any comparison.
select set_config('zero136.owner_maximums', (current_setting('zero136.owner_maximums')::jsonb - 23)::text, false);
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\set QUIET on
\o /dev/null
\ir ../../../../docs/rollback/0136_affected_staff_counts.sql
\o
\set QUIET off
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
select pg_temp.expect('3j maximums missing a line are refused',
  '0136: the owner''s maximums must list lines 1 to 24, once each; nothing was changed.', :'LAST_ERROR_MESSAGE');
select set_config('zero136.owner_maximums', '', false);

-- 4. 0136 as written, on the table before it. Its maximums are 0 at real
-- facilities (Q113 A) and the fictional staff at real facilities are
-- affected, so it stops before changing anything. ON_ERROR_ROLLBACK undoes only that statement here, so the suite
-- can go on and check the change itself; the migration runner runs the file
-- as one transaction and applies nothing.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\set QUIET on
\ir ../../database/migrations/0136_role_permission_changes.sql
\set QUIET off
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
select pg_temp.expect('4a with the owner''s maximums at 0 (Q113 A), 0136 stops on line 1 and names every line it touches',
  '0136 stopped, nothing was changed: real staff would be affected, and the owner approved 0136 only while none are '
  || 'active (Q113 A): line 1 (receptionist gains ehr.document.write) is now ' || (select real_count from counts_seen
     where label = 'before' and line = 1) || ' (' || (select logins from counts_seen where label = 'before' and line = 1)
  || ' staff logins), more than the owner''s 0 (0); ',
  left(:'LAST_ERROR_MESSAGE', length('0136 stopped, nothing was changed: real staff would be affected, and the owner '
  || 'approved 0136 only while none are active (Q113 A): line 1 (receptionist gains ehr.document.write) is now '
  || (select real_count from counts_seen where label = 'before' and line = 1) || ' ('
  || (select logins from counts_seen where label = 'before' and line = 1)
  || ' staff logins), more than the owner''s 0 (0); ')));
select pg_temp.expect('4b the stop names lines 1-24 that touch anyone, never 25 or 26',
  (select string_agg(line::text, ' ' order by line) from counts_seen
    where label = 'before' and line <= 24 and (real_count > 0 or coalesce(logins, 0) > 0)),
  (select string_agg(found[1], ' ' order by found[1]::integer)
     from regexp_matches(:'LAST_ERROR_MESSAGE', 'line (\d+) \(', 'g') found));
select pg_temp.expect('4c 0136 counted what the counts file counted, number for number', '0',
  (select count(*)::text from (
     select line, what, real_count, logins, sealed_count from counts_seen where label = 'before'
     except
     select counted.line, counted.what, counted.real_count, counted.logins, counted.sealed_count
       from jsonb_to_recordset(current_setting('zero136.counts')::jsonb)
            counted(line integer, what text, real_count bigint, logins bigint, sealed_count bigint)) differing));
select pg_temp.expect('4d the change itself (the rest of the file): removed, added, new codes', '0 8 3',
  pg_temp.removed_present() || ' ' || pg_temp.added_present() || ' ' || pg_temp.codes_present());
select pg_temp.expect('4e 0136 closed the laboratory member''s records-processing request only',
  '1 pending, 2 pending, 3 expired, 4 pending, 5 pending, 6 approved',
  (select string_agg(right(id::text, 1) || ' ' || status, ', ' order by id) from identity.access_requests
    where id::text like 'c1369000-%'));
select pg_temp.expect('4f one audit row per closed request: system, the plain reason, no staff or patient detail beyond ids',
  '1 system identity.access-request.close success This staff member can no longer process records migration',
  (select count(*) || ' ' || min(actor_type) || ' ' || min(action) || ' ' || min(outcome) || ' ' || min(reason) || ' '
          || min(provenance)
     from audit.events
    where resource_type = 'access-request' and resource_id like 'c1369000-%' and correlation_id = '0136-role-permission-changes'
      and actor_subject is null and patient_id = 'c1365000-0000-4000-8000-000000000001'));
select pg_temp.expect('4g the count 0136 printed for line 25 is the number it closed', '1',
  (select (before.real_count + before.sealed_count - baseline.real_count - baseline.sealed_count)::text
     from counts_seen before join counts_seen baseline on baseline.line = before.line
    where before.label = 'before' and baseline.label = 'baseline' and before.line = 25));

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
  desk text[] := array['ehr.document.write', 'ehr.document.read-own', 'ocr.job.write', 'ocr.job.start',
    'ocr.job.read-own', 'ehr.vital.read'];
  desk_never text[] := array['ehr.document.read', 'ocr.job.read', 'ocr.validation.write', 'ocr.patient.confirm',
    'ocr.publication.write', 'ehr.note.read', 'ehr.diagnosis.read', 'ehr.prescription.read', 'ehr.lab-request.read'];
  doctor_lost text[] := array['outreach.campaign.read', 'outreach.campaign.write', 'outreach.registration.read',
    'outreach.registration.write', 'lab.work-item.read', 'pharmacy.work-item.read'];
  doctor_kept text[] := array['ocr.job.write', 'ocr.job.read', 'ocr.validation.write', 'ocr.patient.confirm',
    'ocr.publication.write', 'lab.work-item.accept', 'ehr.lab-request.read', 'ehr.prescription.read',
    'lab.result.released.read', 'ehr.prescription.write', 'ehr.lab-request.write', 'ehr.order-route.send',
    'ehr.document.read', 'ehr.document.write'];
  lab_lost text[] := array['ehr.encounter.read', 'ocr.job.read', 'ocr.job.write', 'ocr.validation.write'];
  lab_kept text[] := array['lab.work-item.read', 'lab.work-item.accept', 'lab.order-route.receive', 'lab.result.enter',
    'lab.result.release', 'ehr.lab-request.read', 'ehr.lab-request.write'];
  admin_lost text[] := array['lab.work-item.read', 'pharmacy.work-item.read'];
  admin_kept text[] := array['identity.registration.approve', 'workforce.manage', 'organization.manage', 'audit.read',
    'ocr.job.read'];
  starts text[] := array['ocr.job.write', 'ocr.job.start'];
  nurse_all text[] := array['ehr.note.write', 'ocr.job.write', 'ocr.job.start', 'ocr.job.read', 'ocr.validation.write',
    'outreach.campaign.read', 'lab.work-item.read', 'pharmacy.work-item.read', 'ehr.vital.read', 'ehr.document.read'];
begin
  perform pg_temp.expect(stage || ': front desk (1) scans, starts readings, sees its own uploads and vitals',
    array_to_string(desk, ' '), pg_temp.holding(1, desk));
  perform pg_temp.expect(stage || ': front desk (1) holds neither full read nor any clinical read (Q112 A)',
    '- - - - - - - - -', pg_temp.holding(1, desk_never));
  perform pg_temp.expect(stage || ': front desk with a nurse role (2) keeps the full reads through the nurse role',
    'ehr.document.read ocr.job.read', pg_temp.holding(2, array['ehr.document.read', 'ocr.job.read']));
  perform pg_temp.expect(stage || ': doctor (3) loses Outreach and the work lists', '- - - - - -',
    pg_temp.holding(3, doctor_lost));
  perform pg_temp.expect(stage || ': doctor (3) keeps checking, confirming, publishing, sending and its orders'' progress (Q111 A)',
    array_to_string(doctor_kept, ' '), pg_temp.holding(3, doctor_kept));
  perform pg_temp.expect(stage || ': doctor (3) cannot start a reading (no ocr.job.start)', 'ocr.job.write -',
    pg_temp.holding(3, starts));
  perform pg_temp.expect(stage || ': doctor with a nurse role (4) keeps everything and starts readings as a nurse',
    array_to_string(doctor_lost || starts, ' '), pg_temp.holding(4, doctor_lost || starts));
  perform pg_temp.expect(stage || ': lab member (7) loses visits and OCR', '- - - -', pg_temp.holding(7, lab_lost));
  perform pg_temp.expect(stage || ': lab member (7) keeps its own work', array_to_string(lab_kept, ' '),
    pg_temp.holding(7, lab_kept));
  perform pg_temp.expect(stage || ': admin (9) loses the two work lists', '- -', pg_temp.holding(9, admin_lost));
  perform pg_temp.expect(stage || ': admin (9) keeps approving new patients, running staff and reading jobs',
    array_to_string(admin_kept, ' '), pg_temp.holding(9, admin_kept));
  perform pg_temp.expect(stage || ': admin and doctor (10) loses the work lists from both roles', '- -',
    pg_temp.holding(10, admin_lost));
  perform pg_temp.expect(stage || ': admin and doctor (10) keeps Outreach through the admin role',
    'outreach.campaign.read outreach.registration.write',
    pg_temp.holding(10, array['outreach.campaign.read', 'outreach.registration.write']));
  perform pg_temp.expect(stage || ': nurse (12) keeps everything and starts readings', array_to_string(nurse_all, ' '),
    pg_temp.holding(12, nurse_all));
  perform pg_temp.expect(stage || ': clinician (16) starts and checks readings', 'ocr.job.write ocr.job.start ocr.validation.write',
    pg_temp.holding(16, array['ocr.job.write', 'ocr.job.start', 'ocr.validation.write']));
  perform pg_temp.expect(stage || ': inactive membership (5), disabled login (6), revoked role (8) hold nothing',
    '- - -', pg_temp.holding(5, array['ehr.encounter.read']) || ' ' || pg_temp.holding(6, array['ehr.encounter.read'])
      || ' ' || pg_temp.holding(8, array['lab.work-item.read']));
end $$;
select pg_temp.check_members('after 0136');

-- 5. Records processing (0104's trigger), as the Identity API runtime, at each
-- member's own facility.
create function pg_temp.ask_records_processing(n integer) returns text language plpgsql as $$
declare
  outcome record;
begin
  perform set_config('app.actor_subject', 'staff:role-change-' || n, true),
    set_config('app.facility_id', 'c1366000-0000-4000-8000-00000000000'
      || (select facility from rc_member where rc_member.n = ask_records_processing.n), true),
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
select pg_temp.expect('5b a doctor (13) still may (Q111 A: doctors keep checking readings)',
  'ok pending healthcare-operations', pg_temp.ask_records_processing(13));
select pg_temp.expect('5c a laboratory member (7) is refused', '42501 RECORDS_PROCESSING_NOT_ALLOWED',
  pg_temp.ask_records_processing(7));
select pg_temp.expect('5d a nurse (12) still may', 'ok pending healthcare-operations',
  pg_temp.ask_records_processing(12));
reset role;

-- 7. After 0136 the counts file refuses to count again (its numbers would mean
-- nothing).
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\set QUIET on
\o /dev/null
\ir ../../../../docs/rollback/0136_affected_staff_counts.sql
\o
\set QUIET off
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
select pg_temp.expect('7a after 0136 the counts file says there is nothing left to count',
  '0136 counts: this database already has 0136''s new permissions, so 0136 has already run here and there is nothing left to count.',
  :'LAST_ERROR_MESSAGE');

-- 6. The prepared undo, as written: the twelve rows and the doctor's and
-- laboratory member's ocr.job.start back, the front-desk rows left; twice
-- changes nothing.
\ir ../../../../docs/rollback/0136_rollback.sql
select pg_temp.expect('6a undo: the twelve rows are back', '12', pg_temp.removed_present()::text);
select pg_temp.expect('6b undo: the front-desk, nurse and clinician rows and the three codes stay', '8 3',
  pg_temp.added_present() || ' ' || pg_temp.codes_present());
select pg_temp.expect('6c undo: doctor, lab member and admin can do again what they did before 0136',
  'ocr.job.write ocr.job.start lab.work-item.read outreach.campaign.read | ehr.encounter.read ocr.job.read ocr.job.write '
  || 'ocr.job.start ocr.validation.write | lab.work-item.read pharmacy.work-item.read',
  pg_temp.holding(3, array['ocr.job.write', 'ocr.job.start', 'lab.work-item.read', 'outreach.campaign.read']) || ' | '
  || pg_temp.holding(7, array['ehr.encounter.read', 'ocr.job.read', 'ocr.job.write', 'ocr.job.start',
                              'ocr.validation.write']) || ' | '
  || pg_temp.holding(9, array['lab.work-item.read', 'pharmacy.work-item.read']));
select pg_temp.expect('6d undo: the front desk keeps scanning with its own uploads only',
  'ehr.document.write ehr.document.read-own ocr.job.write ocr.job.start ocr.job.read-own ehr.vital.read - -',
  pg_temp.holding(1, array['ehr.document.write', 'ehr.document.read-own', 'ocr.job.write', 'ocr.job.start',
    'ocr.job.read-own', 'ehr.vital.read', 'ehr.document.read', 'ocr.job.read']));
create temporary table rows_after_undo on commit drop as
  select role_code, permission_code from auth.role_permissions;
\ir ../../../../docs/rollback/0136_rollback.sql
select pg_temp.expect('6e undo a second time: the table is the same', '0 0',
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
