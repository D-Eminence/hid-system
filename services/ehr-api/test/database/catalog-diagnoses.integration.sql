\set ON_ERROR_STOP on
-- 0152 (ORD-9, first slice): the ICD-11 diagnosis list and its search.
-- Rollback-only.
--   1. after 0001-0152: the list is empty, the status answers for three
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
--   4. the EHR runtime may search and read no table;
--   5. 0157 (Rahman's two ranking fixes after his last look at #320), on a
--      release of its own: a word whose final s the second attempt drops is
--      accepted when it or the word as typed is a whole word (fix 1); entries
--      naming more of q's words, every word and never a code part, come
--      after a name that is q or starts with q, for q of 2 or more words
--      (fix 2), so a stage or grade number no longer ranks by a code part;
--      a one-word q such as "1a" keeps its order, with punctuation around it
--      too; on the second attempt the words counted are the shortened ones;
--      a code typed with a space at its dot stays first though another entry
--      names more of q's words. Each fix case fails on 0152's search. Case 2z
--      also changes with fix 2. Then Ola's two addenda to fix 2's count
--      (the second narrows the first), on releases of their own: when q has
--      the word with and not the word without, the count reads no word of a
--      "without ..." clause (with starts without), which runs to the next
--      comma or semicolon or the next word with; any other q counts every
--      word; and a q shaped like an ICD-11 code (a digit third) counts
--      nothing, so it keeps 0152's order. Cases 5h and 5j fail on 0157's
--      first body (7ad367c1), and 5h on 0152's; 5i holds on both addenda's
--      bodies and 7ad367c1's (its last q fails on 0152's), and fails when
--      the clause is taken out even for a q with the word without; 5k fails
--      on 7ad367c1's and 0152's, and when the count comes before "starts
--      with q" (which 5g showed before a q shaped like a code counted
--      nothing). Fix 1's whole-word check still reads a clause's
--      words (5l, which also fails on 0152's); a clause in our other names
--      does not count either, for an entry whose title has none (5m, on a
--      release of its own). The second addendum's cases (5n-5t, on a release
--      of their own) fail on the first addendum's body (528bfecf) wherever
--      it differs: a q without the word with counts every word again
--      (laceration, pelvic fracture, "w/o"), a clause ends at the next word
--      with, and "type 1" and "lung ca" are counted again.
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

-- 1. After 0001-0152.
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
-- the switch, which seals the live one (0149's guard; 0152's insert trigger then refuses it any row).
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
-- cut at 100 characters (the first 6 words match all three) still starts it. Since 0157 (fix 2) every word of q
-- ranks, not only the first 6: the other title, which names 14 or 15 of q's words, now comes before QC10, which
-- names 6 or 7 (before, the shorter QC10 came second).
select pg_temp.expect('2z a title with its own apostrophe-s, typed as written or cut at 100 characters, comes first',
  'QC11 QC12 QC10 more=false|QC12 QC11 QC10 more=false|QC11 QC12 QC10 more=false',
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

-- 5. 0157: Rahman's two ranking fixes (his last look at #320). A release of its own (2026-02, loaded while still
-- loading, then switched live), so the rows above keep their answers. WHO's titles verbatim; the other names of
-- 2E86.0 are ours, as the seed gives them.
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approvals_sha256, approved_at)
  values ('c1500000-0000-4000-8000-000000000005', 'diagnosis', '2026-02', repeat('b', 64), 'synthetic ranking sign-off',
          repeat('5', 64), now());
