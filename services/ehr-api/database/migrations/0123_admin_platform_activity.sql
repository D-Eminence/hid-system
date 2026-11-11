-- 0123 Admin dashboard activity (owner request of 2026-11-11, D-Eminence: the
-- super admin Overview shows people, care activity, Migrate and Ask, a daily
-- chart and the latest sign-ups and uploads for the last 7, 30 or 90 days).
-- Numbered 0123: 0109-0121 are held by open pull requests and 0122 by the
-- collect sign-up fields plan. Unsigned: the declaration's reviewed_by stays
-- empty until the owner signs it.
--
-- The change (additive only; no table, column, row or existing function body
-- is changed):
-- 1. The permission platform.dashboard.read ("Read the platform activity
--    dashboard"), granted to the role platform_super_admin and to no other
--    role. Today's super admins get it at once (the Identity API reads
--    platform permissions afresh at each session resolution).
-- 2. identity.admin_platform_activity(p_days integer) returns jsonb: a
--    read of counts plus at most ten recent sign-ups and ten recent uploads,
--    for the Identity API's GET /api/v1/admin/overview/activity.
--    - Refuses 42501 ADMIN_PERMISSION_DENIED unless the session's account
--      (platform.current_account_id(), as 0027/0098's admin_platform_overview)
--      holds platform.dashboard.read; refuses 22023 ADMIN_INVALID_DAYS for
--      anything but 7, 30 or 90.
--    - Writes one audit.events row per call: actor_type 'platform', action
--      admin.overview.activity.read, resource_type platform-dashboard,
--      details {"days": n} and nothing else (no counts, names or ids).
--    - Names, emails and Health IDs are shortened inside this function and
--      never leave the database whole: "Ada O." (first name and the last
--      name's initial), "a***@gmail.com" (the account email's first character
--      and its domain), "HID-7K…M9" (the first two and last two characters of
--      the code). No part of an upload's file name leaves the database: only
--      its kind, from the last extension on an allowlist (pdf -> "PDF"; jpg,
--      jpeg, png, heic, tif, tiff -> "Image"; docx -> "Word"), and
--      "Document" for anything else ("Ada.Okonkwo", "x.pdf.exe", no
--      extension).
--    - The sealed demo tenant (0098) is left out of every number and list,
--      as admin_platform_overview does: demo patients, accounts and the four
--      demo facilities.
--    - The period is calendar days in Africa/Lagos ending today: p_days days
--      starting at local midnight p_days - 1 days ago; the previous period is
--      the p_days days before it.
--    SECURITY DEFINER, VOLATILE (it writes the audit row), plpgsql, owned by
--    the applier, search_path pinned; EXECUTE for hid_identity_runtime and
--    hid_schema_test_runtime only (here and in runtime-grants.sql).
--
-- What each number counts (in the period unless said otherwise):
--   people.accounts            auth.accounts not deleted (now)
--   people.verifiedPct         patients (not deleted) whose assurance state is
--                              NIN_VERIFIED, % of patients (null with none)
--   people.profilesCompletePct patients at profile_percent 100, % (null with none)
--   people.activeInPeriod      accounts with a session issued or used
--   people.sharedWithFacility  patients with an active, unexpired share (0095) now
--   people.accessPins          patients with an active Access PIN now
--   people.newInPeriod / prevNewInPeriod  patients created in this / the previous period
--   care.healthRecords         clinical notes + vitals + diagnoses created
--   care.visits                encounters created
--   care.labRequests           lab requests created
--   care.prescriptions         prescriptions created
--   care.emergencyAccess       break-glass grants created
--   care.outreachSignups       outreach registration cases created
--   migrateAsk.pagesRead       OCR pages recorded (ocr.page_usage)
--   migrateAsk.recordsMoved    OCR publications published
--   migrateAsk.questionsAnswered  staff "Ask about this patient" answers that
--                              are ready (saved messages only; a cleared
--                              conversation's messages are no longer counted)
--   migrateAsk.answersWithSourcesPct  of those, % with at least one source
--   daily[]                    per local day: patients created, and accounts
--                              with a session issued or last used that day
--                              (one grouped pass over each table, joined to
--                              the days; see Cost)
--   recentSignups[]            latest ten patients (not deleted); status
--                              suspended (account locked/disabled or patient
--                              inactive), verified (NIN_VERIFIED) or pending
--   recentUploads[]            latest ten uploaded or rejected documents;
--                              scan clean / refused (rejected or failed scan,
--                              or a rejected document) / pending
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied): every
--    table, column and helper read exists; not applied yet.
-- 1. The permission and its one role grant.
-- 2. The read window: identity.admin_activity_read_windows and the helper
--    identity.admin_activity_read_open() (see section 2).
-- 3. The function, the name shortener and the file-kind label, their ACLs.
-- 4. The eleven read-window policies: one SELECT policy, for the applier role
--    only, on each FORCE row-level-security table the read counts, last, after
--    their locks (see Locks). No other policy, table or grant changes.
-- 5. Post-checks.
--
-- Locks: CREATE POLICY takes ACCESS EXCLUSIVE on its table, so section 4
-- first takes all eleven in one LOCK TABLE ... IN ACCESS EXCLUSIVE MODE
-- NOWAIT, in a fixed order (ehr.clinical_notes, ehr.diagnoses,
-- ehr.document_scan_events, ehr.documents, ehr.encounters, ehr.lab_requests,
-- ehr.prescriptions, ehr.staff_chat_messages, ehr.vitals, ocr.publications,
-- outreach.registration_cases), retried every 10 ms for at most 5 seconds
-- (then 55P03 "... stayed busy for 5 seconds; run the release again later",
-- nothing applied). A NOWAIT attempt never queues, so a busy table never
-- makes the release block the others' readers and writers, and a failed
-- attempt releases what it took. Once held they are kept only for the
-- eleven CREATE POLICY statements and the post-checks, to commit. Sections
-- 0-3 take ROW EXCLUSIVE on auth.permissions and auth.role_permissions (two
-- inserted rows) and catalog locks only. The measured locks and timings are in
-- config/production-schema-compatibility.json.
--
-- Cost: every count is one pass over its table filtered on created_at (or the
-- session's issued_at / last_used_at) since the period's start; daily[] groups
-- each source by local day once and joins the result to the days, so days=90
-- reads each table once, not once per day. No index is added: auth.sessions
-- has none on issued_at or last_used_at and identity.patients and
-- ehr.documents none on created_at alone, so these passes are sequential
-- scans whose cost grows with the table, not with the days asked for.
--
-- Old services on this schema: nothing calls the new function until the
-- Identity API image with the activity route is deployed; the existing
-- overview and every other route are unchanged.

do $$
declare
  missing text;
begin
  if to_regprocedure('identity.admin_platform_activity(integer)') is not null then
    raise exception using errcode = '55000', message = '0123: already applied';
  end if;
  select string_agg(expected.proc, '; ') into missing
    from (values ('identity.sealed_demo_ids(text)'), ('auth.account_has_platform_permission(uuid,text)'),
                 ('platform.current_account_id()'), ('platform.current_actor_subject()'),
                 ('platform.current_correlation_id()')) expected(proc)
   where to_regprocedure(expected.proc) is null;
  if missing is null then
    select string_agg(expected.relation || '.' || expected.attribute, '; ') into missing
      from (values
        ('auth.accounts', 'email'), ('auth.accounts', 'status'), ('auth.permissions', 'code'),
        ('auth.role_permissions', 'permission_code'), ('auth.roles', 'code'),
        ('auth.sessions', 'account_id'), ('auth.sessions', 'issued_at'), ('auth.sessions', 'last_used_at'),
        ('identity.patients', 'first_name'), ('identity.patients', 'last_name'), ('identity.patients', 'full_name'),
        ('identity.patients', 'hid_code'), ('identity.patients', 'profile_percent'), ('identity.patients', 'account_id'),
        ('identity.patients', 'status'), ('identity.patients', 'created_at'),
        ('identity.patient_assurance_states', 'state'), ('identity.patient_access_pins', 'status'),
        ('identity.patient_consent_shares', 'consent_grant_id'), ('identity.consent_grants', 'break_glass'),
        ('identity.consent_grants', 'expires_at'), ('identity.facilities', 'name'),
        ('ehr.clinical_notes', 'facility_id'), ('ehr.vitals', 'facility_id'), ('ehr.diagnoses', 'facility_id'),
        ('ehr.encounters', 'facility_id'), ('ehr.lab_requests', 'facility_id'), ('ehr.prescriptions', 'facility_id'),
        ('ehr.documents', 'original_file_name'), ('ehr.documents', 'size_bytes'),
        ('ehr.document_scan_events', 'event_type'), ('ehr.staff_chat_messages', 'reply'),
        ('ehr.staff_chat_messages', 'facility_id'), ('ocr.page_usage', 'pages'), ('ocr.page_usage', 'recorded_at'),
        ('ocr.publications', 'completed_at'), ('outreach.registration_cases', 'facility_id'),
        ('audit.events', 'details')) expected(relation, attribute)
     where not exists (select 1 from pg_attribute attribute_row
                        where attribute_row.attrelid = to_regclass(expected.relation)
                          and attribute_row.attname = expected.attribute and not attribute_row.attisdropped);
  end if;
  if missing is null and not exists (select 1 from auth.roles where code = 'platform_super_admin') then
    missing := 'the role platform_super_admin';
  end if;
  if missing is not null then
    raise exception using errcode = '55000', message = '0123: missing ' || missing;
  end if;
end
$$;

-- 1. The permission, for the platform super admin only.
insert into auth.permissions (code, description)
values ('platform.dashboard.read', 'Read the platform activity dashboard')
on conflict (code) do update set description = excluded.description, active = true;
insert into auth.role_permissions (role_code, permission_code)
values ('platform_super_admin', 'platform.dashboard.read')
on conflict (role_code, permission_code) do nothing;

-- 2. The read window. Eleven of the tables the read counts have row-level
-- security FORCED (ehr.encounters, clinical_notes, vitals, diagnoses,
-- prescriptions, lab_requests, documents, document_scan_events,
-- staff_chat_messages, ocr.publications, outreach.registration_cases), so a
-- SECURITY DEFINER owner that is neither superuser nor BYPASSRLS (production)
-- would see none of their rows and every count would read 0. Each gains one
-- SELECT policy (section 4) for the applier role only (no runtime role is a member of it,
-- so no runtime query ever evaluates it), true only while
-- identity.admin_platform_activity holds a window open: a row of
-- identity.admin_activity_read_windows for this backend and this transaction,
-- which the function inserts after its permission check and deletes before it
-- writes its audit row and returns. Nothing else runs as the owner inside that
-- window, a refusal or error rolls the row back with the call, and no role is
-- granted anything on the window table or the helper.
create table identity.admin_activity_read_windows (
  backend_pid integer not null,
  transaction_id xid8 not null,
  opened_at timestamptz not null default clock_timestamp(),
  primary key (backend_pid, transaction_id)
);
alter table identity.admin_activity_read_windows enable row level security;
revoke all on table identity.admin_activity_read_windows from public;

create function identity.admin_activity_read_open()
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from identity.admin_activity_read_windows read_window
                  where read_window.backend_pid = pg_backend_pid()
                    and read_window.transaction_id = pg_current_xact_id_if_assigned())
$$;

-- 3. The read.
create function identity.admin_platform_activity(p_days integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  local_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  first_day date;
  period_start timestamptz;
  previous_start timestamptz;
  demo_patients uuid[] := coalesce(identity.sealed_demo_ids('patient'), '{}');
  demo_accounts uuid[] := coalesce(identity.sealed_demo_ids('account'), '{}');
  demo_facilities uuid[] := coalesce(identity.sealed_demo_ids('facility'), '{}');
  patient_total bigint;
  active_total bigint;
  people jsonb;
  care jsonb;
  migrate_ask jsonb;
  daily jsonb;
  recent_signups jsonb;
  recent_uploads jsonb;
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.dashboard.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if p_days is null or p_days not in (7, 30, 90) then
    raise exception using errcode = '22023', message = 'ADMIN_INVALID_DAYS';
  end if;
  first_day := local_today - (p_days - 1);
  period_start := first_day::timestamp at time zone 'Africa/Lagos';
  previous_start := (first_day - p_days)::timestamp at time zone 'Africa/Lagos';

  -- Open the read window (section 2) for this transaction.
  insert into identity.admin_activity_read_windows (backend_pid, transaction_id)
  values (pg_backend_pid(), pg_current_xact_id())
  on conflict (backend_pid, transaction_id) do nothing;

  select count(*) into patient_total from identity.patients patient
   where patient.status <> 'deleted' and patient.id <> all (demo_patients);

  -- Sessions touched in the period: one pass over auth.sessions, each session
  -- giving the local day it was issued and the day it was last used (when in
  -- the period). daily[] and activeInPeriod both come from this pass.
  with touched as materialized (
    select session_row.account_id, (touch.at_time at time zone 'Africa/Lagos')::date as day
      from auth.sessions session_row
      cross join lateral (values (session_row.issued_at), (session_row.last_used_at)) touch(at_time)
     where (session_row.issued_at >= period_start or session_row.last_used_at >= period_start)
       and touch.at_time >= period_start
       and session_row.account_id <> all (demo_accounts)),
  active_by_day as (
    select touched.day, count(distinct touched.account_id) as active from touched group by touched.day),
  signups_by_day as (
    select (patient.created_at at time zone 'Africa/Lagos')::date as day, count(*) as signups
      from identity.patients patient
     where patient.created_at >= period_start and patient.status <> 'deleted'
       and patient.id <> all (demo_patients)
     group by 1)
  select (select count(distinct touched.account_id) from touched),
         coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(day_row.day, 'YYYY-MM-DD'),
           'signups', coalesce(signups_by_day.signups, 0),
           'activeAccounts', coalesce(active_by_day.active, 0)) order by day_row.day), '[]'::jsonb)
    into active_total, daily
    from (select generate_series(first_day, local_today, interval '1 day')::date as day) day_row
    left join signups_by_day on signups_by_day.day = day_row.day
    left join active_by_day on active_by_day.day = day_row.day;

  select jsonb_build_object(
    'accounts', (select count(*) from auth.accounts account
                  where account.status <> 'deleted' and account.id <> all (demo_accounts)),
    'verifiedPct', case when patient_total = 0 then null else
      round(100.0 * (select count(*) from identity.patients patient
                      join identity.patient_assurance_states assurance on assurance.patient_id = patient.id
                     where patient.status <> 'deleted' and patient.id <> all (demo_patients)
                       and assurance.state = 'NIN_VERIFIED') / patient_total)::integer end,
    'profilesCompletePct', case when patient_total = 0 then null else
      round(100.0 * (select count(*) from identity.patients patient
                     where patient.status <> 'deleted' and patient.id <> all (demo_patients)
                       and patient.profile_percent >= 100) / patient_total)::integer end,
    'activeInPeriod', active_total,
    'sharedWithFacility', (select count(distinct share.patient_id) from identity.patient_consent_shares share
                            join identity.consent_grants grant_row on grant_row.id = share.consent_grant_id
                           where grant_row.status = 'active' and grant_row.revoked_at is null
                             and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp())
                             and share.patient_id <> all (demo_patients)),
    'accessPins', (select count(*) from identity.patient_access_pins pin
                    where pin.status = 'active' and pin.patient_id <> all (demo_patients)),
    'newInPeriod', (select count(*) from identity.patients patient
                     where patient.created_at >= period_start and patient.status <> 'deleted'
                       and patient.id <> all (demo_patients)),
    'prevNewInPeriod', (select count(*) from identity.patients patient
                         where patient.created_at >= previous_start and patient.created_at < period_start
                           and patient.status <> 'deleted' and patient.id <> all (demo_patients)))
  into people;

  select jsonb_build_object(
    'healthRecords',
      (select count(*) from ehr.clinical_notes note
        where note.created_at >= period_start and note.facility_id <> all (demo_facilities))
      + (select count(*) from ehr.vitals vital
          where vital.created_at >= period_start and vital.facility_id <> all (demo_facilities))
      + (select count(*) from ehr.diagnoses diagnosis
          where diagnosis.created_at >= period_start and diagnosis.facility_id <> all (demo_facilities)),
    'visits', (select count(*) from ehr.encounters encounter
                where encounter.created_at >= period_start and encounter.facility_id <> all (demo_facilities)),
    'labRequests', (select count(*) from ehr.lab_requests lab_request
                     where lab_request.created_at >= period_start and lab_request.facility_id <> all (demo_facilities)),
    'prescriptions', (select count(*) from ehr.prescriptions prescription
                       where prescription.created_at >= period_start
                         and prescription.facility_id <> all (demo_facilities)),
    'emergencyAccess', (select count(*) from identity.consent_grants grant_row
                         where grant_row.break_glass and grant_row.created_at >= period_start
                           and grant_row.facility_id <> all (demo_facilities)),
    'outreachSignups', (select count(*) from outreach.registration_cases registration
                         where registration.created_at >= period_start
                           and registration.facility_id <> all (demo_facilities)))
  into care;

  select jsonb_build_object(
    'pagesRead', (select coalesce(sum(usage.pages), 0) from ocr.page_usage usage
                   where usage.recorded_at >= period_start and usage.facility_id <> all (demo_facilities)),
    'recordsMoved', (select count(*) from ocr.publications publication
                      where publication.status = 'published' and publication.completed_at >= period_start
                        and publication.facility_id <> all (demo_facilities)),
    'questionsAnswered', answers.answered,
    'answersWithSourcesPct', case when answers.answered = 0 then null
      else round(100.0 * answers.with_sources / answers.answered)::integer end)
  into migrate_ask
  from (select count(*) as answered,
               count(*) filter (where jsonb_array_length(message.reply -> 'sources') > 0) as with_sources
          from ehr.staff_chat_messages message
         where message.created_at >= period_start and message.reply ->> 'status' = 'ready'
           and (message.facility_id is null or message.facility_id <> all (demo_facilities))) answers;

  select coalesce(jsonb_agg(signup.item order by signup.created_at desc, signup.id), '[]'::jsonb)
    into recent_signups
    from (select patient.id, patient.created_at, jsonb_build_object(
            'name', identity.admin_activity_short_name(patient.first_name, patient.last_name, patient.full_name),
            'email', case when account.email is null or position('@' in account.email) < 2 then null
                     else left(account.email, 1) || '***@' || split_part(account.email, '@', 2) end,
            'healthId', 'HID-' || left(substr(patient.hid_code, 5), 2) || '…' || right(patient.hid_code, 2),
            'profilePct', greatest(0, least(100, coalesce(patient.profile_percent, 0))),
            'status', case when account.status in ('locked', 'disabled') or patient.status = 'inactive' then 'suspended'
                           when assurance.state = 'NIN_VERIFIED' then 'verified' else 'pending' end,
            'createdAt', patient.created_at) as item
            from identity.patients patient
            left join auth.accounts account on account.id = patient.account_id
            left join identity.patient_assurance_states assurance on assurance.patient_id = patient.id
           where patient.status <> 'deleted' and patient.id <> all (demo_patients)
           order by patient.created_at desc, patient.id
           limit 10) signup;

  select coalesce(jsonb_agg(upload.item order by upload.created_at desc, upload.id), '[]'::jsonb)
    into recent_uploads
    from (select document.id, document.created_at, jsonb_build_object(
            'document', identity.admin_activity_file_kind(document.original_file_name),
            'patient', identity.admin_activity_short_name(patient.first_name, patient.last_name, patient.full_name),
            'facility', facility.name,
            'sizeBytes', document.size_bytes,
            'scan', case when document.status = 'rejected' or scan.event_type in ('rejected', 'failed') then 'refused'
                         when scan.event_type = 'clean' then 'clean' else 'pending' end,
            'createdAt', document.created_at) as item
            from ehr.documents document
            join identity.facilities facility on facility.id = document.facility_id
            left join identity.patients patient on patient.id = document.patient_id
            left join lateral (select scan_event.event_type from ehr.document_scan_events scan_event
                                where scan_event.document_id = document.id
                                order by scan_event.created_at desc, scan_event.id desc limit 1) scan on true
           where document.status in ('uploaded', 'rejected')
             and document.facility_id <> all (demo_facilities)
             and (document.patient_id is null or document.patient_id <> all (demo_patients))
           order by document.created_at desc, document.id
           limit 10) upload;

  -- Close the read window before anything else runs.
  delete from identity.admin_activity_read_windows read_window
   where read_window.backend_pid = pg_backend_pid() and read_window.transaction_id = pg_current_xact_id();

  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
    resource_type, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
    'admin.overview.activity.read', 'success', 'platform-dashboard', 'healthcare-operations',
    'application', 'identity-api', jsonb_build_object('days', p_days));

  return jsonb_build_object(
    'days', p_days,
    'generatedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'people', people, 'care', care, 'migrateAsk', migrate_ask, 'daily', daily,
    'recentSignups', recent_signups, 'recentUploads', recent_uploads);
