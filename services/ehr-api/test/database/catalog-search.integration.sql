\set ON_ERROR_STOP on
-- 0149 (ORD-7, first slice): the medicine and lab-test lists and their
-- search. Rollback-only.
--   1. after 0001-0149: the lists are empty, the status says not available,
--      the searches answer nothing; the tables are the owner's only, the
--      functions are the EHR and schema test runtimes' only;
--   2. with a version loaded by hand (as the governed loader will): prefix
--      search on the generic name and other names, letter case ignored,
--      punctuation splitting words; names that start with q first, then A
--      to Z; matched_name; dose form and route filters; limit and more;
--      withdrawn rows and inactive versions never offered; one active
--      version per kind; the status counts what is offered;
--   3. refusals: q of 1 or 101 characters, limit 0 or 26, an unknown dose
--      form (22023 CATALOG_SEARCH_INVALID); q of punctuation only answers
--      nothing; ids, codes and ATC codes outside their forms are refused;
--   4. the EHR runtime may run the searches and read no table.
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
select pg_temp.expect('1b the status: neither list available', 'lab_test f 0, medicine f 0',
  (select string_agg(format('%s %s %s', kind, available, offered), ', ' order by kind) from ehr.catalog_status()));
select pg_temp.expect('1c a search before any list answers nothing', ' more=false', pg_temp.medicines('amox', 10));
select pg_temp.expect('1d no runtime holds a privilege on the tables', '0',
  (select count(*)::text from pg_class relation, lateral aclexplode(coalesce(relation.relacl,
     acldefault('r', relation.relowner))) acl
    where relation.oid in ('ehr.catalog_versions'::regclass, 'ehr.catalog_medicines'::regclass,
                           'ehr.catalog_lab_tests'::regclass)
      and acl.grantee <> relation.relowner));
select pg_temp.expect('1e the searches and the status: the EHR runtime only (of the service runtimes)',
  'true true true false false',
  has_function_privilege('hid_ehr_runtime', 'ehr.search_catalog_medicines(text,integer,text,text)', 'EXECUTE')
  || ' ' || has_function_privilege('hid_ehr_runtime', 'ehr.search_catalog_lab_tests(text,integer)', 'EXECUTE')
  || ' ' || has_function_privilege('hid_ehr_runtime', 'ehr.catalog_status()', 'EXECUTE')
  || ' ' || has_function_privilege('hid_pharmacy_runtime', 'ehr.search_catalog_medicines(text,integer,text,text)',
       'EXECUTE')
  || ' ' || has_function_privilege('hid_ehr_runtime', 'ehr.catalog_search_query(text)', 'EXECUTE'));

-- 2. A version loaded by hand, as the governed loader will.
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approved_at, active) values
  ('c1490000-0000-4000-8000-000000000001', 'medicine', '2026.1', repeat('a', 64), 'synthetic sign-off reference',
   now(), true),
  ('c1490000-0000-4000-8000-000000000002', 'lab_test', '2026.1', repeat('b', 64), 'synthetic sign-off reference',
   now(), true),
  ('c1490000-0000-4000-8000-000000000003', 'medicine', '2025.9', repeat('c', 64), 'synthetic older sign-off',
   now() - interval '30 days', false);
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
  ('c1490000-0000-4000-8000-000000000001', 'MED-00007', 'prussian blue', '', '500 mg', 'capsule', 'Capsule', '{oral}',
   null, 'who-eml-24'),
  ('c1490000-0000-4000-8000-000000000003', 'MED-00099', 'amoxicillin', '', '250 mg', 'capsule', 'Capsule', '{oral}',
   null, 'nigeria-eml-7');
update ehr.catalog_medicines set withdrawn = true where list_id = 'MED-00007';
insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display, other_names, specimen, category,
  source) values
  ('c1490000-0000-4000-8000-000000000002', 'LAB-0001', 'LOINC', '57021-8', 'Full blood count',
   'FBC; CBC; Complete blood count', 'Blood (EDTA)', 'haematology', 'hid-common-tests'),
  ('c1490000-0000-4000-8000-000000000002', 'LAB-0002', 'LOINC', '24362-6', 'Electrolytes, urea and creatinine',
   'E/U/Cr; U&E', 'Serum', 'chemistry', 'hid-common-tests'),
  ('c1490000-0000-4000-8000-000000000002', 'LAB-0003', 'HID-LAB', 'MP-SMEAR', 'Malaria parasite (blood film)',
   'MP; blood film for malaria', 'Blood (EDTA)', 'parasitology', 'hid-common-tests');

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
select pg_temp.expect('2n lab tests: E/U/Cr (punctuation splits words; each starts a word of the name itself)',
  'LAB-0002 more=false',
  pg_temp.tests('E/U/Cr', 5));
select pg_temp.expect('2o lab tests: an HID-LAB code', 'LAB-0003 HID-LAB MP-SMEAR',
  (select format('%s %s %s', list_id, code_system, code) from ehr.search_catalog_lab_tests('malaria', 5)));
select pg_temp.expect('2p the status counts what is offered (the withdrawn row left out)',
  'lab_test t 2026.1 3, medicine t 2026.1 6',
  (select string_agg(format('%s %s %s %s', kind, available, list_version, offered), ', ' order by kind)
     from ehr.catalog_status()));
select pg_temp.expect('2q a second active version of a kind is refused', '23505',
  left(pg_temp.refusal($q$update ehr.catalog_versions set active = true
                          where id = 'c1490000-0000-4000-8000-000000000003'$q$), 5));

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
select pg_temp.expect('3f a list id, a lab code system and an ATC code outside their forms', '23514 23514 23514',
  left(pg_temp.refusal($q$insert into ehr.catalog_medicines (version_id, list_id, generic_name, dose_form, source)
        values ('c1490000-0000-4000-8000-000000000001', 'MED-1', 'x', 'tablet', 'nigeria-eml-8')$q$), 5) || ' '
  || left(pg_temp.refusal($q$insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display, category,
        source) values ('c1490000-0000-4000-8000-000000000002', 'LAB-0009', 'SNOMED', '1', 'x', 'other', 'x')$q$), 5)
  || ' ' || left(pg_temp.refusal($q$insert into ehr.catalog_medicines (version_id, list_id, generic_name, dose_form,
        atc_code, source) values ('c1490000-0000-4000-8000-000000000001', 'MED-00010', 'x', 'tablet', 'J01', 'x')$q$), 5));

-- 4. As the EHR runtime: the searches answer; the tables do not.
set local role hid_ehr_runtime;
select pg_temp.expect('4a the EHR runtime searches', 'MED-00004(Panadol) more=false', pg_temp.medicines('panad', 10));
select pg_temp.expect('4b the EHR runtime reads no table', '42501',
  left(pg_temp.refusal('select count(*) from ehr.catalog_medicines'), 5));
reset role;

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
