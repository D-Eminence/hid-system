\set ON_ERROR_STOP on
-- A same-facility Pharmacy acceptance is exactly its EHR prescription (0100,
-- owner decision of 2026-11-01, D-Eminence: "Fix it now"). Rollback-only.
--
-- Before 0100, pharmacy.validate_work_item's same-facility branch checked the
-- session, facility and actor, source_status (which the caller supplies) and
-- that the prescription was not routed; it never read ehr.prescriptions. Now
-- it reads the prescription FOR SHARE and refuses, with 23514:
--   PRESCRIPTION_SOURCE_NOT_FOUND         no such prescription (or one the
--                                         session may not read and write);
--   PRESCRIPTION_SOURCE_NOT_ACTIVE        not active;
--   PRESCRIPTION_SOURCE_VERSION_MISMATCH  another version;
--   PRESCRIPTION_SOURCE_MISMATCH          any field differs.
-- Cases:
--   1. structure: the body is 0100's; the order-route branch and the checks
--      after the new ones are byte for byte 0086's; attributes, trigger, ACL;
--   2. legitimate acceptances pass: the values exactly as the EHR API's
--      hand-off sends them through pharmacy-api (texts trimmed, dose as a
--      JSON number, dates as the ISO timestamps a JavaScript Date makes,
--      prescribed_at cut to the millisecond), the stored values themselves,
--      a prescription without the optional fields, ones whose stored texts
--      carry what String.prototype.trim() removes (all 25 characters), one
--      at version 2;
--   3. a missing prescription; each inactive status (draft, on hold,
--      completed, cancelled, entered in error); a wrong version; each field
--      different in turn (and null against a value, both ways);
--      the refusals' order (status, then version, then fields, then 0077's
--      session checks and source_status);
--   4. the order-route branch never reads the prescription;
--   5. the sealed demo tenant (0098): its doctor's prescription is accepted
--      at Demo Hospital, a changed one is refused, and neither side can name
--      the other's prescription;
--   6. lock: the acceptance holds the prescription row locked to commit
--      (its xmax is this transaction's; that another session's update waits
--      is checked by the proof script with two sessions), and the EHR's own
--      update of it in the same transaction still runs.
-- The acceptances run as hid_pharmacy_api_runtime with the session
-- pharmacy-api sets (DatabaseService.transaction), using pharmacy-api's own
-- INSERT (PharmacyService.acceptPrescription); the EHR rows are written as
-- hid_ehr_api_runtime with the EHR API's own INSERT and UPDATE. Each probe is
-- undone. Under an owner that bypasses row-level security (this runner) a
-- prescription of another facility is a mismatch; under the release
-- rehearsal's NOSUPERUSER NOBYPASSRLS owner (production) it is not found, and
-- the expectations follow the owner (recorded below).
set plpgsql.variable_conflict = error;
begin;

-- 1. Structure.
do $$
declare
  body text := (select prosrc from pg_proc where oid = 'pharmacy.validate_work_item()'::regprocedure);
  mismatch text;
begin
  if md5(body) <> '8fb2944de050dedd973e5d7f07d9c301' then
    raise exception 'pharmacy.validate_work_item is not 0100''s (md5 %)', md5(body);
  end if;
  -- 0086's order-route branch (the 2327 characters after its IF) and 0086's
  -- same-facility checks (from "if session_facility_id is null" to the end).
  if md5(split_part(split_part(body, E'  if new.order_route_id is not null then\n', 2),
           E'    return new;\n  end if;\n', 1)) <> '68509bb204820f30f89371415dc4051f'
     or md5(substr(body, position(E'  if session_facility_id is null\n' in body))) <> '817fadddb419760ea48fd60a7565fa1e' then
    raise exception 'the order-route branch or the existing checks of pharmacy.validate_work_item changed';
  end if;
  select string_agg(format('definer=%s config=%s volatile=%s strict=%s', p.prosecdef, p.proconfig, p.provolatile,
           p.proisstrict), '; ') into mismatch
    from pg_proc p
   where p.oid = 'pharmacy.validate_work_item()'::regprocedure
     and (not p.prosecdef or p.proconfig is distinct from '{"search_path=pharmacy, platform, pg_temp"}'::text[]
       or p.provolatile <> 'v' or p.proisstrict
       or p.proowner <> (select proowner from pg_proc where oid = 'pharmacy.context_allows(uuid,uuid,text)'::regprocedure));
  if mismatch is not null then
    raise exception 'pharmacy.validate_work_item attributes changed: %', mismatch;
  end if;
  if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
              where p.oid = 'pharmacy.validate_work_item()'::regprocedure and acl.grantee <> p.proowner) then
    raise exception 'pharmacy.validate_work_item is executable by a role other than its owner';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'pharmacy.work_items'::regclass
        and tgname = 'pharmacy_work_item_validate' and tgfoid = 'pharmacy.validate_work_item()'::regprocedure
        and tgenabled = 'O' and tgtype = 7) <> 1 then
    raise exception 'pharmacy_work_item_validate is not BEFORE INSERT FOR EACH ROW on pharmacy.work_items';
  end if;
  perform set_config('source_check.owner_bypasses', (select (r.rolsuper or r.rolbypassrls)::text
    from pg_proc p join pg_roles r on r.oid = p.proowner
   where p.oid = 'pharmacy.validate_work_item()'::regprocedure), true);