insert into ehr.catalog_diagnoses (version_id, code, title, other_names, chapter, residual) values
  -- Fix 1: titles with words that end in s by themselves (thyroiditis, sites, uterus, neoplasms).
  ('c1500000-0000-4000-8000-000000000005', '5A03.20', 'Hashimoto thyroiditis', '', '05', false),
  ('c1500000-0000-4000-8000-000000000005', 'DD70.6', 'Crohn disease of anastomotic sites', '', '13', false),
  ('c1500000-0000-4000-8000-000000000005', '2E86.0', 'Leiomyoma of uterus', 'fibroid uterus; fibroids; uterine fibroids',
   '02', false),
  ('c1500000-0000-4000-8000-000000000005', '2A8Z', 'Mature B-cell neoplasms, unspecified', '', '02', true),
  ('c1500000-0000-4000-8000-000000000005', '2A82.Z', 'Mature B-cell neoplasm with leukaemic behaviour, unspecified', '',
   '02', true),
  -- Fix 1 and the second attempt's count: infection and lung, as shortened, are words of all three; infections, as
  -- typed, of two, and lungs of none.
  ('c1500000-0000-4000-8000-000000000005', 'CA4Z', 'Lung infections, unspecified', '', '12', true),
  ('c1500000-0000-4000-8000-000000000005', '1F73.1', 'Echinococcus infection of lung', '', '01', false),
  ('c1500000-0000-4000-8000-000000000005', 'CA4Y', 'Other specified lung infections', '', '12', true),
  -- Fix 2: HIV disease by clinical stage (stages 1 to 3, and 1C61.3, stage 4, whose code part is 3) and follicular
  -- lymphoma by grade, each with a number that also starts a code part of another.
  ('c1500000-0000-4000-8000-000000000005', '1C60.0', 'HIV disease clinical stage 1 associated with tuberculosis', '',
   '01', false),
  ('c1500000-0000-4000-8000-000000000005', '1C60.1', 'HIV disease clinical stage 2 associated with tuberculosis', '',
   '01', false),
  ('c1500000-0000-4000-8000-000000000005', '1C60.2', 'HIV disease clinical stage 3 associated with tuberculosis', '',
   '01', false),
  ('c1500000-0000-4000-8000-000000000005', '1C61.0', 'HIV disease clinical stage 1 associated with malaria', '', '01',
   false),
  ('c1500000-0000-4000-8000-000000000005', '1C61.1', 'HIV disease clinical stage 2 associated with malaria', '', '01',
   false),
  ('c1500000-0000-4000-8000-000000000005', '1C61.2', 'HIV disease clinical stage 3 associated with malaria', '', '01',
   false),
  ('c1500000-0000-4000-8000-000000000005', '1C61.3', 'HIV disease clinical stage 4 associated with malaria', '', '01',
   false),
  ('c1500000-0000-4000-8000-000000000005', '1C62.1',
   'HIV disease clinical stage 2 without mention of tuberculosis or malaria', '', '01', false),
  ('c1500000-0000-4000-8000-000000000005', '1C62.2',
   'HIV disease clinical stage 3 without mention of tuberculosis or malaria', '', '01', false),
  ('c1500000-0000-4000-8000-000000000005', '2A80.0', 'Follicular lymphoma grade 1', '', '02', false),
  ('c1500000-0000-4000-8000-000000000005', '2A80.1', 'Follicular lymphoma grade 2', '', '02', false),
  ('c1500000-0000-4000-8000-000000000005', '2A80.2', 'Follicular lymphoma grade 3', '', '02', false),
  -- A one-word code fragment: 1a starts 1A00's code, and is a word of the two others' titles.
  ('c1500000-0000-4000-8000-000000000005', '1A00', 'Cholera', '', '01', false),
  ('c1500000-0000-4000-8000-000000000005', 'GC51.00', 'Female Genital Mutilation Type 1a', '', '16', false),
  ('c1500000-0000-4000-8000-000000000005', 'KB88.0', 'Necrotising enterocolitis of newborn, Stage 1A & B', '', '19',
   false);
update ehr.catalog_versions set active = false where kind = 'diagnosis' and active;
update ehr.catalog_versions set active = true where id = 'c1500000-0000-4000-8000-000000000005';
-- Fix 1. Before, each shortened word had to be a whole word itself: thyroiditi, site and uteru are not, so the first
-- three found nothing, and neoplasm is a word of 2A82.Z only, so the fourth offered 2A82.Z alone.
select pg_temp.expect('5a fix 1: a word that ends in s by itself is accepted as typed, when the second attempt drops its s',
  '5A03.20 more=false|DD70.6 more=false|2E86.0(fibroid uterus) more=false|2A8Z 2A82.Z more=false',
  pg_temp.found('hashimotos thyroiditis', 10) || '|' || pg_temp.found('crohns disease of anastomotic sites', 10) || '|'
  || pg_temp.found('fibroids uterus', 10) || '|' || pg_temp.found('Mature B-cells neoplasms, unspecified', 10));
