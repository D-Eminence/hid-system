-- Imported legacy medical history (owner decision 3 of 2026-10-16, ADR-065).
-- Applied migrations 0001 through 0095 are immutable.
--
-- Patients and staff may see the medical history imported from the legacy
-- system: its records, every version of each and the metadata of their
-- files, exactly as the legacy system held them, never turned into
-- encounters, notes or signatures, and never part of either record summary.
--
-- 0. A database that holds the PR #8 branch's imported history objects (its
--    0061 and 0062, which gave every consent at any facility the whole
--    history and gave the schema owner a bypass policy) is refused with
--    55000 IMPORTED_HISTORY_BRANCH_OBJECTS_PRESENT before anything is
--    created: such a staging database is rebuilt from main first (release
--    checklist P36).
--
-- 1. Three append-only tables, ehr.imported_medical_records, their versions
--    and their files, each keeping the legacy row as staged (source_payload,
--    whose checksum is the sealed staging checksum), its legacy author's
--    account, whether the patient or a clinician wrote it, and the sealed
--    staging run it came from. They force row-level security and are
--    written only by the import command below.
--
-- 2. The patient's sharing choice, identity.imported_history_sharing (off
--    until the patient turns it on; no row means off), and its append-only
--    change log identity.imported_history_sharing_events. Both force
--    row-level security; only the two session-bound commands below change
--    or read them.
--
-- 3. Two PUBLIC SELECT policies on each imported table, so the EHR runtime's
--    own reads are filtered:
--    - imported_history_patient_self_read: the 0091 patient-self binding
--      (ehr.patient_self_context, whose EXECUTE stays with hid_ehr_runtime
--      and the test role, PSELF-RLS) in a transaction whose
--      app.patient_release names importedHistory, which PatientRecordRelease
--      binds only while its own flag is on. A patient needs no sharing
--      choice to see their own history.
--    - imported_history_staff_read: ehr.imported_history_staff_read_allowed,
--      true only for the purpose direct-care, an ehr.context_allows pass for
--      the patient at the selected facility (an active, unheld, unexpired
--      standard consent of the selected membership and no deny directive;
--      break-glass grants count only for the purpose emergency, which is
--      refused here), the membership holding ehr.imported-history.read, the
--      patient's sharing choice, and a login that is not deleted. When all
--      hold, the patient's whole imported history is disclosed as one unit:
--      it has no source facility or encounter that a facility-bound consent
--      could narrow (ADR-065).
--    No policy admits an INSERT, UPDATE or DELETE by any role named here;
--    the technical owners' policies are created by the role bootstrap
--    (runtime-grants.sql), where those roles exist.
--
-- 4. Four SECURITY DEFINER functions with search_path pg_catalog, pg_temp,
--    revoked from PUBLIC; the role bootstrap gives each to a NOLOGIN
--    technical owner whose privileges are exactly what its body reads and
--    writes (no owner bypass of row-level security is relied on, so they
--    work under a schema owner that is neither a superuser nor BYPASSRLS):
--    - ehr.imported_history_staff_read_allowed(uuid) and the patient's
--      identity.my_imported_history_sharing(text, uuid) and
--      identity.set_my_imported_history_sharing(text, uuid, boolean), owned
--      by hid_imported_history_commands. The two commands take the patient
--      from identity.patient_self_session (a live, unrevoked patient session
--      of an active login, bound to the acting subject) and refuse anything
--      else with 42501; a change is recorded with its session and
--      correlation id, and a repeat changes nothing.
--    - ehr.import_legacy_medical_history(uuid, uuid, text, jsonb), owned by
--      hid_imported_history_importer, executable by hid_migration_admin
--      only. It imports only from main's sealed staging pipeline: the parent
--      run must be the reconciled, verified legacy identity run
--      (stage-legacy-identity.mjs, promote-legacy-identity.mjs and
--      reconcile-legacy-identity.mjs), the history run a sealed staging run
--      of the same source snapshot holding only the three history categories
--      (stage-legacy-identity.mjs --scope=imported-history), and the
--      supplied rows exactly that run's sealed rows. Every patient, author
--      and uploader is resolved through the parent run's sealed identity
--      rows. Rows are inserted once (a repeat changes nothing) and a stored
--      row that differs is refused; a receipt run records the counts.
--
-- 5. The permission ehr.imported-history.read, held by doctor, clinician and
--    nurse (the roles that read notes); the staff route needs it as well.
--
-- Not included (ADR-065): imported attachments, scan evidence, downloads and
-- health profiles; the imported inbox; the imported customer configuration
-- archive and any administrator read of it; a staff historical inbox; and
-- any change to the patient summary, the emergency (break-glass) summary or
-- any other route. This migration moves no data: the import command runs
-- only when an operator runs it, on staging, after the DPO and the owner have
-- signed off (release checklist P36).
--
-- Locks: creating the foreign keys takes SHARE ROW EXCLUSIVE on
-- identity.patients, auth.accounts and migration.runs, and the permission
-- rows take row locks on auth.permissions and auth.role_permissions, until
-- the migration commits; everything else creates new objects. Each waits at
-- most the runner's 5 s lock timeout; a timeout rolls 0096 back whole, and it
-- can be run again.

