-- 0136 staff counts, read only: how many staff each of 0136's role-table rows
-- touches, for the owner to see BEFORE signing 0136 (owner decision Q103 A).
--
-- It reads; it never writes. The first statement makes every later
-- transaction of this session read only, so even a mistaken edit below cannot
-- change anything. It answers numbers only: no name, email, account,
-- membership, facility or patient id, and it reads no patient table.
--
-- How to run it (the person running it needs read access to the production
-- database; no agent and no release step has that before 0136 is signed):
--   psql "<a read-only production connection>" -v ON_ERROR_STOP=1 \
--     -f docs/rollback/0136_affected_staff_counts.sql
-- or paste it into a read-only query editor session.
--
-- One row per row 0136 adds or removes, in 0136's order:
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
-- "Active" is identity.has_active_membership's rule: membership active and not
-- held by the cutover, login active and not disabled, staff record active and
-- verified, facility and organisation active; the role assignment not revoked.
-- 0136 prints the same numbers, with the same query, in the release log
-- (lines "0136 count n: ..."), when it runs.

set session characteristics as transaction read only;

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