-- Fix 2. Before, the 7th word (tuberculosis) did not rank, so the shorter malaria titles came first; and grade 2 and
-- stage 2 also started the code parts 2A80 and 1C6x.2, so grade 1 and the stage 3 entries ranked with them.
select pg_temp.expect('5b fix 2: every word of q ranks, and a word that starts only a code part ranks lower',
  '1C60.0 1C61.0 1C60.1 1C60.2 1C61.1 1C61.2 1C61.3 more=false|2A80.1 2A80.0 2A80.2 more=false|'
  || '1C61.1 1C60.1 1C62.1 1C61.2 1C60.2 1C62.2 more=false',
  pg_temp.found('HIV disease stage 1 associated with tuberculosis', 10) || '|'
  || pg_temp.found('grade 2 follicular lymphoma', 10) || '|' || pg_temp.found('hiv stage 2', 10));
-- (ii): 3 is a word of the stage 3 titles, and only a code part of 1C61.3 (stage 4). Before, 1C61.3 came second, by
-- its shorter title.
select pg_temp.expect('5c fix 2: "stage 3" puts the stage 3 entries before 1C61.3, which is stage 4',
  '1C61.2 1C60.2 1C62.2 1C61.3 more=false', pg_temp.found('stage 3', 10));
-- A one-word q keeps 0152's order (Ola, clinical owner): a code fragment usually means the code, so 1A00 stays before
-- the titles that have 1a as a word.
select pg_temp.expect('5d a one-word q keeps its order: "1a" puts 1A00 first', '1A00 GC51.00 KB88.0 more=false',
  pg_temp.found('1a', 10));
-- Punctuation around one word makes empty pieces when q is split; they are not words, so "(1a)" and "1a." are one
-- word too and keep the order of "1a".
select pg_temp.expect('5e a one-word q with punctuation around it keeps its order', '1A00 GC51.00 KB88.0 more=false|'
  || '1A00 GC51.00 KB88.0 more=false',
  pg_temp.found('(1a)', 10) || '|' || pg_temp.found('1a.', 10));
-- On the second attempt the words counted are the words as shortened, as the match uses them: infection and lung are
-- words of all three entries, so the shorter titles come first. Counted as typed, infections would put the two lung
-- infections entries first. Before (0152), infection of lung was the only entry where each shortened word is a word.
select pg_temp.expect('5f fix 1 and the second attempt''s count: "infections lungs" counts infection and lung',
  'CA4Z 1F73.1 CA4Y more=false', pg_temp.found('infections lungs', 10));
-- The code q is stays first: in "2A80 1" (2A80.1 with a space at its dot), 1 is a word of 2A80.0's title, grade 1, and
-- only a code part of 2A80.1's. Since Ola's addenda a q shaped like an ICD-11 code (2A80.1: a digit third) counts
-- nothing (5j), so the count no longer orders these; before, the first key put the code before 2A80.0, which named
-- more of q's words.
select pg_temp.expect('5g a code typed with a space at its dot comes first, though another entry names more of q''s words',
  '2A80.1 2A80.0 more=false|2A80.1 2A80.0 more=false',
  pg_temp.found('2A80 1', 10) || '|' || pg_temp.found('2a80.1', 10));

-- Ola's addendum to 0157 (#258, from its clinical review): two changes to fix 2's count, which her second addendum
-- narrows (5n-5t, below). A release of its own (2026-03), so the rows above keep their answers. WHO's titles verbatim.
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approvals_sha256, approved_at)
  values ('c1500000-0000-4000-8000-000000000006', 'diagnosis', '2026-03', repeat('6', 64),
          'synthetic addendum sign-off', repeat('7', 64), now());