-- 0. A database built from the PR #8 branch is reconciled first.
do $$
begin
  if to_regclass('ehr.imported_medical_records') is not null
     or to_regclass('ehr.imported_medical_record_versions') is not null
     or to_regclass('ehr.imported_medical_record_files') is not null
     or to_regclass('ehr.imported_patient_health_profiles') is not null
     or to_regclass('ehr.imported_attachment_bindings') is not null
     or to_regclass('ehr.imported_attachment_scan_events') is not null
     or to_regclass('notification.imported_inbox_items') is not null
     or to_regclass('notification.imported_inbox_reads') is not null
     or to_regclass('platform.imported_customer_configuration') is not null
     or to_regclass('platform.imported_configuration_mappings') is not null
     or to_regclass('migration.customer_table_dispositions') is not null
     or exists (select 1 from pg_proc proc join pg_namespace namespace_row on namespace_row.oid = proc.pronamespace
                 where namespace_row.nspname = 'ehr' and proc.proname = 'imported_record_read_context')
     or exists (select 1 from migration.schema_migrations
                 where version in ('0061_imported_medical_records.sql', '0062_customer_history_access.sql')) then
    raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_BRANCH_OBJECTS_PRESENT',
      detail = 'This database holds imported history objects of the PR #8 branch; rebuild it from main first (ADR-065).';
  end if;
end
$$;

-- 1. The imported history.
create table ehr.imported_medical_records (
  id uuid primary key,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  author_account_id uuid not null references auth.accounts(id) on delete restrict,
  origin text not null check (origin in ('patient-provided', 'provider-authored')),
  current_version_id uuid not null,
  source_run_id uuid not null references migration.runs(id) on delete restrict,
  source_payload jsonb not null check (jsonb_typeof(source_payload) = 'object'),
  source_sha256 char(64) not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_created_at timestamptz not null,
  source_updated_at timestamptz not null,
  imported_at timestamptz not null default clock_timestamp(),
  unique (id, patient_id)
);
create table ehr.imported_medical_record_versions (
  id uuid primary key,
  record_id uuid not null,
  patient_id uuid not null,
  version_no integer not null check (version_no > 0),
  author_account_id uuid not null references auth.accounts(id) on delete restrict,
  origin text not null check (origin in ('patient-provided', 'provider-authored')),
  source_payload jsonb not null check (jsonb_typeof(source_payload) = 'object'),
  source_sha256 char(64) not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_created_at timestamptz not null,
  imported_at timestamptz not null default clock_timestamp(),
  foreign key (record_id, patient_id) references ehr.imported_medical_records(id, patient_id) on delete restrict,
  unique (record_id, version_no),
  unique (id, record_id, patient_id)
);
alter table ehr.imported_medical_records add constraint imported_current_version
  foreign key (current_version_id, id, patient_id)
  references ehr.imported_medical_record_versions(id, record_id, patient_id)
  deferrable initially deferred;
create table ehr.imported_medical_record_files (
  id uuid primary key,
  record_id uuid not null,
  patient_id uuid not null,
  record_version_id uuid,
  uploader_account_id uuid not null references auth.accounts(id) on delete restrict,
  source_payload jsonb not null check (jsonb_typeof(source_payload) = 'object'),
  source_sha256 char(64) not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_created_at timestamptz not null,
  imported_at timestamptz not null default clock_timestamp(),
  foreign key (record_id, patient_id) references ehr.imported_medical_records(id, patient_id) on delete restrict,
  foreign key (record_version_id, record_id, patient_id)
    references ehr.imported_medical_record_versions(id, record_id, patient_id) on delete restrict,
  unique (id, patient_id)
);
-- The read order of both routes: newest first, with the id as tie-breaker.
create index imported_medical_records_patient_idx
  on ehr.imported_medical_records (patient_id, source_created_at desc, id desc);
create index imported_medical_record_versions_record_idx
  on ehr.imported_medical_record_versions (record_id, version_no desc);
create index imported_medical_record_files_record_idx
  on ehr.imported_medical_record_files (record_id, source_created_at, id);

