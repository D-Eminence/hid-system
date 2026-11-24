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
--    "; " between names; from ocr-worker's DIAGNOSIS_SYNONYMS, and the
--    plain-letter spelling of a title with accented letters, such as
--    "Sjogren syndrome" for "Sjögren syndrome" (Ola, clinical owner); kept
--    apart from WHO's words, no ICD-10 content), the chapter and whether the
--    entry is residual ("other specified", "unspecified"). Extension codes
--    (X...) and blocks without a code are never loaded. A generated tsvector
--    over the code, the title and the other names, split into words exactly
--    as a search splits q, as 0149's lists now are (Rahman's review of #318,
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
--    It also refuses (55000) a row for a version of another kind, a
--    medicine or lab-test list, where nothing would ever show it (the
--    loader cannot make one; the table's owner could).
-- 3. ehr.search_catalog_diagnoses(q, limit) (SECURITY DEFINER, STABLE): the
--    active release's entries where every word of q starts a word of the
--    code and title or of one other name, each split as q is, with 0149's
--    query rules (the first 6 words of q, each cut to 40 characters; q
--    never reaches to_tsquery as typed). The active release's id is read
--    first, so only that release's rows are read, and the code through the
--    list's key (version_id, code), however many releases are kept. Before
--    the words are made, a word-final 's or ’s (either apostrophe, any
--    case) is dropped from q, so "Parkinson's disease" is searched as
--    "Parkinson disease" (0149's rules alone made it parkinson, s and
--    disease, and the lone s had to start another word of the title). When
--    nothing matched, the search runs once more with a final s dropped from
--    each word of 4 or more letters ("parkinsons", "alzheimers"). The order:
--    a. The entry whose code q is, found even when q is the code without its
--       dot. For that test q is trimmed and upper-cased, and any run of
--       characters that are neither letters nor digits, full stops
--       included, is taken off both ends, so a code copied with punctuation
--       around it is still that code ("NB91.", "NB91,", "(NB91)", "(NB91).",
--       "NB91 .", ".NB91" and "NB91,." are NB91); a code's own dot, inside
--       it, stays ("(9A03.0)." is 9A03.0). What is left is then the code as
--       it is when it has a code's shape as written (four of A-Z and 0-9,
--       then up to two parts of a dot and one or two of them: "9A03",
--       "9A03.0"); with the dot put back after the fourth character when it
--       is five or six of them ("9a030" is 9A03.0); with the dot put back
--       for the spaces, or the spaces and the dot, between the first four
--       and the last one or two ("5C50 5", "5C50. 5" and "5C50 .5" are
--       5C50.5); and no code otherwise. When no entry has that code, the
--       words alone decide, as before.
--    b. Entries whose title or one of our other names is q, compared as
--       words (lower case, split as q is, a word-final 's dropped from
--       both): "ra" gives FA20 Rheumatoid arthritis, whose other name is
--       "ra", before longer titles starting with ra.
--    c. Entries whose title or one of our other names starts with q, as
--       searched (each in lower case with a word-final 's dropped, as q is;
--       LIKE's %, _ and \ escaped).
--    d. Shorter titles, then the title in the "C" collation and the code.
--    At most limit (1-25) and whether more matched. matched_name is our
--    other name when it is what matched, or when it starts with q and the
--    title does not ("falciparum" names "falciparum malaria" for 1F40, as
--    the contract's example). 22023 CATALOG_SEARCH_INVALID for q outside
--    2-100 characters or a limit outside 1-25.
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
-- rows), to replace its kind check, and in the same attempt ACCESS SHARE on
-- ehr.catalog_medicines and ehr.catalog_lab_tests (0149's lists): replacing
-- the status (4) checks its body (the runner leaves check_function_bodies
-- on), and that check takes ACCESS SHARE on both lists, so it is taken
-- first, here, instead of waiting there with the versions table held
-- (Rahman's re-review of #320, finding 2). Each with NOWAIT: a busy table
-- fails the attempt at once, and the attempt gives back what it took; it is
-- made again every 100 ms for at most 5 seconds, then 55P03 "0150: ...
-- stayed busy for 5 seconds; nothing applied; run the release again at a
-- quieter time". When this transaction already holds an earlier
-- migration's locks that stop other sessions (the runner's dry run), one
-- attempt only ("... so it does not wait; nothing applied; run the release
-- again at a quieter time"). Both name the three tables and are the
-- runner's busy refusal, so a dry run rolls back and tries again
-- (dry-run-attempts.mjs). Only an ACCESS EXCLUSIVE holder or request on a
-- list makes its ACCESS SHARE busy (VACUUM FULL, CLUSTER, ALTER or LOCK
-- TABLE: nothing routine), never a search or a load. While the
-- versions table is held, a catalogue search (a few milliseconds) and a
-- load (the loader reads and writes that table) wait. The new table's
-- foreign key reaches only the versions table, and its triggers are on the
-- new table. The search and the trigger function are PL/pgSQL, whose
-- bodies are not checked against tables, so creating them locks no
-- existing relation.
--
-- Old services on this schema: nothing calls the new function. The status
-- gains a diagnosis row. The 0149-era ehr-api reads its medicine and
-- lab-test rows as before, but takes the notices of any row that is not a
-- medicine row as a lab-test row's: with an ICD-11 release active and a
-- lab-test list available, it would show WHO's notice while it says
-- diagnoses are not available. So an ICD-11 release is activated only once
-- this slice's ehr-api is live. New services on a schema without this
-- file: ehr-api's diagnosis search answers 503 CATALOG_UNAVAILABLE (42883),
-- and the status says diagnoses are not available.
--
-- Undo (by hand only): drop the search function; replace the status with
-- 0149's body; drop the table, then its insert trigger function. The kind
-- check stays with its three kinds: 0149's guard never deletes a version
-- row, so a diagnosis version, once loaded, is never gone.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied): 0149's
--    status and query helper as made (the md5 of their bodies; the helper's
--    owner and search_path too) and 0001's append-only trigger function.
-- 1. The lock and the kind. 2-5. As above. 6. Post-checks: owners, grants
--    and search_path; each trigger's events (pg_trigger.tgtype: 27 before
--    update or delete for each row, 34 before truncate, 7 before insert for
--    each row) and function, and the sealed-release function's body (its
--    md5); the kind check; an empty list. (0149's post-checks have the
--    same gap for its own triggers; 0149 is signed and left as it is.)

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