insert into ehr.catalog_diagnoses (version_id, code, title, other_names, chapter, residual) values
  -- With starts without: entries whose "without ..." clause holds words of q.
  ('c1500000-0000-4000-8000-000000000006', '1C60.3', 'HIV disease clinical stage 4 associated with tuberculosis', '',
   '01', false),
  ('c1500000-0000-4000-8000-000000000006', '1C61.3', 'HIV disease clinical stage 4 associated with malaria', '', '01',
   false),
  ('c1500000-0000-4000-8000-000000000006', '1C62.3',
   'HIV disease clinical stage 4 without mention of tuberculosis or malaria', '', '01', false),
  ('c1500000-0000-4000-8000-000000000006', 'DC11.4', 'Calculus of bile duct with cholangitis', '', '13', false),
  ('c1500000-0000-4000-8000-000000000006', 'DC11.5', 'Calculus of bile duct with cholecystitis', '', '13', false),
  ('c1500000-0000-4000-8000-000000000006', 'DC11.6', 'Calculus of bile duct without cholangitis or cholecystitis', '',
   '13', false),
  -- A clause ends at the next comma: NB51.0's "lower back or pelvis" is outside it.
  ('c1500000-0000-4000-8000-000000000006', 'NC91.0', 'Laceration without foreign body of lower leg', '', '22', false),
  ('c1500000-0000-4000-8000-000000000006', 'NC91.1', 'Laceration with foreign body of lower leg', '', '22', false),
  ('c1500000-0000-4000-8000-000000000006', 'NB51.0', 'Laceration without foreign body of abdomen, lower back or pelvis',
   '', '22', false),
  ('c1500000-0000-4000-8000-000000000006', 'NB51.1', 'Laceration with foreign body of abdomen, lower back or pelvis',
   '', '22', false),
  ('c1500000-0000-4000-8000-000000000006', 'NB31.01', 'Minor laceration of heart with haemopericardium', '', '22', false),
  -- A q with the word without: each pair names all of q's words, one entry only through its clause.
  ('c1500000-0000-4000-8000-000000000006', 'KB87.1', 'Meconium plug without ileus', '', '19', false),
  ('c1500000-0000-4000-8000-000000000006', 'KB87.2', 'Meconium ileus without perforation', '', '19', false),
  ('c1500000-0000-4000-8000-000000000006', 'KB87.4', 'Meconium ileus with perforation', '', '19', false),
  ('c1500000-0000-4000-8000-000000000006', 'DB94.3', 'Alcoholic cirrhosis of liver without hepatitis', '', '13', false),
  ('c1500000-0000-4000-8000-000000000006', 'DB95.11',
   'Drug-induced or toxic liver disease with chronic hepatitis without cirrhosis', '', '13', false),
  -- A q with the words with and without: DB95.11's family, with and without cirrhosis.
  ('c1500000-0000-4000-8000-000000000006', 'DB95.1', 'Drug-induced or toxic liver disease with chronic hepatitis', '',
   '13', false),
  ('c1500000-0000-4000-8000-000000000006', 'DB95.10',
   'Drug-induced or toxic liver disease with chronic hepatitis with cirrhosis', '', '13', false),
  ('c1500000-0000-4000-8000-000000000006', 'DB95.1Z',
   'Drug-induced or toxic liver disease with chronic hepatitis, unspecified', '', '13', true),
  -- A code typed as a code: ME24.A, its subcodes (a starts only their code part), and other ME24 entries with a title
  -- word starting with a.
  ('c1500000-0000-4000-8000-000000000006', 'ME24.0', 'Digestive system abscess', '', '21', false),
  ('c1500000-0000-4000-8000-000000000006', 'ME24.90', 'Acute gastrointestinal bleeding, not elsewhere classified', '',
   '21', false),
  ('c1500000-0000-4000-8000-000000000006', 'ME24.A', 'Other digestive system haemorrhage, not elsewhere classified', '',
   '21', false),
  ('c1500000-0000-4000-8000-000000000006', 'ME24.A1', 'Haemorrhage of anus or rectum', '', '21', false),
  ('c1500000-0000-4000-8000-000000000006', 'ME24.A2', 'Oesophageal haemorrhage', '', '21', false),
  ('c1500000-0000-4000-8000-000000000006', 'ME24.A3', 'Haematochezia', '', '21', false),
  ('c1500000-0000-4000-8000-000000000006', 'ME24.A4', 'Melaena', '', '21', false),
  ('c1500000-0000-4000-8000-000000000006', 'ME24.A5', 'Haematemesis', '', '21', false);
update ehr.catalog_versions set active = false where kind = 'diagnosis' and active;
update ehr.catalog_versions set active = true where id = 'c1500000-0000-4000-8000-000000000006';
-- When q has the word with (and not without), the count reads no word of a "without ..." clause, up to the next
-- comma. Before (7ad367c1), with started without and the clause's tuberculosis, malaria, cholangitis and cholecystitis
-- counted, so the negative entry came first: 1C62.3 named 8 of the 9 words, the others 7; DC11.6 named 7 of 8, DC11.4
-- 6. Now 1C62.3 names 5 and DC11.6 4 (the second addendum keeps this: each q has the word with). The third q is
-- NC91.1's title typed as written, which stays first. It has the word with too, and NC91.0's clause runs to the end of
-- its title, so its site (lower leg) goes with foreign body: it names laceration only and comes last, where it came
-- second before (on 0152 too, by its shorter title). A q without the word with counts NC91.0's site again (5n).
-- NB51.0's clause ends at its comma, so lower back or pelvis still count (were the clause taken to the end, NC91.0
-- would come before NB51.0, by its shorter title).
select pg_temp.expect('5h the count reads no word of a "without ..." clause: a positive entry comes first',
  '1C61.3 1C60.3 1C62.3 more=false|DC11.4 DC11.6 more=false|NC91.1 NB51.1 NB51.0 NC91.0 more=false',
  pg_temp.found('hiv disease clinical stage 4 with tuberculosis and malaria', 10) || '|'
  || pg_temp.found('calculus of bile duct with cholangitis and cholecystitis', 10) || '|'
  || pg_temp.found('Laceration with foreign body of lower leg', 10));
