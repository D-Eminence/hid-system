\set ON_ERROR_STOP on
-- Patient details on this facility's own lab and pharmacy work (0113, owner
-- decision 25 of 2026-11-01, D-Eminence: "all recommended except D5"; the
-- Akos handover backend plan, item 3a; D8 emergency included).
-- Rollback-only.
--
-- lab.work_item_patient_cards(ids) and pharmacy.work_item_patient_cards(ids)
-- answer the patient (name, sex, date of birth, last 4 of the Health ID) of
-- each given work item that is this facility's own work (no order route) and
-- that the session's member may read: the work-list read permission at the
-- session's facility and the read consent test of the work items' read
-- policy. The cases, through the exact Lab and Pharmacy API runtime roles in
-- the session lab-api and pharmacy-api set (DatabaseService.withTransaction):
--   1. structure: each body is 0113's (md5), SECURITY DEFINER, STABLE,
--      plpgsql, not STRICT, search_path pg_catalog, pg_temp, owned by
--      identity.patients' owner; EXECUTE for its own runtime and the schema
--      test runtime only (no PUBLIC, no other runtime);
--   2. a member with a read grant gets exactly the own rows it can read, with
--      the patient's details as identity.patients holds them (a missing sex
--      or date of birth stays empty; a long Health ID gives its last 4); the
--      cards are exactly the member's own rows under row-level security;
--   3. no row: a patient without a grant for the member; a routed work item
--      (from another facility), even one the member can read by consent;
--      another facility's own work; a member who holds consent but not the
--      read permission (a receptionist; a pharmacist through the Lab function
--      and a laboratory scientist through the Pharmacy one); a session whose
--      facility is not its membership's, without a membership, with an
--      unknown subject or with no purpose of use; a revoked or an expired
--      grant; an active deny directive (emergency still sees the row, so
--      still gets the card); a held membership; an unverified staff record;
--      a disabled account; a second membership of the same account, or
--      another member's membership, in the session; another facility's
--      member sees only its own facility's own work; a malformed facility
--      setting is refused 22023;
--   4. emergency (D8): a member with an active reasoned break-glass grant and
--      purpose 'emergency' gets the card of exactly the rows it can read,
--      and nothing under direct-care;
--   5. limits: 200 ids are read; 201 ids (also as a 2 x 101 array) and a
--      null list raise 22023 WORK_ITEM_PATIENT_CARDS_INVALID; an empty list
--      answers nothing;
--   6. the functions write nothing (no audit row);
--   7. the audit rows lab-api and pharmacy-api write per patient shown
--      (lab|pharmacy.work-item.list, basis 'consent', work item ids) show in
--      that patient's access log as views by the member at the facility.
-- Fixtures are inserted as the suite runner with session_replication_role =
-- replica (CHECK constraints still apply; foreign keys and the work items'
-- guards are skipped: the work items stand for rows lab-api and
-- pharmacy-api accepted). Synthetic values only; uuid prefix e113.
set plpgsql.variable_conflict = error;
begin;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception 'work item patient cards: %: got [%], want [%]', label, got, want;
  end if;
end
$f$;
grant execute on function pg_temp.expect(text, text, text) to public;

