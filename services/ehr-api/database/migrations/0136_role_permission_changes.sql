-- 0136 Who can do what: five changes to the staff role table (Akos SX-2 and
-- SX-3, Release A). Written on staging-novu-ci-20261005 at afec3f75
-- (0001-0127 applied). Release A applies 0128-0135 first; none of them
-- touches the rows this file adds or removes (0131 adds one doctor, nurse and
-- clinician row of its own, 0133 deliberately adds no doctor row), and this
-- file reads nothing they add, so it needs only 0001-0127.
--
-- Owner decision (D-Eminence, in chat, 18 November 2026, about 21:00 UTC),
-- verbatim: "Q103 A". Q103 A is "all five" of the changes below, with
-- "the admin's approve new patient and the nurse's note writing" unchanged.
-- The declaration in config/production-schema-compatibility.json is signed
-- separately: its reviewed_by stays empty until the owner signs it there,
-- after seeing the staff counts (docs/rollback/0136_affected_staff_counts.sql).
--
-- Rows (auth.role_permissions, role_code / permission_code). Nothing else
-- changes: no function, policy, grant or table, so runtime-grants.sql is
-- unchanged. Permissions are read from this table on every request
-- (auth.membership_has_permission and the Identity staff context), so a
-- change takes effect on the next request of each signed-in staff member;
-- nobody is signed out.
--
-- C1 The front desk (receptionist) may scan paper records into a patient's
--    file. Four rows, the smallest set today's scan path needs:
--      receptionist  ehr.document.write   upload the scan (POST
--                                         ehr/documents/upload-intents and
--                                         :id/complete)
--      receptionist  ehr.document.read    see the uploaded file and when its
--                                         virus scan is clean, to pick it
--                                         for reading (GET ehr/documents)
--      receptionist  ocr.job.write        start and retry the reading (POST
--                                         ocr/jobs, ocr/jobs/:id/retry), and
--                                         ask the patient for records
--                                         processing (0104 D2)
--      receptionist  ocr.job.read         follow the reading (GET ocr/jobs,
--                                         ocr/job-list); ocr-api's read of the
--                                         source document from ehr-api
--                                         (GET ehr/internal/ocr/documents/
--                                         :id/source) is checked against this
--                                         too, so a job cannot start without it
--    Not given: ocr.validation.write, ocr.patient.confirm and
--    ocr.publication.write. Checking a reading and putting it into the chart
--    stay with doctors, nurses and clinicians. Every file and reading still
--    needs the patient's access (a consent grant, or records processing under
--    0104/0108/0113), exactly as for anyone else.
-- C2 The front desk may see vitals:
--      receptionist  ehr.vital.read       (GET ehr/patients/:id/vitals...,
--                                         EHR-C3's latest vitals), under the
--                                         patient's access as today.
-- C3 Doctors lose paper-scan writing, the leftover Outreach permissions and
--    the lab and pharmacy queue reads (seven rows):
--      doctor  ocr.job.write              starting a reading moves to the
--                                         desk (see the note below)
--      doctor  outreach.campaign.read, outreach.campaign.write,
--              outreach.registration.read, outreach.registration.write
--                                         (Q97 already keeps doctors off
--                                         outreach.; the rows were left over)
--      doctor  lab.work-item.read         the laboratory's whole work list
--      doctor  pharmacy.work-item.read    the pharmacy's whole work list
--    Doctors keep lab.work-item.accept (sending a lab request to their own
--    laboratory when it is activated), ehr.lab-request.read and
--    ehr.prescription.read (their own orders' progress, ORD-3, live) and
--    lab.result.released.read (released results).
--    Note on ocr.job.write: checking a reading (ocr/jobs/:id/validation) and
--    confirming its patient run only under the healthcare-operations purpose
--    (records processing), and records processing needs ocr.job.write for the
--    membership at each use (0104 D8, 0108, 0113). So without it a doctor
--    also stops checking readings, confirming their patient and asking for
--    records processing. A doctor still reads jobs and publishes a checked
--    reading into the chart under direct care with their own grant
--    (ocr.job.read, ocr.publication.write, kept). Nurses and clinicians keep
--    ocr.job.write and keep checking. The rows ocr.validation.write and
--    ocr.patient.confirm stay with doctors, unused, until the owner decides.
-- C4 Laboratory staff lose visit reading and scanning (four rows):
--      lab  ehr.encounter.read
--      lab  ocr.job.read, ocr.job.write, ocr.validation.write
--    They keep their own work (lab.work-item.*, lab.accession.*,
--    lab.specimen.*, lab.execution.*, lab.result.*, lab.order-route.receive)
--    and ehr.lab-request.read/write.
-- C5 Hospital administrators (admin) lose the lab and pharmacy queue reads
--    (two rows):
--      admin  lab.work-item.read
--      admin  pharmacy.work-item.read
--    They keep running staff (workforce.manage), settings
--    (organization.manage), audit.read and approving new patients
--    (identity.registration.approve).
-- Unchanged on purpose (asserted below): admin identity.registration.approve
-- and nurse ehr.note.write. org_admin holds neither queue read, so it is not
-- touched. Nurses and clinicians are not part of Q103 and keep every row they
-- hold today.
--
-- Staff counts. Before changing anything, this file prints one NOTICE line
-- per row it adds or removes: how many active staff memberships hold that
-- role, how many of them actually gain or lose the permission (a membership
-- that also holds another role granting it is not affected), and how many
-- distinct staff logins that is, each split into real facilities and the
-- sealed QA and demo tenants. Numbers only: no name, email, account or
-- membership id. The migration runner forwards these lines to the release's
-- dry-run and apply logs. The same numbers can be read before signing with
-- the read-only query docs/rollback/0136_affected_staff_counts.sql. No audit
-- row is written (a dry run must leave audit.events' sequence as it was).
--
-- Undo: docs/rollback/0136_rollback.sql puts the thirteen removed rows back.
-- It is not in the ledger; it becomes the next migration number only if the
-- owner signs it.
--
-- 0. Preconditions (each failure raises 55000 and nothing is applied):
--    0001-0127 applied (auth.session_single_sign_on is the marker); the five
--    roles and the fifteen permission codes it names exist and are active; every row
--    to remove is present and every row to add is absent (otherwise "0136:
--    the role table is not in the reviewed state"); the two rows kept on
--    purpose are present.
-- 1. Counts (NOTICE). 2. The change. 3. Post-checks.
-- Lock: SHARE ROW EXCLUSIVE on auth.role_permissions for the transaction
-- (other writers wait; every reader goes on), taken before the reads.

lock table auth.role_permissions in share row exclusive mode;

do $preconditions$
declare
  missing text;
begin
  if to_regclass('auth.session_single_sign_on') is null
     or to_regclass('auth.role_permissions') is null
     or to_regclass('auth.account_roles') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('identity.sealed_demo_members') is null
     or to_regclass('identity.sealed_qa_members') is null then
    raise exception using errcode = '55000', message = '0136: 0001-0127 must be applied first';
  end if;

  select string_agg(code, ', ' order by code) into missing
    from (values ('receptionist'), ('doctor'), ('lab'), ('admin'), ('nurse')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0136: role missing or inactive: ' || missing;
  end if;

  select string_agg(code, ', ' order by code) into missing
    from (values ('ehr.document.write'), ('ehr.document.read'), ('ocr.job.write'), ('ocr.job.read'),
                 ('ehr.vital.read'), ('outreach.campaign.read'), ('outreach.campaign.write'),
                 ('outreach.registration.read'), ('outreach.registration.write'), ('lab.work-item.read'),
                 ('pharmacy.work-item.read'), ('ehr.encounter.read'), ('ocr.validation.write'),
                 ('identity.registration.approve'), ('ehr.note.write')) wanted(code)
   where not exists (select 1 from auth.permissions permission_row
                      where permission_row.code = wanted.code and permission_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0136: permission missing or inactive: ' || missing;
  end if;

  -- The reviewed state: every row to remove present, every row to add absent.
  select string_agg(change.role_code || ' ' || change.permission_code, ', '
                    order by change.role_code, change.permission_code) into missing
    from (values
      ('receptionist', 'ehr.document.write', 'add'), ('receptionist', 'ehr.document.read', 'add'),
      ('receptionist', 'ocr.job.write', 'add'), ('receptionist', 'ocr.job.read', 'add'),
      ('receptionist', 'ehr.vital.read', 'add'),
      ('doctor', 'ocr.job.write', 'remove'),
      ('doctor', 'outreach.campaign.read', 'remove'), ('doctor', 'outreach.campaign.write', 'remove'),
      ('doctor', 'outreach.registration.read', 'remove'), ('doctor', 'outreach.registration.write', 'remove'),
      ('doctor', 'lab.work-item.read', 'remove'), ('doctor', 'pharmacy.work-item.read', 'remove'),
      ('lab', 'ehr.encounter.read', 'remove'),
      ('lab', 'ocr.job.read', 'remove'), ('lab', 'ocr.job.write', 'remove'), ('lab', 'ocr.validation.write', 'remove'),
      ('admin', 'lab.work-item.read', 'remove'), ('admin', 'pharmacy.work-item.read', 'remove')
    ) change(role_code, permission_code, action)
   where (change.action = 'remove') <> exists (
           select 1 from auth.role_permissions row_now
            where row_now.role_code = change.role_code and row_now.permission_code = change.permission_code);
  if missing is not null then
    raise exception using errcode = '55000', message = '0136: the role table is not in the reviewed state: ' || missing;
  end if;

  if (select count(*) from auth.role_permissions
       where (role_code, permission_code) in (('admin', 'identity.registration.approve'), ('nurse', 'ehr.note.write'))) <> 2 then
    raise exception using errcode = '55000',
      message = '0136: admin identity.registration.approve and nurse ehr.note.write must be present';
  end if;
end
$preconditions$;

-- 1. Counts, before the change: one NOTICE line per row added or removed. The
-- query is docs/rollback/0136_affected_staff_counts.sql's, copied unchanged
-- (indented), so the numbers the owner reads before signing and the numbers
-- this file prints come from the same text.
do $counts$
declare
  line record;
begin
  for line in
    with change(position, role_code, permission_code, action) as (
      values
        (1, 'receptionist', 'ehr.document.write', 'gains'), (2, 'receptionist', 'ehr.document.read', 'gains'),
        (3, 'receptionist', 'ocr.job.write', 'gains'), (4, 'receptionist', 'ocr.job.read', 'gains'),
        (5, 'receptionist', 'ehr.vital.read', 'gains'),
        (6, 'doctor', 'ocr.job.write', 'loses'),
        (7, 'doctor', 'outreach.campaign.read', 'loses'), (8, 'doctor', 'outreach.campaign.write', 'loses'),
        (9, 'doctor', 'outreach.registration.read', 'loses'), (10, 'doctor', 'outreach.registration.write', 'loses'),
        (11, 'doctor', 'lab.work-item.read', 'loses'), (12, 'doctor', 'pharmacy.work-item.read', 'loses'),
        (13, 'lab', 'ehr.encounter.read', 'loses'),
        (14, 'lab', 'ocr.job.read', 'loses'), (15, 'lab', 'ocr.job.write', 'loses'),
        (16, 'lab', 'ocr.validation.write', 'loses'),
        (17, 'admin', 'lab.work-item.read', 'loses'), (18, 'admin', 'pharmacy.work-item.read', 'loses')
    ),
    -- The role table as 0136 leaves it: today's rows less 0136's removals plus its
    -- additions.
    role_table_after as (
      select grant_row.role_code, grant_row.permission_code
        from auth.role_permissions grant_row
       where not exists (select 1 from change
                          where change.action = 'loses' and change.role_code = grant_row.role_code
                            and change.permission_code = grant_row.permission_code)
      union
      select change.role_code, change.permission_code from change where change.action = 'gains'
    ),
    live_membership as (
      select membership.id, membership.account_id, membership.facility_id,
             exists (select 1 from identity.sealed_demo_members sealed
                      where sealed.member_kind = 'facility' and sealed.member_id = membership.facility_id)
             or exists (select 1 from identity.sealed_qa_members sealed
                         where sealed.member_kind = 'facility' and sealed.member_id = membership.facility_id) as sealed
        from identity.staff_facility_memberships membership
        join auth.accounts account_row on account_row.id = membership.account_id
        join identity.staff staff_row on staff_row.id = membership.staff_id
        join identity.facilities facility on facility.id = membership.facility_id
        join identity.organizations organization_row on organization_row.id = membership.organization_id
       where membership.active and membership.migration_hold_reason is null
         and account_row.status = 'active'
         and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
         and staff_row.active and lower(staff_row.verification_status) in ('verified', 'approved', 'active')
         and facility.active and facility.organization_id = membership.organization_id and organization_row.active
    ),
    holder as (
      select change.position, live.id as membership_id, live.account_id, live.sealed,
             -- Another active role at the same membership grants the permission
             -- after 0136: the membership neither gains nor loses it.
             exists (select 1
                       from auth.account_roles other_role
                       join auth.roles other_role_row on other_role_row.code = other_role.role_code and other_role_row.active
                       join role_table_after other_grant
                         on other_grant.role_code = other_role.role_code
                        and other_grant.permission_code = change.permission_code
                      where other_role.membership_id = live.id and other_role.facility_id = live.facility_id
                        and other_role.account_id = live.account_id and other_role.scope_type = 'facility'
                        and other_role.revoked_at is null and other_role.role_code <> change.role_code) as covered
        from change
        join auth.account_roles assignment
          on assignment.role_code = change.role_code and assignment.scope_type = 'facility'
         and assignment.revoked_at is null
        join live_membership live
          on live.id = assignment.membership_id and live.facility_id = assignment.facility_id
         and live.account_id = assignment.account_id
    )
    select change.position,
           change.role_code || ' ' || change.action || ' ' || change.permission_code as change,
           exists (select 1 from auth.role_permissions row_now
                    where row_now.role_code = change.role_code and row_now.permission_code = change.permission_code)
             as row_there_now,
           count(holder.membership_id) filter (where not holder.sealed) as real_memberships_with_role,
           count(holder.membership_id) filter (where not holder.sealed and not holder.covered) as real_memberships_changing,
           count(distinct holder.account_id) filter (where not holder.sealed and not holder.covered)
             as real_staff_logins_changing,
           count(holder.membership_id) filter (where holder.sealed) as sealed_memberships_with_role,
           count(holder.membership_id) filter (where holder.sealed and not holder.covered) as sealed_memberships_changing
      from change
      left join holder on holder.position = change.position
     group by change.position, change.role_code, change.permission_code, change.action
     order by change.position
  loop
    raise notice '0136 count %: %. Real facilities: % active memberships hold the role, % of them change (% staff logins). Sealed QA and demo: % hold the role, % change.',
      line.position, line.change, line.real_memberships_with_role, line.real_memberships_changing,
      line.real_staff_logins_changing, line.sealed_memberships_with_role, line.sealed_memberships_changing;
  end loop;
end
$counts$;

-- 2. The change.
delete from auth.role_permissions
 where (role_code, permission_code) in (
   ('doctor', 'ocr.job.write'),
   ('doctor', 'outreach.campaign.read'), ('doctor', 'outreach.campaign.write'),
   ('doctor', 'outreach.registration.read'), ('doctor', 'outreach.registration.write'),
   ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
   ('lab', 'ehr.encounter.read'),
   ('lab', 'ocr.job.read'), ('lab', 'ocr.job.write'), ('lab', 'ocr.validation.write'),
   ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read'));

insert into auth.role_permissions (role_code, permission_code) values
  ('receptionist', 'ehr.document.write'),
  ('receptionist', 'ehr.document.read'),
  ('receptionist', 'ocr.job.write'),
  ('receptionist', 'ocr.job.read'),
  ('receptionist', 'ehr.vital.read');

-- 3. Post-checks: exactly the thirteen rows gone, the five rows there, the two
-- kept rows still there.
do $postchecks$
begin
  if exists (select 1 from auth.role_permissions
              where (role_code, permission_code) in (
                ('doctor', 'ocr.job.write'),
                ('doctor', 'outreach.campaign.read'), ('doctor', 'outreach.campaign.write'),
                ('doctor', 'outreach.registration.read'), ('doctor', 'outreach.registration.write'),
                ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
                ('lab', 'ehr.encounter.read'),
                ('lab', 'ocr.job.read'), ('lab', 'ocr.job.write'), ('lab', 'ocr.validation.write'),
                ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read')))
     or (select count(*) from auth.role_permissions
          where role_code = 'receptionist'
            and permission_code in ('ehr.document.write', 'ehr.document.read', 'ocr.job.write', 'ocr.job.read',
                                    'ehr.vital.read')) <> 5
     or (select count(*) from auth.role_permissions
          where (role_code, permission_code) in (('admin', 'identity.registration.approve'), ('nurse', 'ehr.note.write'))) <> 2 then
    raise exception using errcode = '55000', message = '0136: post-check failed';
  end if;
end
$postchecks$;
