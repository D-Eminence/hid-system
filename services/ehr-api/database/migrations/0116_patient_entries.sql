-- 0116 Records patients add themselves, text only (Akos handover step 6,
-- the plan's item 1a and the chat half of item 1c; owner decision 25 of
-- 2026-11-01, "all recommended except D5", with D7: a record the patient
-- removes is hidden everywhere and kept; the akos-plan README of
-- 2026-11-03 gives this item the number 0116; the declaration is signed
-- separately). Photos and files on these records are a later migration.
-- Written on 0103 (34d69557) and released on 0106: every lower number is
-- assumed applied, and only objects of 0001-0103 are read, with one body as
-- 0104 left it (identity.has_active_consent_grant, pinned in section 0).
--
-- A patient adds a record of their own from anywhere: a visit, a test, a
-- medicine, a diagnosis, a vaccination or something else, with a title,
-- the place, the date and notes. The patient reads it on their records page
-- and in their chat as "You added this"; a clinician with access reads it,
-- read only, as added by the patient and not checked by a health worker.
-- It is never mixed into the clinician's own records. The patient may
-- remove it: it is then hidden from the patient, clinicians and both chats,
-- and the row is kept.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0103 applied (0103's
--    identity.organization_application_admin_account body is the marker);
--    nothing of this file exists yet (else 55000 "0116: already applied");
--    the bodies the new commands, the read policy and the no-delete trigger
--    rely on are byte for byte the ones measured on 0106, the chain head it
--    is released on (md5 of pg_proc.prosrc; all as on 0103 except
--    identity.has_active_consent_grant, which is 0104's body, so 0104 must be
--    applied first): ehr.patient_self_context, ehr.imported_record_read_
--    context, ehr.context_allows, identity.has_active_consent_grant and
--    identity.has_active_membership behind it, the platform.current_*
--    readers, platform.reject_mutation and audit.authorize_platform_event,
--    with the security attributes of the first five; the source-kind CHECK this file writes through, on both
--    chunk tables (0069's 13 kinds; 0070 copied it to the staff table under
--    the same name), and the audit.events CHECKs the new rows must pass,
--    with 0064's authority trigger; the applying role, which will own the
--    new table and functions, owns identity.patients (so its forced RLS
--    hides no patient from the commands, and the foreign key may reference
--    it), owns both chunk tables or is a member that inherits their owner
--    and may SET ROLE to it (ALTER TABLE), holds INSERT on audit.events and
--    CREATE on schema ehr, and may run every function the new objects call,
--    never through a superuser's bypass.
-- 1. The lock the new foreign key needs (see Locks).
-- 2. ehr.patient_entries: per entry the patient, the kind (visit, test,
--    medicine, diagnosis, vaccination, other), a title (2-160 characters on
--    one line), the place (1-160 on one line, or none), the date (from
--    1 January 1900; not after today in Lagos, which the command checks),
--    notes (1-1000 characters, newlines the only control characters, or
--    none), active or withdrawn (with when), who added it, the request's
--    idempotency key (or none) and digest, a row_version. Unique per
--    patient and key. Rows are never deleted or truncated (platform.reject_
--    mutation) and change only from active to withdrawn
--    (ehr.patient_entries_guard). Row-level security, forced: the applier's
--    own policy (the commands) and a read policy, active entries in
--    ehr.imported_record_read_context, as 0094's patient-reported health
--    information: the patient in a fresh patient-self transaction (0083) or
--    a clinician whose access at the current facility is granted
--    (ehr.context_allows ... 'read_records'), which covers the records
--    page, the staff read and both chats. A withdrawn entry is read by
--    nobody but the commands (D7).
-- 3. Commands, SECURITY DEFINER with search_path pg_catalog, pg_temp, only
--    in a fresh patient-self EHR transaction (ehr.patient_self_context of
--    app.patient_id, an account and a correlation id; else 42501):
--    a. ehr.create_my_patient_entry: invalid input, a date after today in
--       Lagos, a malformed key or digest raise 22023 PATIENT_ENTRY_INVALID;
--       under the advisory lock patient-entry:<patient>: the same key and
--       digest answer 'replayed' with the entry; the same key with another
--       digest 'key_reused' (nothing written); no key and an active entry
--       of the same digest and no key added in the last 60 seconds
--       'replayed'; 30 entries added in the last 24 hours, removed ones
--       included, 'limited' (audited as denied, counts only, nothing else
--       written); else the entry is added ('created').
--    b. ehr.withdraw_my_patient_entry: 'withdrawn', or 'already_withdrawn'
--       with the first time, or 'not_found' for an entry that is not the
--       patient's; the first withdrawal also deletes the patient's own chat
--       vectors of that entry. It cannot delete the staff chat's: their
--       forced row-level security admits only the clinician's own chat
--       transaction. ehr-api deletes a withdrawn entry's vectors from either
--       chunk table at that chat's next search, in the chat's own
--       transaction (the staff chat's, and the patient's should a search
--       that checked its sources before the withdrawal write them after it).
--       None is ever ranked meanwhile, since retrieval joins the current
--       sources.
--    Every write records its audit.events row in the same transaction:
--    ehr.patient-entry.create and ehr.patient-entry.withdraw, actor the
--    patient, resource patient-entry, with codes and booleans only (never a
--    title, place or note).
-- 4. Grants, here and in runtime-grants.sql: SELECT on the table and the
--    two commands to hid_ehr_runtime and hid_schema_test_runtime (the EHR
--    API's login inherits the first); no INSERT, UPDATE or DELETE grant;
--    every new function revoked from PUBLIC, the guard granted to nobody.
--    The chunk tables keep their grants.
-- 5. Post-checks: the new table and functions are the applier's and as
--    this file makes them (owner, forced RLS, the two policies, SECURITY
--    DEFINER, search_path, bodies), and the bodies relied on are unchanged.
-- 6. Chat evidence, last: patient_entry becomes a source kind of
--    ehr.patient_evidence_chunks and ehr.staff_evidence_chunks (their
--    shared CHECK patient_evidence_chunks_source_kind_check is dropped and
--    added NOT VALID with the 14 kinds, then validated); every other CHECK
--    of the two tables is unchanged.
--
-- Locks: SHARE ROW EXCLUSIVE on identity.patients (the new foreign key),
-- taken first, NOWAIT every 10 ms for at most 5 seconds (then 55P03 and
-- nothing applied), held to commit: patient sign-up and profile writes wait
-- for the apply, reads do not. Then, last, ACCESS EXCLUSIVE on both chunk
-- tables, taken the same way and held to commit (the runner applies the file
-- in one transaction, so VALIDATE does not narrow it): every chat search
-- waits for the rest of the apply. Measured with pg_locks before commit (the
-- file applied in an open transaction on a 0103 copy): SHARE ROW EXCLUSIVE
-- and ACCESS SHARE on identity.patients and ACCESS SHARE on its primary key;
-- ACCESS EXCLUSIVE and SHARE UPDATE EXCLUSIVE on ehr.patient_evidence_chunks
-- and ehr.staff_evidence_chunks; ACCESS EXCLUSIVE (and the weaker locks
-- creating it takes) on the new table and its indexes; no lock on
-- audit.events or any other existing table; the catalogs' own locks. The
-- apply took 28 ms on that copy. With a write held open on identity.patients,
-- or a read held open on either chunk table, it stopped after 5.5 s with
-- 55P03 and nothing applied.
--
-- Old services on this schema: every change is additive. Today's EHR image
-- reads no new object and writes only the 13 chunk kinds it knows, which the
-- wider CHECK still accepts. The new EHR image reads ehr.patient_entries and
-- writes patient_entry chunks only while PATIENT_ENTRIES_ENABLED is on, which
-- defaults to on since the owner's decision of 4 Nov 2026: that image runs
-- before this migration only with PATIENT_ENTRIES_ENABLED=false. Applied
-- migrations 0001 through 0106 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0094's helper).
create function pg_temp.patient_entries_holds(holder oid, object_owner oid, object_acl aclitem[],
  object_type "char", wanted text)
returns boolean
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  with recursive held(role_id) as (
    select holder
    union
    select membership.roleid from pg_catalog.pg_auth_members membership join held on membership.member = held.role_id
  )
  select object_owner in (select held.role_id from held)
    or exists (select 1 from pg_catalog.aclexplode(coalesce(object_acl, pg_catalog.acldefault(object_type, object_owner))) acl
                where acl.privilege_type = wanted
                  and (acl.grantee = 0 or acl.grantee in (select held.role_id from held)))
$$;

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  -- a. Prerequisites: 0001-0103 (0103's body is the marker).
  if to_regprocedure('identity.organization_application_admin_account(text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = 'identity.organization_application_admin_account(text)'::regprocedure)
        is distinct from '186eb4ca420749b8bdb324bdc843bc50'
     or to_regclass('identity.patients') is null
     or to_regclass('audit.events') is null
     or to_regclass('ehr.patient_evidence_chunks') is null
     or to_regclass('ehr.staff_evidence_chunks') is null then
    raise exception using errcode = '55000', message = '0116: 0001-0103 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('ehr.patient_entries') is not null
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and proc.proname in ('create_my_patient_entry', 'withdraw_my_patient_entry',
                     'patient_entries_guard')) then
    raise exception using errcode = '55000', message = '0116: already applied';
  end if;
  -- c. The bodies the commands, the read policy and the triggers rely on:
  -- the patient-self and clinician read contexts, the consent check and the
  -- membership check behind them, the request-context readers they use, the
  -- no-delete trigger and the audit table's authority trigger.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'),
      ('ehr.imported_record_read_context(uuid)', 'eabd4af535ecf91508eae6003836e427'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- Their security attributes: the patient-self context, the consent and
  -- membership checks run as their owner, the read context as its caller.
  if mismatch is null then
    select string_agg(expected.proc, '; ') into mismatch
      from (values
        ('ehr.patient_self_context(uuid)', true, '{"search_path=pg_catalog, pg_temp"}'),
        ('ehr.imported_record_read_context(uuid)', false, '{"search_path=ehr, platform, pg_temp"}'),
        ('ehr.context_allows(uuid,uuid,text)', true, '{"search_path=ehr, identity, platform, pg_temp"}'),
        ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', true,
         '{"search_path=identity, auth, pg_temp"}'),
        ('identity.has_active_membership(text,uuid,uuid)', true, '{"search_path=identity, auth, pg_temp"}'))
           expected(proc, definer, config)
     where not exists (select 1 from pg_proc proc
                        where proc.oid = to_regprocedure(expected.proc)
                          and proc.prosecdef = expected.definer and proc.provolatile = 's'
                          and proc.proconfig = expected.config::text[]);
    if mismatch is not null then mismatch := 'attributes of ' || mismatch; end if;
  end if;
  -- d. The CHECKs this file writes through (the source-kind CHECK of both
  -- chunk tables, 0069's 13 kinds) and the audit rules the new rows pass.
  if mismatch is null
     and (select count(*) from pg_constraint constraint_row
           where constraint_row.conrelid in ('ehr.patient_evidence_chunks'::regclass, 'ehr.staff_evidence_chunks'::regclass)
             and constraint_row.contype = 'c' and constraint_row.convalidated
             and constraint_row.conname = 'patient_evidence_chunks_source_kind_check'
             and md5(pg_get_constraintdef(constraint_row.oid)) = '397f23b4607a022f7ef782d36898e2b9') <> 2 then
    mismatch := 'patient_evidence_chunks_source_kind_check on ehr.patient_evidence_chunks and ehr.staff_evidence_chunks';
  end if;
  if mismatch is null
     and (select count(*) from pg_constraint constraint_row
           where constraint_row.conrelid = 'audit.events'::regclass and constraint_row.contype = 'c'
             and constraint_row.convalidated
             and (constraint_row.conname, md5(pg_get_constraintdef(constraint_row.oid))) in (
               ('audit_actor_type_ck', 'd630642d19ec60d7d0cfab2d90533dba'),
               ('audit_actor_facility_ck', 'd74856f4b11b9e7e378d1a586f3a284b'),
               ('audit_platform_scope_ck', 'bc5f610696515dc7475eadde912e0a30'),
               ('events_correlation_id_check', '9066882d9638362e3e51196825b0a764'),
               ('events_outcome_check', '8ec48394933b68472efacffc62cfeda2'),
               ('events_provenance_check', '6bf802bf3aa55c42b5c3752b204fbad1'),
               ('events_details_check', '13e7eaeabe2055f5d8a517bf0fc75a88'),
               ('events_action_check', 'a3aa891e6aa8e44df4b69cb2eaff7c10'))) <> 8 then
    mismatch := 'the audit.events constraints the new rows must pass';
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
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0116: an object this migration relies on differs from 0001-0106: %s', mismatch);
  end if;
  -- e. Privileges, never through a superuser's bypass (production's
  -- migrator has none).
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s lacks %s on %s', holder.rolname, wanted.privilege, relation.oid::regclass) as what
        from (values ('identity.patients', 'OWNER'), ('audit.events', 'INSERT')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
        join pg_roles holder on holder.oid = applier
       where case when wanted.privilege = 'OWNER'
               then not pg_temp.patient_entries_holds(applier, relation.relowner, null::aclitem[], 'r', 'OWNER')
               else not pg_temp.patient_entries_holds(applier, relation.relowner, relation.relacl, 'r', wanted.privilege) end
      union all
      select format('%s is not %s and may not act as it (INHERIT and SET) for %s', holder.rolname,
               pg_get_userbyid(relation.relowner), relation.oid::regclass)
        from pg_class relation
        join pg_roles holder on holder.oid = applier
       where relation.oid in ('ehr.patient_evidence_chunks'::regclass, 'ehr.staff_evidence_chunks'::regclass)
         and relation.relowner <> applier
         and not (pg_temp.patient_entries_holds(applier, relation.relowner, null::aclitem[], 'r', 'OWNER')
           and pg_has_role(applier, relation.relowner, 'USAGE') and pg_has_role(applier, relation.relowner, 'SET'))
      union all
      select format('%s lacks CREATE on schema %s', holder.rolname, namespace.nspname)
        from pg_namespace namespace
        join pg_roles holder on holder.oid = applier
       where namespace.nspname = 'ehr'
         and not pg_temp.patient_entries_holds(applier, namespace.nspowner, namespace.nspacl, 'n', 'CREATE')
      union all
      select format('%s lacks EXECUTE on %s', holder.rolname, proc.oid::regprocedure)
        from (values
          ('ehr.patient_self_context(uuid)'), ('ehr.imported_record_read_context(uuid)'),
          ('platform.current_correlation_id()'), ('platform.current_actor_subject()'),
          ('platform.reject_mutation()')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
        join pg_roles holder on holder.oid = applier
       where not pg_temp.patient_entries_holds(applier, proc.proowner, proc.proacl, 'f', 'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0116: missing privileges: %s', mismatch);
  end if;
  raise notice '0116: owners checked: %', (
    select string_agg(format('%s=%s', owned.what, owned.owner), ', ' order by owned.what)
      from (select relation.oid::regclass::text as what, pg_get_userbyid(relation.relowner)::text as owner
              from pg_class relation
             where relation.oid in ('identity.patients'::regclass, 'ehr.patient_evidence_chunks'::regclass,
                                    'ehr.staff_evidence_chunks'::regclass)
            union all
            select 'new table and functions', current_user::text) owned);
end
$$;

-- 1. The lock the new foreign key takes, up front and bounded.
do $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table identity.patients in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0116: identity.patients stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 2. The records patients add themselves.
create table ehr.patient_entries (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  kind text not null check (kind in ('visit', 'test', 'medicine', 'diagnosis', 'vaccination', 'other')),
  title text not null check (length(title) between 2 and 160 and title !~ '[\u0001-\u001f\u007f-\u009f]'),
  facility_name text check (facility_name is null
    or (length(facility_name) between 1 and 160 and facility_name !~ '[\u0001-\u001f\u007f-\u009f]')),
  occurred_on date not null check (occurred_on >= date '1900-01-01'),
  notes text check (notes is null
    or (length(notes) between 1 and 1000 and notes !~ '[\u0001-\u0009\u000b-\u001f\u007f-\u009f]')),
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  withdrawn_at timestamptz,
  created_by_account_id uuid not null,
  idempotency_key text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint patient_entries_withdrawn_check check ((status = 'withdrawn') = (withdrawn_at is not null)),
  constraint patient_entries_idempotency_key_uq unique (patient_id, idempotency_key)
);
create index patient_entries_patient_list_idx
  on ehr.patient_entries (patient_id, status, occurred_on desc, created_at desc);

-- Only active to withdrawn: withdrawn_at set, row_version + 1, every other
-- column but updated_at unchanged.
create function ehr.patient_entries_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status = 'active' and new.status = 'withdrawn' and new.withdrawn_at is not null
     and new.row_version = old.row_version + 1
     and (new.id, new.patient_id, new.kind, new.title, new.facility_name, new.occurred_on, new.notes,
          new.created_by_account_id, new.idempotency_key, new.request_sha256, new.created_at)
         is not distinct from
         (old.id, old.patient_id, old.kind, old.title, old.facility_name, old.occurred_on, old.notes,
          old.created_by_account_id, old.idempotency_key, old.request_sha256, old.created_at) then
    return new;
  end if;
  raise exception using errcode = '55000',
    message = 'A record a patient added changes only from active to withdrawn';
end
$$;
create trigger patient_entries_one_way
  before update on ehr.patient_entries
  for each row execute function ehr.patient_entries_guard();
create trigger patient_entries_no_delete
  before delete on ehr.patient_entries
  for each row execute function platform.reject_mutation();
create trigger patient_entries_no_truncate
  before truncate on ehr.patient_entries
  for each statement execute function platform.reject_mutation();

alter table ehr.patient_entries enable row level security;
alter table ehr.patient_entries force row level security;
do $$
begin
  execute format('create policy patient_entries_owner on ehr.patient_entries for all '
    || 'using (current_user = %L) with check (current_user = %L)', current_user, current_user);
end
$$;
create policy patient_entries_read on ehr.patient_entries
  for select using (status = 'active' and ehr.imported_record_read_context(patient_id));
revoke all on ehr.patient_entries from public;

-- 3a. The patient adds a record (fresh patient-self context).
create function ehr.create_my_patient_entry(requested_kind text, requested_title text, requested_facility_name text,
  requested_occurred_on date, requested_notes text, requested_idempotency_key text, requested_request_sha256 text)
returns table (outcome text, entry_id uuid, entry_kind text, entry_title text, entry_facility_name text,
  entry_occurred_on date, entry_notes text, entry_created_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  uuid_shape constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  claimed_patient text := nullif(current_setting('app.patient_id', true), '');
  claimed_account text := nullif(current_setting('app.account_id', true), '');
  claimed_subject text := nullif(current_setting('app.actor_subject', true), '');
  one_line constant text := '[\u0001-\u001f\u007f-\u009f]';
  with_newlines constant text := '[\u0001-\u0009\u000b-\u001f\u007f-\u009f]';
  patient_id_value uuid;
  existing ehr.patient_entries%rowtype;
  added_today bigint;
begin
  if claimed_patient is null or claimed_patient !~ uuid_shape or claimed_account is null
     or claimed_account !~ uuid_shape or platform.current_correlation_id() is null
     or not ehr.patient_self_context(claimed_patient::uuid) then
    raise exception using errcode = '42501', message = 'Patient self context is required';
  end if;
  patient_id_value := claimed_patient::uuid;
  if requested_kind is null
     or requested_kind not in ('visit', 'test', 'medicine', 'diagnosis', 'vaccination', 'other')
     or requested_title is null or length(requested_title) not between 2 and 160
     or requested_title ~ one_line or requested_title <> btrim(requested_title)
     or (requested_facility_name is not null
       and (length(requested_facility_name) not between 1 and 160 or requested_facility_name ~ one_line
         or requested_facility_name <> btrim(requested_facility_name)))
     or requested_occurred_on is null or requested_occurred_on < date '1900-01-01'
     or requested_occurred_on > (clock_timestamp() at time zone 'Africa/Lagos')::date
     or (requested_notes is not null
       and (length(requested_notes) not between 1 and 1000 or requested_notes ~ with_newlines))
     or (requested_idempotency_key is not null
       and requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$')
     or requested_request_sha256 is null or requested_request_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'PATIENT_ENTRY_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-entry:' || patient_id_value::text, 0));
  if requested_idempotency_key is not null then
    select entry.* into existing from ehr.patient_entries entry
     where entry.patient_id = patient_id_value and entry.idempotency_key = requested_idempotency_key;
    if found then
      if existing.request_sha256 = requested_request_sha256 then
        return query select 'replayed'::text, existing.id, existing.kind, existing.title, existing.facility_name,
          existing.occurred_on, existing.notes, existing.created_at;
      else
        return query select 'key_reused'::text, null::uuid, null::text, null::text, null::text, null::date,
          null::text, null::timestamptz;
      end if;
      return;
    end if;
  else
    select entry.* into existing from ehr.patient_entries entry
     where entry.patient_id = patient_id_value and entry.idempotency_key is null
       and entry.request_sha256 = requested_request_sha256 and entry.status = 'active'
       and entry.created_at > clock_timestamp() - interval '60 seconds'
     order by entry.created_at desc, entry.id desc
     limit 1;
    if found then
      return query select 'replayed'::text, existing.id, existing.kind, existing.title, existing.facility_name,
        existing.occurred_on, existing.notes, existing.created_at;
      return;
    end if;
  end if;
  select count(*) into added_today from ehr.patient_entries entry
   where entry.patient_id = patient_id_value and entry.created_at > clock_timestamp() - interval '24 hours';
  if added_today >= 30 then
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
      action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'patient', claimed_subject, claimed_account::uuid, patient_id_value,
      'ehr.patient-entry.create', 'denied', 'patient-entry', null, 'patient-self', 'application', 'ehr-api',
      jsonb_build_object('reason', 'daily_limit', 'limit', 30, 'windowHours', 24));
    return query select 'limited'::text, null::uuid, null::text, null::text, null::text, null::date,
      null::text, null::timestamptz;
    return;
  end if;
  insert into ehr.patient_entries (patient_id, kind, title, facility_name, occurred_on, notes,
    created_by_account_id, idempotency_key, request_sha256)
  values (patient_id_value, requested_kind, requested_title, requested_facility_name, requested_occurred_on,
    requested_notes, claimed_account::uuid, requested_idempotency_key, requested_request_sha256)
  returning * into existing;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'patient', claimed_subject, claimed_account::uuid, patient_id_value,
    'ehr.patient-entry.create', 'success', 'patient-entry', existing.id::text, 'patient-self', 'application',
    'ehr-api', jsonb_build_object('kind', existing.kind, 'hasFacilityName', existing.facility_name is not null,
      'hasNotes', existing.notes is not null));
  return query select 'created'::text, existing.id, existing.kind, existing.title, existing.facility_name,
    existing.occurred_on, existing.notes, existing.created_at;
end
$$;

-- 3b. The patient removes a record they added: hidden everywhere, kept (D7).
create function ehr.withdraw_my_patient_entry(requested_entry_id uuid)
returns table (outcome text, entry_id uuid, entry_withdrawn_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  uuid_shape constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  claimed_patient text := nullif(current_setting('app.patient_id', true), '');
  claimed_account text := nullif(current_setting('app.account_id', true), '');
  claimed_subject text := nullif(current_setting('app.actor_subject', true), '');
  patient_id_value uuid;
  existing ehr.patient_entries%rowtype;
begin
  if claimed_patient is null or claimed_patient !~ uuid_shape or claimed_account is null
     or claimed_account !~ uuid_shape or platform.current_correlation_id() is null
     or not ehr.patient_self_context(claimed_patient::uuid) then
    raise exception using errcode = '42501', message = 'Patient self context is required';
  end if;
  patient_id_value := claimed_patient::uuid;
  perform pg_advisory_xact_lock(hashtextextended('patient-entry:' || patient_id_value::text, 0));
  select entry.* into existing from ehr.patient_entries entry
   where entry.id = requested_entry_id and entry.patient_id = patient_id_value
     for update;
  if not found then
    return query select 'not_found'::text, requested_entry_id, null::timestamptz;
    return;
  end if;
  if existing.status = 'withdrawn' then
    return query select 'already_withdrawn'::text, existing.id, existing.withdrawn_at;
    return;
  end if;
  update ehr.patient_entries entry
     set status = 'withdrawn', withdrawn_at = clock_timestamp(), updated_at = clock_timestamp(),
         row_version = entry.row_version + 1
   where entry.id = existing.id
  returning entry.* into existing;
  -- The patient's own chat vectors of the entry (derived data, never truth).
  delete from ehr.patient_evidence_chunks chunk
   where chunk.patient_id = patient_id_value and chunk.source_kind = 'patient_entry'
     and chunk.source_id = existing.id;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'patient', claimed_subject, claimed_account::uuid, patient_id_value,
    'ehr.patient-entry.withdraw', 'success', 'patient-entry', existing.id::text, 'patient-self', 'application',
    'ehr-api', jsonb_build_object('kind', existing.kind));
  return query select 'withdrawn'::text, existing.id, existing.withdrawn_at;
end
$$;

-- 4. Grants (here and in runtime-grants.sql).
revoke all on function ehr.create_my_patient_entry(text,text,text,date,text,text,text),
  ehr.withdraw_my_patient_entry(uuid), ehr.patient_entries_guard() from public;
do $$
declare grantee text;
begin
  foreach grantee in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant select on ehr.patient_entries to %I', grantee);
      execute format('grant execute on function ehr.create_my_patient_entry(text,text,text,date,text,text,text), '
        || 'ehr.withdraw_my_patient_entry(uuid) to %I', grantee);
    end if;
  end loop;
end
$$;

comment on table ehr.patient_entries is
  'Records a patient added themselves (text), not checked by a health worker; shown as added by the patient. Written only by ehr.create_my_patient_entry and ehr.withdraw_my_patient_entry; a withdrawn entry is read by nobody and kept.';
comment on function ehr.create_my_patient_entry(text,text,text,date,text,text,text) is
  'Adds a record for the patient of a fresh patient-self transaction: created, replayed (same key and digest, or the same digest without a key within 60 seconds), key_reused or limited (30 a day).';
comment on function ehr.withdraw_my_patient_entry(uuid) is
  'Withdraws a record the patient of a fresh patient-self transaction added: withdrawn, already_withdrawn or not_found. The row is kept; the patient''s own chat vectors of it are deleted.';
comment on function ehr.patient_entries_guard() is
  'A record a patient added changes only from active to withdrawn.';

-- 5. Post-checks.
do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  if not exists (select 1 from pg_class relation
                  where relation.oid = 'ehr.patient_entries'::regclass and relation.relowner = applier
                    and relation.relrowsecurity and relation.relforcerowsecurity)
     or (select string_agg(policy.polname, ', ' order by policy.polname) from pg_policy policy
          where policy.polrelid = 'ehr.patient_entries'::regclass)
        is distinct from 'patient_entries_owner, patient_entries_read' then
    mismatch := 'ehr.patient_entries (owner, forced row-level security or policies)';
  end if;
  if mismatch is null then
    select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
      into mismatch
      from (values
        ('ehr.create_my_patient_entry(text,text,text,date,text,text,text)', true, '280b73ca5151f73ffac6256bf81110af'),
        ('ehr.withdraw_my_patient_entry(uuid)', true, '172d17d8abb9d237ba4fa6fd06ddeb21'),
        ('ehr.patient_entries_guard()', false, 'f04a4337f2d2be151d2483af0ba0207c'))
           expected(proc, definer, digest)
      left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
     where proc.oid is null or md5(proc.prosrc) is distinct from expected.digest or proc.proowner <> applier
        or proc.prosecdef <> expected.definer
        or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[];
  end if;
  if mismatch is null then
    select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
      into mismatch
      from (values
        ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'),
        ('ehr.imported_record_read_context(uuid)', 'eabd4af535ecf91508eae6003836e427'),
        ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
        ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '732d11892dd4e27e1ff9093ae3b7de5a'),
        ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
        ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'))
           expected(proc, digest)
      left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
     where md5(proc.prosrc) is distinct from expected.digest;
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0116: post-check failed: %s', mismatch);
  end if;
end
$$;

-- 6. Chat evidence, last: the lock on both chunk tables, up front and
-- bounded, then the source-kind CHECK written through with patient_entry.
do $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.patient_evidence_chunks, ehr.staff_evidence_chunks in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0116: the chat search tables stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;
alter table ehr.patient_evidence_chunks
  drop constraint patient_evidence_chunks_source_kind_check,
  add constraint patient_evidence_chunks_source_kind_check check (source_kind in ('note', 'encounter', 'diagnosis',
    'prescription', 'investigation', 'vital', 'import', 'import_version', 'health_profile', 'lab_result', 'attachment',
    'document', 'profile', 'patient_entry')) not valid;
alter table ehr.patient_evidence_chunks validate constraint patient_evidence_chunks_source_kind_check;
alter table ehr.staff_evidence_chunks
  drop constraint patient_evidence_chunks_source_kind_check,
  add constraint patient_evidence_chunks_source_kind_check check (source_kind in ('note', 'encounter', 'diagnosis',
    'prescription', 'investigation', 'vital', 'import', 'import_version', 'health_profile', 'lab_result', 'attachment',
    'document', 'profile', 'patient_entry')) not valid;
alter table ehr.staff_evidence_chunks validate constraint patient_evidence_chunks_source_kind_check;

-- The two CHECKs as written, validated; every other CHECK of the two tables
-- as 0067, 0069 and 0070 left it.
do $$
begin
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.conrelid in ('ehr.patient_evidence_chunks'::regclass, 'ehr.staff_evidence_chunks'::regclass)
         and constraint_row.contype = 'c' and constraint_row.convalidated
         and (constraint_row.conname, md5(pg_get_constraintdef(constraint_row.oid))) in (
           ('patient_evidence_chunks_source_kind_check', '392152e0fd4834262de048c7b9027151'),
           ('patient_evidence_chunks_chunk_no_check', 'd4ae960c85bf97e058d641877bd560ee'),
           ('patient_evidence_chunks_model_id_check', 'afcc38827908755887318a60c0860911'),
           ('patient_evidence_chunks_normalizer_version_check', '6fbc583f60344327350aea0741ee5969'),
           ('patient_evidence_chunks_source_hash_check', '740cf637b654a9226e2d17711debd38c'),
           ('patient_evidence_chunks_source_version_check', 'bc99e4320b5c83fb21491387f477999c'),
           ('staff_evidence_chunks_purpose_of_use_check', 'f889369f4e96e9e156544fc087fb1a72'))) <> 13
     or (select count(*) from pg_constraint constraint_row
          where constraint_row.conrelid in ('ehr.patient_evidence_chunks'::regclass, 'ehr.staff_evidence_chunks'::regclass)
            and constraint_row.contype = 'c') <> 13 then
    raise exception using errcode = '55000',
      message = '0116: post-check failed: the chunk tables'' CHECKs are not as this file leaves them';
  end if;
end
$$;
drop function pg_temp.patient_entries_holds(oid, oid, aclitem[], "char", text);
