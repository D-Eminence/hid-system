\set ON_ERROR_STOP on
-- 0149 (ORD-7, first slice): the medicine and lab-test lists and their
-- search. Rollback-only.
--   1. after 0001-0149: the lists are empty, the status says not available,
--      the searches answer nothing; the tables are the owner's only, the
--      functions are the EHR and schema test runtimes' only;
--   2. with a version loaded by hand (as the governed loader will: rows
--      into a version still loading, then the switch): prefix search on the
--      generic name and other names, letter case ignored, punctuation
--      splitting words in q and in the names alike (MTB/RIF, HIV 1/2,
--      COVID-19, U/A and G&XM found by their exact names); names that start
--      with q first, then A to Z; matched_name; dose form and route
--      filters; limit and more; withdrawn rows and inactive versions never
--      offered; one active version per kind; the status counts what is
--      offered;
--   3. refusals: q of 1 or 101 characters, limit 0 or 26, an unknown dose
--      form, a route that is not a plain word (22023
--      CATALOG_SEARCH_INVALID); q of punctuation only, brackets, :* or
--      operators answers nothing, never an error; only the first 6 words
--      of at most 40 characters count; LIKE's characters are plain; ids,
--      codes and ATC codes outside their forms are refused; a loaded row
--      and a version never change but for the loader's switch (55000), and
--      the switch (old off, then new on) works; the status names each
--      seed file; a retired id, a changed id and a reused lab code are
--      refused, an unchanged id loads in a new version;
--   4. the EHR runtime may run the searches and read no table;
--   5. a version is sealed when it goes live and stays sealed: a row for
--      the active version or a replaced one is refused (55000
--      CATALOG_VERSION_SEALED), a row for a version still loading loads;
--      the approvals file's sha256 never changes.
-- Synthetic values only: uuid prefix c149. Medicine and test names are list
-- facts, not patient data.
set plpgsql.variable_conflict = error;
begin;

create temporary table catalog_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;
grant select, insert on catalog_cases to public;
grant usage on sequence catalog_cases_seq_seq to public;
create function pg_temp.expect(case_name text, expected text, actual text) returns void language sql as $$
  insert into catalog_cases (name, expected, actual) values (case_name, expected, coalesce(actual, 'null'));
