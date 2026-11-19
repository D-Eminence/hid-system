\set ON_ERROR_STOP on
-- 0133 (ORD-2 of the Akos EHR plan of 18 November 2026; finding F2):
-- activated prescriptions go to the hospital's own pharmacy by themselves,
-- and the facility's pharmacy and lab staff work on their own facility's
-- work items without a personal consent grant, never the chart.
-- Rollback-only. Through the exact runtime roles the services use
-- (hid_ehr_api_runtime, hid_pharmacy_api_runtime, hid_lab_api_runtime), in
-- the session the services set.
-- Cases:
--   1. structure: the new and replaced functions' bodies (md5), owner,
--      SECURITY DEFINER, volatility, search_path; who may execute each; 0086's
--      context_allows bodies unchanged; the 42 own-work policies and none on
--      the imported evidence tables; the sends table has no grant; the two
--      ehr.prescriptions policies name only the dispensing validator's owner,
--      no runtime role is its member, and the owner-run definer functions
--      that read ehr.prescriptions are the seven known ones;
--   2. the send: the prescriber's activated prescription becomes a work item
--      accepted by the prescriber with the fixed reason, one event, one
--      outbox event with pharmacy-api's own four payload keys (what the event
--      dispatcher admits), a sent row; a second send writes nothing; a failed
--      attempt leaves the prescription active and the send pending with the
--      SQLSTATE, and the next send sends it; not the prescriber, a draft, a
--      changed version, a facility with nobody to work on pharmacy items;
--      a receptionist, an emergency session and a missing session are
--      refused 42501;
--   2b. ehr.own_pharmacy_staffed (D7's no_pharmacy test for the list and
--      page): true at F1 (for the doctor and the pharmacist), false at F3
--      (nobody works on pharmacy items there), null for a member who may not
--      read prescriptions (the receptionist, the lab scientist) and without a
--      session; it writes nothing;
--   3. the pharmacist without a grant sees the item, its card and its
--      event, may work on it (own_work_access_for, basis 'own-work'), its
--      list basis is 'own-work', and dispenses it; it reads nothing of the chart
--      (ehr.context_allows is false, ehr.prescriptions is not readable);
--      a second work item for a sent prescription is refused (one item per
--      prescription), and so is accepting a prescription nobody sent;
--   4. not for: a nurse, an admin, a receptionist, a clinician and a doctor
--      without a grant (they hold the read permission but not the receive
--      one), a member whose role holds the receive permission but not the
--      read one, a lab scientist (pharmacy items), a pharmacist of another
--      facility, an emergency session, a patient with a deny directive (her
--      item and its events), an inactive patient; a pharmacist with a grant
--      keeps the basis 'consent', on the list and on every command
--      (own_work_access_for answers 'consent' for the action its grant
--      covers);
--   5. stopping after the send: the change itself marks the send withdrawn
--      (D8's trigger: an UPDATE of the prescription alone, as today's
--      ehr-api images make it, without calling the withdrawal), once; the
--      withdrawal answers that it stands withdrawn; the item reads withdrawn,
--      and dispensing it is refused (PRESCRIPTION_SOURCE_NOT_DISPENSABLE); a
--      sent prescription edited while active, or resumed after the hold, is
--      marked withdrawn too (the pharmacy keeps the version sent) and the
--      send answers superseded, never already_in_pharmacy; completing one
--      marks nothing;
--   5b. after a dispensing (case 7e, at the end, so the earlier cases keep
--      rx1 as it was): an edit of the dispensed rx1 is still recorded on its
--      send, but the withdrawal answers false and PH's states answer not
--      withdrawn: what was sent was dispensed;
--   6. lab: the facility's lab scientist without a grant sees the own lab
--      work item and its card, may work on it, its basis is 'own-work', and
--      accessions it; another facility's lab scientist, the nurse and an
--      emergency session do not;
--   7. item by item, never the imported evidence: at the same facility and
--      for the same patient, a route-backed Lab item's chain (its requested
--      test, accession, specimen requirement, specimen, execution and
--      result) and a route-backed Pharmacy item's dispensing stay hidden
--      from the own-work staff, who cannot write onto them either, while the
--      own items' chains are visible (and lockable for update where the API
--      updates); the patient's imported Lab and Pharmacy evidence stays
--      hidden from them (the nurse alike) and is read with a consent grant
--      only; Pharmacy's events about an own dispensing are written, about a
--      routed one refused;
--   7b. the Lab chain on the own-work basis, with lab-api's own statements
--      as LS and L3 (no grant): a second specimen requirement and specimen on
--      W1's accession, collect and receive (update, command key, event,
--      outbox), an execution started and completed, a result entered and
--      corrected, checked by L3 and released by LS; each row reads back for
--      LS and stays hidden from the nurse and from F2's lab scientist; none
--      of these writes reaches R1's chain (routed); the inserts the services
--      make with RETURNING (an accession, a dispensing, a reversal) answer
--      their row;
--   7c. the deny directive, scope by scope (D1, as consent's own test): the
--      facility (this one or another), the organization (this one or
--      another), the staff member (the pharmacist, not the lab scientist),
--      the directive's facility, its actions (read or write only), its
--      purposes (emergency only, direct care), not yet started or expired;
--   7d. 0125's prescription details still need the member's consent: none
--      for PH, the item's details for PG;
--   8. the owner-run definer functions that read ehr.prescriptions give the
--      pharmacist nothing more through the EHR runtime: the order-route send,
--      the own-pharmacy send and the withdrawal refuse the pharmacist first.
--   9. the undo order of 0133's header: the sends table dropped while the
--      withdrawal trigger stands breaks prescription changes (42P01); the
--      trigger and its function dropped first do not.
-- Fixtures inserted as the suite runner with session_replication_role =
-- replica where the services would not write them (identity rows, the lab
-- work item). Synthetic values only; uuid prefix e133.
set plpgsql.variable_conflict = error;
begin;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception 'own facility work: %: got [%], want [%]', label, got, want;
  end if;
end
$f$;
grant execute on function pg_temp.expect(text, text, text) to public;

-- 1. Structure.
do $$
declare
  mismatch text;
  owner_oid oid := (select relowner from pg_class where oid = 'pharmacy.work_items'::regclass);
begin
  select string_agg(format('%s md5=%s owner=%s definer=%s volatile=%s config=%s', expected.proc_name,
           coalesce(md5(proc.prosrc), 'none (missing)'), pg_get_userbyid(proc.proowner), proc.prosecdef,
           proc.provolatile, proc.proconfig), '; ')
    into mismatch
    from (values
      ('identity.facility_work_member_allows(text,uuid,uuid,text)', '474875a22f8c5e7b46846f1ddb1d5046', 's'),
      ('lab.work_item_allows(uuid,uuid,uuid,text)', 'a194e2b4437efd5bb1db5e3bf482aa69', 's'),
      ('pharmacy.work_item_allows(uuid,uuid,uuid,text)', '2c2236b85397574aefc131ebca4196cc', 's'),
      ('lab.own_work_chain_allows(text,uuid,uuid,uuid,text)', 'cd166869d06a2c9a9cddbb6a04292c00', 's'),
      ('pharmacy.own_work_chain_allows(text,uuid,uuid,uuid,text)', 'bef3a9a843481841f315b3af175f86d1', 's'),
      ('lab.work_item_patient_cards(uuid[])', '91e157a7d6f89edd46c14dbb095d1bc6', 's'),
      ('pharmacy.work_item_patient_cards(uuid[])', '0dc38390c3c40a1883b87345ce0d35bd', 's'),
      ('pharmacy.own_work_source_prescription(uuid,uuid,uuid)', '41a9afd4ea6f708425b98d1fb6e6eb87', 's'),
      ('ehr.send_prescription_to_own_pharmacy(uuid,bigint)', 'ea6e547d05979779c9765f7dcc70c377', 'v'),
      ('ehr.withdraw_own_pharmacy_send(uuid)', 'bdb411d4f4e7fe6806d246d996e91771', 'v'),
      ('ehr.own_pharmacy_send_withdrawn_on_change()', '455c027844f87eebde9dd836f75760cf', 'v'),
      ('ehr.own_pharmacy_staffed()', '4998057d7a17977a8f7e9639bc759c7b', 's'),
      ('pharmacy.own_work_access_for(text,uuid,text)', '5ddb078242919dd978d6312f5cd5aa77', 's'),
      ('lab.own_work_access_for(text,uuid,text)', '1c834e3ed17d864dadb27f3105cffa04', 's'),
      ('pharmacy.own_work_item_states(uuid[])', '821f37afc72515b43494f730adf0fef9', 's'),
      ('lab.own_work_item_bases(uuid[])', '07e31d7ca86ac31255ad096d56363637', 's')) expected(proc_name, digest, volatility)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc_name)
   where proc.oid is null or md5(proc.prosrc) <> expected.digest or proc.proowner <> owner_oid
      or not proc.prosecdef or proc.provolatile <> expected.volatility or proc.proisstrict;
  if mismatch is not null then
    raise exception 'own facility work: the functions are not 0133''s: %', mismatch;
  end if;
  -- Who may execute each, through any membership.
  select string_agg(format('%s %s=%s', expected.proc_name, role_row.rolname,
           has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')), '; ') into mismatch
    from (values
      ('identity.facility_work_member_allows(text,uuid,uuid,text)', array[]::text[]),
      ('pharmacy.own_work_source_prescription(uuid,uuid,uuid)', array[]::text[]),
      ('ehr.own_pharmacy_send_withdrawn_on_change()', array[]::text[]),
      ('lab.own_work_chain_allows(text,uuid,uuid,uuid,text)', array['hid_lab_runtime', 'hid_lab_api_runtime',
        'hid_schema_test_runtime']),
      ('pharmacy.own_work_chain_allows(text,uuid,uuid,uuid,text)', array['hid_pharmacy_runtime',
        'hid_pharmacy_api_runtime', 'hid_schema_test_runtime']),
      ('ehr.send_prescription_to_own_pharmacy(uuid,bigint)', array['hid_ehr_runtime', 'hid_ehr_api_runtime',
        'hid_schema_test_runtime']),
      ('ehr.withdraw_own_pharmacy_send(uuid)', array['hid_ehr_runtime', 'hid_ehr_api_runtime',
        'hid_schema_test_runtime']),
      ('ehr.own_pharmacy_staffed()', array['hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_schema_test_runtime']),
      ('pharmacy.own_work_access_for(text,uuid,text)', array['hid_pharmacy_runtime', 'hid_pharmacy_api_runtime',
        'hid_schema_test_runtime']),
      ('pharmacy.own_work_item_states(uuid[])', array['hid_pharmacy_runtime', 'hid_pharmacy_api_runtime',
        'hid_schema_test_runtime']),
      ('lab.own_work_access_for(text,uuid,text)', array['hid_lab_runtime', 'hid_lab_api_runtime',
        'hid_schema_test_runtime']),
      ('lab.own_work_item_bases(uuid[])', array['hid_lab_runtime', 'hid_lab_api_runtime',
        'hid_schema_test_runtime'])) expected(proc_name, allowed)
    cross join pg_roles role_row
   where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
     and has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')
         <> (role_row.rolname = any(expected.allowed));
  if mismatch is not null then
    raise exception 'own facility work: EXECUTE differs: %', mismatch;
  end if;
  if exists (select 1 from pg_class relation, aclexplode(relation.relacl) acl
              where relation.oid = 'pharmacy.own_prescription_sends'::regclass and acl.grantee <> relation.relowner) then
    raise exception 'own facility work: the sends table has grants';
  end if;
  if (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'ehr.prescriptions'::regclass
         and policy_row.polname in ('prescriptions_own_pharmacy_source_read', 'prescriptions_own_pharmacy_source_lock')
         and policy_row.polroles = array[(select proowner from pg_proc
                                           where oid = 'pharmacy.validate_dispensing()'::regprocedure)]) <> 2 then
    raise exception 'own facility work: the ehr.prescriptions policies do not name only the validator''s owner';
  end if;
  if exists (select 1 from pg_roles role_row
              where role_row.rolname like 'hid\_%'
                and role_row.oid <> (select proowner from pg_proc where oid = 'pharmacy.validate_dispensing()'::regprocedure)
                and pg_has_role(role_row.oid, (select proowner from pg_proc
                                                where oid = 'pharmacy.validate_dispensing()'::regprocedure), 'MEMBER')) then
    raise exception 'own facility work: a hid_ role is a member of the validator''s owner';
  end if;
  -- 0086's chain policy functions are untouched (B1: the imported evidence
  -- keeps them as its only policies).
  if (select string_agg(md5(prosrc), ',' order by oid::regprocedure::text) from pg_proc
       where oid in ('lab.context_allows(uuid,uuid,text)'::regprocedure,
                     'pharmacy.context_allows(uuid,uuid,text)'::regprocedure))
     is distinct from '57e689661a6227e34d3bde9562468951,958a6e5cd2a534d158c82fe399b8f381' then
    raise exception 'own facility work: 0086''s context_allows bodies changed';
  end if;
  -- The own-work policies: 42, on the work chain only, never on the imported
  -- evidence, the Lab outbox or the route reports.
  if (select count(*) from pg_policy policy_row where policy_row.polname like 'own\_work\_%') <> 42
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polname like 'own\_work\_%'
                   and policy_row.polrelid in ('lab.imported_evidence'::regclass, 'lab.imported_observations'::regclass,
                     'pharmacy.imported_medication_evidence'::regclass, 'lab.outbox_events'::regclass,
                     'lab.order_route_result_reports'::regclass, 'pharmacy.order_route_dispensing_reports'::regclass,
                     'lab.work_items'::regclass, 'pharmacy.work_items'::regclass))
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polrelid in ('lab.imported_evidence'::regclass, 'lab.imported_observations'::regclass,
                         'pharmacy.imported_medication_evidence'::regclass)
                   and coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '')
                       || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '') ~ 'own_work') then
    raise exception 'own facility work: the own-work policies are not 0133''s 42 on the work chain';
  end if;
  -- S7: the owner-run SECURITY DEFINER functions that read ehr.prescriptions
  -- (each sees D5's rows in a pharmacist's session) are exactly these seven;
  -- case 8 shows each gives the pharmacist nothing more. A new one must be
  -- added here, and to case 8, by whoever writes it.
  if (select string_agg(proc.oid::regprocedure::text, ' ' order by proc.oid::regprocedure::text) from pg_proc proc
       where proc.prosecdef and proc.prosrc ~* 'ehr\.prescriptions'
         and proc.proowner = (select proowner from pg_proc where oid = 'pharmacy.validate_dispensing()'::regprocedure))
     is distinct from 'ehr.patient_list_order_routes() ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,'
       || 'character) ehr.send_prescription_to_own_pharmacy(uuid,bigint) ehr.withdraw_own_pharmacy_send(uuid) '
       || 'identity.demo_story_install(text) pharmacy.validate_dispensing() pharmacy.validate_work_item()' then
    raise exception 'own facility work: the owner-run definer functions that read ehr.prescriptions changed: %',
      (select string_agg(proc.oid::regprocedure::text, ' ' order by proc.oid::regprocedure::text) from pg_proc proc
        where proc.prosecdef and proc.prosrc ~* 'ehr\.prescriptions');
  end if;
  if exists (select 1 from pg_roles role_row
              where role_row.rolname like 'hid\_%'
                and has_function_privilege(role_row.oid, 'identity.demo_story_install(text)', 'EXECUTE')) then
    raise exception 'own facility work: a hid_ role may execute identity.demo_story_install(text)';
  end if;