-- 1. Structure.
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s md5=%s owner=%s definer=%s volatile=%s language=%s strict=%s config=%s',
           expected.proc_name, coalesce(md5(proc.prosrc), 'none (missing)'), pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
           language_row.lanname, proc.proisstrict, proc.proconfig), '; ')
    into mismatch
    from (values ('lab.work_item_patient_cards(uuid[])', '69b1836bb8d9493bdc0d6d7cc5e96515'),
                 ('pharmacy.work_item_patient_cards(uuid[])', '5a944e144033d04f86771a33ef41247b')) expected(proc_name, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc_name)
    left join pg_language language_row on language_row.oid = proc.prolang
   where proc.oid is null or md5(proc.prosrc) <> expected.digest
      or proc.proowner <> (select relation.relowner from pg_class relation where relation.oid = 'identity.patients'::regclass)
      or not proc.prosecdef or proc.provolatile <> 's' or language_row.lanname <> 'plpgsql' or proc.proisstrict
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[];
  if mismatch is not null then
    raise exception 'work item patient cards: the functions are not 0113''s: %', mismatch;
  end if;
  select string_agg(format('%s %s', proc.oid::regprocedure, acl.grantee::regrole), '; ') into mismatch
    from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
   where proc.oid in ('lab.work_item_patient_cards(uuid[])'::regprocedure,
                      'pharmacy.work_item_patient_cards(uuid[])'::regprocedure)
     and acl.grantee <> proc.proowner
     and (acl.grantee = 0 or acl.privilege_type <> 'EXECUTE'
       or acl.grantee::regrole::text not in ('hid_schema_test_runtime',
            case when proc.pronamespace = 'lab'::regnamespace then 'hid_lab_runtime' else 'hid_pharmacy_runtime' end));
  if mismatch is not null then
    raise exception 'work item patient cards: unexpected grants: %', mismatch;
  end if;
  -- Who may execute each, through any membership: its own runtime, its API
  -- login and the schema test runtime; no other runtime or API login.
  select string_agg(format('%s %s=%s', expected.proc_name, role_row.rolname,
           has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')), '; ') into mismatch
    from (values ('lab.work_item_patient_cards(uuid[])', array['hid_lab_runtime', 'hid_lab_api_runtime',
                    'hid_schema_test_runtime']),
                 ('pharmacy.work_item_patient_cards(uuid[])', array['hid_pharmacy_runtime', 'hid_pharmacy_api_runtime',
                    'hid_schema_test_runtime'])) expected(proc_name, allowed)
    cross join pg_roles role_row
   where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
     and has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')
         <> (role_row.rolname = any(expected.allowed));
  if mismatch is not null then
    raise exception 'work item patient cards: EXECUTE differs: %', mismatch;
  end if;
  if (select count(*) from pg_roles where rolname in ('hid_lab_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_runtime',
        'hid_pharmacy_api_runtime', 'hid_schema_test_runtime', 'hid_ehr_api_runtime', 'hid_identity_api_runtime')) <> 7 then
    raise exception 'work item patient cards: the runtime roles are not bootstrapped';
  end if;
end $$;

-- Fixtures. Organization O (e1130000...01); facilities F1 "Cards Test
-- Clinic" (e1130001...01) and F2 "Cards Test Annex" (...02). Members (account
-- e1130002...0n, staff e1130003...0n, membership e1130004...0n, role
-- e1130005...0n): 1 LS laboratory scientist at F1, 2 PH pharmacist at F1,
-- 3 RC receptionist at F1, 4 L2 laboratory scientist at F2, 5 P2 pharmacist
-- at F2, 6 LE laboratory scientist at F1 (emergency grant only), 7 PE
-- pharmacist at F1 (emergency grant only). Patients (e1130006...0n): 1 Amaka
-- (with an account and a live patient session), 2 Bode (a long Health ID),
-- 3 Chidi (no grant for anyone), 4 Dupe (no sex or date of birth).
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'work-item-cards-test'),
  ('emergency', 'Emergency treatment', 'work-item-cards-test')
