-- 0119 OCR learning rules (learning phase 2, part 2 of 2; Session B). Owner
-- decision Q43 of 2026-11-11 and the coordinator's answers of the same day
-- (see 0118): a correction rule switches on by itself, with no approver, only
-- after at least 5 identical corrections from at least 3 different staff and
-- no conflicting correction (a facility rule: at that facility; a platform
-- rule: across facilities combined, from at least 2 facilities); it is shown
-- as a suggestion only ("Possibly X? Check the paper"), the saved value never
-- changes; it retires itself when staff did not take it in 3 of its last 10
-- showings, and re-arms only from evidence dated after its retirement; each
-- rule set (the platform's, and each facility's) has an owner kill switch, on
-- by default; an item saved unchanged is neither support nor conflict. Also
-- the platform-wide review-outcome summary that phase 1 left for this
-- migration (aggregate only, suppressed in SQL). It needs 0118. The
-- declaration is signed separately (reviewed_by is empty until the owner
-- signs). Provisional number: it gets the next free number at merge.
--
-- 1. Tables (no runtime role has any privilege on them; row-level security is
--    on and forced with one policy for the OCR functions' owner, as 0107;
--    nothing from a page: a digest, a closed-list value, codes and counts):
--    - ocr.learning_rules (id; scope facility | platform; facility_id (NULL
--      exactly for platform); field_class and read_digest as 0118;
--      suggest_value (0118's constraint, NOT NULL); status active | retired;
--      activated_at; retired_at (NULL exactly while active); the evidence at
--      activation: supporting_corrections, supporting_staff,
--      supporting_facilities). At most one active rule per scope, facility
--      and key (a partial unique index).
--    - ocr.learning_rule_showings (rule_id -> learning_rules, validation_key
--      (the validation id's HMAC under 0118's key), facility_id ->
--      identity.facilities, outcome accepted | rejected, shown_at; unique
--      (rule_id, validation_key)). Kept 180 days.
--    - ocr.learning_switches (scope facility | platform, facility_id (NULL
--      exactly for platform), enabled, reason, set_by_account_id, set_at;
--      unique per scope and facility). No row: on.
--    - ocr.quality_summary_runs (transaction_id xid8 primary key,
--      started_at): a platform quality-summary read in progress. Only
--      ocr.review_outcome_summary writes it, one row for its own transaction,
--      inserted just before its read of ocr.validations and deleted just
--      after; so no row outlives that read (a rollback removes it too).
--    And one SELECT policy on ocr.validations,
--    ocr_validations_quality_summary, for the OCR functions' owner only
--    (TO that role): a row is visible while this transaction holds a summary
--    run. ocr.validations forces row-level security and its staff policy
--    admits only the session facility's rows, so without it the platform
--    summary, which runs as that owner in a platform session (no facility),
--    read nothing where the owner is neither superuser nor BYPASSRLS, as in
--    production (review of 2026-11-12, the same class as 0110). Every other
--    function of that owner still reads only the session facility's rows:
--    no other function writes a run row.
-- 2. Functions (SECURITY DEFINER, search_path pinned, owned by the OCR
--    functions' owner, EXECUTE revoked from PUBLIC):
--    - ocr.learning_evaluate(field, digest): the switch-on reckoning for one
--      key, facility rules then the platform rule (SECURITY INVOKER, granted
--      to no role; called only by learning_after_validation as the owner).
--      Evidence: the key's 0118 observations of the last 180 days and after
--      the latest retirement of a rule of that scope (and facility) and key.
--      A rule is made when there is no active one, the evidence has no
--      conflict (no NULL suggest_value, one value only), at least 5
--      corrections, at least 3 staff keys and, for the platform, at least 2
--      facilities.
--    - ocr.learning_after_validation(validation, showings jsonb) -> jsonb
--      ({showings, retired, activated}), for ocr-api (hid_ocr_runtime): the
--      record command's session and validation checks (0118); showings a JSON
--      array of at most 200 {ruleId, outcome (accepted | rejected), field,
--      readDigest}, each a rule of this facility or the platform whose own
--      key is that field and read digest (the item it was shown on, which
--      ocr-api computes from the reviewed reading; else 22023, nothing
--      written), so no showing can name a rule the reading never had. Records
--      them (a replay adds nothing), retires each rule shown whose last 10
--      showings hold at least 3 rejected, then evaluates each key the
--      validation observed (0118), under a transaction advisory lock per key
--      (and per rule for the showings, so concurrent showings count in turn).
--      ocr-api calls it in its own READ COMMITTED transaction after the
--      validation committed. Deletes up to 1000 showings older than 180 days.
--    - ocr.purge_learning_showings(limit 1-100000) -> integer, for the OCR
--      worker (an account holding ocr_worker): showings older than 180 days,
--      with the 7-day sweep.
--    - ocr.reading_suggestions(keys jsonb) -> table (field_class, read_digest
--      hex as the caller sent it (rules are stored under its HMAC, 0118),
--      rule_id, scope, suggest_value), for ocr-api (hid_ocr_runtime): a
--      session naming a facility and an active membership there holding
--      ocr.job.read; keys a JSON array of at most 500 {field, readDigest}
--      (else 22023). For each key the facility's active rule, else the
--      platform's. The platform switch off hides the platform's rules
--      everywhere; a facility's switch off hides every suggestion at that
--      facility, the platform's included (coordinator, 2026-11-11: off means
--      off for the people there). A switch stops suggestions only: evidence
--      still accrues and rules still switch on.
--    - ocr.set_learning_switch(scope, facility, enabled, reason) -> void, for
--      the Identity API (hid_identity_runtime): a platform super admin in a
--      platform session with a correlation id and healthcare-operations, as
--      0107's ocr.set_facility_page_limit; reason 1-240 characters; one
--      platform audit row admin.ocr.learning-switch.set.
--    - ocr.learning_overview() -> table (scope, facility_id, enabled,
--      active_rules, retired_rules, showings_180d, rejected_180d), for the
--      Identity API: platform.admin.access in a platform session. Counts
--      only, every facility with a rule or a switch, and the platform.
--    - ocr.review_outcome_summary(from, to) -> table (group_type, week,
--      facility_id, kind, prompt_version, measure, value), for the Identity
--      API: platform.admin.access and platform.operations.read in a platform
--      session with a correlation id; from <= to, at most 104 days (the 92 a
--      caller may ask for, widened to whole ISO weeks). Sums the stored
--      phase-1 review outcomes (ocr.validations.provenance.reviewOutcome,
--      schema hid.ocr.review-outcome/v1) of at most 50000 validations: item
--      rows per ISO week, facility, kind, prompt version and decision; review
--      rows (reviews, validated, rejected, estimated, summary_failed) per ISO
--      week, facility and prompt version. A group under 20 items (reviews)
--      is one row with measure 'suppressed' and value 0. Codes outside
--      ^[a-z][a-z0-9_]{0,63}$ count as 'other'. One platform audit row
--      admin.ocr.quality-summary.read with the range and counts. It reads
--      every facility's validations inside a summary run (section 1).
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0118 applied (its two command bodies by md5);
--    not applied yet; md5 of the bodies relied on (session helpers,
--    auth.membership_has_permission, auth.account_has_platform_permission,
--    audit.authorize_platform_event, as 0107 pins them); 0064's three audit
--    constraints and its authority trigger (as 0107 checks them); the
--    permissions ocr.job.read, ocr.validation.write, platform.admin.access,
--    platform.operations.read and the role platform_super_admin; the runtime
--    roles hid_ocr_runtime, hid_ocr_api_runtime (a member of it) and
--    hid_identity_runtime and hid_ocr_worker, where they exist, neither
--    superuser nor BYPASSRLS;
--    the 0118 tables and ocr.jobs share one owner, which may create in schema
--    ocr; the applier is it or a member that inherits it and may SET ROLE.
-- 3. Owners, policies, REVOKE FROM PUBLIC and grants (here when the roles
--    exist, and in runtime-grants.sql, which gains the same 0119 block).
-- 4. Post-checks: attributes, owners, ACLs, row-level security.
--
-- Locks: beyond ACCESS SHARE, only the four new tables and their indexes,
-- SHARE ROW EXCLUSIVE on identity.facilities (the foreign keys) and, for the
-- new policy, ACCESS EXCLUSIVE on ocr.validations, taken NOWAIT every 10 ms
-- for at most 5 seconds (else 55P03, nothing applied) just before the policy
-- and held to the end of this migration's transaction; no row of an
-- existing table is read or written.
--
-- Old services on this schema: nothing existing changes; today's ocr-api and
-- identity-api images never call the new functions (no suggestion is shown,
-- no rule is evaluated). Applied migrations are immutable.

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
  ocr_owner oid;
begin
  -- a. 0118 applied (its two command bodies are the marker).
  if to_regclass('ocr.correction_observations') is null or to_regclass('ocr.learning_key') is null
     or (select md5(prosrc) from pg_proc
          where oid = to_regprocedure('ocr.record_correction_observations(uuid,jsonb)'))
        is distinct from '911db547172c01a416044e1b5cd545a9'
     or (select md5(prosrc) from pg_proc
          where oid = to_regprocedure('ocr.purge_correction_observations(integer)'))
        is distinct from '496b287474cd30e3a0eeca5ff24ce7ca'
     or to_regclass('audit.events') is null then
    raise exception using errcode = '55000', message = '0119: 0118 must be applied first';
  end if;
  -- b. Not applied yet (nor partly present).
  if to_regclass('ocr.learning_rules') is not null
     or to_regclass('ocr.learning_rule_showings') is not null
     or to_regclass('ocr.learning_switches') is not null
     or to_regclass('ocr.quality_summary_runs') is not null
     or to_regprocedure('ocr.learning_evaluate(text,bytea)') is not null
     or to_regprocedure('ocr.learning_after_validation(uuid,jsonb)') is not null
     or to_regprocedure('ocr.reading_suggestions(jsonb)') is not null
     or to_regprocedure('ocr.set_learning_switch(text,uuid,boolean,text)') is not null
     or to_regprocedure('ocr.learning_overview()') is not null
     or to_regprocedure('ocr.review_outcome_summary(date,date)') is not null
     or to_regprocedure('ocr.purge_learning_showings(integer)') is not null then
    raise exception using errcode = '55000', message = '0119: already applied';
  end if;
  -- c. The bodies relied on.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('auth.account_has_platform_permission(uuid,text)', '2145c72b864abf1b69d23d96265e5ba7'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('auth.account_has_active_role(uuid,text)', 'a3310b48da6ff8bcd3ecb9d7dbef900a'),
      ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- 0064's audit rules the platform rows must satisfy (as 0107).
  if mismatch is null
     and (select count(*) from pg_constraint constraint_row
           where constraint_row.conrelid = 'audit.events'::regclass and constraint_row.contype = 'c'
             and constraint_row.convalidated
             and (constraint_row.conname, md5(pg_get_constraintdef(constraint_row.oid))) in (
               ('audit_actor_type_ck', 'd630642d19ec60d7d0cfab2d90533dba'),
               ('audit_actor_facility_ck', 'd74856f4b11b9e7e378d1a586f3a284b'),
               ('audit_platform_scope_ck', 'bc5f610696515dc7475eadde912e0a30'))) <> 3 then
    mismatch := 'the audit.events constraints audit_actor_type_ck, audit_actor_facility_ck, audit_platform_scope_ck';
  end if;
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'audit.events'::regclass
             and trigger_row.tgname = 'audit_platform_authority' and trigger_row.tgenabled = 'O'
             and pg_get_triggerdef(trigger_row.oid) =
               'CREATE TRIGGER audit_platform_authority BEFORE INSERT ON audit.events '
               || 'FOR EACH ROW EXECUTE FUNCTION audit.authorize_platform_event()') <> 1 then
    mismatch := 'the trigger audit_platform_authority';
  end if;
  if mismatch is null
     and ((select count(*) from auth.permissions where code in ('ocr.job.read', 'ocr.validation.write',
            'platform.admin.access', 'platform.operations.read')) <> 4
       or not exists (select 1 from auth.roles where code = 'platform_super_admin')) then
    mismatch := 'the permissions ocr.job.read, ocr.validation.write, platform.admin.access, '
      || 'platform.operations.read or the role platform_super_admin';
  end if;
  if mismatch is null then
    select string_agg(role_row.rolname, ', ') into mismatch
      from pg_roles role_row
     where role_row.rolname in ('hid_ocr_runtime', 'hid_ocr_api_runtime', 'hid_identity_runtime', 'hid_ocr_worker')
       and (role_row.rolsuper or role_row.rolbypassrls);
    if mismatch is not null then mismatch := 'the runtime roles (superuser or BYPASSRLS) ' || mismatch; end if;
  end if;
  if mismatch is null
     and exists (select 1 from pg_roles where rolname = 'hid_ocr_api_runtime')
     and exists (select 1 from pg_roles where rolname = 'hid_ocr_runtime')
     and not pg_has_role('hid_ocr_api_runtime', 'hid_ocr_runtime', 'USAGE') then
    mismatch := 'hid_ocr_api_runtime must inherit hid_ocr_runtime';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0119: an object this migration relies on differs from what it expects: %s', mismatch);
  end if;
  -- ocr.validations' row-level security is 0013's: forced, and exactly its staff
  -- read and insert policies (the summary's policy is added beside them).
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'ocr.validations'::regclass)
     or (select array_agg(policy_row.polname::text || ':' || policy_row.polcmd::text || ':'
                          || policy_row.polpermissive::text || ':' || policy_row.polroles::text || ':'
                          || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '')
                          || ':' || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '')
                          order by policy_row.polname)
           from pg_policy policy_row where policy_row.polrelid = 'ocr.validations'::regclass)
        is distinct from array[
          'ocr_validations_staff:r:true:{0}:(facility_id = platform.current_facility_id()):',
          'ocr_validations_staff_insert:a:true:{0}::(facility_id = platform.current_facility_id())'] then
    raise exception using errcode = '55000',
      message = '0119: ocr.validations'' row-level security is not 0013''s';
  end if;
  -- d. One owner for ocr.jobs, ocr.validations and the 0118 tables.
  ocr_owner := (select relowner from pg_class where oid = 'ocr.jobs'::regclass);
  if exists (select 1 from pg_class where oid in ('ocr.validations'::regclass,
               'ocr.correction_observations'::regclass, 'ocr.learning_key'::regclass) and relowner <> ocr_owner) then
    raise exception using errcode = '55000',
      message = '0119: ocr.jobs, ocr.validations and the 0118 tables must share one owner';
  end if;
  if not has_schema_privilege(ocr_owner, 'ocr', 'CREATE') then
    raise exception using errcode = '55000',
      message = format('0119: %s may not create in schema ocr', pg_get_userbyid(ocr_owner));
  end if;
  if applier <> ocr_owner
     and not (pg_has_role(applier, ocr_owner, 'USAGE') and pg_has_role(applier, ocr_owner, 'SET')) then
    raise exception using errcode = '42501',
      message = format('0119: %s is not %s and may not act as it (INHERIT and SET)', current_user,
        pg_get_userbyid(ocr_owner));
  end if;
  raise notice '0119: owners checked: ocr.jobs=%, applier=%', pg_get_userbyid(ocr_owner), current_user;