-- When q has the word without, the clause counts: each entry names all of q's words, so the shorter title comes first,
-- the entry q names. Were the clause taken out here too, KB87.1 would name 1 word (meconium) and KB87.2 2, and DB94.3
-- 1 (liver) and DB95.11 2 (liver, hepatitis): the other entry first. The same holds when q also has the word with
-- (since the second addendum the only q whose clauses are taken out has with and not without): in "toxic liver
-- disease with chronic hepatitis without cirrhosis" DB95.11 names all 8 words, DB95.10 (with cirrhosis) 7, so the
-- entry q names comes first. Were the clauses taken out because q has with, DB95.11 would name 6 (not without nor
-- cirrhosis) and DB95.10 7: the entry with cirrhosis first. On 0152 the shorter titles came first, DB95.11 last.
select pg_temp.expect('5i a q with the word without still finds its own entry first, with the word with too',
  'KB87.1 KB87.2 more=false|DB94.3 DB95.11 more=false|DB95.11 DB95.10 DB95.1 DB95.1Z more=false',
  pg_temp.found('meconium without ileus', 10) || '|' || pg_temp.found('liver without hepatitis', 10) || '|'
  || pg_temp.found('toxic liver disease with chronic hepatitis without cirrhosis', 10));
-- A q shaped like a code counts nothing: its own subcodes keep rows 2-5, by their shorter titles. Before (7ad367c1),
-- "ME24.A" counted as two words, and a only starts a code part of ME24.A2-ME24.A5 but a title word of ME24.0, ME24.A1
-- and ME24.90, which came second to fourth.
select pg_temp.expect('5j a q shaped like a code keeps its order: "ME24.A" puts its subcodes in rows 2-5',
  'ME24.A ME24.A4 ME24.A5 ME24.A3 ME24.A2 ME24.0 ME24.A1 ME24.90 more=false|'
  || 'ME24.A ME24.A4 ME24.A5 ME24.A3 ME24.A2 ME24.0 ME24.A1 ME24.90 more=false',
  pg_temp.found('ME24.A', 10) || '|' || pg_temp.found('ME24 A', 10));
-- The count still comes after "starts with q". An entry that starts with q can now name fewer of q's words: in
-- "laceration with", with starts only the clause's without in NC91.0 and NB51.0, so the four laceration titles, which
-- all start with q, put NC91.1 and NB51.1 first; NB31.01 names both words but does not start with q, so it comes last
-- (were the count before "starts with q", it would come third). Before (7ad367c1, and on 0152 by shorter titles),
-- NC91.0 came second.
select pg_temp.expect('5k the count orders entries that start with q among themselves, before the others',
  'NC91.1 NB51.1 NC91.0 NB51.0 NB31.01 more=false', pg_temp.found('laceration with', 10));
-- Fix 1's whole-word check still reads every word of the entry, a clause's too; only the count leaves them out. In
-- "meconium ileus with perforations" the first attempt finds nothing (no word starts with perforations); the second
-- drops the final s of ileus and perforations, and perforation is a whole word of KB87.2 only inside its clause. So
-- KB87.2 is still found, and the count, which leaves its clause out (q has the word with), puts it after KB87.4, which
-- names all four words. Were the check to read the count's words, KB87.2 would not be found at all, and which entries
-- match would change. "meconium ileus perforations" (the first addendum's q) has no word with since the second
-- addendum, so both entries name all three words, and the shorter title comes first: the same answer. 0152 finds
-- nothing for either (ileu is no word).
select pg_temp.expect('5l fix 1''s whole-word check still reads a clause''s words; only the count leaves them out',
  'KB87.4 KB87.2 more=false|KB87.4 KB87.2 more=false',
  pg_temp.found('meconium ileus with perforations', 10) || '|' || pg_temp.found('meconium ileus perforations', 10));

-- A clause in our other names. A release of its own (2026-04), so the rows above keep their answers. WHO's titles
-- verbatim (neither has the word without); the other names are ours.
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approvals_sha256, approved_at)
  values ('c1500000-0000-4000-8000-000000000007', 'diagnosis', '2026-04', repeat('8', 64),
          'synthetic other-names sign-off', repeat('9', 64), now());
