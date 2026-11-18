-- 0136 staff counts, read only (owner decisions Q103 A, Q111 A, Q112 A,
-- Q113 A). How many staff each of 0136's changes touches, and what follows
-- for paper readings and records processing. DevOps runs it ONCE against
-- production before the owner signs 0136; the owner writes the numbers it
-- prints into 0136 as the most staff 0136 may touch, and 0136 stops at apply
-- if more would be touched by then.
--
-- It reads; it never writes. The first statement makes every later
-- transaction of this session read only, so even a mistaken edit below cannot
-- change anything. It answers numbers only: no name, email, account,
-- membership, facility or patient id, and no patient detail (it counts OCR
-- readings and access requests by facility and status, nothing else).
--
-- How to run it (DevOps, with read access to the production database; no
-- agent and no release step has that before 0136 is signed):
--   psql "<production, the database owner's login (the one the migrations
--          use), read-only session>" -v ON_ERROR_STOP=1 \
--     -f docs/rollback/0136_affected_staff_counts.sql
-- psql is needed (the header lines are psql \echo lines). Use the database
-- owner's login: row security hides rows from any other login that does not
-- bypass it, and the file then stops with a plain message instead of printing
-- numbers that are too low. It runs in a few seconds and takes no lock that
-- stops anybody's work.
--
-- What it prints: a short header, then table 1 (one row per line, 26 lines)
-- and table 2 (lines 1 to 24 again, in the exact form the owner writes into
-- 0136). Send both tables to the owner. They hold numbers only.
--
-- The count itself is the block do $count_0136$ below. 0136 carries the same
-- block, character for character (a test in ehr-api checks this), so the
-- numbers DevOps reads and the numbers the release prints at apply come from
-- the same text. When 0136 runs it, the block also compares each line with
-- the owner's maximum; when this file runs it, no maximum is given and the
-- block only counts.

set session characteristics as transaction read only;

\echo ''
\echo '0136 staff counts (read only; numbers only, no names or ids)'
\echo ''
\echo 'Table 1, one row per line. Columns:'
\echo '  at real facilities     lines 1-21: active staff memberships at real facilities that this line changes'
\echo '                         (a membership that keeps the permission through another of its roles is not counted);'
\echo '                         lines 22-24: facilities; line 25: open requests; line 26: readings'
\echo '  staff logins           lines 1-21 only: the distinct staff logins behind those memberships'
\echo '  sealed QA and demo     the same count at the sealed QA and demo tenants (fictional staff)'
\echo 'Lines:'
\echo '   1-8   what the front desk (receptionist), nurses and clinicians gain. The front desk gains uploading'
\echo '         scans, seeing only its own uploads (ehr.document.read-own), starting a reading (ocr.job.write and'
\echo '         ocr.job.start), following the readings of its own uploads without their text (ocr.job.read-own)'
\echo '         and seeing vitals. Nurses and clinicians gain ocr.job.start: from 0136 starting a reading needs'
\echo '         it, so they keep starting readings; nothing changes for them.'
\echo '   9-20  what doctors, laboratory staff and hospital administrators lose (Outreach, the laboratory and'
\echo '         pharmacy work lists, and for laboratory staff visits and paper readings).'
\echo '  21     doctors who can start a reading today and cannot after 0136 (they keep checking readings and'
\echo '         confirming their patient).'
\echo '  22     facilities where someone can check a reading today and nobody can after 0136.'
\echo '  23     facilities where after 0136 someone can start a reading and nobody can check it.'
\echo '  24     the same for confirming a reading''s patient.'
\echo '  25     open records-processing requests that 0136 closes (their staff member can no longer use them).'
\echo '  26     readings not yet checked at the facilities of line 22.'
\echo 'Table 2: lines 1 to 24 as "(line, at real facilities, staff logins)". The owner writes these rows into'
\echo '0136 (section "The owner''s maximums") before signing. At apply, 0136 prints the counts again and stops,'
\echo 'changing nothing, if any of lines 1 to 24 is higher than the number written there. Lines 25 and 26'
\echo 'change by the hour, so they are printed only.'
\echo ''

