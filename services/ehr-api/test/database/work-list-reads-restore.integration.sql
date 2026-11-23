\set ON_ERROR_STOP on
-- 0144 (owner decision Q134 B): admins and doctors get back the laboratory's
-- and the pharmacy's work lists, and doctors get back starting a reading.
-- Rollback-only.
--   1. after 0001-0144: the five rows are there; the admin's and the
--      doctor's whole permission lines are 0136's plus exactly these rows
--      (0131's identity.patient.open-own-facility row, which 0131's suite
--      pins, is left out); who holds ocr.job.start; everything else 0136 did
--      is unchanged (doctors stay off outreach.*, laboratory staff off visits
--      and paper readings, the front desk without the full reads, org_admin
--      without the work lists);
--   2. fictional staff at a fictional hospital, through
--      auth.membership_has_permission (what every service checks): an admin
--      and a doctor read both work lists; the doctor can start a reading
--      (ocr.job.start with ocr.job.write and ocr.job.read, as ocr-api asks);
--      an inactive membership, a disabled login and a revoked role get
--      nothing; the front desk, a nurse and laboratory staff are as 0136
--      left them;
--   3. 0144 run again, as written: "0144: already applied" (55000), and
--      nothing changes;
--   4. with the five rows taken away again (the undo), 0144 as written puts
--      them back, and its post-check passes; with a row 0136 left changed
--      first (a doctor without ocr.job.write, or laboratory staff given
--      ocr.job.start), it refuses with the row named, and nothing changes.
-- Synthetic values only: uuid prefix c144, @example.invalid addresses.
set plpgsql.variable_conflict = error;
begin;

create temporary table restore_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;
grant select, insert on restore_cases to public;
grant usage on sequence restore_cases_seq_seq to public;
create function pg_temp.expect(case_name text, expected text, actual text) returns void language sql as $$
  insert into restore_cases (name, expected, actual) values (case_name, expected, coalesce(actual, 'null'));
$$;
grant execute on function pg_temp.expect(text, text, text) to public;

-- A role's permissions as one sorted, space-separated line.
create function pg_temp.role_line(role text) returns text language sql as $$
  select string_agg(permission_code, ' ' order by permission_code) from auth.role_permissions
   where role_code = role and permission_code <> 'identity.patient.open-own-facility';
$$;
create function pg_temp.restored_present() returns integer language sql as $$
  select count(*)::integer from auth.role_permissions
   where (role_code, permission_code) in (
     ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read'),
     ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
     ('doctor', 'ocr.job.start'));
$$;
create function pg_temp.table_now() returns text language sql as $$
  select md5(string_agg(role_code || ' ' || permission_code, ',' order by role_code, permission_code))
    from auth.role_permissions;
$$;

-- 1. The role table after 0001-0144.
select pg_temp.expect('1a the five rows are there', '5', pg_temp.restored_present()::text);
select pg_temp.expect('1b doctor: 0136''s line plus lab.work-item.read, ocr.job.start and pharmacy.work-item.read',
  'ehr.diagnosis.read ehr.diagnosis.write ehr.document.read ehr.document.write '
  || 'ehr.encounter.read ehr.encounter.write ehr.lab-request.read ehr.lab-request.write ehr.note.read ehr.note.write '
  || 'ehr.order-route.send ehr.prescription.read ehr.prescription.write ehr.vital.read ehr.vital.write '
  || 'identity.authorization.check identity.break-glass.write identity.consent.read identity.consent.write '
  || 'identity.patient-access-pin.verify identity.patient.read identity.registration.write lab.import.read '
  || 'lab.import.write lab.result.released.read lab.work-item.accept lab.work-item.read ocr.job.read ocr.job.start '
  || 'ocr.job.write ocr.patient.confirm ocr.publication.write ocr.validation.write pharmacy.dispensing.read '
  || 'pharmacy.import.read pharmacy.import.write pharmacy.work-item.read',
  pg_temp.role_line('doctor'));