-- 1. The locks (NOWAIT, at most 5 seconds) and the kind.
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
      -- Replacing the status (4) checks its body, which takes ACCESS SHARE on both lists: taken here, in the same
      -- attempt, so a list held or queued for ACCESS EXCLUSIVE fails the attempt instead of a wait with the versions
      -- table held. A failed attempt gives back both locks.
      lock table ehr.catalog_medicines, ehr.catalog_lab_tests in access share mode nowait;
      exit;
    exception when lock_not_available then
      -- Both endings are the runner's busy refusal (dry-run-attempts.mjs), so a dry run tries again.
      if holding then
        raise exception using errcode = '55P03',
          message = '0150: ehr.catalog_versions (a catalogue search or load), ehr.catalog_medicines or '
            || 'ehr.catalog_lab_tests is busy and this transaction already holds an earlier migration''s locks, so it '
            || 'does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0150: ehr.catalog_versions (a catalogue search or load), ehr.catalog_medicines or '
            || 'ehr.catalog_lab_tests stayed busy for 5 seconds; nothing applied; run the release again at a quieter '
            || 'time';
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
-- in progress, then reads the release as switched. Nor for a version of another kind (a medicine or lab-test list),
-- where nothing would ever show it; a version that does not exist is left to the foreign key (23503). It runs as
-- the inserting role: only the table's owner may insert, and it holds the UPDATE privilege that FOR SHARE needs.
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
  if target.kind <> 'diagnosis' then
    raise exception using errcode = '55000',
      message = 'A diagnosis entry needs a diagnosis release, not the ' || target.kind || ' list ' || target.version;
  end if;
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
  searched text;
  fewer_s text;
  query tsquery;
  starts text;
  exact text;
  code_text text;
  typed_code text;
  release_id uuid;
  release_label text;