end;
$$;

-- 1. Tables.
create table ocr.learning_rules (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('facility', 'platform')),
  facility_id uuid references identity.facilities(id) on delete restrict,
  field_class text not null check (field_class in ('name', 'strength', 'frequency', 'test', 'unit', 'diagnosis')),
  read_digest bytea not null check (octet_length(read_digest) = 32),
  suggest_value text not null check (length(suggest_value) between 1 and 120
    and suggest_value ~ '^[A-Za-z0-9][A-Za-z0-9 .,+/%()''-]*$'),
  status text not null default 'active' check (status in ('active', 'retired')),
  activated_at timestamptz not null default clock_timestamp(),
  retired_at timestamptz,
  supporting_corrections integer not null check (supporting_corrections >= 5),
  supporting_staff integer not null check (supporting_staff >= 3),
  supporting_facilities integer not null check (supporting_facilities >= 1),
  check ((scope = 'facility') = (facility_id is not null)),
  check ((status = 'retired') = (retired_at is not null)),
  check (scope = 'facility' or supporting_facilities >= 2)
);
create unique index ocr_learning_rules_active_key on ocr.learning_rules
  (scope, coalesce(facility_id, '00000000-0000-0000-0000-000000000000'::uuid), field_class, read_digest)
  where status = 'active';