select pg_temp.expect('1c admin: 0136''s line plus lab.work-item.read and pharmacy.work-item.read',
  'audit.read identity.registration.approve '
  || 'identity.registration.write lab.accession.read lab.execution.read lab.import.read lab.result.released.read '
  || 'lab.work-item.read ocr.job.read organization.manage outreach.campaign.read outreach.campaign.write '
  || 'outreach.registration.read outreach.registration.write pharmacy.dispensing.read pharmacy.import.read '
  || 'pharmacy.work-item.read workforce.manage',
  pg_temp.role_line('admin'));
select pg_temp.expect('1d who holds ocr.job.start (doctors again, laboratory staff still not)',
  'clinician doctor nurse receptionist',
  (select string_agg(role_code, ' ' order by role_code) from auth.role_permissions
    where permission_code = 'ocr.job.start'));
select pg_temp.expect('1e everything else 0136 took away stays away', '0',
  (select count(*)::text from auth.role_permissions
    where (role_code, permission_code) in (
      ('doctor', 'outreach.campaign.read'), ('doctor', 'outreach.campaign.write'),
      ('doctor', 'outreach.registration.read'), ('doctor', 'outreach.registration.write'),
      ('lab', 'ehr.encounter.read'), ('lab', 'ocr.job.read'), ('lab', 'ocr.job.write'),
      ('lab', 'ocr.validation.write'), ('receptionist', 'ehr.document.read'), ('receptionist', 'ocr.job.read'),
      ('org_admin', 'lab.work-item.read'), ('org_admin', 'pharmacy.work-item.read'))));
select pg_temp.expect('1f what 0136 added stays: the front desk''s six rows, nurses'' and clinicians'' ocr.job.start, '
  || 'the three codes', '8 3',
  (select count(*) from auth.role_permissions
    where (role_code, permission_code) in (
      ('receptionist', 'ehr.document.write'), ('receptionist', 'ehr.document.read-own'),
      ('receptionist', 'ocr.job.write'), ('receptionist', 'ocr.job.start'),
      ('receptionist', 'ocr.job.read-own'), ('receptionist', 'ehr.vital.read'),
      ('nurse', 'ocr.job.start'), ('clinician', 'ocr.job.start')))
  || ' ' || (select count(*) from auth.permissions
              where code in ('ocr.job.start', 'ocr.job.read-own', 'ehr.document.read-own') and active));

-- 2. Fictional staff at a fictional hospital (n, roles, membership active,
-- login status, role revoked).
insert into identity.organizations (id, name, slug) values
  ('c1446000-0000-4000-8000-000000000001', 'Restore Test Org', 'restore-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('c1446000-0000-4000-8000-000000000002', 'c1446000-0000-4000-8000-000000000001', 'Restore Hospital',
   'RS-144-A', 'Africa/Lagos', true, 'verified');
create temporary table rs_member (n integer primary key, roles text[], membership_active boolean,
  account_status text, revoked boolean) on commit drop;
grant select on rs_member to public;
insert into rs_member values
  (1, array['admin'], true, 'active', false),
  (2, array['doctor'], true, 'active', false),
  (3, array['admin', 'doctor'], true, 'active', false),
  (4, array['admin'], false, 'active', false),
  (5, array['doctor'], true, 'disabled', false),
  (6, array['doctor'], true, 'active', true),
  (7, array['receptionist'], true, 'active', false),
  (8, array['nurse'], true, 'active', false),
  (9, array['lab'], true, 'active', false);
create function pg_temp.rs_id(kind text, n integer) returns uuid language sql immutable as $$
  select ('c144' || kind || '000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid;
$$;
grant execute on function pg_temp.rs_id(text, integer) to public;
insert into auth.accounts (id, subject, email, display_name, status)
select pg_temp.rs_id('1', n), 'staff:restore-' || n, 'restore-' || n || '@example.invalid',
  'Restore Staff ' || n, account_status
  from rs_member;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select pg_temp.rs_id('2', n), pg_temp.rs_id('1', n), 'Restore Staff ' || n, 'restore-' || n || '@example.invalid',
  'verified', roles[1]
  from rs_member;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select pg_temp.rs_id('3', n), pg_temp.rs_id('2', n), pg_temp.rs_id('1', n), 'c1446000-0000-4000-8000-000000000001',
  'c1446000-0000-4000-8000-000000000002', roles[1], roles[1], true, membership_active
  from rs_member;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason,
  granted_at, revoked_at, revoked_by, revocation_reason)