end $$;

-- Fixtures. Organization O (e1330000...01); facilities F1 "Own Work
-- Hospital" (e1330001...01), F2 "Own Work Annex" (...02), F3 "Own Work
-- Clinic" (...03, no pharmacy staff). Members (account e1330002...n, staff
-- e1330003...n, membership e1330004...n, role e1330005...n):
--   1 DR doctor F1   2 PH pharmacist F1   3 LS lab F1   4 NU nurse F1
--   5 AD admin F1    6 P2 pharmacist F2   7 RC receptionist F1
--   8 D2 doctor F1   9 D3 doctor F3       10 PG pharmacist F1 (with grants)
--   11 L2 lab F2     12 CL clinician F1   13 DN doctor F1 (no grant)
--   14 RO receive-only F1 (a synthetic role holding pharmacy.order-route.receive
--      and lab.order-route.receive, not the two read permissions)
--   15 L3 lab F1 (no grant; the second person who checks LS's result)
-- Patients (e1330006...n): 1 Ada (active), 2 Bisi (a deny directive later),
-- 3 Chike (made inactive later). DR, D2 and PG hold write grants for all
-- three at F1, D3 for Ada at F3.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'own-work-test'),
  ('emergency', 'Emergency treatment', 'own-work-test')
on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1330000-0000-4000-8000-000000000001', 'Own Work Test Organization', 'own-work-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
select ('e1330001-0000-4000-8000-00000000000' || n)::uuid, 'e1330000-0000-4000-8000-000000000001', name,
       'OWN-WORK-' || n, 'Africa/Lagos', true, 'verified'
  from (values (1, 'Own Work Hospital'), (2, 'Own Work Annex'), (3, 'Own Work Clinic')) site(n, name);
create temporary table own_members (n integer primary key, code text, role_code text, site integer) on commit drop;
insert into own_members values (1, 'dr', 'doctor', 1), (2, 'ph', 'pharmacist', 1), (3, 'ls', 'lab', 1),
  (4, 'nu', 'nurse', 1), (5, 'ad', 'admin', 1), (6, 'p2', 'pharmacist', 2), (7, 'rc', 'receptionist', 1),
  (8, 'd2', 'doctor', 1), (9, 'd3', 'doctor', 3), (10, 'pg', 'pharmacist', 1), (11, 'l2', 'lab', 2),
  (12, 'cl', 'clinician', 1), (13, 'dn', 'doctor', 1), (14, 'ro', 'own_work_receive_only', 1), (15, 'l3', 'lab', 1);
grant select on own_members to public;
insert into auth.roles (code, description) values
  ('own_work_receive_only', 'Own work suite: the two receive permissions without the two read permissions');
insert into auth.role_permissions (role_code, permission_code) values
  ('own_work_receive_only', 'pharmacy.order-route.receive'), ('own_work_receive_only', 'lab.order-route.receive');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1330002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:own-work-' || code,
       'own-work-' || code || '@example.invalid', 'Own Work ' || upper(code), 'active'
  from own_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1330003-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'Own Work ' || upper(code),
       'own-work-' || code || '@example.invalid', 'verified', role_code
  from own_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1330004-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330003-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'e1330000-0000-4000-8000-000000000001',
       ('e1330001-0000-4000-8000-00000000000' || site)::uuid, role_code, role_code, true, true
  from own_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e1330005-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
       ('e1330004-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330001-0000-4000-8000-00000000000' || site)::uuid, 'Own work suite role'
  from own_members;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e1330006-0000-4000-8000-000000000001', 'HID-WRKAAA2', 'Ada', 'Own', 'Ada Own', 'female', '1990-04-05', 'active'),
  ('e1330006-0000-4000-8000-000000000002', 'HID-WRKBBB3', 'Bisi', 'Own', 'Bisi Own', 'female', '1985-01-02', 'active'),
  ('e1330006-0000-4000-8000-000000000003', 'HID-WRKCCC4', 'Chike', 'Own', 'Chike Own', 'male', '1979-09-30', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
select gen_random_uuid(), ('e1330006-0000-4000-8000-00000000000' || patient)::uuid,
       ('e1330003-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1330001-0000-4000-8000-00000000000' || site)::uuid, 'write_records', 'direct-care', 'active',
       'Synthetic own work consent', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days'
  from (values (1, 1, 1), (1, 2, 1), (1, 3, 1), (8, 1, 1), (10, 1, 1), (10, 2, 1), (10, 3, 1), (9, 1, 3))
       consent(member, patient, site);
set local session_replication_role = origin;

-- The session the services set (DatabaseService.withTransaction).
create function pg_temp.as_member(member integer, site integer default null, purpose text default 'direct-care',
  correlation text default null) returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:own-work-' || (select code from own_members where n = member), true),
         set_config('app.facility_id', 'e1330001-0000-4000-8000-00000000000'
           || coalesce(site, (select own_members.site from own_members where n = member)), true),
         set_config('app.correlation_id', coalesce(correlation, 'own-work-' || substr(md5(random()::text), 1, 12)), true),
         set_config('app.membership_id', 'e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'), true),
         set_config('app.purpose_of_use', purpose, true);
$f$;
create function pg_temp.rx(n integer) returns uuid language sql immutable as $f$
  select ('e1330007-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
-- A statement's outcome: 'ok', or 'SQLSTATE message'.
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- The send's answer as text.
create function pg_temp.send(prescription uuid, version bigint) returns text language plpgsql as $f$
declare answer text;
begin
  select string_agg(sent.outcome || case when sent.work_item_id is null then '' else ':item' end, ',') into answer
    from ehr.send_prescription_to_own_pharmacy(prescription, version) sent;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.work_item_of(prescription uuid) returns uuid language sql security definer as $f$
  select id from pharmacy.work_items where source_ehr_prescription_id = prescription
$f$;
-- pharmacy-api's dispensing INSERT (PharmacyService.dispense) by the session's member.
create function pg_temp.dispense_sql(work_item uuid, member integer) returns text language sql security definer as $f$
  select format($i$insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,%L,%L,%L,%L,%L,21,'capsule',%L,%L,'Dispensed to the patient',%L,%L,%L)$i$,
    gen_random_uuid(), w.id, w.patient_id, w.facility_id, w.medication_code_system, w.medication_code,
    w.medication_display, 'e1330002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'),
    'e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'),
    'own-work-dispense-' || replace(gen_random_uuid()::text, '-', ''), repeat('d', 64),
    current_setting('app.correlation_id'))
  from pharmacy.work_items w where w.id = work_item
$f$;
-- pharmacy-api's acceptance INSERT (PharmacyService.accept) of prescription n
-- by the session's member, with the prescription's own values.
create function pg_temp.accept_sql(n integer, member integer) returns text language sql security definer as $f$
  select format($i$insert into pharmacy.work_items (
        id,patient_id,facility_id,ordering_facility_id,source_ehr_prescription_id,
        source_ehr_prescription_version,source_encounter_id,source_status,medication_code_system,
        medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
        starts_on,ends_on,prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,
        acceptance_reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,%L,%L,%L,%s,%L,'active',%L,%L,%L,%s,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,
        'Accepted by the pharmacist',%L,%L,%L)$i$,
    gen_random_uuid(), p.patient_id, p.facility_id, p.facility_id, p.id, p.row_version, p.encounter_id,
    p.medication_code_system, p.medication_code, p.medication_display, p.dose_quantity, p.dose_unit, p.route_code,
    p.frequency, p.instructions, p.starts_on, p.ends_on, p.created_by, p.created_at,
    'e1330002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'),
    'e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'),
    'own-work-accept-' || replace(gen_random_uuid()::text, '-', ''), repeat('a', 64),
    current_setting('app.correlation_id'))
  from ehr.prescriptions p where p.id = pg_temp.rx(n)
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', proc.signature);
  end loop;
end $$;

-- The EHR rows, through the EHR runtime with the EHR API's statements, as
-- DR at F1: encounter E1 for Ada, E2 for Bisi, E3 for Chike; prescriptions
-- (draft, then activated as prescriptions.service.ts update does): 1, 2, 3,
-- 4, 6 for Ada, 7 for Bisi, 8 for Chike; 5 stays a draft. As D3 at F3: 9
-- for Ada.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e1330008-0000-4000-8000-00000000000' || n)::uuid, ('e1330006-0000-4000-8000-00000000000' || n)::uuid,
       'e1330001-0000-4000-8000-000000000001', 'e1330002-0000-4000-8000-000000000001',
       'e1330004-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp()
  from generate_series(1, 3) n;
