\set ON_ERROR_STOP on
-- 0119: OCR learning rules. Rollback-only. Every person, facility and
-- document here is made up (Rules Test Clinic A/B, fictional staff).
--
-- Proves, as the exact runtime roles (hid_ocr_api_runtime for the OCR API,
-- hid_identity_api_runtime for the admin console) with the session settings
-- each service sets:
--   - the security properties, EXECUTE grants, forced row-level security and
--     the absence of any table privilege for a runtime role;
--   - switch-on: a facility rule after 5 identical corrections from 3 staff at
--     that facility with no conflict; none with a conflicting (NULL) row, with
--     two different values, with 2 staff only, or with evidence older than
--     180 days; a platform rule from 5 corrections, 3 staff and 2 facilities
--     combined (and no facility rule from the part at one facility); a
--     replay switches nothing on twice;
--   - suggestions: the facility's rule first, else the platform's; another
--     facility sees only the platform's; a rule set switched off is left
--     out (a facility switched off shows nothing, the platform's rules
--     included); malformed keys, a session without a membership and a membership
--     without ocr.job.read are refused;
--   - showings: recorded once per rule and validation; a rule retires when 3
--     of its last 10 showings were not taken; it re-arms only from evidence
--     after its retirement; showings of an unknown rule, another facility's
--     rule, a bad outcome or shape are refused with nothing written;
--   - the kill switch: only a platform super admin in a platform session
--     with healthcare-operations sets it, with a platform audit row; others,
--     bad input and an unknown facility are refused; the overview gives
--     counts to platform administrators only;
--   - the platform summary: item and review rows per ISO week, facility and
--     prompt version, groups under 20 suppressed, codes outside the code
--     pattern counted as other, an audit row with counts; refused without
--     platform.operations.read, from a facility session, and for a bad range.
begin;

-- Security properties.
do $$
declare
  mismatch text;
  ocr_owner oid := (select relowner from pg_class where oid = 'ocr.jobs'::regclass);
begin
  select string_agg(format('%s: definer=%s owner=%s', p.oid::regprocedure, p.prosecdef, p.proowner::regrole), '; ')
    into mismatch
    from pg_proc p
    join (values
      ('ocr.learning_after_validation(uuid,jsonb)'::regprocedure, true),
      ('ocr.reading_suggestions(jsonb)'::regprocedure, true),
      ('ocr.set_learning_switch(text,uuid,boolean,text)'::regprocedure, true),
      ('ocr.learning_overview()'::regprocedure, true),
      ('ocr.review_outcome_summary(date,date)'::regprocedure, true),
      ('ocr.purge_learning_showings(integer)'::regprocedure, true),
      ('ocr.learning_evaluate(text,bytea)'::regprocedure, false))
      expected(proc, definer) on p.oid = expected.proc
   where p.prosecdef <> expected.definer or p.proowner <> ocr_owner
      or p.proconfig is null or p.proconfig[1] not like 'search_path=pg_catalog, ocr, %';
  if mismatch is not null then
    raise exception '0119 command security properties differ: %', mismatch;
  end if;
  select string_agg(format('%s to %s', p.oid::regprocedure, coalesce(grantee.rolname, 'PUBLIC')), '; ')
    into mismatch
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
    left join pg_roles grantee on grantee.oid = privilege.grantee
   where p.pronamespace = 'ocr'::regnamespace
     and p.proname in ('learning_evaluate', 'learning_after_validation', 'reading_suggestions',
       'set_learning_switch', 'learning_overview', 'review_outcome_summary', 'purge_learning_showings')
     and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner
     and (p.proname, coalesce(grantee.rolname, 'PUBLIC')) not in (
       ('learning_after_validation', 'hid_ocr_runtime'), ('reading_suggestions', 'hid_ocr_runtime'),
       ('set_learning_switch', 'hid_identity_runtime'), ('learning_overview', 'hid_identity_runtime'),
       ('review_outcome_summary', 'hid_identity_runtime'), ('purge_learning_showings', 'hid_ocr_worker'));
  if mismatch is not null then
    raise exception 'unexpected EXECUTE grants on the 0119 commands: %', mismatch;
  end if;
  if (select count(*) from pg_proc p, aclexplode(p.proacl) privilege
       where p.pronamespace = 'ocr'::regnamespace and privilege.privilege_type = 'EXECUTE'
         and (p.proname, privilege.grantee::regrole::text) in (
           ('learning_after_validation', 'hid_ocr_runtime'), ('reading_suggestions', 'hid_ocr_runtime'),
           ('set_learning_switch', 'hid_identity_runtime'), ('learning_overview', 'hid_identity_runtime'),
           ('review_outcome_summary', 'hid_identity_runtime'), ('purge_learning_showings', 'hid_ocr_worker'))) <> 6 then
    raise exception 'the 0119 EXECUTE grants are incomplete';
  end if;
  select string_agg(format('%s %s %s', role_row.rolname, privilege, table_name), '; ') into mismatch
    from pg_roles role_row
    cross join unnest(array['ocr.learning_rules', 'ocr.learning_rule_showings', 'ocr.learning_switches']) table_name
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege
   where role_row.rolname like 'hid\_%' and not role_row.rolsuper
     and not pg_has_role(role_row.oid, (select relowner from pg_class where oid = table_name::regclass), 'MEMBER')
     and has_table_privilege(role_row.oid, table_name, privilege);
  if mismatch is not null then
    raise exception 'a runtime role has a privilege on a 0119 table: %', mismatch;
  end if;
  if (select count(*) from pg_class c
       where c.oid in ('ocr.learning_rules'::regclass, 'ocr.learning_rule_showings'::regclass,
                       'ocr.learning_switches'::regclass)
         and c.relrowsecurity and c.relforcerowsecurity
         and not exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                          where a.grantee <> c.relowner)
         and (select count(*) from pg_policy p where p.polrelid = c.oid) = 1) <> 3 then
    raise exception 'the 0119 tables must force row-level security, grant nothing and have one owner policy';
  end if;