end $$;

-- Fixtures (as replica: identity rows without their triggers). Clinic C1
-- (e9c00001...01) and C2 (...02); doctor D (account e9c00002...01,
-- membership e9c00004...01) and pharmacist A (...02) at C1, doctor D2 (...03)
-- at C2; patients P1 (e9c00005...01) and P2 (...02). D and A have write
-- consent for P1 and P2 at C1, D2 for P1 at C2.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'pharmacy-source-test')
on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e9c00000-0000-4000-8000-000000000001', 'Source Check Organization', 'source-check-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e9c00001-0000-4000-8000-000000000001', 'e9c00000-0000-4000-8000-000000000001', 'Source Check Clinic',
   'SOURCE-CHECK-1', 'Africa/Lagos', true, 'verified'),
  ('e9c00001-0000-4000-8000-000000000002', 'e9c00000-0000-4000-8000-000000000001', 'Source Check Annex',
   'SOURCE-CHECK-2', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e9c00002-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:pharmacy-source-' || x,
       'pharmacy-source-' || x || '@example.invalid', 'Source Check ' || x, 'active'
  from (values (1, 'doctor'), (2, 'pharmacist'), (3, 'annex-doctor')) member(n, x);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e9c00003-0000-4000-8000-00000000000' || n)::uuid, ('e9c00002-0000-4000-8000-00000000000' || n)::uuid,
       'Source Check ' || x, 'pharmacy-source-' || x || '@example.invalid', 'verified', role_code
  from (values (1, 'doctor', 'doctor'), (2, 'pharmacist', 'pharmacist'), (3, 'annex-doctor', 'doctor'))
       member(n, x, role_code);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role)
select ('e9c00004-0000-4000-8000-00000000000' || n)::uuid, ('e9c00003-0000-4000-8000-00000000000' || n)::uuid,
       ('e9c00002-0000-4000-8000-00000000000' || n)::uuid, 'e9c00000-0000-4000-8000-000000000001',
       ('e9c00001-0000-4000-8000-00000000000' || site)::uuid, role_code, role_code
  from (values (1, 1, 'doctor'), (2, 1, 'pharmacist'), (3, 2, 'doctor')) member(n, site, role_code);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('e9c00005-0000-4000-8000-000000000001', 'HID-SRCCHKA', 'Source', 'One', 'Source One', 'active'),
  ('e9c00005-0000-4000-8000-000000000002', 'HID-SRCCHKB', 'Source', 'Two', 'Source Two', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
select gen_random_uuid(), ('e9c00005-0000-4000-8000-00000000000' || patient)::uuid,
       ('e9c00003-0000-4000-8000-00000000000' || member)::uuid, ('e9c00002-0000-4000-8000-00000000000' || member)::uuid,
       ('e9c00004-0000-4000-8000-00000000000' || member)::uuid, ('e9c00001-0000-4000-8000-00000000000' || site)::uuid,
       'write_records', 'direct-care', 'active', 'Synthetic source check consent',
       clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days'
  from (values (1, 1, 1), (2, 1, 1), (1, 2, 1), (2, 2, 1), (3, 1, 2)) consent(member, patient, site);
set local session_replication_role = origin;

-- The sessions the services set: the EHR API's and pharmacy-api's are the
-- same five settings.
create function pg_temp.as_member(member integer, site integer) returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:pharmacy-source-'
           || (array['doctor', 'pharmacist', 'annex-doctor'])[member], true),
         set_config('app.facility_id', 'e9c00001-0000-4000-8000-00000000000' || site, true),
         set_config('app.correlation_id', 'pharmacy-source-' || substr(md5(random()::text), 1, 12), true),
         set_config('app.membership_id', 'e9c00004-0000-4000-8000-00000000000' || member, true),
         set_config('app.purpose_of_use', 'direct-care', true);
$f$;

-- The EHR rows, through the EHR runtime with the EHR API's statements
-- (prescriptions.service.ts create and update). Encounters E1, E2 (P1) and E3
-- (P2) at C1, E4 (P1) at C2.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1, 1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e9c00006-0000-4000-8000-00000000000' || n)::uuid, ('e9c00005-0000-4000-8000-00000000000' || patient)::uuid,
       'e9c00001-0000-4000-8000-000000000001', 'e9c00002-0000-4000-8000-000000000001',
       'e9c00004-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp()
  from (values (1, 1), (2, 1), (3, 2)) encounter(n, patient);
create function pg_temp.prescribe(prescription uuid, encounter uuid, patient uuid, facility uuid, creator uuid,
  creator_membership uuid, code_system text, code text, display text, dose numeric, unit text, route text,
  frequency text, instructions text, starts date, ends date, status text) returns void language sql as $f$
  insert into ehr.prescriptions (
    id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    medication_code_system, medication_code, medication_display, dose_quantity, dose_unit,
    route_code, frequency, instructions, starts_on, ends_on, status
  ) values (prescription, encounter, patient, facility, creator, creator_membership, code_system, code, display, dose,
    unit, route, frequency, instructions, starts, ends, status);
$f$;
create function pg_temp.change(prescription uuid, new_status text, new_frequency text, new_instructions text,
  new_ends date, expected_version bigint, reason text) returns void language plpgsql as $f$