begin
  if trimmed is null or length(trimmed) < 2 or length(trimmed) > 100
     or requested_limit is null or requested_limit < 1 or requested_limit > 25 then
    raise exception using errcode = '22023', message = 'CATALOG_SEARCH_INVALID';
  end if;
  -- The active release first: then only its rows are read, and the code through the key (version_id, code).
  select version_row.id, version_row.version into release_id, release_label
    from ehr.catalog_versions version_row
   where version_row.active and version_row.kind = 'diagnosis';
  if release_id is null then
    return;
  end if;
  -- q as a code, upper-cased, as copied: any run of characters that are neither letters nor digits taken off both
  -- ends ("NB91.", "(NB91).", "NB91 .", ".NB91" are NB91; "(9A03.0)." is 9A03.0, the code's own dot stays). Then as
  -- it is when it has the code's shape with its dot; with the dot put back after the fourth character ("9a030" is
  -- 9A03.0); or with the dot put back for spaces, or spaces and a dot, after the fourth ("5C50 5", "5C50. 5" and
  -- "5C50 .5" are 5C50.5). That entry comes first, and is found even without the dot.
  code_text := regexp_replace(upper(trimmed), '^[^[:alnum:]]+|[^[:alnum:]]+$', '', 'g');
  typed_code := case when code_text ~ '^[0-9A-Z]{4}(\.[0-9A-Z]{1,2}){0,2}$' then code_text
                     when code_text ~ '^[0-9A-Z]{5,6}$' then left(code_text, 4) || '.' || substr(code_text, 5)
                     when code_text ~ '^[0-9A-Z]{4}([[:space:]]*\.[[:space:]]*|[[:space:]]+)[0-9A-Z]{1,2}$'
                       then left(code_text, 4) || '.' || regexp_replace(substr(code_text, 5), '[[:space:].]+', '')
                end;
  -- The words: a word-final 's or ’s dropped ("Parkinson's disease" is Parkinson disease), so 0149's helper is
  -- given no lone s to make a word of.
  searched := regexp_replace(trimmed, '([[:alnum:]])[''’][sS](?![[:alnum:]])', '\1', 'g');
  for attempt in 1..2 loop
    query := ehr.catalog_search_query(searched);
    if query is null then
      return;
    end if;
    -- "Starts with q" for the order: q as searched, with LIKE's %, _ and \ escaped.
    starts := replace(replace(replace(lower(searched), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    -- "Is q": q as searched, as words (lower case, split as q is).
    exact := btrim(regexp_replace(lower(searched), '[^[:alnum:]]+', ' ', 'g'));
    return query
      with candidates as materialized (
        -- The release's rows whose words match, or whose code q is; each title split into words once, as q is.
        select diagnosis.code, diagnosis.title, diagnosis.other_names,
               regexp_replace(lower(diagnosis.title), '[^[:alnum:]]+', ' ', 'g') as title_words
          from ehr.catalog_diagnoses diagnosis
         where diagnosis.version_id = release_id
           and (diagnosis.search_terms @@ query or diagnosis.code = typed_code)),
      found as (
        select candidate.code, candidate.title, compared.title as compared_title,
               coalesce(candidate.code = typed_code, false) as code_hit,
               -- The code and the title, split as q is (a code is A-Z, 0-9 and dots only).
               to_tsvector('simple'::regconfig, replace(lower(candidate.code), '.', ' ') || ' ' || candidate.title_words)
                 @@ query as title_hit,
               (select other.name from unnest(string_to_array(candidate.other_names, '; ')) as other(name)
                 where other.name <> ''
                   and to_tsvector('simple'::regconfig, regexp_replace(lower(other.name), '[^[:alnum:]]+', ' ', 'g'))
                       @@ query
                 order by (lower(regexp_replace(other.name, '([[:alnum:]])[''’][sS](?![[:alnum:]])', '\1', 'g'))
                           like starts escape '\') desc, lower(other.name) collate "C", other.name collate "C"
                 limit 1) as other_hit,
               -- The title or one of our other names is q, as words.
               (compared.words = exact
                or (candidate.other_names <> ''
                    and exists (select 1 from unnest(string_to_array(candidate.other_names, '; ')) as other(name)
                                 where btrim(regexp_replace(lower(regexp_replace(other.name,
                                         '([[:alnum:]])[''’][sS](?![[:alnum:]])', '\1', 'g')), '[^[:alnum:]]+', ' ',
                                         'g')) = exact))) as name_is_q
          from candidates candidate
          -- The title as q is compared with it: lower case, a word-final 's dropped as from q (only a title with an
          -- apostrophe changes; the 2026-01 release has 4), and as words.
          cross join lateral (
            select case when strpos(candidate.title, '''') > 0 or strpos(candidate.title, '’') > 0
                        then lower(regexp_replace(candidate.title, '([[:alnum:]])[''’][sS](?![[:alnum:]])', '\1', 'g'))
                        else lower(candidate.title) end as title,
                   case when strpos(candidate.title, '''') > 0 or strpos(candidate.title, '’') > 0
                        then btrim(regexp_replace(lower(regexp_replace(candidate.title,
                               '([[:alnum:]])[''’][sS](?![[:alnum:]])', '\1', 'g')), '[^[:alnum:]]+', ' ', 'g'))
                        else btrim(candidate.title_words) end as words) as compared),
      named as (
        select found.*,
               lower(regexp_replace(found.other_hit, '([[:alnum:]])[''’][sS](?![[:alnum:]])', '\1', 'g'))
                 as compared_other
          from found
         where found.code_hit or found.title_hit or found.other_hit is not null),
      shown as (
        select named.*,
               -- Our other name is named when it is what matched, or when it starts with q and the title does not.
               case when named.compared_title like starts escape '\' then null
                    when named.other_hit is not null
                         and (not named.title_hit or named.compared_other like starts escape '\') then named.other_hit
               end as matched,
               (named.compared_title like starts escape '\'
                or coalesce(named.compared_other like starts escape '\', false)) as starts_with_q
          from named),
      ranked as (
        select shown.*, count(*) over () as total,
               row_number() over (order by shown.code_hit desc, shown.name_is_q desc, shown.starts_with_q desc,
                 length(shown.title), lower(shown.title) collate "C", shown.code collate "C") as position
          from shown)
      select ranked.code, ranked.title, ranked.matched, release_label, ranked.total > requested_limit
        from ranked
       where ranked.position <= requested_limit
       order by ranked.position;
    if found then
      return;
    end if;
    -- Nothing matched: once more with a final s dropped from each word of 4 or more letters ("parkinsons" is
    -- parkinson, "alzheimers" alzheimer), when that changes q.
    fewer_s := regexp_replace(searched, '(?<![[:alnum:]])([[:alpha:]]{3,})[sS](?![[:alnum:]])', '\1', 'g');
    exit when fewer_s = searched;
    searched := fewer_s;
  end loop;
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
  '0150 (ORD-9): the active ICD-11 release''s entries whose code and title or one other name has a word starting with each word of q (a word-final ''s dropped from q; when nothing matched, once more with a final s dropped from words of 4 or more letters); the entry whose code q is (with or without its dot, or with spaces at its dot, and with any run of characters that are neither letters nor digits taken off both ends; its own dot stays) first, then a title or other name that is q, then names starting with q, then shorter titles, then A to Z; at most limit (1-25) and whether more matched. 22023 CATALOG_SEARCH_INVALID for q outside 2-100 characters or a limit outside 1-25.';
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
  -- Each trigger's events as made (pg_trigger.tgtype: 1 for each row, 2 before, 4 insert, 8 delete, 16 update,
  -- 32 truncate): 27 before update or delete for each row, 34 before truncate.
  if (select count(*) from pg_trigger trigger_row
       where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
         and trigger_row.tgrelid = 'ehr.catalog_diagnoses'::regclass
         and trigger_row.tgfoid = 'platform.reject_mutation()'::regprocedure
         and ((trigger_row.tgname = 'catalog_diagnoses_append_only' and trigger_row.tgtype = 27)
              or (trigger_row.tgname = 'catalog_diagnoses_no_truncate' and trigger_row.tgtype = 34))) <> 2 then
    raise exception using errcode = '55000', message = '0150: the diagnosis list is missing its append-only triggers';
  end if;
  -- 7: before insert for each row; and the function's body as this file makes it.
  if not exists (select 1 from pg_trigger trigger_row
                  where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
                    and trigger_row.tgrelid = 'ehr.catalog_diagnoses'::regclass
                    and trigger_row.tgname = 'catalog_diagnoses_not_sealed' and trigger_row.tgtype = 7
                    and trigger_row.tgfoid = 'ehr.catalog_diagnosis_not_sealed()'::regprocedure)
     or not exists (select 1 from pg_proc proc
                     where proc.oid = 'ehr.catalog_diagnosis_not_sealed()'::regprocedure and not proc.prosecdef
                       and md5(proc.prosrc) = '453b30e5c720222eca5c5fe318c28638'
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