create index ocr_learning_rules_key_idx on ocr.learning_rules (field_class, read_digest);

create table ocr.learning_rule_showings (
  rule_id uuid not null references ocr.learning_rules(id) on delete restrict,
  validation_key bytea not null check (octet_length(validation_key) = 32),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  outcome text not null check (outcome in ('accepted', 'rejected')),
  shown_at timestamptz not null default clock_timestamp(),
  primary key (rule_id, validation_key)
);
create index ocr_learning_rule_showings_recent_idx on ocr.learning_rule_showings (rule_id, shown_at desc);
create index ocr_learning_rule_showings_shown_idx on ocr.learning_rule_showings (shown_at);

create table ocr.learning_switches (
  scope text not null check (scope in ('facility', 'platform')),
  facility_id uuid references identity.facilities(id) on delete restrict,
  enabled boolean not null,
  reason text not null check (length(btrim(reason)) between 1 and 240 and length(reason) <= 240),
  set_by_account_id uuid not null,
  set_at timestamptz not null default clock_timestamp(),
  check ((scope = 'facility') = (facility_id is not null))
);
create unique index ocr_learning_switches_key on ocr.learning_switches
  (scope, coalesce(facility_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- A platform quality-summary read in progress (one row per transaction, for
-- the length of that read only).
create table ocr.quality_summary_runs (
  transaction_id xid8 primary key,
  started_at timestamptz not null default clock_timestamp()
);

alter table ocr.quality_summary_runs enable row level security;
alter table ocr.quality_summary_runs force row level security;
alter table ocr.learning_rules enable row level security;
alter table ocr.learning_rules force row level security;
alter table ocr.learning_rule_showings enable row level security;
alter table ocr.learning_rule_showings force row level security;
alter table ocr.learning_switches enable row level security;
alter table ocr.learning_switches force row level security;
revoke all on ocr.learning_rules, ocr.learning_rule_showings, ocr.learning_switches, ocr.quality_summary_runs
  from public;

comment on table ocr.learning_rules is
  '0119: an OCR correction rule (key: field class and a digest of the value read; suggestion: a closed-list value). Switched on by learning_evaluate only (>= 5 identical corrections, >= 3 staff, no conflict; platform: >= 2 facilities); retired after 3 of its last 10 showings were not taken.';
comment on table ocr.learning_rule_showings is
  '0119: whether staff took a rule''s suggestion (saved value = suggestion) on one validation. Kept 180 days.';
comment on table ocr.quality_summary_runs is
  '0119: a platform quality-summary read in progress, one row for its transaction, written by ocr.review_outcome_summary just before its read of ocr.validations and deleted just after. The policy ocr_validations_quality_summary admits the OCR owner to every facility''s validations only while such a row exists.';
comment on table ocr.learning_switches is
  '0119: the owner kill switch of each rule set (the platform''s, each facility''s). No row: on.';

-- 2. Functions.
-- The switch-on reckoning for one key. Granted to no role.
create function ocr.learning_evaluate(requested_field text, requested_digest bytea)
returns integer
language plpgsql volatile
set search_path = pg_catalog, ocr, pg_temp
as $$
declare
  window_start timestamptz := clock_timestamp() - interval '180 days';
  candidate record;
  activated integer := 0;
begin
  -- Facility rules.
  for candidate in
    with evidence as (
      select observation.facility_id, observation.suggest_value, observation.staff_key
        from ocr.correction_observations observation
       where observation.field_class = requested_field and observation.read_digest = requested_digest
         and observation.observed_at > greatest(window_start, coalesce((
               select max(rule.retired_at) from ocr.learning_rules rule
                where rule.scope = 'facility' and rule.facility_id = observation.facility_id
                  and rule.field_class = requested_field and rule.read_digest = requested_digest),
               '-infinity'::timestamptz))
    )
    select evidence.facility_id, min(evidence.suggest_value) as suggest_value, count(*)::integer as corrections,
           count(distinct evidence.staff_key)::integer as staff
      from evidence
     group by evidence.facility_id
    having count(*) filter (where evidence.suggest_value is null) = 0
       and count(distinct evidence.suggest_value) = 1
       and count(*) >= 5 and count(distinct evidence.staff_key) >= 3
  loop
    if not exists (select 1 from ocr.learning_rules rule
                    where rule.status = 'active' and rule.scope = 'facility' and rule.facility_id = candidate.facility_id
                      and rule.field_class = requested_field and rule.read_digest = requested_digest) then
      insert into ocr.learning_rules (scope, facility_id, field_class, read_digest, suggest_value,
        supporting_corrections, supporting_staff, supporting_facilities)
      values ('facility', candidate.facility_id, requested_field, requested_digest, candidate.suggest_value,
        candidate.corrections, candidate.staff, 1);
      activated := activated + 1;
    end if;
  end loop;
  -- The platform rule: every facility combined.
  select min(observation.suggest_value) as suggest_value, count(*)::integer as corrections,
         count(distinct observation.staff_key)::integer as staff,
         count(distinct observation.facility_id)::integer as facilities,
         count(*) filter (where observation.suggest_value is null) as conflicts,
         count(distinct observation.suggest_value) as values_seen
    into candidate
    from ocr.correction_observations observation
   where observation.field_class = requested_field and observation.read_digest = requested_digest
     and observation.observed_at > greatest(window_start, coalesce((
           select max(rule.retired_at) from ocr.learning_rules rule
            where rule.scope = 'platform' and rule.field_class = requested_field
              and rule.read_digest = requested_digest), '-infinity'::timestamptz));
  if candidate.conflicts = 0 and candidate.values_seen = 1 and candidate.corrections >= 5 and candidate.staff >= 3
     and candidate.facilities >= 2
     and not exists (select 1 from ocr.learning_rules rule
                      where rule.status = 'active' and rule.scope = 'platform'
                        and rule.field_class = requested_field and rule.read_digest = requested_digest) then
    insert into ocr.learning_rules (scope, facility_id, field_class, read_digest, suggest_value,
      supporting_corrections, supporting_staff, supporting_facilities)
    values ('platform', null, requested_field, requested_digest, candidate.suggest_value,
      candidate.corrections, candidate.staff, candidate.facilities);
    activated := activated + 1;
  end if;
  return activated;
end
$$;

create function ocr.learning_after_validation(requested_validation_id uuid, requested_showings jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := platform.current_account_id();
  session_facility uuid := platform.current_facility_id();
  session_membership uuid := platform.current_membership_id();
  recorded integer := 0;
  retired integer := 0;
  activated integer := 0;
  shown record;
  observed record;
  keyed_validation bytea;
  learning_key bytea;
begin
  if requested_validation_id is null or actor_account is null or session_facility is null
     or session_membership is null
     or not coalesce(auth.membership_has_permission(actor_subject, session_membership, session_facility,
       'ocr.validation.write'), false) then
    raise exception using errcode = '42501', message = 'OCR validation access is required';
  end if;
  if not exists (
       select 1 from ocr.validations validation
        where validation.id = requested_validation_id and validation.facility_id = session_facility
          and validation.validated_by_membership_id = session_membership
          and validation.validated_by = actor_account and validation.disposition = 'validated'
          and validation.created_at > clock_timestamp() - interval '10 minutes') then
    raise exception using errcode = 'P0002', message = 'Validation not found';
  end if;
  select key_row.key into strict learning_key from ocr.learning_key key_row where key_row.id = 1;
  -- Each showing names its rule and that rule's own key (the field and the
  -- read digest of the reading's item it was shown on, which ocr-api computes
  -- from the reviewed reading): a showing of any other rule is refused, so a
  -- caller cannot record showings, nor retire, a rule its reading never had.
  if requested_showings is null or jsonb_typeof(requested_showings) <> 'array'
     or jsonb_array_length(requested_showings) > 200
     or exists (
       select 1 from jsonb_array_elements(requested_showings) entry
        where jsonb_typeof(entry) <> 'object'
           or (select array_agg(key order by key) from jsonb_object_keys(entry) key)
              <> array['field', 'outcome', 'readDigest', 'ruleId']
           or jsonb_typeof(entry -> 'ruleId') <> 'string'
           or entry ->> 'ruleId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or jsonb_typeof(entry -> 'outcome') <> 'string'
           or entry ->> 'outcome' not in ('accepted', 'rejected')
           or jsonb_typeof(entry -> 'field') <> 'string'
           or entry ->> 'field' not in ('name', 'strength', 'frequency', 'test', 'unit', 'diagnosis')
           or jsonb_typeof(entry -> 'readDigest') <> 'string'
           or entry ->> 'readDigest' !~ '^[0-9a-f]{64}$'
           or not exists (select 1 from ocr.learning_rules rule
                           where rule.id = (entry ->> 'ruleId')::uuid
                             and (rule.scope = 'platform' or rule.facility_id = session_facility)
                             and rule.field_class = entry ->> 'field'
                             and rule.read_digest
                                 = public.hmac(decode(entry ->> 'readDigest', 'hex'), learning_key, 'sha256'))) then
    raise exception using errcode = '22023', message = 'Invalid OCR suggestion showings';
  end if;
  keyed_validation := public.hmac(convert_to(requested_validation_id::text, 'UTF8'), learning_key, 'sha256');
  -- Showings, then retirement of each rule shown (3 of its last 10 not taken).
  for shown in
    select distinct on ((entry ->> 'ruleId')::uuid) (entry ->> 'ruleId')::uuid as rule_id, entry ->> 'outcome' as outcome
      from jsonb_array_elements(requested_showings) entry
     order by (entry ->> 'ruleId')::uuid, entry ->> 'outcome' desc
  loop
    -- One rule at a time: concurrent showings of the same rule count in turn.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hid.ocr.learning.rule:' || shown.rule_id, 0));
    insert into ocr.learning_rule_showings (rule_id, validation_key, facility_id, outcome)
    values (shown.rule_id, keyed_validation, session_facility, shown.outcome)
    on conflict (rule_id, validation_key) do nothing;
    if found then recorded := recorded + 1; end if;
    update ocr.learning_rules rule set status = 'retired', retired_at = clock_timestamp()
     where rule.id = shown.rule_id and rule.status = 'active'
       and (select count(*) filter (where recent.outcome = 'rejected')
              from (select showing.outcome from ocr.learning_rule_showings showing
                     where showing.rule_id = shown.rule_id
                     order by showing.shown_at desc, showing.validation_key limit 10) recent) >= 3;
    if found then retired := retired + 1; end if;
  end loop;
  -- Evaluation of each key this validation observed (0118).
  for observed in
    select distinct observation.field_class, observation.read_digest
      from ocr.correction_observations observation
     where observation.validation_key = keyed_validation
     order by observation.field_class, observation.read_digest
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'hid.ocr.learning:' || observed.field_class || ':' || encode(observed.read_digest, 'hex'), 0));
    activated := activated + ocr.learning_evaluate(observed.field_class, observed.read_digest);
  end loop;
  -- Retention: 180 days.
  delete from ocr.learning_rule_showings old_row
   where (old_row.rule_id, old_row.validation_key) in (
     select candidate.rule_id, candidate.validation_key from ocr.learning_rule_showings candidate
      where candidate.shown_at < clock_timestamp() - interval '180 days'
      order by candidate.shown_at limit 1000);
  return jsonb_build_object('showings', recorded, 'retired', retired, 'activated', activated);