$$;
grant execute on function pg_temp.expect(text, text, text) to public;
-- A refusal's SQLSTATE and message, or 'none'.
create function pg_temp.refusal(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'none';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.refusal(text) to public;
create function pg_temp.medicines(q text, lim integer, form text default null, route text default null) returns text
language sql as $$
  select coalesce(string_agg(found.list_id || coalesce('(' || found.matched_name || ')', ''), ' ' order by ordinality), '')
         || ' more=' || coalesce(bool_or(found.more)::text, 'false')
    from ehr.search_catalog_medicines(q, lim, form, route) with ordinality as found;
$$;
grant execute on function pg_temp.medicines(text, integer, text, text) to public;
create function pg_temp.tests(q text, lim integer) returns text language sql as $$
  select coalesce(string_agg(found.list_id || coalesce('(' || found.matched_name || ')', ''), ' ' order by ordinality), '')
         || ' more=' || coalesce(bool_or(found.more)::text, 'false')
    from ehr.search_catalog_lab_tests(q, lim) with ordinality as found;
$$;
grant execute on function pg_temp.tests(text, integer) to public;

-- 1. After 0001-0149.
select pg_temp.expect('1a the lists are empty', '0 0 0',
  (select count(*) from ehr.catalog_versions) || ' ' || (select count(*) from ehr.catalog_medicines) || ' '
  || (select count(*) from ehr.catalog_lab_tests));
select pg_temp.expect('1b the status: neither list available, no seed file', 'lab_test f 0 -, medicine f 0 -',
  (select string_agg(format('%s %s %s %s', kind, available, offered, coalesce(file_sha256, '-')), ', ' order by kind)
     from ehr.catalog_status() where kind in ('lab_test', 'medicine')));
select pg_temp.expect('1c a search before any list answers nothing', ' more=false', pg_temp.medicines('amox', 10));
select pg_temp.expect('1d no runtime holds a privilege on the tables', '0',
  (select count(*)::text from pg_class relation, lateral aclexplode(coalesce(relation.relacl,
     acldefault('r', relation.relowner))) acl
    where relation.oid in ('ehr.catalog_versions'::regclass, 'ehr.catalog_medicines'::regclass,
                           'ehr.catalog_lab_tests'::regclass, 'ehr.catalog_retired_codes'::regclass)
      and acl.grantee <> relation.relowner));
select pg_temp.expect('1e the searches and the status: the EHR runtime only (of the service runtimes)',
  'true true true false false',
  has_function_privilege('hid_ehr_runtime', 'ehr.search_catalog_medicines(text,integer,text,text)', 'EXECUTE')
  || ' ' || has_function_privilege('hid_ehr_runtime', 'ehr.search_catalog_lab_tests(text,integer)', 'EXECUTE')
  || ' ' || has_function_privilege('hid_ehr_runtime', 'ehr.catalog_status()', 'EXECUTE')
  || ' ' || has_function_privilege('hid_pharmacy_runtime', 'ehr.search_catalog_medicines(text,integer,text,text)',
       'EXECUTE')
  || ' ' || has_function_privilege('hid_ehr_runtime', 'ehr.catalog_search_query(text)', 'EXECUTE'));

-- 2. A version loaded by hand, as the governed loader will: the versions (loading), their rows, then the switch.
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approvals_sha256, approved_at)
values
  ('c1490000-0000-4000-8000-000000000001', 'medicine', '2026.1', repeat('a', 64), 'synthetic sign-off reference',
   repeat('1', 64), now()),
  ('c1490000-0000-4000-8000-000000000002', 'lab_test', '2026.1', repeat('b', 64), 'synthetic sign-off reference',
   repeat('1', 64), now()),
  ('c1490000-0000-4000-8000-000000000003', 'medicine', '2025.9', repeat('c', 64), 'synthetic older sign-off',
   repeat('2', 64), now() - interval '30 days');
insert into ehr.catalog_medicines (version_id, list_id, generic_name, other_names, strength, dose_form, dose_form_text,
  routes, atc_code, source) values
  ('c1490000-0000-4000-8000-000000000001', 'MED-00001', 'amoxicillin', 'Amoxil', '500 mg', 'capsule', 'Capsule',
   '{oral}', 'J01CA04', 'nigeria-eml-8'),
  ('c1490000-0000-4000-8000-000000000001', 'MED-00002', 'amoxicillin', 'Amoxil', '125 mg/5 mL', 'liquid',
   'Oral liquid', '{oral}', 'J01CA04', 'nigeria-eml-8'),
  ('c1490000-0000-4000-8000-000000000001', 'MED-00003', 'amoxicillin + clavulanic acid', 'Augmentin; co-amoxiclav',
   '625 mg', 'tablet', 'Tablet', '{oral}', 'J01CR02', 'nigeria-eml-8'),
  ('c1490000-0000-4000-8000-000000000001', 'MED-00004', 'paracetamol', 'acetaminophen; Panadol', '500 mg', 'tablet',
   'Tablet', '{oral}', 'N02BE01', 'nigeria-eml-8'),
  ('c1490000-0000-4000-8000-000000000001', 'MED-00005', 'ceftriaxone', '', '1 g', 'injection', 'Powder for injection',
   '{intravenous,intramuscular}', 'J01DD04', 'nigeria-eml-8'),
  ('c1490000-0000-4000-8000-000000000001', 'MED-00006', 'chloramphenicol', '', '250 mg', 'capsule', 'Capsule',
   '{oral}', null, 'nigeria-eml-8'),
  ('c1490000-0000-4000-8000-000000000003', 'MED-00099', 'amoxicillin', '', '250 mg', 'capsule', 'Capsule', '{oral}',
   null, 'nigeria-eml-7');