on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1130000-0000-4000-8000-000000000001', 'Cards Test Organization', 'cards-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1130001-0000-4000-8000-000000000001', 'e1130000-0000-4000-8000-000000000001', 'Cards Test Clinic',
   'CARDS-TEST-1', 'Africa/Lagos', true, 'verified'),
  ('e1130001-0000-4000-8000-000000000002', 'e1130000-0000-4000-8000-000000000001', 'Cards Test Annex',
   'CARDS-TEST-2', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1130002-0000-4000-8000-00000000000' || member.n)::uuid, 'synthetic:cards-' || member.code,
       'cards-' || member.code || '@example.invalid', member.full_name, 'active'
  from (values (1, 'ls', 'Card Lab Scientist'), (2, 'ph', 'Card Pharmacist'), (3, 'rc', 'Card Receptionist'),
               (4, 'l2', 'Card Annex Scientist'), (5, 'p2', 'Card Annex Pharmacist'),
               (6, 'le', 'Card Emergency Scientist'), (7, 'pe', 'Card Emergency Pharmacist')) member(n, code, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1130003-0000-4000-8000-00000000000' || member.n)::uuid, ('e1130002-0000-4000-8000-00000000000' || member.n)::uuid,
       account.display_name, account.email, 'verified', member.role_code
  from (values (1, 'lab'), (2, 'pharmacist'), (3, 'receptionist'), (4, 'lab'), (5, 'pharmacist'), (6, 'lab'),
               (7, 'pharmacist')) member(n, role_code)
  join auth.accounts account on account.id = ('e1130002-0000-4000-8000-00000000000' || member.n)::uuid;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1130004-0000-4000-8000-00000000000' || member.n)::uuid, ('e1130003-0000-4000-8000-00000000000' || member.n)::uuid,
       ('e1130002-0000-4000-8000-00000000000' || member.n)::uuid, 'e1130000-0000-4000-8000-000000000001',
       ('e1130001-0000-4000-8000-00000000000' || member.site)::uuid, member.role_code, member.role_code, true, true
  from (values (1, 1, 'lab'), (2, 1, 'pharmacist'), (3, 1, 'receptionist'), (4, 2, 'lab'), (5, 2, 'pharmacist'),
               (6, 1, 'lab'), (7, 1, 'pharmacist')) member(n, site, role_code);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e1130005-0000-4000-8000-00000000000' || member.n)::uuid, ('e1130002-0000-4000-8000-00000000000' || member.n)::uuid,
       member.role_code, 'facility', ('e1130004-0000-4000-8000-00000000000' || member.n)::uuid,
       ('e1130001-0000-4000-8000-00000000000' || member.site)::uuid, 'Cards suite role'
  from (values (1, 1, 'lab'), (2, 1, 'pharmacist'), (3, 1, 'receptionist'), (4, 2, 'lab'), (5, 2, 'pharmacist'),
               (6, 1, 'lab'), (7, 1, 'pharmacist')) member(n, site, role_code);
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1130002-0000-4000-8000-000000000011', 'synthetic:cards-patient-amaka', 'cards-amaka@example.invalid',
   'Amaka Card', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e1130006-0000-4000-8000-000000000001', 'e1130002-0000-4000-8000-000000000011', 'HID-CARDAAA2', 'Amaka', 'Card',
   'Amaka Card', 'female', '1991-02-03', 'active'),
  ('e1130006-0000-4000-8000-000000000002', null, 'HID-CARDBBB3XYZ7', 'Bode', 'Card', 'Bode Card', 'male', '1979-12-30',
   'active'),
  ('e1130006-0000-4000-8000-000000000003', null, 'HID-CARDCCC4', 'Chidi', 'Card', 'Chidi Card', 'male', '1988-07-14',
   'active'),
  ('e1130006-0000-4000-8000-000000000004', null, 'HID-CARDDDD5', 'Dupe', 'Card', 'Dupe Card', null, null, 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('e1130007-0000-4000-8000-000000000001', 'e1130002-0000-4000-8000-000000000011', 'e1130007-0000-4000-8000-000000000001',
   md5('cards-session-1') || md5('cards-session-1'), gen_random_uuid(), 1, 'password', clock_timestamp(),
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
   'e1130006-0000-4000-8000-000000000001');
-- Direct-care write grants (which also allow reads): LS, PH for Amaka, Bode
-- and Dupe at F1; RC for Amaka at F1; L2 and P2 for Amaka at F2. Break-glass
-- read grants: LE and PE for Amaka at F1.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass)
select ('e1130008-0000-4000-8000-0000000000' || grant_row.member || grant_row.patient)::uuid,
       ('e1130006-0000-4000-8000-00000000000' || grant_row.patient)::uuid,
       ('e1130003-0000-4000-8000-00000000000' || grant_row.member)::uuid,
       ('e1130002-0000-4000-8000-00000000000' || grant_row.member)::uuid,
       ('e1130004-0000-4000-8000-00000000000' || grant_row.member)::uuid,
       ('e1130001-0000-4000-8000-00000000000' || grant_row.site)::uuid,
       case when grant_row.emergency then 'break_glass' else 'write_records' end,
       case when grant_row.emergency then 'emergency' else 'direct-care' end, 'active',
       case when grant_row.emergency then 'Synthetic emergency for the cards suite' else 'Synthetic cards consent' end,
       clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days', grant_row.emergency
  from (values (1, 1, 1, false), (1, 2, 1, false), (1, 4, 1, false), (2, 1, 1, false), (2, 2, 1, false),
               (2, 4, 1, false), (3, 1, 1, false), (4, 1, 2, false), (5, 1, 2, false), (6, 1, 1, true),
               (7, 1, 1, true)) grant_row(member, patient, site, emergency);
-- Lab work items (e113000a...0n) and pharmacy work items (e113000b...0n):
-- 1 own work for Amaka at F1, 2 for Bode at F1, 3 for Chidi at F1, 4 routed
-- to F1 from F2 for Amaka (order route e113000c...01), 5 own work for Amaka
-- at F2, 6 own work for Dupe at F1.
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
  requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id,
  order_route_id)
select ('e113000a-0000-4000-8000-00000000000' || item.n)::uuid, ('e1130006-0000-4000-8000-00000000000' || item.patient)::uuid,
       ('e1130001-0000-4000-8000-00000000000' || item.site)::uuid,
       ('e1130001-0000-4000-8000-00000000000' || item.ordering)::uuid,
       ('e113000d-0000-4000-8000-00000000000' || item.n)::uuid, 1, ('e113000e-0000-4000-8000-00000000000' || item.n)::uuid,
       'accepted', 'routine', 'http://loinc.org', '718-7', 'Haemoglobin', 'e1130002-0000-4000-8000-000000000001',
       clock_timestamp(), ('e1130002-0000-4000-8000-00000000000' || item.member)::uuid,
       ('e1130004-0000-4000-8000-00000000000' || item.member)::uuid, 'cards-lab-item-' || item.n || '-key',
       md5('cards-lab-' || item.n) || md5('cards-lab-' || item.n), 'cards-suite-lab-' || item.n,
       case when item.routed then 'e113000c-0000-4000-8000-000000000001'::uuid end
  from (values (1, 1, 1, 1, 1, false), (2, 2, 1, 1, 1, false), (3, 3, 1, 1, 1, false), (4, 1, 1, 2, 1, true),
               (5, 1, 2, 2, 4, false), (6, 4, 1, 1, 1, false)) item(n, patient, site, ordering, member, routed);
insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
  source_ehr_prescription_version, source_encounter_id, source_status, status, medication_display, frequency,
  instructions, prescribed_by, prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason,
  idempotency_key, request_sha256, correlation_id, order_route_id)
select ('e113000b-0000-4000-8000-00000000000' || item.n)::uuid, ('e1130006-0000-4000-8000-00000000000' || item.patient)::uuid,
       ('e1130001-0000-4000-8000-00000000000' || item.site)::uuid,
       ('e1130001-0000-4000-8000-00000000000' || item.ordering)::uuid,
       ('e113000f-0000-4000-8000-00000000000' || item.n)::uuid, 1, ('e113000e-0000-4000-8000-00000000001' || item.n)::uuid,
       'active', 'accepted', 'Amoxicillin 500 mg capsule', 'Every 8 hours', 'Take after food',
       'e1130002-0000-4000-8000-000000000001', clock_timestamp(), ('e1130002-0000-4000-8000-00000000000' || item.member)::uuid,
       ('e1130004-0000-4000-8000-00000000000' || item.member)::uuid, 'Accepted for the cards suite',
       'cards-pharmacy-item-' || item.n || '-key', md5('cards-pharmacy-' || item.n) || md5('cards-pharmacy-' || item.n),
       'cards-suite-pharmacy-' || item.n,
       case when item.routed then 'e113000c-0000-4000-8000-000000000002'::uuid end
  from (values (1, 1, 1, 1, 2, false), (2, 2, 1, 1, 2, false), (3, 3, 1, 1, 2, false), (4, 1, 1, 2, 2, true),
               (5, 1, 2, 2, 5, false), (6, 4, 1, 1, 2, false)) item(n, patient, site, ordering, member, routed);
set local session_replication_role = origin;

-- The session lab-api and pharmacy-api set for a staff request.
create function pg_temp.as_member(member integer, site integer, purpose text default 'direct-care') returns void
language sql as $f$
  select set_config('app.actor_subject', 'synthetic:cards-'
           || (array['ls', 'ph', 'rc', 'l2', 'p2', 'le', 'pe'])[member], true),
         set_config('app.facility_id', 'e1130001-0000-4000-8000-00000000000' || site, true),
         set_config('app.correlation_id', 'cards-suite-' || substr(md5(random()::text), 1, 12), true),
         set_config('app.membership_id', 'e1130004-0000-4000-8000-00000000000' || member, true),
         set_config('app.purpose_of_use', purpose, true);
$f$;
-- The six work items of a kind, and the answers in a comparable form: the
-- work item's last digit, then name/sex/date of birth/Health ID ending.
create function pg_temp.items(kind text) returns uuid[] language sql as $f$
  select array_agg(((case kind when 'lab' then 'e113000a' else 'e113000b' end)
           || '-0000-4000-8000-00000000000' || n)::uuid order by n)
    from generate_series(1, 6) n;
$f$;
create function pg_temp.cards(kind text, ids uuid[]) returns text language plpgsql as $f$
declare
  answer text;
begin
  if kind = 'lab' then
    select coalesce(string_agg(format('%s:%s/%s/%s/%s', right(card.work_item_id::text, 1), card.patient_full_name,
             coalesce(card.patient_sex, '-'), coalesce(card.patient_date_of_birth::text, '-'),
             coalesce(card.patient_health_id_last4, '-')), ' ' order by card.work_item_id), '')
      into answer from lab.work_item_patient_cards(ids) card;
  else
    select coalesce(string_agg(format('%s:%s/%s/%s/%s', right(card.work_item_id::text, 1), card.patient_full_name,
             coalesce(card.patient_sex, '-'), coalesce(card.patient_date_of_birth::text, '-'),
             coalesce(card.patient_health_id_last4, '-')), ' ' order by card.work_item_id), '')
      into answer from pharmacy.work_item_patient_cards(ids) card;
  end if;
  return answer;
end
$f$;
-- The work items' last digits the session can read under row-level
-- security: all, and its own work only.
create function pg_temp.visible(kind text, own_only boolean) returns text language plpgsql as $f$
declare
  answer text;
begin
  if kind = 'lab' then
    select coalesce(string_agg(right(item.id::text, 1), ' ' order by item.id), '') into answer
      from lab.work_items item
     where item.id = any(pg_temp.items('lab')) and (not own_only or item.order_route_id is null);
  else
    select coalesce(string_agg(right(item.id::text, 1), ' ' order by item.id), '') into answer
      from pharmacy.work_items item
     where item.id = any(pg_temp.items('pharmacy')) and (not own_only or item.order_route_id is null);
  end if;
  return answer;
