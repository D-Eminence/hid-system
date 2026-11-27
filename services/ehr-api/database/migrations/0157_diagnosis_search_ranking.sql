-- 0157 Diagnosis search ranking: Rahman's two fixes in the ICD-11 search
-- (ORD-9 of the Akos EHR plan, lane D). The planned contract's section
-- "ORD-9: Diagnosis search on ICD-11, recent diagnoses, and diagnoses by
-- name only", first slice. Rahman's last look at #320 (hid-system#320, 24
-- November 2026) cleared 0152 to sign and left two ranking minors, to fix
-- before any ICD-11 release is activated; the design note on hid-system#258
-- (Ola, 26 November 2026, 13:20 UTC) is the plan, Ola's addendum there
-- (27 November 2026, 10:10 UTC, from the build's clinical review) changes
-- fix 2's count twice, and her second addendum (27 November 2026, 16:20
-- UTC, from the first addendum's review) narrows both changes (below).
-- Written on 0152 (#320).
-- The number is a booking, given at integration in release order; neither
-- function body names 0152 or 0157 (both name only 0149, the helper's file,
-- in comments), so renumbering leaves both md5s. This file requires 0149
-- and 0152 applied (0153-0156 and 0159 are not required). The declaration
-- is signed separately.
--
-- THE GAP. Rahman's two minors, both in ehr.search_catalog_diagnoses only:
-- 1. The second attempt (when nothing matched) drops a final s from every
--    word of 4 or more letters, then keeps an entry only when each
--    shortened word is a whole word of it. A word that ends in s by itself
--    was lost: thyroiditis became thyroiditi, sclerosis sclerosi, sites
--    site, uterus uteru. So "hashimotos thyroiditis", "hodgkins lymphoma
--    nodular sclerosis", "crohns disease of anastomotic sites", "bitots
--    spots" and "fibroids uterus" found nothing, and "Mature B-cells
--    neoplasms, unspecified" offered only 2A82.Z, not 2A8Z.
-- 2. Long or numbered queries ranked by their first 6 words (0149's query
--    helper) and by code parts. Words after the 6th neither narrowed nor
--    ranked: "HIV disease stage 1 associated with tuberculosis" put 1C61.0,
--    the malaria entry, first. A lone stage, grade or type number also
--    matched a code part, because the title check includes the code's
--    words: "grade 2 follicular lymphoma" put 2A80.0, grade 1, first, and
--    "hiv stage 2" put a stage 3 entry second.
--
-- WHAT IT DOES: one CREATE OR REPLACE of ehr.search_catalog_diagnoses
-- (requested_q text, requested_limit integer), with the same columns (code,
-- title, matched_name, list_version, more), language plpgsql, STABLE,
-- SECURITY DEFINER, search_path pg_catalog, pg_temp and #variable_conflict
-- use_column, all restated (CREATE OR REPLACE refuses a changed parameter
-- name or column, 42P13, and keeps the owner, the grants and the oid). Its
-- body is 0152's (0152:296-436), but for:
-- 1. Fix 1, Rahman's form. The entry's own words (its title's and our other
--    names', each split as q is; never the code's) are listed once per row.
--    On the second attempt a shortened word is accepted when it, or the
--    word as typed (it with its s), is one of them. So "hashimotos
--    thyroiditis" finds 5A03.20 Hashimoto thyroiditis, "fibroids uterus"
--    2E86.0 through our other name "fibroid uterus", and "Mature B-cells
--    neoplasms, unspecified" 2A8Z, then 2A82.Z. "fits" still finds nothing:
--    fit only starts "Fitting or adjustment of ...", and neither fit nor
--    fits is a word of it. A one-word q reaches the second attempt only when
--    no entry has a word starting with it, so its word as typed is never a
--    whole word, and fix 1 never changes a one-word answer.
-- 2. Fix 2. Every word of q as searched (lower case, split as q is, empty
--    pieces dropped, each cut to 40 characters as 0149's helper cuts them,
--    but not stopped at 6; on the second attempt, the words as shortened, as
--    the match uses them) is counted for each entry when it starts one of
--    the words the count reads, never a code part. Those are the entry's own
--    words. But when q has the word with and not the word without, each
--    "without ..." clause of its title and of our other names is taken out
--    first: the word without, split as q is, up to the next , or ; or the
--    next word with, or the end (a , is put before each word with, so the
--    clause's pattern needs no nested look-around). Ola's addenda: with
--    starts without, so "hiv disease clinical stage 4 with tuberculosis and
--    malaria" put 1C62.3, "... without mention of tuberculosis or malaria",
--    first, and "calculus of bile duct with cholangitis and cholecystitis"
--    put DC11.6, "... without cholangitis or cholecystitis", first. Any
--    other q counts every word (the second addendum: taken out for every q,
--    a clause also took the site of "Laceration without foreign body of
--    forearm" and the pelvic ring of the stable pelvic fractures), so
--    "laceration of forearm" keeps NC31.0 third, "pelvic fracture" and a q
--    typed with "w/o" keep 0152's order, and "meconium without ileus" still
--    puts KB87.1 Meconium plug without ileus first. A clause ends at the next
--    word with, so 6A02.2 "... without disorder of intellectual development
--    and with impaired functional language" still names functional and
--    language. That list is made once per row, beside the entry's own words,
--    only for such a q and only for an entry with the letters without in its
--    title or other names (the 2026-01 release has 260 such titles and no
--    such other name); every other entry's count reads its own words. Fix
--    1's whole-word check still reads all of the entry's own words. For a q
--    of one word, or of an ICD-11 code's shape (the first key's shape, with
--    a digit third, as every ICD-11 code has: "ME24.A", "KA21.2", "1C62.3",
--    "NC31 0"), every entry counts 0, so such a q keeps 0152's order (Ola,
--    clinical owner: a clinician who types a code fragment such as "1a"
--    usually means the code, so 1A00 Cholera stays before GC51.00 Female
--    Genital Mutilation Type 1a; and the addendum: "ME24.A", counted as two
--    words, put its own subcodes in rows 2-5 behind other ME24 entries).
--    Four letters or digits, a space and one or two more have the first
--    key's shape too, but no digit third, so "type 1", "lung ca" and "loss
--    of" are counted (the second addendum).
-- 3. The order:
--    a. the entry whose code q is;
--    b. entries whose title or one of our other names is q;
--    c. entries whose title or other name starts with q;
--    d. (new) entries naming more of q's words (2);
--    e. shorter titles, then the title in the "C" collation, then the code.
--    The first three keys never move, so a code typed in any form, and a
--    title typed as written, still come first. The new key never changes
--    which entries match, how many, or more. It orders only entries that
--    name different numbers of q's words, which happens only when q has 2
--    or more words and no ICD-11 code's shape, and either has 7 or more
--    words, or one of its words starts a code part of an entry, or (when q
--    has the word with and not the word without) a word of one of its
--    "without ..." clauses, and no word the count reads. So "HIV disease
--    stage 1 associated with tuberculosis" puts 1C60.0 first and 1C61.0
--    second, "grade 2 follicular lymphoma" 2A80.1 first, "hiv stage 2" the
--    stage 2 entries before the stage 3 ones, "stage 3" 1C60.2 and 1C62.2
--    before 1C61.3, which is stage 4, "type 1" 7A20.1 Narcolepsy, Type 2
--    after the type 1 entries, "lung ca" the lung carcinomas before Farmer
--    lung (CA70.0), "hiv disease clinical stage 4 with tuberculosis and
--    malaria" 1C61.3 and 1C60.3 before 1C62.3, and "calculus of bile duct
--    with cholangitis and cholecystitis" DC11.4 before DC11.6.
-- 4. The body's comment on the release, as Rahman worded it: the active
--    release's id is read first, and the code through the key (version_id,
--    code), but the words' index finds every kept release's matches, and
--    the scan drops those of the other releases. (0152's header, line 52,
--    still says "only that release's rows are read"; it stays as signed.)
-- 5. The function's comment names 0152 and 0157 and the new order.
--
-- What it does not do: no table, index, trigger, grant or row changes.
-- 0152's tables, its sealed-release function and ehr.catalog_status() (which
-- 0155 replaces), 0149's helper and its medicine and lab-test searches (so
-- words after the 6th still do not narrow; they only rank), 0153's and
-- 0156's functions (which never call the search), the seed, ehr-api
-- (DIAGNOSES_SQL) and runtime-grants.sql are unchanged.
--
-- Known limits (Ola's addenda: accepted, and named in the contract):
-- "mumps complications" found nothing on 0152 and offers only 1D80.0 Mumps
-- without complication here (fix 1), the negation blindness 0152 already
-- has for "varicella complications"; the fix is an other name in the seed
-- follow-up (#342). A junk q of 50 one-letter words takes about 2.3 times
-- as long as on 0152 (about 405 ms against 177 ms), bounded by the
-- 100-character limit and the 429 rate limit. Two problems 0152 already
-- has, outside 0157 (Ola tracks them separately): "1C62.3 hiv", a code and
-- a word, is not a code, so 1C62.2 comes first; and "gestational
-- hypertension with proteinuria" matches only "... without hypertension"
-- entries.
--
-- Locks: none on tables. The search stays PL/pgSQL, as 0152 made it. The
-- runner leaves check_function_bodies on, and for PL/pgSQL that check is
-- syntax only: the SQL inside is parsed, but no table or function name is
-- looked up, so replacing it locks no table (an SQL body would take ACCESS
-- SHARE on both catalogue tables at CREATE). Its declarations stay plain
-- types, with no %ROWTYPE or %TYPE. Only PostgreSQL's own catalog rows
-- change (the function's pg_proc row and its comment). A search does not
-- wait: a call in progress finishes on the old body, and the next call
-- after the commit uses the new one. Busy refusals: none; every refusal
-- starts with "0157: ".
--
-- Old and new services on this schema: the answer's shape does not change,
-- and ehr-api is not changed, so either image may run on either schema.
-- Production has no ICD-11 release (nothing is loaded until the clinical
-- lead signs one), so no answer there changes until one is activated.
--
-- Undo (by hand only, owner-signed, one transaction): CREATE OR REPLACE the
-- search with 0152's body verbatim (0152:296-436), everything restated, and
-- 0152's comment (0152:477-478); then check the body's md5
-- (43f331b780d76226347dcf4cba313f74), STABLE, SECURITY DEFINER, its
-- search_path, its owner and its grants. No table lock.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied): 0149's
--    ehr.catalog_versions, 0152's ehr.catalog_diagnoses and the search;
--    "0157: already applied" when the search's body is this file's (its
--    md5); otherwise the search as 0152 made it (the md5 of its body,
--    PL/pgSQL, SECURITY DEFINER, STABLE, its search_path, the owner of
--    ehr.catalog_versions and its columns), and 0149's query helper, which
--    the body calls, as 0152 pins it (the md5 of its body, its owner and its
--    search_path). Nothing else is required, and other lanes' additions
--    pass. If a file released before 0157 ever replaces the search, the
--    first md5 moves to its body's at integration.
-- 1. The search. 2. Its comment. 3. Post-checks: the body's md5 (this
--    file's), SECURITY DEFINER, STABLE, its search_path and its owner;
--    EXECUTE for the owner and the EHR and schema test runtimes only, and
--    each runtime that exists still holds it; 0149's helper unchanged.

-- 0. Preconditions.
do $$
begin
  if to_regclass('ehr.catalog_versions') is null or to_regclass('ehr.catalog_diagnoses') is null
     or to_regprocedure('ehr.search_catalog_diagnoses(text,integer)') is null then
    raise exception using errcode = '55000', message = '0157: 0149 and 0152 must be applied first';
  end if;
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = 'ehr.search_catalog_diagnoses(text,integer)'::regprocedure)
     = 'c9071a17d289c4df6f99d334b0430207' then
    raise exception using errcode = '55000', message = '0157: already applied';
  end if;
  -- The search as 0152 made it: its body, language, SECURITY DEFINER, STABLE, search_path, owner and columns.
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'ehr.search_catalog_diagnoses(text,integer)'::regprocedure
                    and md5(proc.prosrc) = '43f331b780d76226347dcf4cba313f74'
                    and proc.prolang = (select language_row.oid from pg_language language_row
                                         where language_row.lanname = 'plpgsql')
                    and proc.prosecdef and proc.provolatile = 's'
                    and proc.proconfig = array['search_path=pg_catalog, pg_temp']
                    and proc.proowner = (select relation.relowner from pg_class relation
                                          where relation.oid = 'ehr.catalog_versions'::regclass)
                    and pg_get_function_result(proc.oid)
                        = 'TABLE(code text, title text, matched_name text, list_version text, more boolean)') then
    raise exception using errcode = '55000',
      message = '0157: ehr.search_catalog_diagnoses is not as 0152 made it';
  end if;
  -- The body still calls 0149's query helper (the first 6 words, 40 characters, prefix matching, never raw
  -- to_tsquery): its body, owner and search_path, as 0152 pins them.
  if (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure('ehr.catalog_search_query(text)'))
     is distinct from '8b3c964d6b9f34c557210acfe1f986ff'
     or not exists (select 1 from pg_proc proc
                     where proc.oid = to_regprocedure('ehr.catalog_search_query(text)')
                       and proc.proowner = (select relation.relowner from pg_class relation
                                             where relation.oid = 'ehr.catalog_versions'::regclass)
                       and proc.proconfig = array['search_path=pg_catalog, pg_temp']) then
    raise exception using errcode = '55000', message = '0157: 0149''s query helper is not as made';
  end if;