-- Withdrawn in this version (a loaded row never changes: a withdrawal is a new version's row).
insert into ehr.catalog_medicines (version_id, list_id, generic_name, other_names, strength, dose_form, dose_form_text,
  routes, atc_code, source, withdrawn) values
  ('c1490000-0000-4000-8000-000000000001', 'MED-00007', 'prussian blue', '', '500 mg', 'capsule', 'Capsule', '{oral}',
   null, 'who-eml-24', true);
insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display, other_names, specimen, category,
  source) values
  ('c1490000-0000-4000-8000-000000000002', 'LAB-0001', 'LOINC', '57021-8', 'Full blood count',
   'FBC; CBC; Complete blood count', 'Blood (EDTA)', 'haematology', 'hid-common-tests'),
  ('c1490000-0000-4000-8000-000000000002', 'LAB-0002', 'LOINC', '24362-6', 'Electrolytes, urea and creatinine',
   'E/U/Cr; U&E', 'Serum', 'chemistry', 'hid-common-tests'),
  ('c1490000-0000-4000-8000-000000000002', 'LAB-0003', 'HID-LAB', 'MP-SMEAR', 'Malaria parasite (blood film)',
   'MP; blood film for malaria', 'Blood (EDTA)', 'parasitology', 'hid-common-tests'),
  -- Names the default parser would split otherwise than q (#318 review, finding 1). Synthetic codes.
  ('c1490000-0000-4000-8000-000000000002', 'LAB-0004', 'HID-LAB', 'SYN-MTB-RIF', 'GeneXpert MTB/RIF',
   'Xpert MTB/RIF Ultra', 'Sputum', 'molecular', 'hid-common-tests'),
  ('c1490000-0000-4000-8000-000000000002', 'LAB-0005', 'HID-LAB', 'SYN-HIV-12', 'HIV 1/2 screening', 'HIV rapid test',
   'Serum', 'serology', 'hid-common-tests'),
  ('c1490000-0000-4000-8000-000000000002', 'LAB-0006', 'HID-LAB', 'SYN-COVID-PCR', 'COVID-19 PCR', '',
   'Nasopharyngeal swab', 'molecular', 'hid-common-tests'),
  ('c1490000-0000-4000-8000-000000000002', 'LAB-0007', 'HID-LAB', 'SYN-UA', 'Urinalysis', 'U/A; Urine dipstick',
   'Urine', 'urine-and-stool', 'hid-common-tests'),
  ('c1490000-0000-4000-8000-000000000002', 'LAB-0008', 'HID-LAB', 'SYN-GXM', 'Group and crossmatch',
   'G&XM; Crossmatch', 'Blood (EDTA)', 'blood-bank', 'hid-common-tests');
-- The loader's switch: the new versions on (each kind had none on).
update ehr.catalog_versions set active = true
 where id in ('c1490000-0000-4000-8000-000000000001', 'c1490000-0000-4000-8000-000000000002');
-- The next versions, still loading (3f, 3r to 3w, 5).
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approvals_sha256, approved_at)
values
  ('c1490000-0000-4000-8000-000000000004', 'medicine', '2026.2', repeat('e', 64), 'synthetic next sign-off',
   repeat('3', 64), now()),
  ('c1490000-0000-4000-8000-000000000005', 'lab_test', '2026.2', repeat('f', 64), 'synthetic next sign-off',
   repeat('3', 64), now());

select pg_temp.expect('2a a prefix of the generic name: names starting with q first, then A to Z, then strength',
  'MED-00002 MED-00001 MED-00003 more=false', pg_temp.medicines('amox', 10));
select pg_temp.expect('2b letter case and spaces ignored', 'MED-00002 MED-00001 MED-00003 more=false',
  pg_temp.medicines('  AMOX  ', 10));
select pg_temp.expect('2c an other name, split at the hyphen: matched_name names it',
  'MED-00003(co-amoxiclav) more=false', pg_temp.medicines('co-amox', 10));
select pg_temp.expect('2d a brand name', 'MED-00004(Panadol) more=false', pg_temp.medicines('panad', 10));
select pg_temp.expect('2e two words must both start words of one name', 'MED-00003 more=false',
  pg_temp.medicines('amox clav', 10));
select pg_temp.expect('2f a word inside a name does not match (prefixes only)', ' more=false',
  pg_temp.medicines('cillin', 10));