end
$f$;
-- The card ids only (last digits), to compare with what row-level security shows.
create function pg_temp.card_ids(kind text) returns text language plpgsql as $f$
declare
  answer text;
begin
  if kind = 'lab' then
    select coalesce(string_agg(right(card.work_item_id::text, 1), ' ' order by card.work_item_id), '') into answer
      from lab.work_item_patient_cards(pg_temp.items('lab')) card;
  else
    select coalesce(string_agg(right(card.work_item_id::text, 1), ' ' order by card.work_item_id), '') into answer
      from pharmacy.work_item_patient_cards(pg_temp.items('pharmacy')) card;
  end if;
  return answer;
end
$f$;
-- The error a call raises, as SQLSTATE: message.
create function pg_temp.refusal(kind text, ids uuid[]) returns text language plpgsql as $f$
begin
  perform pg_temp.cards(kind, ids);
  return 'no error';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end
$f$;
grant execute on function pg_temp.as_member(integer, integer, text), pg_temp.items(text),
  pg_temp.cards(text, uuid[]), pg_temp.visible(text, boolean), pg_temp.card_ids(text),
  pg_temp.refusal(text, uuid[]) to public;
select set_config('cards.audit_before', (select count(*)::text from audit.events), true);

-- 2-5. Lab, through lab-api's runtime.
set local role hid_lab_api_runtime;
select pg_temp.as_member(1, 1);
select pg_temp.expect('LS reads its own rows'' patients',
  pg_temp.cards('lab', pg_temp.items('lab')),
  '1:Amaka Card/female/1991-02-03/AAA2 2:Bode Card/male/1979-12-30/XYZ7 6:Dupe Card/-/-/DDD5');
select pg_temp.expect('LS: row-level security shows the routed row 4 too', pg_temp.visible('lab', false), '1 2 4 6');
select pg_temp.expect('LS: the cards are exactly its own rows under row-level security',
  pg_temp.card_ids('lab'), pg_temp.visible('lab', true));
select pg_temp.expect('LS: one routed row alone', pg_temp.cards('lab', array['e113000a-0000-4000-8000-000000000004'::uuid]), '');
select pg_temp.expect('LS: Chidi, without a grant', pg_temp.cards('lab', array['e113000a-0000-4000-8000-000000000003'::uuid]), '');
select pg_temp.expect('LS: F2''s own row', pg_temp.cards('lab', array['e113000a-0000-4000-8000-000000000005'::uuid]), '');
select pg_temp.expect('LS: repeated and unknown ids', pg_temp.cards('lab', array['e113000a-0000-4000-8000-000000000001'::uuid,
  'e113000a-0000-4000-8000-000000000001'::uuid, 'e113000a-0000-4000-8000-000000000009'::uuid, null]),
  '1:Amaka Card/female/1991-02-03/AAA2');
select pg_temp.expect('LS: an empty list', pg_temp.cards('lab', array[]::uuid[]), '');
select pg_temp.expect('LS: 200 ids are read', pg_temp.cards('lab', array['e113000a-0000-4000-8000-000000000002'::uuid]
  || array(select gen_random_uuid() from generate_series(1, 199))), '2:Bode Card/male/1979-12-30/XYZ7');
select pg_temp.expect('LS: 201 ids', pg_temp.refusal('lab', array(select gen_random_uuid() from generate_series(1, 201))),
  '22023: WORK_ITEM_PATIENT_CARDS_INVALID');
select pg_temp.expect('LS: a null list', pg_temp.refusal('lab', null), '22023: WORK_ITEM_PATIENT_CARDS_INVALID');
-- 42501 either way: the Lab runtime has no USAGE on schema pharmacy, and no
-- EXECUTE on the function.
select pg_temp.expect('LS through the Pharmacy function, as the Lab runtime',
  left(pg_temp.refusal('pharmacy', pg_temp.items('pharmacy')), 5), '42501');
