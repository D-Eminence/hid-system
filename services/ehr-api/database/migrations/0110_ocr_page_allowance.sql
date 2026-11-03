-- 0110 OCR page allowance (Migrate AI reading, Session B; owner decision of
-- 2026-11-02/03, D-Eminence, coordination notes "owner-decisions.md" (7):
-- "allowance 500 pages/facility/month (Textract+AI), only super admin raises,
-- 100% pauses reading but not review/manual entry"). The declaration is
-- signed separately (reviewed_by is empty until the owner signs).
--
-- Written on 0103 (the latest migration on this branch). In the release,
-- 0104-0109 (records processing, virus scanner, support check, Session C's
-- items/checking/publishing) are expected to be applied before 0110, but 0110
-- uses none of their objects and its preconditions ask for none of them: it
-- needs only ocr.jobs, the 0077 bodies named in section 0, the session and
-- permission helpers it calls, and the runtime roles. If a migration between
-- 0103 and 0110 replaces one of the pinned bodies (for example
-- ocr.validate_job_write or ocr.fail_worker_job), section 0 stops 0110 with
-- nothing applied and the pins must be renewed against that body.
--
-- What it adds. Pages read are counted per facility per calendar month in
-- Africa/Lagos (Textract and the AI reading count together, one number per
-- job). The default allowance is 500 pages per facility per month; a
-- platform super admin may set another limit (1-100000). A facility is
-- paused when pages_used >= pages_limit: the OCR worker then parks the job it
-- holds until 00:00 Africa/Lagos on the first day of the next month without
-- using an attempt. Review, validation, publication and manual entry are not
-- touched: nothing here is read by ocr-api's job, extraction, validation or
-- publication paths.
--
-- 1. Tables (no runtime role has any privilege on them; row-level security is
--    on and forced, with one policy for the OCR functions' owner, as 0097;
--    only the SECURITY DEFINER functions below touch them; no patient text):
--    - ocr.facility_page_limits (facility_id pk -> identity.facilities,
--      pages_limit 1-100000, set_by_account_id (the platform account the
--      command took from the session; no foreign key, so creating the table
--      takes no lock on auth.accounts, which sign-ins write all the time; the
--      audit row names the same account), reason 1-240 characters, set_at);
--    - ocr.page_usage (job_id pk, facility_id -> identity.facilities,
--      usage_month = the first day of the Africa/Lagos month of the job's
--      first recording, pages 1-200, recorded_at). job_id deliberately has no
--      foreign key to ocr.jobs: the count must outlive the job's 24-hour
--      working data (Session C's deletion) and must never block it.
--    - ocr.ai_usage (job_id, attempt_no, model primary key; model
--      ^claude-[a-z0-9-]+$; facility_id -> identity.facilities; usage_month as
--      page_usage; requests, input/output/cache read/cache write tokens, all
--      >= 0; recorded_at). Counts only; no foreign key to ocr.jobs, for the
--      same reason.
-- 2. Functions (SECURITY DEFINER, search_path pinned, owned by the OCR
--    functions' owner, EXECUTE revoked from PUBLIC):
--    - ocr.worker_page_allowance(job, claim token) -> (pages_used,
--      pages_limit, resets_on, paused) for the job's facility; the same actor
--      and claim checks as ocr.fail_worker_job (0077); paused is false for a
--      job whose pages are already recorded (a retry is never parked by its
--      own pages); hid_ocr_worker.
--    - ocr.record_worker_pages(job, claim token, page count, correlation id)
--      -> the same row; idempotent per job (a replay, or a smaller count,
--      changes nothing; a larger count keeps the larger); the month is the
--      month of the first recording; one audit row ocr.worker.pages_recorded
--      (details: pages only) when the count is stored or raised;
--      hid_ocr_worker.
--    - ocr.pause_worker_job_for_allowance(job, claim token, correlation id)
--      -> the resume time (resets_on 00:00 Africa/Lagos). NULL, changing
--      nothing, unless the facility is at or over its limit and the job's
--      pages are not yet recorded (a limit raised since the read, or a
--      retry). Otherwise processing -> failed -> queued as in
--      fail_worker_job's retry path, with attempt_count restored to
--      attempt_count - 1 (a pause never uses an attempt), last_error_code
--      OCR_PAGE_ALLOWANCE_USED_UP, next_attempt_at = the resume time; audit
--      ocr.worker.paused_for_allowance; hid_ocr_worker.
--    - ocr.facility_page_allowance(facility) -> the same row, for ocr-api
--      (hid_ocr_runtime, which hid_ocr_api_runtime inherits) and the
--      Identity API admin console (hid_identity_runtime): a session that names
--      that facility and an active membership there holding ocr.job.read
--      (auth.membership_has_permission), or a platform-scoped session (no
--      facility, no membership) whose account holds platform.admin.access.
--    - ocr.set_facility_page_limit(facility, limit, reason) -> void, for the
--      Identity API (hid_identity_runtime): platform-scoped (no facility, no
--      membership, as 0103), platform.admin.access, an active platform
--      assignment of platform_super_admin (only: a limit is a cost decision;
--      platform_admin, support admins and the facility only read), a
--      correlation id and purpose healthcare-operations. Upserts the limit, writes one platform audit row
--      admin.ocr.page-limit.set (0064's platform rules: no facility,
--      membership, organization or patient; the facility is the resource), and
--      when the new limit is above this month's use, sets next_attempt_at to
--      now for the facility's queued jobs parked with
--      OCR_PAGE_ALLOWANCE_USED_UP whose resume time is still ahead. A job the
--      job trigger refuses (its document no longer exactly clean, or, under
--      an owner without BYPASSRLS (release checklist P8), a document the
--      trigger cannot read in a platform session) is skipped and counted in
--      the audit row (skippedJobs); it stays parked and becomes due at
--      resets_on, when the claim checks its evidence as for any job. Like
--      every OCR worker command, the three worker commands see no job under
--      such an owner (the worker session names no facility) and answer
--      55000.
--    - ocr.facility_page_allowance_state(facility): the shared reckoning
--      (SECURITY INVOKER, granted to no role; called only by the five above
--      as their owner).
--    - ocr.claim_worker_job_fair(provider, lease seconds, max in flight per
--      facility 1-16) -> the row ocr.claim_worker_job returns; its
--      authorization, validation, lease recovery and eligibility (the 0014
--      body as 0015 resolves its columns, copied), plus: a facility with that
--      many jobs processing under an unexpired lease is skipped, and the
--      least busy facility's job is taken first (then next_attempt_at,
--      queued_at, id). SKIP LOCKED as before; the candidate's facility is
--      taken with pg_try_advisory_xact_lock and counted again after it, so the
--      cap is exact among fair claimers (a claimer that cannot take the lock
--      passes over that facility for this call, never waits). Claims made
--      through the unchanged ocr.claim_worker_job (an old worker image) take
--      no such lock and are counted but not bounded. hid_ocr_worker.
--    - ocr.record_worker_ai_usage(job, claim token, model, requests, input,
--      output, cache read, cache write tokens, correlation id) -> void;
--      fail_worker_job's claim checks; model ^claude-[a-z0-9-]+$ and counts
--      >= 0 (22023); one row per (job, current attempt, model), the given
--      totals replace the stored ones; audit ocr.worker.ai_usage_recorded
--      (counts and model only) when something changed; hid_ocr_worker.
--    - ocr.facility_ocr_usage(facility, month) -> (model, requests,
--      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
--      pages): one row per model and one row 'textract' with the month's
--      pages from ocr.page_usage (tokens 0), for the Africa/Lagos month
--      containing the date (NULL: this month); the callers and grants of
--      ocr.facility_page_allowance.
-- 3. ocr.validate_job_write (0077's body) gains one allowed transition and
--    nothing else: a queued job parked by the allowance (last_error_code
--    exactly OCR_PAGE_ALLOWANCE_USED_UP, compared with IS NOT DISTINCT FROM so
--    a job with no error code never qualifies) may move its next_attempt_at
--    earlier, but not before now - 1 minute, with the next version and
--    optionally a new correlation id, every other column unchanged. Without it the trigger refuses any queued -> queued
--    update and raising the limit could not resume parked jobs. The two
--    transitions the pause makes (processing -> failed, failed -> queued) are
--    0077's own, taken out of play exactly as fail_worker_job does.
--    attempt_count is not one of the trigger's immutable columns.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): ocr.jobs, identity.facilities, auth.accounts,
--    audit.events present; not applied yet (none of 0110's objects, and
--    validate_job_write not already this file's body); md5 of pg_proc.prosrc
--    of ocr.validate_job_write, ocr.fail_worker_job, ocr.claim_worker_job,
--    ocr.record_job_event (0077/0014/0015 bodies), the platform session
--    helpers, auth.account_id_for_subject, auth.account_has_active_role,
--    auth.account_has_platform_permission, auth.membership_has_permission,
--    identity.has_active_membership and audit.authorize_platform_event; the
--    two ocr.jobs triggers; 0064's three audit constraints and its authority
--    trigger; the permissions ocr.job.read and platform.admin.access and the
--    roles ocr_worker and platform_super_admin; the runtime roles hid_ocr_worker, hid_ocr_runtime, hid_ocr_api_runtime
--    (a member of hid_ocr_runtime) and hid_identity_runtime, where they exist,
--    neither superuser nor BYPASSRLS (a fresh database creates them later in
--    the role bootstrap); ocr.jobs,
--    validate_job_write, fail_worker_job and claim_worker_job share one owner,
--    which may create in schema ocr, and the applier is it or a member that
--    inherits it and may SET ROLE to it.
-- 4. Grants are made here too, since a release applies only migrations;
--    runtime-grants.sql gains the same 0110 block for a role bootstrap.
-- 5. Post-checks: the bodies (ocr.validate_job_write and
--    ocr.claim_worker_job_fair by md5, ocr.claim_worker_job still one of its
--    two accepted bodies), attributes, owners, ACLs, row-level security, the
--    absence of any table privilege for a runtime role and of any foreign key
--    from the usage tables to ocr.jobs.
--
-- Locks (measured with pg_locks before commit on a 0103 copy): beyond
-- ACCESS SHARE, only the three new tables and their indexes, the session's own
-- temporary table and schema, and SHARE ROW EXCLUSIVE on identity.facilities
-- (the two foreign keys); no lock on ocr.jobs, auth.accounts or audit.events
-- is held to commit, and no row is read or written. Behind a session holding
-- ACCESS EXCLUSIVE on ocr.jobs or identity.facilities the runner stopped
-- after its 5 s lock_timeout with nothing applied; behind a transaction
-- writing identity.facilities (ROW EXCLUSIVE) it waits for that transaction
-- (facility rows are written only by onboarding and platform lifecycle
-- commands); behind writers of ocr.jobs, auth.accounts and audit.events it
-- applies at once. Apply time about 40 ms.
--
-- Old services on this schema: no existing function changes behaviour except
-- the one extra allowed job transition, which no current service performs
-- (ocr.claim_worker_job keeps its body; its md5 is checked again after);
-- today's ocr-api, ocr-worker and identity-api images run unchanged. Applied
-- migrations 0001 through 0103 are immutable.

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
  ocr_owner oid;
begin
  -- a. Prerequisites (what 0110 itself needs; no 0104-0109 marker).
  if to_regclass('ocr.jobs') is null
     or to_regclass('identity.facilities') is null
     or to_regclass('auth.accounts') is null
     or to_regclass('audit.events') is null
     or to_regprocedure('ocr.fail_worker_job(uuid,uuid,text,text,boolean,integer,text)') is null
     or to_regprocedure('ocr.validate_job_write()') is null then
    raise exception using errcode = '55000', message = '0110: ocr.jobs and the 0077 OCR worker commands must be applied first';
  end if;
  -- b. Not applied yet (nor partly present).
  if to_regclass('ocr.facility_page_limits') is not null
     or to_regclass('ocr.page_usage') is not null
     or to_regprocedure('ocr.worker_page_allowance(uuid,uuid)') is not null
     or to_regprocedure('ocr.record_worker_pages(uuid,uuid,integer,text)') is not null
     or to_regprocedure('ocr.pause_worker_job_for_allowance(uuid,uuid,text)') is not null
     or to_regprocedure('ocr.facility_page_allowance(uuid)') is not null
     or to_regprocedure('ocr.set_facility_page_limit(uuid,integer,text)') is not null
     or to_regprocedure('ocr.facility_page_allowance_state(uuid)') is not null
     or to_regclass('ocr.ai_usage') is not null
     or to_regprocedure('ocr.claim_worker_job_fair(text,integer,integer)') is not null
     or to_regprocedure('ocr.record_worker_ai_usage(uuid,uuid,text,integer,bigint,bigint,bigint,bigint,text)') is not null
     or to_regprocedure('ocr.facility_ocr_usage(uuid,date)') is not null
     or (select md5(proc.prosrc) from pg_proc proc where proc.oid = 'ocr.validate_job_write()'::regprocedure)
        = '58ff61a5b9b95685f6a6d3f938b8481f' then
    raise exception using errcode = '55000', message = '0110: already applied';
  end if;
  -- c. The bodies replaced and relied on, as 0001-0103 left them. The claim
  -- command has two accepted bodies: 0014's with 0015's function setting, and
  -- the one database/rds-compat/0015 writes on Amazon RDS (with
  -- #variable_conflict in the body); 0110 relies only on its claim condition
  -- (queued, next_attempt_at reached, attempts left), which both share.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('ocr.validate_job_write()', array['e9ea263ec9f29355eb9a6a81fd2d7b37']),
      ('ocr.fail_worker_job(uuid,uuid,text,text,boolean,integer,text)', array['2e677d5ec17ae5de9702cf0083f22004']),
      ('ocr.claim_worker_job(text,integer)',
       array['1572865c10fcfb673293e83776d6cf50', '59a60b466df9b8effeb3519939fc54a2']),
      ('ocr.record_job_event()', array['5c972a4dc0443e217cf8db2c0b14d552']),
      ('platform.current_account_id()', array['b715ffe72856836d13ab16656fa6e94a']),
      ('platform.current_actor_subject()', array['cf14c2d4a16d44a79ea9dbef9dc79c2b']),
      ('platform.current_facility_id()', array['c4a7c2989e83d9cedbf1f7b785a5aaed']),
      ('platform.current_membership_id()', array['641989704fea95f885fbc38c6feb5aa5']),
      ('platform.current_correlation_id()', array['48d3bf187101d33bfda51dac829aa223']),
      ('platform.current_purpose_of_use()', array['74f7f2ea17dbbe825f7cfe543ad3e83f']),
      ('auth.account_id_for_subject(text)', array['4678770cf6a210034740f09422fdfbaa']),
      ('auth.account_has_active_role(uuid,text)', array['a3310b48da6ff8bcd3ecb9d7dbef900a']),
      ('auth.account_has_platform_permission(uuid,text)', array['2145c72b864abf1b69d23d96265e5ba7']),
      ('auth.membership_has_permission(text,uuid,uuid,text)', array['65e3eaff93fe729fd5c5b986b80c9dd6']),
      ('identity.has_active_membership(text,uuid,uuid)', array['bb52953ef1cd08527db61230a671859e']),
      ('audit.authorize_platform_event()', array['41e4102669ab23df53ac4d73badc8a8c']))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is null or md5(proc.prosrc) <> all (expected.digest);
  -- The trigger function's attributes (SECURITY DEFINER plpgsql, VOLATILE,
  -- its search_path).
  if mismatch is null and not exists (
       select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
        where proc.oid = 'ocr.validate_job_write()'::regprocedure
          and language_row.lanname = 'plpgsql' and proc.prosecdef and not proc.proisstrict
          and proc.provolatile = 'v'
          and proc.proconfig = '{"search_path=ocr, ehr, identity, auth, platform, pg_temp"}'::text[]) then
    mismatch := 'attributes of ocr.validate_job_write()';
  end if;
  -- The two ocr.jobs triggers, enabled, as 0013 created them.
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'ocr.jobs'::regclass and trigger_row.tgenabled = 'O'
             and (trigger_row.tgname, pg_get_triggerdef(trigger_row.oid)) in (
               ('ocr_jobs_validate', 'CREATE TRIGGER ocr_jobs_validate BEFORE INSERT OR UPDATE ON ocr.jobs '
                 || 'FOR EACH ROW EXECUTE FUNCTION ocr.validate_job_write()'),
               ('ocr_jobs_event', 'CREATE TRIGGER ocr_jobs_event AFTER INSERT OR UPDATE OF status ON ocr.jobs '
                 || 'FOR EACH ROW EXECUTE FUNCTION ocr.record_job_event()'))) <> 2 then
    mismatch := 'the ocr.jobs triggers ocr_jobs_validate and ocr_jobs_event';
  end if;
  -- 0064's audit rules the platform row must satisfy.
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
  -- The runtime roles granted to, where they exist (on a fresh database the
  -- role bootstrap creates them after the migrations and runtime-grants.sql
  -- makes the same grants), and the permissions and roles read.
  if mismatch is null then
    select string_agg(role_row.rolname, ', ') into mismatch
      from pg_roles role_row
     where role_row.rolname in ('hid_ocr_worker', 'hid_ocr_runtime', 'hid_ocr_api_runtime', 'hid_identity_runtime')
       and (role_row.rolsuper or role_row.rolbypassrls);
    if mismatch is not null then mismatch := 'the runtime roles (superuser or BYPASSRLS) ' || mismatch; end if;
  end if;
  if mismatch is null
     and exists (select 1 from pg_roles where rolname = 'hid_ocr_api_runtime')
     and exists (select 1 from pg_roles where rolname = 'hid_ocr_runtime')
     and not pg_has_role('hid_ocr_api_runtime', 'hid_ocr_runtime', 'USAGE') then
    mismatch := 'hid_ocr_api_runtime must inherit hid_ocr_runtime';
  end if;
  if mismatch is null
     and ((select count(*) from auth.permissions where code in ('ocr.job.read', 'platform.admin.access')) <> 2
       or (select count(*) from auth.roles where code in ('ocr_worker', 'platform_super_admin')) <> 2) then
    mismatch := 'the permissions ocr.job.read, platform.admin.access or the roles ocr_worker, platform_super_admin';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0110: an object this migration relies on differs from 0001-0103: %s', mismatch);
  end if;
  -- d. One owner for ocr.jobs and the OCR worker commands; it may create in
  -- schema ocr; the applier is it, or a member that inherits it and may SET
  -- ROLE to it (never a superuser's bypass alone).
  select string_agg(distinct pg_get_userbyid(owner_row.owner_oid), ', ') into mismatch
    from (select proc.proowner as owner_oid from pg_proc proc
           where proc.oid in ('ocr.validate_job_write()'::regprocedure,
             'ocr.fail_worker_job(uuid,uuid,text,text,boolean,integer,text)'::regprocedure,
             'ocr.claim_worker_job(text,integer)'::regprocedure)
          union all
          select class_row.relowner from pg_class class_row where class_row.oid = 'ocr.jobs'::regclass) owner_row;
  ocr_owner := (select relowner from pg_class where oid = 'ocr.jobs'::regclass);
  if mismatch is distinct from pg_get_userbyid(ocr_owner) then
    raise exception using errcode = '55000',
      message = format('0110: ocr.jobs and the OCR worker commands must share one owner (found %s)', mismatch);
  end if;
  if not has_schema_privilege(ocr_owner, 'ocr', 'CREATE') then
    raise exception using errcode = '55000',
      message = format('0110: %s may not create in schema ocr', pg_get_userbyid(ocr_owner));
  end if;
  if applier <> ocr_owner
     and not (pg_has_role(applier, ocr_owner, 'USAGE') and pg_has_role(applier, ocr_owner, 'SET')) then
    raise exception using errcode = '42501',
      message = format('0110: %s is not %s and may not act as it (INHERIT and SET)', current_user,
        pg_get_userbyid(ocr_owner));
  end if;
  raise notice '0110: owners checked: ocr.jobs=%, applier=%', pg_get_userbyid(ocr_owner), current_user;
end;
$$;

-- The ACL of the replaced trigger function, for the post-check.
create temporary table ocr_page_allowance_0110_acl on commit drop as
  select proc.oid as function_oid, proc.proowner, proc.proacl
    from pg_proc proc where proc.oid = 'ocr.validate_job_write()'::regprocedure;

-- 1. Tables.
create table ocr.facility_page_limits (
  facility_id uuid primary key references identity.facilities(id) on delete restrict,
  pages_limit integer not null check (pages_limit between 1 and 100000),
  set_by_account_id uuid not null,
  reason text not null check (length(btrim(reason)) between 1 and 240 and length(reason) <= 240),
  set_at timestamptz not null default clock_timestamp()
);

create table ocr.page_usage (
  job_id uuid primary key,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  usage_month date not null check (usage_month = date_trunc('month', usage_month)::date),
  pages integer not null check (pages between 1 and 200),
  recorded_at timestamptz not null default clock_timestamp()
);
create index ocr_page_usage_facility_month_idx on ocr.page_usage (facility_id, usage_month);

alter table ocr.facility_page_limits enable row level security;
alter table ocr.facility_page_limits force row level security;
alter table ocr.page_usage enable row level security;
alter table ocr.page_usage force row level security;
revoke all on ocr.facility_page_limits, ocr.page_usage from public;

comment on table ocr.facility_page_limits is
  '0110: a platform super admin''s monthly OCR page allowance for one facility (default 500 when no row). Only the 0110 SECURITY DEFINER functions touch it.';
comment on table ocr.page_usage is
  '0110: pages read (Textract and AI together) per OCR job, counted in the Africa/Lagos month of the first recording. No patient text; no foreign key to ocr.jobs so the count outlives the job''s working data. Only the 0110 SECURITY DEFINER functions touch it.';

-- 2. The shared reckoning: the facility's limit (500 without a row), the
-- pages it used this Africa/Lagos month, the first day of next month, and
-- whether reading is paused. Granted to no role.
create function ocr.facility_page_allowance_state(requested_facility_id uuid)
returns table (pages_used integer, pages_limit integer, resets_on date, paused boolean)
language sql volatile
set search_path = pg_catalog, ocr, pg_temp
as $$
  with period as (
    select date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos')::date as usage_month
  ), state as (
    select coalesce((select sum(usage_row.pages) from ocr.page_usage usage_row, period
                      where usage_row.facility_id = requested_facility_id
                        and usage_row.usage_month = period.usage_month), 0)::integer as pages_used,
           coalesce((select limit_row.pages_limit from ocr.facility_page_limits limit_row
                      where limit_row.facility_id = requested_facility_id), 500) as pages_limit,
           (period.usage_month + interval '1 month')::date as resets_on
      from period
  )
  select state.pages_used, state.pages_limit, state.resets_on, state.pages_used >= state.pages_limit
    from state
$$;

-- The worker reads its job's facility allowance (fail_worker_job's checks).
create function ocr.worker_page_allowance(requested_job_id uuid, requested_claim_token uuid)
returns table (pages_used integer, pages_limit integer, resets_on date, paused boolean)
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  job_row ocr.jobs%rowtype;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_claim_token is null then
    raise exception using errcode = '55000', message = 'OCR claim is not active';
  end if;
  select * into job_row from ocr.jobs job where job.id = requested_job_id;
  if job_row.id is null or job_row.status is distinct from 'processing'
     or job_row.claim_token is distinct from requested_claim_token
     or job_row.claimed_by_subject is distinct from actor_subject
     or job_row.claim_expires_at is null
     or job_row.claim_expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'OCR claim is not active';
  end if;
  -- A job whose pages are already counted (a retry after its reading was
  -- recorded) is never paused: reading it again adds nothing to the count.
  return query select state.pages_used, state.pages_limit, state.resets_on,
         state.paused and not exists (select 1 from ocr.page_usage usage_row
                                       where usage_row.job_id = job_row.id)
    from ocr.facility_page_allowance_state(job_row.facility_id) state;
end
$$;

-- The worker records the pages it read for the job it holds. Idempotent per
-- job: a replay or a smaller count changes nothing, a larger count is kept.
create function ocr.record_worker_pages(
  requested_job_id uuid, requested_claim_token uuid, requested_page_count integer,
  requested_correlation_id text
) returns table (pages_used integer, pages_limit integer, resets_on date, paused boolean)
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, audit, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  job_row ocr.jobs%rowtype;
  stored_pages integer;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_page_count is null or requested_page_count not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Invalid OCR page count';
  end if;
  if requested_claim_token is null then
    raise exception using errcode = '55000', message = 'OCR claim is not active';
  end if;
  select * into job_row from ocr.jobs job where job.id = requested_job_id for update;
  if job_row.id is null or job_row.status is distinct from 'processing'
     or job_row.claim_token is distinct from requested_claim_token
     or job_row.claimed_by_subject is distinct from actor_subject
     or job_row.claim_expires_at is null
     or job_row.claim_expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'OCR claim is not active';
  end if;
  insert into ocr.page_usage as usage_row (job_id, facility_id, usage_month, pages)
  values (job_row.id, job_row.facility_id,
          date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos')::date, requested_page_count)
  on conflict (job_id) do update
     set pages = excluded.pages, recorded_at = clock_timestamp()
   where usage_row.pages < excluded.pages
  returning usage_row.pages into stored_pages;
  if stored_pages is not null then
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
      patient_id, action, outcome, resource_type, resource_id, provenance, details
    ) values (
      requested_correlation_id, 'workload', actor_subject, actor_account,
      job_row.facility_id, job_row.patient_id, 'ocr.worker.pages_recorded', 'success',
      'ocr_job', job_row.id::text, 'application', jsonb_build_object('pages', stored_pages)
    );
  end if;
  return query select state.pages_used, state.pages_limit, state.resets_on, state.paused
    from ocr.facility_page_allowance_state(job_row.facility_id) state;
end
$$;

-- The worker parks the job it holds until the allowance resets, without
-- using an attempt. NULL (nothing changed) unless the facility is at or over
-- its limit and the job's pages are not yet counted.
create function ocr.pause_worker_job_for_allowance(
  requested_job_id uuid, requested_claim_token uuid, requested_correlation_id text
) returns timestamptz
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, audit, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  job_row ocr.jobs%rowtype;
  state record;
  resume_at timestamptz;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_claim_token is null then
    raise exception using errcode = '55000', message = 'OCR claim is not active';
  end if;
  select * into job_row from ocr.jobs job where job.id = requested_job_id for update;
  if job_row.id is null or job_row.status is distinct from 'processing'
     or job_row.claim_token is distinct from requested_claim_token
     or job_row.claimed_by_subject is distinct from actor_subject
     or job_row.claim_expires_at is null
     or job_row.claim_expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'OCR claim is not active';
  end if;
  select * into state from ocr.facility_page_allowance_state(job_row.facility_id);
  -- Not used up (a limit raised since the worker read it), or this job's
  -- pages already counted: nothing changes and the worker reads the job.
  if not state.paused or exists (select 1 from ocr.page_usage usage_row where usage_row.job_id = job_row.id) then
    return null;
  end if;
  resume_at := state.resets_on::timestamp at time zone 'Africa/Lagos';
  update ocr.jobs set status = 'failed', failed_at = clock_timestamp(), completed_at = null,
    last_error_code = 'OCR_PAGE_ALLOWANCE_USED_UP',
    last_error_summary = 'Reading is paused because this facility has used this month''s page allowance',
    next_attempt_at = resume_at,
    claim_token = null, claim_expires_at = null, claimed_by_subject = null,
    correlation_id = requested_correlation_id, row_version = row_version + 1
   where id = job_row.id;
  update ocr.jobs set status = 'queued', started_at = null, failed_at = null,
    attempt_count = greatest(attempt_count - 1, 0),
    correlation_id = requested_correlation_id, row_version = row_version + 1
   where id = job_row.id;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
    patient_id, action, outcome, resource_type, resource_id, provenance, details
  ) values (
    requested_correlation_id, 'workload', actor_subject, actor_account,
    job_row.facility_id, job_row.patient_id, 'ocr.worker.paused_for_allowance', 'success',
    'ocr_job', job_row.id::text, 'application',
    jsonb_build_object('errorCode', 'OCR_PAGE_ALLOWANCE_USED_UP', 'pagesUsed', state.pages_used,
      'pagesLimit', state.pages_limit, 'resetsOn', state.resets_on, 'attemptRestored', job_row.attempt_count > 0)
  );
  return resume_at;
end
$$;

-- Staff of the facility holding ocr.job.read, or a platform administrator in
-- a platform-scoped session, read the facility's allowance.
create function ocr.facility_page_allowance(requested_facility_id uuid)
returns table (pages_used integer, pages_limit integer, resets_on date, paused boolean)
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, auth, identity, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := platform.current_account_id();
  session_facility uuid := platform.current_facility_id();
  session_membership uuid := platform.current_membership_id();
  platform_scoped boolean := session_facility is null and session_membership is null;
begin
  if requested_facility_id is null or actor_account is null
     or not coalesce((not platform_scoped
              and session_facility = requested_facility_id and session_membership is not null
              and auth.membership_has_permission(actor_subject, session_membership, requested_facility_id,
                'ocr.job.read'))
          or (platform_scoped
              and auth.account_has_platform_permission(actor_account, 'platform.admin.access')), false) then
    raise exception using errcode = '42501', message = 'OCR page allowance access is required';
  end if;
  if not exists (select 1 from identity.facilities facility where facility.id = requested_facility_id) then
    raise exception using errcode = 'P0002', message = 'Facility not found';
  end if;
  return query select state.pages_used, state.pages_limit, state.resets_on, state.paused
    from ocr.facility_page_allowance_state(requested_facility_id) state;
end
$$;

-- A platform super admin sets a facility's monthly page limit; raising it
-- above this month's use resumes the facility's parked jobs.
create function ocr.set_facility_page_limit(
  requested_facility_id uuid, requested_pages_limit integer, requested_reason text
) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, audit, auth, identity, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := platform.current_account_id();
  correlation text := platform.current_correlation_id();
  previous_limit integer;
  state record;
  parked record;
  resumed integer := 0;
  skipped integer := 0;
  session_facility text;
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
  if requested_pages_limit is null or requested_pages_limit not between 1 and 100000
     or requested_reason is null or length(btrim(requested_reason)) not between 1 and 240
     or length(requested_reason) > 240 then
    raise exception using errcode = '22023', message = 'Invalid OCR page limit';
  end if;
  perform 1 from identity.facilities facility where facility.id = requested_facility_id for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'Facility not found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hid.ocr.page-limit:' || requested_facility_id::text, 0));
  select limit_row.pages_limit into previous_limit
    from ocr.facility_page_limits limit_row where limit_row.facility_id = requested_facility_id;
  insert into ocr.facility_page_limits as limit_row (facility_id, pages_limit, set_by_account_id, reason, set_at)
  values (requested_facility_id, requested_pages_limit, actor_account, btrim(requested_reason), clock_timestamp())
  on conflict (facility_id) do update
     set pages_limit = excluded.pages_limit, set_by_account_id = excluded.set_by_account_id,
         reason = excluded.reason, set_at = excluded.set_at;
  select * into state from ocr.facility_page_allowance_state(requested_facility_id);
  if not state.paused then
    -- The job rows are read under ocr.jobs' facility policy; name the
    -- facility for the loop (an owner without BYPASSRLS sees nothing
    -- otherwise) and restore the platform session afterwards.
    session_facility := current_setting('app.facility_id', true);
    perform set_config('app.facility_id', requested_facility_id::text, true);
    for parked in
      select job.id from ocr.jobs job
       where job.facility_id = requested_facility_id and job.status = 'queued'
         and job.last_error_code = 'OCR_PAGE_ALLOWANCE_USED_UP'
         and job.next_attempt_at > clock_timestamp()
       order by job.next_attempt_at, job.id
       for update of job
    loop
      begin
        update ocr.jobs set next_attempt_at = clock_timestamp(), correlation_id = correlation,
          row_version = row_version + 1
         where id = parked.id;
        resumed := resumed + 1;
      exception when check_violation then
        -- The document's evidence is no longer clean: the job stays parked
        -- and the claim would refuse it anyway.
        skipped := skipped + 1;
      end;
    end loop;
    perform set_config('app.facility_id', coalesce(session_facility, ''), true);
  end if;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    facility_id, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    correlation, 'platform', actor_subject, actor_account, null, null,
    'admin.ocr.page-limit.set', 'success', 'facility', requested_facility_id::text,
    'healthcare-operations', btrim(requested_reason), 'application', 'identity-api',
    jsonb_build_object('pagesLimit', requested_pages_limit, 'previousPagesLimit', coalesce(previous_limit, 500),
      'pagesUsed', state.pages_used, 'resetsOn', state.resets_on, 'paused', state.paused,
      'resumedJobs', resumed, 'skippedJobs', skipped)
  );