select pg_temp.expect('2g the dose form filter', 'MED-00002 more=false', pg_temp.medicines('amox', 10, 'liquid'));
select pg_temp.expect('2h the route filter (letter case ignored)', 'MED-00005 more=false',
  pg_temp.medicines('cef', 10, null, 'Intravenous'));
select pg_temp.expect('2i limit and more', 'MED-00002 more=true', pg_temp.medicines('amox', 1));
select pg_temp.expect('2j a withdrawn row is never offered', ' more=false', pg_temp.medicines('prussian', 10));
select pg_temp.expect('2k an inactive version is never offered (MED-00099)', 'MED-00002 MED-00001 MED-00003 more=false',
  pg_temp.medicines('amoxicillin', 10));
select pg_temp.expect('2l the answer carries the list version and the item''s fields',
  '2026.1 amoxicillin 500 mg capsule Capsule {oral} J01CA04 nigeria-eml-8',
  (select format('%s %s %s %s %s %s %s %s', list_version, generic_name, strength, dose_form, dose_form_text, routes,
     atc_code, source) from ehr.search_catalog_medicines('amox', 10, 'capsule', null)));
select pg_temp.expect('2m lab tests: an abbreviation, its other names as a list',
  'LAB-0001(FBC) {FBC,CBC,"Complete blood count"} LOINC 57021-8',
  (select format('%s(%s) %s %s %s', list_id, matched_name, other_names, code_system, code)
     from ehr.search_catalog_lab_tests('fbc', 5)));
select pg_temp.expect('2n lab tests: E/U/Cr (punctuation splits words in q and in the names alike)',
  'LAB-0002 more=false',
  pg_temp.tests('E/U/Cr', 5));
select pg_temp.expect('2o lab tests: an HID-LAB code', 'LAB-0003 HID-LAB MP-SMEAR',
  (select format('%s %s %s', list_id, code_system, code) from ehr.search_catalog_lab_tests('malaria', 5)));
select pg_temp.expect('2p the status counts what is offered (the withdrawn row left out)',
  'lab_test t 2026.1 8, medicine t 2026.1 6',
  (select string_agg(format('%s %s %s %s', kind, available, list_version, offered), ', ' order by kind)
     from ehr.catalog_status() where kind in ('lab_test', 'medicine')));
select pg_temp.expect('2q a second active version of a kind is refused', '23505',
  left(pg_temp.refusal($q$update ehr.catalog_versions set active = true
                          where id = 'c1490000-0000-4000-8000-000000000003'$q$), 5));
-- Each name found as typed: the index and the per-name checks split the names as the search splits q.
select pg_temp.expect('2r MTB/RIF: the name, the code part and an other name, as typed',
  'LAB-0004 more=false|LAB-0004 more=false|LAB-0004(Xpert MTB/RIF Ultra) more=false',
  pg_temp.tests('GeneXpert MTB/RIF', 5) || '|' || pg_temp.tests('MTB/RIF', 5) || '|'
  || pg_temp.tests('Xpert MTB/RIF Ultra', 5));
select pg_temp.expect('2s HIV 1/2, as typed', 'LAB-0005 more=false|LAB-0005 more=false',
  pg_temp.tests('HIV 1/2 screening', 5) || '|' || pg_temp.tests('HIV 1/2', 5));
select pg_temp.expect('2t COVID-19, as typed', 'LAB-0006 more=false|LAB-0006 more=false',
  pg_temp.tests('COVID-19 PCR', 5) || '|' || pg_temp.tests('COVID-19', 5));
select pg_temp.expect('2u U/A returns Urinalysis first (its other name starts with q), then a name with u and a words',
  'LAB-0007(U/A) LAB-0002 more=false', pg_temp.tests('U/A', 5));
select pg_temp.expect('2v G&XM, an other name, as typed', 'LAB-0008(G&XM) more=false', pg_temp.tests('G&XM', 5));

-- 3. Refusals.
select pg_temp.expect('3a q of 1 character', '22023 CATALOG_SEARCH_INVALID',
  pg_temp.refusal($q$select * from ehr.search_catalog_medicines('a', 10, null, null)$q$));
