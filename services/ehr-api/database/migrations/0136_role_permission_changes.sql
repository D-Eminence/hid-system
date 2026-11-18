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
-- Rows (auth.role_permissions, role_code / permission_code). The only other
-- change is closing open records-processing requests that can no longer be
-- used (step 3 below): no function, policy, grant or table changes, so
-- runtime-grants.sql is unchanged. Permissions are read from this table on every request
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
-- sealed QA and demo tenants. Then five lines for what follows (19-23):
-- facilities left with nobody who can check a reading or confirm its patient
-- (checking and confirming run under records processing, which needs
-- ocr.job.write: a clinic with doctors and a front desk but no nurse or
-- clinician, or a laboratory, is one), facilities where a reading can still
-- be started (using paid OCR pages) but never checked, readings not yet
-- checked there, and the open records-processing requests step 3 closes.
-- Numbers only: no name, email, account, membership, facility or patient id.
-- The migration runner forwards these lines to the release's dry-run and
-- apply logs. The same numbers can be read before signing with the
-- read-only query docs/rollback/0136_affected_staff_counts.sql. The counts
-- write no audit row; step 3 writes one per request it closes.
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
-- 1. Counts (NOTICE). 2. The change. 3. Closing the open records-processing
-- requests of staff who lost ocr.job.write. 4. Post-checks.
-- Locks: SHARE ROW EXCLUSIVE on auth.role_permissions and on
-- identity.access_requests for the transaction (other writers wait, for
-- example a new access request or a patient's approval; every reader goes
-- on), taken before the reads, so no records-processing request can be made
-- or approved between the snapshot and the close.

lock table auth.role_permissions in share row exclusive mode;
lock table identity.access_requests in share row exclusive mode;

do $preconditions$
declare
  missing text;
begin
  if to_regclass('auth.session_single_sign_on') is null
     or to_regclass('auth.role_permissions') is null
     or to_regclass('auth.account_roles') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('identity.sealed_demo_members') is null
     or to_regclass('identity.sealed_qa_members') is null
     or to_regclass('identity.access_requests') is null
     or to_regclass('ocr.jobs') is null
     or to_regclass('audit.events') is null then
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

-- The numbers are right only if this login sees every row it counts. Row
-- security hides rows of the access requests and of the sealed QA and demo
-- lists from any login but the database owner (the login the migrations use)
-- and from a login that bypasses row security; then this stops with a plain
-- message instead of answering numbers that are too low.
do $visible$
declare
  hidden text;
begin
  select string_agg(table_name, ', ' order by table_name) into hidden
    from unnest(array['auth.role_permissions', 'auth.roles', 'auth.accounts', 'auth.account_roles',
                      'identity.staff_facility_memberships', 'identity.staff', 'identity.facilities',
                      'identity.organizations', 'identity.sealed_demo_members', 'identity.sealed_qa_members',
                      'identity.access_requests']) table_name
   where row_security_active(table_name::regclass);
  if hidden is not null then
    raise exception using errcode = '42501',
      message = '0136 counts: this login cannot see every row of ' || hidden
        || ', so the numbers would be too low. Run it with the database owner''s login (the one the migrations use) in a read-only session.';
  end if;
end
$visible$;

