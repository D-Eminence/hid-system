-- 0150 Diagnosis search on ICD-11, first slice: the diagnosis list and its
-- search (ORD-9 of the Akos EHR plan, lane D). The planned contract's
-- section "ORD-9: Diagnosis search on ICD-11, recent diagnoses, and
-- diagnoses by name only" is what this slice builds a part of; the design
-- note on hid-system#258 (Ola, 23 November 2026, 13:55 UTC) is the plan.
-- Written on ORD-7's two slices (0149, #318; the loader, #319). The number
-- is provisional, given in merge order after 0149; no migration number
-- appears inside a function body, so renumbering leaves every md5. This
-- file requires 0001-0137 and 0149 applied. The declaration is signed
-- separately.
--
-- THE GAP. A diagnosis is typed with its code and code system by hand
-- (clinical.dto.ts, 0004); there is no list to pick from. Owner decision
-- Q124 A (19 November 2026): ICD-11 is the search list, and ICD-10 codes
-- typed in are still accepted.
--
-- WHAT IT DOES (nothing is loaded; the list stays empty until a signed
-- release is loaded by ORD-7's governed loader, never by a migration)
-- 1. ehr.catalog_versions (0149) takes the kind 'diagnosis': its kind check
--    is replaced. That takes ACCESS EXCLUSIVE on the versions table, which
--    every catalogue search reads; see Locks.
-- 2. ehr.catalog_diagnoses: one row per coded entry of an ICD-11 MMS
--    release per version: the code, WHO's title verbatim (CC BY-ND 3.0 IGO:
--    never shortened, respelled or re-cased), our own other names (one text,
--    "; " between names; from ocr-worker's DIAGNOSIS_SYNONYMS, kept apart
--    from WHO's words, no ICD-10 content), the chapter and whether the entry
--    is residual ("other specified", "unspecified"). Extension codes (X...)
--    and blocks without a code are never loaded. A generated tsvector over
--    the code, the title and the other names, split into words exactly as
--    a search splits q, as 0149's lists now are (Rahman's review of #318,
--    finding 1): lower case, at anything that is not a letter or a digit,
--    so "1F40.Z" gives 1f40 and z, "COVID-19" covid and 19, and
--    "T-cell/histiocyte" t, cell and histiocyte (the default parser kept
--    "-19" and "cell/histiocyte" as words no search could reach);
--    configuration 'simple'; with a GIN index.
--    Append-only, as 0149's lists: a new WHO release is a new version. As
--    0149's lists do (Rahman's review of #318, finding 2), a BEFORE INSERT
--    trigger refuses (55000) a row for a sealed version
--    (CATALOG_VERSION_SEALED), reading the version row FOR SHARE: 0149's
--    guard seals a release when it goes live, so a release that is or has
--    been live gains no row, and only a release still loading takes rows.
-- 3. ehr.search_catalog_diagnoses(q, limit) (SECURITY DEFINER, STABLE): the
--    active release's entries where every word of q starts a word of the
--    code and title or of one other name, each split as q is, with 0149's
--    query rules (the first 6 words of q, each cut to 40 characters; q
--    never reaches to_tsquery as typed). The entry whose code q is
--    (upper-cased, with or without its dot: "9A03.0" or "9a030") first,
--    found even without the dot, and as copied with punctuation around it:
--    characters that are neither letters, digits nor dots are taken off
--    both ends, then full stops off the end, before the code's shape is
--    tested ("NB91.", "NB91,", "(NB91)" are NB91); then entries whose
--    title or one of our other names starts with q
--    (LIKE's %, _ and \ escaped), then shorter titles, then the title in the
--    "C" collation and the code. At most limit (1-25) and whether more
--    matched. matched_name is our other name when it is what matched, or
--    when it starts with q and the title does not ("falciparum" names
--    "falciparum malaria" for 1F40, as the contract's example). 22023
--    CATALOG_SEARCH_INVALID for q outside 2-100 characters or a limit
--    outside 1-25.
-- 4. ehr.catalog_status() (0149) is replaced, the same columns: it answers
--    for the diagnosis list too.
-- 5. Grants: EXECUTE on 3 to hid_ehr_runtime and hid_schema_test_runtime
--    only, where those roles exist (and in runtime-grants.sql); 4 keeps
--    0149's grants; no privilege on the table or on 2's trigger function
--    for any runtime.
--
-- What it does not do: no recent diagnoses, no diagnosis by name only and
-- no codeStatus (a later slice, which alters ehr.diagnoses), no loader
-- change here (the loader slice takes the kind), no data.
--
-- Locks: ACCESS EXCLUSIVE on ehr.catalog_versions (0149's, a handful of
-- rows), to replace its kind check, with NOWAIT: a busy table fails the
-- attempt at once, made again every 100 ms for at most 5 seconds, then
-- 55P03 "0150: ... stayed busy for 5 seconds; nothing applied; run the
-- release again at a quieter time". When this transaction already holds an
-- earlier migration's locks that stop other sessions (the runner's dry
-- run), one attempt only ("... so it does not wait; nothing applied; run
-- the release again at a quieter time"). Both are the runner's busy
-- refusal, so a dry run rolls back and tries again (dry-run-attempts.mjs).
-- While it is held, a catalogue search (a few milliseconds) waits; nothing
-- else reads the table. The new table's foreign key reaches only that
-- table, and its triggers are on the new table. Creating and replacing
-- functions locks no existing relation.
--
-- Old services on this schema: nothing calls the new function; 0149's
-- status answers as before for medicines and lab tests. New services on a
-- schema without this file: ehr-api's diagnosis search answers 503
-- CATALOG_UNAVAILABLE (42883), and the status says diagnoses are not
-- available.
--
-- Undo (by hand only): drop the search function; replace the status with
-- 0149's body; drop the table, then its insert trigger function; then put
-- back 0149's kind check (only once no diagnosis version is left).
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied): 0149's
--    status and query helper as made (the md5 of their bodies; the helper's
--    owner and search_path too) and 0001's append-only trigger function.
-- 1. The lock and the kind. 2-5. As above. 6. Post-checks.

-- 0. Preconditions.
do $$
begin
  if to_regclass('identity.qoreid_nin_checks') is null or to_regclass('ehr.visit_queue') is null
     or to_regclass('ehr.catalog_versions') is null or to_regclass('ehr.catalog_retired_codes') is null then
    raise exception using errcode = '55000', message = '0150: 0001-0137 and 0149 must be applied first';
  end if;
  if to_regclass('ehr.catalog_diagnoses') is not null
     or to_regprocedure('ehr.search_catalog_diagnoses(text,integer)') is not null then
    raise exception using errcode = '55000', message = '0150: already applied';
  end if;
  -- The search below calls 0149's query helper, so its body (the 6 words, 40 characters, prefix matching, never
  -- raw to_tsquery), owner and search_path are pinned beside the status's body.
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure('ehr.catalog_status()'))
     is distinct from 'c7ecd991576a74ade056b878d7de5895'
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('ehr.catalog_search_query(text)'))
     is distinct from '8b3c964d6b9f34c557210acfe1f986ff'
     or not exists (select 1 from pg_proc proc
                     where proc.oid = to_regprocedure('ehr.catalog_search_query(text)')
                       and proc.proowner = (select relation.relowner from pg_class relation
                                             where relation.oid = 'ehr.catalog_versions'::regclass)
                       and proc.proconfig = array['search_path=pg_catalog, pg_temp'])
     or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure('platform.reject_mutation()'))
     is distinct from '398738f39f6eebed2c54da5009495def' then
    raise exception using errcode = '55000', message = '0150: 0149''s status or query helper, or 0001''s append-only trigger function, is not as made';
  end if;
  if not exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'ehr.catalog_versions'::regclass
                    and constraint_row.conname = 'catalog_versions_kind_check'
                    and pg_get_constraintdef(constraint_row.oid)
                        = 'CHECK ((kind = ANY (ARRAY[''medicine''::text, ''lab_test''::text])))') then
    raise exception using errcode = '55000', message = '0150: the catalogue versions'' kind check is not as 0149 made it';
  end if;