begin
  perform set_config('app.change_reason', reason, true);
  update ehr.prescriptions set
    status = coalesce(new_status, status), frequency = coalesce(new_frequency, frequency),
    instructions = coalesce(new_instructions, instructions), ends_on = coalesce(new_ends, ends_on)
  where id = prescription and row_version = expected_version;
  if not found then raise exception 'source check suite: % was not at version %', prescription, expected_version; end if;
end $f$;
-- RA: every field. RB: no optional field. RW: texts carrying what trim()
-- removes (no EHR API path stores them; a direct writer could). RV: changed
-- once (version 2). RP2: P2's. The inactive ones: RDR draft (version 1), RH,
-- RC, RX, RE on hold, completed, cancelled, entered in error (version 2).
select pg_temp.prescribe('e9c00007-0000-4000-8000-0000000000a1', 'e9c00006-0000-4000-8000-000000000001',
  'e9c00005-0000-4000-8000-000000000001', 'e9c00001-0000-4000-8000-000000000001', 'e9c00002-0000-4000-8000-000000000001',
  'e9c00004-0000-4000-8000-000000000001', 'http://www.whocc.no/atc', 'J01CA04', 'Amoxicillin 500 mg capsule', 1.5,
  'capsule', 'oral', 'Every 8 hours', 'Take after food for 7 days', date '2026-11-01', date '2026-11-08', 'active');
select pg_temp.prescribe('e9c00007-0000-4000-8000-0000000000b1', 'e9c00006-0000-4000-8000-000000000001',
  'e9c00005-0000-4000-8000-000000000001', 'e9c00001-0000-4000-8000-000000000001', 'e9c00002-0000-4000-8000-000000000001',
  'e9c00004-0000-4000-8000-000000000001', null, null, 'Paracetamol', null, null, null, 'When needed',
  'Up to four times a day', null, null, 'active');
select pg_temp.prescribe('e9c00007-0000-4000-8000-0000000000c1', 'e9c00006-0000-4000-8000-000000000001',
  'e9c00005-0000-4000-8000-000000000001', 'e9c00001-0000-4000-8000-000000000001', 'e9c00002-0000-4000-8000-000000000001',
  'e9c00004-0000-4000-8000-000000000001', ' urn:hid:medication' || chr(9), chr(160) || 'ibuprofen-400' || chr(12288),
  chr(65279) || 'Ibuprofen 400 mg ' || chr(8232), 2, ' tablet' || chr(10), chr(8201) || 'oral ', chr(13) || 'Twice daily',
  'With food' || chr(11) || chr(8239), date '2026-11-02', null, 'active');
-- RW2: instructions wrapped in all 25 characters trim() removes, each once on
-- each side (tab, LF, VT, FF, CR, space, U+00A0, U+1680, U+2000-U+200A,
-- U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF).
select pg_temp.prescribe('e9c00007-0000-4000-8000-0000000000c2', 'e9c00006-0000-4000-8000-000000000001',
  'e9c00005-0000-4000-8000-000000000001', 'e9c00001-0000-4000-8000-000000000001', 'e9c00002-0000-4000-8000-000000000001',
  'e9c00004-0000-4000-8000-000000000001', null, null, 'Omeprazole 20 mg', null, null, null, 'Once daily',
  (select string_agg(chr(c), '' order by c) || 'Before breakfast' || string_agg(chr(c), '' order by c desc)
     from unnest(array[9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
       8202, 8232, 8233, 8239, 8287, 12288, 65279]) c), null, null, 'active');
select pg_temp.prescribe('e9c00007-0000-4000-8000-0000000000d1', 'e9c00006-0000-4000-8000-000000000001',
  'e9c00005-0000-4000-8000-000000000001', 'e9c00001-0000-4000-8000-000000000001', 'e9c00002-0000-4000-8000-000000000001',
  'e9c00004-0000-4000-8000-000000000001', null, null, 'Metformin 500 mg', 500, 'mg', 'oral', 'Twice daily',
  'With meals', null, null, 'active');
select pg_temp.change('e9c00007-0000-4000-8000-0000000000d1', null, null, 'With breakfast and dinner', null, 1,
  'Instructions clarified');
select pg_temp.prescribe('e9c00007-0000-4000-8000-0000000000e1', 'e9c00006-0000-4000-8000-000000000003',
  'e9c00005-0000-4000-8000-000000000002', 'e9c00001-0000-4000-8000-000000000001', 'e9c00002-0000-4000-8000-000000000001',
  'e9c00004-0000-4000-8000-000000000001', 'http://www.whocc.no/atc', 'J01CA04', 'Amoxicillin 500 mg capsule', 1.5,
  'capsule', 'oral', 'Every 8 hours', 'Take after food for 7 days', date '2026-11-01', date '2026-11-08', 'active');
select pg_temp.prescribe(('e9c00007-0000-4000-8000-0000000000f' || n)::uuid, 'e9c00006-0000-4000-8000-000000000001',
  'e9c00005-0000-4000-8000-000000000001', 'e9c00001-0000-4000-8000-000000000001', 'e9c00002-0000-4000-8000-000000000001',
  'e9c00004-0000-4000-8000-000000000001', null, null, 'Lisinopril 10 mg', null, null, null, 'Once daily',
  'In the morning', null, null, case when n = 1 then 'draft' else 'active' end)
  from generate_series(1, 5) n;
