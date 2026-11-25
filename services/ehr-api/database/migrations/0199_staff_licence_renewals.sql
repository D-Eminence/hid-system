-- 0199 ROS-1 Shifts, rosters, HR and credentials: licence renewals and expiry
-- (Release D, the department sprint the owner approved on 25 November 2026,
-- verbatim: "I approve Q147-Q290 at the recommended options"). Written on
-- claude/sprint-hr-backend at 67a1099a (staging-novu-ci-20261005 at 0cfddcc9:
-- 0001-0153 applied). The number is provisional (given at merge). It reads
-- nothing 0140-0198 create or change: it needs 0086's and 0139's objects only.
-- The declaration in config/production-schema-compatibility.json stays
-- unsigned until the owner signs this file.
--
-- Owner decisions (25 November 2026, each at its recommended option):
-- Q243 A (an expired licence only warns: the list, a banner and the export;
-- no role or access ever changes because of it), Q247 A (the administrator
-- records how the licence was checked; Health ID connects to no regulator
-- register), Q244 A (work data only), Q154 A (the contract,
-- docs/EHR_PLANNED_CONTRACT.md ROS-1, was written first), Q160 A (the go-live
-- gate). Smaller choices at the recommended option, not yet answered by the
-- owner: Q-ROS-12 A (the export shows the last 4 characters of a licence
-- number), Q-ROS-13 A (an administrator may record their own renewal; it is
-- marked self_recorded), Q-ROS-14 A (no renewals at governed facilities: the
-- routes are admitted by 0086's identity.staff_management_actor, which
-- refuses them), Q-ROS-15 A (no free text: a withdrawal has a reason code).
-- The 30 and 60 day windows are on the clinical lead's checklist.
--
-- What it changes (nothing else):
-- L1 identity.staff_licence_renewals, append-only: organisation, facility,
--    membership and account (foreign key to the membership, as 0086's
--    attestations), attestation_id (the attestation it was recorded against),
--    licence_body and licence_key (copied from it), role_code, period
--    (licence_year: valid to 31 December of licence_year; expiry_date: an
--    exact date), valid_until, checked_how (regulator_register,
--    certificate_seen, in_person), checked_on, who checked it
--    (checked_by_account_id, checked_by_membership_id), self_recorded,
--    attestation_version (the text facility-licence-renewal-v1), recorded_at,
--    the Idempotency-Key with the request's SHA-256 (unique per membership and
--    key) and the correlation id. A renewal belongs to the licence by its key
--    (body and normalised number, 0086's identity.staff_licence_key), so it
--    still counts after the role is removed and added again with the same
--    licence; a new licence number starts with no renewal.
-- L2 identity.staff_licence_renewal_withdrawals, append-only, at most one per
--    renewal: reason_code (wrong_member, wrong_dates, wrong_licence, other),
--    who and when, the Idempotency-Key with the request's SHA-256.
--    Both tables: row-level security enabled and forced, with only the
--    owner's four command policies (0086's staff_licence_attestations form);
--    no privilege for any runtime role; a row trigger refuses UPDATE and
--    DELETE and a statement trigger refuses TRUNCATE, both with
--    platform.reject_mutation(). No identity column and no sequence.
-- L3 identity.staff_attestation_texts gains facility-licence-renewal-v1 (the
--    text the administrator confirms; the website fills {name}).
-- L4 Functions, SECURITY DEFINER with SET search_path = pg_catalog, pg_temp,
--    every object named with its schema, no temporary table; owned like
--    0139's (the migration owner); EXECUTE for hid_identity_runtime only:
--      identity.staff_licence_status_list()           route 1
--      identity.staff_licence_member_read(uuid)       route 2
--      identity.staff_licence_export_rows()           route 3
--      identity.staff_licence_renewal_record(...)     route 4
--      identity.staff_licence_renewal_withdraw(...)   route 5
--    Helpers no role may execute (SECURITY INVOKER, the same search_path;
--    they run only inside the definers, as their owner):
--      identity.staff_licence_status_of(date, date)   the status of a date
--      identity.staff_licence_status_rows(uuid, date) one row per licensed
--        active role of each active member (0139's licence rule: the latest
--        attestation tied to the grant), plus one row per member with no
--        licensed role
--      identity.staff_licence_renewal_json(uuid)      a renewal's answer
--      identity.staff_licence_audit(...)              one audit row
--    Each definer is admitted by 0086's identity.staff_management_actor
--    (md5-pinned): a staff session at a self-signed-up facility holding
--    workforce.manage, purpose healthcare-operations (42501
--    STAFF_MANAGEMENT_PERMISSION_DENIED without the code, 42501
--    STAFF_MANAGEMENT_NOT_AVAILABLE at governed, legacy and released
--    facilities). Routes 4 and 5 also need support's review (outcome
--    review_pending).
-- L5 Audit, in the request's transaction. A refusal the function answers is
--    written here (outcome denied or failure); a refusal it raises (42501, or
--    22023 for input identity-api never sends) is written by identity-api's
--    request audit. identity.staff-licence.list (counts),
--    identity.staff-licence.member-read (the membership),
--    identity.staff-licence.export (counts, never a name),
--    identity.staff-licence.renewal-record (membership, role, period kind, how
--    checked, self-recorded), identity.staff-licence.renewal-withdraw (the
--    renewal, the reason code). No row ever holds a name or a licence number.
--
-- Licence status (as of today's Lagos date): no_licence (a licensed role with
-- no attestation, members from before 0086), not_recorded (a licence with no
-- renewal that is not withdrawn), else from the latest renewal not withdrawn
-- (by recorded_at): expired (valid_until before today), expiring_30 (0-30
-- days left), expiring_60 (31-60), valid (more). A warning only: nothing is
-- refused or changed because of a status (Q243 A).
--
-- Locks (measured with pg_locks before commit and compared by the
-- workforce-migrations suite), taken first, NOWAIT: SHARE ROW EXCLUSIVE on
-- identity.staff_licence_attestations, identity.staff_facility_memberships,
-- identity.facilities, identity.staff_attestation_texts and auth.accounts (the
-- foreign keys of the new, empty tables; the text row); ACCESS SHARE on
-- auth.account_roles, identity.staff and auth.permissions (read by the
-- preconditions and post-checks). A busy table fails the attempt at once and
-- its subtransaction releases what it took. The attempt is made 50 times,
-- 100 ms apart (about 5 seconds), so the file never waits for one of its locks
-- while holding the others; then 55P03 (nothing applied). When this
-- transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run applies every pending file
-- in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied. Both refusals begin "0199: " and end "run the release again at a
-- quieter time", so the runner's dry run rolls back and tries again (#306).
--
-- Old images on this schema: nothing calls the new functions. Today's
-- GET /identity/facility-staff is unchanged. identity-api's
-- HR_CREDENTIALS_ENABLED (off by default) keeps routes 1-5 closed until the
-- owner's go-live; while it is on, a database without this file answers 503
-- HR_CREDENTIALS_NOT_AVAILABLE.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- functions and the two tables. The attestation text row stays (append-only).
--
-- The whole file is one statement (do $hr0199$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): 0086's and 0139's markers;
--    "0199: already applied" when every object of this file is there exactly
--    as it leaves it, "0199: the schema is not in the reviewed state" for any
--    other state with part of it; the bodies it calls md5-pinned; the columns
--    it reads.
-- 2. L1-L4 and the grants.
-- 3. Post-checks in 0148's and 0152's form: owners; row-level security
--    enabled and forced with exactly the four owner command policies; no
--    privilege on the tables for any role but the owner; no identity column
--    or sequence; each trigger's tgtype, tgqual, tgattr, tgnargs, tgfoid and
--    tgenabled; each function's owner, SECURITY DEFINER or not, fixed
--    search_path, EXECUTE list and pinned body; the text row.