end
$$;

-- 1. The lock (NOWAIT, at most 5 seconds) and the kind.
do $$
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
       and namespace.nspname <> 'migration'
       and relation.oid <> 'ehr.catalog_versions'::regclass);
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.catalog_versions in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      -- Both endings are the runner's busy refusal (dry-run-attempts.mjs), so a dry run tries again.
      if holding then
        raise exception using errcode = '55P03',
          message = '0150: ehr.catalog_versions (a catalogue search or load) is busy and this transaction already '
            || 'holds an earlier migration''s locks, so it does not wait; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0150: ehr.catalog_versions (a catalogue search or load) stayed busy for 5 seconds; nothing '
            || 'applied; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$$;
alter table ehr.catalog_versions drop constraint catalog_versions_kind_check;
alter table ehr.catalog_versions add constraint catalog_versions_kind_check
  check (kind in ('medicine', 'lab_test', 'diagnosis'));

-- 2. The diagnosis list.
create table ehr.catalog_diagnoses (
  version_id uuid not null references ehr.catalog_versions(id) on delete restrict,
  code text not null check (code ~ '^[0-9A-Z]{4}(\.[0-9A-Z]{1,2}){0,2}$' and code !~ '^X'),
  title text not null check (length(btrim(title)) between 1 and 500),
  other_names text not null default '' check (length(other_names) <= 2000),
  chapter text not null check (chapter ~ '^([0-9]{2}|[A-Z])$'),
  residual boolean not null default false,
  -- Split as a search splits q (ehr.catalog_search_query): lower case, at anything not a letter or a digit.
  search_terms tsvector generated always as (to_tsvector('simple'::regconfig,
    regexp_replace(lower(code || ' ' || title || ' ' || other_names), '[^[:alnum:]]+', ' ', 'g'))) stored,
  constraint catalog_diagnoses_pkey primary key (version_id, code)
);
create index catalog_diagnoses_search_idx on ehr.catalog_diagnoses using gin (search_terms);
revoke all on ehr.catalog_diagnoses from public;
create trigger catalog_diagnoses_append_only
  before update or delete on ehr.catalog_diagnoses
  for each row execute function platform.reject_mutation();