select pg_temp.change(('e9c00007-0000-4000-8000-0000000000f' || n)::uuid, status, null, null, null, 1,
  'Status changed by the prescriber')
  from (values (2, 'on_hold'), (3, 'completed'), (4, 'cancelled'), (5, 'entered_in_error')) inactive(n, status);
-- R2: P1's at C2, by D2.
select pg_temp.as_member(3, 2);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e9c00006-0000-4000-8000-000000000004', 'e9c00005-0000-4000-8000-000000000001',
  'e9c00001-0000-4000-8000-000000000002', 'e9c00002-0000-4000-8000-000000000003',
  'e9c00004-0000-4000-8000-000000000003', 'ambulatory', 'in_progress', clock_timestamp());
select pg_temp.prescribe('e9c00007-0000-4000-8000-0000000000a2', 'e9c00006-0000-4000-8000-000000000004',
  'e9c00005-0000-4000-8000-000000000001', 'e9c00001-0000-4000-8000-000000000002', 'e9c00002-0000-4000-8000-000000000003',
  'e9c00004-0000-4000-8000-000000000003', 'http://www.whocc.no/atc', 'J01CA04', 'Amoxicillin 500 mg capsule', 1.5,
  'capsule', 'oral', 'Every 8 hours', 'Take after food for 7 days', date '2026-11-01', date '2026-11-08', 'active');
reset role;
-- RA's created_at, as the owner (replica: no version trigger), with
-- microseconds a millisecond cut and a rounding tell apart.
set local session_replication_role = replica;
update ehr.prescriptions set created_at = '2026-10-30 09:15:42.123987+00'
 where id = 'e9c00007-0000-4000-8000-0000000000a1';
set local session_replication_role = origin;
do $$
begin
  if (select string_agg(format('%s/%s/%s', right(id::text, 2), status, row_version), ' ' order by id)
        from ehr.prescriptions where id::text like 'e9c00007-%')
     <> 'a1/active/1 a2/active/1 b1/active/1 c1/active/1 c2/active/1 d1/active/2 e1/active/1 f1/draft/1 f2/on_hold/2 '
        || 'f3/completed/2 f4/cancelled/2 f5/entered_in_error/2' then
    raise exception 'source check fixtures are not as described';
  end if;
end $$;

