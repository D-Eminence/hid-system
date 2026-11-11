-- 0118 OCR correction observations (learning phase 2, part 1 of 2; Session B).
-- Owner decision Q43 of 2026-11-11, relayed by the coordinator: the reading
-- learns from the corrections staff already make, with no extra work for
-- them; a correction rule switches on by itself only after at least 5
-- identical corrections from at least 3 different staff with no conflicting
-- correction; suggestions only; sensitive classes are never covered;
-- retention and "no AI training" unchanged. Coordinator answers of the same
-- day: an item saved unchanged is neither support nor conflict; 180 days for
-- both the evidence window and the purge; the staff key is an HMAC made with a
-- key the migration creates inside the database (no new deployment secret).
-- 0119 adds the rules, their showings, the kill switches and the
-- platform-wide quality summary. The declaration is signed separately
-- (reviewed_by is empty until the owner signs). Provisional number: it gets
-- the next free number at merge.
--
-- What it adds. One row per corrected field of a linked reading item, written
-- by ocr-api after the validation committed, in its own transaction. Nothing read from the paper
-- is stored:
--   - the rule key is (field_class, read_digest): ocr-api computes the
--     SHA-256 of 'hid.ocr.learning/v1|' || field || '|' || the normalised
--     value the reading gave (the text itself never reaches the database),
--     and the database stores HMAC-SHA-256 of that digest under the key below,
--     so a stored digest cannot be checked against guessed text without the
--     key;
--   - suggest_value is the value the reviewer saved, and only when it is a
--     value of a closed list (the drug list's generic or brand spelling, a
--     strength in number-and-unit form, a frequency code, a lab test name or
--     unit of the lab list); otherwise the row is a conflict (suggest_value
--     NULL: the reviewer saved something else);
--   - staff_key is HMAC-SHA-256(account id, a 32-byte key made here with
--     gen_random_bytes and readable only by the OCR functions' owner): enough
--     to count distinct staff, never who; validation_key is the HMAC of the
--     validation id, so a row cannot be joined to a validation (and through
--     it to a patient) without the key. Dumps carry the key with the rows;
--     the key only pseudonymises (declaration evidence).
-- ocr-api writes nothing for an item saved unchanged, an unlinked item, an
-- EHR note, or any document whose reading holds a sensitive item (ARVs and
-- HIV, TB, psychiatric, sickle cell: ocr-api's versioned class list).
--
-- 1. Tables (no runtime role has any privilege on them; row-level security is
--    on and forced with one policy for the OCR functions' owner, as 0107):
--    - ocr.learning_key (one row: id 1, key bytea of 32 bytes, created_at);
--    - ocr.correction_observations (id, facility_id -> identity.facilities,
--      field_class name | strength | frequency | test | unit | diagnosis,
--      read_digest bytea of 32 bytes, suggest_value NULL or 1-120 characters
--      of ^[A-Za-z0-9][A-Za-z0-9 .,+/%()'-]*$, staff_key bytea of 32 bytes,
--      validation_key bytea of 32 bytes (the validation id's HMAC; no
--      foreign key: the purge of 0112 and this one stay independent),
--      observed_at); unique (validation_key, field_class, read_digest), so a
--      replay adds nothing; indexed by (field_class,
--      read_digest, observed_at) for 0119's evaluation and by observed_at for
--      the purge.
-- 2. Functions (SECURITY DEFINER, search_path pinned, owned by the OCR
--    functions' owner, EXECUTE revoked from PUBLIC):
--    - ocr.record_correction_observations(validation, observations jsonb)
--      -> integer (rows added), for ocr-api (hid_ocr_runtime): a session
--      naming a facility and an active membership there holding
--      ocr.validation.write; the validation is an accepted one (disposition
--      validated) of that facility, made by that membership and account in
--      the last 10 minutes (the same request; else P0002); the
--      observations a JSON array of at most 200 objects with exactly
--      field, readDigest (64 hex digits) and suggestValue (NULL or as the
--      column) (else 22023, nothing written). The read digest and the
--      validation id are stored as HMACs under the key. It also deletes up to 1000 rows
--      older than 180 days (any facility).
--    - ocr.purge_correction_observations(limit 1-100000) -> integer, for the
--      OCR worker (hid_ocr_worker), which calls it with its 7-day source
--      sweep: deletes up to that many rows older than 180 days, oldest first.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): ocr.jobs, ocr.validations, identity.facilities
--    and auth.accounts present; public.hmac(bytea, bytea, text) and
--    public.gen_random_bytes(integer) (pgcrypto, 0001); not applied yet; md5
--    of the session helpers, auth.membership_has_permission,
--    auth.account_id_for_subject and auth.account_has_active_role as 0107
--    pins them; the permission ocr.validation.write and the role ocr_worker; the runtime roles
--    hid_ocr_runtime, hid_ocr_api_runtime (a member of it) and hid_ocr_worker,
--    where they exist, neither superuser nor BYPASSRLS; ocr.jobs and
--    ocr.validations share one owner, which may create in schema ocr, and the
--    applier is it or a member that inherits it and may SET ROLE to it.
-- 3. Owners, policies, REVOKE FROM PUBLIC and grants (here when the roles
--    exist, and in runtime-grants.sql, which gains the same 0118 block).
-- 4. Post-checks: attributes, owners, ACLs, row-level security (the key row
--    is not counted here: an applier acting for the owner sees no row of a
--    table whose only policy is the owner's).
--
-- Locks: beyond ACCESS SHARE, only the two new tables and their indexes and
-- SHARE ROW EXCLUSIVE on identity.facilities (the foreign key); no row of an
-- existing table is read or written. Behind a session holding ACCESS
-- EXCLUSIVE on identity.facilities the runner stops after its 5 s
-- lock_timeout with nothing applied.
--
-- Old services on this schema: nothing existing changes; today's ocr-api,
-- ocr-worker and identity-api images never call the new functions.
-- Applied migrations are immutable.

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
  ocr_owner oid;
begin
  -- a. Prerequisites.
  if to_regclass('ocr.jobs') is null
     or to_regclass('ocr.validations') is null
     or to_regclass('identity.facilities') is null
     or to_regclass('auth.accounts') is null
     or to_regprocedure('public.hmac(bytea,bytea,text)') is null
     or to_regprocedure('public.gen_random_bytes(integer)') is null then
    raise exception using errcode = '55000',
      message = '0118: ocr.validations, identity.facilities and pgcrypto (0001) must be present first';
  end if;
  -- b. Not applied yet (nor partly present).
  if to_regclass('ocr.learning_key') is not null
     or to_regclass('ocr.correction_observations') is not null
     or to_regprocedure('ocr.record_correction_observations(uuid,jsonb)') is not null
     or to_regprocedure('ocr.purge_correction_observations(integer)') is not null then
    raise exception using errcode = '55000', message = '0118: already applied';
  end if;
  -- c. The bodies relied on (as 0107 pins them).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('auth.account_has_active_role(uuid,text)', 'a3310b48da6ff8bcd3ecb9d7dbef900a'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is null and (not exists (select 1 from auth.permissions where code = 'ocr.validation.write')
       or not exists (select 1 from auth.roles where code = 'ocr_worker')) then
    mismatch := 'the permission ocr.validation.write or the role ocr_worker';
  end if;
  if mismatch is null then
    select string_agg(role_row.rolname, ', ') into mismatch
      from pg_roles role_row
     where role_row.rolname in ('hid_ocr_worker', 'hid_ocr_runtime', 'hid_ocr_api_runtime')
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
      message = format('0118: an object this migration relies on differs from what it expects: %s', mismatch);
  end if;
  -- d. One owner for ocr.jobs and ocr.validations; it may create in schema
  -- ocr; the applier is it, or a member that inherits it and may SET ROLE to
  -- it (never a superuser's bypass alone).
  ocr_owner := (select relowner from pg_class where oid = 'ocr.jobs'::regclass);
  if (select relowner from pg_class where oid = 'ocr.validations'::regclass) <> ocr_owner then
    raise exception using errcode = '55000', message = '0118: ocr.jobs and ocr.validations must share one owner';
  end if;
  if not has_schema_privilege(ocr_owner, 'ocr', 'CREATE') then
    raise exception using errcode = '55000',
      message = format('0118: %s may not create in schema ocr', pg_get_userbyid(ocr_owner));
  end if;
  if applier <> ocr_owner
     and not (pg_has_role(applier, ocr_owner, 'USAGE') and pg_has_role(applier, ocr_owner, 'SET')) then
    raise exception using errcode = '42501',
      message = format('0118: %s is not %s and may not act as it (INHERIT and SET)', current_user,
        pg_get_userbyid(ocr_owner));
  end if;
  raise notice '0118: owners checked: ocr.jobs=%, applier=%', pg_get_userbyid(ocr_owner), current_user;
end;
$$;

-- 1. Tables.
create table ocr.learning_key (
  id smallint primary key check (id = 1),
  key bytea not null check (octet_length(key) = 32),
  created_at timestamptz not null default clock_timestamp()
);
insert into ocr.learning_key (id, key) values (1, public.gen_random_bytes(32));

create table ocr.correction_observations (
  id bigint generated always as identity primary key,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  field_class text not null check (field_class in ('name', 'strength', 'frequency', 'test', 'unit', 'diagnosis')),
  read_digest bytea not null check (octet_length(read_digest) = 32),
  suggest_value text check (suggest_value is null or (length(suggest_value) between 1 and 120
    and suggest_value ~ '^[A-Za-z0-9][A-Za-z0-9 .,+/%()''-]*$')),
  staff_key bytea not null check (octet_length(staff_key) = 32),
  validation_key bytea not null check (octet_length(validation_key) = 32),
  observed_at timestamptz not null default clock_timestamp(),
  unique (validation_key, field_class, read_digest)
);
create index ocr_correction_observations_key_idx
  on ocr.correction_observations (field_class, read_digest, observed_at);
create index ocr_correction_observations_observed_idx on ocr.correction_observations (observed_at);

alter table ocr.learning_key enable row level security;
alter table ocr.learning_key force row level security;
alter table ocr.correction_observations enable row level security;
alter table ocr.correction_observations force row level security;
revoke all on ocr.learning_key, ocr.correction_observations from public;

comment on table ocr.learning_key is
  '0118: the 32-byte key of the staff HMAC (made here with gen_random_bytes; no deployment secret). It only pseudonymises counts. Read only by the OCR functions'' owner.';
comment on table ocr.correction_observations is
  '0118: one corrected field of a linked OCR reading item: a digest of the value read (never the text), the closed-list value saved (NULL: something else was saved, a conflict) and an HMAC of the staff account. Kept 180 days. Only the 0118/0119 SECURITY DEFINER functions touch it.';

-- 2. Functions.
create function ocr.record_correction_observations(requested_validation_id uuid, requested_observations jsonb)
returns integer
language plpgsql volatile security definer
set search_path = pg_catalog, ocr, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := platform.current_account_id();
  session_facility uuid := platform.current_facility_id();
  session_membership uuid := platform.current_membership_id();
  learning_key bytea;
  added integer;
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
  if requested_observations is null or jsonb_typeof(requested_observations) <> 'array'
     or jsonb_array_length(requested_observations) > 200
     or exists (
       select 1 from jsonb_array_elements(requested_observations) entry
        where jsonb_typeof(entry) <> 'object'
           or (select array_agg(key order by key) from jsonb_object_keys(entry) key)
              <> array['field', 'readDigest', 'suggestValue']
           or jsonb_typeof(entry -> 'field') <> 'string'
           or entry ->> 'field' not in ('name', 'strength', 'frequency', 'test', 'unit', 'diagnosis')
           or jsonb_typeof(entry -> 'readDigest') <> 'string'
           or entry ->> 'readDigest' !~ '^[0-9a-f]{64}$'
           or jsonb_typeof(entry -> 'suggestValue') not in ('string', 'null')
           or (jsonb_typeof(entry -> 'suggestValue') = 'string'
               and (length(entry ->> 'suggestValue') not between 1 and 120
                    or entry ->> 'suggestValue' !~ '^[A-Za-z0-9][A-Za-z0-9 .,+/%()''-]*$'))) then
    raise exception using errcode = '22023', message = 'Invalid OCR correction observations';
  end if;
  select key_row.key into strict learning_key from ocr.learning_key key_row where key_row.id = 1;
  insert into ocr.correction_observations
    (facility_id, field_class, read_digest, suggest_value, staff_key, validation_key)
  select session_facility, entry ->> 'field',
         public.hmac(decode(entry ->> 'readDigest', 'hex'), learning_key, 'sha256'), entry ->> 'suggestValue',
         public.hmac(convert_to(actor_account::text, 'UTF8'), learning_key, 'sha256'),
         public.hmac(convert_to(requested_validation_id::text, 'UTF8'), learning_key, 'sha256')
    from jsonb_array_elements(requested_observations) entry
  on conflict (validation_key, field_class, read_digest) do nothing;
  get diagnostics added = row_count;
  -- Retention: 180 days (the evidence window). The worker's sweep purges too.
  delete from ocr.correction_observations old_row
   where old_row.id in (select candidate.id from ocr.correction_observations candidate
                         where candidate.observed_at < clock_timestamp() - interval '180 days'
                         order by candidate.observed_at limit 1000);
  return added;
end
$$;

create function ocr.purge_correction_observations(requested_limit integer)
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
  delete from ocr.correction_observations old_row
   where old_row.id in (select candidate.id from ocr.correction_observations candidate
                         where candidate.observed_at < clock_timestamp() - interval '180 days'
                         order by candidate.observed_at limit requested_limit);
  get diagnostics removed = row_count;
  return removed;
end
$$;

-- 3. Owners, policies, ACLs. New objects belong to the OCR functions' owner
-- (the applier, or the owner it acts as), whose policy is the tables' only one.
do $$
declare
  ocr_owner name := (select pg_get_userbyid(relowner) from pg_class where oid = 'ocr.jobs'::regclass);
begin
  if ocr_owner <> current_user then
    execute format('alter table ocr.learning_key owner to %I', ocr_owner);
    execute format('alter table ocr.correction_observations owner to %I', ocr_owner);
    execute format('alter function ocr.record_correction_observations(uuid,jsonb) owner to %I', ocr_owner);
    execute format('alter function ocr.purge_correction_observations(integer) owner to %I', ocr_owner);
  end if;
  execute format('create policy learning_key_owner on ocr.learning_key for all '
    || 'using (current_user = %L) with check (current_user = %L)', ocr_owner, ocr_owner);
  execute format('create policy correction_observations_owner on ocr.correction_observations for all '
    || 'using (current_user = %L) with check (current_user = %L)', ocr_owner, ocr_owner);
end
$$;

revoke all on function ocr.record_correction_observations(uuid,jsonb),
  ocr.purge_correction_observations(integer) from public;

comment on function ocr.record_correction_observations(uuid,jsonb) is
  '0118: ocr-api records the corrected fields of one validation (digest of the value read, closed-list value saved or NULL, staff HMAC), after the validation committed, in its own transaction; purges rows older than 180 days.';
comment on function ocr.purge_correction_observations(integer) is
  '0118: the OCR worker deletes correction observations older than 180 days, oldest first, up to the limit.';

-- Grants (the same in runtime-grants.sql's 0118 block). A release applies only
-- migrations, so the roles that already exist get them here; on a fresh
-- database the role bootstrap makes them.
do $$
declare
  wanted record;
begin
  for wanted in
    select * from (values
      ('hid_ocr_runtime', 'usage on schema ocr'),
      ('hid_ocr_worker', 'usage on schema ocr'),
      ('hid_ocr_runtime', 'execute on function ocr.record_correction_observations(uuid,jsonb)'),
      ('hid_ocr_worker', 'execute on function ocr.purge_correction_observations(integer)'))
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
   where proc.oid in ('ocr.record_correction_observations(uuid,jsonb)'::regprocedure,
       'ocr.purge_correction_observations(integer)'::regprocedure)
     and (not proc.prosecdef or proc.proowner <> ocr_owner or proc.proconfig is null
          or proc.proconfig[1] not like 'search_path=pg_catalog, ocr, %');
  if mismatch is not null then mismatch := 'attributes of ' || mismatch; end if;
  if mismatch is null then
    select string_agg(format('%s to %s', proc.oid::regprocedure, coalesce(grantee.rolname, 'PUBLIC')), '; ')
      into mismatch
      from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
      left join pg_roles grantee on grantee.oid = privilege.grantee
     where proc.pronamespace = 'ocr'::regnamespace
       and proc.proname in ('record_correction_observations', 'purge_correction_observations')
       and privilege.grantee <> proc.proowner
       and (proc.proname, coalesce(grantee.rolname, 'PUBLIC')) not in (
         ('record_correction_observations', 'hid_ocr_runtime'),
         ('purge_correction_observations', 'hid_ocr_worker'));
    if mismatch is not null then mismatch := 'unexpected EXECUTE: ' || mismatch; end if;
  end if;
  if mismatch is null and (select count(*) from pg_class class_row
        where class_row.oid in ('ocr.learning_key'::regclass, 'ocr.correction_observations'::regclass)
          and class_row.relowner = ocr_owner and class_row.relrowsecurity and class_row.relforcerowsecurity
          and (select count(*) from pg_policy policy_row where policy_row.polrelid = class_row.oid) = 1
          and not exists (select 1 from aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) privilege
                           where privilege.grantee <> class_row.relowner)) <> 2 then
    mismatch := 'the owner, row-level security, policy or ACL of the 0118 tables';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0118: post-check failed: %s', mismatch);
  end if;
end;
$$;