create trigger catalog_diagnoses_no_truncate
  before truncate on ehr.catalog_diagnoses
  for each statement execute function platform.reject_mutation();
-- No row for a sealed release (one that is or has been live), as 0149's lists' insert triggers: the release's row
-- is read FOR SHARE, so a switch that seals it waits for the insert's transaction, and an insert waits for a switch
-- in progress, then reads the release as switched. It runs as the inserting role: only the table's owner may
-- insert, and it holds the UPDATE privilege that FOR SHARE needs.
create function ehr.catalog_diagnosis_not_sealed()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  target record;
begin
  select versions.kind, versions.version, versions.sealed into target
    from ehr.catalog_versions versions where versions.id = new.version_id for share;
  if target.sealed then
    raise exception using errcode = '55000',
      message = 'CATALOG_VERSION_SEALED: ' || target.kind || ' ' || target.version;
  end if;
  return new;
end;
$$;
revoke all on function ehr.catalog_diagnosis_not_sealed() from public;
create trigger catalog_diagnoses_not_sealed
  before insert on ehr.catalog_diagnoses
  for each row execute function ehr.catalog_diagnosis_not_sealed();

-- 3. The search.
create function ehr.search_catalog_diagnoses(requested_q text, requested_limit integer)
returns table (code text, title text, matched_name text, list_version text, more boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  trimmed text := btrim(requested_q);
  query tsquery;
  starts text;
  code_text text;
  typed_code text;
begin
  if trimmed is null or length(trimmed) < 2 or length(trimmed) > 100
     or requested_limit is null or requested_limit < 1 or requested_limit > 25 then
    raise exception using errcode = '22023', message = 'CATALOG_SEARCH_INVALID';
  end if;
  query := ehr.catalog_search_query(trimmed);
  if query is null then
    return;
  end if;
  -- "Starts with q" for the order: q with LIKE's %, _ and \ escaped.
  starts := replace(replace(replace(lower(trimmed), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  -- q as a code, upper-cased, as copied: characters that are neither letters, digits nor dots taken off both ends,
  -- then full stops off the end ("NB91.", "NB91,", "(NB91)" are NB91). Then as it is when it has the code's shape
  -- with its dot, or with the dot put back after the fourth character ("9a030" is 9A03.0). That entry comes first,
  -- and is found even without the dot.
  code_text := rtrim(regexp_replace(upper(trimmed), '^[^[:alnum:].]+|[^[:alnum:].]+$', '', 'g'), '.');
  typed_code := case when code_text ~ '^[0-9A-Z]{4}(\.[0-9A-Z]{1,2}){0,2}$' then code_text
                     when code_text ~ '^[0-9A-Z]{5,6}$' then left(code_text, 4) || '.' || substr(code_text, 5) end;
  return query
    with found as (
      select diagnosis.code, diagnosis.title, version_row.version as version_label,
             coalesce(diagnosis.code = typed_code, false) as code_hit,
             to_tsvector('simple'::regconfig, regexp_replace(lower(diagnosis.code || ' ' || diagnosis.title),
               '[^[:alnum:]]+', ' ', 'g')) @@ query as title_hit,
             (select other.name from unnest(string_to_array(diagnosis.other_names, '; ')) as other(name)
               where other.name <> ''
                 and to_tsvector('simple'::regconfig, regexp_replace(lower(other.name), '[^[:alnum:]]+', ' ', 'g'))
                     @@ query
               order by (lower(other.name) like starts escape '\') desc, lower(other.name) collate "C",
                 other.name collate "C" limit 1) as other_hit
        from ehr.catalog_diagnoses diagnosis
        join ehr.catalog_versions version_row on version_row.id = diagnosis.version_id
       where version_row.active and version_row.kind = 'diagnosis'
         and (diagnosis.search_terms @@ query or diagnosis.code = typed_code)),
    shown as (
      select found.*,
             -- Our other name is named when it is what matched, or when it starts with q and the title does not.
             case when lower(found.title) like starts escape '\' then null
                  when found.other_hit is not null
                       and (not found.title_hit or lower(found.other_hit) like starts escape '\') then found.other_hit
             end as matched,
             (lower(found.title) like starts escape '\'
              or coalesce(lower(found.other_hit) like starts escape '\', false)) as starts_with_q
        from found
       where found.code_hit or found.title_hit or found.other_hit is not null),
    ranked as (
      select shown.*, count(*) over () as total,
             row_number() over (order by shown.code_hit desc, shown.starts_with_q desc,
               length(shown.title), lower(shown.title) collate "C", shown.code collate "C") as position
        from shown)
    select ranked.code, ranked.title, ranked.matched, ranked.version_label, ranked.total > requested_limit
      from ranked
     where ranked.position <= requested_limit
     order by ranked.position;
end;
$$;

-- 4. The status, now for the diagnosis list too (the same columns; 0149's
-- grants stay).
create or replace function ehr.catalog_status()
returns table (kind text, available boolean, list_version text, approved_at timestamptz, offered integer,
  attribution text[], file_sha256 text)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select kinds.kind, version_row.id is not null, version_row.version, version_row.approved_at,
         case kinds.kind
           when 'medicine' then (select count(*)::integer from ehr.catalog_medicines medicine
                                  where medicine.version_id = version_row.id and not medicine.withdrawn)
           when 'lab_test' then (select count(*)::integer from ehr.catalog_lab_tests test
                                  where test.version_id = version_row.id and not test.withdrawn)
           else (select count(*)::integer from ehr.catalog_diagnoses diagnosis
                  where diagnosis.version_id = version_row.id) end,
         coalesce(version_row.attribution, '{}'), version_row.file_sha256::text
    from (values ('diagnosis'), ('lab_test'), ('medicine')) as kinds(kind)
    left join ehr.catalog_versions version_row on version_row.kind = kinds.kind and version_row.active
   order by kinds.kind
$$;

-- 5. Grants (here and in runtime-grants.sql).
revoke all on function ehr.search_catalog_diagnoses(text, integer) from public;
do $$
declare runtime_role text;
begin
  foreach runtime_role in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function ehr.search_catalog_diagnoses(text, integer) to %I', runtime_role);
    end if;
  end loop;
end
$$;

comment on table ehr.catalog_diagnoses is
  '0150 (ORD-9): the coded entries of an ICD-11 MMS release, one row per entry per version, WHO''s titles verbatim (ICD-11, World Health Organization, CC BY-ND 3.0 IGO) and our own other names apart; no extension codes, no blocks. Loaded by ORD-7''s governed loader. No patient data.';
comment on function ehr.search_catalog_diagnoses(text, integer) is
  '0150 (ORD-9): the active ICD-11 release''s entries whose code and title or one other name has a word starting with each word of q; the entry whose code q is (with or without its dot, and with punctuation around it left out) first, then names starting with q, then shorter titles, then A to Z; at most limit (1-25) and whether more matched. 22023 CATALOG_SEARCH_INVALID for q outside 2-100 characters or a limit outside 1-25.';
comment on function ehr.catalog_status() is
  '0149 (ORD-7), 0150 (ORD-9): per kind (diagnosis, lab_test, medicine): whether an active version exists, its label, when it was approved, how many rows it offers, the notices its sources require and the sha256 of its seed file.';

-- 6. Post-checks.
do $$
declare
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'ehr.catalog_versions'::regclass);
begin
  if exists (select 1 from pg_class relation, lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
              where relation.oid = 'ehr.catalog_diagnoses'::regclass and acl.grantee <> relation.relowner) then
    raise exception using errcode = '55000', message = '0150: the diagnosis list is granted to a role other than its owner';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in ('ehr.search_catalog_diagnoses(text,integer)'::regprocedure, 'ehr.catalog_status()'::regprocedure)
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) not in ('hid_ehr_runtime', 'hid_schema_test_runtime'))) then
    raise exception using errcode = '55000', message = '0150: a catalogue function is granted to a role other than the EHR and schema test runtimes';
  end if;
  if (select count(*) from pg_proc proc
       where proc.oid in ('ehr.search_catalog_diagnoses(text,integer)'::regprocedure, 'ehr.catalog_status()'::regprocedure)
         and proc.prosecdef and proc.provolatile = 's' and proc.proowner = owner_oid
         and proc.proconfig = array['search_path=pg_catalog, pg_temp']) <> 2 then
    raise exception using errcode = '55000', message = '0150: a catalogue function is not as made';
  end if;
  if (select count(*) from pg_trigger trigger_row
       where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
         and trigger_row.tgrelid = 'ehr.catalog_diagnoses'::regclass
         and trigger_row.tgfoid = 'platform.reject_mutation()'::regprocedure) <> 2 then
    raise exception using errcode = '55000', message = '0150: the diagnosis list is missing its append-only triggers';
  end if;
  if not exists (select 1 from pg_trigger trigger_row
                  where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
                    and trigger_row.tgrelid = 'ehr.catalog_diagnoses'::regclass
                    and trigger_row.tgname = 'catalog_diagnoses_not_sealed'
                    and trigger_row.tgfoid = 'ehr.catalog_diagnosis_not_sealed()'::regprocedure)
     or not exists (select 1 from pg_proc proc
                     where proc.oid = 'ehr.catalog_diagnosis_not_sealed()'::regprocedure and not proc.prosecdef
                       and proc.proowner = owner_oid and proc.proconfig = array['search_path=pg_catalog, pg_temp'])
     or exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid = 'ehr.catalog_diagnosis_not_sealed()'::regprocedure and acl.grantee <> proc.proowner) then
    raise exception using errcode = '55000', message = '0150: the diagnosis list''s sealed-release trigger is not as made';
  end if;
  if not exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'ehr.catalog_versions'::regclass
                    and constraint_row.conname = 'catalog_versions_kind_check' and constraint_row.convalidated
                    and pg_get_constraintdef(constraint_row.oid)
                        = 'CHECK ((kind = ANY (ARRAY[''medicine''::text, ''lab_test''::text, ''diagnosis''::text])))') then
    raise exception using errcode = '55000', message = '0150: the catalogue versions'' kind check is not as made';
  end if;
  if exists (select 1 from ehr.catalog_diagnoses) then
    raise exception using errcode = '55000', message = '0150: the diagnosis list must be empty after this file';
  end if;
end
$$;