create function pg_temp.prescribe(n integer, patient integer, member integer, site integer) returns void
language sql as $f$
  insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
    instructions, starts_on, ends_on, status)
  values (pg_temp.rx(n), ('e1330008-0000-4000-8000-00000000000' || case when site = 3 then 9 else patient end)::uuid,
    ('e1330006-0000-4000-8000-00000000000' || patient)::uuid, ('e1330001-0000-4000-8000-00000000000' || site)::uuid,
    ('e1330002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
    ('e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid, 'http://www.whocc.no/atc', 'J01CA04',
    'Amoxicillin 500 mg capsule (' || n || ')', 1, 'capsule', 'oral', 'Every 8 hours', 'Take after food for 7 days',
    date '2026-11-18', date '2026-11-25', 'draft');
$f$;
create function pg_temp.set_status(n integer, new_status text, reason text) returns void language plpgsql as $f$
begin
  perform set_config('app.change_reason', reason, true);
  update ehr.prescriptions set status = new_status where id = pg_temp.rx(n);
  if not found then raise exception 'own work suite: prescription % not updated', n; end if;
end $f$;
grant execute on function pg_temp.prescribe(integer, integer, integer, integer),
  pg_temp.set_status(integer, text, text) to public;
select pg_temp.prescribe(n, patient, 1, 1)
  from (values (1, 1), (2, 1), (3, 1), (4, 1), (5, 1), (6, 1), (7, 2), (8, 3)) rx(n, patient);
select pg_temp.set_status(n, 'active', 'First activation (no reason needed)') from unnest(array[1, 2, 3, 4, 6, 7, 8]) n;
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(9);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e1330008-0000-4000-8000-000000000009', 'e1330006-0000-4000-8000-000000000001',
  'e1330001-0000-4000-8000-000000000003', 'e1330002-0000-4000-8000-000000000009',
  'e1330004-0000-4000-8000-000000000009', 'ambulatory', 'in_progress', clock_timestamp());
select pg_temp.prescribe(9, 1, 9, 3);
select pg_temp.set_status(9, 'active', 'First activation (no reason needed)');
reset role;

-- 2. The send, as DR through the EHR runtime.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('rx1 is sent', pg_temp.send(pg_temp.rx(1), 2), 'sent:item');
reset role;
select pg_temp.expect('rx1''s work item: accepted by the prescriber, the fixed reason, version 2, no route',
  (select format('%s/%s/%s/%s/%s', w.accepted_by = 'e1330002-0000-4000-8000-000000000001',
     w.accepted_by_membership_id = 'e1330004-0000-4000-8000-000000000001', w.acceptance_reason,
     w.source_ehr_prescription_version, w.order_route_id is null)
     from pharmacy.work_items w where w.source_ehr_prescription_id = pg_temp.rx(1)),
  't/t/Sent automatically when the prescription was activated/2/t');
select pg_temp.expect('rx1: one event, one outbox event with pharmacy-api''s four payload keys, a sent row',
  (select format('%s/%s/%s', (select count(*) from pharmacy.work_item_events e where e.work_item_id = w.id),
     (select string_agg(o.event_type || ':' || o.aggregate_type || ':' || o.aggregate_version || ':'
        || (select string_agg(key, ',' order by key) from jsonb_object_keys(o.payload) key) || ':'
        || (o.payload ->> 'status') || ':' || (o.payload ->> 'workItemId' = w.id::text) || ':'
        || (o.payload ->> 'sourceEhrPrescriptionId' = w.source_ehr_prescription_id::text) || ':'
        || (o.payload -> 'sourceEhrPrescriptionVersion')::text, ',')
        from pharmacy.outbox_events o where o.aggregate_id = w.id),
     (select s.state || ':' || s.attempts || ':' || (s.work_item_id = w.id) || ':' || coalesce(s.last_failure_sqlstate, '-')
        from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(1)))
     from pharmacy.work_items w where w.source_ehr_prescription_id = pg_temp.rx(1)),
  '1/PharmacyWorkItemCreated:pharmacy-work-item:1:sourceEhrPrescriptionId,sourceEhrPrescriptionVersion,status,'
  || 'workItemId:accepted:true:true:2/sent:1:true:-');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('a second send writes nothing', pg_temp.send(pg_temp.rx(1), 2), 'already_in_pharmacy:item');
select pg_temp.expect('a draft is not sent', pg_temp.send(pg_temp.rx(5), 1), 'not_active');
select pg_temp.expect('another version is not sent', pg_temp.send(pg_temp.rx(2), 1), 'changed');
select pg_temp.expect('an unknown prescription', pg_temp.send(gen_random_uuid(), 1), 'not_found');
select pg_temp.expect('a bad version', pg_temp.send(pg_temp.rx(2), 0), '22023 OWN_PHARMACY_SEND_INVALID');
-- A failed attempt (a correlation id the work item's CHECK refuses): the
-- prescription stays active, the send pending with the SQLSTATE, nothing else written.
select pg_temp.as_member(1, correlation => 'short');
select pg_temp.expect('a failed attempt is pending', pg_temp.send(pg_temp.rx(2), 2), 'pending');
reset role;
select pg_temp.expect('the pending send: no work item, the SQLSTATE, the prescription still active',
  (select format('%s/%s/%s/%s/%s', s.state, s.attempts, s.last_failure_sqlstate,
     (select count(*) from pharmacy.work_items w where w.source_ehr_prescription_id = pg_temp.rx(2)),
     (select p.status from ehr.prescriptions p where p.id = pg_temp.rx(2)))
     from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(2)),
  'pending/1/23514/0/active');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('the next send sends it', pg_temp.send(pg_temp.rx(2), 2), 'sent:item');
select pg_temp.expect('rx3, rx4, rx6, rx7, rx8 are sent', (select string_agg(pg_temp.send(pg_temp.rx(n), 2), ' ')
  from unnest(array[3, 4, 6, 7, 8]) n), 'sent:item sent:item sent:item sent:item sent:item');
-- Not the prescriber: D2 (a doctor with a grant for Ada).
select pg_temp.as_member(8);
select pg_temp.set_status(5, 'active', 'First activation (no reason needed)');
select pg_temp.expect('D2 does not send DR''s prescription', pg_temp.send(pg_temp.rx(5), 2), 'not_prescriber');
-- Refused sessions.
select pg_temp.as_member(7);
select pg_temp.expect('a receptionist is refused', pg_temp.send(pg_temp.rx(5), 2), '42501 OWN_PHARMACY_SEND_DENIED');
select pg_temp.as_member(1, purpose => 'emergency');
select pg_temp.expect('an emergency session is refused', pg_temp.send(pg_temp.rx(5), 2), '42501 OWN_PHARMACY_SEND_DENIED');
select set_config('app.membership_id', '', true);
select pg_temp.expect('a session without a membership is refused', pg_temp.send(pg_temp.rx(5), 2),
  '42501 OWN_PHARMACY_SEND_DENIED');
-- Nobody works on pharmacy items at F3.
select pg_temp.as_member(9);
select pg_temp.expect('F3 has no pharmacy staff', pg_temp.send(pg_temp.rx(9), 2), 'no_pharmacy');
reset role;
select pg_temp.expect('no send row for the refused and unsent', (select count(*)::text from pharmacy.own_prescription_sends
  where prescription_id in (pg_temp.rx(5), pg_temp.rx(9))), '0');

-- 2b. Whether a send can reach somebody here (the list's and page's flag).
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('F1 has pharmacy staff, for DR', ehr.own_pharmacy_staffed()::text, 'true');
select pg_temp.as_member(2);
select pg_temp.expect('and for PH (who may read prescriptions)', ehr.own_pharmacy_staffed()::text, 'true');
select pg_temp.as_member(9);
select pg_temp.expect('F3 has none, for D3', ehr.own_pharmacy_staffed()::text, 'false');
select pg_temp.as_member(1, site => 3);
select pg_temp.expect('DR claiming F3 (no membership there) gets no answer', coalesce(ehr.own_pharmacy_staffed()::text, 'null'),
  'null');
select pg_temp.as_member(7);
select pg_temp.expect('the receptionist (no prescription read) gets no answer',
  coalesce(ehr.own_pharmacy_staffed()::text, 'null'), 'null');
select pg_temp.as_member(3);
select pg_temp.expect('the lab scientist (no prescription read) gets no answer',
  coalesce(ehr.own_pharmacy_staffed()::text, 'null'), 'null');
select set_config('app.facility_id', '', true);
select pg_temp.expect('no session, no answer', coalesce(ehr.own_pharmacy_staffed()::text, 'null'), 'null');
reset role;
select pg_temp.expect('the staffed test wrote no send row', (select count(*)::text from pharmacy.own_prescription_sends
  where prescription_id in (pg_temp.rx(5), pg_temp.rx(9))), '0');

-- 3. PH, the pharmacist at F1 without any grant, through pharmacy-api's runtime.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH sees the seven items sent (rx1-rx4, rx6, rx7, rx8)',
  (select count(*)::text from pharmacy.work_items), '7');
select pg_temp.expect('PH sees rx1''s card with the name',
  (select string_agg(card.patient_full_name || '/' || card.patient_health_id_last4, ',')
     from pharmacy.work_item_patient_cards(array[pg_temp.work_item_of(pg_temp.rx(1))]) card), 'Ada Own/AAA2');
select pg_temp.expect('PH may work on rx1''s item, on the own-work basis',
  (select string_agg(access.basis, ',') from pharmacy.own_work_access_for('work_item',
     pg_temp.work_item_of(pg_temp.rx(1)), 'write_records') access), 'own-work');
select pg_temp.expect('rx1''s basis for PH is own-work, not withdrawn',
  (select string_agg(state.basis || '/' || state.withdrawn, ',')
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(1))]) state), 'own-work/false');
select pg_temp.expect('PH reads rx1''s event', (select count(*)::text from pharmacy.work_item_events e
  where e.work_item_id = pg_temp.work_item_of(pg_temp.rx(1))), '1');
select pg_temp.expect('PH dispenses rx1', pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2)), 'ok');
select pg_temp.expect('PH reads the dispensing', (select count(*)::text from pharmacy.dispensings d
  where d.work_item_id = pg_temp.work_item_of(pg_temp.rx(1))), '1');
-- One pharmacy item per prescription, and no acceptance without consent: a
-- second item for the sent rx1, and rx5 (active, never sent). On a database
-- whose owner bypasses row-level security the validator finds rx5 and the
-- work items' insert policy refuses it (0133's branch is for reads only);
-- under forced row-level security (production) the validator, reading as
-- its owner in PH's session, does not find rx5 at all.
select pg_temp.expect('PH: a second work item for rx1 is refused',
  pg_temp.try(pg_temp.accept_sql(1, 2)), '42501 new row violates row-level security policy for table "work_items"');
select pg_temp.expect('PH: accepting rx5 (never sent) without a grant is refused',
  pg_temp.try(pg_temp.accept_sql(5, 2)) in ('42501 new row violates row-level security policy for table "work_items"',
    '23514 PRESCRIPTION_SOURCE_NOT_FOUND')::text, 'true');
select pg_temp.expect('the Pharmacy runtime cannot read the chart',
  pg_temp.try('select count(*) from ehr.prescriptions'), '42501 permission denied for schema ehr');
select pg_temp.expect('PH: a Lab resource type is refused', pg_temp.try($s$select * from pharmacy.own_work_access_for(
  'accession', gen_random_uuid(), 'read_records')$s$), '22023 OWN_WORK_ACCESS_INVALID');