end
$$;

create function ocr.reading_suggestions(requested_keys jsonb)
returns table (field_class text, read_digest text, rule_id uuid, scope text, suggest_value text)
language plpgsql stable security definer
set search_path = pg_catalog, ocr, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  session_facility uuid := platform.current_facility_id();
  session_membership uuid := platform.current_membership_id();
begin
  if session_facility is null or session_membership is null
     or not coalesce(auth.membership_has_permission(actor_subject, session_membership, session_facility,
       'ocr.job.read'), false) then
    raise exception using errcode = '42501', message = 'OCR job access is required';
  end if;
  if requested_keys is null or jsonb_typeof(requested_keys) <> 'array' or jsonb_array_length(requested_keys) > 500
     or exists (
       select 1 from jsonb_array_elements(requested_keys) entry
        where jsonb_typeof(entry) <> 'object'
           or (select array_agg(key order by key) from jsonb_object_keys(entry) key) <> array['field', 'readDigest']
           or jsonb_typeof(entry -> 'field') <> 'string'
           or entry ->> 'field' not in ('name', 'strength', 'frequency', 'test', 'unit', 'diagnosis')
           or jsonb_typeof(entry -> 'readDigest') <> 'string'
           or entry ->> 'readDigest' !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = '22023', message = 'Invalid OCR suggestion keys';
  end if;
  return query
    with learning_key as (
      select key_row.key from ocr.learning_key key_row where key_row.id = 1
    ), wanted as (
      -- The caller's digest, and the keyed digest the rules are stored under (0118).
      select distinct entry ->> 'field' as field, decode(entry ->> 'readDigest', 'hex') as digest,
             public.hmac(decode(entry ->> 'readDigest', 'hex'), (select learning_key.key from learning_key), 'sha256')
               as keyed_digest
        from jsonb_array_elements(requested_keys) entry
    ), facility_on as (
      select coalesce((select switch.enabled from ocr.learning_switches switch
                        where switch.scope = 'facility' and switch.facility_id = session_facility), true) as enabled
    ), platform_on as (
      select coalesce((select switch.enabled from ocr.learning_switches switch
                        where switch.scope = 'platform'), true) as enabled
    ), candidates as (
      select wanted.field, wanted.digest, rule.id, rule.scope, rule.suggest_value,
             row_number() over (partition by wanted.field, wanted.digest
                                order by case rule.scope when 'facility' then 0 else 1 end) as preference
        from wanted
        join ocr.learning_rules rule
          on rule.field_class = wanted.field and rule.read_digest = wanted.keyed_digest and rule.status = 'active'
       where (rule.scope = 'facility' and rule.facility_id = session_facility
              and (select facility_on.enabled from facility_on))
          or (rule.scope = 'platform' and (select platform_on.enabled from platform_on)
              and (select facility_on.enabled from facility_on))
    )
    select candidates.field, encode(candidates.digest, 'hex'), candidates.id, candidates.scope,
           candidates.suggest_value
      from candidates where candidates.preference = 1;
end
$$;

-- The owner kill switch: a platform super admin turns a rule set off or on.
create function ocr.set_learning_switch(
  requested_scope text, requested_facility_id uuid, requested_enabled boolean, requested_reason text
) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, audit, auth, identity, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := platform.current_account_id();
  correlation text := platform.current_correlation_id();
  previous boolean;
begin
  if actor_account is null or correlation is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or platform.current_facility_id() is not null or platform.current_membership_id() is not null
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or not exists (
       select 1 from auth.account_roles assignment
         join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
        where assignment.account_id = actor_account and assignment.scope_type = 'platform'
          and assignment.revoked_at is null
          and assignment.role_code = 'platform_super_admin') then
    raise exception using errcode = '42501', message = 'Platform super admin is required';
  end if;
  if requested_scope is null or requested_scope not in ('facility', 'platform')
     or (requested_scope = 'facility') <> (requested_facility_id is not null)
     or requested_enabled is null
     or requested_reason is null or length(btrim(requested_reason)) not between 1 and 240
     or length(requested_reason) > 240 then
    raise exception using errcode = '22023', message = 'Invalid OCR learning switch';
  end if;
  if requested_facility_id is not null then
    perform 1 from identity.facilities facility where facility.id = requested_facility_id for share;
    if not found then
      raise exception using errcode = 'P0002', message = 'Facility not found';
    end if;
  end if;
  select switch.enabled into previous from ocr.learning_switches switch
   where switch.scope = requested_scope and switch.facility_id is not distinct from requested_facility_id
   for update;
  if found then
    update ocr.learning_switches switch
       set enabled = requested_enabled, reason = btrim(requested_reason), set_by_account_id = actor_account,
           set_at = clock_timestamp()
     where switch.scope = requested_scope and switch.facility_id is not distinct from requested_facility_id;
  else
    insert into ocr.learning_switches (scope, facility_id, enabled, reason, set_by_account_id)
    values (requested_scope, requested_facility_id, requested_enabled, btrim(requested_reason), actor_account);
  end if;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    facility_id, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    correlation, 'platform', actor_subject, actor_account, null, null,
    'admin.ocr.learning-switch.set', 'success',
    case requested_scope when 'facility' then 'facility' else 'ocr-learning' end,
    coalesce(requested_facility_id::text, 'platform'),
    'healthcare-operations', btrim(requested_reason), 'application', 'identity-api',
    jsonb_build_object('scope', requested_scope, 'enabled', requested_enabled,
      'previousEnabled', coalesce(previous, true))
  );