select ('c1444000-0000-4000-8000-0000000' || lpad((member.n * 10 + role_row.k)::text, 5, '0'))::uuid,
  pg_temp.rs_id('1', member.n), role_row.role_code, 'facility', pg_temp.rs_id('3', member.n),
  'c1446000-0000-4000-8000-000000000002', 'Synthetic 0144 suite role',
  clock_timestamp() - interval '1 day',
  case when member.revoked then clock_timestamp() end,
  case when member.revoked then pg_temp.rs_id('1', 1) end,
  case when member.revoked then 'Synthetic 0144 suite revocation' end
  from rs_member member
  cross join lateral unnest(member.roles) with ordinality role_row(role_code, k);

create function pg_temp.holding(n integer, permissions text[]) returns text language sql as $$
  select coalesce(string_agg(case when coalesce(auth.membership_has_permission('staff:restore-' || n,
                                     pg_temp.rs_id('3', n), 'c1446000-0000-4000-8000-000000000002', wanted), false)
                                  then wanted else '-' end, ' ' order by ordinal), '')
    from unnest(permissions) with ordinality wanted(wanted, ordinal);
$$;
grant execute on function pg_temp.holding(integer, text[]) to public;
-- The three codes, then what ocr-api asks to start a reading (ocr.job.write and
-- ocr.job.read with ocr.job.start), then two codes 0136 keeps from doctors.
create temporary table rs_codes as select array['lab.work-item.read', 'pharmacy.work-item.read', 'ocr.job.start',
  'ocr.job.write', 'ocr.job.read', 'outreach.campaign.read', 'ehr.document.read'] as codes;
select pg_temp.expect('2a admin: both work lists; no reading start (admins never had it)',
  'lab.work-item.read pharmacy.work-item.read - - ocr.job.read outreach.campaign.read -',
  pg_temp.holding(1, (select codes from rs_codes)));
select pg_temp.expect('2b doctor: both work lists and starting a reading; still no outreach',
  'lab.work-item.read pharmacy.work-item.read ocr.job.start ocr.job.write ocr.job.read - ehr.document.read',
  pg_temp.holding(2, (select codes from rs_codes)));
select pg_temp.expect('2c admin and doctor in one membership: the same as the doctor, plus the admin''s outreach',
  'lab.work-item.read pharmacy.work-item.read ocr.job.start ocr.job.write ocr.job.read outreach.campaign.read '
  || 'ehr.document.read',
  pg_temp.holding(3, (select codes from rs_codes)));
select pg_temp.expect('2d an inactive membership, a disabled login and a revoked role get nothing', '- - - - - - - | '
  || '- - - - - - - | - - - - - - -',
  pg_temp.holding(4, (select codes from rs_codes)) || ' | ' || pg_temp.holding(5, (select codes from rs_codes))
  || ' | ' || pg_temp.holding(6, (select codes from rs_codes)));
select pg_temp.expect('2e the front desk as 0136 left it: starts readings, no work list, no full read',
  '- - ocr.job.start ocr.job.write - outreach.campaign.read -',
  pg_temp.holding(7, (select codes from rs_codes)));
select pg_temp.expect('2f a nurse as before: both work lists and starting a reading',
  'lab.work-item.read pharmacy.work-item.read ocr.job.start ocr.job.write ocr.job.read outreach.campaign.read '
  || 'ehr.document.read',
  pg_temp.holding(8, (select codes from rs_codes)));