insert into ehr.catalog_diagnoses (version_id, code, title, other_names, chapter, residual) values
  ('c1500000-0000-4000-8000-000000000007', '8A63.00', 'Simple febrile seizures',
   'febrile seizure without focal features; simple febrile convulsion', '08', false),
  ('c1500000-0000-4000-8000-000000000007', '8A63.01', 'Complex febrile seizures',
   'febrile seizure with focal features; complex febrile convulsion', '08', false);
update ehr.catalog_versions set active = false where kind = 'diagnosis' and active;
update ehr.catalog_versions set active = true where id = 'c1500000-0000-4000-8000-000000000007';
-- "seizure with focal features": focal and features are words of 8A63.00 only inside its other name's clause, and q
-- has the word with, so 8A63.01, which names all four words, comes first; 8A63.00 names seizure only. Were other
-- names' clauses counted, or only titles checked for the letters without, 8A63.00 would name all four too and come
-- first, by its shorter title (as on 0152 and 7ad367c1). "focal febrile seizure" has no word with, so since the second
-- addendum every word counts (on the first addendum's body, 8A63.01 came first): both entries name all three, and the
-- shorter title comes first, as on 0152. "febrile convulsion" has no word with either: both name both words through
-- their second other name, and the shorter title comes first.
select pg_temp.expect('5m a clause in our other names does not count either, when q has the word with',
  '8A63.01(febrile seizure with focal features) 8A63.00(febrile seizure without focal features) more=false|'
  || '8A63.00(febrile seizure without focal features) 8A63.01(febrile seizure with focal features) more=false|'
  || '8A63.00(simple febrile convulsion) 8A63.01(complex febrile convulsion) more=false',
  pg_temp.found('seizure with focal features', 10) || '|' || pg_temp.found('focal febrile seizure', 10) || '|'
  || pg_temp.found('febrile convulsion', 10));

-- Ola's second addendum (#258, from the first addendum's review): the clause rule applies only when q has the word
-- with and not the word without, a clause also ends at the next word with, and only an ICD-11 code's shape (a digit
-- third) counts nothing. A release of its own (2026-05), so the rows above keep their answers. WHO's titles verbatim;
-- 5A10's other names are ours, as in the 2026-01 seed.
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approvals_sha256, approved_at)
  values ('c1500000-0000-4000-8000-000000000008', 'diagnosis', '2026-05', repeat('c', 64),
          'synthetic second addendum sign-off', repeat('d', 64), now());