end $$;

-- Fixtures (triggers and references skipped while they are inserted).
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('d1190000-0000-4000-8000-000000000001', 'Rules Test Organization', 'rules-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('d1190000-0000-4000-8000-00000000000a', 'd1190000-0000-4000-8000-000000000001', 'Rules Test Clinic A',
   'RULES-A', 'Africa/Lagos', true, 'verified'),
  ('d1190000-0000-4000-8000-00000000000b', 'd1190000-0000-4000-8000-000000000001', 'Rules Test Clinic B',
   'RULES-B', 'Africa/Lagos', true, 'verified');
-- Staff 1-6 (1 doctor A, 2 nurse A, 3 lab A, 4 clinician A, 5 doctor B, 6
-- nurse B, 7 pharmacist A); platform accounts 8 super admin, 9 platform
-- admin, 10 support admin (no platform.operations.read).
insert into auth.accounts (id, subject, email, display_name, status)
select ('d1191000-0000-4000-8000-0000000000' || lpad(a.n::text, 2, '0'))::uuid, 'staff:rules-' || a.name,
       'rules-' || a.name || '@example.invalid', 'Rules ' || a.name, 'active'
  from (values (1, 'doctor-a'), (2, 'nurse-a'), (3, 'lab-a'), (4, 'clinician-a'), (5, 'doctor-b'), (6, 'nurse-b'),
               (7, 'pharmacist-a'), (8, 'super'), (9, 'platform-admin'), (10, 'support'), (11, 'worker'))
       a(n, name);
update auth.accounts set subject = 'workload:rules-worker' where id = 'd1191000-0000-4000-8000-000000000011';
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('d1192000-0000-4000-8000-0000000000' || lpad(m.n::text, 2, '0'))::uuid,
       ('d1191000-0000-4000-8000-0000000000' || lpad(m.n::text, 2, '0'))::uuid, 'Rules staff ' || m.n,
       'rules-staff-' || m.n || '@example.invalid', 'verified', m.role
  from (values (1, 'doctor'), (2, 'nurse'), (3, 'lab'), (4, 'clinician'), (5, 'doctor'), (6, 'nurse'),
               (7, 'pharmacist')) m(n, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, active)