-- 2. The patient's sharing choice and its change log.
create table identity.imported_history_sharing (
  patient_id uuid primary key references identity.patients(id) on delete restrict,
  shared boolean not null default false,
  row_version bigint not null default 1 check (row_version > 0),
  updated_at timestamptz not null default clock_timestamp(),
  updated_session_id uuid not null
);
create table identity.imported_history_sharing_events (
  id bigint generated always as identity primary key,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  shared boolean not null,
  row_version bigint not null check (row_version > 0),
  session_id uuid not null,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  occurred_at timestamptz not null default clock_timestamp(),
  unique (patient_id, row_version)
);

-- Row-level security forced on all five; no PUBLIC privilege; the imported
-- history and the change log are append-only.
alter table ehr.imported_medical_records enable row level security;
alter table ehr.imported_medical_records force row level security;
alter table ehr.imported_medical_record_versions enable row level security;
alter table ehr.imported_medical_record_versions force row level security;
alter table ehr.imported_medical_record_files enable row level security;
alter table ehr.imported_medical_record_files force row level security;
alter table identity.imported_history_sharing enable row level security;
alter table identity.imported_history_sharing force row level security;
alter table identity.imported_history_sharing_events enable row level security;
alter table identity.imported_history_sharing_events force row level security;
revoke all on ehr.imported_medical_records, ehr.imported_medical_record_versions, ehr.imported_medical_record_files,
  identity.imported_history_sharing, identity.imported_history_sharing_events from public;
create trigger imported_history_no_mutation
  before update or delete on ehr.imported_medical_records
  for each row execute function platform.reject_mutation();
create trigger imported_history_no_mutation
  before update or delete on ehr.imported_medical_record_versions
  for each row execute function platform.reject_mutation();
create trigger imported_history_no_mutation
  before update or delete on ehr.imported_medical_record_files
  for each row execute function platform.reject_mutation();
create trigger imported_history_sharing_events_no_mutation
  before update or delete on identity.imported_history_sharing_events
  for each row execute function platform.reject_mutation();
revoke all on sequence identity.imported_history_sharing_events_id_seq from public;

-- 4a. The staff read decision.
create function ehr.imported_history_staff_read_allowed(requested_patient uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    requested_patient is not null
    and platform.current_purpose_of_use() = 'direct-care'
    and ehr.context_allows(requested_patient, platform.current_facility_id(), 'read_records')
    and auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
      platform.current_facility_id(), 'ehr.imported-history.read')
    and exists (
      select 1 from identity.imported_history_sharing sharing
       where sharing.patient_id = requested_patient and sharing.shared)
    and exists (
      select 1 from identity.patients patient
        join auth.accounts account_row on account_row.id = patient.account_id
       where patient.id = requested_patient and account_row.status <> 'deleted'),
    false)
$$;
revoke all on function ehr.imported_history_staff_read_allowed(uuid) from public;
comment on function ehr.imported_history_staff_read_allowed(uuid) is
  'True only for direct care with a standard consent at the selected facility, the membership holding ehr.imported-history.read, the patient''s sharing choice and a login that is not deleted (ADR-065). Never true under break-glass. Owned by hid_imported_history_commands.';

-- 3. The read policies of the imported tables.
create policy imported_history_patient_self_read on ehr.imported_medical_records for select
  using ('importedHistory' = any(string_to_array(current_setting('app.patient_release', true), ','))
    and ehr.patient_self_context(patient_id));
create policy imported_history_staff_read on ehr.imported_medical_records for select
  using (ehr.imported_history_staff_read_allowed(patient_id));
create policy imported_history_patient_self_read on ehr.imported_medical_record_versions for select
  using ('importedHistory' = any(string_to_array(current_setting('app.patient_release', true), ','))
    and ehr.patient_self_context(patient_id));
create policy imported_history_staff_read on ehr.imported_medical_record_versions for select
  using (ehr.imported_history_staff_read_allowed(patient_id));
create policy imported_history_patient_self_read on ehr.imported_medical_record_files for select
  using ('importedHistory' = any(string_to_array(current_setting('app.patient_release', true), ','))
    and ehr.patient_self_context(patient_id));
create policy imported_history_staff_read on ehr.imported_medical_record_files for select
  using (ehr.imported_history_staff_read_allowed(patient_id));