select pg_temp.expect('3b q of 101 characters', '22023 CATALOG_SEARCH_INVALID',
  pg_temp.refusal(format('select * from ehr.search_catalog_lab_tests(%L, 10)', repeat('a', 101))));
select pg_temp.expect('3c limit 0 and limit 26', '22023 CATALOG_SEARCH_INVALID|22023 CATALOG_SEARCH_INVALID',
  pg_temp.refusal($q$select * from ehr.search_catalog_medicines('amox', 0, null, null)$q$) || '|'
  || pg_temp.refusal($q$select * from ehr.search_catalog_lab_tests('fbc', 26)$q$));
select pg_temp.expect('3d an unknown dose form', '22023 CATALOG_SEARCH_INVALID',
  pg_temp.refusal($q$select * from ehr.search_catalog_medicines('amox', 10, 'pessary', null)$q$));
select pg_temp.expect('3e q of punctuation only answers nothing', ' more=false', pg_temp.medicines('--', 10));
-- Into the versions still loading (a live version refuses any row first: 5b).
select pg_temp.expect('3f a list id, a lab code system and an ATC code outside their forms', '23514 23514 23514',
  left(pg_temp.refusal($q$insert into ehr.catalog_medicines (version_id, list_id, generic_name, dose_form, source)
        values ('c1490000-0000-4000-8000-000000000004', 'MED-1', 'x', 'tablet', 'nigeria-eml-8')$q$), 5) || ' '
  || left(pg_temp.refusal($q$insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display, category,
        source) values ('c1490000-0000-4000-8000-000000000005', 'LAB-0009', 'SNOMED', '1', 'x', 'other', 'x')$q$), 5)
  || ' ' || left(pg_temp.refusal($q$insert into ehr.catalog_medicines (version_id, list_id, generic_name, dose_form,
        atc_code, source) values ('c1490000-0000-4000-8000-000000000004', 'MED-00010', 'x', 'tablet', 'J01', 'x')$q$), 5));

select pg_temp.expect('3g q never reaches to_tsquery as typed: brackets, :* and operators answer nothing',
  'none none none none',
  (select string_agg(pg_temp.refusal(format('select pg_temp.medicines(%L, 10)', typed)), ' ' order by typed)
     from unnest(array['((', ':*', '&|!', 'a:* & (']) as typed));
select pg_temp.expect('3h ... and answer no row', ' more=false| more=false| more=false',
  pg_temp.medicines('((', 10) || '|' || pg_temp.medicines(':*', 10) || '|' || pg_temp.tests('&|!', 10));
select pg_temp.expect('3i two words that are one name''s parts do not match (no misspellings)', ' more=false',
  pg_temp.medicines('para cetamol', 10));
select pg_temp.expect('3j a 100-character word is cut to 40 and matches nothing, without an error', ' more=false',
  pg_temp.medicines(repeat('amoxicillin', 9) || 'a', 10));
select pg_temp.expect('3k only the first 6 words count', 'MED-00002 MED-00001 MED-00003 more=false',
  pg_temp.medicines('amox amox amox amox amox amox zzzz', 10));
select pg_temp.expect('3l LIKE''s %, _ and \ in q are plain characters', 'MED-00002 MED-00001 MED-00003 more=false|'
  || 'MED-00002 MED-00001 MED-00003 more=false|MED-00004 more=false',
  pg_temp.medicines('amox%', 10) || '|' || pg_temp.medicines('_amox', 10) || '|' || pg_temp.medicines('\para', 10));
select pg_temp.expect('3m a route that is not a plain word', '22023 CATALOG_SEARCH_INVALID',
  pg_temp.refusal($q$select * from ehr.search_catalog_medicines('amox', 10, null, 'oral%')$q$));