do $hr0199$
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
  v_text constant text := 'I confirm that I checked {name}''s practising licence in the way recorded here, and that '
    || 'it is current until the date recorded. Health ID records this confirmation with my name.';
  -- Every function this file makes: signature, body md5, SECURITY DEFINER, EXECUTE for hid_identity_runtime.
  v_functions constant text[][] := array[
    ['identity.staff_licence_status_of(date,date)', '22f244e57d0ab5532d16e50638da2898', 'false', 'false'],
    ['identity.staff_licence_status_rows(uuid,date)', 'a5befc89f3755646d3c39e0d42dc2210', 'false', 'false'],
    ['identity.staff_licence_renewal_json(uuid)', '9f8e982682efbf1af6f974dad28819bf', 'false', 'false'],
    ['identity.staff_licence_audit(text,uuid,uuid,uuid,uuid,text,text,text,text,text,jsonb)',
     '38eb210c665b1d9a0588b344bb721ff1', 'false', 'false'],
    ['identity.staff_licence_status_list()', '0c00bbf5a74a67fabbc3dcaffa570a71', 'true', 'true'],
    ['identity.staff_licence_member_read(uuid)', 'b6c112332305fd382b65b0fff1e8822f', 'true', 'true'],
    ['identity.staff_licence_export_rows()', '174f971114e35a2d533635f86fe6a4a0', 'true', 'true'],
    ['identity.staff_licence_renewal_record(uuid,text,text,integer,date,text,date,text,text,text)',
     'f1bf501888c60d038a2ae466f3282da7', 'true', 'true'],
    ['identity.staff_licence_renewal_withdraw(uuid,text,text,text)', 'a16fb982e93664ea9d4f01265549c44c', 'true', 'true']];
  -- Every trigger: table, name, tgtype (1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate).
  v_triggers constant text[][] := array[
    ['identity.staff_licence_renewals', 'staff_licence_renewals_append_only', '27'],
    ['identity.staff_licence_renewals', 'staff_licence_renewals_no_truncate', '34'],
    ['identity.staff_licence_renewal_withdrawals', 'staff_licence_renewal_withdrawals_append_only', '27'],
    ['identity.staff_licence_renewal_withdrawals', 'staff_licence_renewal_withdrawals_no_truncate', '34']];
  v_tables constant text[] := array['identity.staff_licence_renewals', 'identity.staff_licence_renewal_withdrawals'];
  v_function_names constant text[] := array['staff_licence_status_of', 'staff_licence_status_rows',
    'staff_licence_renewal_json', 'staff_licence_audit', 'staff_licence_status_list', 'staff_licence_member_read',
    'staff_licence_export_rows', 'staff_licence_renewal_record', 'staff_licence_renewal_withdraw'];
  v_function text[];