end
$$;

-- 2b. The fair claim: ocr.claim_worker_job's authorization, validation, lease
-- recovery and eligibility (its 0014 body with the column resolution 0015
-- gives it, written as the rds-compat body does, in the function), plus a
-- per-facility cap. Among eligible queued jobs it skips a facility that
-- already has requested_max_in_flight_per_facility (1-16) jobs processing
-- under an unexpired lease (any provider), and takes the job of the facility
-- with the fewest such jobs first, then next_attempt_at, queued_at, id, so one
-- facility's large upload cannot starve the others. Exact under concurrency
-- among fair claimers: the candidate's facility is taken with a transaction
-- advisory lock (try, never wait) and its in-flight count is read again after
-- it, so a second claimer counts only after the first claim committed, or
-- passes over that facility for this call. ocr.claim_worker_job is unchanged
-- and does not take that lock: a worker still on it can add its own claims.
create function ocr.claim_worker_job_fair(
  requested_provider text,
  requested_lease_seconds integer,
  requested_max_in_flight_per_facility integer
)
returns table (
  job_id uuid, facility_id uuid, document_id uuid, patient_id uuid,
  storage_bucket text, storage_key text, object_version_id text,
  source_sha256_hex text, size_bytes bigint, media_type text,
  provider text, attempt_no integer, max_attempts integer,
  claim_token uuid, claim_expires_at timestamptz, correlation_id text
) language plpgsql volatile security definer
set search_path = pg_catalog, ocr, ehr, audit, auth, platform, pg_temp as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  candidate ocr.jobs%rowtype;
  expired ocr.jobs%rowtype;
  new_token uuid := gen_random_uuid();
  passed_facilities uuid[] := '{}';
  in_flight integer;
  claim_round integer;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_provider is null or length(btrim(requested_provider)) not between 1 and 120
     or requested_lease_seconds is null or requested_lease_seconds not between 30 and 3600
     or requested_max_in_flight_per_facility is null
     or requested_max_in_flight_per_facility not between 1 and 16 then
    raise exception using errcode = '22023', message = 'Invalid OCR claim request';
  end if;

  -- Recover a bounded number of abandoned leases, as ocr.claim_worker_job.
  for expired in
    select * from ocr.jobs
     where status = 'processing' and provider = requested_provider
       and claim_expires_at <= clock_timestamp()
     order by claim_expires_at, id for update skip locked limit 10
  loop
    update ocr.jobs set status = 'failed', failed_at = clock_timestamp(),
      last_error_code = 'WORKER_LEASE_EXPIRED',
      last_error_summary = 'OCR worker lease expired before completion',
      claim_token = null, claim_expires_at = null, claimed_by_subject = null,
      row_version = row_version + 1 where id = expired.id;
    if expired.attempt_count < expired.max_attempts then
      update ocr.jobs set status = 'queued', started_at = null, failed_at = null,
        next_attempt_at = clock_timestamp(), row_version = row_version + 1
       where id = expired.id;
    end if;
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
      patient_id, action, outcome, resource_type, resource_id, provenance, details
    ) values (
      expired.correlation_id, 'workload', actor_subject, actor_account,
      expired.facility_id, expired.patient_id, 'ocr.worker.lease_recovered', 'failure',
      'ocr_job', expired.id::text, 'application',
      jsonb_build_object('errorCode', 'WORKER_LEASE_EXPIRED',
        'retryScheduled', expired.attempt_count < expired.max_attempts)
    );
  end loop;

  -- At most 16 rounds; each passes over one facility (at its cap after the
  -- lock, or locked by another claimer).
  for claim_round in 1..16 loop
    select job.* into candidate from ocr.jobs job
     join ehr.documents document on document.id = job.document_id
     where job.status = 'queued' and job.provider = requested_provider
       and job.next_attempt_at <= clock_timestamp() and job.attempt_count < job.max_attempts
       and job.facility_id <> all (passed_facilities)
       and document.status = 'uploaded'
       and document.object_version_id = job.source_object_version_id
       and document.sha256_hex = job.source_sha256_hex
       and exists (
         select 1 from ehr.document_scan_events scan
          where scan.id = (select latest.id from ehr.document_scan_events latest
            where latest.document_id = job.document_id
            order by latest.created_at desc, latest.id desc limit 1)
            and scan.event_type = 'clean'
            and scan.object_version_id = job.source_object_version_id
            and scan.object_sha256_hex = job.source_sha256_hex
            and scan.binding_migration_hold_reason is null
       )
       and (select count(*) from ocr.jobs busy
             where busy.facility_id = job.facility_id and busy.status = 'processing'
               and busy.claim_expires_at > clock_timestamp()) < requested_max_in_flight_per_facility
     order by (select count(*) from ocr.jobs busy
                where busy.facility_id = job.facility_id and busy.status = 'processing'
                  and busy.claim_expires_at > clock_timestamp()),
              job.next_attempt_at, job.queued_at, job.id
     for update of job skip locked limit 1;
    if candidate.id is null then return; end if;
    if pg_catalog.pg_try_advisory_xact_lock(
         pg_catalog.hashtextextended('hid.ocr.claim-facility:' || candidate.facility_id::text, 0)) then
      -- A new snapshot: every claim of this facility that held the lock
      -- before has committed.
      select count(*) into in_flight from ocr.jobs busy
       where busy.facility_id = candidate.facility_id and busy.status = 'processing'
         and busy.claim_expires_at > clock_timestamp();
      exit when in_flight < requested_max_in_flight_per_facility;
    end if;
    passed_facilities := passed_facilities || candidate.facility_id;
    candidate := null;
  end loop;
  if candidate.id is null then return; end if;

  update ocr.jobs job set status = 'processing', attempt_count = job.attempt_count + 1,
    started_at = clock_timestamp(), completed_at = null, failed_at = null,
    last_error_code = null, last_error_summary = null, claim_token = new_token,
    claim_expires_at = clock_timestamp() + make_interval(secs => requested_lease_seconds),
    claimed_by_subject = actor_subject, row_version = job.row_version + 1
   where job.id = candidate.id;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
    patient_id, action, outcome, resource_type, resource_id, provenance, details
  ) values (
    candidate.correlation_id, 'workload', actor_subject, actor_account,
    candidate.facility_id, candidate.patient_id, 'ocr.worker.claim', 'success',
    'ocr_job', candidate.id::text, 'application',
    jsonb_build_object('provider', requested_provider, 'attempt', candidate.attempt_count + 1,
      'maxInFlightPerFacility', requested_max_in_flight_per_facility, 'inFlightBefore', in_flight)
  );

  return query select job.id, job.facility_id, job.document_id, job.patient_id,
    document.storage_bucket, document.storage_key, job.source_object_version_id,
    job.source_sha256_hex::text, document.size_bytes, document.declared_media_type,
    job.provider, job.attempt_count, job.max_attempts, job.claim_token,
    job.claim_expires_at, job.correlation_id
   from ocr.jobs job join ehr.documents document on document.id = job.document_id
   where job.id = candidate.id;