-- A session that does not resolve: facility not the membership's, no
-- membership, an unknown subject, no purpose of use.
select pg_temp.as_member(1, 2);
select pg_temp.expect('LS with F2 as its facility', pg_temp.cards('lab', pg_temp.items('lab')), '');
select pg_temp.as_member(1, 1), set_config('app.membership_id', '', true);
select pg_temp.expect('LS without a membership', pg_temp.cards('lab', pg_temp.items('lab')), '');
select pg_temp.as_member(1, 1), set_config('app.actor_subject', 'synthetic:cards-nobody', true);
select pg_temp.expect('an unknown subject', pg_temp.cards('lab', pg_temp.items('lab')), '');
select pg_temp.as_member(1, 1, '');
select pg_temp.expect('LS with no purpose of use', pg_temp.cards('lab', pg_temp.items('lab')), '');
select pg_temp.as_member(1, 1, 'emergency');
select pg_temp.expect('LS under emergency without a break-glass grant', pg_temp.cards('lab', pg_temp.items('lab')), '');
-- Consent without the read permission.
select pg_temp.as_member(3, 1);
select pg_temp.expect('RC: row-level security shows Amaka''s rows', pg_temp.visible('lab', false), '1 4');
select pg_temp.expect('RC holds no lab.work-item.read', pg_temp.cards('lab', pg_temp.items('lab')), '');
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH through the Lab function', pg_temp.cards('lab', pg_temp.items('lab')), '');
-- Another facility's member.
select pg_temp.as_member(4, 2);
select pg_temp.expect('L2 at F2', pg_temp.cards('lab', pg_temp.items('lab')), '5:Amaka Card/female/1991-02-03/AAA2');
select pg_temp.expect('L2: the cards are exactly its own rows', pg_temp.card_ids('lab'), pg_temp.visible('lab', true));
-- Emergency (D8).
select pg_temp.as_member(6, 1, 'emergency');
select pg_temp.expect('LE under emergency', pg_temp.cards('lab', pg_temp.items('lab')), '1:Amaka Card/female/1991-02-03/AAA2');
select pg_temp.expect('LE: the cards are exactly its own rows', pg_temp.card_ids('lab'), pg_temp.visible('lab', true));
select pg_temp.as_member(6, 1);
select pg_temp.expect('LE under direct care', pg_temp.cards('lab', pg_temp.items('lab')), '');
reset role;

-- 2-5. Pharmacy, through pharmacy-api's runtime.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH reads its own rows'' patients',
  pg_temp.cards('pharmacy', pg_temp.items('pharmacy')),
  '1:Amaka Card/female/1991-02-03/AAA2 2:Bode Card/male/1979-12-30/XYZ7 6:Dupe Card/-/-/DDD5');
select pg_temp.expect('PH: row-level security shows the routed row 4 too', pg_temp.visible('pharmacy', false), '1 2 4 6');
select pg_temp.expect('PH: the cards are exactly its own rows under row-level security',
  pg_temp.card_ids('pharmacy'), pg_temp.visible('pharmacy', true));
select pg_temp.expect('PH: one routed row alone',
  pg_temp.cards('pharmacy', array['e113000b-0000-4000-8000-000000000004'::uuid]), '');
select pg_temp.expect('PH: 201 ids', pg_temp.refusal('pharmacy', array(select gen_random_uuid() from generate_series(1, 201))),
  '22023: WORK_ITEM_PATIENT_CARDS_INVALID');
select pg_temp.expect('PH: a null list', pg_temp.refusal('pharmacy', null), '22023: WORK_ITEM_PATIENT_CARDS_INVALID');
select pg_temp.expect('PH through the Lab function, as the Pharmacy runtime',
  pg_temp.refusal('lab', pg_temp.items('lab')), '42501: permission denied for function work_item_patient_cards');
select pg_temp.as_member(2, 2);
select pg_temp.expect('PH with F2 as its facility', pg_temp.cards('pharmacy', pg_temp.items('pharmacy')), '');
select pg_temp.as_member(3, 1);
select pg_temp.expect('RC holds no pharmacy.work-item.read', pg_temp.cards('pharmacy', pg_temp.items('pharmacy')), '');
select pg_temp.as_member(1, 1);
select pg_temp.expect('LS through the Pharmacy function', pg_temp.cards('pharmacy', pg_temp.items('pharmacy')), '');
select pg_temp.as_member(5, 2);
select pg_temp.expect('P2 at F2', pg_temp.cards('pharmacy', pg_temp.items('pharmacy')), '5:Amaka Card/female/1991-02-03/AAA2');
select pg_temp.as_member(7, 1, 'emergency');
select pg_temp.expect('PE under emergency', pg_temp.cards('pharmacy', pg_temp.items('pharmacy')),
  '1:Amaka Card/female/1991-02-03/AAA2');
select pg_temp.expect('PE: the cards are exactly its own rows', pg_temp.card_ids('pharmacy'), pg_temp.visible('pharmacy', true));
select pg_temp.as_member(7, 1);
select pg_temp.expect('PE under direct care', pg_temp.cards('pharmacy', pg_temp.items('pharmacy')), '');
reset role;

-- 3. A revoked or an expired grant, a disabled account (as the owner, then
-- the runtime again; each undone).
savepoint grant_changes;
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp()
 where id in ('e1130008-0000-4000-8000-000000000012', 'e1130008-0000-4000-8000-000000000022');
update identity.consent_grants set starts_at = clock_timestamp() - interval '2 hours',
  expires_at = clock_timestamp() - interval '1 hour'
 where id in ('e1130008-0000-4000-8000-000000000014', 'e1130008-0000-4000-8000-000000000024');