-- The EHR API's hand-off (prescriptions.service.ts acceptForPharmacy) as
-- pharmacy-api receives it, for prescription id: the row as node-postgres
-- reads it, then JSON. Texts as stored; dose as a JSON number (Number of the
-- numeric's text); a date as the ISO string of the JavaScript Date
-- node-postgres makes of it (local midnight; the API runs in UTC); created_at
-- through Date.toISOString() (milliseconds); absent optional fields left out
-- (pharmacy-api then inserts null).
create function pg_temp.handoff(prescription uuid) returns jsonb language sql as $f$
  select jsonb_strip_nulls(jsonb_build_object(
    'patientId', p.patient_id, 'orderingFacilityId', p.facility_id, 'sourceEhrPrescriptionId', p.id,
    'sourceEhrPrescriptionVersion', p.row_version, 'sourceEncounterId', p.encounter_id, 'sourceStatus', p.status,
    'medicationCodeSystem', p.medication_code_system, 'medicationCode', p.medication_code,
    'medicationDisplay', p.medication_display, 'doseQuantity', p.dose_quantity::text::float8,
    'doseUnit', p.dose_unit, 'routeCode', p.route_code, 'frequency', p.frequency, 'instructions', p.instructions,
    'startsOn', to_char(p.starts_on, 'YYYY-MM-DD') || 'T00:00:00.000Z',
    'endsOn', to_char(p.ends_on, 'YYYY-MM-DD') || 'T00:00:00.000Z',
    'prescribedBy', p.created_by,
    'prescribedAt', to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
  from ehr.prescriptions p where p.id = prescription;
$f$;
-- pharmacy-api's INSERT (PharmacyService.acceptPrescription), its values as
-- it binds them: the DTO's fields (null when absent), 'active' literally, the
-- facility, account and membership from the session (for accepter n), and
-- doseQuantity as node-postgres sends a number (String(n)).
create function pg_temp.accept_sql(body jsonb, accepter integer default 2, site integer default 1)
returns text language sql as $f$
  select format($i$insert into pharmacy.work_items (
        id,patient_id,facility_id,ordering_facility_id,source_ehr_prescription_id,
        source_ehr_prescription_version,source_encounter_id,source_status,medication_code_system,
        medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
        starts_on,ends_on,prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,
        acceptance_reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,%L,%L,%L,%L,%L,'active',%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)
      returning *$i$, gen_random_uuid(), body->>'patientId', 'e9c00001-0000-4000-8000-00000000000' || site,
    body->>'orderingFacilityId', body->>'sourceEhrPrescriptionId', body->>'sourceEhrPrescriptionVersion',
    body->>'sourceEncounterId', body->>'medicationCodeSystem', body->>'medicationCode', body->>'medicationDisplay',
    body->>'doseQuantity', body->>'doseUnit', body->>'routeCode', body->>'frequency', body->>'instructions',
    body->>'startsOn', body->>'endsOn', body->>'prescribedBy', body->>'prescribedAt',
    'e9c00002-0000-4000-8000-00000000000' || accepter, 'e9c00004-0000-4000-8000-00000000000' || accepter,
    'Accepted for dispensing', 'pharmacy-source-' || replace(gen_random_uuid()::text, '-', ''), repeat('e', 64),
    current_setting('app.correlation_id'))
$f$;
-- A statement's outcome ('ok', or 'SQLSTATE message'), always undone.
create function pg_temp.try(statement text) returns text language plpgsql as $f$
declare outcome text;
begin
  begin
    execute statement;
    outcome := 'ok';
    raise exception using errcode = 'P0001', message = 'source-check-suite: undo';
  exception when others then
    if sqlerrm <> 'source-check-suite: undo' then outcome := sqlstate || ' ' || sqlerrm; end if;
  end;
  return outcome;
end $f$;
create temporary table source_cases (
  seq serial primary key, name text not null unique, expected text not null, actual text not null
) on commit drop;
grant select, insert on source_cases to public;
grant usage on sequence source_cases_seq_seq to public;
create function pg_temp.accept_case(case_name text, expected text, body jsonb, accepter integer default 2,
  site integer default 1) returns void language sql as $f$
  insert into source_cases (name, expected, actual)
  values (case_name, expected, pg_temp.try(pg_temp.accept_sql(body, accepter, site)));
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_pharmacy_api_runtime, hid_ehr_api_runtime', proc.signature);
  end loop;
end $$;
-- The hand-off bodies, kept as they are now (before any probe).
create temporary table bodies (name text primary key, body jsonb not null) on commit drop;
insert into bodies select right(id::text, 2), pg_temp.handoff(id) from ehr.prescriptions where id::text like 'e9c00007-%';
grant select on bodies to public;
create function pg_temp.body(name text) returns jsonb language sql stable as $f$
  select body from bodies where bodies.name = $1
$f$;
grant execute on function pg_temp.body(text) to hid_pharmacy_api_runtime;
do $$
begin
  if pg_temp.body('a1')->>'prescribedAt' <> '2026-10-30T09:15:42.123Z'
     or pg_temp.body('a1')->>'doseQuantity' <> '1.5' or pg_temp.body('d1')->>'doseQuantity' <> '500'
     or pg_temp.body('a1')->>'startsOn' <> '2026-11-01T00:00:00.000Z' or pg_temp.body('b1') ? 'medicationCode'
     or pg_temp.body('b1') ? 'doseQuantity' or pg_temp.body('b1') ? 'startsOn' then
    raise exception 'the hand-off bodies are not as the EHR API sends them: %', pg_temp.body('a1');
  end if;
end $$;

-- 2.-5. The acceptances, as pharmacist A at C1 through pharmacy-api's runtime.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
-- 2. Legitimate.
select pg_temp.accept_case('RA as the EHR API hands it off', 'ok', pg_temp.body('a1'));
select pg_temp.accept_case('RB, no optional field', 'ok', pg_temp.body('b1'));
select pg_temp.accept_case('RV at version 2', 'ok', pg_temp.body('d1'));
select pg_temp.accept_case('RW as pharmacy-api trims it', 'ok', pg_temp.body('c1') || jsonb_build_object(
  'medicationCodeSystem', 'urn:hid:medication', 'medicationCode', 'ibuprofen-400', 'medicationDisplay', 'Ibuprofen 400 mg',
  'doseUnit', 'tablet', 'routeCode', 'oral', 'frequency', 'Twice daily', 'instructions', 'With food'));
select pg_temp.accept_case('RW as stored', 'ok', pg_temp.body('c1'));
select pg_temp.accept_case('RW2 as pharmacy-api trims it', 'ok',
  pg_temp.body('c2') || '{"instructions": "Before breakfast"}');
select pg_temp.accept_case('RA with created_at itself', 'ok',
  pg_temp.body('a1') || '{"prescribedAt": "2026-10-30 09:15:42.123987+00"}');
select pg_temp.accept_case('RA with the dose as numeric text', 'ok', pg_temp.body('a1') || '{"doseQuantity": "1.5000"}');
select pg_temp.accept_case('RA with dates as plain dates', 'ok',
  pg_temp.body('a1') || '{"startsOn": "2026-11-01", "endsOn": "2026-11-08"}');
select pg_temp.accept_case('RP2 for P2', 'ok', pg_temp.body('e1'));

-- 3. Refused. Missing, inactive, another version.
select pg_temp.accept_case('a prescription that does not exist', '23514 PRESCRIPTION_SOURCE_NOT_FOUND',
  pg_temp.body('a1') || jsonb_build_object('sourceEhrPrescriptionId', 'e9c00007-0000-4000-8000-0000000000ff'));
select pg_temp.accept_case('a draft', '23514 PRESCRIPTION_SOURCE_NOT_ACTIVE', pg_temp.body('f1'));
select pg_temp.accept_case('on hold', '23514 PRESCRIPTION_SOURCE_NOT_ACTIVE', pg_temp.body('f2'));
select pg_temp.accept_case('completed', '23514 PRESCRIPTION_SOURCE_NOT_ACTIVE', pg_temp.body('f3'));
select pg_temp.accept_case('cancelled', '23514 PRESCRIPTION_SOURCE_NOT_ACTIVE', pg_temp.body('f4'));
select pg_temp.accept_case('entered in error', '23514 PRESCRIPTION_SOURCE_NOT_ACTIVE', pg_temp.body('f5'));
select pg_temp.accept_case('cancelled, named at its active version 1', '23514 PRESCRIPTION_SOURCE_NOT_ACTIVE',
  pg_temp.body('f4') || '{"sourceEhrPrescriptionVersion": 1, "sourceStatus": "active"}');
select pg_temp.accept_case('cancelled, with another medicine too', '23514 PRESCRIPTION_SOURCE_NOT_ACTIVE',
  pg_temp.body('f4') || '{"medicationDisplay": "Something else"}');
select pg_temp.accept_case('RV at its old version 1', '23514 PRESCRIPTION_SOURCE_VERSION_MISMATCH',
  pg_temp.body('d1') || '{"sourceEhrPrescriptionVersion": 1, "instructions": "With meals"}');
select pg_temp.accept_case('RV at version 3', '23514 PRESCRIPTION_SOURCE_VERSION_MISMATCH',
  pg_temp.body('d1') || '{"sourceEhrPrescriptionVersion": 3}');
select pg_temp.accept_case('RA at version 2', '23514 PRESCRIPTION_SOURCE_VERSION_MISMATCH',
  pg_temp.body('a1') || '{"sourceEhrPrescriptionVersion": 2}');
select pg_temp.accept_case('RV at version 1, with another medicine too', '23514 PRESCRIPTION_SOURCE_VERSION_MISMATCH',
  pg_temp.body('d1') || '{"sourceEhrPrescriptionVersion": 1, "medicationDisplay": "Something else"}');
-- Each field in turn (RA, then RB for a value where it has none).
insert into source_cases (name, expected, actual)
select 'RA with ' || changed.what, '23514 PRESCRIPTION_SOURCE_MISMATCH',
       pg_temp.try(pg_temp.accept_sql(case when changed.dropped is not null
         then pg_temp.body('a1') - changed.dropped else pg_temp.body('a1') || changed.patch end))
  from (values
    ('another patient (P2)', '{"patientId": "e9c00005-0000-4000-8000-000000000002"}'::jsonb, null::text[]),
    ('another encounter of P1', '{"sourceEncounterId": "e9c00006-0000-4000-8000-000000000002"}', null),
    ('another code system', '{"medicationCodeSystem": "http://snomed.info/sct"}', null),
    ('another code', '{"medicationCode": "J01CA01"}', null),
    ('no code system and code', null, array['medicationCodeSystem', 'medicationCode']),
    ('another medicine name', '{"medicationDisplay": "Amoxicillin 250 mg capsule"}', null),
    ('the name in other case', '{"medicationDisplay": "amoxicillin 500 mg capsule"}', null),
    ('a space inside the name', '{"medicationDisplay": "Amoxicillin  500 mg capsule"}', null),
    ('another dose', '{"doseQuantity": 1.4}', null),
    ('no dose', null, array['doseQuantity', 'doseUnit']),
    ('another dose unit', '{"doseUnit": "tablet"}', null),
    ('another route', '{"routeCode": "iv"}', null),
    ('no route', null, array['routeCode']),
    ('another frequency', '{"frequency": "Every 12 hours"}', null),
    ('other instructions', '{"instructions": "Take after food for 5 days"}', null),
    ('instructions with a full stop', '{"instructions": "Take after food for 7 days."}', null),
    ('another start date', '{"startsOn": "2026-11-02T00:00:00.000Z"}', null),
    ('the start date of a +01:00 clock', '{"startsOn": "2026-10-31T23:00:00.000Z"}', null),
    ('no start date', null, array['startsOn']),
    ('another end date', '{"endsOn": "2026-11-09T00:00:00.000Z"}', null),
    ('no end date', null, array['endsOn']),
    ('another prescriber (A)', '{"prescribedBy": "e9c00002-0000-4000-8000-000000000002"}', null),
    ('prescribed_at rounded up', '{"prescribedAt": "2026-10-30T09:15:42.124Z"}', null),
    ('prescribed_at a millisecond early', '{"prescribedAt": "2026-10-30T09:15:42.122Z"}', null),
    ('prescribed_at a second late', '{"prescribedAt": "2026-10-30T09:15:43.123Z"}', null),
    ('prescribed_at at another offset', '{"prescribedAt": "2026-10-30T09:15:42.123+01:00"}', null)
  ) changed(what, patch, dropped)
 order by changed.what;
insert into source_cases (name, expected, actual)
select 'RB with ' || changed.what, '23514 PRESCRIPTION_SOURCE_MISMATCH',
       pg_temp.try(pg_temp.accept_sql(pg_temp.body('b1') || changed.patch))
  from (values
    ('a code system and code', '{"medicationCodeSystem": "http://www.whocc.no/atc", "medicationCode": "N02BE01"}'::jsonb),
    ('a dose', '{"doseQuantity": 1, "doseUnit": "tablet"}'),
    ('a route', '{"routeCode": "oral"}'),
    ('a start date', '{"startsOn": "2026-11-01T00:00:00.000Z"}'),
    ('an end date', '{"endsOn": "2026-11-08T00:00:00.000Z"}')
  ) changed(what, patch)
 order by changed.what;
select pg_temp.accept_case('RW with the inner text changed', '23514 PRESCRIPTION_SOURCE_MISMATCH',
  pg_temp.body('c1') || '{"medicationDisplay": "Ibuprofen 200 mg"}');
select pg_temp.accept_case('RW with a space the trim keeps (U+180E)', '23514 PRESCRIPTION_SOURCE_MISMATCH',
  pg_temp.body('c1') || jsonb_build_object('frequency', chr(6158) || 'Twice daily'));
select pg_temp.accept_case('RP2 named for P1', '23514 PRESCRIPTION_SOURCE_MISMATCH',
  pg_temp.body('e1') || jsonb_build_object('patientId', 'e9c00005-0000-4000-8000-000000000001',
    'sourceEncounterId', 'e9c00006-0000-4000-8000-000000000001'));
select pg_temp.accept_case('C2''s prescription accepted at C1',
  case when current_setting('source_check.owner_bypasses')::boolean then '23514 PRESCRIPTION_SOURCE_MISMATCH'
       else '23514 PRESCRIPTION_SOURCE_NOT_FOUND' end,
  pg_temp.body('a2') || '{"orderingFacilityId": "e9c00001-0000-4000-8000-000000000001"}');
select pg_temp.accept_case('RA with C2 as the ordering facility', '23514 PRESCRIPTION_SOURCE_MISMATCH',
  pg_temp.body('a1') || '{"orderingFacilityId": "e9c00001-0000-4000-8000-000000000002"}');
select pg_temp.accept_case('RA with C2 as the work item''s facility', '23514 PRESCRIPTION_SOURCE_MISMATCH',
  pg_temp.body('a1'), 2, 2);
-- After the source checks, 0077's: another accepter than the session's, a
-- source_status other than active (pharmacy-api always writes 'active').
select pg_temp.accept_case('RA accepted in D''s name by A''s session',
  '23514 Pharmacy acceptance patient, facility, prescription status, or actor context is invalid',
  pg_temp.body('a1'), 1);
insert into source_cases (name, expected, actual)
values ('RA with source_status draft',
  '23514 Pharmacy acceptance patient, facility, prescription status, or actor context is invalid',
  pg_temp.try(replace(pg_temp.accept_sql(pg_temp.body('a1')), $r$,'active',$r$, $r$,'draft',$r$)));
-- A session at C2 for C1's prescription: under an owner that bypasses
-- row-level security the source matches and 0077's facility check refuses;
-- under production's owner the prescription is not found.
select pg_temp.as_member(2, 2);
select pg_temp.accept_case('RA from a session at C2',
  case when current_setting('source_check.owner_bypasses')::boolean
       then '23514 Pharmacy acceptance patient, facility, prescription status, or actor context is invalid'
       else '23514 PRESCRIPTION_SOURCE_NOT_FOUND' end, pg_temp.body('a1'));
select pg_temp.as_member(2, 1);

-- 4. The order-route branch never reads the prescription: RA's exact values
-- with a route that does not exist answer the route branch's refusal.
insert into source_cases (name, expected, actual)
values ('RA on a route that does not exist',
  '23514 Pharmacy work item does not match its accepted order route and actor context',
  pg_temp.try(replace(replace(pg_temp.accept_sql(pg_temp.body('a1')
      || '{"orderingFacilityId": "e9c00001-0000-4000-8000-000000000002"}'),
    'request_sha256,correlation_id', 'request_sha256,correlation_id,order_route_id'),
    E')\n      returning *', ',' || quote_literal('e9c00008-0000-4000-8000-000000000001') || E')\n      returning *')));
reset role;

-- 6. The lock: an accepted (and kept) work item holds RB FOR SHARE to commit
-- (RB, which nothing in this transaction has changed, so its xmax shows only
-- row locks); the same transaction's EHR update still runs (a transaction
-- never waits for its own lock). The proof script checks with two sessions
-- that another session's update waits and another FOR SHARE does not.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2, 1);
do $$
begin
  execute pg_temp.accept_sql(pg_temp.body('b1'));
end $$;
reset role;
do $$
declare
  locker xid := (select xmax from ehr.prescriptions where id = 'e9c00007-0000-4000-8000-0000000000b1');
  mine xid := pg_current_xact_id()::xid;
  held boolean := locker::text = mine::text;
begin
  -- The row lock is this transaction's, lock only (RB is unchanged): its
  -- xmax is this transaction, or a multixact with this transaction's share
  -- lock among its members (the probes' undone locks may join it).
  if not held then
    begin
      held := exists (select 1 from pg_get_multixact_members(locker) member
                       where member.xid::text = mine::text and member.mode = 'sh');
    exception when others then held := false;
    end;
  end if;
  if not held or (select row_version from ehr.prescriptions where id = 'e9c00007-0000-4000-8000-0000000000b1') <> 1 then
    raise exception 'the acceptance does not hold its prescription FOR SHARE';
  end if;
end $$;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1, 1);
select pg_temp.change('e9c00007-0000-4000-8000-0000000000b1', 'completed', null, null, null, 1, 'Dispensed and completed');
reset role;
do $$
begin
  if (select count(*) from pharmacy.work_items where source_ehr_prescription_id = 'e9c00007-0000-4000-8000-0000000000b1') <> 1
     or (select status from ehr.prescriptions where id = 'e9c00007-0000-4000-8000-0000000000b1') <> 'completed' then
    raise exception 'the kept acceptance or the EHR''s later change is missing';
  end if;
end $$;

-- 5. The sealed demo tenant (0098): installed as the owner, its shares moved
-- an hour back (this transaction's timestamp precedes the install); the demo
-- doctor writes Patient One's prescription at Demo Hospital and accepts it
-- there through pharmacy-api's runtime.
do $$
begin
  if to_regprocedure('identity.sealed_demo_install()') is null then
    raise exception 'the sealed demo tenant (0098) is missing';
  end if;
  perform identity.sealed_demo_install();
  update identity.consent_grants set starts_at = starts_at - interval '1 hour'
   where correlation_id = '0098-sealed-demo-install';
end $$;
-- The staff login active, as after the owner's recovery (0098's suite, 6a;
-- set here directly, as replica).
set local session_replication_role = replica;
update auth.accounts set status = 'active' where id = '98d00003-0000-4000-8000-000000000001';
set local session_replication_role = origin;
create function pg_temp.as_demo_doctor() returns void language sql as $f$
  select set_config('app.actor_subject', 'sealed-demo:98d00003-0000-4000-8000-000000000001', true),
         set_config('app.facility_id', '98d00002-0000-4000-8000-000000000001', true),
         set_config('app.correlation_id', 'pharmacy-source-demo-' || substr(md5(random()::text), 1, 12), true),
         set_config('app.membership_id', '98d00005-0000-4000-8000-000000000001', true),
         set_config('app.purpose_of_use', 'direct-care', true);
$f$;
grant execute on function pg_temp.as_demo_doctor() to hid_pharmacy_api_runtime, hid_ehr_api_runtime;
set local role hid_ehr_api_runtime;
select pg_temp.as_demo_doctor();
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e9c00006-0000-4000-8000-000000000009', '98d00009-0000-4000-8000-000000000001',
  '98d00002-0000-4000-8000-000000000001', '98d00003-0000-4000-8000-000000000001',
  '98d00005-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp());
select pg_temp.prescribe('e9c00007-0000-4000-8000-000000000099', 'e9c00006-0000-4000-8000-000000000009',
  '98d00009-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001', '98d00003-0000-4000-8000-000000000001',
  '98d00005-0000-4000-8000-000000000001', null, null, 'Demo amoxicillin 500 mg', 1, 'capsule', 'oral',
  'Every 8 hours', 'Demo instructions', current_date, null, 'active');
reset role;
insert into bodies values ('99', pg_temp.handoff('e9c00007-0000-4000-8000-000000000099'));
create function pg_temp.demo_accept_sql(body jsonb) returns text language sql as $f$
  select replace(replace(replace(pg_temp.accept_sql(body), 'e9c00001-0000-4000-8000-000000000001',
    '98d00002-0000-4000-8000-000000000001'), 'e9c00002-0000-4000-8000-000000000002', '98d00003-0000-4000-8000-000000000001'),
    'e9c00004-0000-4000-8000-000000000002', '98d00005-0000-4000-8000-000000000001')
$f$;
grant execute on function pg_temp.demo_accept_sql(jsonb) to hid_pharmacy_api_runtime;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_demo_doctor();
insert into source_cases (name, expected, actual) values
  ('demo: Patient One''s prescription at Demo Hospital', 'ok', pg_temp.try(pg_temp.demo_accept_sql(pg_temp.body('99')))),
  ('demo: the same, another dose', '23514 PRESCRIPTION_SOURCE_MISMATCH',
   pg_temp.try(pg_temp.demo_accept_sql(pg_temp.body('99') || '{"doseQuantity": 2}'))),
  ('demo: a real clinic''s prescription named at Demo Hospital',
   case when current_setting('source_check.owner_bypasses')::boolean then '23514 PRESCRIPTION_SOURCE_MISMATCH'
        else '23514 PRESCRIPTION_SOURCE_NOT_FOUND' end,
   pg_temp.try(pg_temp.demo_accept_sql(pg_temp.body('e1') || '{"orderingFacilityId": "98d00002-0000-4000-8000-000000000001"}')));
select pg_temp.as_member(2, 1);
select pg_temp.accept_case('demo: Demo Hospital''s prescription named at a real clinic',
  case when current_setting('source_check.owner_bypasses')::boolean then '23514 PRESCRIPTION_SOURCE_MISMATCH'
       else '23514 PRESCRIPTION_SOURCE_NOT_FOUND' end,
  pg_temp.body('99') || '{"orderingFacilityId": "e9c00001-0000-4000-8000-000000000001"}');
reset role;

-- Every case ran and answered as expected.
do $$
declare mismatches text;
begin
  if (select count(*) from source_cases) <> 67 then
    raise exception 'the source check suite ran % cases, not 67', (select count(*) from source_cases);
  end if;
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq) into mismatches
    from source_cases where actual is distinct from expected;
  if mismatches is not null then
    raise exception E'Pharmacy prescription source check (owner bypasses row-level security: %):\n%',
      current_setting('source_check.owner_bypasses'), mismatches;
  end if;
  raise notice 'Pharmacy prescription source suite: % cases passed (owner bypasses row-level security: %)',
    (select count(*) from source_cases), current_setting('source_check.owner_bypasses');
end $$;

rollback;