-- 4b. The patient's own sharing choice.
create function identity.my_imported_history_sharing(requested_subject text, requested_session uuid)
returns table (shared boolean, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_patient uuid := identity.patient_self_session(requested_subject, requested_session);
begin
  if session_patient is null then
    raise exception using errcode = '42501', message = 'PATIENT_SELF_SESSION_REQUIRED';
  end if;
  return query
    select coalesce(choice.shared, false), choice.updated_at
      from (select 1) one_row
      left join identity.imported_history_sharing choice on choice.patient_id = session_patient;
end
$$;

create function identity.set_my_imported_history_sharing(requested_subject text, requested_session uuid,
  requested_shared boolean)
returns table (shared boolean, changed boolean, updated_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_patient uuid := identity.patient_self_session(requested_subject, requested_session);
  correlation text := nullif(current_setting('app.correlation_id', true), '');
  current_shared boolean;
  current_version bigint;
  current_updated timestamptz;
begin
  if session_patient is null or correlation is null then
    raise exception using errcode = '42501', message = 'PATIENT_SELF_SESSION_REQUIRED';
  end if;
  if requested_shared is null then
    raise exception using errcode = '22023', message = 'IMPORTED_HISTORY_SHARING_CHOICE_REQUIRED';
  end if;
  select choice.shared, choice.row_version, choice.updated_at
    into current_shared, current_version, current_updated
    from identity.imported_history_sharing choice
   where choice.patient_id = session_patient
   for update;
  if not found then
    if not requested_shared then
      return query select false, false, null::timestamptz;
      return;
    end if;
    insert into identity.imported_history_sharing as choice (patient_id, shared, row_version, updated_at,
      updated_session_id)
    values (session_patient, true, 1, clock_timestamp(), requested_session)
    on conflict (patient_id) do nothing
    returning choice.shared, choice.row_version, choice.updated_at
      into current_shared, current_version, current_updated;
    if found then
      insert into identity.imported_history_sharing_events (patient_id, shared, row_version, session_id, correlation_id)
      values (session_patient, true, current_version, requested_session, correlation);
      return query select true, true, current_updated;
      return;
    end if;
    -- A concurrent first choice made the row: lock it and decide against it.
    select choice.shared, choice.row_version, choice.updated_at
      into current_shared, current_version, current_updated
      from identity.imported_history_sharing choice
     where choice.patient_id = session_patient
     for update;
  end if;
  if current_shared = requested_shared then
    return query select current_shared, false, current_updated;
    return;
  end if;
  update identity.imported_history_sharing as choice
     set shared = requested_shared, row_version = choice.row_version + 1, updated_at = clock_timestamp(),
         updated_session_id = requested_session
   where choice.patient_id = session_patient
  returning choice.shared, choice.row_version, choice.updated_at
    into current_shared, current_version, current_updated;
  insert into identity.imported_history_sharing_events (patient_id, shared, row_version, session_id, correlation_id)
  values (session_patient, current_shared, current_version, requested_session, correlation);
  return query select current_shared, true, current_updated;
end
$$;
revoke all on function identity.my_imported_history_sharing(text, uuid),
  identity.set_my_imported_history_sharing(text, uuid, boolean) from public;
comment on function identity.my_imported_history_sharing(text, uuid) is
  'The session patient''s choice to share imported legacy history with the facilities they approve (off when never made), through identity.patient_self_session; 42501 otherwise (ADR-065).';
comment on function identity.set_my_imported_history_sharing(text, uuid, boolean) is
  'Sets the session patient''s imported history sharing choice and records the change with its session and correlation id; a repeat changes nothing; 42501 for anything but a live patient session of the acting subject (ADR-065).';

-- 4c. The import command.
create function ehr.import_legacy_medical_history(parent_run uuid, history_run uuid, operator text, supplied jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  history_types constant text[] := array['medical_record_files', 'medical_record_versions', 'medical_records'];
  uuid_shape constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  parent_row record;
  history_row record;
  item record;
  record_patient uuid;
  patient_account text;
  author_profile text;
  author_staff text;
  author_account uuid;
  author_origin text;
  counts jsonb;
  inserted_records integer := 0;
  inserted_versions integer := 0;
  inserted_files integer := 0;
  added integer;
  receipt uuid;
  receipt_notes text;
begin
  if operator is null or length(btrim(operator)) not between 3 and 200 or supplied is null
     or jsonb_typeof(supplied) <> 'array' then
    raise exception using errcode = '22023', message = 'IMPORTED_HISTORY_INPUT_INVALID';
  end if;

  -- The parent: main's reconciled, verified legacy identity run, without conflicts.
  select run.source_system, run.mode, run.status, run.source_snapshot, run.source_checksum_sha256
    into parent_row from migration.runs run where run.id = parent_run;
  if not found or parent_row.source_system is distinct from 'legacy_identity'
     or parent_row.mode is distinct from 'reconcile' or parent_row.status is distinct from 'verified'
     or parent_row.source_checksum_sha256 is null
     or exists (select 1 from migration.conflicts conflict where conflict.run_id = parent_run) then
    raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_PARENT_NOT_VERIFIED';
  end if;

  -- The history: a sealed staging run of the same snapshot, of exactly the three categories.
  select run.source_system, run.mode, run.status, run.source_snapshot, run.source_counts, run.source_checksum_sha256
    into history_row from migration.runs run where run.id = history_run;
  if not found or history_run = parent_run or history_row.source_system is distinct from 'legacy_identity'
     or history_row.mode is distinct from 'stage' or history_row.status is distinct from 'staged'
     or history_row.source_checksum_sha256 is null
     or exists (select 1 from migration.conflicts conflict where conflict.run_id = history_run) then
    raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_RUN_NOT_SEALED';
  end if;
  if history_row.source_snapshot is distinct from parent_row.source_snapshot then
    raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_SNAPSHOT_MISMATCH';
  end if;
  if (select coalesce(array_agg(key order by key collate "C"), '{}') from jsonb_object_keys(history_row.source_counts) key)
       is distinct from history_types
     or exists (select 1 from migration.source_rows source where source.run_id = history_run
                 and source.entity_type <> all(history_types))
     or exists (select 1 from unnest(history_types) category(name)
                 where jsonb_typeof(history_row.source_counts -> category.name) is distinct from 'number'
                    or (history_row.source_counts ->> category.name)::bigint <> (
                      select count(*) from migration.source_rows source
                       where source.run_id = history_run and source.entity_type = category.name)) then
    raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_CATEGORY_MISMATCH';
  end if;

  -- The supplied rows are exactly the sealed rows: none missing, none added,
  -- none repeated, each with its sealed payload and checksum.
  if jsonb_array_length(supplied) <> (select count(*) from migration.source_rows source where source.run_id = history_run)
     or exists (
       select 1 from jsonb_array_elements(supplied) element
        where jsonb_typeof(element) <> 'object' or jsonb_typeof(element -> 'payload') is distinct from 'object'
           or not exists (
             select 1 from migration.source_rows source
              where source.run_id = history_run and source.entity_type = element ->> 'entityType'
                and source.source_pk = element ->> 'sourcePk' and source.payload = element -> 'payload'
                and btrim(source.payload_sha256) = element ->> 'payloadSha256'))
     or (select count(distinct (element ->> 'entityType', element ->> 'sourcePk')) from jsonb_array_elements(supplied) element)
        <> jsonb_array_length(supplied) then
    raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_ROWS_DIFFER';
  end if;

  -- Records: the patient and the author through the parent's sealed identity rows.
  for item in
    select source.source_pk, source.payload, btrim(source.payload_sha256) as payload_sha256
      from migration.source_rows source
     where source.run_id = history_run and source.entity_type = 'medical_records'
     order by source.source_pk
  loop
    if item.source_pk !~ uuid_shape or item.payload ->> 'id' is distinct from item.source_pk
       or coalesce(item.payload ->> 'patient_id', '') !~ uuid_shape
       or coalesce(item.payload ->> 'current_version_id', '') !~ uuid_shape
       or pg_input_is_valid(item.payload ->> 'created_at', 'timestamptz') is not true
       or pg_input_is_valid(item.payload ->> 'updated_at', 'timestamptz') is not true then
      raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_RECORD_INVALID';
    end if;
    record_patient := (item.payload ->> 'patient_id')::uuid;
    author_profile := item.payload ->> 'created_by_user_profile_id';
    author_staff := item.payload ->> 'created_by_staff_account_id';
    -- The author, through the parent run's sealed identity rows (below, as for versions).
    <<record_author>>
    begin
      select patient_row.payload ->> 'auth_user_id' into patient_account from migration.source_rows patient_row
       where patient_row.run_id = parent_run and patient_row.entity_type = 'patients'
         and patient_row.source_pk = record_patient::text;
      if patient_account is null then
        raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_BINDING_DIFFERS';
      end if;
      select (profile_row.payload ->> 'auth_user_id')::uuid into author_account
        from migration.source_rows profile_row
        join migration.source_rows account_row on account_row.run_id = parent_run
         and account_row.entity_type = 'accounts' and account_row.source_pk = profile_row.payload ->> 'auth_user_id'
       where profile_row.run_id = parent_run and profile_row.entity_type = 'user_profiles'
         and profile_row.source_pk = author_profile
         and coalesce(profile_row.payload ->> 'auth_user_id', '') ~ uuid_shape;
      if author_account is null then
        raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_AUTHOR_UNRESOLVED';
      end if;
      if author_account::text = patient_account and author_staff is null then
        author_origin := 'patient-provided';
      elsif author_account::text <> patient_account and (select count(*) from migration.source_rows staff_row
              where staff_row.run_id = parent_run and staff_row.entity_type = 'staff'
                and staff_row.payload ->> 'auth_user_id' = author_account::text
                and (author_staff is null or staff_row.source_pk = author_staff)) = 1 then
        author_origin := 'provider-authored';
      else
        raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_AUTHOR_UNRESOLVED';
      end if;
    end record_author;
    if not exists (select 1 from migration.source_rows version_row
                    where version_row.run_id = history_run and version_row.entity_type = 'medical_record_versions'
                      and version_row.source_pk = item.payload ->> 'current_version_id'
                      and version_row.payload ->> 'record_id' = item.source_pk) then
      raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_BINDING_DIFFERS';
    end if;
    insert into ehr.imported_medical_records (id, patient_id, author_account_id, origin, current_version_id,
      source_run_id, source_payload, source_sha256, source_created_at, source_updated_at)
    values (item.source_pk::uuid, record_patient, author_account, author_origin,
      (item.payload ->> 'current_version_id')::uuid, history_run, item.payload, item.payload_sha256,
      (item.payload ->> 'created_at')::timestamptz, (item.payload ->> 'updated_at')::timestamptz)
    on conflict (id) do nothing;
    get diagnostics added = row_count;
    inserted_records := inserted_records + added;
    if not exists (select 1 from ehr.imported_medical_records stored
                    where stored.id = item.source_pk::uuid and stored.patient_id = record_patient
                      and stored.author_account_id = author_account and stored.origin = author_origin
                      and stored.current_version_id = (item.payload ->> 'current_version_id')::uuid
                      and stored.source_payload = item.payload and stored.source_sha256 = item.payload_sha256
                      and stored.source_created_at = (item.payload ->> 'created_at')::timestamptz
                      and stored.source_updated_at = (item.payload ->> 'updated_at')::timestamptz) then
      raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_DIFFERS';
    end if;
  end loop;

  -- Versions: of a record of this run, numbered from 1 once each, with content.
  for item in
    select source.source_pk, source.payload, btrim(source.payload_sha256) as payload_sha256
      from migration.source_rows source
     where source.run_id = history_run and source.entity_type = 'medical_record_versions'
     order by source.source_pk
  loop
    select (record_row.payload ->> 'patient_id')::uuid into record_patient
      from migration.source_rows record_row
     where record_row.run_id = history_run and record_row.entity_type = 'medical_records'
       and record_row.source_pk = item.payload ->> 'record_id';
    if item.source_pk !~ uuid_shape or item.payload ->> 'id' is distinct from item.source_pk or record_patient is null then
      raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_BINDING_DIFFERS';
    end if;
    if jsonb_typeof(item.payload -> 'version_no') is distinct from 'number'
       or (item.payload ->> 'version_no') !~ '^[1-9][0-9]{0,8}$'
       or pg_input_is_valid(item.payload ->> 'created_at', 'timestamptz') is not true
       or (select count(*) from migration.source_rows other
            where other.run_id = history_run and other.entity_type = 'medical_record_versions'
              and other.payload ->> 'record_id' = item.payload ->> 'record_id'
              and other.payload -> 'version_no' = item.payload -> 'version_no') <> 1
       or not (
         (jsonb_typeof(item.payload -> 'record') = 'string' and btrim(item.payload ->> 'record') <> '')
         or (jsonb_typeof(item.payload -> 'notes') = 'string' and btrim(item.payload ->> 'notes') <> '')
         or (jsonb_typeof(item.payload -> 'transcription_text') = 'string'
             and btrim(item.payload ->> 'transcription_text') <> '')
         or (jsonb_typeof(item.payload -> 'structured_data') = 'object' and item.payload -> 'structured_data' <> '{}'::jsonb)) then
      raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_VERSION_INVALID';
    end if;
    author_profile := item.payload ->> 'created_by_user_profile_id';
    author_staff := item.payload ->> 'created_by_staff_account_id';
    <<version_author>>
    begin
      select patient_row.payload ->> 'auth_user_id' into patient_account from migration.source_rows patient_row
       where patient_row.run_id = parent_run and patient_row.entity_type = 'patients'
         and patient_row.source_pk = record_patient::text;
      select (profile_row.payload ->> 'auth_user_id')::uuid into author_account
        from migration.source_rows profile_row
        join migration.source_rows account_row on account_row.run_id = parent_run
         and account_row.entity_type = 'accounts' and account_row.source_pk = profile_row.payload ->> 'auth_user_id'
       where profile_row.run_id = parent_run and profile_row.entity_type = 'user_profiles'
         and profile_row.source_pk = author_profile
         and coalesce(profile_row.payload ->> 'auth_user_id', '') ~ uuid_shape;
      if author_account is null then
        raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_AUTHOR_UNRESOLVED';
      end if;
      if author_account::text = patient_account and author_staff is null then
        author_origin := 'patient-provided';
      elsif author_account::text <> patient_account and (select count(*) from migration.source_rows staff_row
              where staff_row.run_id = parent_run and staff_row.entity_type = 'staff'
                and staff_row.payload ->> 'auth_user_id' = author_account::text
                and (author_staff is null or staff_row.source_pk = author_staff)) = 1 then
        author_origin := 'provider-authored';
      else
        raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_AUTHOR_UNRESOLVED';
      end if;
    end version_author;
    insert into ehr.imported_medical_record_versions (id, record_id, patient_id, version_no, author_account_id, origin,
      source_payload, source_sha256, source_created_at)
    values (item.source_pk::uuid, (item.payload ->> 'record_id')::uuid, record_patient,
      (item.payload ->> 'version_no')::integer, author_account, author_origin, item.payload, item.payload_sha256,
      (item.payload ->> 'created_at')::timestamptz)
    on conflict (id) do nothing;
    get diagnostics added = row_count;
    inserted_versions := inserted_versions + added;
    if not exists (select 1 from ehr.imported_medical_record_versions stored
                    where stored.id = item.source_pk::uuid and stored.record_id = (item.payload ->> 'record_id')::uuid
                      and stored.patient_id = record_patient
                      and stored.version_no = (item.payload ->> 'version_no')::integer
                      and stored.author_account_id = author_account and stored.origin = author_origin
                      and stored.source_payload = item.payload and stored.source_sha256 = item.payload_sha256
                      and stored.source_created_at = (item.payload ->> 'created_at')::timestamptz) then
      raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_DIFFERS';
    end if;
  end loop;
  set constraints ehr.imported_current_version immediate;

  -- Files: of a record and, when named, a version of that record, of the record's patient.
  for item in
    select source.source_pk, source.payload, btrim(source.payload_sha256) as payload_sha256
      from migration.source_rows source
     where source.run_id = history_run and source.entity_type = 'medical_record_files'
     order by source.source_pk
  loop
    select (record_row.payload ->> 'patient_id')::uuid into record_patient
      from migration.source_rows record_row
     where record_row.run_id = history_run and record_row.entity_type = 'medical_records'
       and record_row.source_pk = item.payload ->> 'record_id';
    if item.source_pk !~ uuid_shape or item.payload ->> 'id' is distinct from item.source_pk or record_patient is null
       or item.payload ->> 'patient_id' is distinct from record_patient::text
       or (item.payload ->> 'record_version_id' is not null and not exists (
             select 1 from migration.source_rows version_row
              where version_row.run_id = history_run and version_row.entity_type = 'medical_record_versions'
                and version_row.source_pk = item.payload ->> 'record_version_id'
                and version_row.payload ->> 'record_id' = item.payload ->> 'record_id')) then
      raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_BINDING_DIFFERS';
    end if;
    if pg_input_is_valid(item.payload ->> 'created_at', 'timestamptz') is not true
       or jsonb_typeof(item.payload -> 'size_bytes') is distinct from 'number'
       or (item.payload ->> 'size_bytes') !~ '^[0-9]{1,15}$'
       or jsonb_typeof(item.payload -> 'original_file_name') is distinct from 'string'
       or jsonb_typeof(item.payload -> 'mime_type') is distinct from 'string' then
      raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_FILE_INVALID';
    end if;
    -- The uploader, through the parent run's sealed profile and account rows.
    select (profile_row.payload ->> 'auth_user_id')::uuid into author_account
      from migration.source_rows profile_row
      join migration.source_rows account_row on account_row.run_id = parent_run
       and account_row.entity_type = 'accounts' and account_row.source_pk = profile_row.payload ->> 'auth_user_id'
     where profile_row.run_id = parent_run and profile_row.entity_type = 'user_profiles'
       and profile_row.source_pk = item.payload ->> 'uploaded_by_user_profile_id'
       and coalesce(profile_row.payload ->> 'auth_user_id', '') ~ uuid_shape;
    if author_account is null then
      raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_AUTHOR_UNRESOLVED';
    end if;
    insert into ehr.imported_medical_record_files (id, record_id, patient_id, record_version_id, uploader_account_id,
      source_payload, source_sha256, source_created_at)
    values (item.source_pk::uuid, (item.payload ->> 'record_id')::uuid, record_patient,
      (item.payload ->> 'record_version_id')::uuid, author_account, item.payload, item.payload_sha256,
      (item.payload ->> 'created_at')::timestamptz)
    on conflict (id) do nothing;
    get diagnostics added = row_count;
    inserted_files := inserted_files + added;
    if not exists (select 1 from ehr.imported_medical_record_files stored
                    where stored.id = item.source_pk::uuid and stored.record_id = (item.payload ->> 'record_id')::uuid
                      and stored.patient_id = record_patient
                      and stored.record_version_id is not distinct from (item.payload ->> 'record_version_id')::uuid
                      and stored.uploader_account_id = author_account
                      and stored.source_payload = item.payload and stored.source_sha256 = item.payload_sha256
                      and stored.source_created_at = (item.payload ->> 'created_at')::timestamptz) then
      raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_DIFFERS';
    end if;
  end loop;

  -- The receipt, once per parent and history run.
  counts := jsonb_build_object('medical_records', (history_row.source_counts ->> 'medical_records')::bigint,
    'medical_record_versions', (history_row.source_counts ->> 'medical_record_versions')::bigint,
    'medical_record_files', (history_row.source_counts ->> 'medical_record_files')::bigint);
  receipt := md5('hid-imported-history:' || parent_run::text || ':' || history_run::text)::uuid;
  receipt_notes := 'Imported legacy medical history; parent run ' || parent_run::text || ', history run '
    || history_run::text;
  insert into migration.runs (id, source_system, source_snapshot, mode, status, started_by, completed_at,
    source_counts, target_counts, source_checksum_sha256, target_checksum_sha256, notes)
  values (receipt, 'legacy_imported_history', history_row.source_snapshot, 'cutover', 'completed', btrim(operator),
    clock_timestamp(), counts, counts, history_row.source_checksum_sha256, history_row.source_checksum_sha256, receipt_notes)
  on conflict (id) do nothing;
  if not exists (select 1 from migration.runs run
                  where run.id = receipt and run.source_system = 'legacy_imported_history'
                    and run.source_snapshot = history_row.source_snapshot and run.mode = 'cutover'
                    and run.status = 'completed' and run.source_counts = counts and run.target_counts = counts
                    and run.source_checksum_sha256 = history_row.source_checksum_sha256
                    and run.target_checksum_sha256 = history_row.source_checksum_sha256
                    and run.notes = receipt_notes) then
    raise exception using errcode = '55000', message = 'IMPORTED_HISTORY_DIFFERS';
  end if;
  return jsonb_build_object('counts', counts, 'inserted', jsonb_build_object('medical_records', inserted_records,
    'medical_record_versions', inserted_versions, 'medical_record_files', inserted_files), 'receipt', receipt);
end
$$;
revoke all on function ehr.import_legacy_medical_history(uuid, uuid, text, jsonb) from public;
comment on function ehr.import_legacy_medical_history(uuid, uuid, text, jsonb) is
  'Imports a sealed legacy history staging run of a verified legacy identity run, accepting only rows equal to their sealed staging rows; inserts once, refuses a stored row that differs, records a receipt run (ADR-065). Owned by hid_imported_history_importer; executable by hid_migration_admin only.';

-- 5. The permission.
insert into auth.permissions (code, description) values
  ('ehr.imported-history.read',
   'Read a patient''s imported legacy medical history for direct care, with consent and the patient''s sharing choice (ADR-065)')
on conflict (code) do update set description = excluded.description, active = true;
insert into auth.role_permissions (role_code, permission_code) values
  ('doctor', 'ehr.imported-history.read'),
  ('clinician', 'ehr.imported-history.read'),
  ('nurse', 'ehr.imported-history.read')
on conflict (role_code, permission_code) do nothing;

comment on table ehr.imported_medical_records is
  'Imported legacy medical records as the legacy system held them (no encounter, facility or signature is made up); read by the patient through patient-self and by staff only for direct care with consent and the patient''s sharing choice; written only by ehr.import_legacy_medical_history (ADR-065).';
comment on table ehr.imported_medical_record_versions is
  'Every version of each imported legacy record, as staged (ADR-065).';
comment on table ehr.imported_medical_record_files is
  'Metadata of the files of imported legacy records only; no object is bound, scanned or downloadable (ADR-065).';
comment on table identity.imported_history_sharing is
  'The patient''s choice to share imported legacy history with the facilities they approve; no row means not shared (ADR-065).';
comment on table identity.imported_history_sharing_events is
  'Append-only log of each change of the patient''s imported history sharing choice (ADR-065).';