insert into ehr.catalog_diagnoses (version_id, code, title, other_names, chapter, residual) values
  -- Laceration of forearm: the site of NC31.0 is inside its clause.
  ('c1500000-0000-4000-8000-000000000008', 'NC31.0', 'Laceration without foreign body of forearm', '', '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NC31.1', 'Laceration with foreign body of forearm', '', '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NC35.00', 'Laceration of ulnar artery at forearm level', '', '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NC35.10', 'Laceration of radial artery at forearm level', '', '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NC35.20', 'Laceration of vein at forearm level', '', '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NC36.01',
   'Laceration of flexor muscle, fascia or tendon of thumb at forearm level', '', '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NC36.11',
   'Laceration of long flexor muscle, fascia or tendon of other finger at forearm level', '', '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NC36.21',
   'Laceration of other flexor muscle, fascia or tendon at forearm level', '', '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NC36.31',
   'Laceration of extensor or abductor muscles or tendons of thumb at forearm level', '', '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NC36.41',
   'Laceration of extensor muscle, fascia or tendon of other finger at forearm level', '', '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NC36.51',
   'Laceration of other extensor muscle, fascia or tendon at forearm level', '', '22', false),
  -- Pelvic fractures: pelvic is inside the clause of the stable single-bone fractures.
  ('c1500000-0000-4000-8000-000000000008', 'NB52.1',
   'Fracture of pelvic bone without disruption of posterior arch of pelvic ring', '', '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NB52.10', 'Fracture of sacrum without disruption of pelvic ring', '', '22',
   false),
  ('c1500000-0000-4000-8000-000000000008', 'NB52.12', 'Fracture of ilium without disruption of pelvic ring', '', '22',
   false),
  ('c1500000-0000-4000-8000-000000000008', 'NB52.13', 'Fracture of acetabulum without disruption of pelvic ring', '',
   '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NB52.14', 'Fracture of pubis without disruption of pelvic ring', '', '22',
   false),
  ('c1500000-0000-4000-8000-000000000008', 'NB52.15', 'Fracture of ischium without disruption of pelvic ring', '', '22',
   false),
  ('c1500000-0000-4000-8000-000000000008', 'NB52.1Y',
   'Fracture of other specified pelvic bone without disruption of posterior arch of pelvic ring', '', '22', true),
  ('c1500000-0000-4000-8000-000000000008', 'NB52.1Z',
   'Fracture of unspecified pelvic bone without disruption of posterior arch of pelvic ring', '', '22', true),
  ('c1500000-0000-4000-8000-000000000008', 'NB52.2',
   'Fracture of the pelvic ring with incomplete disruption of posterior arch', '', '22', false),
  ('c1500000-0000-4000-8000-000000000008', 'NB52.3', 'Fracture of pelvic ring with complete disruption of posterior arch',
   '', '22', false),
  -- A q typed with "w/o": complication is inside JA00.09's clause.
  ('c1500000-0000-4000-8000-000000000008', 'JA00.08',
   'Spontaneous abortion, complete or unspecified, with other or unspecified complications', '', '18', false),
  ('c1500000-0000-4000-8000-000000000008', 'JA00.09',
   'Spontaneous abortion, complete or unspecified, without complication', '', '18', false),
  -- A clause that ends at the next word with: "... without disorder of intellectual development and with ...".
  ('c1500000-0000-4000-8000-000000000008', '6A02.0',
   'Autism spectrum disorder without disorder of intellectual development and with mild or no impairment of functional language',
   '', '06', false),
  ('c1500000-0000-4000-8000-000000000008', '6A02.1',
   'Autism spectrum disorder with disorder of intellectual development and with mild or no impairment of functional language',
   '', '06', false),
  ('c1500000-0000-4000-8000-000000000008', '6A02.2',
   'Autism spectrum disorder without disorder of intellectual development and with impaired functional language', '',
   '06', false),
  ('c1500000-0000-4000-8000-000000000008', '6A02.3',
   'Autism spectrum disorder with disorder of intellectual development and with impaired functional language', '',
   '06', false),
  ('c1500000-0000-4000-8000-000000000008', '6A02.5',
   'Autism spectrum disorder with disorder of intellectual development and with absence of functional language', '',
   '06', false),
  -- Two words with a code's shape for the first key (TYPE.1, LUNG.CA), but no digit third: a number or ca that starts
  -- only a code part of 7A20.1 and CA70.x.
  ('c1500000-0000-4000-8000-000000000008', '5A10', 'Type 1 diabetes mellitus', 'dm1; t1dm; type 1 dm; type i dm', '05',
   false),
  ('c1500000-0000-4000-8000-000000000008', '7A20.0', 'Narcolepsy, Type 1', '', '07', false),
  ('c1500000-0000-4000-8000-000000000008', '7A20.1', 'Narcolepsy, Type 2', '', '07', false),
  ('c1500000-0000-4000-8000-000000000008', '5C50.11', 'Tyrosinaemia type 1', '', '05', false),
  ('c1500000-0000-4000-8000-000000000008', 'CA70.0', 'Farmer lung', '', '12', false),
  ('c1500000-0000-4000-8000-000000000008', 'CA70.4', 'Malt worker lung', '', '12', false),
  ('c1500000-0000-4000-8000-000000000008', '2E62.2', 'Carcinoma in situ of bronchus or lung', '', '02', false),
  ('c1500000-0000-4000-8000-000000000008', '2C25.1', 'Small cell carcinoma of bronchus or lung', '', '02', false),
  ('c1500000-0000-4000-8000-000000000008', '2C25.2', 'Squamous cell carcinoma of bronchus or lung', '', '02', false),
  ('c1500000-0000-4000-8000-000000000008', '2C25.3', 'Large cell carcinoma of bronchus or lung', '', '02', false),
  ('c1500000-0000-4000-8000-000000000008', '2C25.4',
   'Carcinoid or other malignant neuroendocrine neoplasms of bronchus or lung', '', '02', false);