select pg_temp.expect('3n a loaded row never changes: UPDATE, DELETE and TRUNCATE refused',
  '55000 55000 55000 55000 55000 55000',
  left(pg_temp.refusal($q$update ehr.catalog_medicines set withdrawn = true where list_id = 'MED-00001'$q$), 5) || ' '
  || left(pg_temp.refusal($q$delete from ehr.catalog_medicines where list_id = 'MED-00001'$q$), 5) || ' '
  || left(pg_temp.refusal('truncate ehr.catalog_medicines'), 5) || ' '
  || left(pg_temp.refusal($q$update ehr.catalog_lab_tests set display = 'x' where list_id = 'LAB-0001'$q$), 5) || ' '
  || left(pg_temp.refusal($q$delete from ehr.catalog_lab_tests where list_id = 'LAB-0001'$q$), 5) || ' '
  || left(pg_temp.refusal('truncate ehr.catalog_lab_tests'), 5));
-- TRUNCATE of the versions is refused by the lists' foreign keys first (0A000), the trigger behind them.
select pg_temp.expect('3o a version is never deleted and only its switch changes',
  '55000 ehr.catalog_versions rows are never deleted|'
  || '55000 ehr.catalog_versions: only active, loaded_at and sealed may change|'
  || '55000 ehr.catalog_versions: only active, loaded_at and sealed may change|0A000',
  pg_temp.refusal($q$delete from ehr.catalog_versions where id = 'c1490000-0000-4000-8000-000000000003'$q$) || '|'
  || pg_temp.refusal($q$update ehr.catalog_versions set version = '2025.10' where id = 'c1490000-0000-4000-8000-000000000003'$q$)
  || '|' || pg_temp.refusal($q$update ehr.catalog_versions set file_sha256 = repeat('d', 64)
                                where id = 'c1490000-0000-4000-8000-000000000003'$q$)
  || '|' || left(pg_temp.refusal('truncate ehr.catalog_versions'), 5));
-- The loader's switch is two statements in one transaction: the old version off, then the new one on (one
-- statement turning both would meet the one-active index row by row); other sessions see either list.
select pg_temp.expect('3p the loader''s switch: the old version off, then the new one on',
  'none none MED-00099 more=false',
  pg_temp.refusal($q$update ehr.catalog_versions set active = false where kind = 'medicine' and active$q$)
  || ' ' || pg_temp.refusal($q$update ehr.catalog_versions set active = true, loaded_at = clock_timestamp()
                                where id = 'c1490000-0000-4000-8000-000000000003'$q$)
  || ' ' || pg_temp.medicines('amoxicillin', 10));
update ehr.catalog_versions set active = false where kind = 'medicine' and active;
update ehr.catalog_versions set active = true where id = 'c1490000-0000-4000-8000-000000000001';
select pg_temp.expect('3q the status names the seed file of each active version',
  'lab_test ' || repeat('b', 64) || ', medicine ' || repeat('a', 64),
  (select string_agg(format('%s %s', kind, file_sha256), ', ' order by kind) from ehr.catalog_status() where kind in ('lab_test', 'medicine')));

-- Fixed ids (3b): a retired id, a changed id and a reused lab code are refused; an unchanged id in a new version loads.
insert into ehr.catalog_retired_codes (kind, list_id, reason) values
  ('medicine', 'MED-01375', 'Synthetic: the same medicine is listed under another name');
select pg_temp.expect('3r a retired id never loads again',
  '55000 CATALOG_ID_RETIRED: MED-01375',
  pg_temp.refusal($q$insert into ehr.catalog_medicines (version_id, list_id, generic_name, dose_form, source)
    values ('c1490000-0000-4000-8000-000000000004', 'MED-01375', 'prussian blue', 'capsule', 'who-eml-24')$q$));
select pg_temp.expect('3s an id keeps its medicine and its test: another strength, another code or another name is refused',
  '55000 CATALOG_ID_CHANGED: MED-00001|55000 CATALOG_ID_CHANGED: LAB-0001|55000 CATALOG_ID_CHANGED: LAB-0001',
  pg_temp.refusal($q$insert into ehr.catalog_medicines (version_id, list_id, generic_name, strength, dose_form, source)
    values ('c1490000-0000-4000-8000-000000000004', 'MED-00001', 'amoxicillin', '250 mg', 'capsule', 'nigeria-eml-8')$q$)
  || '|' || pg_temp.refusal($q$insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display, category,
    source) values ('c1490000-0000-4000-8000-000000000005', 'LAB-0001', 'LOINC', '58410-2', 'Full blood count',
    'haematology', 'hid-common-tests')$q$)
  || '|' || pg_temp.refusal($q$insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display, category,
    source) values ('c1490000-0000-4000-8000-000000000005', 'LAB-0001', 'LOINC', '57021-8', 'Complete blood count',
    'haematology', 'hid-common-tests')$q$));