end
$$;

-- 2c. AI usage per job attempt and model (counts only; no foreign key to
-- ocr.jobs, so Session C's 24-hour deletion of the job's working data never
-- waits on it or removes it).
create table ocr.ai_usage (
  job_id uuid not null,
  attempt_no integer not null check (attempt_no between 1 and 10),
  model text not null check (model ~ '^claude-[a-z0-9-]+$' and length(model) <= 100),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  usage_month date not null check (usage_month = date_trunc('month', usage_month)::date),
  requests integer not null check (requests >= 0),
  input_tokens bigint not null check (input_tokens >= 0),
  output_tokens bigint not null check (output_tokens >= 0),
  cache_read_tokens bigint not null check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null check (cache_write_tokens >= 0),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (job_id, attempt_no, model)
);
create index ocr_ai_usage_facility_month_idx on ocr.ai_usage (facility_id, usage_month);
alter table ocr.ai_usage enable row level security;
alter table ocr.ai_usage force row level security;
revoke all on ocr.ai_usage from public;
comment on table ocr.ai_usage is
  '0110: AI reading usage (requests and token counts) per OCR job attempt and Claude model, in the Africa/Lagos month of the first recording. Counts only, no patient or page text; no foreign key to ocr.jobs so it outlives the job''s working data. Only the 0110 SECURITY DEFINER functions touch it.';