reset role;
-- PH's session through the EHR runtime: the chart's consent test (every EHR
-- table's policy) is still false for Ada, and no prescription, encounter or
-- version snapshot is readable.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH reads nothing of the chart through the EHR runtime',
  format('%s/%s/%s/%s', ehr.context_allows('e1330006-0000-4000-8000-000000000001',
      'e1330001-0000-4000-8000-000000000001', 'read_records'),
    (select count(*) from ehr.prescriptions), (select count(*) from ehr.encounters),
    (select count(*) from ehr.record_versions)), 'f/0/0/0');
reset role;

-- 4. Not for others.
create function pg_temp.pharmacy_view(member integer, site integer default null, purpose text default 'direct-care')
returns text language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.as_member(member, site, purpose);
  select format('items=%s cards=%s access=%s', (select count(*) from pharmacy.work_items),
           (select count(*) from pharmacy.work_item_patient_cards(array[pg_temp.work_item_of(pg_temp.rx(3))])),
           (select count(*) from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(3)),
              'read_records')))
    into answer;
  return answer;
end $f$;
grant execute on function pg_temp.pharmacy_view(integer, integer, text) to public;
create function pg_temp.lab_view(member integer) returns text language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.as_member(member);
  select format('items=%s cards=%s access=%s', (select count(*) from lab.work_items),
           (select count(*) from lab.work_item_patient_cards(array['e133000a-0000-4000-8000-000000000001'::uuid])),
           (select count(*) from lab.own_work_access_for('work_item', 'e133000a-0000-4000-8000-000000000001',
              'read_records')))
    into answer;
  return answer;
end $f$;
grant execute on function pg_temp.lab_view(integer) to public;
set local role hid_pharmacy_api_runtime;
select pg_temp.expect('NU (nurse) sees nothing', pg_temp.pharmacy_view(4), 'items=0 cards=0 access=0');
select pg_temp.expect('AD (admin) sees nothing', pg_temp.pharmacy_view(5), 'items=0 cards=0 access=0');
select pg_temp.expect('RC (receptionist) sees nothing', pg_temp.pharmacy_view(7), 'items=0 cards=0 access=0');
select pg_temp.expect('CL (clinician) sees nothing', pg_temp.pharmacy_view(12), 'items=0 cards=0 access=0');
select pg_temp.expect('DN (doctor without a grant) sees nothing', pg_temp.pharmacy_view(13), 'items=0 cards=0 access=0');
select pg_temp.expect('RO (receive permission without the read one) sees nothing', pg_temp.pharmacy_view(14),
  'items=0 cards=0 access=0');
select pg_temp.expect('LS (lab) sees no pharmacy item', pg_temp.pharmacy_view(3), 'items=0 cards=0 access=0');
select pg_temp.expect('P2 (pharmacist at F2) sees nothing of F1', pg_temp.pharmacy_view(6), 'items=0 cards=0 access=0');
select pg_temp.expect('P2''s membership in a session at F1 sees nothing', pg_temp.pharmacy_view(6, 1),
  'items=0 cards=0 access=0');
select pg_temp.expect('PH in an emergency session sees nothing', pg_temp.pharmacy_view(2, purpose => 'emergency'),
  'items=0 cards=0 access=0');
select pg_temp.as_member(10);
select pg_temp.expect('PG (pharmacist with grants) keeps the basis consent',
  (select string_agg(state.basis, ',') from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(1))]) state),
  'consent');
select pg_temp.expect('PG keeps the basis consent on the commands too (read, and the write its grant covers)',
  (select string_agg(access.basis, ',') from (
     select * from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(1)), 'read_records')
     union all
     select * from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(1)), 'write_records')) access),
  'consent,consent');
reset role;
-- Bisi's deny directive (facility F1, everyone) and Chike made inactive.
set local session_replication_role = replica;
insert into identity.consent_directives (id, patient_id) values
  ('e1330009-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000002');
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, facility_id, starts_at, source_reference, reason, content_sha256)
values (gen_random_uuid(), 'e1330009-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000002', 1, 'active',
  'deny', 'all', 'e1330001-0000-4000-8000-000000000001', clock_timestamp() - interval '1 minute', 'own-work-suite',
  'Synthetic deny directive', repeat('a', 64));
update identity.patients set status = 'inactive' where id = 'e1330006-0000-4000-8000-000000000003';
set local session_replication_role = origin;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: Bisi (deny directive) and Chike (inactive) are hidden now',
  (select string_agg(right(w.source_ehr_prescription_id::text, 2), ' ' order by w.source_ehr_prescription_id)
     from pharmacy.work_items w), '01 02 03 04 06');
select pg_temp.expect('PH may not work on Bisi''s item', (select count(*)::text from pharmacy.own_work_access_for(
  'work_item', pg_temp.work_item_of(pg_temp.rx(7)), 'write_records')), '0');
select pg_temp.expect('PH reads no event of Bisi''s or Chike''s items', (select count(*)::text
  from pharmacy.work_item_events e where e.work_item_id in (pg_temp.work_item_of(pg_temp.rx(7)),
    pg_temp.work_item_of(pg_temp.rx(8)))), '0');
select pg_temp.expect('PH sees no card for Bisi''s or Chike''s items', (select count(*)::text
  from pharmacy.work_item_patient_cards(array[pg_temp.work_item_of(pg_temp.rx(7)), pg_temp.work_item_of(pg_temp.rx(8))])),
  '0');
reset role;

-- 5. Stopping after the send: DR holds rx3; the send is withdrawn once, and
-- dispensing is refused.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('an active prescription is not withdrawn', ehr.withdraw_own_pharmacy_send(pg_temp.rx(3))::text,
  'false');
select pg_temp.set_status(3, 'on_hold', 'Held by the prescriber');
reset role;
select set_config('own_work.rx3_withdrawn_at', (select s.withdrawn_at::text from pharmacy.own_prescription_sends s
  where s.prescription_id = pg_temp.rx(3)), true);
select pg_temp.expect('the hold alone marks rx3''s send withdrawn (D8''s trigger, no withdrawal call)',
  (current_setting('own_work.rx3_withdrawn_at') <> '')::text, 'true');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('the held prescription''s send stands withdrawn',
  ehr.withdraw_own_pharmacy_send(pg_temp.rx(3))::text, 'true');
select pg_temp.expect('and stays so', ehr.withdraw_own_pharmacy_send(pg_temp.rx(3))::text, 'true');
reset role;
select pg_temp.expect('marked once (the withdrawal time is the hold''s)', (select s.withdrawn_at::text
  from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(3)),
  current_setting('own_work.rx3_withdrawn_at'));
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.as_member(7);
select pg_temp.expect('a receptionist cannot withdraw', pg_temp.try(format(
  'select ehr.withdraw_own_pharmacy_send(%L)', pg_temp.rx(3))), '42501 OWN_PHARMACY_SEND_DENIED');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: rx3 reads withdrawn',
  (select string_agg(state.basis || '/' || state.withdrawn, ',')
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(3))]) state), 'own-work/true');
select pg_temp.expect('PH: dispensing rx3 is refused',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(3)), 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE');
select pg_temp.expect('PH: rx4 (still active) dispenses', pg_temp.try(pg_temp.dispense_sql(
  pg_temp.work_item_of(pg_temp.rx(4)), 2)), 'ok');
reset role;
-- A sent prescription changed after the send: DR edits rx6 (sent at version
-- 2) while it stays active, and resumes rx3 (held above). The pharmacy item
-- keeps the version sent, so the send is withdrawn and "Send to pharmacy"
-- answers superseded (never already_in_pharmacy). Completing rx4 marks nothing.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('rx6 at the version sent: the send answers already_in_pharmacy',
  pg_temp.send(pg_temp.rx(6), 2), 'already_in_pharmacy:item');
select pg_temp.expect('rx6 at the version sent is not withdrawn', ehr.withdraw_own_pharmacy_send(pg_temp.rx(6))::text,
  'false');
select set_config('app.change_reason', 'Changed the frequency', true);
update ehr.prescriptions set frequency = 'Every 12 hours' where id = pg_temp.rx(6);
select pg_temp.expect('the edited rx6 is active at version 3', (select p.status || '/' || p.row_version
  from ehr.prescriptions p where p.id = pg_temp.rx(6)), 'active/3');
reset role;
select pg_temp.expect('the edit alone marks rx6''s send withdrawn (D8''s trigger)', (select (s.withdrawn_at is not null)::text
  from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(6)), 'true');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('the edited rx6''s send stands withdrawn',
  ehr.withdraw_own_pharmacy_send(pg_temp.rx(6))::text || '/' || ehr.withdraw_own_pharmacy_send(pg_temp.rx(6))::text,
  'true/true');
select pg_temp.expect('Send to pharmacy for the edited rx6 answers superseded', pg_temp.send(pg_temp.rx(6), 3),
  'superseded:item');
select pg_temp.set_status(3, 'active', 'Resumed after review');
select pg_temp.expect('the resumed rx3 is active at version 4, its send withdrawn since the hold',
  (select p.status || '/' || p.row_version from ehr.prescriptions p where p.id = pg_temp.rx(3)) || '/'
    || ehr.withdraw_own_pharmacy_send(pg_temp.rx(3))::text, 'active/4/true');
select pg_temp.expect('Send to pharmacy for the resumed rx3 answers superseded', pg_temp.send(pg_temp.rx(3), 4),
  'superseded:item');
select pg_temp.set_status(4, 'completed', 'Course completed');
select pg_temp.expect('the completed rx4''s send is not withdrawn', ehr.withdraw_own_pharmacy_send(pg_temp.rx(4))::text,
  'false');
reset role;
select pg_temp.expect('rx3''s withdrawal time is still the hold''s', (select s.withdrawn_at::text
  from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(3)),
  current_setting('own_work.rx3_withdrawn_at'));
select pg_temp.expect('the sends: rx3 and rx6 withdrawn at their sent version 2, rx4 not',
  (select string_agg(right(s.prescription_id::text, 2) || ':' || s.prescription_version || ':' || (s.withdrawn_at is not null),
     ' ' order by s.prescription_id) from pharmacy.own_prescription_sends s
    where s.prescription_id in (pg_temp.rx(3), pg_temp.rx(4), pg_temp.rx(6))), '03:2:true 04:2:false 06:2:true');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: the edited rx6 and the resumed rx3 read withdrawn, rx4 not',
  (select string_agg(right(w.source_ehr_prescription_id::text, 2) || ':' || state.withdrawn, ' '
     order by w.source_ehr_prescription_id)
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(3)), pg_temp.work_item_of(pg_temp.rx(4)),
       pg_temp.work_item_of(pg_temp.rx(6))]) state join pharmacy.work_items w on w.id = state.work_item_id),
  '03:true 04:false 06:true');
select pg_temp.expect('PH: dispensing the edited rx6 is refused',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(6)), 2)), '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE');
select pg_temp.expect('PH: dispensing the resumed rx3 is refused',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(3)), 2)), '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE');
reset role;

-- 6. Lab: an own lab work item for Ada at F1 and one at F2 (as replica, as
-- lab-api accepts them from the EHR).
set local session_replication_role = replica;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
  requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
select ('e133000a-0000-4000-8000-00000000000' || site)::uuid, 'e1330006-0000-4000-8000-000000000001',
       ('e1330001-0000-4000-8000-00000000000' || site)::uuid, ('e1330001-0000-4000-8000-00000000000' || site)::uuid,
       gen_random_uuid(), 1, gen_random_uuid(), 'accepted', 'routine', 'http://loinc.org', '718-7', 'Haemoglobin',
       'e1330002-0000-4000-8000-000000000001', clock_timestamp(), 'e1330002-0000-4000-8000-000000000001',
       'e1330004-0000-4000-8000-000000000001', 'own-work-lab-item-' || site || '-key', repeat('b', 64),
       'own-work-suite-lab-' || site
  from generate_series(1, 2) site;
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('LS sees F1''s own lab item and its card',
  (select format('%s/%s/%s/%s', (select count(*) from lab.work_items),
     (select string_agg(card.patient_full_name, ',') from lab.work_item_patient_cards(
        array['e133000a-0000-4000-8000-000000000001'::uuid, 'e133000a-0000-4000-8000-000000000002'::uuid]) card),
     (select count(*) from lab.own_work_access_for('work_item', 'e133000a-0000-4000-8000-000000000001', 'write_records')),
     (select string_agg(basis, ',') from lab.own_work_item_bases(array['e133000a-0000-4000-8000-000000000001'::uuid])))),
  '1/Ada Own/1/own-work');
insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
  idempotency_key, request_sha256, correlation_id)
values ('e133000b-0000-4000-8000-000000000001', 'e133000a-0000-4000-8000-000000000001',
  'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'routine',
  'e1330002-0000-4000-8000-000000000003', 'e1330004-0000-4000-8000-000000000003', 'own-work-accession-0001',
  repeat('c', 64), current_setting('app.correlation_id'));
select pg_temp.expect('LS may work on its accession', (select count(*)::text from lab.own_work_access_for('accession',
  'e133000b-0000-4000-8000-000000000001', 'write_records')), '1');
select pg_temp.as_member(11);
select pg_temp.expect('L2 (lab at F2) sees only F2''s item', (select string_agg(right(id::text, 1), ',') from lab.work_items),
  '2');
select pg_temp.as_member(4);
select pg_temp.expect('NU (nurse) sees no lab item', (select count(*)::text from lab.work_items), '0');
select pg_temp.expect('AD (admin) sees no lab item', pg_temp.lab_view(5), 'items=0 cards=0 access=0');
select pg_temp.expect('RC (receptionist) sees no lab item', pg_temp.lab_view(7), 'items=0 cards=0 access=0');
select pg_temp.expect('CL (clinician) sees no lab item', pg_temp.lab_view(12), 'items=0 cards=0 access=0');
select pg_temp.expect('DN (doctor without a grant) sees no lab item', pg_temp.lab_view(13), 'items=0 cards=0 access=0');
select pg_temp.expect('RO (receive permission without the read one) sees no lab item', pg_temp.lab_view(14),
  'items=0 cards=0 access=0');
select pg_temp.as_member(3, purpose => 'emergency');
select pg_temp.expect('LS in an emergency session sees no lab item', (select count(*)::text from lab.work_items), '0');
reset role;

-- 7. Item by item, never the imported evidence. Fixtures as replica, as the
-- services would have written them: for Ada at F1, the own lab item's chain
-- (W1: requested test, specimen requirement, specimen, execution, result on
-- LS's accession of case 6); a route-backed lab item (R1, an order from F3;
-- its route is unknown here, so its route branch is false) with the same
-- chain; a route-backed pharmacy item (RP, from F3) with a dispensing; and
-- the patient's imported Lab and Pharmacy evidence (OCR-imported outside
-- records).
set local session_replication_role = replica;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, order_route_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
  requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
values ('e133000a-0000-4000-8000-000000000003', 'e1330006-0000-4000-8000-000000000001',
  'e1330001-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000003', gen_random_uuid(), gen_random_uuid(), 1,
  gen_random_uuid(), 'accepted', 'routine', 'http://loinc.org', '2345-7', 'Glucose (routed)',
  'e1330002-0000-4000-8000-000000000009', clock_timestamp(), 'e1330002-0000-4000-8000-000000000003',
  'e1330004-0000-4000-8000-000000000003', 'own-work-routed-lab-item-key', repeat('b', 64), 'own-work-suite-routed');
insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
  idempotency_key, request_sha256, correlation_id)
values ('e133000b-0000-4000-8000-000000000003', 'e133000a-0000-4000-8000-000000000003',
  'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'routine',
  'e1330002-0000-4000-8000-000000000003', 'e1330004-0000-4000-8000-000000000003', 'own-work-routed-accession',
  repeat('c', 64), 'own-work-suite-routed');
-- n = 1: W1 (own, accession e133000b...01); n = 3: R1 (routed, accession e133000b...03).
insert into lab.work_item_requested_tests (id, work_item_id, facility_id, patient_id, ordinal, code_system, code, name)
select ('e133000c-0000-4000-8000-00000000000' || n)::uuid, ('e133000a-0000-4000-8000-00000000000' || n)::uuid,
       'e1330001-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000001', 1, 'http://loinc.org', '718-7',
       'Haemoglobin'
  from unnest(array[1, 3]) n;
insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
select ('e133000d-0000-4000-8000-00000000000' || n)::uuid, ('e133000b-0000-4000-8000-00000000000' || n)::uuid,
       'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 1, 'blood'
  from unnest(array[1, 3]) n;
insert into lab.specimens (id, specimen_identifier, requirement_id, accession_id, patient_id, facility_id,
  collection_ordinal, specimen_type)
select ('e133000e-0000-4000-8000-00000000000' || n)::uuid, 'OWN-WORK-SPECIMEN-' || n,
       ('e133000d-0000-4000-8000-00000000000' || n)::uuid, ('e133000b-0000-4000-8000-00000000000' || n)::uuid,
       'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 1, 'blood'
  from unnest(array[1, 3]) n;
insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id,
  started_by, started_by_membership_id, started_at, idempotency_key, request_sha256, correlation_id)
select ('e133000f-0000-4000-8000-00000000000' || n)::uuid, ('e133000b-0000-4000-8000-00000000000' || n)::uuid,
       ('e133000e-0000-4000-8000-00000000000' || n)::uuid, ('e133000c-0000-4000-8000-00000000000' || n)::uuid,
       'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001',
       'e1330002-0000-4000-8000-000000000003', 'e1330004-0000-4000-8000-000000000003', clock_timestamp(),
       'own-work-execution-' || n, repeat('f', 64), 'own-work-suite-chain'
  from unnest(array[1, 3]) n;
insert into lab.results (id, execution_id, patient_id, facility_id, created_by, created_by_membership_id)
select ('e1330010-0000-4000-8000-00000000000' || n)::uuid, ('e133000f-0000-4000-8000-00000000000' || n)::uuid,
       'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001',
       'e1330002-0000-4000-8000-000000000003', 'e1330004-0000-4000-8000-000000000003'
  from unnest(array[1, 3]) n;
insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, order_route_id,
  source_ehr_prescription_id, source_ehr_prescription_version, source_encounter_id, source_status, medication_display,
  frequency, instructions, prescribed_by, prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason,
  idempotency_key, request_sha256, correlation_id)
values ('e1330011-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000001',
  'e1330001-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000003', gen_random_uuid(), gen_random_uuid(), 1,
  gen_random_uuid(), 'active', 'Metformin 500 mg tablet (routed)', 'Twice a day', 'Take with food',
  'e1330002-0000-4000-8000-000000000009', clock_timestamp(), 'e1330002-0000-4000-8000-000000000002',
  'e1330004-0000-4000-8000-000000000002', 'Accepted from Own Work Clinic', 'own-work-routed-pharmacy-key',
  repeat('b', 64), 'own-work-suite-routed');
insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id, medication_display,
  quantity_dispensed, quantity_unit, dispensed_by, dispensed_by_membership_id, reason, idempotency_key, request_sha256,
  correlation_id)
values ('e1330012-0000-4000-8000-000000000001', 'e1330011-0000-4000-8000-000000000001', 1,
  'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'Metformin 500 mg tablet (routed)',
  60, 'tablet', 'e1330002-0000-4000-8000-000000000002', 'e1330004-0000-4000-8000-000000000002',
  'Dispensed to the patient', 'own-work-routed-dispensing', repeat('d', 64), 'own-work-suite-routed');
insert into lab.imported_evidence (patient_id, facility_id, source_document_id, reviewed_by, created_by,
  created_by_membership_id, idempotency_key, request_sha256, correlation_id, external_lab_name)
values ('e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', gen_random_uuid(),
  'e1330002-0000-4000-8000-000000000001', 'e1330002-0000-4000-8000-000000000001', 'e1330004-0000-4000-8000-000000000001',
  'own-work-imported-lab-0001', repeat('e', 64), 'own-work-suite-imported', 'Synthetic Outside Lab');
insert into pharmacy.imported_medication_evidence (patient_id, facility_id, source_document_id, ocr_job_id,
  extraction_id, validation_id, validation_version, publication_id, medication_text, reviewed_by, created_by,
  created_by_membership_id, idempotency_key, request_sha256, correlation_id)
values ('e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(), 'Synthetic imported medicine',
  'e1330002-0000-4000-8000-000000000001', 'e1330002-0000-4000-8000-000000000001', 'e1330004-0000-4000-8000-000000000001',
  'own-work-imported-medication-0001', repeat('e', 64), 'own-work-suite-imported');
set local session_replication_role = origin;
-- The chain of lab item n (1: W1, 3: R1) as the session reads it, and as it
-- may lock it for update (what the API's updates need).
create function pg_temp.lab_chain(n integer) returns text language plpgsql as $f$
declare answer text;
begin
  select format('tests=%s accessions=%s requirements=%s specimens=%s executions=%s results=%s locked=%s/%s/%s',
           (select count(*) from lab.work_item_requested_tests where id = ('e133000c-0000-4000-8000-00000000000' || n)::uuid),
           (select count(*) from lab.accessions where id = ('e133000b-0000-4000-8000-00000000000' || n)::uuid),
           (select count(*) from lab.specimen_requirements where id = ('e133000d-0000-4000-8000-00000000000' || n)::uuid),
           (select count(*) from lab.specimens where id = ('e133000e-0000-4000-8000-00000000000' || n)::uuid),
           (select count(*) from lab.test_executions where id = ('e133000f-0000-4000-8000-00000000000' || n)::uuid),
           (select count(*) from lab.results where id = ('e1330010-0000-4000-8000-00000000000' || n)::uuid),
           (select count(*) from (select 1 from lab.specimens
               where id = ('e133000e-0000-4000-8000-00000000000' || n)::uuid for update) locked),
           (select count(*) from (select 1 from lab.test_executions
               where id = ('e133000f-0000-4000-8000-00000000000' || n)::uuid for update) locked),
           (select count(*) from (select 1 from lab.results
               where id = ('e1330010-0000-4000-8000-00000000000' || n)::uuid for update) locked))
    into answer;
  return answer;
end $f$;
grant execute on function pg_temp.lab_chain(integer) to public;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('LS: W1''s chain is visible and lockable', pg_temp.lab_chain(1),
  'tests=1 accessions=1 requirements=1 specimens=1 executions=1 results=1 locked=1/1/1');
select pg_temp.expect('LS: R1 (routed, same patient and facility) and its chain stay hidden',
  (select count(*) from lab.work_items where id = 'e133000a-0000-4000-8000-000000000003') || ' ' || pg_temp.lab_chain(3),
  '0 tests=0 accessions=0 requirements=0 specimens=0 executions=0 results=0 locked=0/0/0');
select pg_temp.expect('LS: R1''s accession, execution and result give no own work item',
  (select count(*)::text from (select * from lab.own_work_access_for('accession', 'e133000b-0000-4000-8000-000000000003',
     'read_records') union all select * from lab.own_work_access_for('execution', 'e133000f-0000-4000-8000-000000000003',
     'read_records') union all select * from lab.own_work_access_for('result', 'e1330010-0000-4000-8000-000000000003',
     'read_records')) found), '0');
select pg_temp.expect('LS cannot write an accession onto R1',
  (pg_temp.try($i$insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by,
    created_by_membership_id, idempotency_key, request_sha256, correlation_id)
    values (gen_random_uuid(), 'e133000a-0000-4000-8000-000000000003', 'e1330006-0000-4000-8000-000000000001',
    'e1330001-0000-4000-8000-000000000001', 'routine', 'e1330002-0000-4000-8000-000000000003',
    'e1330004-0000-4000-8000-000000000003', 'own-work-routed-accession-2', repeat('c', 64),
    current_setting('app.correlation_id'))$i$) ~ '^(42501|23514) ')::text, 'true');