select ('d1193000-0000-4000-8000-0000000000' || lpad(m.n::text, 2, '0'))::uuid,
       ('d1192000-0000-4000-8000-0000000000' || lpad(m.n::text, 2, '0'))::uuid,
       ('d1191000-0000-4000-8000-0000000000' || lpad(m.n::text, 2, '0'))::uuid, 'd1190000-0000-4000-8000-000000000001',
       ('d1190000-0000-4000-8000-00000000000' || m.facility)::uuid, m.role, m.role, true
  from (values (1, 'a', 'doctor'), (2, 'a', 'nurse'), (3, 'a', 'lab'), (4, 'a', 'clinician'), (5, 'b', 'doctor'),
               (6, 'b', 'nurse'), (7, 'a', 'pharmacist')) m(n, facility, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('d1194000-0000-4000-8000-0000000000' || lpad(m.n::text, 2, '0'))::uuid,
       ('d1191000-0000-4000-8000-0000000000' || lpad(m.n::text, 2, '0'))::uuid, m.role, 'facility',
       ('d1193000-0000-4000-8000-0000000000' || lpad(m.n::text, 2, '0'))::uuid,
       ('d1190000-0000-4000-8000-00000000000' || m.facility)::uuid, 'Synthetic rules test'
  from (values (1, 'a', 'doctor'), (2, 'a', 'nurse'), (3, 'a', 'lab'), (4, 'a', 'clinician'), (5, 'b', 'doctor'),
               (6, 'b', 'nurse'), (7, 'a', 'pharmacist')) m(n, facility, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d1194000-0000-4000-8000-000000000008', 'd1191000-0000-4000-8000-000000000008', 'platform_super_admin', 'platform', 'Synthetic rules test'),
  ('d1194000-0000-4000-8000-000000000009', 'd1191000-0000-4000-8000-000000000009', 'platform_admin', 'platform', 'Synthetic rules test'),
  ('d1194000-0000-4000-8000-000000000010', 'd1191000-0000-4000-8000-000000000010', 'support_admin', 'platform', 'Synthetic rules test'),
  ('d1194000-0000-4000-8000-000000000011', 'd1191000-0000-4000-8000-000000000011', 'ocr_worker', 'platform', 'Synthetic rules worker');
-- Validations 1-8 by the doctor at A and 9 by the doctor at B, all accepted
-- now (references skipped: the job and extraction ids are made up).
insert into ocr.validations (id, job_id, facility_id, extraction_id, validation_version, validated_payload,
  corrections, reason, validated_by, validated_by_membership_id, disposition, target_domain, candidate_type,
  accepted_fields, rejected_fields, provenance, idempotency_key, request_sha256)
select ('d1195000-0000-4000-8000-00000000000' || n)::uuid, gen_random_uuid(),
       case when n = 9 then 'd1190000-0000-4000-8000-00000000000b' else 'd1190000-0000-4000-8000-00000000000a' end::uuid,
       gen_random_uuid(), 1, '{}'::jsonb, '[]'::jsonb, 'Reviewer checked the fictional page',
       case when n = 9 then 'd1191000-0000-4000-8000-000000000005' else 'd1191000-0000-4000-8000-000000000001' end::uuid,
       case when n = 9 then 'd1193000-0000-4000-8000-000000000005' else 'd1193000-0000-4000-8000-000000000001' end::uuid,
       'validated', 'PHARMACY', 'historical_medication_evidence', '{}'::jsonb, '[]'::jsonb,
       '{"source":"human_review"}'::jsonb, 'rules-validation-' || n || 'xxxxxx', repeat('b', 64)
  from generate_series(1, 9) n;
-- Earlier evidence (keys K1-K6 are the digests 11..11 to 66..66).
create function pg_temp.staff_key(account text) returns bytea language sql as $$
  select public.hmac(convert_to(account, 'UTF8'), (select key from ocr.learning_key where id = 1), 'sha256')
$$;
-- The keyed digest 0118 stores for the key the OCR API sends as repeat(n, 64).
create function pg_temp.k(n integer) returns bytea language sql as $$
  select public.hmac(decode(repeat(n::text, 64), 'hex'), (select key from ocr.learning_key where id = 1), 'sha256')
$$;
create function pg_temp.vkey(validation text) returns bytea language sql as $$
  select public.hmac(convert_to(validation, 'UTF8'), (select key from ocr.learning_key where id = 1), 'sha256')
$$;
insert into ocr.correction_observations (facility_id, field_class, read_digest, suggest_value, staff_key,
  validation_key, observed_at)
select ('d1190000-0000-4000-8000-00000000000' || e.facility)::uuid, 'name', pg_temp.k(e.k), e.value,
       pg_temp.staff_key('d1191000-0000-4000-8000-00000000000' || e.staff),
       public.digest(gen_random_uuid()::text, 'sha256'),
       clock_timestamp() - e.age
  from (values
    -- K1: 4 at A from nurse (2), lab, clinician: with the doctor's, a facility rule.
    (1, 'a', 2, 'Amoxicillin', interval '1 day'), (1, 'a', 2, 'Amoxicillin', interval '2 days'),
    (1, 'a', 3, 'Amoxicillin', interval '1 day'), (1, 'a', 4, 'Amoxicillin', interval '1 day'),
    -- K2: enough, but one conflicting correction.
    (2, 'a', 2, 'Amoxicillin', interval '1 day'), (2, 'a', 3, 'Amoxicillin', interval '1 day'),
    (2, 'a', 4, 'Amoxicillin', interval '1 day'), (2, 'a', 2, 'Amoxicillin', interval '2 days'),
    (2, 'a', 3, null, interval '1 day'),
    -- K3: two different values.
    (3, 'a', 2, 'Amoxicillin', interval '1 day'), (3, 'a', 3, 'Amoxicillin', interval '1 day'),
    (3, 'a', 4, 'Ampicillin', interval '1 day'), (3, 'a', 2, 'Ampicillin', interval '2 days'),
    -- K4: 5 from the nurse alone (2 staff with the doctor's).
    (4, 'a', 2, 'Amoxicillin', interval '1 day'), (4, 'a', 2, 'Amoxicillin', interval '2 days'),
    (4, 'a', 2, 'Amoxicillin', interval '3 days'), (4, 'a', 2, 'Amoxicillin', interval '4 days'),
    (4, 'a', 2, 'Amoxicillin', interval '5 days'),
    -- K5: enough, but older than 180 days.
    (5, 'a', 2, 'Amoxicillin', interval '181 days'), (5, 'a', 3, 'Amoxicillin', interval '181 days'),
    (5, 'a', 4, 'Amoxicillin', interval '181 days'), (5, 'a', 2, 'Amoxicillin', interval '182 days'),
    -- K6: 2 at A and 2 at B: with the doctor's, a platform rule only.
    (6, 'a', 2, 'Paracetamol', interval '1 day'), (6, 'a', 3, 'Paracetamol', interval '1 day'),
    (6, 'b', 6, 'Paracetamol', interval '1 day'), (6, 'b', 6, 'Paracetamol', interval '2 days'))
    e(k, facility, staff, value, age);
set local session_replication_role = origin;

create temporary table rules_cases (name text primary key, expected text, actual text) on commit drop;
grant all on rules_cases to public;
create function pg_temp.rules_try(case_name text, statement text, expected text) returns void
language plpgsql as $$
declare
  outcome text := 'ok';
begin
  begin
    execute statement;
  exception when others then
    outcome := sqlstate;
  end;
  insert into rules_cases (name, expected, actual) values (case_name, expected, outcome);
end $$;
create function pg_temp.rules_check(case_name text, ok boolean) returns void language plpgsql as $$
begin
  insert into rules_cases (name, expected, actual) values (case_name, 'true', coalesce(ok, false)::text);
end $$;
create function pg_temp.as_staff(n integer, facility text) returns void language sql as $$
  select set_config('app.actor_subject', 'staff:rules-' || (array['doctor-a', 'nurse-a', 'lab-a', 'clinician-a', 'doctor-b', 'nurse-b',
           'pharmacist-a', 'super', 'platform-admin', 'support'])[n], true),
    set_config('app.facility_id', 'd1190000-0000-4000-8000-00000000000' || facility, true),
    set_config('app.membership_id', 'd1193000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'), true),
    set_config('app.correlation_id', 'rules-suite-staff', true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
$$;
create function pg_temp.as_platform(n integer, purpose text default 'healthcare-operations') returns void
language sql as $$
  select set_config('app.actor_subject', 'staff:rules-' || (array['doctor-a', 'nurse-a', 'lab-a', 'clinician-a', 'doctor-b', 'nurse-b',
           'pharmacist-a', 'super', 'platform-admin', 'support'])[n], true),
    set_config('app.facility_id', '', true), set_config('app.membership_id', '', true),
    set_config('app.correlation_id', 'rules-suite-platform', true), set_config('app.purpose_of_use', purpose, true);
$$;
-- The key list of a reading, as the OCR API sends it.
create function pg_temp.keys(variadic ks integer[]) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('field', 'name', 'readDigest', repeat(k::text, 64))), '[]'::jsonb)
    from unnest(ks) k
$$;
create function pg_temp.observations(value text, variadic ks integer[]) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('field', 'name', 'readDigest', repeat(k::text, 64), 'suggestValue', value))
    from unnest(ks) k