select pg_temp.expect('3t a lab code another id held is never reused', '55000 CATALOG_ID_CHANGED: LAB-0099',
  pg_temp.refusal($q$insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display, category, source)
    values ('c1490000-0000-4000-8000-000000000005', 'LAB-0099', 'HID-LAB', 'MP-SMEAR', 'Malaria smear', 'parasitology',
    'hid-common-tests')$q$));
select pg_temp.expect('3u an unchanged id loads in a new version (other names, form words and routes may change)', 'none none',
  pg_temp.refusal($q$insert into ehr.catalog_medicines (version_id, list_id, generic_name, other_names, strength, dose_form,
    dose_form_text, routes, source) values ('c1490000-0000-4000-8000-000000000004', 'MED-00001', 'amoxicillin',
    'Amoxil; Ospamox', '500 mg', 'capsule', 'Capsules', '{oral}', 'nigeria-eml-8')$q$)
  || ' ' || pg_temp.refusal($q$insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display,
    other_names, category, source) values ('c1490000-0000-4000-8000-000000000005', 'LAB-0001', 'LOINC', '57021-8',
    'Full blood count', 'FBC', 'haematology', 'hid-common-tests')$q$));
select pg_temp.expect('3v the retired ids are append-only, and a kind must fit its id', '55000 55000 23514',
  left(pg_temp.refusal($q$delete from ehr.catalog_retired_codes$q$), 5) || ' '
  || left(pg_temp.refusal($q$update ehr.catalog_retired_codes set reason = 'Synthetic other reason'$q$), 5) || ' '
  || left(pg_temp.refusal($q$insert into ehr.catalog_retired_codes (kind, list_id, reason)
       values ('lab_test', 'MED-00009', 'Synthetic wrong kind')$q$), 5));
select pg_temp.expect('3w the new categories load', 'none',
  pg_temp.refusal($q$insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display, category, source)
    values ('c1490000-0000-4000-8000-000000000005', 'LAB-0098', 'LOINC', '882-1', 'Blood group and Rh', 'blood-bank',
    'hid-common-tests')$q$));

-- 4. As the EHR runtime: the searches answer; the tables do not.
set local role hid_ehr_runtime;
select pg_temp.expect('4a the EHR runtime searches', 'MED-00004(Panadol) more=false', pg_temp.medicines('panad', 10));
select pg_temp.expect('4b the EHR runtime reads no table', '42501',
  left(pg_temp.refusal('select count(*) from ehr.catalog_medicines'), 5));
reset role;

-- 5. Sealed versions (#318 review, finding 2) and the approvals file's sha256 (#319 review, finding 2).
select pg_temp.expect('5a a version is sealed once it has gone live (2025.9 was live in 3p); one still loading is not',
  'lab_test 2026.1 t t, lab_test 2026.2 f f, medicine 2025.9 f t, medicine 2026.1 t t, medicine 2026.2 f f',
  (select string_agg(format('%s %s %s %s', kind, version, active, sealed), ', ' order by kind, version)
     from ehr.catalog_versions));
select pg_temp.expect('5b a row for the active version is refused, in both lists',
  '55000 CATALOG_VERSION_SEALED: medicine 2026.1|55000 CATALOG_VERSION_SEALED: lab_test 2026.1',
  pg_temp.refusal($q$insert into ehr.catalog_medicines (version_id, list_id, generic_name, dose_form, source)
    values ('c1490000-0000-4000-8000-000000000001', 'MED-00008', 'metronidazole', 'tablet', 'nigeria-eml-8')$q$)
  || '|' || pg_temp.refusal($q$insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display,
    category, source) values ('c1490000-0000-4000-8000-000000000002', 'LAB-0009', 'HID-LAB', 'SYN-ESR',
    'Erythrocyte sedimentation rate', 'haematology', 'hid-common-tests')$q$));