-- 1. Counts, before the change: one NOTICE line per row added or removed
-- (lines 1-18), then one per consequence (lines 19-23). The visibility check
-- above, the two queries and the line-23 block below are
-- docs/rollback/0136_affected_staff_counts.sql's, copied unchanged (the
-- queries indented), so the numbers the owner reads before signing and the
-- numbers this file prints come from the same text.
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
  -- What follows for paper readings and records processing (lines 19-22).
  for line in
    with change(role_code, permission_code, action) as (
      values
        ('receptionist', 'ehr.document.write', 'gains'), ('receptionist', 'ehr.document.read', 'gains'),
        ('receptionist', 'ocr.job.write', 'gains'), ('receptionist', 'ocr.job.read', 'gains'),
        ('receptionist', 'ehr.vital.read', 'gains'),
        ('doctor', 'ocr.job.write', 'loses'),
        ('doctor', 'outreach.campaign.read', 'loses'), ('doctor', 'outreach.campaign.write', 'loses'),
        ('doctor', 'outreach.registration.read', 'loses'), ('doctor', 'outreach.registration.write', 'loses'),
        ('doctor', 'lab.work-item.read', 'loses'), ('doctor', 'pharmacy.work-item.read', 'loses'),
        ('lab', 'ehr.encounter.read', 'loses'),
        ('lab', 'ocr.job.read', 'loses'), ('lab', 'ocr.job.write', 'loses'), ('lab', 'ocr.validation.write', 'loses'),
        ('admin', 'lab.work-item.read', 'loses'), ('admin', 'pharmacy.work-item.read', 'loses')
    ),
    role_table as (
      select 'now' as stage, grant_row.role_code, grant_row.permission_code
        from auth.role_permissions grant_row
      union all
      select 'after', grant_row.role_code, grant_row.permission_code
        from auth.role_permissions grant_row
       where not exists (select 1 from change
                          where change.action = 'loses' and change.role_code = grant_row.role_code
                            and change.permission_code = grant_row.permission_code)
      union
      select 'after', change.role_code, change.permission_code from change where change.action = 'gains'
    ),
    live_membership as (
      select membership.id, membership.facility_id,
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
    -- Each active member's codes today and after 0136, through its active roles.
    member as (
      select live.id, live.facility_id, live.sealed,
             count(distinct role_table.permission_code) filter (where role_table.stage = 'now'
               and role_table.permission_code in ('ocr.job.write', 'ocr.validation.write')) = 2 as checks_now,
             count(distinct role_table.permission_code) filter (where role_table.stage = 'after'
               and role_table.permission_code in ('ocr.job.write', 'ocr.validation.write')) = 2 as checks_after,
             count(distinct role_table.permission_code) filter (where role_table.stage = 'after'
               and role_table.permission_code in ('ocr.job.write', 'ocr.patient.confirm')) = 2 as confirms_after,
             count(distinct role_table.permission_code) filter (where role_table.stage = 'after'
               and role_table.permission_code in ('ocr.job.write', 'ocr.job.read')) = 2 as starts_after,
             bool_or(role_table.stage = 'now' and role_table.permission_code = 'ocr.job.write') as writes_now,
             bool_or(role_table.stage = 'after' and role_table.permission_code = 'ocr.job.write') as writes_after
        from live_membership live
        join auth.account_roles assignment
          on assignment.membership_id = live.id and assignment.facility_id = live.facility_id
         and assignment.scope_type = 'facility' and assignment.revoked_at is null
        join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
        join role_table on role_table.role_code = assignment.role_code
       group by live.id, live.facility_id, live.sealed
    ),
    place as (
      select member.facility_id, member.sealed, bool_or(member.checks_now) as checks_now,
             bool_or(member.checks_after) as checks_after, bool_or(member.confirms_after) as confirms_after,
             bool_or(member.starts_after) as starts_after
        from member
       group by member.facility_id, member.sealed
    ),
    consequence_line(position, consequence, sealed, counted) as (
      select 19, 'facilities where staff can check a reading today and nobody can after 0136', place.sealed,
             count(*) filter (where place.checks_now and not place.checks_after)
        from place group by place.sealed
      union all
      select 20, 'facilities where after 0136 staff can start a reading and nobody can check it', place.sealed,
             count(*) filter (where place.starts_after and not place.checks_after)
        from place group by place.sealed
      union all
      select 21, 'facilities where after 0136 staff can start a reading and nobody can confirm its patient', place.sealed,
             count(*) filter (where place.starts_after and not place.confirms_after)
        from place group by place.sealed
      union all
      select 22, 'open records-processing requests from staff who lose ocr.job.write (0136 closes them)', member.sealed,
             count(request_row.id)
        from member
        join identity.access_requests request_row
          on request_row.membership_id = member.id and request_row.facility_id = member.facility_id
         and request_row.status = 'pending' and request_row.purpose_of_use = 'healthcare-operations'
         and not request_row.break_glass and request_row.migration_hold_reason is null
       where member.writes_now and not member.writes_after
       group by member.sealed
    )
    select wanted.position, wanted.consequence,
           coalesce(sum(consequence_line.counted) filter (where not consequence_line.sealed), 0)::bigint as real_count,
           coalesce(sum(consequence_line.counted) filter (where consequence_line.sealed), 0)::bigint as sealed_count
      from (values
        (19, 'facilities where staff can check a reading today and nobody can after 0136'),
        (20, 'facilities where after 0136 staff can start a reading and nobody can check it'),
        (21, 'facilities where after 0136 staff can start a reading and nobody can confirm its patient'),
        (22, 'open records-processing requests from staff who lose ocr.job.write (0136 closes them)')
      ) wanted(position, consequence)
      left join consequence_line on consequence_line.position = wanted.position
     group by wanted.position, wanted.consequence
     order by wanted.position
  loop
    raise notice '0136 count %: %: % at real facilities, % at the sealed QA and demo tenants.',
      line.position, line.consequence, line.real_count, line.sealed_count;
  end loop;
end
$counts$;

-- Line 23: readings not yet checked (queued, being read, read, or waiting for
-- their check) at the facilities of line 19. OCR jobs are read under their
-- facility's row security even by the database owner, so this names each
-- facility in turn for the count (transaction-local, as 0107 does) and puts
-- the setting back. It prints the line as a NOTICE and leaves the two numbers
-- in the session setting zero136.unchecked_readings ("real/sealed").
do $unchecked_readings$
declare
  facility_row record;
  waiting bigint;
  real_count bigint := 0;
  sealed_count bigint := 0;
  session_facility text := current_setting('app.facility_id', true);
begin
  for facility_row in
    with change(role_code, permission_code, action) as (
      values
        ('receptionist', 'ehr.document.write', 'gains'), ('receptionist', 'ehr.document.read', 'gains'),
        ('receptionist', 'ocr.job.write', 'gains'), ('receptionist', 'ocr.job.read', 'gains'),
        ('receptionist', 'ehr.vital.read', 'gains'),
        ('doctor', 'ocr.job.write', 'loses'),
        ('doctor', 'outreach.campaign.read', 'loses'), ('doctor', 'outreach.campaign.write', 'loses'),
        ('doctor', 'outreach.registration.read', 'loses'), ('doctor', 'outreach.registration.write', 'loses'),
        ('doctor', 'lab.work-item.read', 'loses'), ('doctor', 'pharmacy.work-item.read', 'loses'),
        ('lab', 'ehr.encounter.read', 'loses'),
        ('lab', 'ocr.job.read', 'loses'), ('lab', 'ocr.job.write', 'loses'), ('lab', 'ocr.validation.write', 'loses'),
        ('admin', 'lab.work-item.read', 'loses'), ('admin', 'pharmacy.work-item.read', 'loses')
    ),
    role_table as (
      select 'now' as stage, grant_row.role_code, grant_row.permission_code
        from auth.role_permissions grant_row
      union all
      select 'after', grant_row.role_code, grant_row.permission_code
        from auth.role_permissions grant_row
       where not exists (select 1 from change
                          where change.action = 'loses' and change.role_code = grant_row.role_code
                            and change.permission_code = grant_row.permission_code)
      union
      select 'after', change.role_code, change.permission_code from change where change.action = 'gains'
    ),
    live_membership as (
      select membership.id, membership.facility_id,
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
    -- Each active member's codes today and after 0136, through its active roles.
    member as (
      select live.id, live.facility_id, live.sealed,
             count(distinct role_table.permission_code) filter (where role_table.stage = 'now'
               and role_table.permission_code in ('ocr.job.write', 'ocr.validation.write')) = 2 as checks_now,
             count(distinct role_table.permission_code) filter (where role_table.stage = 'after'
               and role_table.permission_code in ('ocr.job.write', 'ocr.validation.write')) = 2 as checks_after,
             count(distinct role_table.permission_code) filter (where role_table.stage = 'after'
               and role_table.permission_code in ('ocr.job.write', 'ocr.patient.confirm')) = 2 as confirms_after,
             count(distinct role_table.permission_code) filter (where role_table.stage = 'after'
               and role_table.permission_code in ('ocr.job.write', 'ocr.job.read')) = 2 as starts_after,
             bool_or(role_table.stage = 'now' and role_table.permission_code = 'ocr.job.write') as writes_now,
             bool_or(role_table.stage = 'after' and role_table.permission_code = 'ocr.job.write') as writes_after
        from live_membership live
        join auth.account_roles assignment
          on assignment.membership_id = live.id and assignment.facility_id = live.facility_id
         and assignment.scope_type = 'facility' and assignment.revoked_at is null
        join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
        join role_table on role_table.role_code = assignment.role_code
       group by live.id, live.facility_id, live.sealed
    ),
    place as (
      select member.facility_id, member.sealed, bool_or(member.checks_now) as checks_now,
             bool_or(member.checks_after) as checks_after, bool_or(member.confirms_after) as confirms_after,
             bool_or(member.starts_after) as starts_after
        from member
       group by member.facility_id, member.sealed
    )
    select place.facility_id, place.sealed from place where place.checks_now and not place.checks_after
     order by place.facility_id
  loop
    perform set_config('app.facility_id', facility_row.facility_id::text, true);
    select count(*) into waiting from ocr.jobs job
     where job.facility_id = facility_row.facility_id
       and job.status in ('queued', 'processing', 'extracted', 'awaiting_validation');
    if facility_row.sealed then sealed_count := sealed_count + waiting; else real_count := real_count + waiting; end if;
  end loop;
  perform set_config('app.facility_id', coalesce(session_facility, ''), true);
  perform set_config('zero136.unchecked_readings', real_count || '/' || sealed_count, false);
  raise notice '0136 count 23: readings not yet checked at the facilities of line 19: % at real facilities, % at the sealed QA and demo tenants.',
    real_count, sealed_count;
end
$unchecked_readings$;

-- Open records-processing requests whose staff member holds ocr.job.write
-- now, by the check every service and 0104's trigger use; 0136 closes those
-- whose staff member no longer holds it after the change (step 3).
create temporary table zero136_records_processing_requests on commit drop as
select request_row.id
  from identity.access_requests request_row
  join identity.staff_facility_memberships membership on membership.id = request_row.membership_id
  join auth.accounts account_row on account_row.id = membership.account_id
 where request_row.status = 'pending' and request_row.purpose_of_use = 'healthcare-operations'
   and not request_row.break_glass and request_row.migration_hold_reason is null
   and coalesce(auth.membership_has_permission(account_row.subject, request_row.membership_id,
                  request_row.facility_id, 'ocr.job.write'), false);

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

-- 3. Close the open records-processing requests made by staff who lost
-- ocr.job.write here (doctors and laboratory staff with no other role that
-- grants it). 0104's trigger checks ocr.job.write only when a request is
-- made, so without this a patient could still approve one, and the grant would
-- show in their access history but never work (0104 D8, 0108 and 0113 check
-- ocr.job.write at each use). Status 'expired', as 0086 and 0096 close
-- pending requests; one audit row per request (system actor, the plain
-- reason, ids only, no patient detail), the patient's own audit trail shows
-- it. The undo does not reopen them: the staff member asks again.
do $close_requests$
declare
  closed integer;
begin
  with closed_request as (
    update identity.access_requests request_row
       set status = 'expired', updated_at = clock_timestamp(), row_version = request_row.row_version + 1
      from identity.staff_facility_memberships membership
      join auth.accounts account_row on account_row.id = membership.account_id
     where request_row.id in (select snapshot.id from zero136_records_processing_requests snapshot)
       and request_row.status = 'pending'
       and membership.id = request_row.membership_id
       and not coalesce(auth.membership_has_permission(account_row.subject, request_row.membership_id,
                          request_row.facility_id, 'ocr.job.write'), false)
    returning request_row.id, request_row.patient_id, request_row.facility_id, request_row.scope
  ), audited as (
    insert into audit.events (
      correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, reason, provenance, source_system, details
    )
    select '0136-role-permission-changes', 'system', closed_request.facility_id, closed_request.patient_id,
           'identity.access-request.close', 'success', 'access-request', closed_request.id::text,
           'healthcare-operations', 'This staff member can no longer process records', 'migration', 'hid-0136',
           jsonb_build_object('migration', '0136', 'status', 'expired', 'scope', closed_request.scope)
      from closed_request
    returning 1
  )
  select count(*) into closed from audited;
  raise notice '0136 closed % open records-processing requests (staff who no longer hold ocr.job.write).', closed;
end
$close_requests$;

-- 4. Post-checks: exactly the thirteen rows gone, the five rows there, the two
-- kept rows still there, and no open records-processing request left from a
-- staff member who lost ocr.job.write here.
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
          where (role_code, permission_code) in (('admin', 'identity.registration.approve'), ('nurse', 'ehr.note.write'))) <> 2
     or exists (select 1
                  from identity.access_requests request_row
                  join zero136_records_processing_requests snapshot on snapshot.id = request_row.id
                  join identity.staff_facility_memberships membership on membership.id = request_row.membership_id
                  join auth.accounts account_row on account_row.id = membership.account_id
                 where request_row.status = 'pending'
                   and not coalesce(auth.membership_has_permission(account_row.subject, request_row.membership_id,
                                      request_row.facility_id, 'ocr.job.write'), false)) then
    raise exception using errcode = '55000', message = '0136: post-check failed';
  end if;
end
$postchecks$;