select pg_temp.expect('2g laboratory staff as 0136 left them: their own work list only, no paper readings',
  'lab.work-item.read - - - - - ehr.document.read',
  pg_temp.holding(9, (select codes from rs_codes)));

-- 3. 0144 again, as written: it refuses, and nothing changes.
create temporary table rs_before as select pg_temp.table_now() as digest;
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\set QUIET on
\ir ../../database/migrations/0144_restore_work_list_reads_and_reading_start.sql
\set QUIET off
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
select pg_temp.expect('3a a second run refuses', '55000 0144: already applied',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE');
select pg_temp.expect('3b and changes nothing', 'same',
  case when pg_temp.table_now() = (select digest from rs_before) then 'same' else 'changed' end);

-- 4. The undo (the five rows taken away again), then 0144 as written.
delete from auth.role_permissions
 where (role_code, permission_code) in (
   ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read'),
   ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
   ('doctor', 'ocr.job.start'));
select pg_temp.expect('4a after the undo: no row, and the doctor has neither work list nor reading start', '0 | '
  || '- - - ocr.job.write ocr.job.read - ehr.document.read',
  pg_temp.restored_present() || ' | ' || pg_temp.holding(2, (select codes from rs_codes)));
-- 4b, 4c: a row 0136 left, changed first: refused, the row named, nothing changed.
delete from auth.role_permissions where role_code = 'doctor' and permission_code = 'ocr.job.write';
truncate rs_before;
insert into rs_before select pg_temp.table_now();
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\set QUIET on
\ir ../../database/migrations/0144_restore_work_list_reads_and_reading_start.sql
\set QUIET off
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
select pg_temp.expect('4b a doctor without ocr.job.write: refused, the row named, nothing changed',
  '55000 0144: the role table is not as 0136 left it: doctor ocr.job.write | same',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | '
  || case when pg_temp.table_now() = (select digest from rs_before) then 'same' else 'changed' end);
insert into auth.role_permissions (role_code, permission_code) values ('doctor', 'ocr.job.write'),
  ('lab', 'ocr.job.start');
truncate rs_before;
insert into rs_before select pg_temp.table_now();
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\set QUIET on
\ir ../../database/migrations/0144_restore_work_list_reads_and_reading_start.sql
\set QUIET off
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
select pg_temp.expect('4c laboratory staff given ocr.job.start: refused, the row named, nothing changed',
  '55000 0144: the role table is not as 0136 left it: lab ocr.job.start | same',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | '
  || case when pg_temp.table_now() = (select digest from rs_before) then 'same' else 'changed' end);
delete from auth.role_permissions where role_code = 'lab' and permission_code = 'ocr.job.start';
-- 4d: from the table 0136 left, 0144 as written applies (its own post-check
-- passes) and gives back exactly the five rows.
truncate rs_before;
insert into rs_before
select md5(string_agg(role_code || ' ' || permission_code, ',' order by role_code, permission_code))
  from (select role_code, permission_code from auth.role_permissions
        union all values ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read'),
                         ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
                         ('doctor', 'ocr.job.start')) expected;
\set QUIET on
\ir ../../database/migrations/0144_restore_work_list_reads_and_reading_start.sql
\set QUIET off
select pg_temp.expect('4d 0144 applies from 0136''s table and adds exactly the five rows', '5 same',
  pg_temp.restored_present() || ' '
  || case when pg_temp.table_now() = (select digest from rs_before) then 'same' else 'changed' end);
select pg_temp.expect('4e the doctor reads both work lists and starts readings again',
  'lab.work-item.read pharmacy.work-item.read ocr.job.start ocr.job.write ocr.job.read - ehr.document.read',
  pg_temp.holding(2, (select codes from rs_codes)));

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, actual), E'\n' order by seq) into failures
    from restore_cases where expected is distinct from actual;
  if failures is not null then
    raise exception E'0144 work-list restore suite failed:\n%', failures;
  end if;
  raise notice '0144 work-list restore suite: % cases passed', (select count(*) from restore_cases);
end $$;

rollback;