do $count_0136$
-- 0136's count (the same text in docs/rollback/0136_affected_staff_counts.sql
-- and in the migration). It counts, keeps the answer in the session setting
-- zero136.counts (numbers only), and, when the caller set the owner's maximums
-- in zero136.owner_maximums (0136 does, from its own text), compares each of
-- lines 1-24 with them: zero136.maximums_checked says whether it compared,
-- zero136.over_maximums names every line that is higher ('' when none).
declare
  hidden text;
  lines jsonb;
  places_left jsonb;
  place_row jsonb;
  waiting bigint;
  unchecked_real bigint := 0;
  unchecked_sealed bigint := 0;
  session_facility text := current_setting('app.facility_id', true);
  maximums_text text := coalesce(current_setting('zero136.owner_maximums', true), '');
  maximums jsonb;
  over text;
  line_row record;
begin
  perform set_config('zero136.counts', '', false), set_config('zero136.maximums_checked', 'no', false),
          set_config('zero136.over_maximums', '', false);
  -- The numbers are right only if this login sees every row it counts. Row
  -- security hides rows of the access requests and of the sealed QA and demo
  -- lists from any login but the database owner (the login the migrations use)
  -- and a login that bypasses row security; then this stops with a plain
  -- message instead of answering numbers that are too low.
  select string_agg(table_name, ', ' order by table_name) into hidden
    from unnest(array['auth.permissions', 'auth.role_permissions', 'auth.roles', 'auth.accounts',
                      'auth.account_roles', 'identity.staff_facility_memberships', 'identity.staff',
                      'identity.facilities', 'identity.organizations', 'identity.sealed_demo_members',
                      'identity.sealed_qa_members', 'identity.access_requests']) table_name
   where row_security_active(table_name::regclass);
  if hidden is not null then
    raise exception using errcode = '42501',
      message = '0136 counts: this login cannot see every row of ' || hidden
        || ', so the numbers would be too low. Run it with the database owner''s login (the one the migrations use) in a read-only session.';
  end if;
  if exists (select 1 from auth.permissions
              where code in ('ocr.job.start', 'ocr.job.read-own', 'ehr.document.read-own')) then
    raise exception using errcode = '55000',
      message = '0136 counts: this database already has 0136''s new permissions, so 0136 has already run here and there is nothing left to count.';
  end if;

  with change(position, role_code, permission_code, action) as (
    values
      (1, 'receptionist', 'ehr.document.write', 'gains'), (2, 'receptionist', 'ehr.document.read-own', 'gains'),
      (3, 'receptionist', 'ocr.job.write', 'gains'), (4, 'receptionist', 'ocr.job.start', 'gains'),
      (5, 'receptionist', 'ocr.job.read-own', 'gains'), (6, 'receptionist', 'ehr.vital.read', 'gains'),
      (7, 'nurse', 'ocr.job.start', 'gains'), (8, 'clinician', 'ocr.job.start', 'gains'),
      (9, 'doctor', 'outreach.campaign.read', 'loses'), (10, 'doctor', 'outreach.campaign.write', 'loses'),
      (11, 'doctor', 'outreach.registration.read', 'loses'), (12, 'doctor', 'outreach.registration.write', 'loses'),
      (13, 'doctor', 'lab.work-item.read', 'loses'), (14, 'doctor', 'pharmacy.work-item.read', 'loses'),
      (15, 'lab', 'ehr.encounter.read', 'loses'), (16, 'lab', 'ocr.job.read', 'loses'),
      (17, 'lab', 'ocr.job.write', 'loses'), (18, 'lab', 'ocr.validation.write', 'loses'),
      (19, 'admin', 'lab.work-item.read', 'loses'), (20, 'admin', 'pharmacy.work-item.read', 'loses')
  ),
  -- The role table today ('now') and as 0136 leaves it ('after').
  role_table as (
    select 'now' as stage, grant_row.role_code, grant_row.permission_code
      from auth.role_permissions grant_row
    union all
    select 'after', grant_row.role_code, grant_row.permission_code
      from auth.role_permissions grant_row
     where not exists (select 1 from change
                        where change.action = 'loses' and change.role_code = grant_row.role_code
                          and change.permission_code = grant_row.permission_code)
    union all
    select 'after', change.role_code, change.permission_code from change where change.action = 'gains'
  ),
  -- "Active" is identity.has_active_membership's rule and
  -- auth.membership_has_permission's: membership active and not held by the
  -- cutover, login active and not disabled, staff record active and verified,
  -- facility and organisation active; the role assignment not revoked and the
  -- role active.
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
  assignment as (
    select live.id as membership_id, live.account_id, live.facility_id, live.sealed, role_row.code as role_code
      from live_membership live
      join auth.account_roles assignment_row
        on assignment_row.membership_id = live.id and assignment_row.facility_id = live.facility_id
       and assignment_row.account_id = live.account_id and assignment_row.scope_type = 'facility'
       and assignment_row.revoked_at is null
      join auth.roles role_row on role_row.code = assignment_row.role_code and role_row.active
  ),
  -- Lines 1-20: each membership holding the changed role. A gain changes
  -- nothing for a membership whose other role grants the code today; a loss
  -- changes nothing for one whose other role still grants it after 0136.
  holder as (
    select change.position, assignment.membership_id, assignment.account_id, assignment.sealed,
           exists (select 1
                     from assignment other_role
                     join role_table other_grant
                       on other_grant.role_code = other_role.role_code
                      and other_grant.permission_code = change.permission_code
                      and other_grant.stage = case when change.action = 'gains' then 'now' else 'after' end
                    where other_role.membership_id = assignment.membership_id
                      and other_role.role_code <> change.role_code) as covered
      from change
      join assignment on assignment.role_code = change.role_code
  ),
  -- Each active membership's codes today and after 0136, through all its
  -- active roles, and what it can do with paper readings. Starting a reading
  -- needs ocr.job.write and the source read (ocr.job.read) today; after 0136
  -- it needs ocr.job.write, ocr.job.start and ocr.job.read or ocr.job.read-own.
  -- Checking needs ocr.job.write and ocr.validation.write, confirming the
  -- patient ocr.job.write and ocr.patient.confirm (both run under records
  -- processing, which needs ocr.job.write).
  member as (
    select assignment.membership_id as id, assignment.account_id, assignment.facility_id, assignment.sealed,
           bool_or(assignment.role_code = 'doctor') as doctor,
           coalesce(array_agg(distinct role_table.permission_code) filter (where role_table.stage = 'now'),
                    '{}'::text[]) as now_codes,
           coalesce(array_agg(distinct role_table.permission_code) filter (where role_table.stage = 'after'),
                    '{}'::text[]) as after_codes
      from assignment
      left join role_table on role_table.role_code = assignment.role_code
     group by assignment.membership_id, assignment.account_id, assignment.facility_id, assignment.sealed
  ),
  ability as (
    select member.id, member.account_id, member.facility_id, member.sealed, member.doctor,
           member.now_codes @> array['ocr.job.write', 'ocr.validation.write'] as checks_now,
           member.after_codes @> array['ocr.job.write', 'ocr.validation.write'] as checks_after,
           member.after_codes @> array['ocr.job.write', 'ocr.patient.confirm'] as confirms_after,
           member.now_codes @> array['ocr.job.write', 'ocr.job.read'] as starts_now,
           member.after_codes @> array['ocr.job.write', 'ocr.job.start']
             and member.after_codes && array['ocr.job.read', 'ocr.job.read-own'] as starts_after,
           'ocr.job.write' = any(member.now_codes) as writes_now,
           'ocr.job.write' = any(member.after_codes) as writes_after
      from member
  ),
  place as (
    select ability.facility_id, ability.sealed, bool_or(ability.checks_now) as checks_now,
           bool_or(ability.checks_after) as checks_after, bool_or(ability.confirms_after) as confirms_after,
           bool_or(ability.starts_after) as starts_after
      from ability
     group by ability.facility_id, ability.sealed
  ),
  line(position, what, real_count, real_logins, sealed_count) as (
    select change.position, change.role_code || ' ' || change.action || ' ' || change.permission_code,
           count(holder.membership_id) filter (where not holder.sealed and not holder.covered),
           count(distinct holder.account_id) filter (where not holder.sealed and not holder.covered),
           count(holder.membership_id) filter (where holder.sealed and not holder.covered)
      from change
      left join holder on holder.position = change.position
     group by change.position, change.role_code, change.action, change.permission_code
    union all
    select 21, 'doctors who can start a reading today and cannot after 0136',
           count(*) filter (where not ability.sealed), count(distinct ability.account_id) filter (where not ability.sealed),
           count(*) filter (where ability.sealed)
      from ability
     where ability.doctor and ability.starts_now and not ability.starts_after
    union all
    select 22, 'facilities where staff can check a reading today and nobody can after 0136',
           count(*) filter (where not place.sealed), null::bigint, count(*) filter (where place.sealed)
      from place
     where place.checks_now and not place.checks_after
    union all
    select 23, 'facilities where after 0136 staff can start a reading and nobody can check it',
           count(*) filter (where not place.sealed), null::bigint, count(*) filter (where place.sealed)
      from place
     where place.starts_after and not place.checks_after
    union all
    select 24, 'facilities where after 0136 staff can start a reading and nobody can confirm its patient',
           count(*) filter (where not place.sealed), null::bigint, count(*) filter (where place.sealed)
      from place
     where place.starts_after and not place.confirms_after
    union all
    select 25, 'open records-processing requests from staff who lose ocr.job.write (0136 closes them)',
           count(request_row.id) filter (where not ability.sealed), null::bigint,
           count(request_row.id) filter (where ability.sealed)
      from ability
      join identity.access_requests request_row
        on request_row.membership_id = ability.id and request_row.facility_id = ability.facility_id
       and request_row.status = 'pending' and request_row.purpose_of_use = 'healthcare-operations'
       and not request_row.break_glass and request_row.migration_hold_reason is null
     where ability.writes_now and not ability.writes_after
  )
  select (select jsonb_agg(jsonb_build_object('line', line.position, 'what', line.what, 'real_count', line.real_count,
                                              'logins', line.real_logins, 'sealed_count', line.sealed_count)
                           order by line.position)
            from line),
         (select coalesce(jsonb_agg(jsonb_build_object('facility', place.facility_id, 'sealed', place.sealed)),
                          '[]'::jsonb)
            from place
           where place.checks_now and not place.checks_after)
    into lines, places_left;

  -- Line 26: readings not yet checked (queued, being read, read, or waiting
  -- for their check) at the facilities of line 22. OCR readings are read under
  -- their facility's row security even by the database owner, so this names
  -- each facility in turn (transaction-local, as 0107 does) and puts the
  -- setting back. The facility ids stay inside this block.
  for place_row in select value from jsonb_array_elements(places_left) loop
    perform set_config('app.facility_id', place_row ->> 'facility', true);
    select count(*) into waiting from ocr.jobs job
     where job.facility_id = (place_row ->> 'facility')::uuid
       and job.status in ('queued', 'processing', 'extracted', 'awaiting_validation');
    if (place_row ->> 'sealed')::boolean then
      unchecked_sealed := unchecked_sealed + waiting;
    else
      unchecked_real := unchecked_real + waiting;
    end if;
  end loop;
  perform set_config('app.facility_id', coalesce(session_facility, ''), true);
  lines := lines || jsonb_build_array(jsonb_build_object('line', 26,
    'what', 'readings not yet checked at the facilities of line 22', 'real_count', unchecked_real, 'logins', null,
    'sealed_count', unchecked_sealed));
  perform set_config('zero136.counts', lines::text, false);

  -- The owner's maximums (0136 sets them from its own text; this file does
  -- not). A line not filled in allows nobody: it stops wherever that line
  -- touches anyone at a real facility.
  if maximums_text = '' then
    return;
  end if;
  maximums := maximums_text::jsonb;
  if jsonb_typeof(maximums) <> 'array'
     or (select count(*) from jsonb_array_elements(maximums)) <> 24
     or (select count(distinct (item ->> 'line')::integer) from jsonb_array_elements(maximums) item
          where (item ->> 'line')::integer between 1 and 24) <> 24 then
    raise exception using errcode = '55000',
      message = '0136: the owner''s maximums must list lines 1 to 24, once each; nothing was changed.';
  end if;
  for line_row in
    select counted.line, counted.what, counted.real_count, counted.logins, counted.sealed_count,
           (allowed.item ->> 'real_count')::bigint as real_maximum, (allowed.item ->> 'logins')::bigint as logins_maximum,
           allowed.item ->> 'real_count' is not null and (counted.logins is null or allowed.item ->> 'logins' is not null)
             as filled
      from jsonb_to_recordset(lines) counted(line integer, what text, real_count bigint, logins bigint, sealed_count bigint)
      left join lateral (select item from jsonb_array_elements(maximums) item
                          where (item ->> 'line')::integer = counted.line) allowed on true
     order by counted.line
  loop
    if line_row.line > 24 then
      raise notice '0136 count %: %: % at real facilities, % at the sealed QA and demo tenants (printed only).',
        line_row.line, line_row.what, line_row.real_count, line_row.sealed_count;
      continue;
    end if;
    raise notice '0136 count %: %: % at real facilities%, % at the sealed QA and demo tenants; the owner''s maximum: %.',
      line_row.line, line_row.what, line_row.real_count,
      case when line_row.logins is null then '' else ' (' || line_row.logins || ' staff logins)' end, line_row.sealed_count,
      case when not line_row.filled then 'not filled in'
           else line_row.real_maximum
                || case when line_row.logins is null then '' else ' (' || line_row.logins_maximum || ' staff logins)' end
      end;
    if line_row.real_count > coalesce(line_row.real_maximum, 0)
       or (line_row.logins is not null and line_row.logins > coalesce(line_row.logins_maximum, 0)) then
      over := coalesce(over || '; ', '') || 'line ' || line_row.line || ' (' || line_row.what || ') is now '
        || line_row.real_count
        || case when line_row.logins is null then '' else ' (' || line_row.logins || ' staff logins)' end
        || case when not line_row.filled then ' and the owner''s maximum is not filled in'
                else ', more than the owner''s ' || line_row.real_maximum
                     || case when line_row.logins is null then '' else ' (' || line_row.logins_maximum || ')' end
           end;
    end if;
  end loop;
  perform set_config('zero136.maximums_checked', 'yes', false),
          set_config('zero136.over_maximums', coalesce(over, ''), false);
end
$count_0136$;

-- Table 1: every line.
select counted.line, counted.what as "what it counts", counted.real_count as "at real facilities",
       counted.logins as "staff logins", counted.sealed_count as "sealed QA and demo"
  from jsonb_to_recordset(current_setting('zero136.counts')::jsonb)
       counted(line integer, what text, real_count bigint, logins bigint, sealed_count bigint)
 order by counted.line;

-- Table 2: lines 1-24 as the owner writes them into 0136.
select format('     (%s, %s, %s)%s', lpad(counted.line::text, 2), counted.real_count,
              coalesce(counted.logins::text, 'null'), case when counted.line = 24 then '' else ',' end)
         as "owner's maximums for 0136"
  from jsonb_to_recordset(current_setting('zero136.counts')::jsonb)
       counted(line integer, real_count bigint, logins bigint)
 where counted.line <= 24
 order by counted.line;
