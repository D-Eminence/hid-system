\set ON_ERROR_STOP on
-- 0156 (ORD-9): diagnosis codes across an ICD-11 release switch. Rollback-only.
-- The clinical owner's design note on #258 (7192389223): the new
-- ehr.catalog_diagnosis_listed(code_system, code), for codeStatus, and the
-- recent read, ehr.recent_diagnoses, replaced so that it follows the active
-- release.
--   1. both functions as 0156 leaves them: body (md5), owner (the owner of
--      ehr.catalog_versions), SECURITY DEFINER, STABLE (provolatile 's'),
--      plpgsql, search_path, result; EXECUTE for the EHR and schema test
--      runtimes only;
--   2. no release active (0152 loads none, so production today): every pick
--      comes back as stored, an ICD-10 pick, a post-coordinated ICD-11 pick
--      and a code no release holds included; the listed check answers null
--      for every code;
--   3. a release active: a plain ICD-11 pick comes back with the release's
--      title; a post-coordinated one (with & or /) is matched on its first
--      code and keeps its stored display; an ICD-11 code the release does
--      not hold (one it never held, or one typed in lower case) is left
--      out; an ICD-10 pick comes back as stored; order and counts are kept;
--      the limit applies after picks are left out; the listed check is true
--      or false for 'ICD-11' only (on the first code of a post-coordinated
--      code, spaces trimmed), and null for any other code system ('ICD-10',
--      'icd-11'), a null code or a null code system;
--   4. a release switch: the new release's title, a code it dropped left
--      out, a code it added back in; the listed check follows the switch;
--   5. the release switched off (none active): every pick as stored again,
--      the listed check null;
--   6. as before 0156: a member without ehr.diagnosis.write, or a session at
--      another facility, reads nothing under a release; the limit is 1-50;
--      the pharmacy runtime may run neither function; the EHR runtime reads
--      no catalogue table.
-- Every read runs as the EHR runtime (set local role hid_ehr_runtime ...
-- reset role); the releases are loaded by hand as the suite runner, as the
-- governed loader loads them (the release still loading, its entries, then
-- the switch, which seals it).
-- Synthetic values only: uuid prefix d156, example.invalid addresses. The
-- codes and the first release's titles are ICD-11's (WHO, CC BY-ND 3.0
-- IGO), verbatim; the second release, its changed title and its dropped
-- code are synthetic.
set plpgsql.variable_conflict = error;
begin;

create temporary table release_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;
grant select, insert on release_cases to public;
grant usage on sequence release_cases_seq_seq to public;
create function pg_temp.expect(case_name text, expected text, actual text) returns void language sql as $$
  insert into release_cases (name, expected, actual) values (case_name, expected, coalesce(actual, 'null'));
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
create function pg_temp.as_member(subject text, membership text, facility text) returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.membership_id', membership, true),
         set_config('app.facility_id', facility, true);
$$;
grant execute on function pg_temp.as_member(text, text, text) to public;
-- The recent read as a line: system:code(display)xcount, newest first.
create function pg_temp.recent(lim integer default 10) returns text language sql as $$
  select coalesce(string_agg(format('%s:%s(%s)x%s', recent.code_system, recent.code, recent.display, recent.use_count),
    ' ' order by ordinality), '')
    from ehr.recent_diagnoses(lim) with ordinality as recent;
$$;
grant execute on function pg_temp.recent(integer) to public;
-- The listed check for each pair, as one line ('null' for null).
create function pg_temp.listed(pairs text[][]) returns text language sql as $$
  select string_agg(coalesce(ehr.catalog_diagnosis_listed(pairs[i][1], pairs[i][2])::text, 'null'), ' ' order by i)
    from generate_subscripts(pairs, 1) i;
$$;
grant execute on function pg_temp.listed(text[][]) to public;

insert into auth.accounts (id, subject, email, display_name, status, source_system) values
  ('d1560000-0000-4000-8000-000000000001', 'staff:156-doctor', '156-doctor@example.invalid', 'Release Doctor', 'active',
   'hid'),
  ('d1560000-0000-4000-8000-000000000002', 'staff:156-pharmacist', '156-pharm@example.invalid', 'Release Pharmacist',
   'active', 'hid');
