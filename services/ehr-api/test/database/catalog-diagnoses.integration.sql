\set ON_ERROR_STOP on
-- 0150 (ORD-9, first slice): the ICD-11 diagnosis list and its search.
-- Rollback-only.
--   1. after 0001-0150: the list is empty, the status answers for three
--      lists, the versions take the kind 'diagnosis'; the table is the
--      owner's only, the search the EHR and schema test runtimes' only;
--   2. with a release loaded by hand as the governed loader loads it (the
--      release still loading, with the approvals file's sha256, its
--      entries, then the switch, which seals it): a word of the title, our
--      other name (named when it starts q and the title does not), the
--      code, two words; entries starting with q first, then shorter
--      titles; limit and more; an inactive release never offered; a code
--      typed exactly first, though its child codes have shorter titles,
--      with or without its dot (Rahman, #320 finding 3), and copied with
--      punctuation around it: NB91., NB91,, (NB91), 9A03. (Ola, round 2),
--      and any run of it at either end: (NB91)., NB91 ., .NB91, NB91,.,
--      (9A03.0)., (1A36.1). (Ola, round 3), while a word with the same
--      punctuation is searched as before; titles and our other names
--      split as q is: COVID-19, T-cell/histiocyte, glucose-6-phosphate and
--      HIV/TB, as typed (Rahman, #318 finding 1); a name typed with an
--      apostrophe-s (straight or curly) finds the entry named, and when
--      nothing matched a final s is dropped from words of 4 or more
--      letters, while "X syndrome" eponyms answer as before (Rahman's
--      re-review of #320, finding 1); a word so shortened must then be a
--      whole word of the entry ("fits" offers no "Fitting ..." entry); a
--      title or other name that is q comes right after the code ("ra",
--      "urti", "prom"; nit 4); a code typed with spaces at its dot is that
--      code, and a word with a space is searched as before (nit 5); our
--      plain-letter other names for accented titles (nit 9g); a title with
--      its own apostrophe-s is compared with q as q is, its 's dropped too;
--   3. refusals: q of 1 or 101 characters, limit 0 or 26 (22023
--      CATALOG_SEARCH_INVALID); brackets and operators answer nothing; an
--      extension code, a bad chapter and a second active release are
--      refused; a loaded entry never changes; a row for the live release,
--      or for one replaced after it was live, is refused, and a release
--      still loading takes rows (Rahman, #318 finding 2); a diagnosis row
--      for a medicine list's version is refused (nit 7);
--   4. the EHR runtime may search and read no table.
-- Synthetic version ids: prefix c150. The codes and titles are ICD-11's
-- (WHO, CC BY-ND 3.0 IGO), verbatim; the other names are ours.
set plpgsql.variable_conflict = error;
begin;

create temporary table diagnosis_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;
grant select, insert on diagnosis_cases to public;
grant usage on sequence diagnosis_cases_seq_seq to public;
create function pg_temp.expect(case_name text, expected text, actual text) returns void language sql as $$
  insert into diagnosis_cases (name, expected, actual) values (case_name, expected, coalesce(actual, 'null'));
$$;
grant execute on function pg_temp.expect(text, text, text) to public;
create function pg_temp.refusal(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'none';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end;
$$;
grant execute on function pg_temp.refusal(text) to public;
create function pg_temp.found(q text, lim integer) returns text language sql as $$
  select coalesce(string_agg(hit.code || coalesce('(' || hit.matched_name || ')', ''), ' ' order by ordinality), '')
         || ' more=' || coalesce(bool_or(hit.more)::text, 'false')
    from ehr.search_catalog_diagnoses(q, lim) with ordinality as hit;
$$;
grant execute on function pg_temp.found(text, integer) to public;

-- 1. After 0001-0150.
select pg_temp.expect('1a the list is empty; the status answers for three lists', '0|diagnosis f, lab_test f, medicine f',
  (select count(*) from ehr.catalog_diagnoses) || '|'
  || (select string_agg(format('%s %s', kind, available), ', ' order by kind) from ehr.catalog_status()));
select pg_temp.expect('1b a search before any release answers nothing', ' more=false', pg_temp.found('malaria', 10));
select pg_temp.expect('1c the table is the owner''s only; the search the EHR runtime''s, not the pharmacy runtime''s',
  '0 true false',
  (select count(*)::text from pg_class relation, lateral aclexplode(coalesce(relation.relacl,
     acldefault('r', relation.relowner))) acl
    where relation.oid = 'ehr.catalog_diagnoses'::regclass and acl.grantee <> relation.relowner)
  || ' ' || has_function_privilege('hid_ehr_runtime', 'ehr.search_catalog_diagnoses(text,integer)', 'EXECUTE')
  || ' ' || has_function_privilege('hid_pharmacy_runtime', 'ehr.search_catalog_diagnoses(text,integer)', 'EXECUTE'));

-- 2. A release loaded by hand, as the governed loader loads it: the releases (still loading), their entries, then
-- the switch, which seals the live one (0149's guard; 0150's insert trigger then refuses it any row).
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approvals_sha256, approved_at)
  values
  ('c1500000-0000-4000-8000-000000000001', 'diagnosis', '2026-01', repeat('d', 64), 'synthetic sign-off reference',
   repeat('1', 64), now()),
  ('c1500000-0000-4000-8000-000000000002', 'diagnosis', '2025-01', repeat('e', 64), 'synthetic older sign-off',
   repeat('2', 64), now() - interval '300 days');
insert into ehr.catalog_diagnoses (version_id, code, title, other_names, chapter, residual) values
  ('c1500000-0000-4000-8000-000000000001', '1F40', 'Malaria due to Plasmodium falciparum', 'falciparum malaria', '01', false),
  ('c1500000-0000-4000-8000-000000000001', '1F40.Z', 'Malaria due to Plasmodium falciparum, unspecified', '', '01', true),
  ('c1500000-0000-4000-8000-000000000001', '1F4Z', 'Malaria, unspecified', '', '01', true),
  ('c1500000-0000-4000-8000-000000000001', 'KA64.20', 'Congenital falciparum malaria', '', '19', false),
  ('c1500000-0000-4000-8000-000000000001', '1A07', 'Typhoid fever', 'enteric fever; typhoid', '01', false),
  ('c1500000-0000-4000-8000-000000000001', '5A11', 'Type 2 diabetes mellitus', 'dm2; t2dm; type 2 dm', '05', false),
  ('c1500000-0000-4000-8000-000000000001', 'BA00', 'Essential hypertension', '', '11', false),
  ('c1500000-0000-4000-8000-000000000002', '1F41', 'Malaria due to Plasmodium vivax', '', '01', false);
-- Parents whose child codes have shorter titles (the real release's order put 9A03 last of its family).
insert into ehr.catalog_diagnoses (version_id, code, title, chapter) values
  ('c1500000-0000-4000-8000-000000000001', '9A03', 'Acquired malposition of eyelid', '09'),
  ('c1500000-0000-4000-8000-000000000001', '9A03.0', 'Blepharoptosis', '09'),
  ('c1500000-0000-4000-8000-000000000001', '9A03.3', 'Eyelid retraction', '09'),
  ('c1500000-0000-4000-8000-000000000001', '9A03.4', 'Lagophthalmos', '09'),
  ('c1500000-0000-4000-8000-000000000001', '1A36', 'Amoebiasis', '01'),
  ('c1500000-0000-4000-8000-000000000001', '1A36.1', 'Extraintestinal infections due to Entamoeba', '01'),
  ('c1500000-0000-4000-8000-000000000001', '1A36.10', 'Amoebic liver abscess', '01'),
  ('c1500000-0000-4000-8000-000000000001', '1A36.11', 'Amoebic lung abscess', '01'),
  ('c1500000-0000-4000-8000-000000000001', 'NB91', 'Injury of intra-abdominal organs', '22'),
  ('c1500000-0000-4000-8000-000000000001', 'NB91.0', 'Injury of spleen', '22'),
  ('c1500000-0000-4000-8000-000000000001', 'NB91.1', 'Injury of liver', '22'),
  ('c1500000-0000-4000-8000-000000000001', 'NB91.8', 'Injury of colon', '22');
-- Titles the default parser split differently from q (Rahman, #318 finding 1), and one of our other names with a
-- slash.
insert into ehr.catalog_diagnoses (version_id, code, title, other_names, chapter) values
  ('c1500000-0000-4000-8000-000000000001', 'RA01', 'COVID-19', '', '25'),
  ('c1500000-0000-4000-8000-000000000001', 'RA01.0', 'COVID-19, virus identified', '', '25'),
  ('c1500000-0000-4000-8000-000000000001', 'RA02', 'Post COVID-19 condition', '', '25'),
  ('c1500000-0000-4000-8000-000000000001', '2A81.4', 'T-cell/histiocyte rich large B-cell lymphoma', '', '02'),
  ('c1500000-0000-4000-8000-000000000001', '3A10.00',
   'Haemolytic anaemia due to glucose-6-phosphate dehydrogenase deficiency', '', '03'),
  ('c1500000-0000-4000-8000-000000000001', '1C60', 'Human immunodeficiency virus disease associated with tuberculosis',
   'HIV/TB', '01');
-- Names typed with an apostrophe-s (Rahman's re-review of #320, finding 1): WHO's eponyms have none ("Parkinson
-- disease"), and before, the lone s of "parkinson's" had to start another word of the title.
insert into ehr.catalog_diagnoses (version_id, code, title, chapter, residual) values
  ('c1500000-0000-4000-8000-000000000001', '8A00', 'Parkinsonism', '08', false),
  ('c1500000-0000-4000-8000-000000000001', '8A00.0', 'Parkinson disease', '08', false),
  ('c1500000-0000-4000-8000-000000000001', '8A00.00', 'Sporadic Parkinson disease', '08', false),
  ('c1500000-0000-4000-8000-000000000001', '8A00.0Y', 'Other specified Parkinson disease', '08', true),
  ('c1500000-0000-4000-8000-000000000001', '2B30', 'Hodgkin lymphoma', '02', false),
  ('c1500000-0000-4000-8000-000000000001', '2B30.10', 'Nodular sclerosis classical Hodgkin lymphoma', '02', false),
  ('c1500000-0000-4000-8000-000000000001', 'DD70.3', 'Crohn disease of large intestine', '13', false),
  ('c1500000-0000-4000-8000-000000000001', 'DD70.5', 'Crohn disease of both small and large intestine', '13', false),
  ('c1500000-0000-4000-8000-000000000001', '8A20', 'Alzheimer disease', '08', false),
  ('c1500000-0000-4000-8000-000000000001', '8B88.0', 'Bell palsy', '08', false),
  ('c1500000-0000-4000-8000-000000000001', '8A01.10', 'Huntington disease', '08', false),
  ('c1500000-0000-4000-8000-000000000001', '5C64.00', 'Wilson disease', '05', false),
  ('c1500000-0000-4000-8000-000000000001', '5A70', 'Cushing syndrome', '05', false),
  ('c1500000-0000-4000-8000-000000000001', '5A70.Z', 'Cushing syndrome, unspecified', '05', true),
  -- Words whose final s the second attempt drops: fit and sweat start these words, and are whole words of only one.
  ('c1500000-0000-4000-8000-000000000001', 'QB31.4', 'Fitting or adjustment of hearing aid', '24', false),
  ('c1500000-0000-4000-8000-000000000001', 'ED92.1', 'Apocrine sweat disorders', '14', false),
  ('c1500000-0000-4000-8000-000000000001', 'ME66.5', 'Complaint of abnormal sweating', '21', false),
  -- WHO's own titles with an apostrophe-s.
  ('c1500000-0000-4000-8000-000000000001', 'QC10', 'Procedure not carried out because of contraindication', '24', false),
  ('c1500000-0000-4000-8000-000000000001', 'QC11',
   'Procedure not carried out because of patient''s decision for reasons of belief or group pressure', '24', false),
  ('c1500000-0000-4000-8000-000000000001', 'QC12',
   'Procedure not carried out because of patient''s decision for reasons other than belief or group pressure', '24',
   false);
-- Abbreviations that are our other names, behind shorter titles that start with them (nit 4), and a parent with
-- shorter child titles typed with spaces at its dot (nit 5).
insert into ehr.catalog_diagnoses (version_id, code, title, other_names, chapter) values
  ('c1500000-0000-4000-8000-000000000001', 'FA20', 'Rheumatoid arthritis', 'ra', '15'),
  ('c1500000-0000-4000-8000-000000000001', 'ME66.6', 'Rash', '', '21'),
  ('c1500000-0000-4000-8000-000000000001', 'MD32', 'Rales', '', '21'),
  ('c1500000-0000-4000-8000-000000000001', '1C82', 'Rabies', '', '01'),
  ('c1500000-0000-4000-8000-000000000001', '8B93', 'Radiculopathy', '', '08'),
  ('c1500000-0000-4000-8000-000000000001', 'CA07.0', 'Acute upper respiratory infection, site unspecified', 'urti', '12'),
  ('c1500000-0000-4000-8000-000000000001', 'EB00.0', 'Acute urticaria', '', '14'),
  ('c1500000-0000-4000-8000-000000000001', 'EB05', 'Urticaria of unspecified type', '', '14'),
  ('c1500000-0000-4000-8000-000000000001', 'JA89', 'Maternal care related to premature rupture of membranes', 'prom', '18'),
  ('c1500000-0000-4000-8000-000000000001', 'MC88', 'Prominent veins', '', '21'),
  ('c1500000-0000-4000-8000-000000000001', '5C50', 'Inborn errors of amino acid or other organic acid metabolism', '', '05'),
  ('c1500000-0000-4000-8000-000000000001', '5C50.0', 'Phenylketonuria', '', '05'),
  ('c1500000-0000-4000-8000-000000000001', '5C50.10', 'Alkaptonuria', '', '05'),
  ('c1500000-0000-4000-8000-000000000001', '5C50.5', 'Disorders of the gamma-glutamyl cycle', '', '05'),
  ('c1500000-0000-4000-8000-000000000001', '5C50.E', 'Organic aciduria', '', '05'),
  -- Accented titles with our plain-letter other names, as the seed now gives them (nit 9g).
  ('c1500000-0000-4000-8000-000000000001', '4A43.2', 'Sjögren syndrome', 'Sjogren syndrome', '04'),
  ('c1500000-0000-4000-8000-000000000001', '2B02', 'Sézary syndrome', 'Sezary syndrome', '02'),
  ('c1500000-0000-4000-8000-000000000001', '4A62', 'Behçet disease', 'Behcet disease', '04'),
  ('c1500000-0000-4000-8000-000000000001', '8A45.43', 'Demyelination due to Behcet disease', '', '08');
-- The switch: 2026-01 goes live and is sealed; 2025-01 stays loading (never live).
update ehr.catalog_versions set active = true where id = 'c1500000-0000-4000-8000-000000000001';

select pg_temp.expect('2a a word of the title: our other name starting q ranks 1F40 first and is named, then shorter titles',
  '1F40(falciparum malaria) KA64.20 1F40.Z more=false', pg_temp.found('falciparum', 10));
select pg_temp.expect('2b a title starting with q first, then shorter titles; an inactive release never offered',
  '1F4Z 1F40 1F40.Z KA64.20 more=false', pg_temp.found('malaria', 10));
select pg_temp.expect('2c our other name only', '5A11(t2dm) more=false', pg_temp.found('t2dm', 10));
select pg_temp.expect('2d a title that starts with q is not named by another name', '1A07 more=false',
  pg_temp.found('typhoid', 10));
select pg_temp.expect('2e an other name that matched where the title did not', '1A07(enteric fever) more=false',
  pg_temp.found('enteric', 10));
select pg_temp.expect('2f the code, and a code''s parts', '1F40 1F40.Z more=false|1F40.Z more=false',
  pg_temp.found('1F40', 10) || '|' || pg_temp.found('1f40.z', 10));
select pg_temp.expect('2g two words', '5A11 more=false', pg_temp.found('diabetes type 2', 10));
select pg_temp.expect('2h limit and more', '1F4Z more=true', pg_temp.found('malaria', 1));
select pg_temp.expect('2i the answer carries the release', '2026-01 Malaria due to Plasmodium falciparum',
  (select format('%s %s', list_version, title) from ehr.search_catalog_diagnoses('1F40', 1)));
select pg_temp.expect('2j the status counts what is offered, and the live release is sealed',
  'diagnosis t 2026-01 64 sealed=true|2025-01 sealed=false',
  (select format('%s %s %s %s', kind, available, list_version, offered) from ehr.catalog_status() where kind = 'diagnosis')
  || ' sealed=' || (select sealed::text from ehr.catalog_versions where id = 'c1500000-0000-4000-8000-000000000001')
  || '|' || (select version || ' sealed=' || sealed from ehr.catalog_versions
              where id = 'c1500000-0000-4000-8000-000000000002'));
select pg_temp.expect('2k a code typed exactly comes first, then shorter titles; in any case and at limit 1',
  '9A03 9A03.4 9A03.0 9A03.3 more=false|9A03 9A03.4 9A03.0 9A03.3 more=false|9A03 more=true',
  pg_temp.found('9A03', 10) || '|' || pg_temp.found(' 9a03 ', 10) || '|' || pg_temp.found('9A03', 1));
select pg_temp.expect('2l a code with its dot comes first; without its dot it is found, first',
  '1A36.1 1A36 1A36.11 1A36.10 more=false|1A36.1 more=false|9A03.0 more=false',
  pg_temp.found('1A36.1', 10) || '|' || pg_temp.found('1a361', 10) || '|' || pg_temp.found('9A030', 10));
select pg_temp.expect('2m a word of five letters is not taken for a code', '1A07 more=false', pg_temp.found('typho', 10));
-- A parent code copied with punctuation around it (Ola, round 2): the punctuation comes off both ends before the
-- code's shape is tested. Before, NB91 came last of its family (its title is the longest) and 9A03 after its
-- children.
select pg_temp.expect('2q a parent code copied with a full stop, a comma, brackets or spaces comes first',
  'NB91 NB91.8 NB91.1 NB91.0 more=false|NB91 NB91.8 NB91.1 NB91.0 more=false|NB91 NB91.8 NB91.1 NB91.0 more=false|'
  || '9A03 9A03.4 9A03.0 9A03.3 more=false|9A03 9A03.4 9A03.0 9A03.3 more=false',
  pg_temp.found('NB91.', 10) || '|' || pg_temp.found('NB91,', 10) || '|' || pg_temp.found('(NB91)', 10) || '|'
  || pg_temp.found('9A03.', 10) || '|' || pg_temp.found(' 9A03 ', 10));
select pg_temp.expect('2r a word with the same punctuation is searched as a word, as before, never as a code',
  '1A07 more=false|1A07 more=false|1F4Z KA64.20 1F40 1F40.Z more=false|1F4Z 1F40 1F40.Z KA64.20 more=false',
  pg_temp.found('typho.', 10) || '|' || pg_temp.found('(typho)', 10) || '|' || pg_temp.found('malaria.', 10) || '|'
  || pg_temp.found('malaria', 10));
-- Any run of characters that are neither letters nor digits comes off both ends (Ola, round 3): a full stop after a
-- bracket or a space, a full stop before the code, a comma and a full stop. The code's own dot stays: 1A36.1 comes
-- before its parent 1A36 and its children (before, it came last of them); 9A03.0 is the only entry its words find.
select pg_temp.expect('2s a code with any run of punctuation at either end comes first; the code''s own dot stays',
  'NB91 NB91.8 NB91.1 NB91.0 more=false|NB91 NB91.8 NB91.1 NB91.0 more=false|NB91 NB91.8 NB91.1 NB91.0 more=false|'
  || 'NB91 NB91.8 NB91.1 NB91.0 more=false|9A03.0 more=false|1A36.1 1A36 1A36.11 1A36.10 more=false',
  pg_temp.found('(NB91).', 10) || '|' || pg_temp.found('NB91 .', 10) || '|' || pg_temp.found('.NB91', 10) || '|'
  || pg_temp.found('NB91,.', 10) || '|' || pg_temp.found('(9A03.0).', 10) || '|' || pg_temp.found('(1A36.1).', 10));
select pg_temp.expect('2n COVID-19 as typed: the titles starting with it first; with a space it is found too',
  'RA01 RA01.0 RA02 more=false|RA01 RA02 RA01.0 more=false',
  pg_temp.found('COVID-19', 10) || '|' || pg_temp.found('covid 19', 10));
select pg_temp.expect('2o a title with a slash and with hyphens, as typed',
  '2A81.4 more=false|3A10.00 more=false',
  pg_temp.found('T-cell/histiocyte', 10) || '|' || pg_temp.found('glucose-6-phosphate', 10));
select pg_temp.expect('2p our other name with a slash, as typed, is found and named', '1C60(HIV/TB) more=false',
  pg_temp.found('HIV/TB', 10));
-- Rahman's re-review of #320, finding 1. Before: 8A00.0 was missing ("s" had to start a word: sporadic, specified),
-- DD70.3 too (small), Hodgkin lymphoma's own entry too (sclerosis), and the rest found nothing.
select pg_temp.expect('2t a name typed with an apostrophe-s finds the entry named, first',
  '8A00.0 8A00.00 8A00.0Y more=false|8A00.0 8A00.00 8A00.0Y more=false|2B30 2B30.10 more=false|'
  || 'DD70.3 DD70.5 more=false|8A20 more=false|8B88.0 more=false|8A01.10 more=false|5C64.00 more=false|'
  || '8A20 more=false|8B88.0 more=false',
  pg_temp.found('Parkinson''s disease', 10) || '|' || pg_temp.found('parkinson’s disease', 10) || '|'
  || pg_temp.found('hodgkin''s lymphoma', 10) || '|' || pg_temp.found('Crohn''s disease of large intestine', 10) || '|'
  || pg_temp.found('alzheimer''s disease', 10) || '|' || pg_temp.found('bell''s palsy', 10) || '|'
  || pg_temp.found('huntington''s disease', 10) || '|' || pg_temp.found('wilson''s disease', 10) || '|'
  || pg_temp.found('ALZHEIMER’S DISEASE', 10) || '|' || pg_temp.found('Bell’S palsy', 10));
select pg_temp.expect('2u nothing matched: once more with a final s dropped from words of 4 or more letters',
  '8A00.0 8A00.00 8A00.0Y more=false|8A20 more=false|8A20 more=false',
  pg_temp.found('parkinsons', 10) || '|' || pg_temp.found('alzheimers', 10) || '|'
  || pg_temp.found('alzheimers disease', 10));
-- A word so shortened must be a whole word of the title or of one of our other names, not only the start of one.
-- Before, "fits" offered QB31.4 (fit starts Fitting), "sweats" ME66.5 too (sweating), and "parkinsons" 8A00
-- Parkinsonism first (2u). A word typed as the start of another is searched as before.
select pg_temp.expect('2ua the second attempt keeps only entries where each shortened word is a whole word',
  ' more=false|ED92.1 more=false|QB31.4 more=false|ED92.1 ME66.5 more=false',
  pg_temp.found('fits', 10) || '|' || pg_temp.found('sweats', 10) || '|' || pg_temp.found('fit', 10) || '|'
  || pg_temp.found('sweat', 10));
-- A title with its own apostrophe-s is compared as q is, its 's dropped too: typed as written it is still q, and q
-- cut at 100 characters (the first 6 words match all three) still starts it.
select pg_temp.expect('2z a title with its own apostrophe-s, typed as written or cut at 100 characters, comes first',
  'QC11 QC10 QC12 more=false|QC12 QC10 QC11 more=false|QC11 QC12 QC10 more=false',
  pg_temp.found('Procedure not carried out because of patient''s decision for reasons of belief or group pressure', 10)
  || '|' || pg_temp.found(left('Procedure not carried out because of patient''s decision for reasons other than belief or '
                                || 'group pressure', 100), 10)
  || '|' || pg_temp.found('procedure not carried out because of patient’s decision', 10));
select pg_temp.expect('2v "X syndrome" eponyms answer as before, with or without the apostrophe',
  '5A70 5A70.Z more=false|5A70 5A70.Z more=false|5A70 5A70.Z more=false',
  pg_temp.found('cushing''s syndrome', 10) || '|' || pg_temp.found('Cushing’s syndrome', 10) || '|'
  || pg_temp.found('cushing syndrome', 10));
-- Nit 4. Before: FA20 came after every shorter title starting with ra, CA07.0 and JA89 after their shorter titles.
select pg_temp.expect('2w a title or other name that is q comes right after the code',
  'FA20(ra) ME66.6 MD32 1C82 8B93 RA01 RA02 RA01.0 more=false|CA07.0(urti) EB05 EB00.0 more=false|JA89(prom) MC88 more=false|'
  || '8A00.0 8A00.00 8A00.0Y more=false',
  pg_temp.found('ra', 10) || '|' || pg_temp.found('urti', 10) || '|' || pg_temp.found('prom', 10) || '|'
  || pg_temp.found('parkinson disease', 10));
-- Nit 5. Before: "5C50 5" was the words 5c50 and 5, so 5C50.5 came after every shorter title of its family.
select pg_temp.expect('2x a code typed with spaces at its dot is that code; a word with a space is searched as before',
  '5C50.5 5C50.10 5C50.0 5C50.E 5C50 more=false|5C50.5 5C50.10 5C50.0 5C50.E 5C50 more=false|'
  || '5C50.5 5C50.10 5C50.0 5C50.E 5C50 more=false|5C50.5 5C50.10 5C50.0 5C50.E 5C50 more=false|'
  || '9A03.0 more=false|5A11 more=false',
  pg_temp.found('5C50 5', 10) || '|' || pg_temp.found('5C50. 5', 10) || '|' || pg_temp.found('5c50 .5', 10) || '|'
  || pg_temp.found('(5C50 . 5)', 10) || '|' || pg_temp.found('9A03 0', 10) || '|' || pg_temp.found('type 2', 10));
-- Nit 9g: the accented titles are found by plain letters through our other names.
select pg_temp.expect('2y plain letters find the accented titles',
  '4A43.2(Sjogren syndrome) more=false|2B02(Sezary syndrome) more=false|4A62(Behcet disease) 8A45.43 more=false',
  pg_temp.found('sjogren', 10) || '|' || pg_temp.found('sezary', 10) || '|' || pg_temp.found('behcet', 10));

-- 3. Refusals.
select pg_temp.expect('3a q of 1 or 101 characters, limit 0 or 26', '22023 CATALOG_SEARCH_INVALID|22023 CATALOG_SEARCH_INVALID|'
  || '22023 CATALOG_SEARCH_INVALID|22023 CATALOG_SEARCH_INVALID',
  pg_temp.refusal($q$select * from ehr.search_catalog_diagnoses('m', 10)$q$) || '|'
  || pg_temp.refusal(format('select * from ehr.search_catalog_diagnoses(%L, 10)', repeat('m', 101))) || '|'
  || pg_temp.refusal($q$select * from ehr.search_catalog_diagnoses('malaria', 0)$q$) || '|'
  || pg_temp.refusal($q$select * from ehr.search_catalog_diagnoses('malaria', 26)$q$));
select pg_temp.expect('3b brackets and operators answer nothing, never an error', ' more=false| more=false',
  pg_temp.found('((', 10) || '|' || pg_temp.found('&|!', 10));
select pg_temp.expect('3c an extension code, a code of another shape and a bad chapter are refused', '23514 23514 23514',
  left(pg_temp.refusal($q$insert into ehr.catalog_diagnoses (version_id, code, title, chapter)
       values ('c1500000-0000-4000-8000-000000000002', 'XN6P4', 'x', 'X')$q$), 5) || ' '
  || left(pg_temp.refusal($q$insert into ehr.catalog_diagnoses (version_id, code, title, chapter)
       values ('c1500000-0000-4000-8000-000000000002', 'B50.9', 'x', '01')$q$), 5) || ' '
  || left(pg_temp.refusal($q$insert into ehr.catalog_diagnoses (version_id, code, title, chapter)
       values ('c1500000-0000-4000-8000-000000000002', '1A00', 'x', '1')$q$), 5));
select pg_temp.expect('3d a second active release is refused', '23505',
  left(pg_temp.refusal($q$update ehr.catalog_versions set active = true
                          where id = 'c1500000-0000-4000-8000-000000000002'$q$), 5));
select pg_temp.expect('3e a loaded entry never changes', '55000 55000 55000',
  left(pg_temp.refusal($q$update ehr.catalog_diagnoses set title = 'x' where code = '1F40'$q$), 5) || ' '
  || left(pg_temp.refusal($q$delete from ehr.catalog_diagnoses where code = '1F40'$q$), 5) || ' '
  || left(pg_temp.refusal('truncate ehr.catalog_diagnoses'), 5));
select pg_temp.expect('3f the versions still refuse a kind of no list', '23514',
  left(pg_temp.refusal($q$insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference,
       approvals_sha256, approved_at) values ('c1500000-0000-4000-8000-000000000009', 'procedure', '1', repeat('f', 64),
       'synthetic sign-off', repeat('9', 64), now())$q$), 5));
select pg_temp.expect('3g a row for the live release is refused; a release still loading takes one',
  '55000 CATALOG_VERSION_SEALED: diagnosis 2026-01|none',
  pg_temp.refusal($q$insert into ehr.catalog_diagnoses (version_id, code, title, chapter)
    values ('c1500000-0000-4000-8000-000000000001', '1F41', 'Malaria due to Plasmodium vivax', '01')$q$)
  || '|' || pg_temp.refusal($q$insert into ehr.catalog_diagnoses (version_id, code, title, chapter)
    values ('c1500000-0000-4000-8000-000000000002', '1F4Z', 'Malaria, unspecified', '01')$q$));
-- Nit 7: a diagnosis row for a version of another kind (a medicine list still loading) is refused.
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approvals_sha256, approved_at)
  values ('c1500000-0000-4000-8000-000000000010', 'medicine', '2026.1', repeat('a', 64), 'synthetic medicine sign-off',
          repeat('4', 64), now());
select pg_temp.expect('3i a diagnosis row for a medicine list''s version is refused',
  '55000 A diagnosis entry needs a diagnosis release, not the medicine list 2026.1',
  pg_temp.refusal($q$insert into ehr.catalog_diagnoses (version_id, code, title, chapter)
    values ('c1500000-0000-4000-8000-000000000010', '1F40', 'Malaria due to Plasmodium falciparum', '01')$q$));
-- A next release (still loading) takes its entry, then replaces 2026-01; then 2026-01 is switched back for 4.
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approvals_sha256, approved_at)
  values ('c1500000-0000-4000-8000-000000000003', 'diagnosis', '2027-01', repeat('c', 64), 'synthetic next sign-off',
          repeat('3', 64), now());
insert into ehr.catalog_diagnoses (version_id, code, title, chapter)
  values ('c1500000-0000-4000-8000-000000000003', '1F40', 'Malaria due to Plasmodium falciparum', '01');
update ehr.catalog_versions set active = false where kind = 'diagnosis' and active;
update ehr.catalog_versions set active = true where id = 'c1500000-0000-4000-8000-000000000003';
select pg_temp.expect('3h a row for a release replaced after it was live is refused, and for the new live one',
  '55000 CATALOG_VERSION_SEALED: diagnosis 2026-01|55000 CATALOG_VERSION_SEALED: diagnosis 2027-01|1F40 more=false',
  pg_temp.refusal($q$insert into ehr.catalog_diagnoses (version_id, code, title, chapter)
    values ('c1500000-0000-4000-8000-000000000001', '1F41', 'Malaria due to Plasmodium vivax', '01')$q$)
  || '|' || pg_temp.refusal($q$insert into ehr.catalog_diagnoses (version_id, code, title, chapter)
    values ('c1500000-0000-4000-8000-000000000003', '1F4Z', 'Malaria, unspecified', '01')$q$)
  || '|' || pg_temp.found('malaria', 10));
update ehr.catalog_versions set active = false where kind = 'diagnosis' and active;
update ehr.catalog_versions set active = true where id = 'c1500000-0000-4000-8000-000000000001';

-- 4. As the EHR runtime: the search answers; the table does not.
set local role hid_ehr_runtime;
select pg_temp.expect('4a the EHR runtime searches', '5A11(t2dm) more=false', pg_temp.found('t2dm', 10));
select pg_temp.expect('4b the EHR runtime reads no table', '42501',
  left(pg_temp.refusal('select count(*) from ehr.catalog_diagnoses'), 5));
reset role;

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, actual), E'\n' order by seq) into failures
    from diagnosis_cases where expected is distinct from actual;
  if failures is not null then
    raise exception E'0150 diagnosis search suite failed:\n%', failures;
  end if;
  raise notice '0150 diagnosis search suite: % cases passed', (select count(*) from diagnosis_cases);
end $$;
rollback;