end
$$;

-- 1. The search (as 0152 made it but for the two fixes; see above).
create or replace function ehr.search_catalog_diagnoses(requested_q text, requested_limit integer)
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
  -- Every word of q as searched, not only the first 6: an entry is ranked by how many of them it names.
  typed_words text[];
  code_text text;
  typed_code text;
  release_id uuid;
  release_label text;
  -- On the second attempt only: the words of q that it shortened, each of which, or the word as typed, must be a
  -- whole word of the entry.
  shortened text[];
begin
  if trimmed is null or length(trimmed) < 2 or length(trimmed) > 100
     or requested_limit is null or requested_limit < 1 or requested_limit > 25 then
    raise exception using errcode = '22023', message = 'CATALOG_SEARCH_INVALID';
  end if;
  -- The active release first, and the code through the key (version_id, code). The words' index finds every kept
  -- release's matches, and the scan drops those of the other releases.
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
    -- Every word of q as searched: lower case, split as q is, each cut to 40 characters as 0149's helper cuts them,
    -- but not stopped at 6 (on the second attempt, the words as shortened, as the match uses them).
    typed_words := array(select left(split.word, 40)
                           from regexp_split_to_table(lower(searched), '[^[:alnum:]]+') as split(word)
                          where split.word <> '');
    return query
      with candidates as materialized (
        -- The release's rows whose words match, or whose code q is; each title split into words once, as q is.
        select diagnosis.code, diagnosis.title, diagnosis.other_names,
               regexp_replace(lower(diagnosis.title), '[^[:alnum:]]+', ' ', 'g') as title_words
          from ehr.catalog_diagnoses diagnosis
         where diagnosis.version_id = release_id
           and (diagnosis.search_terms @@ query or diagnosis.code = typed_code)),
      found as (
        select candidate.code, candidate.title, candidate.title_words, candidate.other_names,
               compared.title as compared_title,
               -- The entry's own words: its title's and our other names', each split as q is; never the code's.
               string_to_array(btrim(candidate.title_words || ' '
                 || regexp_replace(lower(candidate.other_names), '[^[:alnum:]]+', ' ', 'g')), ' ') as entry_words,
               -- The words the count reads, when they are not the entry's own: its title's and our other names', each
               -- "without ..." clause taken out first (the word without, as q is split, to the next , or ; or the
               -- next word with, or the end: a , is put before each word with, and the clause then runs to the next ,
               -- or ;), then split as q is. Only when q has the word with and not the word without, and the title or
               -- our other names have the letters without; null otherwise, and the count then reads the entry's own
               -- words. Made once per row.
               case when 'with' = any(typed_words) and 'without' <> all(typed_words)
                         and (strpos(candidate.title_words, 'without') > 0
                              or strpos(lower(candidate.other_names), 'without') > 0)
                    then string_to_array(btrim(regexp_replace(regexp_replace(regexp_replace(lower(candidate.title),
                           '(?<![[:alnum:]])with(?![[:alnum:]])', ',with', 'g'),
                           '(?<![[:alnum:]])without(?![[:alnum:]])[^,;]*', ' ', 'g'), '[^[:alnum:]]+', ' ', 'g') || ' '
                         || regexp_replace(regexp_replace(regexp_replace(lower(candidate.other_names),
                           '(?<![[:alnum:]])with(?![[:alnum:]])', ',with', 'g'),
                           '(?<![[:alnum:]])without(?![[:alnum:]])[^,;]*', ' ', 'g'), '[^[:alnum:]]+', ' ', 'g')), ' ')
               end as counted_words,
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
                 as compared_other,
               -- How many words of q start a word the count reads: every word, not only the first 6, and never a code
               -- part. 0 for every row when q is one word, or has an ICD-11 code's shape (the code key's shape, with a
               -- digit third), so such a q keeps its order.
               case when cardinality(typed_words) < 2
                         or (typed_code is not null and substr(typed_code, 3, 1) ~ '[0-9]') then 0
                    else (select count(*)::integer from unnest(typed_words) as typed(word)
                           where exists (select 1
                                           from unnest(coalesce(found.counted_words, found.entry_words)) as entry(word)
                                          where starts_with(entry.word, typed.word))) end as words_named
          from found
         where (found.code_hit or found.title_hit or found.other_hit is not null)
           -- On the second attempt, each word whose final s was dropped, or that word as typed, is a whole word of the
           -- title or of one of our other names, not only the start of one ("fits" is not "Fitting or adjustment of
           -- ...", and thyroiditis, shortened to thyroiditi, is a whole word of "Hashimoto thyroiditis").
           and (shortened is null
                or not exists (select 1 from unnest(shortened) as word(shortened_word)
                                where not (array[word.shortened_word, word.shortened_word || 's'] && found.entry_words)))),
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
               -- The code q is, a name that is q, a name starting with q, more of q's words named, then shorter titles.
               row_number() over (order by shown.code_hit desc, shown.name_is_q desc, shown.starts_with_q desc,
                 shown.words_named desc, length(shown.title), lower(shown.title) collate "C", shown.code collate "C")
                 as position
          from shown)
      select ranked.code, ranked.title, ranked.matched, release_label, ranked.total > requested_limit
        from ranked
       where ranked.position <= requested_limit
       order by ranked.position;
    if found then
      return;
    end if;
    -- Nothing matched: once more with a final s dropped from each word of 4 or more letters ("parkinsons" is
    -- parkinson, "alzheimers" alzheimer), when that changes q; each word so shortened, or the word as typed, must
    -- then be a whole word.
    fewer_s := regexp_replace(searched, '(?<![[:alnum:]])([[:alpha:]]{3,})[sS](?![[:alnum:]])', '\1', 'g');
    exit when fewer_s = searched;
    shortened := array(select lower(shortened_match[1])
                         from regexp_matches(searched, '(?<![[:alnum:]])([[:alpha:]]{3,})[sS](?![[:alnum:]])', 'g')
                              as shortened_match);
    searched := fewer_s;
  end loop;
