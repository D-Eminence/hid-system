-- 0115 Outreach: visits on a registration case, a link-preview attempt log,
-- and staff names for case and campaign answers (backend plan, Part 3 "Item
-- 5", written as 0108; the number 0115 assigned by the coordinator, 0106-0114
-- belonging to other builders; owner decisions D10 "send the campaign name
-- now" and D11 "link by Health ID needs existing access"; the declaration is
-- signed separately). Written on 0105 (0d0cd3d7). It uses and needs nothing
-- 0106-0114 add, so it applies on 0105 alone or after them.
--
-- What it adds (nothing existing is altered, replaced or dropped):
-- 1. outreach.registration_case_visits: a field visit, referral or follow-up
--    recorded on a registration case. Insert-only (platform.reject_mutation
--    on UPDATE and DELETE), row-level security enabled and forced. A row is
--    read and written only through its case: the policies require the
--    Outreach permission at the session facility (outreach.context_allows)
--    and that the case is visible to the caller at the same facility, so the
--    case's own policies (facility, permission, and the restrictive campaign
--    membership policy) decide. The writer must be the session's account and
--    membership. Idempotency lives on the row: unique (recorded_by_account_id,
--    facility_id, idempotency_key) with the request's sha256. occurred_on may
--    not be after today in Africa/Lagos (a BEFORE INSERT trigger, which also
--    stamps created_at), follow_up_on is null or after occurred_on,
--    referred_to null or 2-160 characters without control characters, notes
--    null or 1-1000 characters whose only control character is a newline.
-- 2. outreach.link_preview_attempts: one row per Health ID check (a preview
--    or a link by Health ID, written before Identity is asked), holding ids
--    and a time only, never the Health ID. outreach-api counts a member's rows of the last hour to apply the
--    plan's limit of 20 an hour per member; there was nowhere to count them
--    (the Outreach runtime cannot read audit.events). Insert-only, row-level
--    security enabled and forced; a member reads only their own rows.
-- 3. outreach.member_display_names(uuid[]) and
--    outreach.case_registrar_names(uuid[]): SECURITY DEFINER readers that
--    return the staff record's full_name (identity.staff.full_name) and
--    nothing else, for at most 200 ids (22023 above that):
--    - member names only for memberships at the session facility that share
--      a campaign with the caller, to a caller holding outreach.campaign.read
--      there;
--    - registrar names only for cases at the session facility that the caller
--      may read (outreach.registration.read, and the case's campaign
--      membership rule, outreach.registration_campaign_member).
--    They lock no row (0045's trigger locked a FORCE row-level-security table
--    with no UPDATE policy and was refused under an owner that does not
--    bypass row-level security; these are plain reads). Under such an owner
--    the read tables' own policies also apply, and they ask for the same
--    things as the explicit predicates.
-- 4. Grants, here in a block for an installation whose roles exist (a release
--    applies only migrations) and the same statements top-level in
--    runtime-grants.sql (0115 block): SELECT and INSERT on both tables, and
--    EXECUTE on both readers, to hid_outreach_runtime and
--    hid_schema_test_runtime; nothing to PUBLIC. No sequence (uuid keys).
--
-- No registration_case_events or outbox row is written for a visit: both
-- have fixed event-type CHECKs and downstream consumers, and a visit does not
-- change the case.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0105 applied (0105's
--    documents_scanner_function_lock policy on ehr.documents the marker); not
--    applied yet (else "0115: already applied"); the bodies relied on are as
--    0001-0105 left them (md5 of pg_proc.prosrc: outreach.context_allows,
--    outreach.registration_campaign_member, auth.membership_has_permission,
--    platform.current_account_id, current_membership_id,
--    current_facility_id, current_purpose_of_use, current_actor_subject,
--    reject_mutation); the columns read and referenced have their types and
--    NOT NULLs; identity.staff_facility_memberships has its unique (id,
--    facility_id, account_id); the policies of outreach.registration_cases
--    and outreach.campaign_members, and their row-level security, are 0024's,
--    0038's and 0045's; the applier owns (or inherits and may SET ROLE to the
--    owner of) the schema outreach and every table it references or its
--    readers read.
-- 1. Locks, then the tables, triggers, policies, readers and grants.
-- 2. Post-checks: the tables' row-level security, policies and triggers, the
--    readers' bodies (md5 pinned), attributes and ACLs, and the grants when
--    the roles exist.
--
-- Locks (measured with pg_locks before commit on a 0105 copy, see the
-- declaration): SHARE ROW EXCLUSIVE on outreach.registration_cases and
-- identity.staff_facility_memberships (the new foreign keys), taken up front
-- in that order NOWAIT every 10 ms for at most 5 seconds (then 55P03, nothing
-- applied), held to commit: they block writes to those two tables
-- (registration, linking, sign-in's membership updates) for the apply, never
-- reads. No existing table is altered. ACCESS EXCLUSIVE on the new tables,
-- their indexes and TOAST tables; the catalogs' own locks.
--
-- Old services on this schema: today's outreach-api image calls none of the
-- new objects. The image of this release calls them only while
-- OUTREACH_VISITS_ENABLED is true. Applied migrations 0001 through 0105 are
-- immutable.

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
  object_owner record;
begin
  -- a. Prerequisites: 0001-0105 (0105's scanner lock policy is the marker).
  if to_regclass('ehr.documents') is null
     or to_regclass('outreach.registration_cases') is null
     or to_regclass('outreach.campaign_members') is null
     or to_regprocedure('outreach.registration_campaign_member(uuid,uuid)') is null
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'ehr.documents'::regclass
                       and policy_row.polname = 'documents_scanner_function_lock') then
    raise exception using errcode = '55000', message = '0115: 0001-0105 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('outreach.registration_case_visits') is not null
     or to_regclass('outreach.link_preview_attempts') is not null
     or to_regprocedure('outreach.member_display_names(uuid[])') is not null
     or to_regprocedure('outreach.case_registrar_names(uuid[])') is not null
     or to_regprocedure('outreach.validate_registration_case_visit()') is not null then
    raise exception using errcode = '55000', message = '0115: already applied';
  end if;
  -- c. The bodies relied on, as 0001-0105 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('outreach.context_allows(uuid,text)', '1e0e660ba5fd9288f1c1aeca5a7137ac'),
      ('outreach.registration_campaign_member(uuid,uuid)', '001d3745e8710e8b9210cc37cba24b4a'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- The two outreach helpers stay SECURITY DEFINER with 0024's/0045's
  -- search_path (the policies and readers call them).
  if mismatch is null and (select count(*) from pg_proc proc
       where proc.oid in ('outreach.context_allows(uuid,text)'::regprocedure,
                          'outreach.registration_campaign_member(uuid,uuid)'::regprocedure)
         and proc.prosecdef and proc.provolatile = 's' and proc.prorettype = 'boolean'::regtype
         and proc.proconfig = '{"search_path=pg_catalog, platform, auth, identity, outreach"}'::text[]) <> 2 then
    mismatch := 'attributes of outreach.context_allows or outreach.registration_campaign_member';
  end if;
  -- The columns read and referenced, with their types and NOT NULLs.
  if mismatch is null then
    select string_agg(format('%s.%s', expected.relation, expected.column_name), ', ') into mismatch
      from (values
        ('outreach.registration_cases', 'id', 'uuid', true),
        ('outreach.registration_cases', 'facility_id', 'uuid', true),
        ('outreach.registration_cases', 'campaign_id', 'uuid', false),
        ('outreach.registration_cases', 'created_by_account_id', 'uuid', true),
        ('outreach.registration_cases', 'created_by_membership_id', 'uuid', true),
        ('outreach.campaign_members', 'campaign_id', 'uuid', true),
        ('outreach.campaign_members', 'facility_id', 'uuid', true),
        ('outreach.campaign_members', 'membership_id', 'uuid', true),
        ('identity.staff_facility_memberships', 'id', 'uuid', true),
        ('identity.staff_facility_memberships', 'staff_id', 'uuid', true),
        ('identity.staff_facility_memberships', 'account_id', 'uuid', true),
        ('identity.staff_facility_memberships', 'facility_id', 'uuid', false),
        ('identity.staff', 'id', 'uuid', true),
        ('identity.staff', 'account_id', 'uuid', true),
        ('identity.staff', 'full_name', 'text', true))
           expected(relation, column_name, type_name, not_null)
     where not exists (select 1 from pg_attribute attribute
                        where attribute.attrelid = to_regclass(expected.relation)
                          and attribute.attname = expected.column_name and not attribute.attisdropped
                          and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name
                          and attribute.attnotnull = expected.not_null);
    if mismatch is not null then mismatch := 'columns ' || mismatch; end if;
  end if;
  -- The unique key the membership foreign keys reference, and the primary
  -- key of outreach.registration_cases.
  if mismatch is null and not exists (
       select 1 from pg_constraint constraint_row
        where constraint_row.conrelid = 'identity.staff_facility_memberships'::regclass
          and constraint_row.contype = 'u'
          and pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (id, facility_id, account_id)') then
    mismatch := 'unique (id, facility_id, account_id) on identity.staff_facility_memberships';
  end if;
  if mismatch is null and not exists (
       select 1 from pg_constraint constraint_row
        where constraint_row.conrelid = 'outreach.registration_cases'::regclass
          and constraint_row.contype = 'p' and pg_get_constraintdef(constraint_row.oid) = 'PRIMARY KEY (id)') then
    mismatch := 'the primary key of outreach.registration_cases';
  end if;
  -- The policies the new policies and readers rely on (0024, 0038, 0045):
  -- the cases' permissive read and the restrictive campaign read, and the
  -- members' read; no UPDATE or ALL policy on the members.
  if mismatch is null
     and (select count(*) from pg_policy policy_row
           where policy_row.polrelid in ('outreach.registration_cases'::regclass,
                                         'outreach.campaign_members'::regclass)
             and policy_row.polroles = '{0}'::oid[]
             and (policy_row.polrelid::regclass::text, policy_row.polname, policy_row.polcmd,
                  policy_row.polpermissive,
                  md5(coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), ''))) in (
               ('outreach.registration_cases', 'outreach_registration_cases_read', 'r', true,
                '1e4a3a13b7179fae702c267befd138ea'),
               ('outreach.registration_cases', 'outreach_registration_campaign_read', 'r', false,
                'f0fd2ef6780ca9b6a4ecc922bd617076'),
               ('outreach.campaign_members', 'outreach_campaign_members_read', 'r', true,
                '680a885bf5f25e549d3b68ee11e5e0fe'))) <> 3
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid in ('outreach.registration_cases'::regclass,
                                        'outreach.campaign_members'::regclass)
            and policy_row.polcmd in ('r', '*')) <> 3 then
    mismatch := 'the read policies of outreach.registration_cases and outreach.campaign_members';
  end if;
  if mismatch is null and exists (
       select 1 from pg_policy policy_row
        where policy_row.polrelid = 'outreach.campaign_members'::regclass and policy_row.polcmd in ('w', '*')) then
    mismatch := 'an UPDATE or ALL policy on outreach.campaign_members';
  end if;
  if mismatch is null
     and (select count(*) from pg_class class_row
           where class_row.oid in ('outreach.registration_cases'::regclass, 'outreach.campaign_members'::regclass)
             and class_row.relrowsecurity and class_row.relforcerowsecurity) <> 2 then
    mismatch := 'row-level security of outreach.registration_cases or outreach.campaign_members';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0115: an object this migration relies on differs from 0001-0105: %s', mismatch);
  end if;
  -- d. The applier owns, or inherits and may SET ROLE to the owner of, the
  -- schema it creates in, the tables it references, and the tables its
  -- SECURITY DEFINER readers read (they run as the applier); never a
  -- superuser's bypass alone.
  for object_owner in
    select 'schema outreach' as object_name, namespace_row.nspowner as owner_oid
      from pg_namespace namespace_row where namespace_row.nspname = 'outreach'
    union all
    select class_row.oid::regclass::text, class_row.relowner
      from pg_class class_row
     where class_row.oid in ('outreach.registration_cases'::regclass, 'outreach.campaign_members'::regclass,
                             'identity.staff_facility_memberships'::regclass, 'identity.staff'::regclass)
  loop
    if applier <> object_owner.owner_oid
       and not (pg_has_role(applier, object_owner.owner_oid, 'USAGE')
                and pg_has_role(applier, object_owner.owner_oid, 'SET')) then
      raise exception using errcode = '42501',
        message = format('0115: %s is not the owner of %s (%s) and may not act as it (INHERIT and SET)',
          current_user, object_owner.object_name, pg_get_userbyid(object_owner.owner_oid));
    end if;
  end loop;
