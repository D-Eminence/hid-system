-- 0136 staff counts, read only: how many staff each of 0136's role-table rows
-- touches, and what follows from them for paper readings and records
-- processing, for the owner to see BEFORE signing 0136 (owner decision
-- Q103 A).
--
-- It reads; it never writes. The first statement makes every later
-- transaction of this session read only, so even a mistaken edit below cannot
-- change anything. It answers numbers only: no name, email, account,
-- membership, facility or patient id, and no patient detail (it counts OCR
-- jobs and access requests by facility and status, nothing else).
--
-- How to run it (the person running it needs read access to the production
-- database; no agent and no release step has that before 0136 is signed):
--   psql "<a read-only production connection>" -v ON_ERROR_STOP=1 \
--     -f docs/rollback/0136_affected_staff_counts.sql
-- or paste it into a read-only query editor session. Use the database owner's
-- login (the one the migrations use): row security hides rows from any other
-- login that does not bypass it, and the first block then stops with a plain
-- message. It answers two tables and one NOTICE line.
--
-- Table 1: one row per row 0136 adds or removes, in 0136's order:
--   change                     e.g. "doctor loses ocr.job.write"
--   row_there_now              true when the role row exists today: before 0136
--                              every "loses" row is true and every "gains" row
--                              false; after 0136 the opposite
--   real_memberships_with_role active staff memberships at real facilities
--                              (not the sealed QA and demo tenants) that hold
--                              the role
--   real_memberships_changing  of those, how many actually gain or lose the
--                              permission: a membership that also holds another
--                              role granting it after 0136 is not affected
--   real_staff_logins_changing the distinct staff logins behind those
--   sealed_memberships_with_role, sealed_memberships_changing
--                              the same for the sealed QA and demo tenants
--                              (fictional staff)
-- Table 2: what follows, lines 19 to 23, each with a number for real
-- facilities and one for the sealed QA and demo tenants:
--   19 facilities where some active member can check a reading today and
--      nobody can after 0136 (for example a clinic with doctors and a front
--      desk but no nurse or clinician, or a laboratory)
--   20 facilities where after 0136 someone can start a reading (it uses the
--      facility's paid OCR pages, 0107) and nobody can check it, so it can
--      never be put into the chart and its scan is deleted after 7 days (0112)
--   21 the same for confirming a reading's patient
--   22 open records-processing requests from staff who lose ocr.job.write;
--      0136 closes them (status expired) so a patient cannot approve access
--      that could never be used
--   23 readings not yet checked at the facilities of line 19 (printed as a
--      NOTICE line after table 2, see the last block)
-- "Active" is identity.has_active_membership's rule: membership active and not
-- held by the cutover, login active and not disabled, staff record active and
-- verified, facility and organisation active; the role assignment not revoked.
-- 0136 prints the same numbers, with the same query text, in the release log
-- (lines "0136 count n: ..."), when it runs.

set session characteristics as transaction read only;

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
 order by change.position;

-- What follows from the rows above, one row per line, numbers only. Checking a
-- reading and confirming its patient run only under records processing, which
-- needs ocr.job.write for the staff member (0104 D8, 0108, 0113), so a
-- facility can check readings only while some active member holds both
-- ocr.job.write and ocr.validation.write (confirming: ocr.job.write and
-- ocr.patient.confirm). Starting a reading needs ocr.job.write and
-- ocr.job.read. Line 23 (readings not yet checked) is counted by the block
-- after this table.
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
 order by wanted.position;

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