end
$$;

-- The name shortener and the file-kind label: pure, immutable, and granted to no role (the read
-- calls them as their owner).
create function identity.admin_activity_short_name(first_name text, last_name text, full_name text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when nullif(btrim(coalesce(first_name, '')), '') is not null then
      left(btrim(first_name), 40)
      || coalesce(' ' || upper(left(nullif(btrim(coalesce(last_name, '')), ''), 1)) || '.', '')
    when nullif(btrim(coalesce(full_name, '')), '') is not null then
      left(split_part(btrim(full_name), ' ', 1), 40)
      || coalesce(' ' || upper(left(nullif(split_part(regexp_replace(btrim(full_name), '\s+', ' ', 'g'), ' ', 2), ''), 1)) || '.', '')
    else 'Unnamed' end
$$;

-- The upload's kind, never any part of its name: the last extension when it
-- is on the allowlist, else "Document".
create function identity.admin_activity_file_kind(file_name text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case lower(substring(btrim(coalesce(file_name, '')) from '\.([A-Za-z0-9]+)$'))
    when 'pdf' then 'PDF'
    when 'jpg' then 'Image' when 'jpeg' then 'Image' when 'png' then 'Image' when 'heic' then 'Image'
    when 'tif' then 'Image' when 'tiff' then 'Image'
    when 'docx' then 'Word'
    else 'Document' end
$$;

revoke all on function identity.admin_platform_activity(integer),
  identity.admin_activity_short_name(text, text, text),
  identity.admin_activity_file_kind(text),
  identity.admin_activity_read_open() from public;

do $$
declare grantee text;
begin
  foreach grantee in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant execute on function identity.admin_platform_activity(integer) to %I', grantee);
    end if;
  end loop;
end
$$;

-- 4. The eleven read-window policies, last: their locks up front in one
-- bounded NOWAIT attempt (see Locks), then the policies, then the checks.
do $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.clinical_notes, ehr.diagnoses, ehr.document_scan_events, ehr.documents, ehr.encounters,
        ehr.lab_requests, ehr.prescriptions, ehr.staff_chat_messages, ehr.vitals, ocr.publications,
        outreach.registration_cases
        in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0123: a table that gets a read-window policy stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

do $$
declare
  target text;
begin
  foreach target in array array['ehr.clinical_notes', 'ehr.diagnoses', 'ehr.document_scan_events', 'ehr.documents',
    'ehr.encounters', 'ehr.lab_requests', 'ehr.prescriptions', 'ehr.staff_chat_messages', 'ehr.vitals',
    'ocr.publications', 'outreach.registration_cases'] loop
    execute format('create policy %I on %s as permissive for select to %I using (identity.admin_activity_read_open())',
      (select relname from pg_class where oid = target::regclass) || '_admin_activity_read', target, current_user);
  end loop;
end
$$;

-- 5. Post-checks.
do $$
declare
  applier oid := (select oid from pg_roles where rolname = current_user);
  mismatch text;
begin
  if not exists (select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                  where proc.oid = 'identity.admin_platform_activity(integer)'::regprocedure
                    and language_row.lanname = 'plpgsql' and proc.prosecdef and proc.provolatile = 'v'
                    and proc.proowner = applier
                    and proc.proconfig = '{"search_path=pg_catalog, identity, auth, audit, platform, pg_temp"}') then
    mismatch := 'identity.admin_platform_activity attributes';
  elsif exists (select 1 from pg_proc proc where proc.oid in (
                   'identity.admin_activity_short_name(text,text,text)'::regprocedure,
                   'identity.admin_activity_file_kind(text)'::regprocedure)
                  and (proc.prosecdef or proc.provolatile <> 'i' or proc.proowner <> applier)) then
    mismatch := 'the name shortener''s or file-kind label''s attributes';
  elsif exists (select 1 from pg_proc proc where proc.oid = 'identity.admin_activity_read_open()'::regprocedure
                  and (proc.prosecdef or proc.proowner <> applier))
     or not exists (select 1 from pg_class relation
                     where relation.oid = 'identity.admin_activity_read_windows'::regclass
                       and relation.relowner = applier and relation.relrowsecurity)
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polrelid = 'identity.admin_activity_read_windows'::regclass)
     or exists (select 1 from pg_class relation,
                  aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                 where relation.oid = 'identity.admin_activity_read_windows'::regclass
                   and acl.grantee <> relation.relowner) then
    mismatch := 'the read window table or its helper';
  elsif (select count(*) from pg_policy policy_row
          where policy_row.polname like '%\_admin\_activity\_read'
            and policy_row.polcmd = 'r' and policy_row.polpermissive and policy_row.polroles = array[applier]
            and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'identity.admin_activity_read_open()'
            and policy_row.polwithcheck is null
            and policy_row.polrelid in ('ehr.encounters'::regclass, 'ehr.clinical_notes'::regclass,
              'ehr.vitals'::regclass, 'ehr.diagnoses'::regclass, 'ehr.prescriptions'::regclass,
              'ehr.lab_requests'::regclass, 'ehr.documents'::regclass, 'ehr.document_scan_events'::regclass,
              'ehr.staff_chat_messages'::regclass, 'ocr.publications'::regclass,
              'outreach.registration_cases'::regclass)) <> 11
     or (select count(*) from pg_policy policy_row
          where pg_get_expr(policy_row.polqual, policy_row.polrelid) like '%admin_activity_read_open%') <> 11 then
    mismatch := 'the eleven read-window policies';
  elsif exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid in ('identity.admin_platform_activity(integer)'::regprocedure,
                                    'identity.admin_activity_short_name(text,text,text)'::regprocedure,
                                    'identity.admin_activity_file_kind(text)'::regprocedure,
                                    'identity.admin_activity_read_open()'::regprocedure)
                   and acl.grantee <> proc.proowner
                   and not (proc.oid = 'identity.admin_platform_activity(integer)'::regprocedure
                            and acl.grantee in (select oid from pg_roles
                                                 where rolname in ('hid_identity_runtime', 'hid_schema_test_runtime'))
                            and acl.privilege_type = 'EXECUTE')) then
    mismatch := 'an ACL beyond the owner and the Identity runtime';
  elsif (select array_agg(role_permission.role_code order by role_permission.role_code)
           from auth.role_permissions role_permission
          where role_permission.permission_code = 'platform.dashboard.read')
        is distinct from array['platform_super_admin'] then
    mismatch := 'platform.dashboard.read is granted to a role other than platform_super_admin';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0123: post-check failed: ' || mismatch;
  end if;
end
$$;