select pg_temp.expect('LS cannot write a specimen event onto R1''s accession',
  (pg_temp.try($i$insert into lab.specimen_events (specimen_id, accession_id, patient_id, facility_id, event_version,
    event_type, actor_id, actor_membership_id, reason, correlation_id)
    values ('e133000e-0000-4000-8000-000000000003', 'e133000b-0000-4000-8000-000000000003',
    'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 1, 'collected',
    'e1330002-0000-4000-8000-000000000003', 'e1330004-0000-4000-8000-000000000003', 'Collected',
    current_setting('app.correlation_id'))$i$) ~ '^(42501|23514) ')::text, 'true');
select pg_temp.expect('LS (no grant) reads none of Ada''s imported Lab evidence',
  (select count(*)::text from lab.imported_evidence), '0');
select pg_temp.as_member(4);
select pg_temp.expect('NU reads none of it and none of W1''s chain',
  (select count(*) from lab.imported_evidence) || ' ' || pg_temp.lab_chain(1),
  '0 tests=0 accessions=0 requirements=0 specimens=0 executions=0 results=0 locked=0/0/0');
select pg_temp.as_member(11);
select pg_temp.expect('L2 (lab at F2) in a session at F1 reads nothing of W1''s chain',
  (select count(*) from lab.imported_evidence) || ' ' || pg_temp.lab_chain(1),
  '0 tests=0 accessions=0 requirements=0 specimens=0 executions=0 results=0 locked=0/0/0');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: the own dispensings visible, RP and its dispensing hidden',
  format('%s/%s/%s', (select count(*) from pharmacy.dispensings d
     where d.work_item_id in (pg_temp.work_item_of(pg_temp.rx(1)), pg_temp.work_item_of(pg_temp.rx(4)))),
    (select count(*) from pharmacy.work_items where id = 'e1330011-0000-4000-8000-000000000001'),
    (select count(*) from pharmacy.dispensings where id = 'e1330012-0000-4000-8000-000000000001')), '2/0/0');
select pg_temp.expect('PH: RP''s dispensing gives no own work item', (select count(*)::text
  from pharmacy.own_work_access_for('dispensing', 'e1330012-0000-4000-8000-000000000001', 'read_records')), '0');
select pg_temp.expect('PH (no grant) reads none of Ada''s imported medication evidence',
  (select count(*)::text from pharmacy.imported_medication_evidence), '0');
select pg_temp.expect('PH writes Pharmacy''s event about its own dispensing of rx1',
  (select pg_temp.try(format($i$insert into pharmacy.outbox_events (event_type, aggregate_type, aggregate_id,
     aggregate_version, facility_id, patient_id, correlation_id, payload) values ('MedicationDispensed',
     'medication-dispensing', %L, 1, 'e1330001-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000001',
     current_setting('app.correlation_id'), jsonb_build_object('dispensingId', %L::uuid, 'workItemId', %L::uuid,
     'status', 'dispensed'))$i$, d.id, d.id, d.work_item_id))
     from pharmacy.dispensings d where d.work_item_id = pg_temp.work_item_of(pg_temp.rx(1))), 'ok');
select pg_temp.expect('PH cannot write an event about RP''s dispensing',
  pg_temp.try($i$insert into pharmacy.outbox_events (event_type, aggregate_type, aggregate_id, aggregate_version,
    facility_id, patient_id, correlation_id, payload) values ('MedicationDispensed', 'medication-dispensing',
    'e1330012-0000-4000-8000-000000000001', 1, 'e1330001-0000-4000-8000-000000000001',
    'e1330006-0000-4000-8000-000000000001', current_setting('app.correlation_id'),
    '{"status": "dispensed"}')$i$), '42501 new row violates row-level security policy for table "outbox_events"');
select pg_temp.expect('PH cannot write an event of another kind about its own work item',
  pg_temp.try(format($i$insert into pharmacy.outbox_events (event_type, aggregate_type, aggregate_id, aggregate_version,
    facility_id, patient_id, correlation_id, payload) values ('PharmacyImportedMedicationEvidenceCreated',
    'pharmacy-imported-medication-evidence', %L, 1, 'e1330001-0000-4000-8000-000000000001',
    'e1330006-0000-4000-8000-000000000001', current_setting('app.correlation_id'), '{"status": "created"}')$i$,
    pg_temp.work_item_of(pg_temp.rx(1)))), '42501 new row violates row-level security policy for table "outbox_events"');
select pg_temp.expect('PH cannot dispense RP',
  (pg_temp.try(pg_temp.dispense_sql('e1330011-0000-4000-8000-000000000001', 2)) ~ '^(42501|23514) ')::text, 'true');
select pg_temp.as_member(10);
select pg_temp.expect('PG (pharmacist with a grant for Ada) reads her imported medication evidence (consent)',
  (select count(*)::text from pharmacy.imported_medication_evidence), '1');
reset role;

-- 7b. LS (and L3, the second person) works W1's chain with lab-api's own
-- statements (LabAccessionsService, LabExecutionsService), without a grant.
-- A statement's rows changed, or 'SQLSTATE message'.
create function pg_temp.changed(statement text) returns text language plpgsql as $f$
declare answer bigint;
begin
  execute 'with changed as (' || statement || ') select count(*) from changed' into answer;
  return 'rows=' || answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