-- The worker records the AI usage of the attempt it holds, per model.
-- Idempotent per (job, current attempt, model): the given totals replace the
-- stored ones; an audit row only when something changed.
create function ocr.record_worker_ai_usage(
  requested_job_id uuid, requested_claim_token uuid, requested_model text, requested_requests integer,
  requested_input_tokens bigint, requested_output_tokens bigint, requested_cache_read_tokens bigint,
  requested_cache_write_tokens bigint, requested_correlation_id text
) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, audit, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  job_row ocr.jobs%rowtype;
  stored_attempt integer;
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_model is null or length(requested_model) > 100 or requested_model !~ '^claude-[a-z0-9-]+$'
     or requested_requests is null or requested_requests < 0
     or requested_input_tokens is null or requested_input_tokens < 0
     or requested_output_tokens is null or requested_output_tokens < 0
     or requested_cache_read_tokens is null or requested_cache_read_tokens < 0
     or requested_cache_write_tokens is null or requested_cache_write_tokens < 0 then
    raise exception using errcode = '22023', message = 'Invalid OCR AI usage';
  end if;
  if requested_claim_token is null then
    raise exception using errcode = '55000', message = 'OCR claim is not active';
  end if;
  select * into job_row from ocr.jobs job where job.id = requested_job_id for update;
  if job_row.id is null or job_row.status is distinct from 'processing'
     or job_row.claim_token is distinct from requested_claim_token
     or job_row.claimed_by_subject is distinct from actor_subject
     or job_row.claim_expires_at is null
     or job_row.claim_expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'OCR claim is not active';
  end if;
  insert into ocr.ai_usage as usage_row (job_id, attempt_no, model, facility_id, usage_month, requests,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
  values (job_row.id, job_row.attempt_count, requested_model, job_row.facility_id,
          date_trunc('month', clock_timestamp() at time zone 'Africa/Lagos')::date, requested_requests,
          requested_input_tokens, requested_output_tokens, requested_cache_read_tokens,
          requested_cache_write_tokens)
  on conflict (job_id, attempt_no, model) do update
     set requests = excluded.requests, input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens,
         cache_write_tokens = excluded.cache_write_tokens, recorded_at = clock_timestamp()
   where (usage_row.requests, usage_row.input_tokens, usage_row.output_tokens, usage_row.cache_read_tokens,
          usage_row.cache_write_tokens)
         is distinct from (excluded.requests, excluded.input_tokens, excluded.output_tokens,
          excluded.cache_read_tokens, excluded.cache_write_tokens)
  returning usage_row.attempt_no into stored_attempt;
  if stored_attempt is not null then
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
      patient_id, action, outcome, resource_type, resource_id, provenance, details
    ) values (
      requested_correlation_id, 'workload', actor_subject, actor_account,
      job_row.facility_id, job_row.patient_id, 'ocr.worker.ai_usage_recorded', 'success',
      'ocr_job', job_row.id::text, 'application',
      jsonb_build_object('attempt', stored_attempt, 'model', requested_model, 'requests', requested_requests,
        'inputTokens', requested_input_tokens, 'outputTokens', requested_output_tokens,
        'cacheReadTokens', requested_cache_read_tokens, 'cacheWriteTokens', requested_cache_write_tokens)
    );
  end if;