end
$$;

create function ocr.learning_overview()
returns table (scope text, facility_id uuid, enabled boolean, active_rules integer, retired_rules integer,
  showings_180d integer, rejected_180d integer)
language plpgsql stable security definer
set search_path = pg_catalog, ocr, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null or platform.current_facility_id() is not null
     or platform.current_membership_id() is not null
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access') then
    raise exception using errcode = '42501', message = 'Platform administration authority is required';
  end if;
  return query
    with sets as (
      select 'platform'::text as scope, null::uuid as facility_id
      union
      select rule.scope, rule.facility_id from ocr.learning_rules rule where rule.scope = 'facility'
      union
      select switch.scope, switch.facility_id from ocr.learning_switches switch where switch.scope = 'facility'
    )
    select sets.scope, sets.facility_id,
           coalesce((select switch.enabled from ocr.learning_switches switch
                      where switch.scope = sets.scope and switch.facility_id is not distinct from sets.facility_id), true),
           (select count(*)::integer from ocr.learning_rules rule
             where rule.scope = sets.scope and rule.facility_id is not distinct from sets.facility_id
               and rule.status = 'active'),
           (select count(*)::integer from ocr.learning_rules rule
             where rule.scope = sets.scope and rule.facility_id is not distinct from sets.facility_id
               and rule.status = 'retired'),
           (select count(*)::integer from ocr.learning_rule_showings showing
              join ocr.learning_rules rule on rule.id = showing.rule_id
             where rule.scope = sets.scope and rule.facility_id is not distinct from sets.facility_id
               and showing.shown_at > clock_timestamp() - interval '180 days'),
           (select count(*)::integer from ocr.learning_rule_showings showing
              join ocr.learning_rules rule on rule.id = showing.rule_id
             where rule.scope = sets.scope and rule.facility_id is not distinct from sets.facility_id
               and showing.outcome = 'rejected' and showing.shown_at > clock_timestamp() - interval '180 days')
      from sets
     order by sets.scope desc, sets.facility_id;