select pg_temp.expect('5c a row for a replaced version (live once, then switched off) is refused',
  '55000 CATALOG_VERSION_SEALED: medicine 2025.9',
  pg_temp.refusal($q$insert into ehr.catalog_medicines (version_id, list_id, generic_name, dose_form, source)
    values ('c1490000-0000-4000-8000-000000000003', 'MED-00008', 'metronidazole', 'tablet', 'nigeria-eml-8')$q$));
select pg_temp.expect('5d a row for a version still loading loads, in both lists', 'none none',
  pg_temp.refusal($q$insert into ehr.catalog_medicines (version_id, list_id, generic_name, dose_form, source)
    values ('c1490000-0000-4000-8000-000000000004', 'MED-00008', 'metronidazole', 'tablet', 'nigeria-eml-8')$q$)
  || ' ' || pg_temp.refusal($q$insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display,
    category, source) values ('c1490000-0000-4000-8000-000000000005', 'LAB-0009', 'HID-LAB', 'SYN-ESR',
    'Erythrocyte sedimentation rate', 'haematology', 'hid-common-tests')$q$));
select pg_temp.expect('5e a sealed version stays sealed, and a version inserted live must be sealed',
  '55000 ehr.catalog_versions: a sealed version stays sealed|23514',
  pg_temp.refusal($q$update ehr.catalog_versions set sealed = false
                      where id = 'c1490000-0000-4000-8000-000000000003'$q$)
  || '|' || left(pg_temp.refusal($q$insert into ehr.catalog_versions (id, kind, version, file_sha256,
    approval_reference, approvals_sha256, approved_at, active) values ('c1490000-0000-4000-8000-000000000006',
    'lab_test', '2026.3', repeat('a', 64), 'synthetic live sign-off', repeat('4', 64), now(), true)$q$), 5));
select pg_temp.expect('5f the approvals file''s sha256 never changes (live or loading), and is 64 hex digits',
  '55000 ehr.catalog_versions: only active, loaded_at and sealed may change|'
  || '55000 ehr.catalog_versions: only active, loaded_at and sealed may change|23514|23502',
  pg_temp.refusal($q$update ehr.catalog_versions set approvals_sha256 = repeat('9', 64)
                      where id = 'c1490000-0000-4000-8000-000000000001'$q$)
  || '|' || pg_temp.refusal($q$update ehr.catalog_versions set approvals_sha256 = repeat('9', 64)
                      where id = 'c1490000-0000-4000-8000-000000000004'$q$)
  || '|' || left(pg_temp.refusal($q$insert into ehr.catalog_versions (id, kind, version, file_sha256,
    approval_reference, approvals_sha256, approved_at) values ('c1490000-0000-4000-8000-000000000006', 'lab_test',
    '2026.3', repeat('a', 64), 'synthetic next sign-off', repeat('A', 64), now())$q$), 5)
  || '|' || left(pg_temp.refusal($q$insert into ehr.catalog_versions (id, kind, version, file_sha256,
    approval_reference, approved_at) values ('c1490000-0000-4000-8000-000000000006', 'lab_test', '2026.3',
    repeat('a', 64), 'synthetic next sign-off', now())$q$), 5));
select pg_temp.expect('5g the loader may seal a version before its switch; it then gains no row',
  'none 55000 CATALOG_VERSION_SEALED: lab_test 2026.2',
  pg_temp.refusal($q$update ehr.catalog_versions set sealed = true where id = 'c1490000-0000-4000-8000-000000000005'$q$)
  || ' ' || pg_temp.refusal($q$insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display,
    category, source) values ('c1490000-0000-4000-8000-000000000005', 'LAB-0010', 'HID-LAB', 'SYN-CRP',
    'C-reactive protein', 'chemistry', 'hid-common-tests')$q$));

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, actual), E'\n' order by seq) into failures
    from catalog_cases where expected is distinct from actual;
  if failures is not null then
    raise exception E'0149 catalogue search suite failed:\n%', failures;
  end if;
  raise notice '0149 catalogue search suite: % cases passed', (select count(*) from catalog_cases);
end $$;

rollback;