grant execute on function pg_temp.changed(text) to public;
-- The ids: W1's accession A1 e133000b...01 and requested test T1
-- e133000c...01; new requirement e133000d...02, specimen e133000e...02,
-- execution e133000f...02, result e1330010...02. Ada at F1; LS member 3, L3 15.
create function pg_temp.lab_sql(step text) returns text language sql immutable as $f$
  select case step
    when 'requirement' then $i$insert into lab.specimen_requirements(id,accession_id,patient_id,facility_id,ordinal,
      specimen_type,container_type,notes) values('e133000d-0000-4000-8000-000000000002','e133000b-0000-4000-8000-000000000001',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',2,'urine',null,null)$i$
    when 'specimen' then $i$insert into lab.specimens(id,requirement_id,accession_id,patient_id,facility_id,specimen_type,
      container_type) values('e133000e-0000-4000-8000-000000000002','e133000d-0000-4000-8000-000000000002',
      'e133000b-0000-4000-8000-000000000001','e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',
      'urine',null) returning id$i$
    when 'collect' then $i$update lab.specimens set status='collected',collected_at=clock_timestamp(),
      collected_by='e1330002-0000-4000-8000-000000000003',collected_by_membership_id='e1330004-0000-4000-8000-000000000003',
      collection_notes=null,row_version=row_version+1 where id='e133000e-0000-4000-8000-000000000002'
      and accession_id='e133000b-0000-4000-8000-000000000001' and facility_id='e1330001-0000-4000-8000-000000000001'
      and row_version=1 returning id$i$
    when 'receive' then $i$update lab.specimens set status='received',received_at=clock_timestamp(),
      received_by='e1330002-0000-4000-8000-000000000003',received_by_membership_id='e1330004-0000-4000-8000-000000000003',
      receipt_condition=null,row_version=row_version+1 where id='e133000e-0000-4000-8000-000000000002'
      and accession_id='e133000b-0000-4000-8000-000000000001' and facility_id='e1330001-0000-4000-8000-000000000001'
      and row_version=2 returning id$i$
    when 'start' then $i$insert into lab.test_executions(id,accession_id,specimen_id,requested_test_id,patient_id,facility_id,
      method,started_by,started_by_membership_id,started_at,idempotency_key,request_sha256,correlation_id)
      values('e133000f-0000-4000-8000-000000000002','e133000b-0000-4000-8000-000000000001',
      'e133000e-0000-4000-8000-000000000002','e133000c-0000-4000-8000-000000000001','e1330006-0000-4000-8000-000000000001',
      'e1330001-0000-4000-8000-000000000001',null,'e1330002-0000-4000-8000-000000000003',
      'e1330004-0000-4000-8000-000000000003',clock_timestamp(),'own-work-start-0002',repeat('f',64),
      current_setting('app.correlation_id')) returning id$i$
    when 'complete' then $i$update lab.test_executions set status='completed',completed_at=clock_timestamp(),
      completed_by='e1330002-0000-4000-8000-000000000003',completed_by_membership_id='e1330004-0000-4000-8000-000000000003',
      completion_notes=null,completed_idempotency_key='own-work-complete-0002',completed_request_sha256=repeat('f',64),
      row_version=row_version+1 where id='e133000f-0000-4000-8000-000000000002' and status='in_progress' and row_version=1
      returning id$i$
    when 'result' then $i$insert into lab.results(id,execution_id,patient_id,facility_id,created_by,created_by_membership_id)
      values('e1330010-0000-4000-8000-000000000002','e133000f-0000-4000-8000-000000000002',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001','e1330002-0000-4000-8000-000000000003',
      'e1330004-0000-4000-8000-000000000003') returning id$i$
    when 'revision1' then $i$insert into lab.result_revisions(result_id,execution_id,patient_id,facility_id,version,
      result_type,numeric_value,text_value,unit,reference_range,abnormal_flag,entered_by,entered_by_membership_id,
      correction_reason,idempotency_key,request_sha256,correlation_id,revision_kind,supersedes_version)
      values('e1330010-0000-4000-8000-000000000002','e133000f-0000-4000-8000-000000000002',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',1,'numeric',1.015,null,null,
      '1.005-1.030','normal','e1330002-0000-4000-8000-000000000003','e1330004-0000-4000-8000-000000000003',null,
      'own-work-result-0002',repeat('9',64),current_setting('app.correlation_id'),'original',null) returning id$i$
    when 'correct' then $i$update lab.results set current_version=current_version+1
      where id='e1330010-0000-4000-8000-000000000002' and execution_id='e133000f-0000-4000-8000-000000000002'
      and current_version=1 and (not exists(select 1 from lab.result_releases
        where result_id='e1330010-0000-4000-8000-000000000002' and result_version=1) or false)
      returning current_version$i$
    when 'revision2' then $i$insert into lab.result_revisions(result_id,execution_id,patient_id,facility_id,version,
      result_type,numeric_value,text_value,unit,reference_range,abnormal_flag,entered_by,entered_by_membership_id,
      correction_reason,idempotency_key,request_sha256,correlation_id,revision_kind,supersedes_version)
      values('e1330010-0000-4000-8000-000000000002','e133000f-0000-4000-8000-000000000002',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',2,'numeric',1.020,null,null,
      '1.005-1.030','normal','e1330002-0000-4000-8000-000000000003','e1330004-0000-4000-8000-000000000003',
      'Read again after calibration','own-work-result-0003',repeat('9',64),current_setting('app.correlation_id'),
      'correction',1) returning id$i$
    when 'verify' then $i$insert into lab.result_verifications(result_id,execution_id,patient_id,facility_id,result_version,
      verified_by,verified_by_membership_id,verified_at,reason,idempotency_key,request_sha256,correlation_id)
      values('e1330010-0000-4000-8000-000000000002','e133000f-0000-4000-8000-000000000002',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',2,
      'e1330002-0000-4000-8000-000000000015','e1330004-0000-4000-8000-000000000015',clock_timestamp(),'Checked',
      'own-work-verify-0002',repeat('8',64),current_setting('app.correlation_id')) returning id$i$
    when 'release' then $i$insert into lab.result_releases(verification_id,result_id,execution_id,patient_id,facility_id,
      result_version,released_by,released_by_membership_id,released_at,reason,idempotency_key,request_sha256,correlation_id)
      select verification.id,'e1330010-0000-4000-8000-000000000002','e133000f-0000-4000-8000-000000000002',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',2,
      'e1330002-0000-4000-8000-000000000003','e1330004-0000-4000-8000-000000000003',clock_timestamp(),'Released',
      'own-work-release-0002',repeat('7',64),current_setting('app.correlation_id')
      from lab.result_verifications verification
      where verification.result_id='e1330010-0000-4000-8000-000000000002' and verification.result_version=2
      returning id$i$
  end
$f$;
-- A specimen, execution or result event as lab-api writes it, and its outbox event.
create function pg_temp.lab_event_sql(kind text, version integer, event_type text) returns text language sql immutable as $f$
  select case kind
    when 'specimen' then format($i$insert into lab.specimen_events(specimen_id,accession_id,patient_id,facility_id,
      event_version,event_type,actor_id,actor_membership_id,reason,correlation_id)
      values('e133000e-0000-4000-8000-000000000002','e133000b-0000-4000-8000-000000000001',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',%s,%L,
      'e1330002-0000-4000-8000-000000000003','e1330004-0000-4000-8000-000000000003','Own work suite',
      current_setting('app.correlation_id')) returning id$i$, version, event_type)
    when 'command' then format($i$insert into lab.specimen_command_idempotency(facility_id,patient_id,actor_id,
      idempotency_key,operation,specimen_id,request_sha256,result_version)
      values('e1330001-0000-4000-8000-000000000001','e1330006-0000-4000-8000-000000000001',
      'e1330002-0000-4000-8000-000000000003',%L,%L,'e133000e-0000-4000-8000-000000000002',repeat('a',64),%s)
      returning specimen_id$i$, 'own-work-' || event_type || '-0002', event_type, version)
    when 'execution' then format($i$insert into lab.execution_events(execution_id,patient_id,facility_id,event_version,
      event_type,actor_id,actor_membership_id,reason,correlation_id) values('e133000f-0000-4000-8000-000000000002',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',%s,%L,
      'e1330002-0000-4000-8000-000000000003','e1330004-0000-4000-8000-000000000003','Own work suite',
      current_setting('app.correlation_id')) returning execution_id$i$, version, event_type)
    when 'result' then format($i$insert into lab.result_events(result_id,execution_id,patient_id,facility_id,event_version,
      event_type,actor_id,actor_membership_id,reason,correlation_id) values('e1330010-0000-4000-8000-000000000002',
      'e133000f-0000-4000-8000-000000000002','e1330006-0000-4000-8000-000000000001',
      'e1330001-0000-4000-8000-000000000001',%s,%L,'e1330002-0000-4000-8000-000000000003',
      'e1330004-0000-4000-8000-000000000003','Own work suite',current_setting('app.correlation_id')) returning result_id$i$,
      version, event_type)
    when 'outbox' then format($i$insert into lab.outbox_events(event_type,aggregate_id,aggregate_version,facility_id,
      patient_id,correlation_id,payload) values(%L,'e133000e-0000-4000-8000-000000000002',%s,
      'e1330001-0000-4000-8000-000000000001','e1330006-0000-4000-8000-000000000001',current_setting('app.correlation_id'),
      '{"status":"own-work-suite"}'::jsonb) returning id$i$, event_type, version)
  end
$f$;
-- W1's chain rows as the session reads them (counts per table, new rows only).
create function pg_temp.lab_chain_written() returns text language sql as $f$
  select format('requirements=%s specimens=%s specimen_events=%s commands=%s executions=%s execution_events=%s '
      || 'results=%s revisions=%s result_events=%s verifications=%s releases=%s',
    (select count(*) from lab.specimen_requirements where id = 'e133000d-0000-4000-8000-000000000002'),
    (select string_agg(status || ':' || row_version, ',') from lab.specimens where id = 'e133000e-0000-4000-8000-000000000002'),
    (select count(*) from lab.specimen_events where specimen_id = 'e133000e-0000-4000-8000-000000000002'),
    (select count(*) from lab.specimen_command_idempotency where specimen_id = 'e133000e-0000-4000-8000-000000000002'),
    (select string_agg(status || ':' || row_version, ',') from lab.test_executions
      where id = 'e133000f-0000-4000-8000-000000000002'),
    (select count(*) from lab.execution_events where execution_id = 'e133000f-0000-4000-8000-000000000002'),
    (select string_agg(current_version::text, ',') from lab.results where id = 'e1330010-0000-4000-8000-000000000002'),
    (select count(*) from lab.result_revisions where result_id = 'e1330010-0000-4000-8000-000000000002'),
    (select count(*) from lab.result_events where result_id = 'e1330010-0000-4000-8000-000000000002'),
    (select count(*) from lab.result_verifications where result_id = 'e1330010-0000-4000-8000-000000000002'),
    (select count(*) from lab.result_releases where result_id = 'e1330010-0000-4000-8000-000000000002'))
$f$;
grant execute on function pg_temp.lab_sql(text), pg_temp.lab_event_sql(text, integer, text),
  pg_temp.lab_chain_written() to public;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('LS: a second specimen requirement and specimen on W1''s accession, with their event',
  format('%s %s %s', pg_temp.try(pg_temp.lab_sql('requirement')), pg_temp.changed(pg_temp.lab_sql('specimen')),
    pg_temp.changed(pg_temp.lab_event_sql('specimen', 1, 'specimen_required'))), 'ok rows=1 rows=1');
select pg_temp.expect('LS collects it: the update, its command key, its event and its outbox event',
  format('%s %s %s %s', pg_temp.changed(pg_temp.lab_sql('collect')), pg_temp.changed(pg_temp.lab_event_sql('command', 2,
    'collect')), pg_temp.changed(pg_temp.lab_event_sql('specimen', 2, 'specimen_collected')),
    pg_temp.changed(pg_temp.lab_event_sql('outbox', 2, 'LabSpecimenCollected'))), 'rows=1 rows=1 rows=1 rows=1');
select pg_temp.expect('LS receives it',
  format('%s %s %s', pg_temp.changed(pg_temp.lab_sql('receive')), pg_temp.changed(pg_temp.lab_event_sql('command', 3,
    'receive')), pg_temp.changed(pg_temp.lab_event_sql('specimen', 3, 'specimen_received'))), 'rows=1 rows=1 rows=1');
select pg_temp.expect('LS starts and completes an execution on it, with their events',
  format('%s %s %s %s', pg_temp.changed(pg_temp.lab_sql('start')),
    pg_temp.changed(pg_temp.lab_event_sql('execution', 1, 'execution_started')), pg_temp.changed(pg_temp.lab_sql('complete')),
    pg_temp.changed(pg_temp.lab_event_sql('execution', 2, 'execution_completed'))), 'rows=1 rows=1 rows=1 rows=1');
select pg_temp.expect('LS enters a result and corrects it (the head''s update), with their events',
  format('%s %s %s %s %s %s', pg_temp.changed(pg_temp.lab_sql('result')), pg_temp.changed(pg_temp.lab_sql('revision1')),
    pg_temp.changed(pg_temp.lab_event_sql('result', 1, 'result_entered')), pg_temp.changed(pg_temp.lab_sql('correct')),
    pg_temp.changed(pg_temp.lab_sql('revision2')), pg_temp.changed(pg_temp.lab_event_sql('result', 2, 'result_corrected'))),
  'rows=1 rows=1 rows=1 rows=1 rows=1 rows=1');
select pg_temp.expect('LS may not check its own result (0021, two people)',
  (split_part(pg_temp.changed(pg_temp.lab_sql('verify')), ' ', 1) <> 'rows=1')::text, 'true');
select pg_temp.as_member(15);
select pg_temp.expect('L3 (no grant) checks it', pg_temp.changed(pg_temp.lab_sql('verify')), 'rows=1');
select pg_temp.as_member(3);
select pg_temp.expect('LS releases it', pg_temp.changed(pg_temp.lab_sql('release')), 'rows=1');
select pg_temp.expect('LS reads back every row it wrote', pg_temp.lab_chain_written(),
  'requirements=1 specimens=received:3 specimen_events=3 commands=2 executions=completed:2 execution_events=2 '
  || 'results=2 revisions=2 result_events=2 verifications=1 releases=1');
select pg_temp.expect('LS cannot change R1''s specimen or execution (routed): nothing is updated',
  format('%s %s', pg_temp.changed($u$update lab.specimens set row_version=row_version+1
      where id='e133000e-0000-4000-8000-000000000003' returning id$u$),
    pg_temp.changed($u$update lab.test_executions set row_version=row_version+1
      where id='e133000f-0000-4000-8000-000000000003' returning id$u$)), 'rows=0 rows=0');
select pg_temp.expect('LS cannot write a result revision onto R1''s result (routed)',
  (pg_temp.changed($i$insert into lab.result_revisions(result_id,execution_id,patient_id,facility_id,version,result_type,
    numeric_value,unit,abnormal_flag,entered_by,entered_by_membership_id,idempotency_key,request_sha256,correlation_id,
    revision_kind) values('e1330010-0000-4000-8000-000000000003','e133000f-0000-4000-8000-000000000003',
    'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',1,'numeric',5.5,'mmol/L','normal',
    'e1330002-0000-4000-8000-000000000003','e1330004-0000-4000-8000-000000000003','own-work-routed-result',
    repeat('9',64),current_setting('app.correlation_id'),'original') returning id$i$) ~ '^(42501|23514) ')::text, 'true');
select pg_temp.as_member(4);
select pg_temp.expect('NU (nurse) reads none of it', pg_temp.lab_chain_written(),
  'requirements=0 specimens= specimen_events=0 commands=0 executions= execution_events=0 results= '
  || 'revisions=0 result_events=0 verifications=0 releases=0');
select pg_temp.as_member(11, 1);
select pg_temp.expect('L2 (lab at F2) in a session at F1 reads none of it', pg_temp.lab_chain_written(),
  'requirements=0 specimens= specimen_events=0 commands=0 executions= execution_events=0 results= '
  || 'revisions=0 result_events=0 verifications=0 releases=0');
reset role;
-- The services' inserts that answer the new row (RETURNING, so the row must
-- also pass the read policies): LS's accession of a new own lab item W4,
-- PH's dispensing of rx2 and its reversal, exactly as lab-api and
-- pharmacy-api write them.
set local session_replication_role = replica;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
  requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
values ('e133000a-0000-4000-8000-000000000004', 'e1330006-0000-4000-8000-000000000001',
  'e1330001-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', gen_random_uuid(), 1,
  gen_random_uuid(), 'accepted', 'routine', 'http://loinc.org', '2160-0', 'Creatinine',
  'e1330002-0000-4000-8000-000000000001', clock_timestamp(), 'e1330002-0000-4000-8000-000000000001',
  'e1330004-0000-4000-8000-000000000001', 'own-work-lab-item-4-key', repeat('b', 64), 'own-work-suite-lab-4');
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('LS accessions W4 with lab-api''s statement, answering the row',
  pg_temp.changed($i$insert into lab.accessions(work_item_id,patient_id,facility_id,priority,created_by,
    created_by_membership_id,idempotency_key,request_sha256,correlation_id)
    values('e133000a-0000-4000-8000-000000000004','e1330006-0000-4000-8000-000000000001',
    'e1330001-0000-4000-8000-000000000001','routine','e1330002-0000-4000-8000-000000000003',
    'e1330004-0000-4000-8000-000000000003','own-work-accession-0004',repeat('c',64),current_setting('app.correlation_id'))
    returning id::text,accession_number,work_item_id::text,patient_id::text,facility_id::text,status,priority,
    row_version::text,created_at,request_sha256$i$), 'rows=1');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH dispenses rx2 with pharmacy-api''s statement, answering the row',
  pg_temp.changed(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(2)), 2) || ' returning *'), 'rows=1');