end
$$;

-- The platform-wide review-outcome summary (phase 1's outcomes, every
-- facility), aggregate only, suppressed here.
create function ocr.review_outcome_summary(requested_from date, requested_to date)
returns table (group_type text, week text, facility_id uuid, kind text, prompt_version text, measure text,
  value bigint)
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, audit, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := platform.current_account_id();
  correlation text := platform.current_correlation_id();
  reviews_read integer;
  truncated boolean;
begin
  if actor_account is null or correlation is null
     or platform.current_facility_id() is not null or platform.current_membership_id() is not null
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or not auth.account_has_platform_permission(actor_account, 'platform.operations.read') then
    raise exception using errcode = '42501', message = 'Platform administration authority is required';
  end if;
  if requested_from is null or requested_to is null or requested_to < requested_from
     or requested_to - requested_from + 1 > 104 then
    raise exception using errcode = '22023', message = 'Invalid OCR quality summary range';
  end if;
  -- A second read in the same transaction starts again.
  if to_regclass('pg_temp.review_outcome_rows') is not null then drop table pg_temp.review_outcome_rows; end if;
  if to_regclass('pg_temp.review_outcome_summary_rows') is not null then
    drop table pg_temp.review_outcome_summary_rows;
  end if;
  -- The read of every facility's validations happens inside a summary run
  -- (the policy ocr_validations_quality_summary), ended right after it.
  insert into ocr.quality_summary_runs (transaction_id) values (pg_current_xact_id());
  create temporary table review_outcome_rows on commit drop as
    select to_char(validation.created_at at time zone 'UTC', 'IYYY-"W"IW') as week, validation.facility_id,
           validation.provenance -> 'reviewOutcome' as outcome
      from ocr.validations validation
     where validation.created_at >= requested_from::timestamp at time zone 'UTC'
       and validation.created_at < (requested_to + 1)::timestamp at time zone 'UTC'
       and validation.provenance -> 'reviewOutcome' ->> 'schema' = 'hid.ocr.review-outcome/v1'
     order by validation.created_at limit 50001;
  delete from ocr.quality_summary_runs run where run.transaction_id = pg_current_xact_id();
  select count(*) into reviews_read from review_outcome_rows;
  truncated := reviews_read > 50000;
  if truncated then
    delete from review_outcome_rows where ctid = (select max(ctid) from review_outcome_rows);
    reviews_read := 50000;
  end if;
  create temporary table review_outcome_summary_rows on commit drop as
    with outcomes as (
      select review_outcome_rows.week, review_outcome_rows.facility_id, review_outcome_rows.outcome,
             case when review_outcome_rows.outcome ->> 'promptVersion' ~ '^[A-Za-z0-9][A-Za-z0-9._+:-]{0,119}$'
                  then review_outcome_rows.outcome ->> 'promptVersion' end as prompt_version
        from review_outcome_rows
    ), items as (
      select outcomes.week, outcomes.facility_id, outcomes.prompt_version,
             case when bucket ->> 'kind' ~ '^[a-z][a-z0-9_]{0,63}$' then bucket ->> 'kind' else 'other' end as kind,
             case when bucket ->> 'decision' ~ '^[a-z][a-z0-9_]{0,63}$' then bucket ->> 'decision' else 'other' end
               as decision,
             (bucket ->> 'items')::bigint as items
        from outcomes
        cross join lateral jsonb_array_elements(case when jsonb_typeof(outcomes.outcome -> 'buckets') = 'array'
                                                     then outcomes.outcome -> 'buckets' else '[]'::jsonb end) bucket
       where jsonb_typeof(bucket) = 'object' and jsonb_typeof(bucket -> 'items') = 'number'
         and (bucket ->> 'items') ~ '^[0-9]{1,6}$'
    ), item_groups as (
      select items.week, items.facility_id, items.kind, items.prompt_version, items.decision,
             sum(items.items)::bigint as items,
             sum(sum(items.items)) over (partition by items.week, items.facility_id, items.kind, items.prompt_version)
               as group_items
        from items group by items.week, items.facility_id, items.kind, items.prompt_version, items.decision
    ), review_groups as (
      select outcomes.week, outcomes.facility_id, outcomes.prompt_version,
             count(*) as reviews,
             count(*) filter (where outcomes.outcome ->> 'disposition' = 'validated'
                                and not outcomes.outcome ? 'error') as validated,
             count(*) filter (where outcomes.outcome ->> 'disposition' = 'rejected'
                                and not outcomes.outcome ? 'error') as rejected,
             count(*) filter (where outcomes.outcome -> 'estimated' = 'true'::jsonb) as estimated,
             count(*) filter (where outcomes.outcome ? 'error') as summary_failed
        from outcomes group by outcomes.week, outcomes.facility_id, outcomes.prompt_version
    )
    select 'item'::text as group_type, item_groups.week, item_groups.facility_id, item_groups.kind,
           item_groups.prompt_version, item_groups.decision as measure, item_groups.items as value
      from item_groups where item_groups.group_items >= 20
    union all
    select distinct 'item', item_groups.week, item_groups.facility_id, item_groups.kind, item_groups.prompt_version,
           'suppressed', 0::bigint
      from item_groups where item_groups.group_items < 20
    union all
    select 'review', review_groups.week, review_groups.facility_id, null, review_groups.prompt_version, metric.name,
           metric.value
      from review_groups
      cross join lateral (values ('reviews', review_groups.reviews), ('validated', review_groups.validated),
                                 ('rejected', review_groups.rejected), ('estimated', review_groups.estimated),
                                 ('summary_failed', review_groups.summary_failed)) metric(name, value)
     where review_groups.reviews >= 20
    union all
    select 'review', review_groups.week, review_groups.facility_id, null, review_groups.prompt_version,
           'suppressed', 0::bigint
      from review_groups where review_groups.reviews < 20;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    facility_id, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    correlation, 'platform', actor_subject, actor_account, null, null,
    'admin.ocr.quality-summary.read', 'success', 'ocr-quality-summary', 'platform',
    'healthcare-operations', null, 'application', 'identity-api',
    jsonb_build_object('from', requested_from, 'to', requested_to, 'reviews', reviews_read, 'truncated', truncated,
      'rows', (select count(*) from review_outcome_summary_rows),
      'suppressedGroups', (select count(*) from review_outcome_summary_rows summary_row
                            where summary_row.measure = 'suppressed'))
  );
  return query
    select summary_row.group_type, summary_row.week, summary_row.facility_id, summary_row.kind,
           summary_row.prompt_version, summary_row.measure, summary_row.value
      from review_outcome_summary_rows summary_row
     order by summary_row.week, summary_row.facility_id, summary_row.group_type, summary_row.kind,
              summary_row.prompt_version, summary_row.measure;
