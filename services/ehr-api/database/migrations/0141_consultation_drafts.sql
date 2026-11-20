-- 0141: consultation drafts saved on the server (EHR-C6, Akos N-5 and the
-- auto-save part of P1-13, Release B; the planned contract's "EHR-C6").
-- Owner decision Q126 A, 19 November 2026: author only; deleted 7 days after
-- the last save. Booked as 0141 on hid-system#258; numbers are given in merge
-- order at the Release B cut-off. This file requires 0001-0137 applied.
--
-- A draft is the unfinished consultation form, saved while the clinician
-- types. It is not part of the patient's record: no version history, no
-- clinical check, never in the chart, the patient's own record, chat, the
-- record evidence, Migrate or OCR. Rows can be deleted.
--
-- D1 ehr.consultation_drafts: the patient, the facility, the author (account
--    and membership, keyed to the membership by id, facility and account),
--    an optional visit of this patient here, form_version (1-1000), content
--    (a JSON object, stored as jsonb: key order is not kept; at most 262,144
--    bytes measured as stored, the JSON text PostgreSQL keeps; protected, as
--    note bodies are, by row-level security and the database's encryption at
--    rest), size_bytes, row_version, created_at, saved_at and expires_at
--    (saved_at + 7 days). One draft per author per visit, and one per author
--    per patient with no visit.
-- D2 ehr.guard_consultation_draft(), BEFORE INSERT OR UPDATE: the server
--    sets created_at, saved_at, expires_at, size_bytes and row_version (a
--    save is row_version + 1); an update cannot move a draft to another
--    patient, facility, author or visit (55000
--    CONSULTATION_DRAFT_IMMUTABLE); content over the limit is 22023
--    CONSULTATION_DRAFT_TOO_LARGE.
-- D3 Row-level security, forced. The author's policies (select, insert,
--    update) call ehr.is_consultation_draft_author (SECURITY DEFINER): the
--    session's own account, membership and facility, an active membership
--    with ehr.note.write; select and update also need a draft not yet
--    expired. They also check the patient's consent, as the clinical tables
--    do (ehr.context_allows): select needs read_records, insert and update
--    write_records, so a grant that ends hides the draft at once. The
--    runtime has no DELETE: discard is D7's function, which needs authorship
--    only. The table's owner may read and delete (the functions below, as
--    0131's encounters_owner_read); no other function reads the table.
-- D4 ehr.list_my_consultation_drafts() (SECURITY DEFINER, EHR runtime): the
--    session author's live drafts at this facility, newest save first, at
--    most 50; listed only while the session may read the patient's records
--    now for direct care (ehr.context_allows), the rest counted in
--    hidden_count (an empty list is one row with no draft that carries it);
--    the waiting-list card's patient fields; audited (one
--    ehr.consultation-draft.list row and one .shown row per patient shown).
-- D5 ehr.sweep_consultation_drafts(batch integer) (SECURITY DEFINER, EHR
--    runtime): deletes up to `batch` (1-1000) drafts past expires_at, oldest
--    first, with one ehr.consultation-draft.expire audit row each (system
--    actor, the run's correlation id, never the content), and answers how
--    many. A draft whose patient or author is under an unreleased legal hold
--    (platform.legal_holds, 0096) is kept: a hold overrides lifecycle
--    deletion (DATABASE.md). The expiry is tested again on the row deleted,
--    so a save that renewed the draft meanwhile keeps it.
-- D6 ehr.consultation_draft_held(patient, account): whether an unreleased
--    legal hold names the patient or the account. platform.legal_holds is
--    readable only by its owner (0096's policy), so this one function is
--    that owner's, executable only by this file's functions' owner.
-- D7 ehr.discard_consultation_draft(draft, patient) (SECURITY DEFINER, EHR
--    runtime): the session author deletes their own draft, expired or not,
--    with no consent check (Q126 A: discard needs authorship only), and one
--    ehr.consultation-draft.discard audit row: success naming the patient,
--    or failure (not_found) when nothing was deleted, naming the patient
--    only if it exists (the requested id is in details otherwise). Answers
--    whether a draft was deleted; safe to repeat.
-- D8 ehr.expire_my_consultation_draft(patient, visit) (SECURITY DEFINER, EHR
--    runtime): deletes the session author's own draft for that patient and
--    visit (or no visit) only if it has expired and no legal hold covers
--    it, with the sweeper's .expire audit row (the author as actor). A create
--    that meets an expired draft not yet swept clears it and tries once more.
-- D9 Grants, here and in runtime-grants.sql: SELECT, INSERT and UPDATE on
--    the table and EXECUTE on the five runtime functions to hid_ehr_runtime
--    where it exists; nothing to any other role.
--
-- Locks: SHARE ROW EXCLUSIVE on identity.patients, identity.facilities,
-- auth.accounts, identity.staff_facility_memberships and ehr.encounters (the
-- foreign keys of a new, empty table), and ACCESS SHARE on
-- platform.legal_holds (D6's SQL body is parsed when it is created), held to
-- commit. Taken first, NOWAIT:
-- a busy table fails the attempt at once and its subtransaction releases
-- what it took; the attempt is made again every 100 ms for at most 5
-- seconds, then 55P03 (nothing applied). When this transaction already holds
-- an earlier migration's locks that stop other sessions' reads or writes
-- (the runner's dry run), one attempt and no sleep: 55P03 at once, nothing
-- applied.
--
-- Old services on this schema: nothing reads or writes the table.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 0b. Locks, NOWAIT (55P03 and nothing applied).
-- 1. The table (D1), its guard (D2) and row-level security (D3).
-- 2. The functions (D4-D8).
-- 3. Grants (D9).
-- 4. Post-checks.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regclass('auth.session_facility_selection') is null
     or to_regprocedure('identity.qoreid_nin_record_used(character,text)') is null then
    raise exception using errcode = '55000', message = '0141: 0001-0137 must be applied first';
  end if;
  if to_regclass('ehr.consultation_drafts') is not null
     or to_regprocedure('ehr.guard_consultation_draft()') is not null
     or to_regprocedure('ehr.list_my_consultation_drafts()') is not null
     or to_regprocedure('ehr.is_consultation_draft_author(uuid,uuid,uuid)') is not null
     or to_regprocedure('ehr.sweep_consultation_drafts(integer)') is not null
     or to_regprocedure('ehr.consultation_draft_held(uuid,uuid)') is not null
     or to_regprocedure('ehr.discard_consultation_draft(uuid,uuid)') is not null
     or to_regprocedure('ehr.expire_my_consultation_draft(uuid,uuid)') is not null then
    raise exception using errcode = '55000', message = '0141: already applied';
  end if;
  -- D6 reads 0096's legal holds, which only their owner may read.
  if to_regclass('platform.legal_holds') is null
     or not exists (select 1 from pg_policy policy
                     where policy.polrelid = 'platform.legal_holds'::regclass and policy.polname = 'legal_holds_owner') then
    raise exception using errcode = '55000', message = '0141: platform.legal_holds (0096) is not as this file reads it';
  end if;
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)', '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa')
    ) expected(signature, body_md5)
   where to_regprocedure(expected.signature) is null
      or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0141: these functions are not the ones this file relies on: ' || mismatch;
  end if;
  if not exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'identity.staff_facility_memberships'::regclass
                    and constraint_row.contype in ('u', 'p')
                    and (select array_agg(attribute.attname::text order by attribute.attname)
                           from pg_attribute attribute
                          where attribute.attrelid = constraint_row.conrelid
                            and attribute.attnum = any (constraint_row.conkey))
                        = array['account_id', 'facility_id', 'id'])
     or not exists (select 1 from pg_constraint constraint_row
                     where constraint_row.conrelid = 'ehr.encounters'::regclass
                       and constraint_row.contype in ('u', 'p')
                       and (select array_agg(attribute.attname::text order by attribute.attname)
                              from pg_attribute attribute
                             where attribute.attrelid = constraint_row.conrelid
                               and attribute.attnum = any (constraint_row.conkey))
                           = array['facility_id', 'id', 'patient_id']) then
    raise exception using errcode = '55000', message = '0141: the membership or visit keys are not as this file references them';
  end if;
end
$$;

-- 0b. Locks (see Locks), NOWAIT, at most 5 s; one attempt when this
-- transaction already holds an earlier migration's locks.
do $locks$
declare
  attempt integer := 0;
  holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
begin
  loop
    attempt := attempt + 1;
    begin
      lock table identity.patients, identity.facilities, auth.accounts, identity.staff_facility_memberships,
        ehr.encounters in share row exclusive mode nowait;
      lock table platform.legal_holds in access share mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0141: identity.patients, identity.facilities, auth.accounts, the staff memberships, ehr.encounters or platform.legal_holds is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0141: identity.patients, identity.facilities, auth.accounts, the staff memberships, ehr.encounters or platform.legal_holds stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 1. The table (D1).
create table ehr.consultation_drafts (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  membership_id uuid not null,
  encounter_id uuid,
  form_version integer not null check (form_version between 1 and 1000),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  size_bytes integer not null check (size_bytes between 2 and 262144),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  saved_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check (expires_at = saved_at + interval '7 days'),
  check (saved_at >= created_at),
  foreign key (membership_id, facility_id, account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  foreign key (encounter_id, patient_id, facility_id)
    references ehr.encounters(id, patient_id, facility_id) on delete restrict
);
create unique index consultation_drafts_one_per_visit on ehr.consultation_drafts (membership_id, encounter_id)
  where encounter_id is not null;
create unique index consultation_drafts_one_without_visit on ehr.consultation_drafts (membership_id, patient_id)
  where encounter_id is null;
create index consultation_drafts_author_saved on ehr.consultation_drafts (membership_id, facility_id, saved_at desc);
create index consultation_drafts_expiry on ehr.consultation_drafts (expires_at);
comment on table ehr.consultation_drafts is
  '0141 (EHR-C6, owner decision Q126 A): unfinished consultation forms, author only, deleted 7 days after the last save. Not part of the record: no version history, never in the chart, the patient''s own record, chat, evidence, Migrate or OCR.';

-- 1b. The guard (D2).
create function ehr.guard_consultation_draft()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if (new.id, new.patient_id, new.facility_id, new.account_id, new.membership_id, new.encounter_id, new.created_at)
       is distinct from
       (old.id, old.patient_id, old.facility_id, old.account_id, old.membership_id, old.encounter_id, old.created_at) then
      raise exception using errcode = '55000', message = 'CONSULTATION_DRAFT_IMMUTABLE';
    end if;
    new.row_version := old.row_version + 1;
  else
    new.row_version := 1;
    new.created_at := clock_timestamp();
  end if;
  new.size_bytes := octet_length(new.content::text);
  if new.size_bytes > 262144 then
    raise exception using errcode = '22023', message = 'CONSULTATION_DRAFT_TOO_LARGE';
  end if;
  new.saved_at := greatest(clock_timestamp(), new.created_at);
  new.expires_at := new.saved_at + interval '7 days';
  return new;
end
$$;
comment on function ehr.guard_consultation_draft() is
  'Guard of ehr.consultation_drafts (0141): sets created_at, saved_at, expires_at (saved_at + 7 days), size_bytes and row_version; refuses a move to another patient, facility, author or visit (55000 CONSULTATION_DRAFT_IMMUTABLE) and content over 262,144 bytes (22023 CONSULTATION_DRAFT_TOO_LARGE).';
revoke all on function ehr.guard_consultation_draft() from public;
create trigger consultation_drafts_guard
  before insert or update on ehr.consultation_drafts
  for each row execute function ehr.guard_consultation_draft();

-- 1c. Row-level security (D3). The author check is a definer: the EHR runtime
-- may not run the membership helpers itself.
create function ehr.is_consultation_draft_author(row_account uuid, row_membership uuid, row_facility uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select row_account = auth.account_id_for_subject(platform.current_actor_subject())
     and row_membership = platform.current_membership_id()
     and row_facility = platform.current_facility_id()
     and auth.membership_has_permission(platform.current_actor_subject(), row_membership, row_facility, 'ehr.note.write')
$$;
comment on function ehr.is_consultation_draft_author(uuid, uuid, uuid) is
  '0141: whether a draft is the session''s own: its account, membership and facility, an active membership with ehr.note.write. The drafts policies call it.';
revoke all on function ehr.is_consultation_draft_author(uuid, uuid, uuid) from public;
alter table ehr.consultation_drafts enable row level security;
alter table ehr.consultation_drafts force row level security;
-- The patient's consent is checked here too (ehr.context_allows), as on the
-- clinical tables: reading needs read_records, writing write_records.
create policy consultation_drafts_author_read on ehr.consultation_drafts for select
  using (ehr.is_consultation_draft_author(account_id, membership_id, facility_id) and expires_at > clock_timestamp()
         and ehr.context_allows(patient_id, facility_id, 'read_records'));
create policy consultation_drafts_author_insert on ehr.consultation_drafts for insert
  with check (ehr.is_consultation_draft_author(account_id, membership_id, facility_id)
              and ehr.context_allows(patient_id, facility_id, 'write_records'));
create policy consultation_drafts_author_update on ehr.consultation_drafts for update
  using (ehr.is_consultation_draft_author(account_id, membership_id, facility_id) and expires_at > clock_timestamp()
         and ehr.context_allows(patient_id, facility_id, 'write_records'))
  with check (ehr.is_consultation_draft_author(account_id, membership_id, facility_id)
              and ehr.context_allows(patient_id, facility_id, 'write_records'));
create policy consultation_drafts_owner_read on ehr.consultation_drafts for select
  using (pg_has_role((select relation.relowner from pg_class relation
                       where relation.oid = 'ehr.consultation_drafts'::regclass), 'USAGE'));
create policy consultation_drafts_owner_delete on ehr.consultation_drafts for delete
  using (pg_has_role((select relation.relowner from pg_class relation
                       where relation.oid = 'ehr.consultation_drafts'::regclass), 'USAGE'));

-- 2. The functions (D4-D8).
create function ehr.list_my_consultation_drafts()
returns table (draft_id uuid, encounter_id uuid, saved_at timestamptz, expires_at timestamptz, patient_id uuid,
  full_name text, sex text, date_of_birth date, health_id_last4 text, hidden_count bigint)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  actor_correlation text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_organization uuid;
  hidden bigint;
  shown_ids uuid[];
  shown_patients uuid[];
begin
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.note.write') then
    raise exception using errcode = '42501', message = 'CONSULTATION_DRAFTS_NOT_PERMITTED';
  end if;
  select membership.organization_id into actor_organization
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.account_id = actor_account
     and membership.facility_id = actor_facility and membership.active
     and membership.migration_hold_reason is null;
  if not found then
    raise exception using errcode = '42501', message = 'CONSULTATION_DRAFTS_NOT_PERMITTED';
  end if;
  if actor_purpose is distinct from 'direct-care' then
    raise exception using errcode = '22023', message = 'CONSULTATION_DRAFTS_DIRECT_CARE_ONLY';
  end if;

  with mine as (
    select draft.id, draft.patient_id, draft.saved_at
      from ehr.consultation_drafts draft
     where draft.account_id = actor_account and draft.membership_id = actor_membership
       and draft.facility_id = actor_facility and draft.expires_at > clock_timestamp()
  ), access_rows as (
    select distinct_patient.patient_id,
           coalesce(ehr.context_allows(distinct_patient.patient_id, actor_facility, 'read_records'), false) as allowed
      from (select distinct mine.patient_id from mine) distinct_patient
  ), listed as (
    select mine.id, mine.patient_id, mine.saved_at
      from mine join access_rows on access_rows.patient_id = mine.patient_id and access_rows.allowed
     order by mine.saved_at desc, mine.id desc
     limit 50
  )
  select (select count(*) from mine join access_rows on access_rows.patient_id = mine.patient_id
           where not access_rows.allowed),
         coalesce(array_agg(listed.id order by listed.saved_at desc, listed.id desc), array[]::uuid[]),
         coalesce(array_agg(listed.patient_id order by listed.saved_at desc, listed.id desc), array[]::uuid[])
    into hidden, shown_ids, shown_patients
    from listed;
  select coalesce(array_agg(first_seen.patient_id order by first_seen.first_position), array[]::uuid[]) into shown_patients
    from (select listed.patient_id, min(listed.position) as first_position
            from unnest(shown_patients) with ordinality listed(patient_id, position)
           group by listed.patient_id) first_seen;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, null, 'ehr.consultation-draft.list', 'success',
    'consultation-draft', null, actor_purpose, 'application', 'ehr-api',
    jsonb_build_object('scope', 'mine', 'resultCount', cardinality(shown_ids), 'hiddenCount', hidden,
      'patientIds', to_jsonb(shown_patients))
  );
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  )
  select actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
         actor_organization, actor_facility, shown.patient_id, 'ehr.consultation-draft.list.shown', 'success',
         'consultation-draft', null, actor_purpose, 'application', 'ehr-api', '{}'::jsonb
    from unnest(shown_patients) with ordinality shown(patient_id, position)
   order by shown.position;

  if cardinality(shown_ids) = 0 then
    -- An empty list still says how many drafts are hidden: one row with no draft in it.
    return query select null::uuid, null::uuid, null::timestamptz, null::timestamptz, null::uuid, null::text,
      null::text, null::date, null::text, hidden;
    return;
  end if;
  return query
    select draft.id, draft.encounter_id, draft.saved_at, draft.expires_at, draft.patient_id, patient.full_name,
           patient.gender, patient.dob, right(patient.hid_code, 4), hidden
      from unnest(shown_ids) with ordinality listed(id, position)
      join ehr.consultation_drafts draft on draft.id = listed.id
      join identity.patients patient on patient.id = draft.patient_id
     order by listed.position;
end
$$;
comment on function ehr.list_my_consultation_drafts() is
  '0141 (EHR-C6): the session author''s live consultation drafts at the session facility, newest save first, at most 50; listed only while the session may read the patient''s records now for direct care (ehr.context_allows), the rest counted in hidden_count; the waiting-list card''s patient fields, never a full Health ID. Needs ehr.note.write. Audited: one ehr.consultation-draft.list row and one .shown row per patient shown. Never the content.';
revoke all on function ehr.list_my_consultation_drafts() from public;

-- 2b. Legal holds (D6). platform.legal_holds is readable only by its owner
-- (0096's legal_holds_owner policy), so this function becomes that owner's,
-- and only this file's functions' owner may run it.
create function ehr.consultation_draft_held(draft_patient uuid, draft_account uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from platform.legal_holds hold
                  where hold.released_at is null
                    and ((hold.subject_type = 'patient' and hold.subject_id = draft_patient)
                      or (hold.subject_type = 'account' and hold.subject_id = draft_account)))
$$;
comment on function ehr.consultation_draft_held(uuid, uuid) is
  '0141 (EHR-C6): whether an unreleased legal hold (0096) names this patient or this account. A held draft is never deleted by expiry. Owned by platform.legal_holds'' owner, whose policy alone reads the holds.';
revoke all on function ehr.consultation_draft_held(uuid, uuid) from public;
do $$
declare
  holds_owner name := (select pg_get_userbyid(relation.relowner) from pg_class relation
                        where relation.oid = 'platform.legal_holds'::regclass);
begin
  if holds_owner <> current_user then
    execute format('alter function ehr.consultation_draft_held(uuid, uuid) owner to %I', holds_owner);
    execute format('grant execute on function ehr.consultation_draft_held(uuid, uuid) to %I', current_user);
  end if;
end
$$;

create function ehr.sweep_consultation_drafts(batch integer)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  swept integer;
begin
  if batch is null or batch not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'CONSULTATION_DRAFT_SWEEP_BATCH_INVALID';
  end if;
  -- A held draft is skipped before the batch is cut, so held drafts never
  -- stop the sweep; the expiry is tested again on the row deleted, so a save
  -- that renewed the draft while this waited for its lock keeps it.
  with expired as (
    select draft.id
      from ehr.consultation_drafts draft
     where draft.expires_at <= clock_timestamp()
       and not ehr.consultation_draft_held(draft.patient_id, draft.account_id)
     order by draft.expires_at, draft.id
     limit batch
  ), removed as (
    delete from ehr.consultation_drafts draft
     using expired
     where draft.id = expired.id and draft.expires_at <= clock_timestamp()
    returning draft.id, draft.patient_id, draft.facility_id, draft.account_id, draft.membership_id, draft.size_bytes
  ), audited as (
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    )
    select coalesce(platform.current_correlation_id(), 'consultation-draft-sweep'), 'system', null, null, null,
           null, removed.facility_id, removed.patient_id, 'ehr.consultation-draft.expire', 'success',
           'consultation-draft', removed.id::text, null, 'system', 'ehr-api',
           jsonb_build_object('sizeBytes', removed.size_bytes, 'authorMembershipId', removed.membership_id)
      from removed
    returning 1
  )
  select count(*) into swept from audited;
  return swept;
end
$$;
comment on function ehr.sweep_consultation_drafts(integer) is
  '0141 (EHR-C6, Q126 A): deletes up to `batch` (1-1000) consultation drafts past expires_at (7 days after the last save), oldest first, except drafts whose patient or author is under an unreleased legal hold, with one ehr.consultation-draft.expire audit row (the run''s correlation id) for each draft this call deleted (never the content); answers how many.';
revoke all on function ehr.sweep_consultation_drafts(integer) from public;

-- 2c. The session author, for D7 and D8: an active, unheld membership here
-- with ehr.note.write, for direct care (as D4 checks).
create function ehr.consultation_draft_session()
returns table (actor_subject text, actor_account uuid, actor_membership uuid, actor_facility uuid,
  actor_organization uuid, actor_correlation text, actor_purpose text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  subject_value text := platform.current_actor_subject();
  account_value uuid := auth.account_id_for_subject(subject_value);
  membership_value uuid := platform.current_membership_id();
  facility_value uuid := platform.current_facility_id();
  correlation_value text := platform.current_correlation_id();
  purpose_value text := platform.current_purpose_of_use();
  organization_value uuid;
begin
  if account_value is null or membership_value is null or facility_value is null or correlation_value is null
     or not auth.membership_has_permission(subject_value, membership_value, facility_value, 'ehr.note.write') then
    raise exception using errcode = '42501', message = 'CONSULTATION_DRAFTS_NOT_PERMITTED';
  end if;
  select membership.organization_id into organization_value
    from identity.staff_facility_memberships membership
   where membership.id = membership_value and membership.account_id = account_value
     and membership.facility_id = facility_value and membership.active
     and membership.migration_hold_reason is null;
  if not found then
    raise exception using errcode = '42501', message = 'CONSULTATION_DRAFTS_NOT_PERMITTED';
  end if;
  if purpose_value is distinct from 'direct-care' then
    raise exception using errcode = '22023', message = 'CONSULTATION_DRAFTS_DIRECT_CARE_ONLY';
  end if;
  return query select subject_value, account_value, membership_value, facility_value, organization_value,
    correlation_value, purpose_value;
end
$$;
comment on function ehr.consultation_draft_session() is
  '0141 (EHR-C6): the session author for discard and on-demand expiry (an active, unheld membership here with ehr.note.write, for direct care), or 42501 CONSULTATION_DRAFTS_NOT_PERMITTED / 22023 CONSULTATION_DRAFTS_DIRECT_CARE_ONLY.';
revoke all on function ehr.consultation_draft_session() from public;

-- 2d. Discard (D7): authorship only, no consent check (Q126 A).
create function ehr.discard_consultation_draft(requested_draft uuid, requested_patient uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  removed_id uuid;
  removed_patient uuid;
  removed_size integer;
  named_patient uuid;
begin
  select * into actor from ehr.consultation_draft_session();
  delete from ehr.consultation_drafts draft
   where draft.id = requested_draft and draft.patient_id = requested_patient
     and draft.facility_id = actor.actor_facility and draft.account_id = actor.actor_account
     and draft.membership_id = actor.actor_membership
  returning draft.id, draft.patient_id, draft.size_bytes into removed_id, removed_patient, removed_size;
  -- The audit row names the patient only if one exists (its foreign key).
  named_patient := coalesce(removed_patient,
    (select patient.id from identity.patients patient where patient.id = requested_patient));
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor.actor_correlation, 'staff', actor.actor_subject, actor.actor_account, actor.actor_membership,
    actor.actor_organization, actor.actor_facility, named_patient, 'ehr.consultation-draft.discard',
    case when removed_id is null then 'failure' else 'success' end,
    'consultation-draft', requested_draft::text, actor.actor_purpose, 'application', 'ehr-api',
    case when removed_id is not null then jsonb_build_object('sizeBytes', removed_size, 'discarded', true)
         when named_patient is null then jsonb_build_object('discarded', false, 'reason', 'not_found',
           'requestedPatientId', requested_patient)
         else jsonb_build_object('discarded', false, 'reason', 'not_found') end
  );
  return removed_id is not null;
end
$$;
comment on function ehr.discard_consultation_draft(uuid, uuid) is
  '0141 (EHR-C6, Q126 A): the session author deletes their own draft (expired or not) with no consent check, and one ehr.consultation-draft.discard audit row (success, or failure with reason not_found; the patient named only if it exists). Answers whether a draft was deleted; safe to repeat. Never the content.';
revoke all on function ehr.discard_consultation_draft(uuid, uuid) from public;

-- 2e. On-demand expiry (D8): a create that meets the author's own expired
-- draft for the same patient and visit, before the sweeper has removed it.
create function ehr.expire_my_consultation_draft(requested_patient uuid, requested_encounter uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor record;
  removed_id uuid;
  removed_patient uuid;
  removed_size integer;
begin
  select * into actor from ehr.consultation_draft_session();
  delete from ehr.consultation_drafts draft
   where draft.membership_id = actor.actor_membership and draft.account_id = actor.actor_account
     and draft.facility_id = actor.actor_facility and draft.patient_id = requested_patient
     and draft.encounter_id is not distinct from requested_encounter
     and draft.expires_at <= clock_timestamp()
     and not ehr.consultation_draft_held(draft.patient_id, draft.account_id)
  returning draft.id, draft.patient_id, draft.size_bytes into removed_id, removed_patient, removed_size;
  if removed_id is null then
    return false;
  end if;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor.actor_correlation, 'staff', actor.actor_subject, actor.actor_account, actor.actor_membership,
    actor.actor_organization, actor.actor_facility, removed_patient, 'ehr.consultation-draft.expire', 'success',
    'consultation-draft', removed_id::text, actor.actor_purpose, 'application', 'ehr-api',
    jsonb_build_object('sizeBytes', removed_size, 'authorMembershipId', actor.actor_membership, 'trigger', 'create')
  );
  return true;
end
$$;
comment on function ehr.expire_my_consultation_draft(uuid, uuid) is
  '0141 (EHR-C6): deletes the session author''s own draft for this patient and visit (or no visit) only if it has expired and no legal hold covers it, with one ehr.consultation-draft.expire audit row; answers whether one was deleted. A create calls it on a conflict it cannot see, then tries once more.';
revoke all on function ehr.expire_my_consultation_draft(uuid, uuid) from public;

-- 3. Grants (D9; here and in runtime-grants.sql). The runtime has no DELETE:
-- discard is D7's function.
revoke all on ehr.consultation_drafts from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant select, insert, update on ehr.consultation_drafts to hid_ehr_runtime;
    grant execute on function ehr.list_my_consultation_drafts(), ehr.sweep_consultation_drafts(integer),
      ehr.is_consultation_draft_author(uuid, uuid, uuid), ehr.discard_consultation_draft(uuid, uuid),
      ehr.expire_my_consultation_draft(uuid, uuid) to hid_ehr_runtime;
  end if;
end
$$;

-- 4. Post-checks.
do $$
declare
  owner_oid oid := (select relation.relowner from pg_class relation
                     where relation.oid = 'ehr.consultation_drafts'::regclass);
  held_owner oid := (select proc.proowner from pg_proc proc
                      where proc.oid = 'ehr.consultation_draft_held(uuid,uuid)'::regprocedure);
  members text;
begin
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'ehr.consultation_drafts'::regclass) then
    raise exception using errcode = '55000', message = '0141: ehr.consultation_drafts is not under forced row-level security';
  end if;
  if (select string_agg(policy.polname::text, ',' order by policy.polname) from pg_policy policy
       where policy.polrelid = 'ehr.consultation_drafts'::regclass)
     is distinct from 'consultation_drafts_author_insert,consultation_drafts_author_read,consultation_drafts_author_update,'
                      || 'consultation_drafts_owner_delete,consultation_drafts_owner_read' then
    raise exception using errcode = '55000', message = '0141: ehr.consultation_drafts does not have exactly its five policies';
  end if;
  -- The owner's policies admit every function the owner runs: no hid_ role
  -- other than the owner may be a member of it (0133's form).
  select string_agg(role_row.rolname::text, ', ' order by role_row.rolname) into members
    from pg_roles role_row
   where role_row.rolname like 'hid\_%' and role_row.oid <> owner_oid
     and pg_has_role(role_row.oid, owner_oid, 'MEMBER');
  if members is not null then
    raise exception using errcode = '55000',
      message = format('0141: these roles are members of the drafts table''s owner %s: %s', pg_get_userbyid(owner_oid), members);
  end if;
  if exists (select 1 from pg_proc proc
              where proc.oid in ('ehr.list_my_consultation_drafts()'::regprocedure, 'ehr.sweep_consultation_drafts(integer)'::regprocedure,
                                 'ehr.is_consultation_draft_author(uuid,uuid,uuid)'::regprocedure,
                                 'ehr.consultation_draft_held(uuid,uuid)'::regprocedure,
                                 'ehr.consultation_draft_session()'::regprocedure,
                                 'ehr.discard_consultation_draft(uuid,uuid)'::regprocedure,
                                 'ehr.expire_my_consultation_draft(uuid,uuid)'::regprocedure)
                and not (proc.prosecdef and proc.proconfig = array['search_path=pg_catalog, pg_temp'])) then
    raise exception using errcode = '55000', message = '0141: a drafts function is not as created';
  end if;
  -- D6 reads the holds only if 0096's policy admits its owner (or its owner
  -- bypasses row-level security); the sweeper and D8 must be able to run it.
  if not ((select role_row.rolsuper or role_row.rolbypassrls from pg_roles role_row where role_row.oid = held_owner)
          or exists (select 1 from pg_policy policy
                      where policy.polrelid = 'platform.legal_holds'::regclass and policy.polname = 'legal_holds_owner'
                        and policy.polcmd = '*' and policy.polroles = array[0::oid]
                        and pg_get_expr(policy.polqual, policy.polrelid)
                            = format('(CURRENT_USER = %L::name)', pg_get_userbyid(held_owner))))
     or not has_function_privilege(current_user, 'ehr.consultation_draft_held(uuid,uuid)', 'EXECUTE')
     or exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid = 'ehr.consultation_draft_held(uuid,uuid)'::regprocedure
                   and acl.grantee not in (proc.proowner, (select role_row.oid from pg_roles role_row
                                                            where role_row.rolname = current_user))) then
    raise exception using errcode = '55000',
      message = '0141: ehr.consultation_draft_held cannot read platform.legal_holds, or others may run it';
  end if;
end
$$;