end;
$$;

-- 1a. Locks: the two referenced tables, NOWAIT, for at most 5 seconds.
do $$
declare
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table outreach.registration_cases, identity.staff_facility_memberships
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0115: outreach.registration_cases or identity.staff_facility_memberships stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 1b. Visits on a registration case.
create table outreach.registration_case_visits (
  id uuid primary key default gen_random_uuid(),
  registration_case_id uuid not null references outreach.registration_cases(id) on delete restrict,
  facility_id uuid not null,
  kind text not null check (kind in ('visit', 'referral', 'follow_up')),
  occurred_on date not null check (occurred_on >= date '2020-01-01'),
  follow_up_on date constraint registration_case_visits_follow_up_on_check
    check (follow_up_on is null or follow_up_on > occurred_on),
  referred_to text check (referred_to is null or (
    char_length(referred_to) between 2 and 160 and referred_to = btrim(referred_to)
    and referred_to !~ '[[:cntrl:]]')),
  notes text check (notes is null or (
    char_length(notes) between 1 and 1000 and notes = btrim(notes, E' \n')
    and notes !~ '[\x01-\x09\x0b-\x1f\x7f]')),
  recorded_by_account_id uuid not null,
  recorded_by_membership_id uuid not null,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (recorded_by_membership_id, facility_id, recorded_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint registration_case_visits_idempotency_uq unique (recorded_by_account_id, facility_id, idempotency_key)
);

comment on table outreach.registration_case_visits is
  'Visits, referrals and follow-ups recorded on an Outreach registration case. Insert-only; read and written only through a case the caller may read at the session facility.';

create index registration_case_visits_case_idx
  on outreach.registration_case_visits (registration_case_id, occurred_on desc, created_at desc, id desc);

-- The visit date is a date in Africa/Lagos and not after today there; the
-- time of recording is the database's.
create function outreach.validate_registration_case_visit()
returns trigger
language plpgsql
set search_path = pg_catalog, outreach
as $$
begin
  new.created_at := clock_timestamp();
  if new.occurred_on > (clock_timestamp() at time zone 'Africa/Lagos')::date then
    raise exception using errcode = '23514',
      message = 'Outreach visit date cannot be after today in Africa/Lagos';
  end if;
  return new;
end
$$;

comment on function outreach.validate_registration_case_visit() is
  'Outreach visit capture: occurred_on is not after today in Africa/Lagos; created_at is the database time.';

create trigger registration_case_visits_validate
  before insert on outreach.registration_case_visits
  for each row execute function outreach.validate_registration_case_visit();
create trigger registration_case_visits_no_mutation
  before update or delete on outreach.registration_case_visits
  for each row execute function platform.reject_mutation();

alter table outreach.registration_case_visits enable row level security;
alter table outreach.registration_case_visits force row level security;

create policy outreach_registration_case_visits_read on outreach.registration_case_visits
  for select using (
    outreach.context_allows(facility_id, 'outreach.registration.read')
    and exists (select 1 from outreach.registration_cases registration_case
                 where registration_case.id = registration_case_visits.registration_case_id
                   and registration_case.facility_id = registration_case_visits.facility_id)
  );
create policy outreach_registration_case_visits_create on outreach.registration_case_visits
  for insert with check (
    recorded_by_account_id = platform.current_account_id()
    and recorded_by_membership_id = platform.current_membership_id()
    and outreach.context_allows(facility_id, 'outreach.registration.write')
    and exists (select 1 from outreach.registration_cases registration_case
                 where registration_case.id = registration_case_visits.registration_case_id
                   and registration_case.facility_id = registration_case_visits.facility_id)
  );

-- 1c. Health ID preview attempts: ids and a time only.
create table outreach.link_preview_attempts (
  id uuid primary key default gen_random_uuid(),
  registration_case_id uuid not null references outreach.registration_cases(id) on delete restrict,
  facility_id uuid not null,
  requested_by_account_id uuid not null,
  requested_by_membership_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (requested_by_membership_id, facility_id, requested_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict
);

comment on table outreach.link_preview_attempts is
  'One row per Outreach Health ID check (a preview or a link by Health ID), for the per-member hourly limit. Never holds the Health ID.';

create index link_preview_attempts_member_idx
  on outreach.link_preview_attempts (requested_by_membership_id, created_at desc);

create trigger link_preview_attempts_no_mutation
  before update or delete on outreach.link_preview_attempts
  for each row execute function platform.reject_mutation();

alter table outreach.link_preview_attempts enable row level security;
alter table outreach.link_preview_attempts force row level security;

create policy outreach_link_preview_attempts_read on outreach.link_preview_attempts
  for select using (
    requested_by_account_id = platform.current_account_id()
    and requested_by_membership_id = platform.current_membership_id()
    and outreach.context_allows(facility_id, 'outreach.registration.write')
  );
create policy outreach_link_preview_attempts_create on outreach.link_preview_attempts
  for insert with check (
    requested_by_account_id = platform.current_account_id()
    and requested_by_membership_id = platform.current_membership_id()
    and outreach.context_allows(facility_id, 'outreach.registration.write')
    and exists (select 1 from outreach.registration_cases registration_case
                 where registration_case.id = link_preview_attempts.registration_case_id
                   and registration_case.facility_id = link_preview_attempts.facility_id)
  );

-- 1d. Staff names: full_name only, at most 200 ids, no row locks.
create function outreach.member_display_names(membership_ids uuid[])
returns table (membership_id uuid, display_name text)
language plpgsql stable security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
#variable_conflict use_column
begin
  if membership_ids is null or cardinality(membership_ids) > 200 then
    raise exception using errcode = '22023', message = 'Between 0 and 200 membership ids are required';
  end if;
  return query
    select membership.id, staff.full_name
      from identity.staff_facility_memberships membership
      join identity.staff staff on staff.id = membership.staff_id and staff.account_id = membership.account_id
     where membership.id = any(membership_ids)
       and membership.facility_id = platform.current_facility_id()
       and outreach.context_allows(membership.facility_id, 'outreach.campaign.read')
       and exists (select 1
                     from outreach.campaign_members listed
                     join outreach.campaign_members caller
                       on caller.campaign_id = listed.campaign_id
                      and caller.facility_id = listed.facility_id
                      and caller.membership_id = platform.current_membership_id()
                    where listed.membership_id = membership.id
                      and listed.facility_id = membership.facility_id);
end
$$;

comment on function outreach.member_display_names(uuid[]) is
  'Outreach campaign member names: the staff full_name of memberships at the session facility that share a campaign with the caller, to a holder of outreach.campaign.read. At most 200 ids; no row locks.';

create function outreach.case_registrar_names(case_ids uuid[])
returns table (registration_case_id uuid, display_name text)
language plpgsql stable security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
#variable_conflict use_column
begin
  if case_ids is null or cardinality(case_ids) > 200 then
    raise exception using errcode = '22023', message = 'Between 0 and 200 registration case ids are required';
  end if;
  return query
    select registration_case.id, staff.full_name
      from outreach.registration_cases registration_case
      join identity.staff_facility_memberships membership
        on membership.id = registration_case.created_by_membership_id
       and membership.facility_id = registration_case.facility_id
       and membership.account_id = registration_case.created_by_account_id
      join identity.staff staff on staff.id = membership.staff_id and staff.account_id = membership.account_id
     where registration_case.id = any(case_ids)
       and registration_case.facility_id = platform.current_facility_id()
       and outreach.context_allows(registration_case.facility_id, 'outreach.registration.read')
       and outreach.registration_campaign_member(registration_case.campaign_id, registration_case.facility_id);
end
$$;

comment on function outreach.case_registrar_names(uuid[]) is
  'Outreach registrar names: the staff full_name of whoever registered each case at the session facility that the caller may read. At most 200 ids; no row locks.';

-- 1e. Grants. Here for an installation whose roles exist, and the same
-- statements top-level in runtime-grants.sql (0115 block).
revoke all on outreach.registration_case_visits, outreach.link_preview_attempts from public;
revoke all on function outreach.validate_registration_case_visit(),
  outreach.member_display_names(uuid[]), outreach.case_registrar_names(uuid[]) from public;
do $$
declare
  runtime_role text;
begin
  foreach runtime_role in array array['hid_outreach_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant select, insert on outreach.registration_case_visits, outreach.link_preview_attempts to %I',
        runtime_role);
      execute format('grant execute on function outreach.member_display_names(uuid[]), '
        || 'outreach.case_registrar_names(uuid[]) to %I', runtime_role);
    end if;
  end loop;
end
$$;

-- 2. Post-checks.
do $$
declare
  mismatch text;
begin
  if (select count(*) from pg_class class_row
       where class_row.oid in ('outreach.registration_case_visits'::regclass,
                               'outreach.link_preview_attempts'::regclass)
         and class_row.relrowsecurity and class_row.relforcerowsecurity) <> 2 then
    mismatch := 'row-level security of the new tables';
  end if;
  if mismatch is null
     and ((select count(*) from pg_policy
            where polrelid = 'outreach.registration_case_visits'::regclass) <> 2
       or (select count(*) from pg_policy
            where polrelid = 'outreach.link_preview_attempts'::regclass) <> 2
       or exists (select 1 from pg_policy
                   where polrelid in ('outreach.registration_case_visits'::regclass,
                                      'outreach.link_preview_attempts'::regclass)
                     and (polcmd not in ('r', 'a') or polroles <> '{0}'::oid[] or not polpermissive))) then
    mismatch := 'the policies of the new tables';
  end if;
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid in ('outreach.registration_case_visits'::regclass,
                                         'outreach.link_preview_attempts'::regclass)
             and not trigger_row.tgisinternal and trigger_row.tgenabled = 'O') <> 3 then
    mismatch := 'the triggers of the new tables';
  end if;
  if mismatch is null then
    select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
      into mismatch
      from (values
        ('outreach.validate_registration_case_visit()', '162c06fe35fd0129faf8e8b194b1ed2d'),
        ('outreach.member_display_names(uuid[])', '9fb78017a8178d849dd0fc789d522965'),
        ('outreach.case_registrar_names(uuid[])', '7caf9def58450b900e7d1ba9c663ee9b'))
           expected(proc, digest)
      left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
     where md5(proc.prosrc) is distinct from expected.digest;
  end if;
  if mismatch is null
     and (select count(*) from pg_proc proc
           where proc.oid in ('outreach.member_display_names(uuid[])'::regprocedure,
                              'outreach.case_registrar_names(uuid[])'::regprocedure)
             and proc.prosecdef and proc.provolatile = 's' and not proc.proisstrict
             and proc.proconfig = '{"search_path=pg_catalog, platform, auth, identity, outreach"}'::text[]) <> 2
     or exists (select 1 from pg_proc proc
                 where proc.oid = 'outreach.validate_registration_case_visit()'::regprocedure
                   and proc.prosecdef) then
    mismatch := 'the attributes of the new functions';
  end if;
  -- Nothing to PUBLIC; the readers and tables only to the Outreach runtime
  -- and the schema test runtime (when they exist).
  if mismatch is null and (
       has_table_privilege('public', 'outreach.registration_case_visits', 'SELECT')
       or exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                   where proc.oid in ('outreach.validate_registration_case_visit()'::regprocedure,
                                      'outreach.member_display_names(uuid[])'::regprocedure,
                                      'outreach.case_registrar_names(uuid[])'::regprocedure)
                     and acl.grantee = 0)
       or exists (select 1 from pg_class class_row, aclexplode(class_row.relacl) acl
                   where class_row.oid in ('outreach.registration_case_visits'::regclass,
                                           'outreach.link_preview_attempts'::regclass)
                     and acl.grantee <> class_row.relowner
                     and (acl.grantee not in (select oid from pg_roles
                                               where rolname in ('hid_outreach_runtime', 'hid_schema_test_runtime'))
                          or acl.privilege_type not in ('SELECT', 'INSERT')))) then
    mismatch := 'the privileges of the new objects';
  end if;
  if mismatch is null and exists (select 1 from pg_roles where rolname = 'hid_outreach_runtime') and not (
       has_table_privilege('hid_outreach_runtime', 'outreach.registration_case_visits', 'SELECT, INSERT')
       and has_table_privilege('hid_outreach_runtime', 'outreach.link_preview_attempts', 'SELECT, INSERT')
       and has_function_privilege('hid_outreach_runtime', 'outreach.member_display_names(uuid[])', 'EXECUTE')
       and has_function_privilege('hid_outreach_runtime', 'outreach.case_registrar_names(uuid[])', 'EXECUTE')) then
    mismatch := 'the grants to hid_outreach_runtime';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0115: post-check failed: %s', mismatch);
  end if;
end;
$$;
