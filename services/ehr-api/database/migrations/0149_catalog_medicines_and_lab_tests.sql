-- 0149 The medicine and lab-test lists, first slice: the catalogue tables and
-- their search (ORD-7 of the Akos EHR plan, lane D). The planned contract's
-- section "ORD-7: Medicine and lab-test lists, and lab tests by name only" is
-- what this slice builds a part of; the design note on hid-system#258 (Ola,
-- 23 November 2026, 12:55 UTC) is the plan. Written on
-- staging-novu-ci-20261005 at 06f98040 (Release A, 0001-0137, live). The
-- number is provisional, given in merge order after Release B; no migration
-- number appears inside a function body, so renumbering leaves every md5.
-- This file requires 0001-0137 applied and relies on nothing of Release B.
-- The declaration is signed separately.
--
-- THE GAP. A prescriber types a medicine's name and a lab requester a
-- test's name: there is no list to pick from (the screens' built-in lists
-- and Wave 0's 13 HID-LAB codes are all there is). The combined national
-- list (#312: 1,624 medicines with fixed ids MED-nnnnn, 158 lab tests with
-- LAB-nnnn) is drafted and waits for the clinical lead's sign-off (owner
-- decision Q124 A).
--
-- WHAT IT DOES (nothing is loaded; the lists stay empty until a signed
-- version is loaded by the governed loader of a later slice, never by a
-- migration)
-- 1. ehr.catalog_versions: one row per loaded version of a list (kind
--    'medicine' or 'lab_test'): its version label, the sha256 of the seed
--    file it came from, the approval reference (the lead's sign-off) and
--    when it was approved and loaded, and whether it is the active version.
--    At most one active version per kind (a unique partial index). Its
--    attribution: the notices the signed file's sources require (LOINC's,
--    the WHO Model List's), at most 5, shown on the screens' About page. A
--    version row is never deleted and never changes but for the loader's
--    switch (active, and loaded_at): a trigger refuses anything else (55000),
--    and TRUNCATE. The loader (a later slice) switches in one transaction
--    under SHARE ROW EXCLUSIVE on this table: the old version off, then the
--    new one on (two statements: one turning both would meet the
--    one-active index row by row), so two loaders cannot both win and a
--    search sees the old list or the new one, never neither.
-- 2. ehr.catalog_medicines: one row per list row per version: the fixed id
--    (MED-nnnnn, the code under codeSystem HID-MED), the generic name (the
--    INN), other names (one text, names separated by "; "), strength, dose
--    form (section 46's values), the list's words for the form, routes,
--    ATC code, a common adult dose hint, the source and its section and
--    sub-list, and withdrawn. A generated tsvector over the generic name and
--    the other names (configuration 'simple': no stemming, no stop words)
--    with a GIN index. A row never changes once loaded (UPDATE, DELETE and
--    TRUNCATE refused by platform.reject_mutation()): a correction or a
--    withdrawal is a new version, so old prescriptions keep their meaning.
-- 3. ehr.catalog_lab_tests: the same for lab tests: the fixed id
--    (LAB-nnnn), the code system and code the test is ordered with (LOINC or
--    HID-LAB; a test with no code is never loaded), the name, other names,
--    specimen, category (the contract's nine), source, withdrawn, and the
--    tsvector with its GIN index; append-only as 2.
-- 4. ehr.search_catalog_medicines(q, limit, dose form, route) and
--    ehr.search_catalog_lab_tests(q, limit) (SECURITY DEFINER, STABLE): the
--    active version's rows that are not withdrawn, where every word of q
--    starts a word of the generic name or of one other name (prefix match,
--    letters and digits only, case ignored; the first 6 words of q, each cut
--    to 40 characters; q never reaches to_tsquery as typed). Names that
--    start with q (LIKE's %, _ and \ escaped) come first, then by name in
--    the "C" collation, then strength and the list id, so the order is the
--    same on every load. At most limit rows (1-25), and whether more
--    matched. matched_name is the other name that matched when the generic
--    name did not. q of 2-100 characters after trimming, limit 1-25, a dose
--    form of section 46 and a route of letters, spaces and hyphens, else
--    22023 CATALOG_SEARCH_INVALID; q is never stored or logged here.
-- 5. ehr.catalog_status(): per kind, whether an active version exists, its
--    label, when it was approved, how many rows it offers, its attribution
--    and the sha256 of the signed file it was loaded from (so the screens
--    and support can tell which list a clinician searched).
-- 6. Grants: EXECUTE on 4 and 5 to hid_ehr_runtime and
--    hid_schema_test_runtime only, where those roles exist (and in
--    runtime-grants.sql); no privilege on the tables for any runtime.
--
-- What it does not do: no facility items (a later slice, with row-level
-- security by facility and the new ehr.catalog.facility-item.write), no lab
-- request by name only (a later slice), no loader, no seed file, no data.
-- The lists hold no patient data: no row-level security on them, no patient
-- audit.
--
-- Locks: only the new tables and functions. No foreign key reaches an
-- existing table (the new tables reference only each other), the triggers
-- call 0001's platform.reject_mutation() and this file's guard, and no
-- existing object is altered or granted on, so the file takes no lock on
-- any existing relation: it never waits on a running service and stops
-- nothing. Checked before commit on PostgreSQL 16 (0001-0137 + this file):
-- pg_locks lists relation locks only on the three new tables, their indexes
-- and TOAST tables, besides ACCESS SHARE on system catalogs and ROW
-- EXCLUSIVE on pg_description (the comments); its 16 object locks are all
-- ACCESS SHARE (the schema and the types and functions the new objects
-- use), which no running service conflicts with. There is no busy refusal
-- to name: the preconditions' refusals start with "0149: ".
--
-- Old services on this schema: nothing calls the new functions. New
-- services on a schema without this file (42883 from the functions):
-- ehr-api's status route answers 404 CATALOG_NOT_AVAILABLE, as the contract
-- says it does before this ships, and the two searches 503
-- CATALOG_UNAVAILABLE, on which the screens fall back to typing.
--
-- Undo (by hand only): drop the two search functions and the status
-- function, then the three tables (lab tests and medicines before
-- versions; their triggers go with them), then the guard function and
-- the query helper. Nothing else refers to them.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 1-6. As above. 7. Post-checks.

-- 0. Preconditions.
do $$
begin
  if to_regclass('identity.qoreid_nin_checks') is null or to_regclass('ehr.visit_queue') is null then
    raise exception using errcode = '55000', message = '0149: 0001-0137 must be applied first';
  end if;
  -- The append-only trigger function the new tables use, as 0001 made it.
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure('platform.reject_mutation()'))
     is distinct from '398738f39f6eebed2c54da5009495def' then
    raise exception using errcode = '55000', message = '0149: platform.reject_mutation() is not as 0001 made it';
  end if;
  if to_regclass('ehr.catalog_versions') is not null or to_regclass('ehr.catalog_medicines') is not null
     or to_regclass('ehr.catalog_lab_tests') is not null
     or exists (select 1 from pg_proc proc where proc.pronamespace = 'ehr'::regnamespace
                 and proc.proname in ('search_catalog_medicines', 'search_catalog_lab_tests', 'catalog_status')) then
    raise exception using errcode = '55000', message = '0149: already applied';
  end if;
end
$$;

-- 1. Versions.
create table ehr.catalog_versions (
  id uuid primary key,
  kind text not null check (kind in ('medicine', 'lab_test')),
  version text not null check (version ~ '^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$'),
  file_sha256 char(64) not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  approval_reference text not null check (length(btrim(approval_reference)) between 8 and 500),
  approved_at timestamptz not null,
  loaded_at timestamptz not null default clock_timestamp(),
  active boolean not null default false,
  attribution text[] not null default '{}' check (cardinality(attribution) <= 5 and array_position(attribution, null) is null),
  constraint catalog_versions_kind_version_uq unique (kind, version)
);
create unique index catalog_versions_one_active_uq on ehr.catalog_versions (kind) where active;
revoke all on ehr.catalog_versions from public;
-- A version row never changes but for the loader's switch (active, and
-- loaded_at when it is loaded again), and is never deleted.
create function ehr.catalog_versions_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'ehr.catalog_versions rows are never deleted';
  end if;
  if (new.id, new.kind, new.version, new.file_sha256, new.approval_reference, new.approved_at, new.attribution)
     is distinct from
     (old.id, old.kind, old.version, old.file_sha256, old.approval_reference, old.approved_at, old.attribution) then
    raise exception using errcode = '55000', message = 'ehr.catalog_versions: only active and loaded_at may change';
  end if;
  return new;
end;
$$;
revoke all on function ehr.catalog_versions_guard() from public;
create trigger catalog_versions_guard
  before update or delete on ehr.catalog_versions
  for each row execute function ehr.catalog_versions_guard();
create trigger catalog_versions_no_truncate
  before truncate on ehr.catalog_versions
  for each statement execute function platform.reject_mutation();

-- 2. Medicines.
create table ehr.catalog_medicines (
  version_id uuid not null references ehr.catalog_versions(id) on delete restrict,
  list_id text not null check (list_id ~ '^MED-[0-9]{5}$'),
  generic_name text not null check (length(btrim(generic_name)) between 1 and 200),
  other_names text not null default '' check (length(other_names) <= 2000),
  strength text check (strength is null or length(strength) between 1 and 80),
  dose_form text not null check (dose_form in ('tablet', 'capsule', 'liquid', 'injection', 'cream', 'inhaler',
    'drops', 'other')),
  dose_form_text text check (dose_form_text is null or length(dose_form_text) between 1 and 80),
  routes text[] not null default '{}' check (cardinality(routes) <= 5),
  atc_code text check (atc_code is null or atc_code ~ '^[A-Z][0-9]{2}[A-Z]{2}[0-9]{2}$'),
  common_adult_dose text check (common_adult_dose is null or length(common_adult_dose) between 1 and 240),
  source text not null check (source ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  source_section text check (source_section is null or length(source_section) <= 40),
  source_list text check (source_list is null or source_list in ('main', 'restricted', 'specialist')),
  withdrawn boolean not null default false,
  search_terms tsvector generated always as
    (to_tsvector('simple'::regconfig, generic_name || ' ' || other_names)) stored,
  constraint catalog_medicines_pkey primary key (version_id, list_id)
);
create index catalog_medicines_search_idx on ehr.catalog_medicines using gin (search_terms);
revoke all on ehr.catalog_medicines from public;
-- A loaded row never changes: a correction or a withdrawal is a new version.
create trigger catalog_medicines_append_only
  before update or delete on ehr.catalog_medicines
  for each row execute function platform.reject_mutation();
create trigger catalog_medicines_no_truncate
  before truncate on ehr.catalog_medicines
  for each statement execute function platform.reject_mutation();

-- 3. Lab tests.
create table ehr.catalog_lab_tests (
  version_id uuid not null references ehr.catalog_versions(id) on delete restrict,
  list_id text not null check (list_id ~ '^LAB-[0-9]{4}$'),
  code_system text not null check (code_system in ('LOINC', 'HID-LAB')),
  code text not null check (length(code) between 1 and 100),
  display text not null check (length(btrim(display)) between 1 and 500),
  other_names text not null default '' check (length(other_names) <= 2000),
  specimen text check (specimen is null or length(specimen) between 1 and 100),
  category text not null check (category in ('haematology', 'chemistry', 'microbiology', 'serology', 'parasitology',
    'urine-and-stool', 'hormones', 'molecular', 'other')),
  source text not null check (source ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  withdrawn boolean not null default false,
  search_terms tsvector generated always as
    (to_tsvector('simple'::regconfig, display || ' ' || other_names)) stored,
  constraint catalog_lab_tests_pkey primary key (version_id, list_id),
  constraint catalog_lab_tests_code_uq unique (version_id, code_system, code)
);
create index catalog_lab_tests_search_idx on ehr.catalog_lab_tests using gin (search_terms);
revoke all on ehr.catalog_lab_tests from public;
-- A loaded row never changes: a correction or a withdrawal is a new version.
create trigger catalog_lab_tests_append_only
  before update or delete on ehr.catalog_lab_tests
  for each row execute function platform.reject_mutation();
create trigger catalog_lab_tests_no_truncate
  before truncate on ehr.catalog_lab_tests
  for each statement execute function platform.reject_mutation();

-- The words of a search: lower case, split at anything that is not a
-- letter or a digit (so "co-amox" is two words, as the index splits
-- "co-amoxiclav", and "E/U/Cr" three), empty words dropped, the first 6
-- words only, each cut to 40 characters; and the prefix query they make.
-- q never reaches to_tsquery as typed: each word is letters and digits
-- only and quoted, so "(", ":*" or "&|!" make no word and answer nothing,
-- never an error. An IMMUTABLE SQL helper, owner only (the search
-- functions call it as owner).
create function ehr.catalog_search_query(requested_q text)
returns tsquery
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case when count(*) = 0 then null
              else to_tsquery('simple'::regconfig, string_agg(quote_literal(word) || ':*', ' & ' order by position)) end
    from (select left(split.word, 40) as word, split.position
            from regexp_split_to_table(lower(requested_q), '[^[:alnum:]]+') with ordinality as split(word, position)
           where split.word <> ''
           order by split.position
           limit 6) words
$$;
revoke all on function ehr.catalog_search_query(text) from public;

-- 4. The two searches.
create function ehr.search_catalog_medicines(requested_q text, requested_limit integer,
  requested_dose_form text, requested_route text)
returns table (list_id text, generic_name text, strength text, dose_form text, dose_form_text text, routes text[],
  atc_code text, common_adult_dose text, matched_name text, source text, list_version text, more boolean)
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
begin
  if trimmed is null or length(trimmed) < 2 or length(trimmed) > 100
     or requested_limit is null or requested_limit < 1 or requested_limit > 25
     or (requested_dose_form is not null and requested_dose_form not in ('tablet', 'capsule', 'liquid', 'injection',
           'cream', 'inhaler', 'drops', 'other'))
     or (requested_route is not null and lower(requested_route) !~ '^[a-z][a-z -]{0,99}$') then
    raise exception using errcode = '22023', message = 'CATALOG_SEARCH_INVALID';
  end if;
  query := ehr.catalog_search_query(trimmed);
  if query is null then
    return;
  end if;
  -- "Starts with q" for the order: q with LIKE's %, _ and \ escaped.
  starts := replace(replace(replace(lower(trimmed), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    with matched as (
      select medicine.*, version_row.version as version_label,
             case when to_tsvector('simple'::regconfig, medicine.generic_name) @@ query then null
                  else (select other.name from unnest(string_to_array(medicine.other_names, '; ')) as other(name)
                         where other.name <> '' and to_tsvector('simple'::regconfig, other.name) @@ query
                         order by lower(other.name) collate "C", other.name collate "C" limit 1) end as matched
        from ehr.catalog_medicines medicine
        join ehr.catalog_versions version_row on version_row.id = medicine.version_id
       where version_row.active and version_row.kind = 'medicine'
         and not medicine.withdrawn
         and medicine.search_terms @@ query
         and (requested_dose_form is null or medicine.dose_form = requested_dose_form)
         and (requested_route is null or lower(requested_route) = any(medicine.routes))),
    shown as (
      select matched.* from matched
       where to_tsvector('simple'::regconfig, matched.generic_name) @@ query or matched.matched is not null),
    ranked as (
      select shown.*, count(*) over () as total,
             row_number() over (order by (lower(coalesce(shown.matched, shown.generic_name)) like starts escape '\') desc,
               lower(shown.generic_name) collate "C", shown.strength collate "C" nulls first, shown.list_id) as position
        from shown)
    select ranked.list_id, ranked.generic_name, ranked.strength, ranked.dose_form, ranked.dose_form_text, ranked.routes,
           ranked.atc_code, ranked.common_adult_dose, ranked.matched, ranked.source, ranked.version_label,
           ranked.total > requested_limit
      from ranked
     where ranked.position <= requested_limit
     order by ranked.position;
end;
$$;

create function ehr.search_catalog_lab_tests(requested_q text, requested_limit integer)
returns table (list_id text, code_system text, code text, display text, other_names text[], specimen text,
  category text, matched_name text, source text, list_version text, more boolean)
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
  return query
    with matched as (
      select test.*, version_row.version as version_label,
             case when to_tsvector('simple'::regconfig, test.display) @@ query then null
                  else (select other.name from unnest(string_to_array(test.other_names, '; ')) as other(name)
                         where other.name <> '' and to_tsvector('simple'::regconfig, other.name) @@ query
                         order by lower(other.name) collate "C", other.name collate "C" limit 1) end as matched
        from ehr.catalog_lab_tests test
        join ehr.catalog_versions version_row on version_row.id = test.version_id
       where version_row.active and version_row.kind = 'lab_test'
         and not test.withdrawn
         and test.search_terms @@ query),
    shown as (
      select matched.* from matched
       where to_tsvector('simple'::regconfig, matched.display) @@ query or matched.matched is not null),
    ranked as (
      select shown.*, count(*) over () as total,
             row_number() over (order by (lower(coalesce(shown.matched, shown.display)) like starts escape '\') desc,
               lower(shown.display) collate "C", shown.list_id) as position
        from shown)
    select ranked.list_id, ranked.code_system, ranked.code, ranked.display,
           array(select other.name from unnest(string_to_array(ranked.other_names, '; ')) as other(name)
                  where other.name <> ''),
           ranked.specimen, ranked.category, ranked.matched, ranked.source, ranked.version_label,
           ranked.total > requested_limit
      from ranked
     where ranked.position <= requested_limit
     order by ranked.position;
end;
$$;

-- 5. Status.
create function ehr.catalog_status()
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
           else (select count(*)::integer from ehr.catalog_lab_tests test
                  where test.version_id = version_row.id and not test.withdrawn) end,
         coalesce(version_row.attribution, '{}'), version_row.file_sha256::text
    from (values ('medicine'), ('lab_test')) as kinds(kind)
    left join ehr.catalog_versions version_row on version_row.kind = kinds.kind and version_row.active
   order by kinds.kind
$$;

-- 6. Grants (here and in runtime-grants.sql).
revoke all on function ehr.search_catalog_medicines(text, integer, text, text),
  ehr.search_catalog_lab_tests(text, integer), ehr.catalog_status() from public;
do $$
declare runtime_role text;
begin
  foreach runtime_role in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function ehr.search_catalog_medicines(text, integer, text, text), '
        || 'ehr.search_catalog_lab_tests(text, integer), ehr.catalog_status() to %I', runtime_role);
    end if;
  end loop;
end
$$;

comment on table ehr.catalog_versions is
  '0149 (ORD-7): one row per loaded version of the national medicine or lab-test list, with its seed file''s sha256 and the clinical lead''s approval (Q124 A); at most one active per kind; never deleted. Loaded by the governed loader, never by a migration.';
comment on table ehr.catalog_medicines is
  '0149 (ORD-7): the national medicine list, one row per list row per version (MED-nnnnn, the code under HID-MED). No patient data.';
comment on table ehr.catalog_lab_tests is
  '0149 (ORD-7): the national lab-test list, one row per list row per version (LAB-nnnn), ordered under LOINC or HID-LAB. No patient data.';
comment on function ehr.search_catalog_medicines(text, integer, text, text) is
  '0149 (ORD-7): the active medicine list''s rows (not withdrawn) whose generic name or one other name has a word starting with each word of q; names starting with q first, then A to Z; at most limit (1-25) and whether more matched. 22023 CATALOG_SEARCH_INVALID for q outside 2-100 characters, a limit outside 1-25 or an unknown dose form.';
comment on function ehr.search_catalog_lab_tests(text, integer) is
  '0149 (ORD-7): the active lab-test list''s rows (not withdrawn) whose name or one other name has a word starting with each word of q; names starting with q first, then A to Z; at most limit (1-25) and whether more matched.';
comment on function ehr.catalog_status() is
  '0149 (ORD-7): per kind (medicine, lab_test): whether an active version exists, its label, when it was approved, how many rows it offers and the notices its sources require.';

-- 7. Post-checks.
do $$
declare
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'ehr.catalog_versions'::regclass);
begin
  if exists (select 1 from pg_class relation, lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
              where relation.oid in ('ehr.catalog_versions'::regclass, 'ehr.catalog_medicines'::regclass,
                                     'ehr.catalog_lab_tests'::regclass)
                and acl.grantee <> relation.relowner) then
    raise exception using errcode = '55000', message = '0149: a catalogue table is granted to a role other than its owner';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in ('ehr.search_catalog_medicines(text,integer,text,text)'::regprocedure,
                                 'ehr.search_catalog_lab_tests(text,integer)'::regprocedure,
                                 'ehr.catalog_status()'::regprocedure, 'ehr.catalog_search_query(text)'::regprocedure,
                                 'ehr.catalog_versions_guard()'::regprocedure)
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) not in ('hid_ehr_runtime', 'hid_schema_test_runtime')
                     or proc.oid in ('ehr.catalog_search_query(text)'::regprocedure,
                                     'ehr.catalog_versions_guard()'::regprocedure))) then
    raise exception using errcode = '55000', message = '0149: a catalogue function is granted to a role other than the EHR and schema test runtimes';
  end if;
  if (select count(*) from pg_proc proc
       where proc.oid in ('ehr.search_catalog_medicines(text,integer,text,text)'::regprocedure,
                          'ehr.search_catalog_lab_tests(text,integer)'::regprocedure,
                          'ehr.catalog_status()'::regprocedure)
         and proc.prosecdef and proc.provolatile = 's' and proc.proowner = owner_oid
         and proc.proconfig = array['search_path=pg_catalog, pg_temp']) <> 3 then
    raise exception using errcode = '55000', message = '0149: a catalogue function is not as made';
  end if;
  if (select count(*) from pg_trigger trigger_row
       where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
         and (trigger_row.tgrelid, trigger_row.tgname, trigger_row.tgfoid) in (
           ('ehr.catalog_versions'::regclass, 'catalog_versions_guard', 'ehr.catalog_versions_guard()'::regprocedure),
           ('ehr.catalog_versions'::regclass, 'catalog_versions_no_truncate', 'platform.reject_mutation()'::regprocedure),
           ('ehr.catalog_medicines'::regclass, 'catalog_medicines_append_only', 'platform.reject_mutation()'::regprocedure),
           ('ehr.catalog_medicines'::regclass, 'catalog_medicines_no_truncate', 'platform.reject_mutation()'::regprocedure),
           ('ehr.catalog_lab_tests'::regclass, 'catalog_lab_tests_append_only', 'platform.reject_mutation()'::regprocedure),
           ('ehr.catalog_lab_tests'::regclass, 'catalog_lab_tests_no_truncate', 'platform.reject_mutation()'::regprocedure)))
     <> 6 then
    raise exception using errcode = '55000', message = '0149: a catalogue table is missing its append-only trigger';
  end if;
  if exists (select 1 from ehr.catalog_versions) then
    raise exception using errcode = '55000', message = '0149: the lists must be empty after this file';
  end if;
end
$$;