end
$$;

-- The OCR worker deletes showings older than 180 days with its 7-day sweep (as
-- ocr.purge_correction_observations does for 0118's rows), so they go even
-- where nobody validates any more.
create function ocr.purge_learning_showings(requested_limit integer)
returns integer
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, auth, platform, pg_temp
as $$
declare
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
  removed integer;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_limit is null or requested_limit not between 1 and 100000 then
    raise exception using errcode = '22023', message = 'Invalid purge limit';
  end if;
  delete from ocr.learning_rule_showings old_row
   where (old_row.rule_id, old_row.validation_key) in (
     select candidate.rule_id, candidate.validation_key from ocr.learning_rule_showings candidate
      where candidate.shown_at < clock_timestamp() - interval '180 days'
      order by candidate.shown_at limit requested_limit);
  get diagnostics removed = row_count;
  return removed;
end
$$;

-- 3. Owners, policies, ACLs.
do $$
declare
  ocr_owner name := (select pg_get_userbyid(relowner) from pg_class where oid = 'ocr.jobs'::regclass);
begin
  if ocr_owner <> current_user then
    execute format('alter table ocr.learning_rules owner to %I', ocr_owner);
    execute format('alter table ocr.learning_rule_showings owner to %I', ocr_owner);
    execute format('alter table ocr.learning_switches owner to %I', ocr_owner);
    execute format('alter table ocr.quality_summary_runs owner to %I', ocr_owner);
    execute format('alter function ocr.learning_evaluate(text,bytea) owner to %I', ocr_owner);
    execute format('alter function ocr.learning_after_validation(uuid,jsonb) owner to %I', ocr_owner);
    execute format('alter function ocr.reading_suggestions(jsonb) owner to %I', ocr_owner);
    execute format('alter function ocr.set_learning_switch(text,uuid,boolean,text) owner to %I', ocr_owner);
    execute format('alter function ocr.learning_overview() owner to %I', ocr_owner);
    execute format('alter function ocr.review_outcome_summary(date,date) owner to %I', ocr_owner);
    execute format('alter function ocr.purge_learning_showings(integer) owner to %I', ocr_owner);
  end if;
  execute format('create policy learning_rules_owner on ocr.learning_rules for all '
    || 'using (current_user = %L) with check (current_user = %L)', ocr_owner, ocr_owner);
  execute format('create policy learning_rule_showings_owner on ocr.learning_rule_showings for all '
    || 'using (current_user = %L) with check (current_user = %L)', ocr_owner, ocr_owner);
  execute format('create policy learning_switches_owner on ocr.learning_switches for all '
    || 'using (current_user = %L) with check (current_user = %L)', ocr_owner, ocr_owner);
  execute format('create policy quality_summary_runs_owner on ocr.quality_summary_runs for all to %I '
    || 'using (true) with check (true)', ocr_owner);
end
$$;

-- The summary's read of ocr.validations: for the OCR owner only, while this
-- transaction holds a summary run. ACCESS EXCLUSIVE for the policy, bounded.
do $$
declare
  ocr_owner name := (select pg_get_userbyid(relowner) from pg_class where oid = 'ocr.jobs'::regclass);
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ocr.validations in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0119: ocr.validations stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
  execute format('create policy ocr_validations_quality_summary on ocr.validations for select to %I '
    || 'using (exists (select 1 from ocr.quality_summary_runs run '
    || 'where run.transaction_id = pg_current_xact_id_if_assigned()))', ocr_owner);
end
$$;
comment on policy ocr_validations_quality_summary on ocr.validations is
  '0119: the OCR functions'' owner reads every facility''s validations only while this transaction holds a row in ocr.quality_summary_runs, which only ocr.review_outcome_summary writes, for its read alone.';

revoke all on function ocr.learning_evaluate(text,bytea), ocr.learning_after_validation(uuid,jsonb),
  ocr.reading_suggestions(jsonb), ocr.set_learning_switch(text,uuid,boolean,text), ocr.learning_overview(),
  ocr.review_outcome_summary(date,date), ocr.purge_learning_showings(integer) from public;

comment on function ocr.purge_learning_showings(integer) is
  '0119: the OCR worker deletes suggestion showings older than 180 days, oldest first, up to the limit.';
comment on function ocr.learning_evaluate(text,bytea) is
  '0119: switches a correction rule on for one key (facility, then platform) when its evidence of the last 180 days, after any retirement, is >= 5 identical corrections from >= 3 staff with no conflict (platform: >= 2 facilities). Granted to no role.';
comment on function ocr.learning_after_validation(uuid,jsonb) is
  '0119: ocr-api records whether each suggestion shown was taken, retires a rule not taken in 3 of its last 10 showings, and evaluates the keys the validation observed (0118).';
comment on function ocr.reading_suggestions(jsonb) is
  '0119: the active rule (facility first, then platform; a rule set switched off is left out) for each key of a reading, for staff holding ocr.job.read at the session facility.';
comment on function ocr.set_learning_switch(text,uuid,boolean,text) is
  '0119: a platform super admin turns the platform''s or a facility''s OCR suggestion rules off or on (the owner kill switch; on without a row). Audited.';
comment on function ocr.learning_overview() is
  '0119: counts of OCR learning rules, switches and showings per rule set, for platform administrators.';
comment on function ocr.review_outcome_summary(date,date) is
  '0119: the phase-1 review outcomes of every facility summed by ISO week, facility, kind, prompt version (and decision); groups under 20 suppressed; for platform administrators holding platform.operations.read. Audited.';

-- Grants (the same in runtime-grants.sql's 0119 block).
do $$
declare
  wanted record;
begin
  for wanted in
    select * from (values
      ('hid_ocr_runtime', 'usage on schema ocr'),
      ('hid_identity_runtime', 'usage on schema ocr'),
      ('hid_ocr_worker', 'usage on schema ocr'),
      ('hid_ocr_worker', 'execute on function ocr.purge_learning_showings(integer)'),
      ('hid_ocr_runtime', 'execute on function ocr.learning_after_validation(uuid,jsonb), '
        || 'ocr.reading_suggestions(jsonb)'),
      ('hid_identity_runtime', 'execute on function ocr.set_learning_switch(text,uuid,boolean,text), '
        || 'ocr.learning_overview(), ocr.review_outcome_summary(date,date)'))
      grant_row(grantee, privilege)
     where exists (select 1 from pg_roles where rolname = grant_row.grantee)
  loop
    execute format('grant %s to %I', wanted.privilege, wanted.grantee);
  end loop;
end
$$;

-- 4. Post-checks.
do $$
declare
  mismatch text;
  ocr_owner oid := (select relowner from pg_class where oid = 'ocr.jobs'::regclass);
begin
  select string_agg(proc.oid::regprocedure::text, ', ') into mismatch
    from pg_proc proc
   where proc.oid in ('ocr.learning_after_validation(uuid,jsonb)'::regprocedure,
       'ocr.reading_suggestions(jsonb)'::regprocedure,
       'ocr.set_learning_switch(text,uuid,boolean,text)'::regprocedure,
       'ocr.learning_overview()'::regprocedure,
       'ocr.review_outcome_summary(date,date)'::regprocedure,
       'ocr.purge_learning_showings(integer)'::regprocedure)
     and (not proc.prosecdef or proc.proowner <> ocr_owner or proc.proconfig is null
          or proc.proconfig[1] not like 'search_path=pg_catalog, ocr, %');
  if mismatch is not null then mismatch := 'attributes of ' || mismatch; end if;
  if mismatch is null and exists (
       select 1 from pg_proc proc where proc.oid = 'ocr.learning_evaluate(text,bytea)'::regprocedure
          and (proc.prosecdef or proc.proowner <> ocr_owner)) then
    mismatch := 'attributes of ocr.learning_evaluate(text,bytea)';
  end if;
  if mismatch is null then
    select string_agg(format('%s to %s', proc.oid::regprocedure, coalesce(grantee.rolname, 'PUBLIC')), '; ')
      into mismatch
      from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
      left join pg_roles grantee on grantee.oid = privilege.grantee
     where proc.pronamespace = 'ocr'::regnamespace
       and proc.proname in ('learning_evaluate', 'learning_after_validation', 'reading_suggestions',
         'set_learning_switch', 'learning_overview', 'review_outcome_summary', 'purge_learning_showings')
       and privilege.grantee <> proc.proowner
       and (proc.proname, coalesce(grantee.rolname, 'PUBLIC')) not in (
         ('learning_after_validation', 'hid_ocr_runtime'), ('reading_suggestions', 'hid_ocr_runtime'),
         ('set_learning_switch', 'hid_identity_runtime'), ('learning_overview', 'hid_identity_runtime'),
         ('review_outcome_summary', 'hid_identity_runtime'), ('purge_learning_showings', 'hid_ocr_worker'));
    if mismatch is not null then mismatch := 'unexpected EXECUTE: ' || mismatch; end if;
  end if;
  if mismatch is null and (select count(*) from pg_class class_row
        where class_row.oid in ('ocr.learning_rules'::regclass, 'ocr.learning_rule_showings'::regclass,
                                'ocr.learning_switches'::regclass, 'ocr.quality_summary_runs'::regclass)
          and class_row.relowner = ocr_owner and class_row.relrowsecurity and class_row.relforcerowsecurity
          and (select count(*) from pg_policy policy_row where policy_row.polrelid = class_row.oid) = 1
          and not exists (select 1 from aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) privilege
                           where privilege.grantee <> class_row.relowner)) <> 4 then
    mismatch := 'the owner, row-level security, policy or ACL of the 0119 tables';
  end if;
  if mismatch is null and (
       (select count(*) from pg_policy policy_row where policy_row.polrelid = 'ocr.validations'::regclass) <> 3
       or not exists (select 1 from pg_policy policy_row
                       where policy_row.polrelid = 'ocr.validations'::regclass
                         and policy_row.polname = 'ocr_validations_quality_summary'
                         and policy_row.polcmd = 'r' and policy_row.polpermissive
                         and policy_row.polroles = array[ocr_owner] and policy_row.polwithcheck is null
                         and pg_get_expr(policy_row.polqual, policy_row.polrelid) =
                           '(EXISTS ( SELECT 1
   FROM ocr.quality_summary_runs run
  WHERE (run.transaction_id = pg_current_xact_id_if_assigned())))')
       or not exists (select 1 from pg_policy policy_row
                       where policy_row.polrelid = 'ocr.quality_summary_runs'::regclass
                         and policy_row.polname = 'quality_summary_runs_owner' and policy_row.polcmd = '*'
                         and policy_row.polroles = array[ocr_owner])) then
    mismatch := 'the policy ocr_validations_quality_summary or quality_summary_runs_owner';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0119: post-check failed: %s', mismatch);
  end if;
end;
$$;