update ehr.catalog_versions set active = false where kind = 'diagnosis' and active;
update ehr.catalog_versions set active = true where id = 'c1500000-0000-4000-8000-000000000008';
-- "laceration of forearm" has no word with, so every word counts: NC31.0 names all three and keeps 0152's third row.
-- On the first addendum's body its clause took its site, so it named laceration only and came 11th, past the default
-- page of 10.
select pg_temp.expect('5n a q without the word with counts every word: "laceration of forearm" keeps NC31.0 third',
  'NC35.20 NC31.1 NC31.0 NC35.00 NC35.10 NC36.21 NC36.51 NC36.01 NC36.31 NC36.41 more=true',
  pg_temp.found('laceration of forearm', 10));
-- With the word with, NC31.0's clause is out again, and the entry q names comes first (as on 0152 and both addenda,
-- by the shorter title too).
select pg_temp.expect('5o "laceration of forearm with foreign body" puts NC31.1 first', 'NC31.1 NC31.0 more=false',
  pg_temp.found('laceration of forearm with foreign body', 10));
-- "pelvic fracture": pelvic is a word of the stable fractures only inside their clause ("without disruption of pelvic
-- ring"). With every word counted they keep 0152's order, by their shorter titles. On the first addendum's body they
-- named fracture only, so NB52.3 and the other pelvic ring entries came first, and the single bones in rows 6-10.
select pg_temp.expect('5p "pelvic fracture" in 0152''s order',
  'NB52.12 NB52.14 NB52.10 NB52.15 NB52.13 NB52.3 NB52.2 NB52.1 NB52.1Z NB52.1Y more=false',
  pg_temp.found('pelvic fracture', 10));
-- "w/o" is the words w and o, not the word without (nor the word with), so every word counts: JA00.09, the entry q
-- names, keeps 0152's first row. On the first addendum's body its clause (complication) was out, and JA00.08, with
-- complications, came first.
select pg_temp.expect('5q a q typed with "w/o" in 0152''s order', 'JA00.09 JA00.08 more=false',
  pg_temp.found('spontaneous abortion complete w/o complication', 10));
-- A clause ends at the next word with: 6A02.2's "without disorder of intellectual development and" is out, and "with
-- impaired functional language" counts, so it names all four words of q, as the three entries with no clause do, and
-- keeps 0152's place by its title's length. On the first addendum's body the clause ran to the end and took functional
-- and language, so 6A02.2 came after 6A02.1. 6A02.0, the same shape, has the longest title and stays last.
select pg_temp.expect('5r a clause ends at the next word with: "... and with ..." still counts',
  '6A02.3 6A02.5 6A02.2 6A02.1 6A02.0 more=false', pg_temp.found('autism with functional language', 10));
-- "type 1" has the first key's code shape (TYPE.1) but no digit third, so it is counted: 1 starts only a code part of
-- 7A20.1, Narcolepsy, Type 2, which comes after Tyrosinaemia type 1. On the first addendum's body every shape of the
-- first key counted nothing, and 7A20.1 came third, as on 0152.
select pg_temp.expect('5s "type 1" is counted: 7A20.1 Narcolepsy, Type 2 is not third',
  '5A10 7A20.0 5C50.11 7A20.1 more=false', pg_temp.found('type 1', 10));
-- "lung ca" (LUNG.CA) is counted too: ca starts carcinoma and carcinoid, and only a code part of CA70.0 and CA70.4, so
-- the lung carcinomas come first. On the first addendum's body (and 0152) the two shorter CA70 titles came first.
select pg_temp.expect('5t "lung ca" is counted: the lung carcinomas come first',
  '2E62.2 2C25.3 2C25.1 2C25.2 2C25.4 CA70.0 CA70.4 more=false', pg_temp.found('lung ca', 10));

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, actual), E'\n' order by seq) into failures
    from diagnosis_cases where expected is distinct from actual;
  if failures is not null then
    raise exception E'0152 diagnosis search suite failed:\n%', failures;
  end if;
  raise notice '0152 diagnosis search suite: % cases passed', (select count(*) from diagnosis_cases);
end $$;
rollback;