insert into identity.organizations (id, name, slug) values
  ('d1560000-0000-4000-8000-000000000011', 'Release Switch Test Org', '156-release-switch-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('d1560000-0000-4000-8000-000000000021', 'd1560000-0000-4000-8000-000000000011', 'Release Test Hospital', '156-H',
   'Africa/Lagos', true, 'verified'),
  ('d1560000-0000-4000-8000-000000000022', 'd1560000-0000-4000-8000-000000000011', 'Release Other Clinic', '156-C',
   'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('d1560000-0000-4000-8000-000000000031', 'd1560000-0000-4000-8000-000000000001', 'Release Doctor',
   '156-doctor@example.invalid', 'verified', 'doctor'),
  ('d1560000-0000-4000-8000-000000000032', 'd1560000-0000-4000-8000-000000000002', 'Release Pharmacist',
   '156-pharm@example.invalid', 'verified', 'pharmacist');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('d1560000-0000-4000-8000-000000000041', 'd1560000-0000-4000-8000-000000000031', 'd1560000-0000-4000-8000-000000000001',
   'd1560000-0000-4000-8000-000000000011', 'd1560000-0000-4000-8000-000000000021', 'doctor', 'doctor', true, true),
  ('d1560000-0000-4000-8000-000000000042', 'd1560000-0000-4000-8000-000000000031', 'd1560000-0000-4000-8000-000000000001',
   'd1560000-0000-4000-8000-000000000011', 'd1560000-0000-4000-8000-000000000022', 'doctor', 'doctor', false, true),
  ('d1560000-0000-4000-8000-000000000043', 'd1560000-0000-4000-8000-000000000032', 'd1560000-0000-4000-8000-000000000002',
   'd1560000-0000-4000-8000-000000000011', 'd1560000-0000-4000-8000-000000000021', 'pharmacist', 'pharmacist', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('d1560000-0000-4000-8000-000000000051', 'd1560000-0000-4000-8000-000000000001', 'doctor', 'facility',
   'd1560000-0000-4000-8000-000000000041', 'd1560000-0000-4000-8000-000000000021', 'Synthetic release switch test'),
  ('d1560000-0000-4000-8000-000000000052', 'd1560000-0000-4000-8000-000000000001', 'doctor', 'facility',
   'd1560000-0000-4000-8000-000000000042', 'd1560000-0000-4000-8000-000000000022', 'Synthetic release switch test'),
  ('d1560000-0000-4000-8000-000000000053', 'd1560000-0000-4000-8000-000000000002', 'pharmacist', 'facility',
   'd1560000-0000-4000-8000-000000000043', 'd1560000-0000-4000-8000-000000000021', 'Synthetic release switch test');

-- 1. Both functions as 0156 leaves them.
select pg_temp.expect('1a both functions: body, owner (the owner of ehr.catalog_versions), SECURITY DEFINER, STABLE, plpgsql, '
  || 'search_path, result',
  'ehr.catalog_diagnosis_listed(text,text) 28048d5d87de33e9f03e71a93024d214 owner definer s plpgsql '
  || '{"search_path=pg_catalog, pg_temp"} boolean | ehr.recent_diagnoses(integer) 034774a650aacf33a366e186d15cd5d7 '
  || 'owner definer s plpgsql {"search_path=pg_catalog, pg_temp"} TABLE(code_system text, code text, display text, '
  || 'last_used_at timestamp with time zone, use_count integer)',
  (select string_agg(format('%s %s %s %s %s %s %s %s', proc.oid::regprocedure, md5(proc.prosrc),
            case when proc.proowner = (select relation.relowner from pg_class relation
                                        where relation.oid = 'ehr.catalog_versions'::regclass)
                 then 'owner' else 'not the owner' end,
            case when proc.prosecdef then 'definer' else 'invoker' end, proc.provolatile, language_row.lanname,
            proc.proconfig, pg_get_function_result(proc.oid)), ' | ' order by proc.proname)
     from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
    where proc.oid in ('ehr.catalog_diagnosis_listed(text,text)'::regprocedure,
                       'ehr.recent_diagnoses(integer)'::regprocedure)));
select pg_temp.expect('1b EXECUTE on each: the EHR and schema test runtimes only (no PUBLIC, no other runtime)',
  'ehr.catalog_diagnosis_listed(text,text): hid_ehr_runtime hid_schema_test_runtime | '
  || 'ehr.recent_diagnoses(integer): hid_ehr_runtime hid_schema_test_runtime',
  (select string_agg(granted.line, ' | ' order by granted.line)
     from (select proc.oid::regprocedure || ': ' || string_agg(case when acl.grantee = 0 then 'PUBLIC'
                    else pg_get_userbyid(acl.grantee) end, ' ' order by pg_get_userbyid(acl.grantee)) as line
             from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
            where proc.oid in ('ehr.catalog_diagnosis_listed(text,text)'::regprocedure,
                               'ehr.recent_diagnoses(integer)'::regprocedure)
              and acl.grantee <> proc.proowner and acl.privilege_type = 'EXECUTE'
            group by proc.oid) granted));

-- 2. No release active (0152 loads none). The doctor's picks, oldest first.
select pg_temp.expect('2a no diagnosis release is active to start with', '0',
  (select count(*)::text from ehr.catalog_versions where kind = 'diagnosis' and active));
select pg_temp.as_member('staff:156-doctor', 'd1560000-0000-4000-8000-000000000041', 'd1560000-0000-4000-8000-000000000021');
set local role hid_ehr_runtime;
select ehr.record_recent_diagnosis(pick.code_system, pick.code, pick.display), pg_sleep(0.01)
  from (values (1, 'ICD-11', '1F40', 'Falciparum malaria'), (2, 'ICD-10', 'A01.0', 'Typhoid fever'),
               (3, 'ICD-11', '1F40&XS25', 'Falciparum malaria, severe'), (4, 'ICD-11', '1A07', 'Enteric fever'),
               (5, 'ICD-11', '5A11', 'Type 2 diabetes'), (6, 'ICD-11', '1f40', 'malaria typed in lower case'))
       pick(n, code_system, code, display)
 order by pick.n;
select ehr.record_recent_diagnosis('ICD-11', '1F40', 'Falciparum malaria');
select pg_sleep(0.01);
select ehr.record_recent_diagnosis('ICD-11', '1f40', 'malaria typed in lower case');
select pg_temp.expect('2b no release: every pick as stored, newest first (ICD-10, post-coordinated and unknown codes '
  || 'included)',
  'ICD-11:1f40(malaria typed in lower case)x2 ICD-11:1F40(Falciparum malaria)x2 ICD-11:5A11(Type 2 diabetes)x1 '
  || 'ICD-11:1A07(Enteric fever)x1 ICD-11:1F40&XS25(Falciparum malaria, severe)x1 ICD-10:A01.0(Typhoid fever)x1',
  pg_temp.recent());
select pg_temp.expect('2c no release: the listed check is null for every code system and code',
  'null null null null', pg_temp.listed(array[['ICD-11', '1F40'], ['ICD-11', '5A11'], ['ICD-10', 'A01.0'],
    ['ICD-11', '1F40&XS25']]));
reset role;

-- 3. The first release (2026-01) loaded and switched on.
insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approvals_sha256, approved_at)
  values
  ('d1560000-0000-4000-8000-000000000101', 'diagnosis', '2026-01', repeat('d', 64), 'synthetic sign-off reference',
   repeat('1', 64), now()),
  ('d1560000-0000-4000-8000-000000000102', 'diagnosis', '2027-01', repeat('e', 64), 'synthetic next sign-off',
   repeat('2', 64), now());