end
$$;

-- A facility's OCR usage in one Africa/Lagos month (the month containing
-- requested_month; NULL is the current one): one row per Claude model and
-- one row 'textract' with the pages counted (tokens 0). The same callers as
-- ocr.facility_page_allowance.
create function ocr.facility_ocr_usage(requested_facility_id uuid, requested_month date)
returns table (model text, requests bigint, input_tokens bigint, output_tokens bigint,
  cache_read_tokens bigint, cache_write_tokens bigint, pages bigint)
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, auth, identity, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := platform.current_account_id();
  session_facility uuid := platform.current_facility_id();
  session_membership uuid := platform.current_membership_id();
  platform_scoped boolean := session_facility is null and session_membership is null;
  wanted_month date := date_trunc('month',
    coalesce(requested_month, (clock_timestamp() at time zone 'Africa/Lagos')::date))::date;
begin
  if requested_facility_id is null or actor_account is null
     or not coalesce((not platform_scoped
              and session_facility = requested_facility_id and session_membership is not null
              and auth.membership_has_permission(actor_subject, session_membership, requested_facility_id,
                'ocr.job.read'))
          or (platform_scoped
              and auth.account_has_platform_permission(actor_account, 'platform.admin.access')), false) then
    raise exception using errcode = '42501', message = 'OCR usage access is required';
  end if;
  if not exists (select 1 from identity.facilities facility where facility.id = requested_facility_id) then
    raise exception using errcode = 'P0002', message = 'Facility not found';
  end if;
  return query
    select usage_row.model, sum(usage_row.requests)::bigint, sum(usage_row.input_tokens)::bigint,
           sum(usage_row.output_tokens)::bigint, sum(usage_row.cache_read_tokens)::bigint,
           sum(usage_row.cache_write_tokens)::bigint, 0::bigint
      from ocr.ai_usage usage_row
     where usage_row.facility_id = requested_facility_id and usage_row.usage_month = wanted_month
     group by usage_row.model
    union all
    select 'textract'::text, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
           coalesce((select sum(page_row.pages) from ocr.page_usage page_row
                      where page_row.facility_id = requested_facility_id
                        and page_row.usage_month = wanted_month), 0)::bigint
    order by 1;