set local role hid_lab_api_runtime;
select pg_temp.as_member(1, 1);
select pg_temp.expect('LS after Bode''s grant is revoked and Dupe''s expired', pg_temp.cards('lab', pg_temp.items('lab')),
  '1:Amaka Card/female/1991-02-03/AAA2');
select pg_temp.expect('LS: still exactly its own rows', pg_temp.card_ids('lab'), pg_temp.visible('lab', true));
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH after Bode''s grant is revoked and Dupe''s expired',
  pg_temp.cards('pharmacy', pg_temp.items('pharmacy')), '1:Amaka Card/female/1991-02-03/AAA2');
reset role;
rollback to savepoint grant_changes;
savepoint account_change;
update auth.accounts set status = 'disabled' where id in ('e1130002-0000-4000-8000-000000000001',
  'e1130002-0000-4000-8000-000000000002');
set local role hid_lab_api_runtime;
select pg_temp.as_member(1, 1);
select pg_temp.expect('LS disabled', pg_temp.cards('lab', pg_temp.items('lab')), '');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH disabled', pg_temp.cards('pharmacy', pg_temp.items('pharmacy')), '');
reset role;
rollback to savepoint account_change;

-- 3. An active deny directive for everyone on Amaka (identity's own rule in
-- has_active_consent_grant): no card for her own rows, the others stay, and
-- the cards are still exactly the own rows row-level security shows; an
-- emergency break-glass session still sees her row, so it gets her card (D8).
savepoint deny_directive;
set local session_replication_role = replica;
insert into identity.consent_directives (id, patient_id, current_version) values
  ('e1130009-0000-4000-8000-000000000001', 'e1130006-0000-4000-8000-000000000001', 1);
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, grantee_id, facility_id, purposes, actions, starts_at, source_reference, reason, content_sha256)
values ('e1130009-0000-4000-8000-000000000011', 'e1130009-0000-4000-8000-000000000001',
  'e1130006-0000-4000-8000-000000000001', 1, 'active', 'deny', 'all', null, null, '{}', '{}',
  clock_timestamp() - interval '1 hour', 'cards-suite', 'Synthetic deny for the cards suite', md5('d') || md5('d'));
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_member(1, 1);
select pg_temp.expect('LS with a deny directive on Amaka', pg_temp.cards('lab', pg_temp.items('lab')),
  '2:Bode Card/male/1979-12-30/XYZ7 6:Dupe Card/-/-/DDD5');
select pg_temp.expect('LS deny: still exactly its own rows', pg_temp.card_ids('lab'), pg_temp.visible('lab', true));
select pg_temp.as_member(6, 1, 'emergency');
select pg_temp.expect('LE under emergency with a deny directive', pg_temp.cards('lab', pg_temp.items('lab')),
  '1:Amaka Card/female/1991-02-03/AAA2');
select pg_temp.expect('LE deny: still exactly its own rows', pg_temp.card_ids('lab'), pg_temp.visible('lab', true));
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH with a deny directive on Amaka', pg_temp.cards('pharmacy', pg_temp.items('pharmacy')),
  '2:Bode Card/male/1979-12-30/XYZ7 6:Dupe Card/-/-/DDD5');
select pg_temp.expect('PH deny: still exactly its own rows', pg_temp.card_ids('pharmacy'),
  pg_temp.visible('pharmacy', true));
reset role;
rollback to savepoint deny_directive;

-- 3. A held membership and an unverified staff record give nothing.
savepoint membership_hold;
update identity.staff_facility_memberships set migration_hold_reason = 'Synthetic hold for the cards suite'
 where id = 'e1130004-0000-4000-8000-000000000001';
set local role hid_lab_api_runtime;
select pg_temp.as_member(1, 1);
select pg_temp.expect('LS with its membership held', pg_temp.cards('lab', pg_temp.items('lab')), '');
reset role;
rollback to savepoint membership_hold;
savepoint staff_unverified;
update identity.staff set verification_status = 'pending' where id = 'e1130003-0000-4000-8000-000000000002';
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
select pg_temp.expect('PH with its staff record unverified', pg_temp.cards('pharmacy', pg_temp.items('pharmacy')), '');
reset role;
rollback to savepoint staff_unverified;