insert into ehr.catalog_diagnoses (version_id, code, title, chapter) values
  ('d1560000-0000-4000-8000-000000000101', '1F40', 'Malaria due to Plasmodium falciparum', '01'),
  ('d1560000-0000-4000-8000-000000000101', '1A07', 'Typhoid fever', '01'),
  ('d1560000-0000-4000-8000-000000000101', 'BA00', 'Essential hypertension', '11'),
  -- The next release: 1F40 retitled, 1A07 dropped, 5A11 added (synthetic changes).
  ('d1560000-0000-4000-8000-000000000102', '1F40', 'Malaria due to Plasmodium falciparum (next release title)', '01'),
  ('d1560000-0000-4000-8000-000000000102', 'BA00', 'Essential hypertension', '11'),
  ('d1560000-0000-4000-8000-000000000102', '5A11', 'Type 2 diabetes mellitus', '05');
update ehr.catalog_versions set active = true where id = 'd1560000-0000-4000-8000-000000000101';
set local role hid_ehr_runtime;
select pg_temp.expect('3a a release active: a plain ICD-11 pick takes its title; a post-coordinated one keeps its '
  || 'display; an ICD-11 code it does not hold (5A11, lower-case 1f40) is left out; ICD-10 as stored',
  'ICD-11:1F40(Malaria due to Plasmodium falciparum)x2 ICD-11:1A07(Typhoid fever)x1 '
  || 'ICD-11:1F40&XS25(Falciparum malaria, severe)x1 ICD-10:A01.0(Typhoid fever)x1',
  pg_temp.recent());