end
$$;

-- 3. The OCR job trigger (0077's body) with one more allowed transition: a
-- job parked by the page allowance may be resumed earlier.
create or replace function ocr.validate_job_write()
returns trigger language plpgsql security definer
set search_path = ocr, ehr, identity, auth, platform, pg_temp as $$
declare document_row record; latest_scan record; scan_found boolean; binds_source boolean;
  leaves_play boolean;
begin
  select document.id, document.patient_id, document.facility_id, document.object_version_id,
         document.sha256_hex, document.status into document_row
    from ehr.documents document where document.id = new.document_id;
  select scan.event_type, scan.object_version_id, scan.object_sha256_hex,
         scan.binding_migration_hold_reason into latest_scan
    from ehr.document_scan_events scan where scan.document_id = new.document_id
   order by scan.created_at desc, scan.id desc limit 1;
  scan_found := found;
  binds_source := tg_op = 'INSERT';
  if tg_op = 'UPDATE' then
    binds_source := new.document_id is distinct from old.document_id
      or new.source_object_version_id is distinct from old.source_object_version_id
      or new.source_sha256_hex is distinct from old.source_sha256_hex
      or (new.status = 'processing' and old.status is distinct from 'processing');
  end if;
  leaves_play := tg_op = 'UPDATE' and not binds_source
    and (new.status in ('failed', 'cancelled') or (old.status = 'failed' and new.status = 'queued'));
  if not leaves_play and (document_row.id is null or document_row.facility_id is distinct from new.facility_id
     or document_row.object_version_id is distinct from new.source_object_version_id
     or document_row.sha256_hex is distinct from new.source_sha256_hex
     or document_row.status is distinct from 'uploaded'
     or (binds_source and not scan_found)
     or (scan_found and (latest_scan.event_type is distinct from 'clean'
       or latest_scan.object_version_id is distinct from new.source_object_version_id
       or latest_scan.object_sha256_hex is distinct from new.source_sha256_hex
       or latest_scan.binding_migration_hold_reason is not null))) then
    raise exception using errcode = '23514', message = 'OCR requires exact clean immutable document evidence';
  end if;
  if new.patient_id is not null and new.patient_id is distinct from document_row.patient_id then
    raise exception using errcode = '23514', message = 'OCR patient association must match the canonical document patient';
  end if;
  if tg_op = 'UPDATE' then
    if new.facility_id is distinct from old.facility_id or new.document_id is distinct from old.document_id
       or new.patient_id is distinct from old.patient_id
       or new.source_object_version_id is distinct from old.source_object_version_id
       or new.source_sha256_hex is distinct from old.source_sha256_hex
       or new.operation is distinct from old.operation
       or new.idempotency_key is distinct from old.idempotency_key
       or new.request_sha256 is distinct from old.request_sha256
       or new.provider is distinct from old.provider or new.created_by is distinct from old.created_by
       or new.created_by_membership_id is distinct from old.created_by_membership_id
       or new.row_version is distinct from old.row_version + 1 then
      raise exception using errcode = '55000', message = 'OCR job identity is immutable and updates require the next version';
    end if;
    if not ((old.status = 'queued' and new.status in ('processing', 'cancelled'))
      or (old.status = 'processing' and new.status in ('extracted', 'failed'))
      or (old.status = 'extracted' and new.status = 'awaiting_validation')
      or (old.status = 'awaiting_validation' and new.status in ('validated', 'rejected'))
      or (old.status = 'failed' and new.status in ('queued', 'cancelled'))
      or (old.status = 'processing' and new.status = 'processing'
        and old.claim_token is not null and old.claim_expires_at > clock_timestamp()
        and new.claim_expires_at > old.claim_expires_at
        and new.claim_expires_at <= clock_timestamp() + interval '3600 seconds'
        and (to_jsonb(new) - array['claim_expires_at', 'row_version', 'updated_at'])
          = (to_jsonb(old) - array['claim_expires_at', 'row_version', 'updated_at']))
      or (old.status = 'queued' and new.status = 'queued'
        and old.last_error_code is not distinct from 'OCR_PAGE_ALLOWANCE_USED_UP'
        and new.next_attempt_at < old.next_attempt_at
        and new.next_attempt_at >= clock_timestamp() - interval '1 minute'
        and (to_jsonb(new) - array['next_attempt_at', 'correlation_id', 'row_version', 'updated_at'])
          = (to_jsonb(old) - array['next_attempt_at', 'correlation_id', 'row_version', 'updated_at']))) then
      raise exception using errcode = '23514', message = 'Invalid OCR job state transition';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end
$$;

-- Owner, policies, ACLs. New objects belong to the OCR functions' owner (the
-- applier, or the owner it acts as), whose policy is the tables' only one.
do $$
declare
  ocr_owner name := (select pg_get_userbyid(relowner) from pg_class where oid = 'ocr.jobs'::regclass);