$$;
-- (SECURITY DEFINER: the suite's owner looks the rule up for the runtime-role sections.)
create function pg_temp.rule_of(scope text, k integer, facility text default null) returns uuid language sql
security definer as $$
  select id from ocr.learning_rules
   where learning_rules.scope = rule_of.scope and read_digest = pg_temp.k(k) and status = 'active'
     and facility_id is not distinct from ('d1190000-0000-4000-8000-00000000000' || facility)::uuid
$$;
grant execute on all functions in schema pg_temp to public;

-- A. Switch-on: the doctor at A saves V1 with K1-K6.
set local role hid_ocr_api_runtime;
select pg_temp.as_staff(1, 'a');
select pg_temp.rules_check('V1 observations recorded',
  ocr.record_correction_observations('d1195000-0000-4000-8000-000000000001',
    pg_temp.observations('Amoxicillin', 1, 2, 3, 4, 5) || pg_temp.observations('Paracetamol', 6)) = 6);
select pg_temp.rules_check('two rules switch on',
  ocr.learning_after_validation('d1195000-0000-4000-8000-000000000001', '[]') =
    '{"showings":0,"retired":0,"activated":2}'::jsonb);
select pg_temp.rules_check('a replay switches nothing on twice',
  ocr.learning_after_validation('d1195000-0000-4000-8000-000000000001', '[]') ->> 'activated' = '0');
reset role;
select pg_temp.rules_check('K1: a facility rule at A, from 5 corrections and 4 staff',
  (select count(*) = 1 and bool_and(suggest_value = 'Amoxicillin' and supporting_corrections = 5
            and supporting_staff = 4 and supporting_facilities = 1)
     from ocr.learning_rules where read_digest = pg_temp.k(1) and scope = 'facility'
      and facility_id = 'd1190000-0000-4000-8000-00000000000a'));
select pg_temp.rules_check('K2 (a conflict), K3 (two values), K4 (2 staff), K5 (old evidence): no rule',
  not exists (select 1 from ocr.learning_rules where read_digest in (pg_temp.k(2), pg_temp.k(3), pg_temp.k(4),
    pg_temp.k(5))));
select pg_temp.rules_check('K6: a platform rule from 2 facilities, and no facility rule',
  (select count(*) = 1 and bool_and(scope = 'platform' and facility_id is null and suggest_value = 'Paracetamol'
            and supporting_facilities = 2 and supporting_staff = 4)
     from ocr.learning_rules where read_digest = pg_temp.k(6)));

-- B. Suggestions. A platform rule for K1 too (another value), to show the
-- facility's rule goes first.
set local session_replication_role = replica;
insert into ocr.learning_rules (scope, facility_id, field_class, read_digest, suggest_value,
  supporting_corrections, supporting_staff, supporting_facilities)
values ('platform', null, 'name', pg_temp.k(1), 'Ampicillin', 5, 3, 2);
set local session_replication_role = origin;
set local role hid_ocr_api_runtime;
select pg_temp.as_staff(1, 'a');
select pg_temp.rules_check('at A: K1 the facility rule, K6 the platform rule, K2 none',
  (select count(*) = 2
          and count(*) filter (where read_digest = repeat('1', 64) and scope = 'facility'
                                 and suggest_value = 'Amoxicillin') = 1
          and count(*) filter (where read_digest = repeat('6', 64) and scope = 'platform'
                                 and suggest_value = 'Paracetamol') = 1
     from ocr.reading_suggestions(pg_temp.keys(1, 6, 2))));
select pg_temp.rules_check('no key, no suggestion', not exists (select 1 from ocr.reading_suggestions('[]')));
select pg_temp.rules_try('keys not an array', $q$select * from ocr.reading_suggestions('{}')$q$, '22023');
select pg_temp.rules_try('a key with an extra member',
  $q$select * from ocr.reading_suggestions('[{"field":"name","readDigest":"1111111111111111111111111111111111111111111111111111111111111111","text":"x"}]')$q$,
  '22023');
select pg_temp.rules_try('501 keys',
  $q$select * from ocr.reading_suggestions((select jsonb_agg(jsonb_build_object('field','name','readDigest',lpad(to_hex(n),64,'0'))) from generate_series(1,501) n))$q$,
  '22023');
select pg_temp.as_staff(5, 'b');
select pg_temp.rules_check('at B: K1 the platform rule only, K6 the platform rule',
  (select count(*) = 2 and bool_and(scope = 'platform')
          and count(*) filter (where read_digest = repeat('1', 64) and suggest_value = 'Ampicillin') = 1
     from ocr.reading_suggestions(pg_temp.keys(1, 6))));
select pg_temp.as_staff(7, 'a');
select pg_temp.rules_try('a pharmacist without ocr.job.read',
  $q$select * from ocr.reading_suggestions('[]')$q$, '42501');
select set_config('app.membership_id', '', true);
select pg_temp.rules_try('a session without a membership', $q$select * from ocr.reading_suggestions('[]')$q$, '42501');
select pg_temp.rules_try('the OCR API reads no rule table', $q$select count(*) from ocr.learning_rules$q$, '42501');
select pg_temp.rules_try('the OCR API sets no switch',
  $q$select ocr.set_learning_switch('platform', null, false, 'x')$q$, '42501');
reset role;

-- The kill switches (Identity API, platform sessions).
set local role hid_identity_api_runtime;
select pg_temp.as_platform(8);
select pg_temp.rules_try('the super admin turns clinic A''s rules off',
  $q$select ocr.set_learning_switch('facility', 'd1190000-0000-4000-8000-00000000000a', false, 'Fictional pause at A')$q$,
  'ok');
reset role;
set local role hid_ocr_api_runtime;
select pg_temp.as_staff(1, 'a');
select pg_temp.rules_check('A off: nothing at A, the platform''s rules included',
  not exists (select 1 from ocr.reading_suggestions(pg_temp.keys(1, 6))));
select pg_temp.as_staff(5, 'b');
select pg_temp.rules_check('A off: B still sees the platform''s rules',
  (select count(*) = 2 and bool_and(scope = 'platform') from ocr.reading_suggestions(pg_temp.keys(1, 6))));
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(8);
select pg_temp.rules_try('the super admin turns the platform''s rules off',
  $q$select ocr.set_learning_switch('platform', null, false, 'Fictional platform pause')$q$, 'ok');
reset role;
set local role hid_ocr_api_runtime;
select pg_temp.as_staff(1, 'a');
select pg_temp.rules_check('A and platform off: nothing at A',
  not exists (select 1 from ocr.reading_suggestions(pg_temp.keys(1, 6))));
select pg_temp.as_staff(5, 'b');
select pg_temp.rules_check('platform off: nothing at B', not exists (select 1 from ocr.reading_suggestions(pg_temp.keys(1, 6))));
reset role;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(8);
select pg_temp.rules_try('both on again (1)',
  $q$select ocr.set_learning_switch('platform', null, true, 'Fictional resume')$q$, 'ok');
select pg_temp.rules_try('both on again (2)',
  $q$select ocr.set_learning_switch('facility', 'd1190000-0000-4000-8000-00000000000a', true, 'Fictional resume')$q$,
  'ok');
select pg_temp.rules_try('scope facility without a facility',
  $q$select ocr.set_learning_switch('facility', null, false, 'x')$q$, '22023');
select pg_temp.rules_try('scope platform with a facility',
  $q$select ocr.set_learning_switch('platform', 'd1190000-0000-4000-8000-00000000000a', false, 'x')$q$, '22023');
select pg_temp.rules_try('an empty reason', $q$select ocr.set_learning_switch('platform', null, false, ' ')$q$, '22023');
select pg_temp.rules_try('an unknown facility',
  $q$select ocr.set_learning_switch('facility', gen_random_uuid(), false, 'x')$q$, 'P0002');
select pg_temp.as_platform(8, 'direct-care');
select pg_temp.rules_try('another purpose', $q$select ocr.set_learning_switch('platform', null, false, 'x')$q$, '42501');
select pg_temp.as_platform(9);
select pg_temp.rules_try('a platform admin may not set it',
  $q$select ocr.set_learning_switch('platform', null, false, 'x')$q$, '42501');
select pg_temp.rules_check('the platform admin reads the overview (platform and A)',
  (select count(*) filter (where scope = 'platform' and enabled and active_rules = 2) = 1
          and count(*) filter (where scope = 'facility' and facility_id = 'd1190000-0000-4000-8000-00000000000a'
                                 and enabled and active_rules = 1) = 1
     from ocr.learning_overview()));
select pg_temp.as_platform(10);
select pg_temp.rules_check('a support admin reads the overview', (select count(*) >= 2 from ocr.learning_overview()));
select pg_temp.as_staff(1, 'a');
select pg_temp.rules_try('a facility session reads no overview', $q$select * from ocr.learning_overview()$q$, '42501');
select pg_temp.rules_try('a facility session sets no switch',
  $q$select ocr.set_learning_switch('platform', null, false, 'x')$q$, '42501');
reset role;
select pg_temp.rules_check('four switch audit rows, platform-scoped, no text but the reason',
  (select count(*) = 4 and bool_and(actor_type = 'platform' and facility_id is null and actor_membership_id is null
            and details ?& array['scope', 'enabled', 'previousEnabled'])
     from audit.events where action = 'admin.ocr.learning-switch.set' and correlation_id = 'rules-suite-platform'));

-- C. Showings and retirement of the K1 facility rule (R1): 9 earlier
-- showings, 2 of them not taken.
set local session_replication_role = replica;
insert into ocr.learning_rule_showings (rule_id, validation_key, facility_id, outcome, shown_at)
select pg_temp.rule_of('facility', 1, 'a'), public.digest(gen_random_uuid()::text, 'sha256'),
       'd1190000-0000-4000-8000-00000000000a',
       case when n in (2, 5) then 'rejected' else 'accepted' end, clock_timestamp() - n * interval '1 hour'
  from generate_series(1, 9) n;
set local session_replication_role = origin;
create temporary table rules_r1 on commit drop as select pg_temp.rule_of('facility', 1, 'a') as id;
grant select on rules_r1 to public;
set local role hid_ocr_api_runtime;
select pg_temp.as_staff(1, 'a');
select pg_temp.rules_check('taken: recorded, not retired',
  ocr.learning_after_validation('d1195000-0000-4000-8000-000000000002',
    jsonb_build_array(jsonb_build_object('ruleId', (select id from rules_r1), 'outcome', 'accepted')))
  = '{"showings":1,"retired":0,"activated":0}'::jsonb);
select pg_temp.rules_check('a platform rule shown at A is recorded too',
  ocr.learning_after_validation('d1195000-0000-4000-8000-000000000002',
    jsonb_build_array(jsonb_build_object('ruleId', pg_temp.rule_of('platform', 6), 'outcome', 'accepted')))
  ->> 'showings' = '1');
select pg_temp.rules_check('not taken a third time in the last 10: retired',
  ocr.learning_after_validation('d1195000-0000-4000-8000-000000000003',
    jsonb_build_array(jsonb_build_object('ruleId', (select id from rules_r1), 'outcome', 'rejected')))
  = '{"showings":1,"retired":1,"activated":0}'::jsonb);
select pg_temp.rules_check('a replay records nothing',
  ocr.learning_after_validation('d1195000-0000-4000-8000-000000000003',
    jsonb_build_array(jsonb_build_object('ruleId', (select id from rules_r1), 'outcome', 'rejected')))
  ->> 'showings' = '0');
select pg_temp.rules_check('at A K1 is now the platform rule',
  (select scope = 'platform' from ocr.reading_suggestions(pg_temp.keys(1))));
-- Re-arm only from evidence after the retirement: one more correction is not enough.
select pg_temp.rules_check('V4 records K1 again',
  ocr.record_correction_observations('d1195000-0000-4000-8000-000000000004', pg_temp.observations('Amoxicillin', 1)) = 1);
select pg_temp.rules_check('old evidence does not re-arm it',
  ocr.learning_after_validation('d1195000-0000-4000-8000-000000000004', '[]') ->> 'activated' = '0');
reset role;
set local session_replication_role = replica;
insert into ocr.correction_observations (facility_id, field_class, read_digest, suggest_value, staff_key,
  validation_key)
select 'd1190000-0000-4000-8000-00000000000a', 'name', pg_temp.k(1), 'Amoxicillin',
       pg_temp.staff_key('d1191000-0000-4000-8000-00000000000' || staff), public.digest(gen_random_uuid()::text, 'sha256')
  from unnest(array[2, 3, 4]) staff;
set local session_replication_role = origin;
set local role hid_ocr_api_runtime;
select pg_temp.as_staff(1, 'a');
select pg_temp.rules_check('V5 records K1',
  ocr.record_correction_observations('d1195000-0000-4000-8000-000000000005', pg_temp.observations('Amoxicillin', 1)) = 1);
select pg_temp.rules_check('5 new corrections from 4 staff after the retirement re-arm it',
  ocr.learning_after_validation('d1195000-0000-4000-8000-000000000005', '[]') ->> 'activated' = '1');
-- Refused showings: nothing written.
select pg_temp.rules_try('an unknown rule',
  format($q$select ocr.learning_after_validation('d1195000-0000-4000-8000-000000000006', '[{"ruleId":"%s","outcome":"accepted"}]')$q$,
    gen_random_uuid()), '22023');
select pg_temp.rules_try('a bad outcome',
  format($q$select ocr.learning_after_validation('d1195000-0000-4000-8000-000000000006', '[{"ruleId":"%s","outcome":"maybe"}]')$q$,
    (select id from rules_r1)), '22023');
select pg_temp.rules_try('an extra member',
  format($q$select ocr.learning_after_validation('d1195000-0000-4000-8000-000000000006', '[{"ruleId":"%s","outcome":"accepted","value":"x"}]')$q$,
    (select id from rules_r1)), '22023');
select pg_temp.rules_try('201 showings',
  format($q$select ocr.learning_after_validation('d1195000-0000-4000-8000-000000000006', %L)$q$,
    (select jsonb_agg(jsonb_build_object('ruleId', (select id from rules_r1), 'outcome', 'accepted'))
       from generate_series(1, 201))::text), '22023');
select pg_temp.rules_try('another facility''s validation',
  $q$select ocr.learning_after_validation('d1195000-0000-4000-8000-000000000009', '[]')$q$, 'P0002');
reset role;
set local session_replication_role = replica;
insert into ocr.learning_rules (scope, facility_id, field_class, read_digest, suggest_value,
  supporting_corrections, supporting_staff, supporting_facilities)
values ('facility', 'd1190000-0000-4000-8000-00000000000b', 'name', pg_temp.k(7), 'Ibuprofen', 5, 3, 1);
set local session_replication_role = origin;
set local role hid_ocr_api_runtime;
select pg_temp.as_staff(1, 'a');
select pg_temp.rules_try('clinic B''s rule shown at A',
  format($q$select ocr.learning_after_validation('d1195000-0000-4000-8000-000000000006', '[{"ruleId":"%s","outcome":"accepted"}]')$q$,
    pg_temp.rule_of('facility', 7, 'b')), '22023');
reset role;
select pg_temp.rules_check('V6 wrote no showing',
  not exists (select 1 from ocr.learning_rule_showings
               where validation_key = pg_temp.vkey('d1195000-0000-4000-8000-000000000006')));

-- D. The worker purges showings older than 180 days (and only those).
set local session_replication_role = replica;
insert into ocr.learning_rule_showings (rule_id, validation_key, facility_id, outcome, shown_at)
select pg_temp.rule_of('platform', 6), public.digest(gen_random_uuid()::text, 'sha256'),
       'd1190000-0000-4000-8000-00000000000a', 'accepted', clock_timestamp() - interval '181 days'
  from generate_series(1, 2);
set local session_replication_role = origin;
create temporary table rules_showings_before on commit drop as select count(*) as n from ocr.learning_rule_showings;
grant select on rules_showings_before to public;
select set_config('app.actor_subject', 'workload:rules-worker', true), set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
set local role hid_ocr_worker;
select pg_temp.rules_check('the worker purges the 2 showings older than 180 days',
  ocr.purge_learning_showings(100) = 2);
select pg_temp.rules_try('a purge limit of 0', $q$select ocr.purge_learning_showings(0)$q$, '22023');
reset role;
select pg_temp.rules_check('younger showings are kept',
  (select count(*) from ocr.learning_rule_showings) = (select n - 2 from rules_showings_before));
select set_config('app.actor_subject', 'staff:rules-doctor-a', true);
set local role hid_ocr_api_runtime;
select pg_temp.rules_try('the OCR API cannot purge showings', $q$select ocr.purge_learning_showings(10)$q$, '42501');
reset role;

-- E. The platform summary: 25 outcomes at A (one bucket each, one with a
-- kind that is not a code), 3 at B.
set local session_replication_role = replica;
insert into ocr.validations (id, job_id, facility_id, extraction_id, validation_version, validated_payload,
  corrections, reason, validated_by, validated_by_membership_id, disposition, target_domain, candidate_type,
  accepted_fields, rejected_fields, provenance, idempotency_key, request_sha256)
select gen_random_uuid(), gen_random_uuid(),
       case when n > 25 then 'd1190000-0000-4000-8000-00000000000b' else 'd1190000-0000-4000-8000-00000000000a' end::uuid,
       gen_random_uuid(), 1, '{}'::jsonb, '[]'::jsonb, 'Reviewer checked the fictional page',
       'd1191000-0000-4000-8000-000000000001', 'd1193000-0000-4000-8000-000000000001', 'validated', 'PHARMACY',
       'historical_medication_evidence', '{}'::jsonb, '[]'::jsonb,
       jsonb_build_object('source', 'human_review', 'reviewOutcome', jsonb_build_object(
         'schema', 'hid.ocr.review-outcome/v1', 'disposition', 'validated', 'estimated', n % 5 = 0,
         'promptVersion', 'hid-paper-reading-prompt-13',
         'buckets', jsonb_build_array(jsonb_build_object('kind', case when n = 1 then 'Ngozi Name' else 'medicine' end,
           'decision', 'kept_unchanged', 'items', 1)))),
       'rules-summary-' || n || 'xxxxxxxxx', repeat('b', 64)
  from generate_series(1, 28) n;
set local session_replication_role = origin;
set local role hid_identity_api_runtime;
select pg_temp.as_platform(9);
create temporary table rules_summary on commit drop as
  select * from ocr.review_outcome_summary(current_date - 7, current_date);
reset role;
select pg_temp.rules_check('A: 24 medicine items kept unchanged, 25 reviews (5 estimated)',
  (select count(*) filter (where group_type = 'item' and kind = 'medicine' and measure = 'kept_unchanged'
                             and value = 24) = 1
          and count(*) filter (where group_type = 'review' and measure = 'reviews' and value = 25) = 1
          and count(*) filter (where group_type = 'review' and measure = 'estimated' and value = 5) = 1
     from rules_summary where facility_id = 'd1190000-0000-4000-8000-00000000000a'));
select pg_temp.rules_check('a kind that is not a code is other, and its group of 1 is suppressed',
  (select count(*) = 1 and bool_and(measure = 'suppressed' and value = 0) from rules_summary
    where facility_id = 'd1190000-0000-4000-8000-00000000000a' and kind = 'other'));
select pg_temp.rules_check('B (3 reviews) is suppressed, item and review',
  (select count(*) = 2 and bool_and(measure = 'suppressed') from rules_summary
    where facility_id = 'd1190000-0000-4000-8000-00000000000b'));
select pg_temp.rules_check('no row names text from a page', not exists (select 1 from rules_summary
  where kind like '%Ngozi%' or measure like '%Ngozi%'));
select pg_temp.rules_check('the read is audited with counts',
  (select count(*) = 1 and bool_and(actor_type = 'platform' and facility_id is null
            and (details ->> 'reviews')::integer >= 28 and details ? 'suppressedGroups')
     from audit.events where action = 'admin.ocr.quality-summary.read' and correlation_id = 'rules-suite-platform'));
set local role hid_identity_api_runtime;
select pg_temp.as_platform(10);
select pg_temp.rules_try('a support admin (no platform.operations.read)',
  $q$select * from ocr.review_outcome_summary(current_date - 7, current_date)$q$, '42501');
select pg_temp.as_platform(9);
select pg_temp.rules_try('105 days', $q$select * from ocr.review_outcome_summary(current_date - 104, current_date)$q$,
  '22023');
select pg_temp.rules_try('to before from', $q$select * from ocr.review_outcome_summary(current_date, current_date - 1)$q$,
  '22023');
select pg_temp.rules_try('a second read in the same transaction',
  $q$select * from ocr.review_outcome_summary(current_date - 7, current_date)$q$, 'ok');
select pg_temp.as_staff(1, 'a');
select pg_temp.rules_try('a facility session', $q$select * from ocr.review_outcome_summary(current_date - 7, current_date)$q$,
  '42501');
reset role;

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n') into failures
    from rules_cases where expected <> actual;
  if failures is not null then
    raise exception 'OCR learning rule cases failed:%', E'\n' || failures;
  end if;
  raise notice 'OCR learning rules: % cases passed', (select count(*) from rules_cases);
end $$;

rollback;