end;
$$;

-- 2. Its comment.
comment on function ehr.search_catalog_diagnoses(text, integer) is
  '0152 (ORD-9), 0157 (ORD-9, Rahman''s two ranking fixes, with Ola''s two addenda): the active ICD-11 release''s entries whose code and title or one other name has a word starting with each word of q (a word-final ''s dropped from q; when nothing matched, once more with a final s dropped from words of 4 or more letters, each word so shortened, or the word as typed, then a whole word of the title or of one other name); the entry whose code q is (with or without its dot, or with spaces at its dot, and with any run of characters that are neither letters nor digits taken off both ends; its own dot stays) first, then a title or other name that is q, then names starting with q, then, for q of 2 or more words not shaped like an ICD-11 code, entries naming more of q''s words (every word of q, not only the first 6, that starts a word of the title or of one other name, never a code part, nor, when q has the word with and not the word without, a word of a "without ..." clause, which ends at the next comma, semicolon or word with), then shorter titles, then A to Z; at most limit (1-25) and whether more matched. 22023 CATALOG_SEARCH_INVALID for q outside 2-100 characters or a limit outside 1-25.';

-- 3. Post-checks.
do $$
declare
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'ehr.catalog_versions'::regclass);
begin
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'ehr.search_catalog_diagnoses(text,integer)'::regprocedure
                    and md5(proc.prosrc) = 'c9071a17d289c4df6f99d334b0430207'
                    and proc.prosecdef and proc.provolatile = 's' and proc.proowner = owner_oid
                    and proc.proconfig = array['search_path=pg_catalog, pg_temp']) then
    raise exception using errcode = '55000', message = '0157: the diagnosis search is not as made';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid = 'ehr.search_catalog_diagnoses(text,integer)'::regprocedure
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) not in ('hid_ehr_runtime', 'hid_schema_test_runtime'))) then
    raise exception using errcode = '55000', message = '0157: the diagnosis search is granted to a role other than the EHR and schema test runtimes';
  end if;
  -- CREATE OR REPLACE keeps the grants: each runtime that exists holds EXECUTE (0152 granted it; the preconditions do
  -- not check it, so a runtime that never held it is refused here too, and nothing is applied).
  if exists (select 1 from pg_roles runtime_role
              where runtime_role.rolname in ('hid_ehr_runtime', 'hid_schema_test_runtime')
                and not exists (select 1 from pg_proc proc, lateral aclexplode(proc.proacl) acl
                                 where proc.oid = 'ehr.search_catalog_diagnoses(text,integer)'::regprocedure
                                   and acl.grantee = runtime_role.oid and acl.privilege_type = 'EXECUTE')) then
    raise exception using errcode = '55000', message = '0157: a runtime does not hold EXECUTE on the diagnosis search';
  end if;
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'ehr.catalog_search_query(text)'::regprocedure
                    and md5(proc.prosrc) = '8b3c964d6b9f34c557210acfe1f986ff'
                    and proc.proowner = owner_oid and proc.proconfig = array['search_path=pg_catalog, pg_temp']) then
    raise exception using errcode = '55000', message = '0157: 0149''s query helper is not as made';
  end if;
end
$$;