begin
  if ocr_owner <> current_user then
    execute format('alter table ocr.facility_page_limits owner to %I', ocr_owner);
    execute format('alter table ocr.page_usage owner to %I', ocr_owner);
    execute format('alter function ocr.facility_page_allowance_state(uuid) owner to %I', ocr_owner);
    execute format('alter function ocr.worker_page_allowance(uuid,uuid) owner to %I', ocr_owner);
    execute format('alter function ocr.record_worker_pages(uuid,uuid,integer,text) owner to %I', ocr_owner);
    execute format('alter function ocr.pause_worker_job_for_allowance(uuid,uuid,text) owner to %I', ocr_owner);
    execute format('alter function ocr.facility_page_allowance(uuid) owner to %I', ocr_owner);
    execute format('alter function ocr.set_facility_page_limit(uuid,integer,text) owner to %I', ocr_owner);
    execute format('alter table ocr.ai_usage owner to %I', ocr_owner);
    execute format('alter function ocr.claim_worker_job_fair(text,integer,integer) owner to %I', ocr_owner);
    execute format('alter function ocr.record_worker_ai_usage(uuid,uuid,text,integer,bigint,bigint,bigint,bigint,text) owner to %I', ocr_owner);
    execute format('alter function ocr.facility_ocr_usage(uuid,date) owner to %I', ocr_owner);
  end if;
  execute format('create policy facility_page_limits_owner on ocr.facility_page_limits for all '
    || 'using (current_user = %L) with check (current_user = %L)', ocr_owner, ocr_owner);
  execute format('create policy page_usage_owner on ocr.page_usage for all '
    || 'using (current_user = %L) with check (current_user = %L)', ocr_owner, ocr_owner);
  execute format('create policy ai_usage_owner on ocr.ai_usage for all '
    || 'using (current_user = %L) with check (current_user = %L)', ocr_owner, ocr_owner);
end
$$;

revoke all on function ocr.facility_page_allowance_state(uuid),
  ocr.worker_page_allowance(uuid,uuid),
  ocr.record_worker_pages(uuid,uuid,integer,text),
  ocr.pause_worker_job_for_allowance(uuid,uuid,text),
  ocr.facility_page_allowance(uuid),
  ocr.set_facility_page_limit(uuid,integer,text),
  ocr.claim_worker_job_fair(text,integer,integer),
  ocr.record_worker_ai_usage(uuid,uuid,text,integer,bigint,bigint,bigint,bigint,text),
  ocr.facility_ocr_usage(uuid,date) from public;

comment on function ocr.worker_page_allowance(uuid,uuid) is
  '0110: the OCR worker reads the page allowance of the facility of the job it holds (pages used this Africa/Lagos month, limit, next reset, paused).';
comment on function ocr.record_worker_pages(uuid,uuid,integer,text) is
  '0110: the OCR worker records the pages read for the job it holds; idempotent per job (the larger count is kept).';
comment on function ocr.pause_worker_job_for_allowance(uuid,uuid,text) is
  '0110: the OCR worker parks the job it holds until the facility''s allowance resets (00:00 Africa/Lagos on resets_on) without using an attempt; NULL and nothing changed unless the allowance is used up and the job''s pages are not yet counted.';
comment on function ocr.facility_page_allowance(uuid) is
  '0110: the facility''s OCR page allowance for its staff holding ocr.job.read, or a platform administrator in a platform-scoped session.';
comment on function ocr.set_facility_page_limit(uuid,integer,text) is
  '0110: a platform super admin (platform_super_admin only) sets a facility''s monthly OCR page limit; raising it above this month''s use resumes the facility''s parked jobs.';
comment on function ocr.claim_worker_job_fair(text,integer,integer) is
  '0110: ocr.claim_worker_job with a per-facility cap (1-16 jobs processing under an unexpired lease) and the least busy facility first; the facility is taken with a transaction advisory lock, so the cap is exact among fair claimers.';
comment on function ocr.record_worker_ai_usage(uuid,uuid,text,integer,bigint,bigint,bigint,bigint,text) is
  '0110: the OCR worker records the AI reading usage (requests and tokens) of the attempt it holds, per Claude model; the totals given replace the stored ones.';