select pg_temp.expect('3b the limit applies after picks are left out (the two newest are left out)',
  'ICD-11:1F40(Malaria due to Plasmodium falciparum)x2 ICD-11:1A07(Typhoid fever)x1', pg_temp.recent(2));
select pg_temp.expect('3c listed: true or false for ICD-11 (a post-coordinated code on its first code, spaces '
  || 'trimmed); null for any other code system, a null code or a null code system',
  'true false true true true false false null null null null null',
  pg_temp.listed(array[['ICD-11', '1F40'], ['ICD-11', '5A11'], ['ICD-11', '1F40&XS25'], ['ICD-11', ' 1A07 / BA00'],
    ['ICD-11', 'BA00&XT8W'], ['ICD-11', 'XS25&1F40'], ['ICD-11', '1f40'], ['ICD-10', 'A01.0'], ['ICD-10', '1F40'],
    ['icd-11', '1F40'], ['ICD-11', null], [null, '1F40']]));
select pg_temp.expect('3d the record is unchanged: a pick the release does not hold is still recorded and counted',
  'ICD-11:1F40(Malaria due to Plasmodium falciparum)x2 ICD-11:1A07(Typhoid fever)x1',
  (select pg_temp.recent(2) from (select ehr.record_recent_diagnosis('ICD-11', '5A11', 'Type 2 diabetes')) recorded));
reset role;
select pg_temp.expect('3e ... it is held, with its count, while the read leaves it out', 'Type 2 diabetes x2',
  (select display || ' x' || use_count from ehr.clinician_recent_diagnoses
    where membership_id = 'd1560000-0000-4000-8000-000000000041' and code_system = 'ICD-11' and code = '5A11'));

-- 4. The switch to the next release.
update ehr.catalog_versions set active = false where kind = 'diagnosis' and active;
update ehr.catalog_versions set active = true where id = 'd1560000-0000-4000-8000-000000000102';
set local role hid_ehr_runtime;
select pg_temp.expect('4a after the switch: the new title, the dropped code (1A07) left out, the added one (5A11) back',
  'ICD-11:5A11(Type 2 diabetes mellitus)x2 ICD-11:1F40(Malaria due to Plasmodium falciparum (next release title))x2 '
  || 'ICD-11:1F40&XS25(Falciparum malaria, severe)x1 ICD-10:A01.0(Typhoid fever)x1',
  pg_temp.recent());
select pg_temp.expect('4b the listed check follows the switch', 'false true true null',
  pg_temp.listed(array[['ICD-11', '1A07'], ['ICD-11', '5A11'], ['ICD-11', '1F40&XS25'], ['ICD-10', 'A01.0']]));
