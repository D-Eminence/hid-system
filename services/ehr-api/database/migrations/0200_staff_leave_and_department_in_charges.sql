-- 0200 ROS-1 Shifts, rosters, HR and credentials: staff leave and department
-- in-charges (Release D, the department sprint the owner approved on 25
-- November 2026, verbatim: "I approve Q147-Q290 at the recommended options").
-- Written on claude/sprint-hr-backend at 67a1099a (staging-novu-ci-20261005 at
-- 0cfddcc9: 0001-0153 applied) after 0199 in the same pull request. The number
-- is provisional (given at merge). It reads nothing 0140-0199 create or
-- change: it needs 0114's objects (the facility profile's department codes)
-- and 0001-0010's. The declaration in config/production-schema-compatibility.json
-- stays unsigned until the owner signs this file.
--
-- Owner decisions (25 November 2026, each at its recommended option):
-- Q244 A (work data only: leave has a type and dates, no reason, note or
-- medical detail), Q245 A (the administrator gives the roster right to
-- in-charges), Q246 A (only memberships), Q149 A (a department switch, seeded
-- off: identity-api's DUTY_ROSTER_ENABLED here), Q161 A (online only; a paper
-- leave book as the back-up). Smaller choices at the recommended option, not
-- yet answered by the owner: Q-ROS-8 A (the administrator names up to 5
-- in-charges per department code; no new role, so SX-4's role functions do
-- not change), Q-ROS-15 A (no free text; declining needs no reason).
--
-- What it changes (nothing else):
-- W1 identity.workforce_department_in_charges: facility, organisation,
--    department_code (one of 0114's codes), membership and account, who named
--    them and when, ended_at and by whom, row_version. At most one active row
--    per (facility, department, membership); up to 5 active per department
--    (the add function, under an advisory lock per facility and department).
--    Never deleted (row DELETE and TRUNCATE refused).
-- W2 identity.staff_leave_requests: facility, organisation, membership and
--    account, leave_type (annual, sick, maternity, study, other), starts_on,
--    ends_on (on or after the start, at most 365 days), department_code
--    (optional, one of 0114's codes), status (requested, approved, declined,
--    cancelled), who decided or cancelled it and when, row_version. No free
--    text column of any kind. A CHECK refuses a decision by the requester's
--    own account. Never deleted (row DELETE and TRUNCATE refused).
-- W3 identity.workforce_events, append-only: one row per leave request,
--    cancel, approve and decline, and per in-charge named or ended (kind,
--    ids, from and to status, actor, when, the Idempotency-Key with the
--    request's SHA-256, unique per membership and key). Never the leave type
--    or dates. Row UPDATE and DELETE and TRUNCATE refused.
--    All three tables: row-level security enabled and forced, with only the
--    owner's four command policies (0086's staff_licence_attestations form);
--    no privilege for any runtime role; no identity column and no sequence.
-- W4 Functions, SECURITY DEFINER with SET search_path = pg_catalog, pg_temp,
--    every object named with its schema, no temporary table; owned like
--    0139's (the migration owner); EXECUTE for hid_identity_runtime only:
--      identity.workforce_in_charge_list()               route 6
--      identity.workforce_in_charge_add(...)             route 7
--      identity.workforce_in_charge_end(...)             route 8
--      identity.staff_leave_requests_mine()              route 9
--      identity.staff_leave_request_create(...)          route 10
--      identity.staff_leave_request_cancel(...)          route 11
--      identity.staff_leave_requests_to_decide(...)      route 12
--      identity.staff_leave_request_decide(...)          routes 13 and 14
--    Helpers no role may execute (SECURITY INVOKER, the same search_path;
--    they run only inside the definers, as their owner; 0202 calls them too,
--    md5-pinned):
--      identity.workforce_actor(text)                    the caller: an active
--        membership with no migration hold at the session facility, its
--        account, staff record, facility and organisation active (0008's
--        identity.has_active_membership), purpose healthcare-operations, and
--        the code asked for (42501 DUTY_ROSTER_NOT_ALLOWED,
--        IN_CHARGE_SETUP_NOT_ALLOWED or LEAVE_REQUEST_NOT_ALLOWED)
--      identity.workforce_member_holds(uuid, text)       a membership holds a
--        code now (0010's role join, keyed by the membership)
--      identity.workforce_facility_departments(uuid)     the profile's codes
--      identity.workforce_editor_departments(uuid)       the departments a
--        membership edits: every profile department with
--        workforce.roster.manage; else, while it holds
--        workforce.roster.read, those it is an active in-charge of
--      identity.staff_leave_card(identity.staff_leave_requests, boolean)
--      identity.workforce_in_charge_card(uuid)
--      identity.workforce_idempotency(uuid, text, text)
--      identity.workforce_audit(...)
--    Without 0201 no role holds workforce.roster.read, workforce.roster.manage
--    or workforce.leave.request, so every function refuses: the database half
--    of "built but switched off".
-- W5 One person's leave and duties are changed under one transaction-scoped
--    advisory lock per (facility, account) ('workforce-person:<facility>:
--    <account>'), so two overlapping requests, or a duty and an approval
--    (0202), cannot both pass. Approving takes the requester's lock; 0202's
--    trigger staff_leave_requests_roster_clash then refuses an approval that
--    clashes with duties not yet started (55000 LEAVE_CLASHES_WITH_ROSTER, the
--    dates in DETAIL), which this file's decide function answers as the
--    outcome clashes_with_roster; without 0202 nothing refuses it.
-- W6 Audit, in the request's transaction. A refusal the function answers is
--    written here (outcome denied or failure); a refusal it raises (42501, or
--    22023 for input identity-api never sends) is written by identity-api's
--    request audit: identity.duty-roster.in-charge-add, .in-charge-end;
--    identity.staff-leave.request, .cancel, .approve, .decline, .list-mine,
--    .list-to-decide (count, ids shown). Rows hold ids, codes, counts and
--    outcomes; never a name, a leave type, leave dates or a reason.
--
-- Locks (measured with pg_locks before commit and compared by the
-- workforce-migrations suite), taken first, NOWAIT: SHARE ROW EXCLUSIVE on
-- identity.staff_facility_memberships, identity.facilities and
-- identity.organizations (the foreign keys of the new, empty tables); ACCESS
-- SHARE on identity.facility_profiles, auth.permissions and
-- auth.role_permissions (read by the preconditions). A busy table fails the
-- attempt at once and its subtransaction releases what it took. The attempt
-- is made 50 times, 100 ms apart (about 5 seconds), so the file never waits
-- for one of its locks while holding the others; then 55P03 (nothing
-- applied). When this transaction already holds an earlier migration's locks
-- that stop other sessions' reads or writes (the runner's dry run), one
-- attempt and no sleep: 55P03 at once, nothing applied. Both refusals begin
-- "0200: " and end "run the release again at a quieter time" (#306).
--
-- Old images on this schema: nothing calls the new functions.
-- identity-api's DUTY_ROSTER_ENABLED (off by default) keeps routes 6-22 closed
-- until the owner's go-live; while it is on, a database without this file
-- answers 503 DUTY_ROSTER_NOT_AVAILABLE for routes 6-14.
--
-- Undo (not in the ledger; a migration only if the owner signs it), after
-- 0202's undo: drop the functions and the three tables.
--
-- The whole file is one statement (do $hr0200$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): 0114's markers; "0200: already
--    applied" when every object of this file is there exactly as it leaves it,
--    "0200: the schema is not in the reviewed state" for any other state with
--    part of it; the bodies it calls md5-pinned; the columns it reads.
-- 2. W1-W4 and the grants.
-- 3. Post-checks in 0148's and 0152's form (owners; row-level security
--    enabled and forced with exactly the four owner command policies; no
--    privilege for any other role; no identity column or sequence; each
--    trigger's tgtype, tgqual, tgattr, tgnargs, tgfoid and tgenabled; each
--    function's owner, SECURITY DEFINER or not, fixed search_path, EXECUTE list
--    and pinned body).

do $hr0200$
declare
  v_attempt integer := 0;
  v_holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  v_runtime boolean := exists (select 1 from pg_roles where rolname = 'hid_identity_runtime');
  v_owner oid := (select oid from pg_roles where rolname = current_user);
  v_mismatch text;
  v_present integer;
  v_tables constant text[] := array['identity.workforce_department_in_charges', 'identity.staff_leave_requests',
    'identity.workforce_events'];
  -- Every function this file makes: signature, body md5, SECURITY DEFINER, EXECUTE for hid_identity_runtime.
  v_functions constant text[][] := array[
    ['identity.workforce_member_holds(uuid,text)', '387f9d0dce25909fe30c6978e1b533ff', 'false', 'false'],
    ['identity.workforce_actor(text)', '21279ebdacadfb4e469b1b0df6e09776', 'false', 'false'],
    ['identity.workforce_facility_departments(uuid)', '2bf2f371dfc30b628ec3b8bd310ebeba', 'false', 'false'],
    ['identity.workforce_editor_departments(uuid)', 'e56b2e40e306ab4bd5e7528c0d181874', 'false', 'false'],
    ['identity.staff_leave_card(identity.staff_leave_requests,boolean)', 'c47695406ae6c1afd389ed52ad24f637', 'false',
     'false'],
    ['identity.workforce_in_charge_card(uuid)', 'e2f8c69c89ec7e96cce454efd6f313b8', 'false', 'false'],
    ['identity.workforce_idempotency(uuid,text,text)', '63782572d4635fc5913d4c9919748b25', 'false', 'false'],
    ['identity.workforce_audit(text,uuid,uuid,uuid,uuid,text,text,text,text,text,jsonb)',
     '38eb210c665b1d9a0588b344bb721ff1', 'false', 'false'],
    ['identity.workforce_in_charge_list()', 'bde597bd312dde6d262539413f0135ef', 'true', 'true'],
    ['identity.workforce_in_charge_add(text,uuid,text,text)', 'f17796708aa8ef8d406b7ab775771ca9', 'true', 'true'],
    ['identity.workforce_in_charge_end(uuid,bigint,text,text)', '6a014279bbc421750b5dacb19bee8756', 'true', 'true'],
    ['identity.staff_leave_requests_mine()', 'e589fe391b03bb6f927110268fd71fd4', 'true', 'true'],
    ['identity.staff_leave_request_create(text,date,date,text,text,text)', '706ed4d3b138fb9a181bd79f49ab13ab', 'true',
     'true'],
    ['identity.staff_leave_request_cancel(uuid,bigint,text,text)', '2c10095e1e52e28907e8d635aff32892', 'true', 'true'],
    ['identity.staff_leave_requests_to_decide(text,text)', '28571bdc134df06463b556f8886506a9', 'true', 'true'],
    ['identity.staff_leave_request_decide(uuid,text,bigint,text,text)', '01503c7efe0b484e9049372ba71a2807', 'true',
     'true']];
  v_function_names constant text[] := array['workforce_member_holds', 'workforce_actor',
    'workforce_facility_departments', 'workforce_editor_departments', 'staff_leave_card', 'workforce_in_charge_card',
    'workforce_idempotency', 'workforce_audit', 'workforce_in_charge_list', 'workforce_in_charge_add',
    'workforce_in_charge_end', 'staff_leave_requests_mine', 'staff_leave_request_create', 'staff_leave_request_cancel',
    'staff_leave_requests_to_decide', 'staff_leave_request_decide'];
  -- Every trigger: table, name, tgtype (1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate).
  v_triggers constant text[][] := array[
    ['identity.workforce_department_in_charges', 'workforce_department_in_charges_no_delete', '11'],
    ['identity.workforce_department_in_charges', 'workforce_department_in_charges_no_truncate', '34'],
    ['identity.staff_leave_requests', 'staff_leave_requests_no_delete', '11'],
    ['identity.staff_leave_requests', 'staff_leave_requests_no_truncate', '34'],
    ['identity.workforce_events', 'workforce_events_append_only', '27'],
    ['identity.workforce_events', 'workforce_events_no_truncate', '34']];
begin
  -- The markers of the tables step 0 locks (catalog reads only).
  if to_regclass('identity.facility_profiles') is null or to_regclass('identity.staff_facility_memberships') is null then
    raise exception using errcode = '55000', message = '0200: 0114 must be applied first';
  end if;

  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0 reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table identity.staff_facility_memberships, identity.facilities, identity.organizations
    in share row exclusive mode nowait;
  lock table identity.facility_profiles, auth.permissions, auth.role_permissions in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0200: the staff memberships, facilities, organizations or a table 0200 reads (facility profiles, '
          || 'permissions, role permissions) is busy, and this transaction already holds an earlier migration''s '
          || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0200: the staff memberships, facilities, organizations or a table 0200 reads (facility profiles, '
          || 'permissions, role permissions) stayed busy for 5 seconds; nothing applied; run the release again at a '
          || 'quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if to_regprocedure('identity.facility_department_codes()') is null
     or to_regprocedure('identity.facility_departments_valid(text[])') is null then
    raise exception using errcode = '55000', message = '0200: 0114 must be applied first';
  end if;

  -- Exactly applied, or not at all. (0202's trigger on identity.staff_leave_requests is not this file's.)
  select count(*) into v_present
    from (select to_regclass(name)::oid as object_id from unnest(v_tables) name
          union all
          select to_regprocedure(v_functions[idx][1])::oid from generate_subscripts(v_functions, 1) idx) present
   where present.object_id is not null;
  if v_present = 3 + array_length(v_functions, 1)
     and not exists (select 1 from generate_subscripts(v_functions, 1) idx
                      where (select md5(proc.prosrc) from pg_proc proc
                              where proc.oid = to_regprocedure(v_functions[idx][1]))
                            is distinct from v_functions[idx][2])
     and (select count(*) from generate_subscripts(v_triggers, 1) idx
            join pg_trigger trigger_row on trigger_row.tgrelid = to_regclass(v_triggers[idx][1])
                                       and trigger_row.tgname = v_triggers[idx][2]) = 6 then
    raise exception using errcode = '55000', message = '0200: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'identity' and proc.proname = any (v_function_names)) then
    raise exception using errcode = '55000',
      message = '0200: the schema is not in the reviewed state (part of 0200 is there); nothing applied';
  end if;

  -- The bodies this file calls, as 0001-0153 leave them.
  select string_agg(expected.signature, ', ' order by expected.signature) into v_mismatch
    from (values
      ('identity.facility_department_codes()', '6e7fe57805c6fc44fc2296caa6b061ae'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0200: these bodies are not as 0001-0153 left them: ' || v_mismatch;
  end if;
  select string_agg(wanted.relation || '.' || wanted.column_name, ', ' order by wanted.relation, wanted.column_name)
    into v_mismatch
    from (values
      ('identity.facility_profiles', 'facility_id', 'uuid'), ('identity.facility_profiles', 'departments', 'text[]'),
      ('identity.staff_facility_memberships', 'id', 'uuid'),
      ('identity.staff_facility_memberships', 'account_id', 'uuid'),
      ('identity.staff_facility_memberships', 'staff_id', 'uuid'),
      ('identity.staff_facility_memberships', 'facility_id', 'uuid'),
      ('identity.staff_facility_memberships', 'organization_id', 'uuid'),
      ('identity.staff_facility_memberships', 'active', 'boolean'),
      ('identity.staff_facility_memberships', 'migration_hold_reason', 'text'),
      ('auth.account_roles', 'membership_id', 'uuid'), ('auth.account_roles', 'facility_id', 'uuid'),
      ('auth.account_roles', 'account_id', 'uuid'), ('auth.account_roles', 'role_code', 'text'),
      ('auth.account_roles', 'scope_type', 'text'), ('auth.account_roles', 'revoked_at', 'timestamp with time zone'),
      ('auth.accounts', 'status', 'text'), ('auth.accounts', 'disabled_until', 'timestamp with time zone'),
      ('identity.staff', 'active', 'boolean'), ('identity.staff', 'verification_status', 'text'),
      ('identity.facilities', 'active', 'boolean'), ('identity.organizations', 'active', 'boolean')
    ) wanted(relation, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = wanted.relation::regclass
                        and attribute_row.attname = wanted.column_name and attribute_row.attnum > 0
                        and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = wanted.type_name);
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0200: these columns are not as 0001-0153 left them: ' || v_mismatch;
  end if;

  -- 2. W1. Department in-charges.
  create table identity.workforce_department_in_charges (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    facility_id uuid not null,
    department_code text not null check (department_code = any (identity.facility_department_codes())),
    membership_id uuid not null,
    account_id uuid not null,
    named_by_membership_id uuid not null,
    named_by_account_id uuid not null,
    named_at timestamptz not null default clock_timestamp(),
    ended_at timestamptz,
    ended_by_membership_id uuid,
    ended_by_account_id uuid,
    row_version bigint not null default 1 check (row_version > 0),
    constraint workforce_department_in_charges_facility_fk foreign key (facility_id, organization_id)
      references identity.facilities(id, organization_id) on delete restrict,
    constraint workforce_department_in_charges_member_fk foreign key (membership_id, facility_id, account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint workforce_department_in_charges_named_by_fk
      foreign key (named_by_membership_id, facility_id, named_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint workforce_department_in_charges_ended_by_fk
      foreign key (ended_by_membership_id, facility_id, ended_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint workforce_department_in_charges_ended_ck check (
      (ended_at is null) = (ended_by_membership_id is null) and (ended_at is null) = (ended_by_account_id is null))
  );
  create unique index workforce_department_in_charges_active_ux
    on identity.workforce_department_in_charges (facility_id, department_code, membership_id) where ended_at is null;
  create index workforce_department_in_charges_member_idx
    on identity.workforce_department_in_charges (membership_id) where ended_at is null;
  alter table identity.workforce_department_in_charges enable row level security;
  alter table identity.workforce_department_in_charges force row level security;
  create policy workforce_department_in_charges_command_read on identity.workforce_department_in_charges
    for select using (true);
  create policy workforce_department_in_charges_command_insert on identity.workforce_department_in_charges
    for insert with check (true);
  create policy workforce_department_in_charges_command_update on identity.workforce_department_in_charges
    for update using (true) with check (true);
  create policy workforce_department_in_charges_command_delete on identity.workforce_department_in_charges
    for delete using (true);
  revoke all on identity.workforce_department_in_charges from public;
  create trigger workforce_department_in_charges_no_delete
    before delete on identity.workforce_department_in_charges
    for each row execute function platform.reject_mutation();
  create trigger workforce_department_in_charges_no_truncate
    before truncate on identity.workforce_department_in_charges
    for each statement execute function platform.reject_mutation();
  comment on table identity.workforce_department_in_charges is
    '0200 (ROS-1, Q245 A, Q-ROS-8 A): who the facility administrator named in charge of a department (0114 code): they edit, publish and mark attendance on that department''s duty rosters and decide leave sent to it, while they hold workforce.roster.read. Up to 5 active per department. Never deleted (ended instead). Only 0200''s and 0202''s functions read and write it, as its owner.';

  -- W2. Leave requests.
  create table identity.staff_leave_requests (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references identity.organizations(id) on delete restrict,
    facility_id uuid not null,
    membership_id uuid not null,
    account_id uuid not null,
    leave_type text not null check (leave_type in ('annual', 'sick', 'maternity', 'study', 'other')),
    starts_on date not null,
    ends_on date not null,
    department_code text check (department_code is null or department_code = any (identity.facility_department_codes())),
    status text not null default 'requested' check (status in ('requested', 'approved', 'declined', 'cancelled')),
    requested_at timestamptz not null default clock_timestamp(),
    decided_at timestamptz,
    decided_by_membership_id uuid,
    decided_by_account_id uuid,
    cancelled_at timestamptz,
    cancelled_by_membership_id uuid,
    cancelled_by_account_id uuid,
    updated_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    constraint staff_leave_requests_facility_fk foreign key (facility_id, organization_id)
      references identity.facilities(id, organization_id) on delete restrict,
    constraint staff_leave_requests_member_fk foreign key (membership_id, facility_id, account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint staff_leave_requests_decided_by_fk
      foreign key (decided_by_membership_id, facility_id, decided_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint staff_leave_requests_cancelled_by_fk
      foreign key (cancelled_by_membership_id, facility_id, cancelled_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint staff_leave_requests_dates_ck check (ends_on >= starts_on and ends_on - starts_on < 365),
    -- Decided exactly with who and when; never by the requester's own account (Q-ROS-8: nobody decides their own).
    constraint staff_leave_requests_decided_ck check (
      (decided_at is null) = (decided_by_membership_id is null)
      and (decided_at is null) = (decided_by_account_id is null)
      and (status not in ('approved', 'declined') or decided_at is not null)
      and (status <> 'requested' or decided_at is null)
      and decided_by_account_id is distinct from account_id),
    -- Cancelled exactly with when, by the requester.
    constraint staff_leave_requests_cancelled_ck check (
      (status = 'cancelled') = (cancelled_at is not null)
      and (cancelled_at is null) = (cancelled_by_membership_id is null)
      and (cancelled_at is null) = (cancelled_by_account_id is null)
      and (cancelled_by_account_id is null or cancelled_by_account_id = account_id))
  );
  create index staff_leave_requests_person_idx
    on identity.staff_leave_requests (facility_id, account_id, starts_on, ends_on) where status in ('requested', 'approved');
  create index staff_leave_requests_membership_idx on identity.staff_leave_requests (membership_id, requested_at);
  create index staff_leave_requests_status_idx on identity.staff_leave_requests (facility_id, status, starts_on);
  alter table identity.staff_leave_requests enable row level security;
  alter table identity.staff_leave_requests force row level security;
  create policy staff_leave_requests_command_read on identity.staff_leave_requests for select using (true);
  create policy staff_leave_requests_command_insert on identity.staff_leave_requests for insert with check (true);
  create policy staff_leave_requests_command_update on identity.staff_leave_requests
    for update using (true) with check (true);
  create policy staff_leave_requests_command_delete on identity.staff_leave_requests for delete using (true);
  revoke all on identity.staff_leave_requests from public;
  create trigger staff_leave_requests_no_delete
    before delete on identity.staff_leave_requests
    for each row execute function platform.reject_mutation();
  create trigger staff_leave_requests_no_truncate
    before truncate on identity.staff_leave_requests
    for each statement execute function platform.reject_mutation();
  comment on table identity.staff_leave_requests is
    '0200 (ROS-1, Q244 A, Q-ROS-15 A): a staff member''s leave request: type and dates only (no reason, note or medical detail), optionally the department whose in-charge decides it. The type is answered only to the requester and the deciders. Never deleted. Only 0200''s and 0202''s functions read and write it, as its owner.';

  -- W3. The history.
  create table identity.workforce_events (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    facility_id uuid not null,
    kind text not null check (kind in ('leave_requested', 'leave_cancelled', 'leave_approved', 'leave_declined',
      'in_charge_named', 'in_charge_ended')),
    leave_request_id uuid references identity.staff_leave_requests(id) on delete restrict,
    in_charge_id uuid references identity.workforce_department_in_charges(id) on delete restrict,
    from_status text check (from_status is null or from_status in ('requested', 'approved', 'declined', 'cancelled',
      'active', 'ended')),
    to_status text not null check (to_status in ('requested', 'approved', 'declined', 'cancelled', 'active', 'ended')),
    actor_account_id uuid not null,
    actor_membership_id uuid not null,
    at timestamptz not null default clock_timestamp(),
    idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
    correlation_id text not null check (length(correlation_id) between 8 and 128),
    constraint workforce_events_facility_fk foreign key (facility_id, organization_id)
      references identity.facilities(id, organization_id) on delete restrict,
    constraint workforce_events_actor_fk foreign key (actor_membership_id, facility_id, actor_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint workforce_events_subject_ck check (
      (kind in ('leave_requested', 'leave_cancelled', 'leave_approved', 'leave_declined')) = (leave_request_id is not null)
      and (kind in ('in_charge_named', 'in_charge_ended')) = (in_charge_id is not null))
  );
  create unique index workforce_events_key_ux on identity.workforce_events (actor_membership_id, idempotency_key);
  create index workforce_events_leave_idx on identity.workforce_events (leave_request_id) where leave_request_id is not null;
  create index workforce_events_in_charge_idx on identity.workforce_events (in_charge_id) where in_charge_id is not null;
  alter table identity.workforce_events enable row level security;
  alter table identity.workforce_events force row level security;
  create policy workforce_events_command_read on identity.workforce_events for select using (true);
  create policy workforce_events_command_insert on identity.workforce_events for insert with check (true);
  create policy workforce_events_command_update on identity.workforce_events for update using (true) with check (true);
  create policy workforce_events_command_delete on identity.workforce_events for delete using (true);
  revoke all on identity.workforce_events from public;
  create trigger workforce_events_append_only
    before update or delete on identity.workforce_events
    for each row execute function platform.reject_mutation();
  create trigger workforce_events_no_truncate
    before truncate on identity.workforce_events
    for each statement execute function platform.reject_mutation();
  comment on table identity.workforce_events is
    '0200 (ROS-1): one row per leave request, cancel, approve and decline and per in-charge named or ended, with the Idempotency-Key and the request''s SHA-256. Never the leave type or dates. Append-only. Only 0200''s functions write it, as its owner.';

  -- W4. Helpers (no role may execute them; the definers run them as their owner).

  -- A membership holds a code now: 0010's auth.membership_has_permission join, keyed by the membership.
  create function identity.workforce_member_holds(requested_membership_id uuid, requested_code text)
  returns boolean
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    return exists (
      select 1
        from identity.staff_facility_memberships membership
        join auth.accounts account_row on account_row.id = membership.account_id
        join identity.staff staff_row on staff_row.id = membership.staff_id
        join identity.facilities facility on facility.id = membership.facility_id
        join identity.organizations organization_row on organization_row.id = membership.organization_id
        join auth.account_roles assignment on assignment.account_id = account_row.id
         and assignment.membership_id = membership.id and assignment.facility_id = membership.facility_id
         and assignment.scope_type = 'facility' and assignment.revoked_at is null
        join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
        join auth.role_permissions role_permission on role_permission.role_code = role_row.code
         and role_permission.permission_code = requested_code
        join auth.permissions permission_row on permission_row.code = role_permission.permission_code
         and permission_row.active
       where membership.id = requested_membership_id and membership.active
         and membership.migration_hold_reason is null
         and facility.organization_id = membership.organization_id and facility.active and organization_row.active
         and account_row.status = 'active'
         and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
         and staff_row.active and lower(staff_row.verification_status) in ('verified', 'approved', 'active'));
  end
  $fn$;

  -- The caller of a workforce function, and which of the three codes it holds here. requested_code null: an
  -- active membership is enough (route 11's requester, route 22, and the deciders, whose right is checked by
  -- the function).
  create function identity.workforce_actor(requested_code text)
  returns table (actor_subject text, actor_account uuid, actor_membership uuid, actor_facility uuid,
    actor_organization uuid, actor_correlation text, holds_read boolean, holds_manage boolean, holds_leave boolean)
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  begin
    actor_subject := platform.current_actor_subject();
    actor_account := auth.account_id_for_subject(actor_subject);
    actor_membership := platform.current_membership_id();
    actor_facility := platform.current_facility_id();
    actor_correlation := platform.current_correlation_id();
    if actor_subject is null or actor_account is null or actor_membership is null or actor_facility is null
       or actor_correlation is null
       or not identity.has_active_membership(actor_subject, actor_membership, actor_facility) then
      raise exception using errcode = '42501', message = 'DUTY_ROSTER_NOT_ALLOWED';
    end if;
    if platform.current_purpose_of_use() is distinct from 'healthcare-operations' then
      raise exception using errcode = '22023', message = 'WORKFORCE_PURPOSE_INVALID';
    end if;
    select membership.organization_id into actor_organization
      from identity.staff_facility_memberships membership where membership.id = actor_membership;
    holds_read := auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
      'workforce.roster.read');
    holds_manage := auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
      'workforce.roster.manage');
    holds_leave := auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
      'workforce.leave.request');
    if requested_code = 'workforce.roster.read' and not holds_read then
      raise exception using errcode = '42501', message = 'DUTY_ROSTER_NOT_ALLOWED';
    elsif requested_code = 'workforce.roster.manage' and not holds_manage then
      raise exception using errcode = '42501', message = 'IN_CHARGE_SETUP_NOT_ALLOWED';
    elsif requested_code = 'workforce.leave.request' and not holds_leave then
      raise exception using errcode = '42501', message = 'LEAVE_REQUEST_NOT_ALLOWED';
    elsif requested_code is not null
          and requested_code not in ('workforce.roster.read', 'workforce.roster.manage', 'workforce.leave.request') then
      raise exception using errcode = '42501', message = 'DUTY_ROSTER_NOT_ALLOWED';
    end if;
    return next;
  end
  $fn$;

  -- The facility profile's department codes (0114), in the profile's order; none without a profile.
  create function identity.workforce_facility_departments(requested_facility_id uuid)
  returns text[]
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    return coalesce((select profile.departments from identity.facility_profiles profile
                      where profile.facility_id = requested_facility_id), array[]::text[]);
  end
  $fn$;

  -- The departments a membership edits now: every profile department with workforce.roster.manage; else, while
  -- it holds workforce.roster.read, the profile departments it is an active in-charge of.
  create function identity.workforce_editor_departments(requested_membership_id uuid)
  returns text[]
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    member_facility uuid := (select membership.facility_id from identity.staff_facility_memberships membership
                              where membership.id = requested_membership_id);
    departments text[] := identity.workforce_facility_departments(member_facility);
  begin
    if member_facility is null or not identity.workforce_member_holds(requested_membership_id, 'workforce.roster.read') then
      return array[]::text[];
    end if;
    if identity.workforce_member_holds(requested_membership_id, 'workforce.roster.manage') then
      return departments;
    end if;
    return coalesce((select array_agg(in_charge.department_code order by in_charge.department_code)
                       from identity.workforce_department_in_charges in_charge
                      where in_charge.membership_id = requested_membership_id
                        and in_charge.facility_id = member_facility and in_charge.ended_at is null
                        and in_charge.department_code = any (departments)), array[]::text[]);
  end
  $fn$;

  -- The leave card. The type only with show_type (the requester and the deciders).
  create function identity.staff_leave_card(requested_leave identity.staff_leave_requests, show_type boolean)
  returns jsonb
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    return jsonb_build_object(
      'leaveRequestId', requested_leave.id, 'membershipId', requested_leave.membership_id,
      'leaveType', case when show_type then requested_leave.leave_type end,
      'startsOn', to_char(requested_leave.starts_on, 'YYYY-MM-DD'),
      'endsOn', to_char(requested_leave.ends_on, 'YYYY-MM-DD'),
      'days', requested_leave.ends_on - requested_leave.starts_on + 1,
      'departmentCode', requested_leave.department_code, 'status', requested_leave.status,
      'requestedAt', to_char(requested_leave.requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'decidedAt', to_char(requested_leave.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'decidedByMembershipId', requested_leave.decided_by_membership_id,
      'cancelledAt', to_char(requested_leave.cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'rowVersion', requested_leave.row_version);
  end
  $fn$;

  -- The in-charge card.
  create function identity.workforce_in_charge_card(requested_in_charge_id uuid)
  returns jsonb
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    return (select jsonb_build_object(
              'inChargeId', in_charge.id, 'departmentCode', in_charge.department_code,
              'membershipId', in_charge.membership_id,
              'since', to_char(in_charge.named_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'setByMembershipId', in_charge.named_by_membership_id,
              'endedAt', to_char(in_charge.ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'rowVersion', in_charge.row_version)
              from identity.workforce_department_in_charges in_charge where in_charge.id = requested_in_charge_id);
  end
  $fn$;

  -- The Idempotency-Key of a workforce write: 'new', 'replay' (the same key and request: the event) or 'reused'
  -- (the same key, another request). Under an advisory lock per membership and key, so two requests with one key
  -- never both act.
  create function identity.workforce_idempotency(requested_membership_id uuid, requested_key text,
    requested_sha256 text)
  returns table (state text, event_kind text, leave_request_id uuid, in_charge_id uuid)
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    found_event identity.workforce_events%rowtype;
  begin
    if requested_key is null or requested_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_sha256 is null or requested_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'WORKFORCE_IDEMPOTENCY_KEY_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
      'workforce-key:' || requested_membership_id::text || ':' || requested_key, 0));
    select event.* into found_event from identity.workforce_events event
     where event.actor_membership_id = requested_membership_id and event.idempotency_key = requested_key;
    if not found then
      state := 'new';
    elsif found_event.request_sha256 = requested_sha256 then
      state := 'replay';
    else
      state := 'reused';
    end if;
    event_kind := found_event.kind;
    leave_request_id := found_event.leave_request_id;
    in_charge_id := found_event.in_charge_id;
    return next;
  end
  $fn$;

  -- One audit row, as the staff actor, in the request's transaction.
  create function identity.workforce_audit(requested_subject text, requested_account uuid, requested_membership uuid,
    requested_organization uuid, requested_facility uuid, requested_correlation text, requested_action text,
    requested_outcome text, requested_resource_type text, requested_resource_id text, requested_details jsonb)
  returns void
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id, organization_id,
      facility_id, action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details
    ) values (
      requested_correlation, 'staff', requested_subject, requested_account, requested_membership,
      requested_organization, requested_facility, requested_action, requested_outcome, requested_resource_type,
      requested_resource_id, 'healthcare-operations', 'application', 'identity-api',
      coalesce(requested_details, '{}'::jsonb));
  end
  $fn$;

  -- Route 6: who is in charge of each profile department.
  create function identity.workforce_in_charge_list()
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    actor record;
  begin
    select * into actor from identity.workforce_actor('workforce.roster.read');
    return jsonb_build_object('departments', coalesce((
      select jsonb_agg(jsonb_build_object('departmentCode', department.code, 'inCharges', coalesce((
               select jsonb_agg(identity.workforce_in_charge_card(in_charge.id)
                                order by in_charge.named_at, in_charge.id)
                 from identity.workforce_department_in_charges in_charge
                where in_charge.facility_id = actor.actor_facility and in_charge.department_code = department.code
                  and in_charge.ended_at is null), '[]'::jsonb))
             order by department.ord)
        from unnest(identity.workforce_facility_departments(actor.actor_facility)) with ordinality
             as department(code, ord)), '[]'::jsonb));
  end
  $fn$;

  -- Route 7: name an in-charge. Outcomes: named (replayed), department_invalid, member_invalid, already,
  -- limit_reached, key_reused.
  create function identity.workforce_in_charge_add(requested_department_code text, requested_membership_id uuid,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, in_charge jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    key_state record;
    member_row identity.staff_facility_memberships%rowtype;
    refusal text;
    new_id uuid;
  begin
    select * into actor from identity.workforce_actor('workforce.roster.manage');
    if requested_department_code is null or requested_department_code !~ '^[a-z_]{2,40}$'
       or requested_membership_id is null then
      raise exception using errcode = '22023', message = 'WORKFORCE_INVALID';
    end if;
    select * into key_state from identity.workforce_idempotency(actor.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.event_kind = 'in_charge_named' then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation,
        'identity.duty-roster.in-charge-add', 'success', 'department-in-charge', key_state.in_charge_id::text,
        jsonb_build_object('replayed', true));
      return query select 'named', true, identity.workforce_in_charge_card(key_state.in_charge_id);
      return;
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif not requested_department_code = any (identity.workforce_facility_departments(actor.actor_facility)) then
      refusal := 'department_invalid';
    end if;
    if refusal is null then
      select membership.* into member_row from identity.staff_facility_memberships membership
       where membership.id = requested_membership_id and membership.facility_id = actor.actor_facility
         and membership.active;
      if not found or not identity.workforce_member_holds(requested_membership_id, 'workforce.roster.read') then
        refusal := 'member_invalid';
      end if;
    end if;
    if refusal is null then
      perform pg_advisory_xact_lock(hashtextextended(
        'workforce-department:' || actor.actor_facility::text || ':' || requested_department_code, 0));
      if exists (select 1 from identity.workforce_department_in_charges in_charge
                  where in_charge.facility_id = actor.actor_facility
                    and in_charge.department_code = requested_department_code
                    and in_charge.membership_id = requested_membership_id and in_charge.ended_at is null) then
        refusal := 'already';
      elsif (select count(*) from identity.workforce_department_in_charges in_charge
              where in_charge.facility_id = actor.actor_facility
                and in_charge.department_code = requested_department_code and in_charge.ended_at is null) >= 5 then
        refusal := 'limit_reached';
      end if;
    end if;
    if refusal is not null then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation,
        'identity.duty-roster.in-charge-add', case when refusal = 'key_reused' then 'denied' else 'failure' end,
        'facility-membership', requested_membership_id::text,
        jsonb_build_object('refusal', refusal, 'departmentCode', requested_department_code));
      return query select refusal, false, null::jsonb;
      return;
    end if;
    insert into identity.workforce_department_in_charges (organization_id, facility_id, department_code,
      membership_id, account_id, named_by_membership_id, named_by_account_id)
    values (actor.actor_organization, actor.actor_facility, requested_department_code, member_row.id,
      member_row.account_id, actor.actor_membership, actor.actor_account)
    returning id into new_id;
    insert into identity.workforce_events (organization_id, facility_id, kind, in_charge_id, to_status,
      actor_account_id, actor_membership_id, idempotency_key, request_sha256, correlation_id)
    values (actor.actor_organization, actor.actor_facility, 'in_charge_named', new_id, 'active', actor.actor_account,
      actor.actor_membership, requested_idempotency_key, requested_request_sha256, actor.actor_correlation);
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation,
      'identity.duty-roster.in-charge-add', 'success', 'department-in-charge', new_id::text,
      jsonb_build_object('departmentCode', requested_department_code, 'membershipId', member_row.id));
    return query select 'named', false, identity.workforce_in_charge_card(new_id);
  end
  $fn$;

  -- Route 8: end an in-charge. Outcomes: ended (replayed), not_found, changed, key_reused.
  create function identity.workforce_in_charge_end(requested_in_charge_id uuid, requested_row_version bigint,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, in_charge jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    key_state record;
    current_row identity.workforce_department_in_charges%rowtype;
    refusal text;
  begin
    select * into actor from identity.workforce_actor('workforce.roster.manage');
    if requested_in_charge_id is null or requested_row_version is null or requested_row_version < 1 then
      raise exception using errcode = '22023', message = 'WORKFORCE_INVALID';
    end if;
    select * into key_state from identity.workforce_idempotency(actor.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.event_kind = 'in_charge_ended'
       and key_state.in_charge_id = requested_in_charge_id then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation,
        'identity.duty-roster.in-charge-end', 'success', 'department-in-charge', requested_in_charge_id::text,
        jsonb_build_object('replayed', true));
      return query select 'ended', true, identity.workforce_in_charge_card(requested_in_charge_id);
      return;
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    end if;
    if refusal is null then
      select in_charge.* into current_row from identity.workforce_department_in_charges in_charge
       where in_charge.id = requested_in_charge_id and in_charge.facility_id = actor.actor_facility
       for update;
      if not found then
        refusal := 'not_found';
      elsif current_row.row_version <> requested_row_version then
        refusal := 'changed';
      elsif current_row.ended_at is not null then
        refusal := 'not_found';
      end if;
    end if;
    if refusal is not null then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation,
        'identity.duty-roster.in-charge-end', case when refusal = 'key_reused' then 'denied' else 'failure' end,
        'department-in-charge', requested_in_charge_id::text, jsonb_build_object('refusal', refusal));
      return query select refusal, false, null::jsonb;
      return;
    end if;
    update identity.workforce_department_in_charges in_charge
       set ended_at = clock_timestamp(), ended_by_membership_id = actor.actor_membership,
           ended_by_account_id = actor.actor_account, row_version = in_charge.row_version + 1
     where in_charge.id = current_row.id;
    insert into identity.workforce_events (organization_id, facility_id, kind, in_charge_id, from_status, to_status,
      actor_account_id, actor_membership_id, idempotency_key, request_sha256, correlation_id)
    values (actor.actor_organization, actor.actor_facility, 'in_charge_ended', current_row.id, 'active', 'ended',
      actor.actor_account, actor.actor_membership, requested_idempotency_key, requested_request_sha256,
      actor.actor_correlation);
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation,
      'identity.duty-roster.in-charge-end', 'success', 'department-in-charge', current_row.id::text,
      jsonb_build_object('departmentCode', current_row.department_code, 'membershipId', current_row.membership_id));
    return query select 'ended', false, identity.workforce_in_charge_card(current_row.id);
  end
  $fn$;

  -- Route 9: my leave requests at this facility, newest first (up to 100).
  create function identity.staff_leave_requests_mine()
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    actor record;
    items jsonb;
  begin
    select * into actor from identity.workforce_actor('workforce.leave.request');
    select coalesce(jsonb_agg(identity.staff_leave_card(mine.leave_row, true)
                              order by (mine.leave_row).requested_at desc, (mine.leave_row).id desc), '[]'::jsonb)
      into items
      from (select leave_row from identity.staff_leave_requests leave_row
             where leave_row.membership_id = actor.actor_membership and leave_row.facility_id = actor.actor_facility
             order by leave_row.requested_at desc, leave_row.id desc limit 100) mine;
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.staff-leave.list-mine',
      'success', 'facility-membership', actor.actor_membership::text,
      jsonb_build_object('count', jsonb_array_length(items)));
    return jsonb_build_object('items', items);
  end
  $fn$;

  -- Route 10: ask for leave. Outcomes: requested (replayed), department_invalid, dates_invalid, overlaps,
  -- key_reused.
  create function identity.staff_leave_request_create(requested_leave_type text, requested_starts_on date,
    requested_ends_on date, requested_department_code text, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, leave_request jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    key_state record;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    refusal text;
    created identity.staff_leave_requests%rowtype;
  begin
    select * into actor from identity.workforce_actor('workforce.leave.request');
    if requested_leave_type is null or requested_leave_type not in ('annual', 'sick', 'maternity', 'study', 'other')
       or requested_starts_on is null or requested_ends_on is null
       or (requested_department_code is not null and requested_department_code !~ '^[a-z_]{2,40}$') then
      raise exception using errcode = '22023', message = 'WORKFORCE_INVALID';
    end if;
    select * into key_state from identity.workforce_idempotency(actor.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.event_kind = 'leave_requested' then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.staff-leave.request',
        'success', 'staff-leave-request', key_state.leave_request_id::text, jsonb_build_object('replayed', true));
      return query select 'requested', true, identity.staff_leave_card(leave_row, true)
        from identity.staff_leave_requests leave_row where leave_row.id = key_state.leave_request_id;
      return;
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif requested_department_code is not null
          and not requested_department_code = any (identity.workforce_facility_departments(actor.actor_facility)) then
      refusal := 'department_invalid';
    elsif requested_starts_on < today - 30 or requested_ends_on < requested_starts_on
          or requested_ends_on - requested_starts_on >= 365 then
      refusal := 'dates_invalid';
    end if;
    if refusal is null then
      -- One person's leave and duties change under one lock (W5).
      perform pg_advisory_xact_lock(hashtextextended(
        'workforce-person:' || actor.actor_facility::text || ':' || actor.actor_account::text, 0));
      if exists (select 1 from identity.staff_leave_requests leave_row
                  where leave_row.facility_id = actor.actor_facility and leave_row.account_id = actor.actor_account
                    and leave_row.status in ('requested', 'approved')
                    and leave_row.starts_on <= requested_ends_on and requested_starts_on <= leave_row.ends_on) then
        refusal := 'overlaps';
      end if;
    end if;
    if refusal is not null then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.staff-leave.request',
        case when refusal = 'key_reused' then 'denied' else 'failure' end, 'facility-membership',
        actor.actor_membership::text, jsonb_build_object('refusal', refusal));
      return query select refusal, false, null::jsonb;
      return;
    end if;
    insert into identity.staff_leave_requests (organization_id, facility_id, membership_id, account_id, leave_type,
      starts_on, ends_on, department_code)
    values (actor.actor_organization, actor.actor_facility, actor.actor_membership, actor.actor_account,
      requested_leave_type, requested_starts_on, requested_ends_on, requested_department_code)
    returning * into created;
    insert into identity.workforce_events (organization_id, facility_id, kind, leave_request_id, to_status,
      actor_account_id, actor_membership_id, idempotency_key, request_sha256, correlation_id)
    values (actor.actor_organization, actor.actor_facility, 'leave_requested', created.id, 'requested',
      actor.actor_account, actor.actor_membership, requested_idempotency_key, requested_request_sha256,
      actor.actor_correlation);
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.staff-leave.request',
      'success', 'staff-leave-request', created.id::text,
      jsonb_build_object('departmentCode', created.department_code));
    return query select 'requested', false, identity.staff_leave_card(created, true);
  end
  $fn$;

  -- Route 11: the requester cancels: from requested, or approved before it starts. Outcomes: cancelled
  -- (replayed), not_found, changed, cancel_not_allowed, key_reused. Duties are not put back.
  create function identity.staff_leave_request_cancel(requested_leave_request_id uuid, requested_row_version bigint,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, leave_request jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    key_state record;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    refusal text;
    current_row identity.staff_leave_requests%rowtype;
    changed_row identity.staff_leave_requests%rowtype;
  begin
    select * into actor from identity.workforce_actor(null);
    if requested_leave_request_id is null or requested_row_version is null or requested_row_version < 1 then
      raise exception using errcode = '22023', message = 'WORKFORCE_INVALID';
    end if;
    select * into key_state from identity.workforce_idempotency(actor.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.event_kind = 'leave_cancelled'
       and key_state.leave_request_id = requested_leave_request_id then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.staff-leave.cancel',
        'success', 'staff-leave-request', requested_leave_request_id::text, jsonb_build_object('replayed', true));
      return query select 'cancelled', true, identity.staff_leave_card(leave_row, true)
        from identity.staff_leave_requests leave_row where leave_row.id = requested_leave_request_id;
      return;
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    end if;
    if refusal is null then
      perform pg_advisory_xact_lock(hashtextextended(
        'workforce-person:' || actor.actor_facility::text || ':' || actor.actor_account::text, 0));
      select leave_row.* into current_row from identity.staff_leave_requests leave_row
       where leave_row.id = requested_leave_request_id and leave_row.facility_id = actor.actor_facility
         and leave_row.membership_id = actor.actor_membership
       for update;
      if not found then
        refusal := 'not_found';
      elsif current_row.row_version <> requested_row_version then
        refusal := 'changed';
      elsif not (current_row.status = 'requested' or (current_row.status = 'approved' and today < current_row.starts_on)) then
        refusal := 'cancel_not_allowed';
      end if;
    end if;
    if refusal is not null then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.staff-leave.cancel',
        case when refusal = 'key_reused' then 'denied' else 'failure' end, 'staff-leave-request',
        requested_leave_request_id::text, jsonb_build_object('refusal', refusal));
      return query select refusal, false, null::jsonb;
      return;
    end if;
    update identity.staff_leave_requests leave_row
       set status = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by_membership_id = actor.actor_membership,
           cancelled_by_account_id = actor.actor_account, updated_at = clock_timestamp(),
           row_version = leave_row.row_version + 1
     where leave_row.id = current_row.id
    returning * into changed_row;
    insert into identity.workforce_events (organization_id, facility_id, kind, leave_request_id, from_status,
      to_status, actor_account_id, actor_membership_id, idempotency_key, request_sha256, correlation_id)
    values (actor.actor_organization, actor.actor_facility, 'leave_cancelled', current_row.id, current_row.status,
      'cancelled', actor.actor_account, actor.actor_membership, requested_idempotency_key, requested_request_sha256,
      actor.actor_correlation);
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.staff-leave.cancel',
      'success', 'staff-leave-request', current_row.id::text, jsonb_build_object('fromStatus', current_row.status));
    return query select 'cancelled', false, identity.staff_leave_card(changed_row, true);
  end
  $fn$;

  -- Route 12: leave to decide (requested) or decided (approved, declined, cancelled in the last 90 days),
  -- earliest start first, at most 200. Administrators (workforce.roster.manage) see every request here; an
  -- in-charge those sent to their departments. Never the caller's own (nobody decides their own leave).
  -- Outcomes: listed, department_invalid. Anyone else: 42501 LEAVE_DECISION_NOT_ALLOWED.
  create function identity.staff_leave_requests_to_decide(requested_status text, requested_department_code text)
  returns table (outcome text, body jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    editable text[];
    shown jsonb;
    shown_ids jsonb;
    more boolean;
  begin
    select * into actor from identity.workforce_actor(null);
    if requested_status is null or requested_status not in ('requested', 'decided')
       or (requested_department_code is not null and requested_department_code !~ '^[a-z_]{2,40}$') then
      raise exception using errcode = '22023', message = 'WORKFORCE_INVALID';
    end if;
    editable := identity.workforce_editor_departments(actor.actor_membership);
    if not actor.holds_manage and cardinality(editable) = 0 then
      raise exception using errcode = '42501', message = 'LEAVE_DECISION_NOT_ALLOWED';
    end if;
    if requested_department_code is not null
       and not requested_department_code = any (identity.workforce_facility_departments(actor.actor_facility)) then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.staff-leave.list-to-decide',
        'failure', 'facility', actor.actor_facility::text, jsonb_build_object('refusal', 'department_invalid'));
      return query select 'department_invalid', null::jsonb;
      return;
    end if;
    if requested_department_code is not null and not actor.holds_manage
       and not requested_department_code = any (editable) then
      raise exception using errcode = '42501', message = 'LEAVE_DECISION_NOT_ALLOWED';
    end if;
    select coalesce(jsonb_agg(identity.staff_leave_card(page.leave_row, true) order by page.rank_no)
                      filter (where page.rank_no <= 200), '[]'::jsonb),
           coalesce(jsonb_agg((page.leave_row).id order by page.rank_no) filter (where page.rank_no <= 200), '[]'::jsonb),
           count(*) > 200
      into shown, shown_ids, more
      from (select leave_row,
                   row_number() over (order by leave_row.starts_on, leave_row.requested_at, leave_row.id) as rank_no
              from identity.staff_leave_requests leave_row
             where leave_row.facility_id = actor.actor_facility and leave_row.account_id <> actor.actor_account
               and (actor.holds_manage or leave_row.department_code = any (editable))
               and (requested_department_code is null or leave_row.department_code = requested_department_code)
               and ((requested_status = 'requested' and leave_row.status = 'requested')
                    or (requested_status = 'decided' and leave_row.status in ('approved', 'declined', 'cancelled')
                        and greatest(leave_row.decided_at, leave_row.cancelled_at)
                            >= clock_timestamp() - interval '90 days'))
             order by leave_row.starts_on, leave_row.requested_at, leave_row.id
             limit 201) page;
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, 'identity.staff-leave.list-to-decide',
      'success', 'facility', actor.actor_facility::text,
      jsonb_build_object('status', requested_status, 'count', jsonb_array_length(shown), 'ids', shown_ids));
    return query select 'listed', jsonb_build_object('items', shown, 'hasMore', more, 'limit', 200);
  end
  $fn$;

  -- Routes 13 and 14: approve or decline. Outcomes: approved or declined (replayed), not_found,
  -- decision_not_allowed, own_decision, already_decided, changed, clashes_with_roster (0202's trigger; dates in
  -- details), key_reused.
  create function identity.staff_leave_request_decide(requested_leave_request_id uuid, requested_decision text,
    requested_row_version bigint, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, leave_request jsonb, details jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    key_state record;
    refusal text;
    refusal_details jsonb;
    current_row identity.staff_leave_requests%rowtype;
    changed_row identity.staff_leave_requests%rowtype;
    new_status text;
    error_message text;
    error_detail text;
    action_name text;
  begin
    select * into actor from identity.workforce_actor(null);
    if requested_leave_request_id is null or requested_decision is null
       or requested_decision not in ('approve', 'decline')
       or requested_row_version is null or requested_row_version < 1 then
      raise exception using errcode = '22023', message = 'WORKFORCE_INVALID';
    end if;
    new_status := case requested_decision when 'approve' then 'approved' else 'declined' end;
    action_name := 'identity.staff-leave.' || requested_decision;
    select * into key_state from identity.workforce_idempotency(actor.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.event_kind = 'leave_' || new_status
       and key_state.leave_request_id = requested_leave_request_id then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, action_name, 'success',
        'staff-leave-request', requested_leave_request_id::text, jsonb_build_object('replayed', true));
      return query select new_status, true, identity.staff_leave_card(leave_row, true), null::jsonb
        from identity.staff_leave_requests leave_row where leave_row.id = requested_leave_request_id;
      return;
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    end if;
    if refusal is null then
      select leave_row.* into current_row from identity.staff_leave_requests leave_row
       where leave_row.id = requested_leave_request_id and leave_row.facility_id = actor.actor_facility;
      if not found then
        refusal := 'not_found';
      elsif not (actor.holds_manage
                 or current_row.department_code = any (identity.workforce_editor_departments(actor.actor_membership))) then
        refusal := 'decision_not_allowed';
      elsif current_row.account_id = actor.actor_account then
        refusal := 'own_decision';
      end if;
    end if;
    if refusal is null then
      -- The requester's lock (W5), then the row.
      perform pg_advisory_xact_lock(hashtextextended(
        'workforce-person:' || actor.actor_facility::text || ':' || current_row.account_id::text, 0));
      select leave_row.* into current_row from identity.staff_leave_requests leave_row
       where leave_row.id = requested_leave_request_id
       for update;
      if current_row.status <> 'requested' then
        refusal := 'already_decided';
      elsif current_row.row_version <> requested_row_version then
        refusal := 'changed';
      end if;
    end if;
    if refusal is null then
      begin
        update identity.staff_leave_requests leave_row
           set status = new_status, decided_at = clock_timestamp(), decided_by_membership_id = actor.actor_membership,
               decided_by_account_id = actor.actor_account, updated_at = clock_timestamp(),
               row_version = leave_row.row_version + 1
         where leave_row.id = current_row.id
        returning * into changed_row;
      exception when object_not_in_prerequisite_state then
        get stacked diagnostics error_message = message_text, error_detail = pg_exception_detail;
        -- 0202's trigger staff_leave_requests_roster_clash: the dates (YYYY-MM-DD, comma-separated) in DETAIL.
        if error_message = 'LEAVE_CLASHES_WITH_ROSTER' then
          refusal := 'clashes_with_roster';
          refusal_details := jsonb_build_object('dates', to_jsonb(string_to_array(coalesce(error_detail, ''), ',')));
        else
          raise;
        end if;
      end;
    end if;
    if refusal is not null then
      perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, actor.actor_facility, actor.actor_correlation, action_name,
        case when refusal in ('key_reused', 'decision_not_allowed', 'own_decision') then 'denied' else 'failure' end,
        'staff-leave-request', requested_leave_request_id::text, jsonb_build_object('refusal', refusal));
      return query select refusal, false, null::jsonb, refusal_details;
      return;
    end if;
    insert into identity.workforce_events (organization_id, facility_id, kind, leave_request_id, from_status,
      to_status, actor_account_id, actor_membership_id, idempotency_key, request_sha256, correlation_id)
    values (actor.actor_organization, actor.actor_facility, 'leave_' || new_status, current_row.id, 'requested',
      new_status, actor.actor_account, actor.actor_membership, requested_idempotency_key, requested_request_sha256,
      actor.actor_correlation);
    perform identity.workforce_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_organization, actor.actor_facility, actor.actor_correlation, action_name, 'success',
      'staff-leave-request', current_row.id::text, jsonb_build_object('departmentCode', current_row.department_code));
    return query select new_status, false, identity.staff_leave_card(changed_row, true), null::jsonb;
  end
  $fn$;

  comment on function identity.workforce_in_charge_list() is
    '0200 (ROS-1): who is in charge of each of this facility''s profile departments. Needs workforce.roster.read.';
  comment on function identity.workforce_in_charge_add(text, uuid, text, text) is
    '0200 (ROS-1, Q-ROS-8 A): the administrator names an in-charge of a department (an active member holding workforce.roster.read; up to 5). Needs workforce.roster.manage. Outcomes named (replayed), department_invalid, member_invalid, already, limit_reached, key_reused. Audited (identity.duty-roster.in-charge-add).';
  comment on function identity.workforce_in_charge_end(uuid, bigint, text, text) is
    '0200 (ROS-1): the administrator ends an in-charge. Needs workforce.roster.manage. Outcomes ended (replayed), not_found, changed, key_reused. Audited (identity.duty-roster.in-charge-end).';
  comment on function identity.staff_leave_requests_mine() is
    '0200 (ROS-1): the caller''s own leave requests here, newest first (up to 100). Needs workforce.leave.request. Audited (identity.staff-leave.list-mine).';
  comment on function identity.staff_leave_request_create(text, date, date, text, text, text) is
    '0200 (ROS-1, Q244 A): ask for leave: type and dates only, optionally the deciding department. Needs workforce.leave.request. Outcomes requested (replayed), department_invalid, dates_invalid, overlaps, key_reused. Audited (identity.staff-leave.request; never the type or dates).';
  comment on function identity.staff_leave_request_cancel(uuid, bigint, text, text) is
    '0200 (ROS-1): the requester cancels their leave (requested, or approved before it starts). Outcomes cancelled (replayed), not_found, changed, cancel_not_allowed, key_reused. Audited (identity.staff-leave.cancel).';
  comment on function identity.staff_leave_requests_to_decide(text, text) is
    '0200 (ROS-1): leave to decide or decided, for administrators (all) and in-charges (their departments); never the caller''s own. Outcomes listed, department_invalid; 42501 LEAVE_DECISION_NOT_ALLOWED for anyone else. Audited (identity.staff-leave.list-to-decide, count and ids).';
  comment on function identity.staff_leave_request_decide(uuid, text, bigint, text, text) is
    '0200 (ROS-1): approve or decline a leave request, never one''s own. Outcomes approved or declined (replayed), not_found, decision_not_allowed, own_decision, already_decided, changed, clashes_with_roster (0202), key_reused. Audited (identity.staff-leave.approve or .decline).';

  -- Grants: EXECUTE for hid_identity_runtime on the eight definers only (here and in runtime-grants.sql).
  revoke all on function identity.workforce_member_holds(uuid, text), identity.workforce_actor(text),
    identity.workforce_facility_departments(uuid), identity.workforce_editor_departments(uuid),
    identity.staff_leave_card(identity.staff_leave_requests, boolean), identity.workforce_in_charge_card(uuid),
    identity.workforce_idempotency(uuid, text, text),
    identity.workforce_audit(text, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb),
    identity.workforce_in_charge_list(), identity.workforce_in_charge_add(text, uuid, text, text),
    identity.workforce_in_charge_end(uuid, bigint, text, text), identity.staff_leave_requests_mine(),
    identity.staff_leave_request_create(text, date, date, text, text, text),
    identity.staff_leave_request_cancel(uuid, bigint, text, text),
    identity.staff_leave_requests_to_decide(text, text),
    identity.staff_leave_request_decide(uuid, text, bigint, text, text) from public;
  if v_runtime then
    grant execute on function identity.workforce_in_charge_list(), identity.workforce_in_charge_add(text, uuid, text, text),
      identity.workforce_in_charge_end(uuid, bigint, text, text), identity.staff_leave_requests_mine(),
      identity.staff_leave_request_create(text, date, date, text, text, text),
      identity.staff_leave_request_cancel(uuid, bigint, text, text),
      identity.staff_leave_requests_to_decide(text, text),
      identity.staff_leave_request_decide(uuid, text, bigint, text, text) to hid_identity_runtime;
  end if;

  -- 3. Post-checks.
  if (select count(*) from pg_class relation
       where relation.oid = any (v_tables::regclass[])
         and relation.relowner = v_owner and relation.relrowsecurity and relation.relforcerowsecurity) <> 3
     or exists (select 1 from pg_class relation,
                  lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                 where relation.oid = any (v_tables::regclass[]) and acl.grantee <> relation.relowner)
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid = any (v_tables::regclass[])
            and policy_row.polpermissive and policy_row.polroles = array[0::oid]
            and ((policy_row.polcmd = 'r' and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'true'
                  and policy_row.polwithcheck is null)
              or (policy_row.polcmd = 'a' and policy_row.polqual is null
                  and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = 'true')
              or (policy_row.polcmd = 'w' and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'true'
                  and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = 'true')
              or (policy_row.polcmd = 'd' and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'true'
                  and policy_row.polwithcheck is null))) <> 12
     or (select count(*) from pg_policy policy_row where policy_row.polrelid = any (v_tables::regclass[])) <> 12
     or exists (select 1 from pg_attribute attribute_row
                 left join pg_attrdef default_row on default_row.adrelid = attribute_row.attrelid
                       and default_row.adnum = attribute_row.attnum
                 where attribute_row.attrelid = any (v_tables::regclass[]) and attribute_row.attnum > 0
                   and (attribute_row.attidentity <> ''
                        or pg_get_expr(default_row.adbin, default_row.adrelid) like '%nextval%')) then
    raise exception using errcode = '55000', message = '0200: post-check failed (the tables'' owner, row-level security, '
      || 'policies or privileges)';
  end if;
  if (select count(*) from generate_subscripts(v_triggers, 1) idx
        join pg_trigger trigger_row on trigger_row.tgrelid = v_triggers[idx][1]::regclass
                                   and trigger_row.tgname = v_triggers[idx][2]
       where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
         and trigger_row.tgtype = v_triggers[idx][3]::smallint and trigger_row.tgqual is null
         and trigger_row.tgattr = ''::int2vector and trigger_row.tgnargs = 0
         and trigger_row.tgfoid = 'platform.reject_mutation()'::regprocedure) <> 6
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = any (v_tables::regclass[]) and not trigger_row.tgisinternal) <> 6 then
    raise exception using errcode = '55000', message = '0200: post-check failed (the no-delete and append-only triggers)';
  end if;
  select string_agg(v_functions[idx][1] || ' (' || coalesce(md5(proc.prosrc), 'missing') || ')', ', ')
    into v_mismatch
    from generate_subscripts(v_functions, 1) idx
    left join pg_proc proc on proc.oid = to_regprocedure(v_functions[idx][1])
   where proc.oid is null
      or md5(proc.prosrc) is distinct from v_functions[idx][2]
      or proc.proowner <> v_owner
      or proc.prosecdef <> v_functions[idx][3]::boolean
      or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']
      or exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                  where acl.grantee <> proc.proowner
                    and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime'
                         or not v_functions[idx][4]::boolean))
      or (v_runtime and v_functions[idx][4]::boolean
          and not has_function_privilege('hid_identity_runtime', proc.oid, 'EXECUTE'));
  if v_mismatch is not null
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'identity' and proc.proname = any (v_function_names))
        <> array_length(v_functions, 1) then
    raise exception using errcode = '55000',
      message = '0200: post-check failed (these functions are not as reviewed: ' || coalesce(v_mismatch, 'an extra one')
        || ')';
  end if;

  raise notice '0200: leave requests and department in-charges are installed (3 tables, 16 functions). Nobody can use them until 0201 gives the codes; identity-api''s DUTY_ROSTER_ENABLED keeps the routes closed until the go-live.';
end
$hr0200$;
