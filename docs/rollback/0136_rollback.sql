-- Prepared undo of 0136 (owner decision Q103 A): puts back exactly the
-- thirteen role-table rows 0136 removed. NOT in the migration ledger and not
-- applied by any release. To use it: copy it into
-- services/ehr-api/database/migrations/ as the next free number (for example
-- 01NN_undo_0136_role_removals.sql), add its ledger entry and declaration,
-- and the owner signs it like any migration. It is written in the
-- migration runner's format (plain SQL, no psql commands, one transaction).
--
-- What it does:
--   puts back  doctor  ocr.job.write
--              doctor  outreach.campaign.read, outreach.campaign.write,
--                      outreach.registration.read, outreach.registration.write
--              doctor  lab.work-item.read, pharmacy.work-item.read
--              lab     ehr.encounter.read
--              lab     ocr.job.read, ocr.job.write, ocr.validation.write
--              admin   lab.work-item.read, pharmacy.work-item.read
--   Each row comes back with a new granted_at (the time of the undo); the
--   table keeps no other column. A row already there is left as it is, so the
--   undo can be run again safely.
-- What it does not do: it leaves the five front-desk rows 0136 added
-- (receptionist ehr.document.write, ehr.document.read, ocr.job.write,
-- ocr.job.read, ehr.vital.read), so the desk keeps scanning and seeing
-- vitals. To take those back as well, the same file would also run:
--   delete from auth.role_permissions
--    where role_code = 'receptionist'
--      and permission_code in ('ehr.document.write', 'ehr.document.read',
--                              'ocr.job.write', 'ocr.job.read', 'ehr.vital.read');
-- Takes effect on each staff member's next request, as 0136 did. It prints
-- one NOTICE line per row put back with how many active memberships hold the
-- role (numbers only, the same rule as 0136's counts).
--
-- Preconditions (55000, nothing applied): the three roles and ten
-- permission codes exist and are active.

lock table auth.role_permissions in share row exclusive mode;

do $preconditions$
declare
  missing text;
begin
  select string_agg(code, ', ' order by code) into missing
    from (values ('doctor'), ('lab'), ('admin')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0136 undo: role missing or inactive: ' || missing;
  end if;
  select string_agg(code, ', ' order by code) into missing
    from (values ('ocr.job.write'), ('ocr.job.read'), ('ocr.validation.write'), ('outreach.campaign.read'),
                 ('outreach.campaign.write'), ('outreach.registration.read'), ('outreach.registration.write'),
                 ('lab.work-item.read'), ('pharmacy.work-item.read'), ('ehr.encounter.read')) wanted(code)
   where not exists (select 1 from auth.permissions permission_row
                      where permission_row.code = wanted.code and permission_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0136 undo: permission missing or inactive: ' || missing;
  end if;
end
$preconditions$;

do $counts$
declare
  line record;
begin
  for line in
    select restored.role_code, restored.permission_code,
           (select count(*)
              from auth.account_roles assignment
              join identity.staff_facility_memberships membership
                on membership.id = assignment.membership_id and membership.facility_id = assignment.facility_id
               and membership.account_id = assignment.account_id
              join auth.accounts account_row on account_row.id = membership.account_id
              join identity.staff staff_row on staff_row.id = membership.staff_id
              join identity.facilities facility on facility.id = membership.facility_id
              join identity.organizations organization_row on organization_row.id = membership.organization_id
             where assignment.role_code = restored.role_code and assignment.scope_type = 'facility'
               and assignment.revoked_at is null
               and membership.active and membership.migration_hold_reason is null
               and account_row.status = 'active'
               and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
               and staff_row.active and lower(staff_row.verification_status) in ('verified', 'approved', 'active')
               and facility.active and facility.organization_id = membership.organization_id
               and organization_row.active) as holders,
           exists (select 1 from auth.role_permissions row_now
                    where row_now.role_code = restored.role_code
                      and row_now.permission_code = restored.permission_code) as already_there
      from (values ('doctor', 'ocr.job.write'),
                   ('doctor', 'outreach.campaign.read'), ('doctor', 'outreach.campaign.write'),
                   ('doctor', 'outreach.registration.read'), ('doctor', 'outreach.registration.write'),
                   ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
                   ('lab', 'ehr.encounter.read'),
                   ('lab', 'ocr.job.read'), ('lab', 'ocr.job.write'), ('lab', 'ocr.validation.write'),
                   ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read')) restored(role_code, permission_code)
  loop
    raise notice '0136 undo: % gets % back (% active memberships hold the role%)',
      line.role_code, line.permission_code, line.holders,
      case when line.already_there then '; the row was already there' else '' end;
  end loop;
end
$counts$;

insert into auth.role_permissions (role_code, permission_code) values
  ('doctor', 'ocr.job.write'),
  ('doctor', 'outreach.campaign.read'), ('doctor', 'outreach.campaign.write'),
  ('doctor', 'outreach.registration.read'), ('doctor', 'outreach.registration.write'),
  ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
  ('lab', 'ehr.encounter.read'),
  ('lab', 'ocr.job.read'), ('lab', 'ocr.job.write'), ('lab', 'ocr.validation.write'),
  ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read')
on conflict (role_code, permission_code) do nothing;

do $postchecks$
begin
  if (select count(*) from auth.role_permissions
       where (role_code, permission_code) in (
         ('doctor', 'ocr.job.write'),
         ('doctor', 'outreach.campaign.read'), ('doctor', 'outreach.campaign.write'),
         ('doctor', 'outreach.registration.read'), ('doctor', 'outreach.registration.write'),
         ('doctor', 'lab.work-item.read'), ('doctor', 'pharmacy.work-item.read'),
         ('lab', 'ehr.encounter.read'),
         ('lab', 'ocr.job.read'), ('lab', 'ocr.job.write'), ('lab', 'ocr.validation.write'),
         ('admin', 'lab.work-item.read'), ('admin', 'pharmacy.work-item.read'))) <> 13 then
    raise exception using errcode = '55000', message = '0136 undo: post-check failed';
  end if;
end
$postchecks$;