begin
  -- The markers of the tables step 0 locks (catalog reads only).
  if to_regclass('identity.staff_licence_attestations') is null or to_regclass('identity.staff_attestation_texts') is null
     or to_regclass('identity.staff_facility_memberships') is null then
    raise exception using errcode = '55000', message = '0199: 0086 and 0139 must be applied first';
  end if;

  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0 reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table identity.staff_licence_attestations, identity.staff_facility_memberships, identity.facilities,
    identity.staff_attestation_texts, auth.accounts
    in share row exclusive mode nowait;
  lock table auth.account_roles, identity.staff, auth.permissions in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0199: the licence attestations, staff memberships, facilities, attestation texts, accounts or a '
          || 'table 0199 reads (role assignments, staff, permissions) is busy, and this transaction already holds an '
          || 'earlier migration''s locks, so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0199: the licence attestations, staff memberships, facilities, attestation texts, accounts or a '
          || 'table 0199 reads (role assignments, staff, permissions) stayed busy for 5 seconds; nothing applied; run '
          || 'the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if to_regprocedure('identity.staff_management_actor(boolean)') is null
     or to_regprocedure('identity.staff_role_licences(uuid)') is null
     or not exists (select 1 from identity.staff_attestation_texts where version = 'platform-staff-role-v1')
     or not exists (select 1 from auth.permissions where code = 'workforce.manage' and active) then
    raise exception using errcode = '55000', message = '0199: 0086 and 0139 must be applied first';
  end if;

  -- Exactly applied, or not at all.
  select count(*) into v_present
    from (select to_regclass(name)::oid as object_id from unnest(v_tables) name
          union all
          select to_regprocedure(v_functions[idx][1])::oid
            from generate_subscripts(v_functions, 1) idx) present
   where present.object_id is not null;
  if v_present = 2 + array_length(v_functions, 1)
     and not exists (select 1 from generate_subscripts(v_functions, 1) idx
                      where (select md5(proc.prosrc) from pg_proc proc
                              where proc.oid = to_regprocedure(v_functions[idx][1]))
                            is distinct from v_functions[idx][2])
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid in (to_regclass('identity.staff_licence_renewals'),
                                          to_regclass('identity.staff_licence_renewal_withdrawals'))
             and not trigger_row.tgisinternal) = 4
     and exists (select 1 from identity.staff_attestation_texts
                  where version = 'facility-licence-renewal-v1' and text = v_text) then
    raise exception using errcode = '55000', message = '0199: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from identity.staff_attestation_texts where version = 'facility-licence-renewal-v1')
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'identity' and proc.proname = any (v_function_names)) then
    raise exception using errcode = '55000',
      message = '0199: the schema is not in the reviewed state (part of 0199 is there); nothing applied';
  end if;

  -- The bodies this file calls, as 0001-0153 leave them.
  select string_agg(expected.signature, ', ' order by expected.signature) into v_mismatch
    from (values
      ('identity.staff_management_actor(boolean)', '677d7d0d0d5e5ebaef13940b1d1ce395'),
      ('identity.staff_role_licence_body(text)', '1d6531b60beaf640a46342be8380eac3'),
      ('identity.licence_number_hint(text)', 'e60b48d39d795692d113f34f1aa94956'),
      ('identity.staff_licence_key(text,text)', '407fc7b6a71477fd3b372700254c1bd1'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0199: these bodies are not as 0001-0153 left them: ' || v_mismatch;
  end if;
  -- The columns this file reads, by name and type.
  select string_agg(wanted.relation || '.' || wanted.column_name, ', ' order by wanted.relation, wanted.column_name)
    into v_mismatch
    from (values
      ('identity.staff_licence_attestations', 'id', 'uuid'),
      ('identity.staff_licence_attestations', 'membership_id', 'uuid'),
      ('identity.staff_licence_attestations', 'facility_id', 'uuid'),
      ('identity.staff_licence_attestations', 'role_code', 'text'),
      ('identity.staff_licence_attestations', 'role_grant_id', 'uuid'),
      ('identity.staff_licence_attestations', 'licence_body', 'text'),
      ('identity.staff_licence_attestations', 'licence_number', 'text'),
      ('identity.staff_licence_attestations', 'licence_key', 'text'),
      ('identity.staff_licence_attestations', 'recorded_at', 'timestamp with time zone'),
      ('auth.account_roles', 'id', 'uuid'), ('auth.account_roles', 'membership_id', 'uuid'),
      ('auth.account_roles', 'facility_id', 'uuid'), ('auth.account_roles', 'role_code', 'text'),
      ('auth.account_roles', 'scope_type', 'text'),
      ('auth.account_roles', 'revoked_at', 'timestamp with time zone'),
      ('identity.staff_facility_memberships', 'id', 'uuid'),
      ('identity.staff_facility_memberships', 'account_id', 'uuid'),
      ('identity.staff_facility_memberships', 'staff_id', 'uuid'),
      ('identity.staff_facility_memberships', 'facility_id', 'uuid'),
      ('identity.staff_facility_memberships', 'organization_id', 'uuid'),
      ('identity.staff_facility_memberships', 'active', 'boolean'),
      ('identity.staff', 'full_name', 'text'), ('auth.accounts', 'display_name', 'text')
    ) wanted(relation, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = wanted.relation::regclass
                        and attribute_row.attname = wanted.column_name and attribute_row.attnum > 0
                        and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = wanted.type_name);
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0199: these columns are not as 0001-0153 left them: ' || v_mismatch;
  end if;

  -- 2. L1. The renewals.
  create table identity.staff_licence_renewals (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    facility_id uuid not null,
    membership_id uuid not null,
    account_id uuid not null,
    attestation_id uuid not null references identity.staff_licence_attestations(id) on delete restrict,
    role_code text not null check (role_code in ('doctor', 'nurse', 'lab', 'pharmacist')),
    licence_body text not null check (licence_body in ('MDCN', 'NMCN', 'MLSCN', 'PCN')),
    licence_key text not null check (length(licence_key) between 3 and 120),
    period text not null check (period in ('licence_year', 'expiry_date')),
    licence_year integer check (licence_year between 2000 and 2200),
    valid_until date not null,
    checked_how text not null check (checked_how in ('regulator_register', 'certificate_seen', 'in_person')),
    checked_on date not null,
    checked_by_account_id uuid not null references auth.accounts(id) on delete restrict,
    checked_by_membership_id uuid not null,
    self_recorded boolean not null,
    attestation_version text not null references identity.staff_attestation_texts(version) on delete restrict,
    recorded_at timestamptz not null default clock_timestamp(),
    idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
    correlation_id text not null check (length(correlation_id) between 8 and 128),
    constraint staff_licence_renewals_facility_fk foreign key (facility_id, organization_id)
      references identity.facilities(id, organization_id) on delete restrict,
    constraint staff_licence_renewals_membership_fk foreign key (membership_id, facility_id, account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint staff_licence_renewals_checker_fk foreign key (checked_by_membership_id, facility_id, checked_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
    constraint staff_licence_renewals_period_ck check (
      (period = 'licence_year') = (licence_year is not null)
      and (period <> 'licence_year' or valid_until = make_date(licence_year, 12, 31))),
    constraint staff_licence_renewals_body_ck check (
      licence_body = case role_code when 'doctor' then 'MDCN' when 'nurse' then 'NMCN' when 'lab' then 'MLSCN'
                                    else 'PCN' end
      and left(licence_key, length(licence_body) + 1) = licence_body || ':'),
    constraint staff_licence_renewals_self_ck check (self_recorded = (checked_by_account_id = account_id))
  );
  create unique index staff_licence_renewals_key_ux
    on identity.staff_licence_renewals (checked_by_membership_id, idempotency_key);
  create index staff_licence_renewals_licence_idx
    on identity.staff_licence_renewals (facility_id, account_id, licence_key, recorded_at);
  create index staff_licence_renewals_membership_idx on identity.staff_licence_renewals (membership_id);
  create index staff_licence_renewals_attestation_idx on identity.staff_licence_renewals (attestation_id);
  alter table identity.staff_licence_renewals enable row level security;
  alter table identity.staff_licence_renewals force row level security;
  create policy staff_licence_renewals_command_read on identity.staff_licence_renewals for select using (true);
  create policy staff_licence_renewals_command_insert on identity.staff_licence_renewals for insert with check (true);
  create policy staff_licence_renewals_command_update on identity.staff_licence_renewals
    for update using (true) with check (true);
  create policy staff_licence_renewals_command_delete on identity.staff_licence_renewals for delete using (true);
  revoke all on identity.staff_licence_renewals from public;
  create trigger staff_licence_renewals_append_only
    before update or delete on identity.staff_licence_renewals
    for each row execute function platform.reject_mutation();
  create trigger staff_licence_renewals_no_truncate
    before truncate on identity.staff_licence_renewals
    for each statement execute function platform.reject_mutation();
  comment on table identity.staff_licence_renewals is
    '0199 (ROS-1, Q243 A, Q247 A): a licence renewal the facility administrator recorded beside the licence SX-4 shows (keyed by 0086''s licence key): the licence year or expiry date, how and when it was checked, and who checked it. Append-only; a mistake is withdrawn (identity.staff_licence_renewal_withdrawals). A warning only: nothing changes when a licence expires. Only 0199''s functions read and write it, as its owner.';

  -- L2. The withdrawals.
  create table identity.staff_licence_renewal_withdrawals (
    id uuid primary key default gen_random_uuid(),
    renewal_id uuid not null unique references identity.staff_licence_renewals(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    reason_code text not null check (reason_code in ('wrong_member', 'wrong_dates', 'wrong_licence', 'other')),
    withdrawn_by_account_id uuid not null references auth.accounts(id) on delete restrict,
    withdrawn_by_membership_id uuid not null,
    withdrawn_at timestamptz not null default clock_timestamp(),
    idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
    correlation_id text not null check (length(correlation_id) between 8 and 128),
    constraint staff_licence_renewal_withdrawals_by_fk
      foreign key (withdrawn_by_membership_id, facility_id, withdrawn_by_account_id)
      references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict
  );
  create unique index staff_licence_renewal_withdrawals_key_ux
    on identity.staff_licence_renewal_withdrawals (withdrawn_by_membership_id, idempotency_key);
  alter table identity.staff_licence_renewal_withdrawals enable row level security;
  alter table identity.staff_licence_renewal_withdrawals force row level security;
  create policy staff_licence_renewal_withdrawals_command_read on identity.staff_licence_renewal_withdrawals
    for select using (true);
  create policy staff_licence_renewal_withdrawals_command_insert on identity.staff_licence_renewal_withdrawals
    for insert with check (true);
  create policy staff_licence_renewal_withdrawals_command_update on identity.staff_licence_renewal_withdrawals
    for update using (true) with check (true);
  create policy staff_licence_renewal_withdrawals_command_delete on identity.staff_licence_renewal_withdrawals
    for delete using (true);
  revoke all on identity.staff_licence_renewal_withdrawals from public;
  create trigger staff_licence_renewal_withdrawals_append_only
    before update or delete on identity.staff_licence_renewal_withdrawals
    for each row execute function platform.reject_mutation();
  create trigger staff_licence_renewal_withdrawals_no_truncate
    before truncate on identity.staff_licence_renewal_withdrawals
    for each statement execute function platform.reject_mutation();
  comment on table identity.staff_licence_renewal_withdrawals is
    '0199 (ROS-1, Q-ROS-15 A): a licence renewal withdrawn as entered by mistake, with a reason code (no free text), who and when. At most one per renewal. Append-only. Only 0199''s functions read and write it, as its owner.';

  -- L3. The text the administrator confirms (append-only table; the website fills {name}).
  insert into identity.staff_attestation_texts (version, text) values ('facility-licence-renewal-v1', v_text);

  -- L4. Helpers (no role may execute them; the definers below run them as their owner).

  -- The status of a renewal's valid_until on a Lagos date (null valid_until: no renewal).
  create function identity.staff_licence_status_of(requested_valid_until date, requested_as_of date)
  returns text
  language sql
  immutable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select case when requested_valid_until is null then 'not_recorded'
                when requested_valid_until < requested_as_of then 'expired'
                when requested_valid_until - requested_as_of <= 30 then 'expiring_30'
                when requested_valid_until - requested_as_of <= 60 then 'expiring_60'
                else 'valid' end
  $fn$;

  -- A renewal's answer (the contract's "renewal"), with withdrawn when it was withdrawn.
  create function identity.staff_licence_renewal_json(requested_renewal_id uuid)
  returns jsonb
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    answer jsonb;
  begin
    select jsonb_build_object(
             'renewalId', renewal.id, 'period', renewal.period, 'licenceYear', renewal.licence_year,
             'validUntil', to_char(renewal.valid_until, 'YYYY-MM-DD'), 'checkedHow', renewal.checked_how,
             'checkedOn', to_char(renewal.checked_on, 'YYYY-MM-DD'),
             'checkedByMembershipId', renewal.checked_by_membership_id,
             'checkedByName', coalesce(checker_account.display_name, checker_staff.full_name),
             'selfRecorded', renewal.self_recorded,
             'recordedAt', to_char(renewal.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'withdrawn', case when withdrawal.id is null then null else jsonb_build_object(
               'reasonCode', withdrawal.reason_code,
               'withdrawnAt', to_char(withdrawal.withdrawn_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'withdrawnByMembershipId', withdrawal.withdrawn_by_membership_id) end)
      into answer
      from identity.staff_licence_renewals renewal
      join auth.accounts checker_account on checker_account.id = renewal.checked_by_account_id
      left join identity.staff checker_staff on checker_staff.account_id = renewal.checked_by_account_id
      left join identity.staff_licence_renewal_withdrawals withdrawal on withdrawal.renewal_id = renewal.id
     where renewal.id = requested_renewal_id;
    return answer;
  end
  $fn$;

  -- One row per licensed active role of each active member of the facility (0139's rule: the latest attestation
  -- tied to the unrevoked facility grant), with the latest renewal of that licence (same facility, person and
  -- licence key) that is not withdrawn; plus one row per active member with no licensed role (role_code null).
  -- licence is the contract's licence answer (null for a member with no licensed role).
  create function identity.staff_licence_status_rows(requested_facility_id uuid, requested_as_of date)
  returns table (membership_id uuid, account_id uuid, member_name text, member_roles text[], role_code text,
    licence_body text, licence_key text, number_hint text, attestation_id uuid, renewal_id uuid, period text,
    licence_year integer, valid_until date, checked_how text, checked_on date, checked_by_membership_id uuid,
    checked_by_name text, self_recorded boolean, recorded_at timestamptz, status text, days_left integer,
    licence jsonb)
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  begin
    return query
    with members as (
      select membership.id as member_id, membership.account_id as member_account,
             coalesce(account.display_name, staff.full_name) as name,
             coalesce((select array_agg(distinct grant_row.role_code order by grant_row.role_code)
                         from auth.account_roles grant_row
                        where grant_row.membership_id = membership.id and grant_row.scope_type = 'facility'
                          and grant_row.revoked_at is null), array[]::text[]) as roles
        from identity.staff_facility_memberships membership
        join identity.staff staff on staff.id = membership.staff_id
        join auth.accounts account on account.id = membership.account_id
       where membership.facility_id = requested_facility_id and membership.active
    ),
    licensed as (
      select members.member_id, members.member_account, members.name, members.roles, grant_row.role_code as role,
             coalesce(latest.licence_body, identity.staff_role_licence_body(grant_row.role_code)) as body,
             latest.licence_key as key, latest.id as attestation,
             case when latest.licence_number is null then null
                  else identity.licence_number_hint(latest.licence_number) end as hint
        from members
        join auth.account_roles grant_row
          on grant_row.membership_id = members.member_id and grant_row.scope_type = 'facility'
         and grant_row.revoked_at is null and grant_row.facility_id = requested_facility_id
         and identity.staff_role_licence_body(grant_row.role_code) is not null
        left join lateral (
          select attestation.id, attestation.licence_body, attestation.licence_key, attestation.licence_number
            from identity.staff_licence_attestations attestation
           where attestation.role_grant_id = grant_row.id
           order by attestation.recorded_at desc, attestation.id desc
           limit 1
        ) latest on true
    ),
    with_renewal as (
      select licensed.*, current_renewal.id as renewal, current_renewal.period as renewal_period,
             current_renewal.licence_year as renewal_year, current_renewal.valid_until as renewal_valid_until,
             current_renewal.checked_how as renewal_checked_how, current_renewal.checked_on as renewal_checked_on,
             current_renewal.checked_by_membership_id as renewal_checker,
             current_renewal.self_recorded as renewal_self, current_renewal.recorded_at as renewal_recorded_at,
             case when licensed.attestation is null then 'no_licence'
                  else identity.staff_licence_status_of(current_renewal.valid_until, requested_as_of) end as state
        from licensed
        left join lateral (
          select renewal.*
            from identity.staff_licence_renewals renewal
           where licensed.attestation is not null and renewal.facility_id = requested_facility_id
             and renewal.account_id = licensed.member_account and renewal.licence_key = licensed.key
             and not exists (select 1 from identity.staff_licence_renewal_withdrawals withdrawal
                              where withdrawal.renewal_id = renewal.id)
           order by renewal.recorded_at desc, renewal.id desc
           limit 1
        ) current_renewal on true
    )
    select with_renewal.member_id, with_renewal.member_account, with_renewal.name, with_renewal.roles,
           with_renewal.role, with_renewal.body, with_renewal.key, with_renewal.hint, with_renewal.attestation,
           with_renewal.renewal, with_renewal.renewal_period, with_renewal.renewal_year,
           with_renewal.renewal_valid_until, with_renewal.renewal_checked_how, with_renewal.renewal_checked_on,
           with_renewal.renewal_checker,
           case when with_renewal.renewal is null then null
                else (identity.staff_licence_renewal_json(with_renewal.renewal))->>'checkedByName' end,
           with_renewal.renewal_self, with_renewal.renewal_recorded_at, with_renewal.state,
           with_renewal.renewal_valid_until - requested_as_of,
           jsonb_build_object('role', with_renewal.role, 'body', with_renewal.body, 'numberHint', with_renewal.hint,
             'status', with_renewal.state, 'validUntil', to_char(with_renewal.renewal_valid_until, 'YYYY-MM-DD'),
             'daysLeft', with_renewal.renewal_valid_until - requested_as_of,
             'renewal', case when with_renewal.renewal is null then null
                             else identity.staff_licence_renewal_json(with_renewal.renewal) - 'withdrawn' end)
      from with_renewal
    union all
    select members.member_id, members.member_account, members.name, members.roles, null::text, null::text,
           null::text, null::text, null::uuid, null::uuid, null::text, null::integer, null::date, null::text,
           null::date, null::uuid, null::text, null::boolean, null::timestamptz, null::text, null::integer,
           null::jsonb
      from members
     where not exists (select 1 from licensed where licensed.member_id = members.member_id);
  end
  $fn$;

  -- One audit row, as the staff actor, in the request's transaction.
  create function identity.staff_licence_audit(requested_subject text, requested_account uuid,
    requested_membership uuid, requested_organization uuid, requested_facility uuid, requested_correlation text,
    requested_action text, requested_outcome text, requested_resource_type text, requested_resource_id text,
    requested_details jsonb)
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

  -- Route 1: the list. Every active member's licensed roles with their status, and the counts.
  create function identity.staff_licence_status_list()
  returns table (membership_id uuid, member_name text, member_roles text[], is_self boolean, role_code text,
    status text, licence jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    as_of date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    counted jsonb;
  begin
    select * into actor from identity.staff_management_actor(false);
    select jsonb_build_object(
             'members', count(distinct row_value.membership_id),
             'licences', count(row_value.role_code),
             'expired', count(*) filter (where row_value.status = 'expired'),
             'expiring30', count(*) filter (where row_value.status = 'expiring_30'),
             'expiring60', count(*) filter (where row_value.status = 'expiring_60'))
      into counted
      from identity.staff_licence_status_rows(actor.facility_id, as_of) row_value;
    perform identity.staff_licence_audit(platform.current_actor_subject(), actor.account_id, actor.membership_id,
      actor.organization_id, actor.facility_id, platform.current_correlation_id(), 'identity.staff-licence.list',
      'success', 'facility', actor.facility_id::text, counted);
    return query
      select row_value.membership_id, row_value.member_name, row_value.member_roles,
             row_value.membership_id = actor.membership_id, row_value.role_code, row_value.status, row_value.licence
        from identity.staff_licence_status_rows(actor.facility_id, as_of) row_value
       order by row_value.member_name, row_value.membership_id, row_value.role_code;
  end
  $fn$;

  -- Route 2: one member, each licence with every renewal of it (newest first; withdrawn ones marked).
  create function identity.staff_licence_member_read(requested_membership_id uuid)
  returns table (outcome text, member jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    as_of date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    answer jsonb;
  begin
    select * into actor from identity.staff_management_actor(false);
    select jsonb_build_object(
             'membershipId', first_row.membership_id, 'name', first_row.member_name,
             'roles', to_jsonb(first_row.member_roles), 'isSelf', first_row.membership_id = actor.membership_id,
             'licences', coalesce((
               select jsonb_agg(row_value.licence || jsonb_build_object('renewals', coalesce((
                        select jsonb_agg(identity.staff_licence_renewal_json(renewal.id)
                                         order by renewal.recorded_at desc, renewal.id desc)
                          from identity.staff_licence_renewals renewal
                         where renewal.facility_id = actor.facility_id and renewal.account_id = row_value.account_id
                           and renewal.licence_key = row_value.licence_key), '[]'::jsonb))
                        order by row_value.role_code)
                 from identity.staff_licence_status_rows(actor.facility_id, as_of) row_value
                where row_value.membership_id = first_row.membership_id and row_value.role_code is not null),
               '[]'::jsonb))
      into answer
      from (select row_value.membership_id, row_value.member_name, row_value.member_roles
              from identity.staff_licence_status_rows(actor.facility_id, as_of) row_value
             where row_value.membership_id = requested_membership_id
             limit 1) first_row;
    if answer is null then
      perform identity.staff_licence_audit(platform.current_actor_subject(), actor.account_id, actor.membership_id,
        actor.organization_id, actor.facility_id, platform.current_correlation_id(),
        'identity.staff-licence.member-read', 'failure', 'facility-membership', requested_membership_id::text,
        jsonb_build_object('outcome', 'not_found'));
      outcome := 'not_found';
      return next;
      return;
    end if;
    perform identity.staff_licence_audit(platform.current_actor_subject(), actor.account_id, actor.membership_id,
      actor.organization_id, actor.facility_id, platform.current_correlation_id(),
      'identity.staff-licence.member-read', 'success', 'facility-membership', requested_membership_id::text,
      jsonb_build_object('licences', jsonb_array_length(answer->'licences')));
    outcome := 'found';
    member := answer;
    return next;
  end
  $fn$;

  -- Route 3: the export's rows, one per licence (members with no licensed role are left out). The number's last
  -- 4 characters only (Q-ROS-12 A). identity-api writes the CSV (words, Lagos dates, formula-safe cells).
  create function identity.staff_licence_export_rows()
  returns table (member_name text, member_roles text[], licence_body text, number_hint text, status text,
    valid_until date, checked_how text, checked_on date, checked_by_name text, self_recorded boolean, as_of date)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    counted jsonb;
  begin
    select * into actor from identity.staff_management_actor(false);
    select jsonb_build_object('rows', count(*),
             'expired', count(*) filter (where row_value.status = 'expired'),
             'expiring30', count(*) filter (where row_value.status = 'expiring_30'),
             'expiring60', count(*) filter (where row_value.status = 'expiring_60'))
      into counted
      from identity.staff_licence_status_rows(actor.facility_id, today) row_value
     where row_value.role_code is not null;
    perform identity.staff_licence_audit(platform.current_actor_subject(), actor.account_id, actor.membership_id,
      actor.organization_id, actor.facility_id, platform.current_correlation_id(), 'identity.staff-licence.export',
      'success', 'facility', actor.facility_id::text, counted);
    return query
      select row_value.member_name, row_value.member_roles, row_value.licence_body, row_value.number_hint,
             row_value.status, row_value.valid_until, row_value.checked_how, row_value.checked_on,
             row_value.checked_by_name, row_value.self_recorded, today
        from identity.staff_licence_status_rows(actor.facility_id, today) row_value
       where row_value.role_code is not null
       order by case row_value.status when 'expired' then 0 when 'expiring_30' then 1 when 'expiring_60' then 2
                  when 'not_recorded' then 3 when 'no_licence' then 4 else 5 end,
                row_value.member_name, row_value.membership_id, row_value.role_code;
  end
  $fn$;

  -- Route 4: record a renewal. Outcomes: recorded (replayed for the same Idempotency-Key and request),
  -- review_pending, not_found, licence_not_on_record, dates_invalid, key_reused.
  create function identity.staff_licence_renewal_record(requested_membership_id uuid, requested_role text,
    requested_period text, requested_licence_year integer, requested_valid_until date, requested_checked_how text,
    requested_checked_on date, requested_attestation_version text, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, renewal jsonb, licence jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    found_renewal identity.staff_licence_renewals%rowtype;
    target record;
    refusal text;
    new_id uuid;
    new_valid_until date;
  begin
    select * into actor from identity.staff_management_actor(true);
    if requested_membership_id is null
       or requested_role is null or requested_role not in ('doctor', 'nurse', 'lab', 'pharmacist')
       or requested_period is null or requested_period not in ('licence_year', 'expiry_date')
       or (requested_period = 'licence_year' and (requested_licence_year is null or requested_valid_until is not null))
       or (requested_period = 'expiry_date' and (requested_valid_until is null or requested_licence_year is not null))
       or requested_checked_how is null
       or requested_checked_how not in ('regulator_register', 'certificate_seen', 'in_person')
       or requested_checked_on is null
       or requested_attestation_version is distinct from 'facility-licence-renewal-v1'
       or requested_idempotency_key is null
       or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'LICENCE_RENEWAL_INVALID';
    end if;
    -- The Idempotency-Key, per membership, across both tables of this file.
    perform pg_advisory_xact_lock(hashtextextended(
      'staff-licence-key:' || actor.membership_id::text || ':' || requested_idempotency_key, 0));
    select renewal.* into found_renewal from identity.staff_licence_renewals renewal
     where renewal.checked_by_membership_id = actor.membership_id
       and renewal.idempotency_key = requested_idempotency_key;
    if found then
      if found_renewal.request_sha256 = requested_request_sha256 then
        perform identity.staff_licence_audit(platform.current_actor_subject(), actor.account_id, actor.membership_id,
          actor.organization_id, actor.facility_id, platform.current_correlation_id(),
          'identity.staff-licence.renewal-record', 'success', 'staff-licence-renewal', found_renewal.id::text,
          jsonb_build_object('replayed', true));
        return query select 'recorded', true, identity.staff_licence_renewal_json(found_renewal.id) - 'withdrawn',
          (select row_value.licence from identity.staff_licence_status_rows(actor.facility_id, today) row_value
            where row_value.membership_id = found_renewal.membership_id
              and row_value.role_code = found_renewal.role_code limit 1);
        return;
      end if;
      refusal := 'key_reused';
    elsif exists (select 1 from identity.staff_licence_renewal_withdrawals withdrawal
                   where withdrawal.withdrawn_by_membership_id = actor.membership_id
                     and withdrawal.idempotency_key = requested_idempotency_key) then
      refusal := 'key_reused';
    elsif actor.review_state <> 'reviewed' then
      refusal := 'review_pending';
    end if;
    if refusal is null then
      if not exists (select 1 from identity.staff_facility_memberships membership
                      where membership.id = requested_membership_id and membership.facility_id = actor.facility_id
                        and membership.active) then
        refusal := 'not_found';
      else
        -- The role held now, with the licence SX-4 shows for it.
        select row_value.membership_id, row_value.account_id, row_value.attestation_id, row_value.licence_body,
               row_value.licence_key
          into target
          from identity.staff_licence_status_rows(actor.facility_id, today) row_value
         where row_value.membership_id = requested_membership_id and row_value.role_code = requested_role
         limit 1;
        if not found or target.attestation_id is null then
          refusal := 'licence_not_on_record';
        end if;
      end if;
    end if;
    if refusal is null then
      new_valid_until := case when requested_period = 'licence_year' then make_date(requested_licence_year, 12, 31)
                              else requested_valid_until end;
      if (requested_period = 'licence_year'
          and requested_licence_year not between extract(year from today)::integer - 1
                                             and extract(year from today)::integer + 3)
         or (requested_period = 'expiry_date'
             and (requested_valid_until < today - 400 or requested_valid_until > (today + interval '5 years')::date))
         or requested_checked_on > today or requested_checked_on < today - 90 then
        refusal := 'dates_invalid';
      end if;
    end if;
    if refusal is not null then
      perform identity.staff_licence_audit(platform.current_actor_subject(), actor.account_id, actor.membership_id,
        actor.organization_id, actor.facility_id, platform.current_correlation_id(),
        'identity.staff-licence.renewal-record',
        case when refusal in ('review_pending', 'key_reused') then 'denied' else 'failure' end,
        'facility-membership', requested_membership_id::text, jsonb_build_object('refusal', refusal));
      return query select refusal, false, null::jsonb, null::jsonb;
      return;
    end if;
    insert into identity.staff_licence_renewals (organization_id, facility_id, membership_id, account_id,
      attestation_id, role_code, licence_body, licence_key, period, licence_year, valid_until, checked_how,
      checked_on, checked_by_account_id, checked_by_membership_id, self_recorded, attestation_version,
      idempotency_key, request_sha256, correlation_id)
    values (actor.organization_id, actor.facility_id, target.membership_id, target.account_id,
      target.attestation_id, requested_role, target.licence_body, target.licence_key, requested_period,
      case when requested_period = 'licence_year' then requested_licence_year end, new_valid_until,
      requested_checked_how, requested_checked_on, actor.account_id, actor.membership_id,
      actor.account_id = target.account_id, requested_attestation_version, requested_idempotency_key,
      requested_request_sha256, platform.current_correlation_id())
    returning id into new_id;
    perform identity.staff_licence_audit(platform.current_actor_subject(), actor.account_id, actor.membership_id,
      actor.organization_id, actor.facility_id, platform.current_correlation_id(),
      'identity.staff-licence.renewal-record', 'success', 'staff-licence-renewal', new_id::text,
      jsonb_build_object('membershipId', target.membership_id, 'role', requested_role, 'period', requested_period,
        'checkedHow', requested_checked_how, 'selfRecorded', actor.account_id = target.account_id));
    return query select 'recorded', false, identity.staff_licence_renewal_json(new_id) - 'withdrawn',
      (select row_value.licence from identity.staff_licence_status_rows(actor.facility_id, today) row_value
        where row_value.membership_id = target.membership_id and row_value.role_code = requested_role limit 1);
  end
  $fn$;

  -- Route 5: withdraw a renewal entered by mistake. Outcomes: withdrawn (replayed), review_pending, not_found,
  -- already_withdrawn, key_reused. The answer's licence is the member's licence of that role now (null when the
  -- member no longer holds the role).
  create function identity.staff_licence_renewal_withdraw(requested_renewal_id uuid, requested_reason_code text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, licence jsonb)
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor record;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    found_withdrawal identity.staff_licence_renewal_withdrawals%rowtype;
    target identity.staff_licence_renewals%rowtype;
    refusal text;
  begin
    select * into actor from identity.staff_management_actor(true);
    if requested_renewal_id is null or requested_reason_code is null
       or requested_reason_code not in ('wrong_member', 'wrong_dates', 'wrong_licence', 'other')
       or requested_idempotency_key is null
       or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'LICENCE_RENEWAL_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
      'staff-licence-key:' || actor.membership_id::text || ':' || requested_idempotency_key, 0));
    select withdrawal.* into found_withdrawal from identity.staff_licence_renewal_withdrawals withdrawal
     where withdrawal.withdrawn_by_membership_id = actor.membership_id
       and withdrawal.idempotency_key = requested_idempotency_key;
    if found then
      if found_withdrawal.request_sha256 = requested_request_sha256 then
        select renewal.* into target from identity.staff_licence_renewals renewal
         where renewal.id = found_withdrawal.renewal_id;
        perform identity.staff_licence_audit(platform.current_actor_subject(), actor.account_id, actor.membership_id,
          actor.organization_id, actor.facility_id, platform.current_correlation_id(),
          'identity.staff-licence.renewal-withdraw', 'success', 'staff-licence-renewal', target.id::text,
          jsonb_build_object('replayed', true));
        return query select 'withdrawn', true,
          (select row_value.licence from identity.staff_licence_status_rows(actor.facility_id, today) row_value
            where row_value.membership_id = target.membership_id and row_value.role_code = target.role_code limit 1);
        return;
      end if;
      refusal := 'key_reused';
    elsif exists (select 1 from identity.staff_licence_renewals renewal
                   where renewal.checked_by_membership_id = actor.membership_id
                     and renewal.idempotency_key = requested_idempotency_key) then
      refusal := 'key_reused';
    elsif actor.review_state <> 'reviewed' then
      refusal := 'review_pending';
    end if;
    if refusal is null then
      -- The renewal row is locked, so two withdrawals of one renewal never both pass.
      select renewal.* into target from identity.staff_licence_renewals renewal
       where renewal.id = requested_renewal_id and renewal.facility_id = actor.facility_id
       for update;
      if not found then
        refusal := 'not_found';
      elsif exists (select 1 from identity.staff_licence_renewal_withdrawals withdrawal
                     where withdrawal.renewal_id = target.id) then
        refusal := 'already_withdrawn';
      end if;
    end if;
    if refusal is not null then
      perform identity.staff_licence_audit(platform.current_actor_subject(), actor.account_id, actor.membership_id,
        actor.organization_id, actor.facility_id, platform.current_correlation_id(),
        'identity.staff-licence.renewal-withdraw',
        case when refusal in ('review_pending', 'key_reused') then 'denied' else 'failure' end,
        'staff-licence-renewal', requested_renewal_id::text, jsonb_build_object('refusal', refusal));
      return query select refusal, false, null::jsonb;
      return;
    end if;
    insert into identity.staff_licence_renewal_withdrawals (renewal_id, facility_id, reason_code,
      withdrawn_by_account_id, withdrawn_by_membership_id, idempotency_key, request_sha256, correlation_id)
    values (target.id, actor.facility_id, requested_reason_code, actor.account_id, actor.membership_id,
      requested_idempotency_key, requested_request_sha256, platform.current_correlation_id());
    perform identity.staff_licence_audit(platform.current_actor_subject(), actor.account_id, actor.membership_id,
      actor.organization_id, actor.facility_id, platform.current_correlation_id(),
      'identity.staff-licence.renewal-withdraw', 'success', 'staff-licence-renewal', target.id::text,
      jsonb_build_object('reasonCode', requested_reason_code));
    return query select 'withdrawn', false,
      (select row_value.licence from identity.staff_licence_status_rows(actor.facility_id, today) row_value
        where row_value.membership_id = target.membership_id and row_value.role_code = target.role_code limit 1);
  end
  $fn$;

  comment on function identity.staff_licence_status_list() is
    '0199 (ROS-1): the facility administrator''s licence list: every active member with each licensed role''s licence and status (valid, expiring_60, expiring_30, expired, not_recorded, no_licence) as of today in Lagos. A warning only (Q243 A). Admitted by 0086''s identity.staff_management_actor. Audited (identity.staff-licence.list, counts only).';
  comment on function identity.staff_licence_member_read(uuid) is
    '0199 (ROS-1): one member''s licences, each with every renewal (withdrawn ones marked). Outcomes found, not_found. Audited (identity.staff-licence.member-read).';
  comment on function identity.staff_licence_export_rows() is
    '0199 (ROS-1): the licence check export''s rows (the last 4 characters of each number only, Q-ROS-12 A). Audited (identity.staff-licence.export, counts only, never a name).';
  comment on function identity.staff_licence_renewal_record(uuid, text, text, integer, date, text, date, text, text, text) is
    '0199 (ROS-1, Q247 A): record a renewal of a member''s licence of a held licensed role, after support''s review. Outcomes recorded (replayed), review_pending, not_found, licence_not_on_record, dates_invalid, key_reused. Audited (identity.staff-licence.renewal-record).';
  comment on function identity.staff_licence_renewal_withdraw(uuid, text, text, text) is
    '0199 (ROS-1, Q-ROS-15 A): withdraw a renewal entered by mistake, with a reason code. Outcomes withdrawn (replayed), review_pending, not_found, already_withdrawn, key_reused. Audited (identity.staff-licence.renewal-withdraw).';

  -- Grants: EXECUTE for hid_identity_runtime on the five definers only (here and in runtime-grants.sql).
  revoke all on function identity.staff_licence_status_of(date, date), identity.staff_licence_renewal_json(uuid),
    identity.staff_licence_status_rows(uuid, date),
    identity.staff_licence_audit(text, uuid, uuid, uuid, uuid, text, text, text, text, text, jsonb),
    identity.staff_licence_status_list(), identity.staff_licence_member_read(uuid),
    identity.staff_licence_export_rows(),
    identity.staff_licence_renewal_record(uuid, text, text, integer, date, text, date, text, text, text),
    identity.staff_licence_renewal_withdraw(uuid, text, text, text) from public;
  if v_runtime then
    grant execute on function identity.staff_licence_status_list(), identity.staff_licence_member_read(uuid),
      identity.staff_licence_export_rows(),
      identity.staff_licence_renewal_record(uuid, text, text, integer, date, text, date, text, text, text),
      identity.staff_licence_renewal_withdraw(uuid, text, text, text) to hid_identity_runtime;
  end if;

  -- 3. Post-checks.
  -- Tables: the owner, row-level security enabled and forced, exactly the four owner command policies, no
  -- privilege for any other role, no identity column or column default from a sequence.
  if (select count(*) from pg_class relation
       where relation.oid = any (array['identity.staff_licence_renewals'::regclass,
                                        'identity.staff_licence_renewal_withdrawals'::regclass])
         and relation.relowner = v_owner and relation.relrowsecurity and relation.relforcerowsecurity) <> 2
     or exists (select 1 from pg_class relation,
                  lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                 where relation.oid = any (array['identity.staff_licence_renewals'::regclass,
                                                  'identity.staff_licence_renewal_withdrawals'::regclass])
                   and acl.grantee <> relation.relowner)
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid = any (array['identity.staff_licence_renewals'::regclass,
                                                  'identity.staff_licence_renewal_withdrawals'::regclass])
            and policy_row.polpermissive and policy_row.polroles = array[0::oid]
            and ((policy_row.polcmd = 'r' and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'true'
                  and policy_row.polwithcheck is null)
              or (policy_row.polcmd = 'a' and policy_row.polqual is null
                  and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = 'true')
              or (policy_row.polcmd = 'w' and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'true'
                  and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = 'true')
              or (policy_row.polcmd = 'd' and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'true'
                  and policy_row.polwithcheck is null))) <> 8
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid = any (array['identity.staff_licence_renewals'::regclass,
                                                  'identity.staff_licence_renewal_withdrawals'::regclass])) <> 8
     or exists (select 1 from pg_attribute attribute_row
                 left join pg_attrdef default_row on default_row.adrelid = attribute_row.attrelid
                       and default_row.adnum = attribute_row.attnum
                 where attribute_row.attrelid = any (array['identity.staff_licence_renewals'::regclass,
                                                            'identity.staff_licence_renewal_withdrawals'::regclass])
                   and attribute_row.attnum > 0
                   and (attribute_row.attidentity <> ''
                        or pg_get_expr(default_row.adbin, default_row.adrelid) like '%nextval%')) then
    raise exception using errcode = '55000', message = '0199: post-check failed (the tables'' owner, row-level security, '
      || 'policies or privileges)';
  end if;
  -- Triggers: each one's events (tgtype), no WHEN condition (tgqual), no column list (tgattr), no arguments
  -- (tgnargs), platform.reject_mutation() (tgfoid), enabled (tgenabled); and no other trigger on the tables.
  if (select count(*) from generate_subscripts(v_triggers, 1) idx
        join pg_trigger trigger_row on trigger_row.tgrelid = v_triggers[idx][1]::regclass
                                   and trigger_row.tgname = v_triggers[idx][2]
       where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
         and trigger_row.tgtype = v_triggers[idx][3]::smallint and trigger_row.tgqual is null
         and trigger_row.tgattr = ''::int2vector and trigger_row.tgnargs = 0
         and trigger_row.tgfoid = 'platform.reject_mutation()'::regprocedure) <> 4
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = any (array['identity.staff_licence_renewals'::regclass,
                                                  'identity.staff_licence_renewal_withdrawals'::regclass])
            and not trigger_row.tgisinternal) <> 4 then
    raise exception using errcode = '55000', message = '0199: post-check failed (the append-only triggers)';
  end if;
  -- Functions: the owner, SECURITY DEFINER for the five routes only, the fixed search_path, EXECUTE for
  -- hid_identity_runtime on the five routes only (never PUBLIC), and each body as reviewed (its md5).
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
      message = '0199: post-check failed (these functions are not as reviewed: ' || coalesce(v_mismatch, 'an extra one')
        || ')';
  end if;
  if not exists (select 1 from identity.staff_attestation_texts
                  where version = 'facility-licence-renewal-v1' and text = v_text) then
    raise exception using errcode = '55000', message = '0199: post-check failed (the attestation text)';
  end if;

  raise notice '0199: licence renewals are installed (2 append-only tables, 9 functions, the text facility-licence-renewal-v1). identity-api''s HR_CREDENTIALS_ENABLED keeps the routes closed until the go-live.';
end
$hr0199$;