comment on function ocr.facility_ocr_usage(uuid,date) is
  '0110: a facility''s OCR usage in one Africa/Lagos month: one row per Claude model and one row textract with the pages; the callers of ocr.facility_page_allowance.';

-- 4. Grants (the same in runtime-grants.sql's 0110 block). A release applies
-- only migrations, so the roles that already exist get them here; on a fresh
-- database (no runtime roles yet, as 0082 and 0097) the role bootstrap makes
-- them.
do $$
declare
  wanted record;
begin
  for wanted in
    select * from (values
      ('hid_ocr_worker', 'usage on schema ocr'),
      ('hid_ocr_runtime', 'usage on schema ocr'),
      ('hid_identity_runtime', 'usage on schema ocr'),
      ('hid_ocr_worker', 'execute on function ocr.worker_page_allowance(uuid,uuid), '
        || 'ocr.record_worker_pages(uuid,uuid,integer,text), ocr.pause_worker_job_for_allowance(uuid,uuid,text), '
        || 'ocr.claim_worker_job_fair(text,integer,integer), '
        || 'ocr.record_worker_ai_usage(uuid,uuid,text,integer,bigint,bigint,bigint,bigint,text)'),
      ('hid_ocr_runtime', 'execute on function ocr.facility_page_allowance(uuid), ocr.facility_ocr_usage(uuid,date)'),
      ('hid_identity_runtime', 'execute on function ocr.facility_page_allowance(uuid), ocr.facility_ocr_usage(uuid,date)'),
      ('hid_identity_runtime', 'execute on function ocr.set_facility_page_limit(uuid,integer,text)'))
      grant_row(grantee, privilege)
     where exists (select 1 from pg_roles where rolname = grant_row.grantee)
  loop
    execute format('grant %s to %I', wanted.privilege, wanted.grantee);
  end loop;
end
$$;

-- 5. Post-checks.
do $$
declare
  mismatch text;
  ocr_owner oid := (select relowner from pg_class where oid = 'ocr.jobs'::regclass);
begin
  if (select md5(prosrc) from pg_proc where oid = 'ocr.validate_job_write()'::regprocedure)
     is distinct from '58ff61a5b9b95685f6a6d3f938b8481f' then
    mismatch := 'the body of ocr.validate_job_write()';
  end if;
  if mismatch is null and exists (
       select 1 from ocr_page_allowance_0110_acl before_row
         left join pg_proc proc on proc.oid = before_row.function_oid
        where proc.oid is null or proc.proowner <> before_row.proowner
           or proc.proacl::text is distinct from before_row.proacl::text
           or not proc.prosecdef or proc.provolatile <> 'v'
           or proc.proconfig is distinct from '{"search_path=ocr, ehr, identity, auth, platform, pg_temp"}'::text[]) then
    mismatch := 'the owner, ACL or attributes of ocr.validate_job_write()';
  end if;
  -- The fair claim's body (its md5 here; ocr.claim_worker_job untouched).
  if mismatch is null
     and (select md5(prosrc) from pg_proc where oid = 'ocr.claim_worker_job_fair(text,integer,integer)'::regprocedure)
         is distinct from 'b4e08bc13b9f0a38ed52c0e84f73ff6c' then
    mismatch := 'the body of ocr.claim_worker_job_fair(text,integer,integer)';
  end if;
  if mismatch is null
     and (select md5(prosrc) from pg_proc where oid = 'ocr.claim_worker_job(text,integer)'::regprocedure)
         <> all (array['1572865c10fcfb673293e83776d6cf50', '59a60b466df9b8effeb3519939fc54a2']) then
    mismatch := 'the body of ocr.claim_worker_job(text,integer) (must stay unchanged)';
  end if;
  -- The eight commands: SECURITY DEFINER, pinned search_path, the OCR owner.
  if mismatch is null then
    select string_agg(proc.oid::regprocedure::text, ', ') into mismatch
      from pg_proc proc
     where proc.oid in ('ocr.worker_page_allowance(uuid,uuid)'::regprocedure,
         'ocr.record_worker_pages(uuid,uuid,integer,text)'::regprocedure,
         'ocr.pause_worker_job_for_allowance(uuid,uuid,text)'::regprocedure,
         'ocr.facility_page_allowance(uuid)'::regprocedure,
         'ocr.set_facility_page_limit(uuid,integer,text)'::regprocedure,
         'ocr.claim_worker_job_fair(text,integer,integer)'::regprocedure,
         'ocr.record_worker_ai_usage(uuid,uuid,text,integer,bigint,bigint,bigint,bigint,text)'::regprocedure,
         'ocr.facility_ocr_usage(uuid,date)'::regprocedure)
       and (not proc.prosecdef or proc.proowner <> ocr_owner or proc.proconfig is null
            or proc.proconfig[1] not like 'search_path=pg_catalog, ocr, %');
    if mismatch is not null then mismatch := 'attributes of ' || mismatch; end if;
  end if;
  if mismatch is null and exists (
       select 1 from pg_proc proc where proc.oid = 'ocr.facility_page_allowance_state(uuid)'::regprocedure
          and (proc.prosecdef or proc.proowner <> ocr_owner)) then
    mismatch := 'attributes of ocr.facility_page_allowance_state(uuid)';
  end if;
  -- EXECUTE exactly as granted above.
  if mismatch is null then
    select string_agg(format('%s to %s', proc.oid::regprocedure, coalesce(grantee.rolname, 'PUBLIC')), '; ')
      into mismatch
      from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
      left join pg_roles grantee on grantee.oid = privilege.grantee
     where proc.pronamespace = 'ocr'::regnamespace
       and proc.proname in ('facility_page_allowance_state', 'worker_page_allowance', 'record_worker_pages',
         'pause_worker_job_for_allowance', 'facility_page_allowance', 'set_facility_page_limit',
         'claim_worker_job_fair', 'record_worker_ai_usage', 'facility_ocr_usage')
       and privilege.grantee <> proc.proowner
       and (proc.proname, coalesce(grantee.rolname, 'PUBLIC')) not in (
         ('worker_page_allowance', 'hid_ocr_worker'), ('record_worker_pages', 'hid_ocr_worker'),
         ('pause_worker_job_for_allowance', 'hid_ocr_worker'),
         ('claim_worker_job_fair', 'hid_ocr_worker'), ('record_worker_ai_usage', 'hid_ocr_worker'),
         ('facility_page_allowance', 'hid_ocr_runtime'), ('facility_page_allowance', 'hid_identity_runtime'),
         ('facility_ocr_usage', 'hid_ocr_runtime'), ('facility_ocr_usage', 'hid_identity_runtime'),
         ('set_facility_page_limit', 'hid_identity_runtime'));
    if mismatch is not null then mismatch := 'unexpected EXECUTE: ' || mismatch; end if;
  end if;
  -- The tables: the OCR owner's, row-level security forced, one owner policy
  -- each, and no privilege for anyone else.
  if mismatch is null and (select count(*) from pg_class class_row
        where class_row.oid in ('ocr.facility_page_limits'::regclass, 'ocr.page_usage'::regclass,
                                'ocr.ai_usage'::regclass)
          and class_row.relowner = ocr_owner and class_row.relrowsecurity and class_row.relforcerowsecurity
          and (select count(*) from pg_policy policy_row where policy_row.polrelid = class_row.oid) = 1
          and not exists (select 1 from aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) privilege
                           where privilege.grantee <> class_row.relowner)) <> 3 then
    mismatch := 'the owner, row-level security, policy or ACL of the 0110 tables';
  end if;
  -- ocr.ai_usage and ocr.page_usage have no foreign key to ocr.jobs.
  if mismatch is null and exists (
       select 1 from pg_constraint constraint_row
        where constraint_row.conrelid in ('ocr.ai_usage'::regclass, 'ocr.page_usage'::regclass)
          and constraint_row.contype = 'f' and constraint_row.confrelid = 'ocr.jobs'::regclass) then
    mismatch := 'a foreign key from a 0110 usage table to ocr.jobs';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0110: post-check failed: %s', mismatch);
  end if;
end;
$$;