-- 3. The session's membership must be the one its grants name, at the
-- session's facility: LS's second membership (at F2, no grants) used at F1
-- and at F2, and another member's membership with LS's subject, give
-- nothing; a malformed facility setting is refused 22023.
savepoint other_memberships;
set local session_replication_role = replica;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
values ('e1130004-0000-4000-8000-000000000009', 'e1130003-0000-4000-8000-000000000001',
  'e1130002-0000-4000-8000-000000000001', 'e1130000-0000-4000-8000-000000000001',
  'e1130001-0000-4000-8000-000000000002', 'lab', 'lab', false, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('e1130005-0000-4000-8000-000000000009', 'e1130002-0000-4000-8000-000000000001', 'lab', 'facility',
  'e1130004-0000-4000-8000-000000000009', 'e1130001-0000-4000-8000-000000000002', 'Cards suite second role');
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_member(1, 1), set_config('app.membership_id', 'e1130004-0000-4000-8000-000000000009', true);
select pg_temp.expect('LS''s F2 membership at F1', pg_temp.cards('lab', pg_temp.items('lab')), '');
select pg_temp.as_member(1, 2), set_config('app.membership_id', 'e1130004-0000-4000-8000-000000000009', true);
select pg_temp.expect('LS''s F2 membership at F2 (its grants name its F1 membership)',
  pg_temp.cards('lab', pg_temp.items('lab')), '');
select pg_temp.as_member(1, 1), set_config('app.membership_id', 'e1130004-0000-4000-8000-000000000002', true);
select pg_temp.expect('LS''s subject with PH''s membership', pg_temp.cards('lab', pg_temp.items('lab')), '');
select pg_temp.as_member(1, 1), set_config('app.facility_id', 'not-a-uuid', true);
select pg_temp.expect('a malformed facility setting', left(pg_temp.refusal('lab', pg_temp.items('lab')), 5), '22023');
reset role;
rollback to savepoint other_memberships;

-- 5. The limit counts every element: a 2 x 101 array is refused.
set local role hid_lab_api_runtime;
select pg_temp.as_member(1, 1);
select pg_temp.expect('a 2 x 101 array', pg_temp.refusal('lab', (select array_agg(pair.ids) from (
    select array[gen_random_uuid(), gen_random_uuid()] ids from generate_series(1, 101)) pair)),
  '22023: WORK_ITEM_PATIENT_CARDS_INVALID');
reset role;

-- 6. Nothing was written.
select pg_temp.expect('no audit row from the reads', (select count(*)::text from audit.events),
  current_setting('cards.audit_before'));

-- 7. The per-patient rows the services write (lab-api's AuditService and
-- pharmacy-api's AuditService statements, as their runtimes) show in
-- Amaka's access log as views by the member at the facility.
set local role hid_lab_api_runtime;
select pg_temp.as_member(1, 1);
insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
  organization_id, facility_id, patient_id, action, resource_type, resource_id, outcome, purpose_of_use, source_ip,
  user_agent, details, provenance, source_system)
values (current_setting('app.correlation_id'), 'staff', 'synthetic:cards-ls', 'e1130002-0000-4000-8000-000000000001',
  'e1130004-0000-4000-8000-000000000001', 'e1130000-0000-4000-8000-000000000001', 'e1130001-0000-4000-8000-000000000001',
  'e1130006-0000-4000-8000-000000000001', 'lab.work-item.list', 'lab-work-item', 'e113000a-0000-4000-8000-000000000001',
  'success', 'direct-care', null, null,
  '{"basis":"consent","workItemIds":["e113000a-0000-4000-8000-000000000001"]}'::jsonb, 'application', 'lab-api');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
  organization_id, facility_id, patient_id, action, resource_type, resource_id, outcome, purpose_of_use, details,
  provenance, source_system)
values (current_setting('app.correlation_id'), 'staff', 'synthetic:cards-ph', 'e1130002-0000-4000-8000-000000000002',
  'e1130004-0000-4000-8000-000000000002', 'e1130000-0000-4000-8000-000000000001', 'e1130001-0000-4000-8000-000000000001',
  'e1130006-0000-4000-8000-000000000001', 'pharmacy.work-item.list', 'pharmacy-work-item',
  'e113000b-0000-4000-8000-000000000001', 'success', 'direct-care',
  '{"basis":"consent","workItemIds":["e113000b-0000-4000-8000-000000000001"]}'::jsonb, 'application', 'pharmacy-api');
reset role;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:cards-patient-amaka', true),
  set_config('app.correlation_id', 'cards-suite-access-log', true),
  set_config('app.facility_id', '', true), set_config('app.membership_id', '', true),
  set_config('app.purpose_of_use', 'patient-self', true);
select pg_temp.expect('Amaka''s access log',
  (select string_agg(format('%s/%s/%s/%s', event->>'action', event->>'actorKind', coalesce(event->>'actorName', '-'),
       coalesce(event->>'facilityName', '-')), ', ' order by ordinality)
     from jsonb_array_elements(identity.patient_self_access_log('synthetic:cards-patient-amaka',
       'e1130007-0000-4000-8000-000000000001', 50, null, null) -> 'events') with ordinality listed(event, ordinality)),
  'viewed/clinician/Card Pharmacist/Cards Test Clinic, viewed/clinician/Card Lab Scientist/Cards Test Clinic');
reset role;

rollback;