select pg_temp.expect('PH reverses it with pharmacy-api''s statement, answering the row',
  (select pg_temp.changed(format($i$insert into pharmacy.dispensing_reversals (
        id,dispensing_id,dispensing_version,work_item_id,patient_id,facility_id,reversed_by,
        reversed_by_membership_id,reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,%L,%L,%L,'e1330002-0000-4000-8000-000000000002','e1330004-0000-4000-8000-000000000002',
        'Dispensed to the wrong patient','own-work-reverse-0002',repeat('e',64),current_setting('app.correlation_id'))
      returning *$i$, gen_random_uuid(), d.id, d.work_item_id, d.patient_id, d.facility_id))
     from pharmacy.dispensings d where d.work_item_id = pg_temp.work_item_of(pg_temp.rx(2))), 'rows=1');
reset role;

-- 7c. The deny directive, scope by scope. One directive for Ada at a time,
-- written as replica and undone (a subtransaction rolled back on purpose),
-- each answered as PH's and LS's sessions would see rx1's pharmacy item and
-- W1 through D9 (D1 is consent's own deny test, so the same scope rules).
create function pg_temp.deny_scope(grantee_kind text, grantee uuid, site uuid, deny_actions text[], deny_purposes text[],
  starts interval default interval '-1 hour', ends interval default null) returns text language plpgsql as $f$
declare answer text;
begin
  begin
    if grantee_kind is null then
      raise exception using errcode = 'P0002', message = 'own work suite: no directive';
    end if;
    perform set_config('session_replication_role', 'replica', true);
    insert into identity.consent_directives (id, patient_id, current_version)
    values ('e1330009-0000-4000-8000-000000000002', 'e1330006-0000-4000-8000-000000000001', 1);
    insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
      grantee_type, grantee_id, facility_id, purposes, actions, starts_at, expires_at, source_reference, reason,
      content_sha256)
    values (gen_random_uuid(), 'e1330009-0000-4000-8000-000000000002', 'e1330006-0000-4000-8000-000000000001', 1,
      'active', 'deny', grantee_kind, grantee, site, deny_purposes, deny_actions, clock_timestamp() + starts,
      clock_timestamp() + ends, 'own-work-suite', 'Synthetic scoped deny directive', repeat('c', 64));
    perform set_config('session_replication_role', 'origin', true);
    answer := pg_temp.own_work_answers();
    raise exception using errcode = 'P0001', message = 'own work suite: undo the directive';
  exception
    when sqlstate 'P0001' then
      null;
    when sqlstate 'P0002' then
      answer := pg_temp.own_work_answers();
  end;
  return answer;
end $f$;
-- PH's and LS's answers from D9 on rx1's pharmacy item and W1, in their sessions.
create function pg_temp.own_work_answers() returns text language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.as_member(2);
  answer := format('PH read=%s write=%s',
    (select count(*) from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(1)), 'read_records')),
    (select count(*) from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(1)), 'write_records')));
  perform pg_temp.as_member(3);
  answer := answer || format(' LS read=%s', (select count(*) from lab.own_work_access_for('work_item',
    'e133000a-0000-4000-8000-000000000001', 'read_records')));
  return answer;
end $f$;
select pg_temp.expect('without a directive both work on Ada''s items',
  pg_temp.deny_scope(null, null, null, '{}', '{}'), 'PH read=1 write=1 LS read=1');
-- A directive on reads only: D9 also answers no write where the schema's
-- owner is under forced row-level security (production), since it cannot
-- read the item; where the owner bypasses it, D9 answers the write. The APIs
-- read the item first either way, so the case reads "either".
select pg_temp.expect('each scope of a deny directive for Ada',
  regexp_replace((select string_agg(label || ': ' || pg_temp.deny_scope(kind, grantee, site, deny_actions, deny_purposes,
     starts, ends), '; ' order by n)
     from (values
       (0, 'everyone', 'all', null, null, '{}', '{}', interval '-1 hour', null),
       (1, 'this facility', 'facility', 'e1330001-0000-4000-8000-000000000001'::uuid, null::uuid, '{}'::text[], '{}'::text[],
         interval '-1 hour', null::interval),
       (2, 'another facility', 'facility', 'e1330001-0000-4000-8000-000000000002', null, '{}', '{}', interval '-1 hour', null),
       (3, 'this organization', 'organization', 'e1330000-0000-4000-8000-000000000001', null, '{}', '{}', interval '-1 hour',
         null),
       (4, 'another organization', 'organization', gen_random_uuid(), null, '{}', '{}', interval '-1 hour', null),
       (5, 'PH as staff', 'staff', 'e1330003-0000-4000-8000-000000000002', null, '{}', '{}', interval '-1 hour', null),
       (6, 'everyone at F2 only', 'all', null, 'e1330001-0000-4000-8000-000000000002', '{}', '{}', interval '-1 hour', null),
       (7, 'everyone at F1 only', 'all', null, 'e1330001-0000-4000-8000-000000000001', '{}', '{}', interval '-1 hour', null),
       (8, 'writes only', 'all', null, null, '{write_records}', '{}', interval '-1 hour', null),
       (9, 'reads only', 'all', null, null, '{read_records}', '{}', interval '-1 hour', null),
       (10, 'emergency only', 'all', null, null, '{}', '{emergency}', interval '-1 hour', null),
       (11, 'direct care', 'all', null, null, '{}', '{direct-care}', interval '-1 hour', null),
       (12, 'not yet started', 'all', null, null, '{}', '{}', interval '1 hour', null),
       (13, 'expired', 'all', null, null, '{}', '{}', interval '-2 hours', interval '-1 hour'))
       scope(n, label, kind, grantee, site, deny_actions, deny_purposes, starts, ends)),
    'reads only: PH read=0 write=[01]', 'reads only: PH read=0 write=either'),
  'everyone: PH read=0 write=0 LS read=0; '
  || 'this facility: PH read=0 write=0 LS read=0; another facility: PH read=1 write=1 LS read=1; '
  || 'this organization: PH read=0 write=0 LS read=0; another organization: PH read=1 write=1 LS read=1; '
  || 'PH as staff: PH read=0 write=0 LS read=1; everyone at F2 only: PH read=1 write=1 LS read=1; '
  || 'everyone at F1 only: PH read=0 write=0 LS read=0; writes only: PH read=1 write=0 LS read=1; '
  || 'reads only: PH read=0 write=either LS read=0; emergency only: PH read=1 write=1 LS read=1; '
  || 'direct care: PH read=0 write=0 LS read=0; not yet started: PH read=1 write=1 LS read=1; '
  || 'expired: PH read=1 write=1 LS read=1');
select pg_temp.expect('the directives were undone', (select count(*)::text from identity.consent_directives
  where id = 'e1330009-0000-4000-8000-000000000002'), '0');

-- 7d. 0125's prescription details read the chart's version snapshots, so
-- they still need the member's consent: none for PH, rx1's for PG.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH (own work, no grant) reads no prescription details', (select count(*)::text
  from pharmacy.work_item_prescription_details(array[pg_temp.work_item_of(pg_temp.rx(1))])), '0');
select pg_temp.as_member(10);
select pg_temp.expect('PG (a grant for Ada) reads rx1''s details', (select count(*)::text
  from pharmacy.work_item_prescription_details(array[pg_temp.work_item_of(pg_temp.rx(1))])), '1');
reset role;

-- 7e. (5b) A change after the dispensing: PH dispensed rx1 in case 3; DR now
-- edits it while it stays active. D8's trigger still records the change on
-- the send, but neither the withdrawal's answer nor D10's flag reports it:
-- the pharmacy dispensed what was sent and has nothing left to dispense.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('rx1 is dispensed and sent at version 2, not withdrawn', ehr.withdraw_own_pharmacy_send(pg_temp.rx(1))::text,
  'false');
select set_config('app.change_reason', 'Changed the frequency after dispensing', true);
update ehr.prescriptions set frequency = 'Every 8 hours' where id = pg_temp.rx(1);
select pg_temp.expect('the edited rx1 is active at version 3', (select p.status || '/' || p.row_version
  from ehr.prescriptions p where p.id = pg_temp.rx(1)), 'active/3');
select pg_temp.expect('the withdrawal answers false for the dispensed rx1',
  ehr.withdraw_own_pharmacy_send(pg_temp.rx(1))::text, 'false');
reset role;
select pg_temp.expect('the change is still recorded on rx1''s send', (select (s.withdrawn_at is not null)::text
  from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(1)), 'true');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: the dispensed and edited rx1 does not read withdrawn',
  (select string_agg(state.basis || '/' || state.withdrawn, ',')
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(1))]) state), 'own-work/false');
select pg_temp.expect('PH: the held rx3 (never dispensed) still reads withdrawn',
  (select string_agg(state.basis || '/' || state.withdrawn, ',')
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(3))]) state), 'own-work/true');
reset role;

-- 8. The owner-run definer functions that read ehr.prescriptions (case 1
-- lists them) give PH nothing more through the EHR runtime: each refuses
-- the pharmacist before it reads (the two validators are cases 3 and 5).
create function pg_temp.rows_of(statement text) returns text language plpgsql as $f$
declare answer bigint;
begin
  execute 'select count(*) from (' || statement || ') listed' into answer;
  return 'rows=' || answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
grant execute on function pg_temp.rows_of(text) to public;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: ehr.send_order_route refuses', pg_temp.try(format($s$select * from ehr.send_order_route(
  gen_random_uuid(), 'prescription', 'e1330006-0000-4000-8000-000000000001', %L, 'e1330008-0000-4000-8000-000000000001',
  2, 'e1330001-0000-4000-8000-000000000002', 'v1', 'own-work-route-probe', repeat('a', 64))$s$, pg_temp.rx(4))),
  '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.expect('PH: the own-pharmacy send refuses',
  pg_temp.send(pg_temp.rx(4), 2), '42501 OWN_PHARMACY_SEND_DENIED');
select pg_temp.expect('PH: the withdrawal refuses', pg_temp.try(format(
  'select ehr.withdraw_own_pharmacy_send(%L)', pg_temp.rx(4))), '42501 OWN_PHARMACY_SEND_DENIED');
-- (The list is the patient's own: a staff session is refused.)
select pg_temp.expect('PH: the patient''s own route list answers nothing for a staff session',
  pg_temp.rows_of('select * from ehr.patient_list_order_routes()'), '42501 PATIENT_SESSION_REQUIRED');
reset role;

-- 9. The undo order (0133's header). With the withdrawal trigger left in
-- place, dropping the sends table succeeds (plpgsql records no dependency)
-- and every later change of a prescription's status or version fails with
-- 42P01; dropping the trigger and its function first leaves prescription
-- changes working. Each in a savepoint, rolled back.
savepoint undo_table_first;
drop table pharmacy.own_prescription_sends;
select pg_temp.expect('the trigger is still there', (select count(*)::text from pg_trigger
  where tgname = 'prescriptions_own_pharmacy_send_withdrawn'), '1');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select set_config('app.change_reason', 'Undo order probe', true);
select pg_temp.expect('the sends table dropped first: a prescription change fails',
  pg_temp.try(format($s$update ehr.prescriptions set frequency = 'Every 6 hours' where id = %L$s$, pg_temp.rx(6))),
  '42P01 relation "pharmacy.own_prescription_sends" does not exist');
reset role;
rollback to savepoint undo_table_first;
savepoint undo_trigger_first;
drop trigger prescriptions_own_pharmacy_send_withdrawn on ehr.prescriptions;
drop function ehr.own_pharmacy_send_withdrawn_on_change();
drop table pharmacy.own_prescription_sends;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select set_config('app.change_reason', 'Undo order probe', true);
select pg_temp.expect('the trigger and its function dropped first: the change goes through',
  pg_temp.try(format($s$update ehr.prescriptions set frequency = 'Every 6 hours' where id = %L$s$, pg_temp.rx(6))),
  'ok');
reset role;
rollback to savepoint undo_trigger_first;
select pg_temp.expect('both undone: the sends table and the trigger are back',
  (select (to_regclass('pharmacy.own_prescription_sends') is not null)::text || '/' || count(*)::text from pg_trigger
    where tgname = 'prescriptions_own_pharmacy_send_withdrawn'), 'true/1');

rollback;