reset role;

-- 5. No release active again.
update ehr.catalog_versions set active = false where kind = 'diagnosis' and active;
set local role hid_ehr_runtime;
select pg_temp.expect('5a the release switched off: every pick as stored again',
  'ICD-11:5A11(Type 2 diabetes)x2 ICD-11:1f40(malaria typed in lower case)x2 ICD-11:1F40(Falciparum malaria)x2 '
  || 'ICD-11:1A07(Enteric fever)x1 ICD-11:1F40&XS25(Falciparum malaria, severe)x1 ICD-10:A01.0(Typhoid fever)x1',
  pg_temp.recent());
select pg_temp.expect('5b ... and the listed check null', 'null null',
  pg_temp.listed(array[['ICD-11', '1F40'], ['ICD-11', '1A07']]));
reset role;

-- 6. As before 0156, under a release.
update ehr.catalog_versions set active = true where id = 'd1560000-0000-4000-8000-000000000102';
select pg_temp.as_member('staff:156-pharmacist', 'd1560000-0000-4000-8000-000000000043',
  'd1560000-0000-4000-8000-000000000021');
set local role hid_ehr_runtime;
select ehr.record_recent_diagnosis('ICD-11', '1F40', 'Falciparum malaria');
select pg_temp.expect('6a a member without ehr.diagnosis.write reads and records nothing', '', pg_temp.recent());
select pg_temp.as_member('staff:156-doctor', 'd1560000-0000-4000-8000-000000000042', 'd1560000-0000-4000-8000-000000000022');
select pg_temp.expect('6b the same doctor at another facility (another membership) reads nothing of the first', '',
  pg_temp.recent());
select pg_temp.as_member('', '', '');
select pg_temp.expect('6c no session reads nothing', '', pg_temp.recent());
select pg_temp.as_member('staff:156-doctor', 'd1560000-0000-4000-8000-000000000041', 'd1560000-0000-4000-8000-000000000021');
select pg_temp.expect('6d the limit is 1-50', '22023 RECENT_DIAGNOSES_INVALID|22023 RECENT_DIAGNOSES_INVALID|22023 '
  || 'RECENT_DIAGNOSES_INVALID|1',
  pg_temp.refusal('select * from ehr.recent_diagnoses(0)') || '|' || pg_temp.refusal('select * from ehr.recent_diagnoses(51)')
  || '|' || pg_temp.refusal('select * from ehr.recent_diagnoses(null)') || '|'
  || (select count(*) from ehr.recent_diagnoses(1)));
select pg_temp.expect('6e the EHR runtime reads no catalogue table', '42501 42501',
  left(pg_temp.refusal('select count(*) from ehr.catalog_diagnoses'), 5) || ' '
  || left(pg_temp.refusal('select count(*) from ehr.catalog_versions'), 5));
reset role;
set local role hid_pharmacy_runtime;
select pg_temp.expect('6f the pharmacy runtime may run neither function', '42501 42501',
  left(pg_temp.refusal($q$select ehr.catalog_diagnosis_listed('ICD-11', '1F40')$q$), 5) || ' '
  || left(pg_temp.refusal('select * from ehr.recent_diagnoses(10)'), 5));
reset role;
select pg_temp.expect('6g nothing was written to the diagnosis tables by the reads', '0 0',
  (select (n_tup_ins + n_tup_upd + n_tup_del)::text from pg_stat_xact_user_tables
    where relid = 'ehr.diagnoses'::regclass) || ' '
  || (select (n_tup_ins + n_tup_upd + n_tup_del)::text from pg_stat_xact_user_tables
       where relid = 'ehr.lab_requests'::regclass));

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, actual), E'\n' order by seq) into failures
    from release_cases where expected is distinct from actual;
  if failures is not null then
    raise exception E'0156 diagnosis release switch suite failed:\n%', failures;
  end if;
  raise notice '0156 diagnosis release switch suite: % cases passed', (select count(*) from release_cases);
end $$;
rollback;
