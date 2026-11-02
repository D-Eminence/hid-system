-- 0102 Sealed demo story (owner request of 2026-11-02 in chat: "i need the
-- access pin and emergency to work in demo account now and fill both patient
-- and ehr with the informaton you filled in the demo video"; the declaration
-- signed separately): the sealed demo tenant of 0098 filled with the demo
-- video's made-up story, so the patient portal and the EHR, Laboratory,
-- Pharmacy and Outreach sites show it, and the access PIN works for the two
-- demo patient logins. Nothing here is a real person, and nothing is sent.
--
-- Decisions:
-- D1 This file always installs three functions, owned by the applier and
--    granted to no role: identity.demo_story_install(pin_hash) (the
--    seed), identity.demo_story_context (the request context a service
--    sets) and identity.demo_story_lab_result (the Lab's steps for one
--    work item). It seeds only on Amazon RDS (where the role rds_superuser
--    exists), as 0098 D3: CI, acceptance, the staging upgrade rehearsal and
--    throwaway clusters get the functions only, and the suite
--    sealed-demo-story calls the seed itself with a hash of its own. No
--    table, column, trigger, policy or existing function changes.
-- D2 Names, as in the video: Patient One becomes Adaeze Okafor (female, born
--    1991-03-04, Lagos, Nigeria) and Patient Two Chinedu Okafor (male, her
--    brother, 0098's date of birth 1990-07-02, Lagos, Nigeria). Patients
--    Three to Ten take the video's other names by sex and age: Abubakar
--    Bello (M 1950), Halima Yusuf (F 1962), Emeka Nwosu (M 1971), Ngozi Eze
--    (F 1978), Musa Ibrahim (M 1999), Funke Adebayo (F 2004), and two
--    made-up names, Ifeanyi Okeke (M 2012) and Zainab Lawal (F 2020). The
--    patient logins' display names follow; the staff login's display name and
--    its staff record's name, plain display fields, become Dr Tunde Bello.
--    Health IDs, sex and the other dates of birth are unchanged. A name is
--    changed only from 0098's own value, so a later change is kept.
-- D3 Every row read or written belongs to the sealed demo tenant: the four
--    demo facilities, the staff login and its four memberships, the two
--    patient logins and the ten patients, each a member in
--    identity.sealed_demo_members with 0098's values; else 55000
--    SEALED_DEMO_STORY_NOT_DEMO and nothing is written.
-- D4 The profile as the patient portal's completion card counts it
--    (apps/patient-web profileCompletion.ts, twelve items): what SQL can
--    honestly hold is filled, for each patient only where the patient has not
--    saved their own: the hospital they use and their HMO (Sample Teaching
--    Hospital, Sample HMO, the video's values); the health information
--    (Adaeze: O+, AA, "Penicillin — rash", "Ferrous sulphate 200 mg tablets,
--    one a day", "Iron deficiency anaemia"; Chinedu: A+, AS); state and
--    country. Their email is already verified (0098). Not seeded, because
--    the database cannot hold them truthfully: the photo (Identity encrypts it
--    with its own key), an emergency contact (ciphertext and HMAC made with
--    Identity's keys, and confirmed by a code), a phone (0098 G5 refuses any
--    phone for a demo patient, so no SMS can ever be due) and a verified NIN
--    (a QoreID check, which 0098 G6 refuses for demo accounts). So Adaeze's
--    card reads 8 of 12 (67%) after this file and 10 of 12 (83%) once the
--    owner adds the photo and the emergency contact in the app; 100% would
--    need a reviewed change to the seal. The health information records the
--    patient's own account as updated_by_account_id, as the only writer of
--    that table does; the audit row says the migration wrote it.
-- D5 The access PIN: Patient One and Patient Two get the row
--    identity.set_my_patient_access_pin writes (same table and columns,
--    status active, hash_algorithm bcrypt, source_system hid-sealed-demo as
--    every 0098 row), holding the bcrypt hash given (cost 12, $2a$, made with
--    pgcrypto; any other shape 22023 SEALED_DEMO_STORY_PIN_HASH_INVALID), and
--    only where the patient has no PIN row: a PIN the patient set or turned
--    off is kept. No grant is revoked and no patient audit row is written.
--    The PIN itself is in no file; the owner holds it.
-- D6 Adaeze's visit six weeks before the apply (the video's "visit before"),
--    written as the demo login's doctor membership at Demo Hospital through
--    the 0098 shares: completed, 40 minutes; vitals (168 cm, 70.1 kg, 36.8
--    °C, pulse 88, breathing 16, BP 112/70, oxygen 99%); a signed
--    consultation note and a signed patient summary (the summary names her
--    emergency contact without a phone number); diagnoses Z88.0 "Allergy to
--    penicillin (rash)" and D50.9 "Iron deficiency anaemia", both active and
--    confirmed; ferrous sulphate 200 mg, one a day for 3 months.
-- D7 Adaeze today, from 150 minutes before the apply, still in progress:
--    "Fever, headache and body aches for 3 days"; triage vitals (BP 128/82,
--    pulse 78, 37.9 °C, oxygen 98%, 72.4 kg, 168 cm); the consultation note
--    "Fever for 3 days", signed ("Consultation complete"); diagnosis B54
--    "Malaria (uncomplicated)", active, confirmed; prescriptions
--    artemether-lumefantrine 80/480 mg (1 tablet twice daily for 3 days,
--    with food) and paracetamol 500 mg (2 tablets three times daily for 3
--    days); lab requests "Malaria rapid test" and "Full blood count"
--    (routine, blood, "Fever for 3 days."). The video's third prescription
--    (hydrocortisone cream) belongs to its scanned clinic note, which needs a
--    stored document, so it is left out.
-- D8 Chinedu today, from 40 minutes before the apply: checked in and
--    waiting ("Fever and headache since yesterday"), triage vitals, a malaria
--    rapid test and paracetamol ordered (these are made up for this file;
--    the video does not show him).
-- D9 The orders go through the live commands, so the derived rows (routes,
--    route events, work items, the notices in the patient's inbox) are the
--    ones a tester's order makes: ehr.send_order_route from Demo Hospital,
--    lab.accept_order_route at Demo Laboratory and
--    pharmacy.accept_order_route at Demo Pharmacy by the same login with the
--    patient's Health ID, as a tester does. Then the Lab's own steps
--    (accession, sample collected and received, test run, result entered)
--    and the Pharmacy's dispensing are written as lab-api and pharmacy-api
--    write them, with their event rows; the services' own outbox rows (which
--    would tell the patient by email or push) and application audit rows are
--    not written. Adaeze's malaria test reads "Positive (P. falciparum)"
--    (normal "Negative", abnormal) and her blood count "Hb 12.8 g/dL, WBC 7.2
--    ×10^9/L, platelets 210 ×10^9/L" (normal); 6 tablets of
--    artemether-lumefantrine and 18 of paracetamol are dispensed (the video's
--    reason), which completes those two routes. Chinedu's test waits at Demo
--    Laboratory for his sample and his paracetamol at Demo Pharmacy. The
--    order commands stamp their own clock, so orders, results and
--    dispensings are dated at the apply.
-- D10 The two results are entered and not checked or released:
--    lab.validate_result_governance requires the check by a second person,
--    and the demo has one staff login. So in the demo a result can never be
--    released (testers meet the same rule); a second demo lab login is an
--    owner decision.
-- D11 Demo Outreach: the video's campaigns, "Ajegunle health week"
--    (registration and vitals, active, started 3 days before) and "Makoko
--    school screening" (vitals, planned, 10 days after), and four field
--    registrations (Kemi Balogun 34 F, Ibrahim Musa 61 M, Chiamaka Obi 8 F,
--    Segun Adewale 45, sex unknown), each awaiting identity resolution, with
--    no phone number. The registrations are not linked to the campaign: the
--    campaign check (outreach.validate_registration_campaign_write, 0045)
--    reads the member row FOR SHARE, which forced row-level security refuses
--    to an applier without BYPASSRLS (outreach.campaign_members has no UPDATE
--    policy). The same check runs as that owner for outreach-api, so a live
--    registration into a campaign may meet the same refusal; reported, not
--    changed here.
-- D12 Nothing is sent. The order commands put "sent" and "accepted" notices
--    in Adaeze's and Chinedu's inboxes; they are marked read in the same
--    transaction, so no phone or computer notification is ever due for them
--    (identity.claim_web_push_deliveries reads unread items only). No
--    identity outbox row, no notification delivery, no email or SMS. The
--    accept commands queue LabWorkItemCreated and PharmacyWorkItemCreated
--    integration events, as for every order; no notification workflow
--    listens to them.
-- D13 The audit tells the truth: one row of the migration's own for every
--    row written or changed (actor system, provenance migration, source
--    system hid-sealed-demo, correlation id 0102-sealed-demo-story; ids only,
--    the PIN's with its cost and never the hash) and one for the story
--    (identity.sealed-demo.seed-story, counts only). No audit row names a
--    patient or a clinician as its actor. The order commands add their own
--    system rows (received, accepted, dispensing returned), as for every
--    order. The EHR's version history (ehr.record_versions) and the order
--    and Lab event rows name the demo login, because the charts are written
--    as its doctor, laboratory and pharmacist memberships, which is what the
--    screens show.
-- D14 Once: the PINs, profile rows and names are written only where absent
--    or still 0098's; the charts, orders and Outreach rows only when no story
--    audit row exists. A second call changes nothing and answers zero counts.
--    It refuses (55000, nothing written) while the three demo logins are not
--    all active (SEALED_DEMO_STORY_LOGINS_NOT_READY: the owner sets their
--    passwords with Forgot password first), while cross-facility orders are
--    switched off (SEALED_DEMO_STORY_ORDERS_OFF), or when a 0098 share no
--    longer lets the demo doctor write for Adaeze and Chinedu at Demo
--    Hospital (SEALED_DEMO_STORY_SHARE_MISSING: the patient revoked it).
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0101 applied and every object relied on
--    exists (else "0102: 0001-0101 must be applied first"); no function of
--    this file exists (else "0102: already applied"); the 35 bodies the seed
--    calls or fires are byte for byte the ones 0001-0101 gave them (md5 of
--    pg_proc.prosrc); the two profile tables' owner policies name the
--    applier, and the applier may create in schema identity (else 42501).
-- 1. The three functions; 2. no grant (revoked from PUBLIC, here and in
--    runtime-grants.sql); 3. post-checks (owner, SECURITY DEFINER for the
--    seed only, search_path, ACL); 4. comments; 5. the seed on Amazon RDS
--    only, with the owner's PIN hash.
--
-- Locks: none up front. On production the seed takes ROW EXCLUSIVE on the
-- tables it writes and row locks on the rows it changes (ten patients, three
-- accounts, one staff record), for the length of the release transaction.
--
-- Old services on this schema: unchanged; nothing new is called by a service.
-- Applied migrations 0001-0101 are immutable. No down migration: the seeded
-- rows are ordinary demo rows that testers keep working on; the off switch of
-- 0098 still applies.
--
-- Before signing, the owner runs this read-only query on production; it must
-- answer rds 1, active_logins 3, orders_on true, hospital_shares 2, pins 0
-- (a PIN a patient set is kept, so the owner's would not apply), story 0:
--   select (select count(*) from pg_roles where rolname = 'rds_superuser') as rds,
--          (select count(*) from auth.accounts where id in ('98d00003-0000-4000-8000-000000000001',
--             '98d00008-0000-4000-8000-000000000001', '98d00008-0000-4000-8000-000000000002')
--             and status = 'active') as active_logins,
--          (select enabled from platform.control_settings
--            where control_key = 'cross_facility_orders_enabled') as orders_on,
--          (select count(*) from identity.consent_grants where correlation_id = '0098-sealed-demo-install'
--             and membership_id = '98d00005-0000-4000-8000-000000000001'
--             and status = 'active' and expires_at > now()) as hospital_shares,
--          (select count(*) from identity.patient_access_pins where patient_id in
--             ('98d00009-0000-4000-8000-000000000001', '98d00009-0000-4000-8000-000000000002')) as pins,
--          (select count(*) from audit.events where correlation_id = '0102-sealed-demo-story') as story;

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  -- a. Prerequisites (0001-0101).
  if to_regclass('identity.sealed_demo_members') is null
     or to_regprocedure('identity.sealed_demo_install()') is null
     or to_regprocedure('identity.sealed_demo_facility(uuid)') is null
     or to_regprocedure('identity.sealed_demo_patient(uuid)') is null
     or to_regclass('identity.patient_access_pins') is null
     or to_regclass('identity.patient_profile_details') is null
     or to_regclass('ehr.patient_reported_health_profiles') is null
     or to_regclass('ehr.encounters') is null or to_regclass('ehr.clinical_notes') is null
     or to_regclass('ehr.clinical_note_revisions') is null or to_regclass('ehr.vitals') is null
     or to_regclass('ehr.diagnoses') is null or to_regclass('ehr.prescriptions') is null
     or to_regclass('ehr.lab_requests') is null or to_regclass('ehr.order_routes') is null
     or to_regclass('ehr.record_versions') is null
     or to_regclass('lab.work_items') is null or to_regclass('lab.accessions') is null
     or to_regclass('lab.specimen_requirements') is null or to_regclass('lab.specimens') is null
     or to_regclass('lab.specimen_events') is null or to_regclass('lab.accession_events') is null
     or to_regclass('lab.specimen_command_idempotency') is null or to_regclass('lab.test_executions') is null
     or to_regclass('lab.execution_events') is null or to_regclass('lab.results') is null
     or to_regclass('lab.result_revisions') is null or to_regclass('lab.result_events') is null
     or to_regclass('pharmacy.work_items') is null or to_regclass('pharmacy.dispensings') is null
     or to_regclass('outreach.campaigns') is null or to_regclass('outreach.campaign_members') is null
     or to_regclass('outreach.campaign_events') is null or to_regclass('outreach.registration_cases') is null
     or to_regclass('outreach.registration_case_events') is null
     or to_regclass('notification.inbox_items') is null or to_regclass('audit.events') is null
     or to_regclass('platform.control_settings') is null then
    raise exception using errcode = '55000', message = '0102: 0001-0101 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regprocedure('identity.demo_story_install(text)') is not null
     or to_regprocedure('identity.demo_story_context(text,uuid,uuid,text)') is not null
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'identity' and proc.proname like 'demo\_story\_%') then
    raise exception using errcode = '55000', message = '0102: already applied';
  end if;
  -- c. The bodies the seed calls or fires, as 0001-0101 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('ehr.capture_record_version()', '70daa16f05bb3ec28f05292e6358a702'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('ehr.order_route_notify_patient(ehr.order_routes,text)', '31a11a44325846699036367b7e56b46e'),
      ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', '4202ba3bbf02abd7db34606d42adca9c'),
      ('ehr.sync_order_routes_on_order_change()', '8ce6b42450cc06fc02fec8d1cf63af41'),
      ('ehr.validate_append_only_clinical_actor()', '288e99e3a96ceeb16a8d66a882008b94'),
      ('identity.access_patient_with_pin(text,text,integer)', '830c1baa4bca3df57cc02b7b002a8831'),
      ('identity.activate_break_glass(text,text,integer)', '6b888391ef7f0e4f264918baf00a6fe7'),
      ('identity.consent_grants_sealed_demo()', '2b5da08703d2cd221c94559a45ce223b'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)',
       '8b12ce866ee75cce411a2721795ffb92'),
      ('identity.sealed_demo_install()', '8a5dfb0feee0b699b2d13faffbc4a178'),
      ('identity.set_my_patient_access_pin(text,uuid,text)', '78ef55c9025781647ef87e3d76a3e6c3'),
      ('lab.accept_order_route(uuid,bigint,text,text,text,character,text)', '316378c286534d6177d562f9edcb4aac'),
      ('lab.context_allows(uuid,uuid,text)', '57e689661a6227e34d3bde9562468951'),
      ('lab.validate_accession_child()', '0e4eae7f8ba065925b575508c67236a5'),
      ('lab.validate_accession_insert()', '5536297661ac4a1f824f06920976e81d'),
      ('lab.validate_execution_child()', '95ee62f2b858a5367718ae0aa15f4758'),
      ('lab.validate_execution_insert()', 'f68a6108ca36a6f6d7c4b0350bc7058e'),
      ('lab.validate_execution_transition()', 'e4ecb83536efe7ee623d56d6a6e91705'),
      ('lab.validate_result_governance()', '6bf52a22ce45e834d4f2a194a06babad'),
      ('lab.validate_result_insert()', '5af00417b4aee49705712921e01d0d4d'),
      ('lab.validate_result_revision()', '3548789c62364b9cecc3136e269222fd'),
      ('lab.validate_specimen_parent()', 'cda48bb84e642560ae2d10879f8fb674'),
      ('lab.validate_specimen_transition()', '04b8ddd460e833e1329bd6b777afda6b'),
      ('lab.validate_work_item()', 'efac15072e0a6e68dff199026ff6f73e'),
      ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', '0b5689f31a3ce00f9313fe1e55244fad'),
      ('outreach.validate_campaign_write()', '1ac1e424e645378ab6e88a45542fccf9'),
      ('outreach.validate_registration_campaign_write()', 'afabd66c378c6e076062f35e80de9cb2'),
      ('outreach.validate_registration_case_write()', 'a12d2b2573c5c7e52bcb5a8cdb1ec190'),
      ('pharmacy.accept_order_route(uuid,bigint,text,text,text,text,character,text)', '6a419490b35f8ddf72add8d464ebc3d8'),
      ('pharmacy.context_allows(uuid,uuid,text)', '958a6e5cd2a534d158c82fe399b8f381'),
      ('pharmacy.return_order_route_dispensing()', 'da0017a88bb938cd0fcbba50fdadaa11'),
      ('pharmacy.validate_dispensing()', '17f7e8897bd2ab240332e4d2c9f757b7'),
      ('pharmacy.validate_work_item()', 'e2411539ee8c95a02dad46c03e24db05'),
      ('platform.control_enabled(text)', 'ed17b9d8097417363c0a6343e52aa47f')) expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0102: 0001-0101 must be applied first',
      detail = 'Bodies that differ: ' || mismatch;
  end if;
  -- d. The applier: may create in schema identity, and is the role the two
  -- profile tables' owner policies name (0094), so the seed's writes to them
  -- pass row-level security, which both force.
  if not has_schema_privilege(current_user, 'identity', 'CREATE')
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid in ('identity.patient_profile_details'::regclass,
                                        'ehr.patient_reported_health_profiles'::regclass)
            and policy_row.polname in ('patient_profile_details_owner', 'patient_reported_health_profiles_owner')
            and pg_get_expr(policy_row.polqual, policy_row.polrelid) = format('(CURRENT_USER = %L::name)', current_user)
            and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid)
                = format('(CURRENT_USER = %L::name)', current_user)) <> 2 then
    raise exception using errcode = '42501',
      message = '0102: the applying role must create in schema identity and own the profile tables'' policies';
  end if;
end
$$;

-- 1. The functions.
-- The request context a service sets, for the rest of the transaction.
create function identity.demo_story_context(requested_subject text, requested_membership uuid,
  requested_facility uuid, requested_correlation text)
returns void
language sql volatile
set search_path = pg_catalog, pg_temp
as $$
  select set_config('app.actor_subject', coalesce(requested_subject, ''), true),
         set_config('app.membership_id', coalesce(requested_membership::text, ''), true),
         set_config('app.facility_id', coalesce(requested_facility::text, ''), true),
         set_config('app.correlation_id', requested_correlation, true),
         set_config('app.purpose_of_use', 'direct-care', true),
         set_config('app.patient_id', '', true),
         set_config('app.session_id', '', true),
         set_config('app.account_id', '', true),
         set_config('app.change_reason', '', true);
$$;

-- The Lab's own steps for one accepted work item, as lab-api writes them
-- (accession, specimen required, collected, received; execution started and
-- completed; a text result entered), each with its event row, in the
-- caller's laboratory context; no outbox row and no application audit row
-- (D9). Not checked or released: lab.validate_result_governance requires a
-- second scientist for the check, and the demo has one staff login (D10).
create function identity.demo_story_lab_result(requested_work_item uuid, requested_account uuid,
  requested_membership uuid, requested_correlation text, requested_method text, requested_collection_notes text,
  requested_value text, requested_range text, requested_flag text)
returns uuid
language plpgsql volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  item record;
  test_id uuid;
  accession_id uuid := gen_random_uuid();
  requirement_id uuid := gen_random_uuid();
  specimen_id uuid := gen_random_uuid();
  execution_id uuid := gen_random_uuid();
  result_id uuid;
  key_base text := 'sealed-demo-story-' || replace(requested_work_item::text, '-', '');
begin
  select work.id, work.patient_id, work.facility_id, work.priority into item
    from lab.work_items work where work.id = requested_work_item;
  select test.id into test_id from lab.work_item_requested_tests test
   where test.work_item_id = requested_work_item order by test.ordinal limit 1;
  insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
    idempotency_key, request_sha256, correlation_id)
  values (accession_id, item.id, item.patient_id, item.facility_id, item.priority, requested_account,
    requested_membership, key_base || '-accession', encode(sha256(convert_to(key_base || '-accession', 'UTF8')), 'hex'),
    requested_correlation);
  insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
  values (requirement_id, accession_id, item.patient_id, item.facility_id, 1, 'Blood');
  insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type)
  values (specimen_id, requirement_id, accession_id, item.patient_id, item.facility_id, 'Blood');
  insert into lab.specimen_events (specimen_id, accession_id, patient_id, facility_id, event_version, event_type,
    actor_id, actor_membership_id, reason, correlation_id)
  values (specimen_id, accession_id, item.patient_id, item.facility_id, 1, 'specimen_required', requested_account,
    requested_membership, 'Sample needed for the requested test', requested_correlation);
  insert into lab.accession_events (accession_id, work_item_id, patient_id, facility_id, event_version, event_type,
    actor_id, actor_membership_id, reason, correlation_id)
  values (accession_id, item.id, item.patient_id, item.facility_id, 1, 'accession_created', requested_account,
    requested_membership, 'Sample needed for the requested test', requested_correlation);
  update lab.specimens set status = 'collected', collected_at = clock_timestamp(), collected_by = requested_account,
         collected_by_membership_id = requested_membership, collection_notes = requested_collection_notes,
         row_version = row_version + 1
   where id = specimen_id;
  insert into lab.specimen_command_idempotency (facility_id, patient_id, actor_id, idempotency_key, operation,
    specimen_id, request_sha256, result_version)
  values (item.facility_id, item.patient_id, requested_account, key_base || '-collect', 'collect', specimen_id,
    encode(sha256(convert_to(key_base || '-collect', 'UTF8')), 'hex'), 2);
  insert into lab.specimen_events (specimen_id, accession_id, patient_id, facility_id, event_version, event_type,
    actor_id, actor_membership_id, reason, correlation_id)
  values (specimen_id, accession_id, item.patient_id, item.facility_id, 2, 'specimen_collected', requested_account,
    requested_membership, requested_collection_notes, requested_correlation);
  update lab.specimens set status = 'received', received_at = clock_timestamp(), received_by = requested_account,
         received_by_membership_id = requested_membership, row_version = row_version + 1
   where id = specimen_id;
  insert into lab.specimen_command_idempotency (facility_id, patient_id, actor_id, idempotency_key, operation,
    specimen_id, request_sha256, result_version)
  values (item.facility_id, item.patient_id, requested_account, key_base || '-receive', 'receive', specimen_id,
    encode(sha256(convert_to(key_base || '-receive', 'UTF8')), 'hex'), 3);
  insert into lab.specimen_events (specimen_id, accession_id, patient_id, facility_id, event_version, event_type,
    actor_id, actor_membership_id, reason, correlation_id)
  values (specimen_id, accession_id, item.patient_id, item.facility_id, 3, 'specimen_received', requested_account,
    requested_membership, 'Specimen received', requested_correlation);
  insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, method,
    started_by, started_by_membership_id, started_at, idempotency_key, request_sha256, correlation_id)
  values (execution_id, accession_id, specimen_id, test_id, item.patient_id, item.facility_id, requested_method,
    requested_account, requested_membership, clock_timestamp(), key_base || '-start',
    encode(sha256(convert_to(key_base || '-start', 'UTF8')), 'hex'), requested_correlation);
  insert into lab.execution_events (execution_id, patient_id, facility_id, event_version, event_type, actor_id,
    actor_membership_id, reason, correlation_id)
  values (execution_id, item.patient_id, item.facility_id, 1, 'execution_started', requested_account,
    requested_membership, 'Test started', requested_correlation);
  update lab.test_executions set status = 'completed', completed_at = clock_timestamp(), completed_by = requested_account,
         completed_by_membership_id = requested_membership, completed_idempotency_key = key_base || '-complete',
         completed_request_sha256 = encode(sha256(convert_to(key_base || '-complete', 'UTF8')), 'hex'),
         row_version = row_version + 1
   where id = execution_id and status = 'in_progress';
  insert into lab.execution_events (execution_id, patient_id, facility_id, event_version, event_type, actor_id,
    actor_membership_id, reason, correlation_id)
  values (execution_id, item.patient_id, item.facility_id, 2, 'execution_completed', requested_account,
    requested_membership, 'Analytical execution completed', requested_correlation);
  insert into lab.results (execution_id, patient_id, facility_id, created_by, created_by_membership_id)
  values (execution_id, item.patient_id, item.facility_id, requested_account, requested_membership)
  returning id into result_id;
  insert into lab.result_revisions (result_id, execution_id, patient_id, facility_id, version, result_type,
    numeric_value, text_value, unit, reference_range, abnormal_flag, entered_by, entered_by_membership_id,
    correction_reason, idempotency_key, request_sha256, correlation_id, revision_kind, supersedes_version)
  values (result_id, execution_id, item.patient_id, item.facility_id, 1, 'text', null, requested_value, null,
    requested_range, requested_flag, requested_account, requested_membership, null, key_base || '-enter',
    encode(sha256(convert_to(key_base || '-enter', 'UTF8')), 'hex'), requested_correlation, 'original', null);
  insert into lab.result_events (result_id, execution_id, patient_id, facility_id, event_version, event_type, actor_id,
    actor_membership_id, reason, correlation_id)
  values (result_id, execution_id, item.patient_id, item.facility_id, 1, 'result_entered', requested_account,
    requested_membership, 'Manual unverified result entered', requested_correlation);
  return result_id;
end
$$;

create function identity.demo_story_install(requested_pin_hash text)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  story_correlation constant text := '0102-sealed-demo-story';
  staff_account constant uuid := '98d00003-0000-4000-8000-000000000001';
  staff_record constant uuid := '98d00004-0000-4000-8000-000000000001';
  staff_subject constant text := 'sealed-demo:98d00003-0000-4000-8000-000000000001';
  hospital constant uuid := '98d00002-0000-4000-8000-000000000001';
  laboratory constant uuid := '98d00002-0000-4000-8000-000000000002';
  pharmacy_site constant uuid := '98d00002-0000-4000-8000-000000000003';
  outreach_site constant uuid := '98d00002-0000-4000-8000-000000000004';
  doctor_membership constant uuid := '98d00005-0000-4000-8000-000000000001';
  lab_membership constant uuid := '98d00005-0000-4000-8000-000000000002';
  pharmacist_membership constant uuid := '98d00005-0000-4000-8000-000000000003';
  nurse_membership constant uuid := '98d00005-0000-4000-8000-000000000004';
  patient_one constant uuid := '98d00009-0000-4000-8000-000000000001';
  patient_two constant uuid := '98d00009-0000-4000-8000-000000000002';
  account_one constant uuid := '98d00008-0000-4000-8000-000000000001';
  account_two constant uuid := '98d00008-0000-4000-8000-000000000002';
  dispensing_reason constant text := 'Dispensed as prescribed. Counselled to take with food and finish the course.';
  -- D2: the eight fictional patients' names, matched by sex and age.
  story_names constant jsonb := '[
    {"id": "98d00009-0000-4000-8000-000000000001", "old": "Patient One", "first": "Adaeze", "last": "Okafor"},
    {"id": "98d00009-0000-4000-8000-000000000002", "old": "Patient Two", "first": "Chinedu", "last": "Okafor"},
    {"id": "98d00009-0000-4000-8000-000000000003", "old": "Patient Three", "first": "Abubakar", "last": "Bello"},
    {"id": "98d00009-0000-4000-8000-000000000004", "old": "Patient Four", "first": "Halima", "last": "Yusuf"},
    {"id": "98d00009-0000-4000-8000-000000000005", "old": "Patient Five", "first": "Emeka", "last": "Nwosu"},
    {"id": "98d00009-0000-4000-8000-000000000006", "old": "Patient Six", "first": "Ngozi", "last": "Eze"},
    {"id": "98d00009-0000-4000-8000-000000000007", "old": "Patient Seven", "first": "Musa", "last": "Ibrahim"},
    {"id": "98d00009-0000-4000-8000-000000000008", "old": "Patient Eight", "first": "Funke", "last": "Adebayo"},
    {"id": "98d00009-0000-4000-8000-000000000009", "old": "Patient Nine", "first": "Ifeanyi", "last": "Okeke"},
    {"id": "98d00009-0000-4000-8000-000000000010", "old": "Patient Ten", "first": "Zainab", "last": "Lawal"}]';
  base timestamptz := clock_timestamp();
  visit_start timestamptz;
  prior_start timestamptz;
  step bigint;
  inserted bigint := 0;
  renamed bigint := 0;
  pins_set bigint := 0;
  profiles_set bigint := 0;
  charts_seeded boolean := false;
  outreach_seeded boolean := false;
  -- Ids made here (random, as the services make them).
  prior_encounter uuid := gen_random_uuid();
  today_encounter uuid := gen_random_uuid();
  two_encounter uuid := gen_random_uuid();
  prior_note uuid := gen_random_uuid();
  summary_note uuid := gen_random_uuid();
  today_note uuid := gen_random_uuid();
  mrdt_request uuid := gen_random_uuid();
  fbc_request uuid := gen_random_uuid();
  two_request uuid := gen_random_uuid();
  coartem_rx uuid := gen_random_uuid();
  paracetamol_rx uuid := gen_random_uuid();
  two_rx uuid := gen_random_uuid();
  ferrous_rx uuid := gen_random_uuid();
  routes uuid[] := array[]::uuid[];
  renamed_patients uuid[];
  renamed_accounts uuid[];
  renamed_staff uuid[];
  detail_patients uuid[];
  health_patients uuid[];
  pin_patients uuid[];
  case_ids uuid[] := array[]::uuid[];
  case_id uuid;
  -- What was written, gathered under the context that may read it (the
  -- tables force row-level security), for the audit in step 10.
  ehr_versions jsonb := '[]';
  lab_results jsonb := '[]';
  dispensings jsonb := '[]';
  dispensing_id uuid;
  result_id uuid;
  route_row record;
  work_item uuid;
  lab_order record;
  rx_order record;
  campaign uuid := gen_random_uuid();
  planned_campaign uuid := gen_random_uuid();
  story_case record;
  audited bigint := 0;
  -- The caller's request context, restored at the end.
  saved_settings text[] := array[current_setting('app.actor_subject', true), current_setting('app.membership_id', true),
    current_setting('app.facility_id', true), current_setting('app.correlation_id', true),
    current_setting('app.purpose_of_use', true), current_setting('app.patient_id', true),
    current_setting('app.session_id', true), current_setting('app.account_id', true),
    current_setting('app.change_reason', true)];
  setting_names constant text[] := array['app.actor_subject', 'app.membership_id', 'app.facility_id',
    'app.correlation_id', 'app.purpose_of_use', 'app.patient_id', 'app.session_id', 'app.account_id',
    'app.change_reason'];
begin
  -- One story install at a time; and after 0098's install (same lock key
  -- family, a different key).
  perform pg_advisory_xact_lock(hashtextextended('hid-sealed-demo-story-install', 0));

  -- 1. Every row this function touches belongs to the sealed demo tenant
  -- (D3): its four facilities, its staff login and the four memberships, the
  -- two patient logins and the ten patients, each marked in
  -- identity.sealed_demo_members and holding the 0098 values; else 55000 and
  -- nothing written.
  if (select count(*) from identity.sealed_demo_members member
       where (member.member_kind = 'facility' and member.member_id in (hospital, laboratory, pharmacy_site, outreach_site))
          or (member.member_kind = 'account' and member.member_id in (staff_account, account_one, account_two))
          or (member.member_kind = 'patient' and member.member_id in (select (name_row->>'id')::uuid
                                                                       from jsonb_array_elements(story_names) name_row)))
     <> 17
     or (select count(*) from identity.staff_facility_memberships membership
          where membership.id in (doctor_membership, lab_membership, pharmacist_membership, nurse_membership)
            and membership.account_id = staff_account and membership.staff_id = staff_record
            and identity.sealed_demo_facility(membership.facility_id)
            and membership.facility_id = case membership.id when doctor_membership then hospital
                                                            when lab_membership then laboratory
                                                            when pharmacist_membership then pharmacy_site
                                                            else outreach_site end) <> 4
     or (select count(*) from identity.patients patient
          where patient.id in (select (name_row->>'id')::uuid from jsonb_array_elements(story_names) name_row)
            and identity.sealed_demo_patient(patient.id)
            and patient.account_id is not distinct from case patient.id when patient_one then account_one
                                                                       when patient_two then account_two end) <> 10
     or not exists (select 1 from identity.staff staff_row
                     where staff_row.id = staff_record and staff_row.account_id = staff_account) then
    raise exception using errcode = '55000', message = '0102: SEALED_DEMO_STORY_NOT_DEMO';
  end if;

  -- 2. The PIN hash given is one set_my_patient_access_pin could have stored:
  -- bcrypt, cost 12, in the table's shape (D5).
  if requested_pin_hash is null or requested_pin_hash !~ '^\$2a\$12\$[./A-Za-z0-9]{53}$' then
    raise exception using errcode = '22023', message = '0102: SEALED_DEMO_STORY_PIN_HASH_INVALID';
  end if;

  -- 3. Names (D2): from 0098's "Demo Patient ..." only, so a later change is
  -- never overwritten; Patient One's date of birth becomes the video's, and
  -- the two logins get a state and country. Health IDs, sex and the other
  -- dates of birth are unchanged.
  with changed as (
  update identity.patients patient
     set first_name = name_row->>'first', last_name = name_row->>'last',
         full_name = (name_row->>'first') || ' ' || (name_row->>'last'),
         state = case when patient.id = any (array[patient_one, patient_two]) then coalesce(patient.state, 'Lagos')
                      else patient.state end,
         country = case when patient.id = any (array[patient_one, patient_two]) then coalesce(patient.country, 'Nigeria')
                        else patient.country end,
         dob = case when patient.id = patient_one and patient.dob = date '1985-03-14' then date '1991-03-04'
                    else patient.dob end,
         row_version = patient.row_version + 1, updated_at = clock_timestamp()
    from jsonb_array_elements(story_names) name_row
   where patient.id = (name_row->>'id')::uuid
     and patient.first_name = 'Demo' and patient.last_name = name_row->>'old'
     and patient.full_name = 'Demo ' || (name_row->>'old')
  returning patient.id)
  select coalesce(array_agg(changed.id), array[]::uuid[]) into renamed_patients from changed;
  renamed := cardinality(renamed_patients); inserted := inserted + renamed;
  with changed as (
  update auth.accounts account
     set display_name = case account.id when account_one then 'Adaeze Okafor' when account_two then 'Chinedu Okafor'
                                        else 'Dr Tunde Bello' end,
         row_version = account.row_version + 1, updated_at = clock_timestamp()
   where (account.id = account_one and account.display_name = 'Demo Patient One')
      or (account.id = account_two and account.display_name = 'Demo Patient Two')
      or (account.id = staff_account and account.display_name = 'Demo Operations')
  returning account.id)
  select coalesce(array_agg(changed.id), array[]::uuid[]) into renamed_accounts from changed;
  inserted := inserted + cardinality(renamed_accounts);
  with changed as (
  update identity.staff staff_row
     set full_name = 'Dr Tunde Bello', row_version = staff_row.row_version + 1, updated_at = clock_timestamp()
   where staff_row.id = staff_record and staff_row.full_name = 'Demo Operations'
  returning staff_row.id)
  select coalesce(array_agg(changed.id), array[]::uuid[]) into renamed_staff from changed;
  inserted := inserted + cardinality(renamed_staff);

  -- 4. What the patients entered in their profile (D4), unless they already
  -- saved their own.
  with added as (
  insert into identity.patient_profile_details (patient_id, hospital_currently_using, hmo_name)
  values (patient_one, 'Sample Teaching Hospital', 'Sample HMO'), (patient_two, 'Sample Teaching Hospital', 'Sample HMO')
  on conflict (patient_id) do nothing
  returning patient_id)
  select coalesce(array_agg(added.patient_id), array[]::uuid[]) into detail_patients from added;
  with added as (
  insert into ehr.patient_reported_health_profiles (patient_id, blood_group, genotype, allergies, current_medications,
    chronic_conditions, medical_notes, updated_by_account_id)
  values (patient_one, 'O+', 'AA', 'Penicillin — rash', 'Ferrous sulphate 200 mg tablets, one a day',
          'Iron deficiency anaemia', null, account_one),
         (patient_two, 'A+', 'AS', null, null, null, null, account_two)
  on conflict (patient_id) do nothing
  returning patient_id)
  select coalesce(array_agg(added.patient_id), array[]::uuid[]) into health_patients from added;
  profiles_set := cardinality(detail_patients) + cardinality(health_patients); inserted := inserted + profiles_set;

  -- 5. The access PIN (D5): the row set_my_patient_access_pin writes, with the
  -- hash given, for a patient without one; no grant revoked.
  perform pg_advisory_xact_lock(hashtextextended('patient-access-pin:' || patient_one::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('patient-access-pin:' || patient_two::text, 0));
  with added as (
  insert into identity.patient_access_pins (patient_id, pin_hash, status, hash_algorithm, disabled_at, disabled_reason,
    source_system, source_record_id, source_created_at, source_updated_at, created_at, updated_at, row_version)
  select pin_patient, requested_pin_hash, 'active', 'bcrypt', null, null, 'hid-sealed-demo', null, null, null,
         clock_timestamp(), clock_timestamp(), 1
    from unnest(array[patient_one, patient_two]) pin_patient
  on conflict (patient_id) do nothing
  returning patient_id)
  select coalesce(array_agg(added.patient_id), array[]::uuid[]) into pin_patients from added;
  pins_set := cardinality(pin_patients); inserted := inserted + pins_set;

  -- 6. The charts (D6-D9), once: the first install writes the story's own
  -- audit row (step 10), and a later call finds it and writes nothing more.
  if not exists (select 1 from audit.events event
                  where event.correlation_id = story_correlation and event.action = 'identity.sealed-demo.seed-story') then
    charts_seeded := true;
    visit_start := base - interval '150 minutes';
    prior_start := base - interval '42 days';
    -- The demo login's doctor membership at Demo Hospital, as the EHR sets it
    -- for a request; the seeded shares (0098 D6) must let it write for both
    -- patients (the insert policies' own check, asked first so a refusal
    -- names the cause even where the applier bypasses row-level security).
    if (select count(*) from auth.accounts account
         where account.id in (staff_account, account_one, account_two) and account.status = 'active'
           and (account.disabled_until is null or account.disabled_until <= clock_timestamp())) <> 3 then
      raise exception using errcode = '55000', message = '0102: SEALED_DEMO_STORY_LOGINS_NOT_READY';
    end if;
    if not platform.control_enabled('cross_facility_orders_enabled') then
      raise exception using errcode = '55000', message = '0102: SEALED_DEMO_STORY_ORDERS_OFF';
    end if;
    perform identity.demo_story_context(staff_subject, doctor_membership, hospital, story_correlation);
    if not (ehr.context_allows(patient_one, hospital, 'write_records')
            and ehr.context_allows(patient_two, hospital, 'write_records')) then
      raise exception using errcode = '55000', message = '0102: SEALED_DEMO_STORY_SHARE_MISSING';
    end if;

    -- 6a. Adaeze's visit six weeks ago (D6): tiredness, iron deficiency
    -- anaemia, ferrous sulphate for three months.
    insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
      status, started_at, ended_at, chief_complaint, created_at)
    values (prior_encounter, patient_one, hospital, staff_account, doctor_membership, 'ambulatory', 'completed',
      prior_start, prior_start + interval '40 minutes', 'Tiredness and dizziness for 2 weeks', prior_start);
    insert into ehr.vitals (encounter_id, patient_id, facility_id, created_by, created_by_membership_id, recorded_at,
      height_cm, weight_kg, temperature_c, pulse_bpm, respiratory_rate, systolic_mmhg, diastolic_mmhg,
      oxygen_saturation_percent, source, created_at)
    values (prior_encounter, patient_one, hospital, staff_account, doctor_membership, prior_start + interval '8 minutes',
      168, 70.1, 36.8, 88, 16, 112, 70, 99, 'manual', prior_start + interval '8 minutes');
    insert into ehr.clinical_notes (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
      note_type, title, status, signed_at, signed_by, created_at)
    values (prior_note, prior_encounter, patient_one, hospital, staff_account, doctor_membership, 'consultation',
      'Tiredness and dizziness', 'signed', prior_start + interval '30 minutes', staff_account,
      prior_start + interval '25 minutes'),
      (summary_note, prior_encounter, patient_one, hospital, staff_account, doctor_membership, 'patient_summary',
      'Patient summary', 'signed', prior_start + interval '35 minutes', staff_account, prior_start + interval '34 minutes');
    insert into ehr.clinical_note_revisions (clinical_note_id, patient_id, facility_id, revision_no, content,
      change_reason, supersedes_revision_no, created_by, created_by_membership_id, created_at)
    values (prior_note, patient_one, hospital, 1,
      E'History\nTired and dizzy for 2 weeks. Heavy periods. No chest pain.\n\nExamination\nPale. BP 112/70, pulse 88.\n\nPlan\nFerrous sulphate 200 mg once a day for 3 months. Check her haemoglobin again in 6 weeks.',
      'initial clinical note', null, staff_account, doctor_membership, prior_start + interval '25 minutes'),
      (summary_note, patient_one, hospital, 1,
      E'Allergies: Penicillin — rash.\nBlood group: O+ · Genotype: AA.\nEmergency contact: Chinedu Okafor (sibling).\nCurrent medicines: Ferrous sulphate 200 mg tablets, one a day.',
      'initial clinical note', null, staff_account, doctor_membership, prior_start + interval '34 minutes');
    insert into ehr.diagnoses (encounter_id, patient_id, facility_id, created_by, created_by_membership_id, code_system,
      code, display, clinical_status, verification_status, onset_at, abatement_at, notes, created_at)
    values (prior_encounter, patient_one, hospital, staff_account, doctor_membership, 'ICD-10', 'Z88.0',
      'Allergy to penicillin (rash)', 'active', 'confirmed', null, null, 'Rash after amoxicillin as a child.',
      prior_start + interval '33 minutes'),
      (prior_encounter, patient_one, hospital, staff_account, doctor_membership, 'ICD-10', 'D50.9',
      'Iron deficiency anaemia', 'active', 'confirmed', base - interval '56 days', null, null,
      prior_start + interval '32 minutes');
    insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
      medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
      instructions, starts_on, ends_on, status, created_at)
    values (ferrous_rx, prior_encounter, patient_one, hospital, staff_account, doctor_membership, null, null,
      'Ferrous sulphate 200 mg tablets', 1, 'tablet(s)', 'Oral', 'Once a day for 3 months',
      'Take after a meal. It can make stools dark.', (prior_start at time zone 'Africa/Lagos')::date,
      (prior_start at time zone 'Africa/Lagos')::date + 90, 'active', prior_start + interval '31 minutes');

    -- 6b. Adaeze today (D7): fever for three days; triage, the consultation,
    -- malaria, two lab requests and two prescriptions; the visit stays open.
    insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
      status, started_at, chief_complaint, created_at)
    values (today_encounter, patient_one, hospital, staff_account, doctor_membership, 'ambulatory', 'in_progress',
      visit_start, 'Fever, headache and body aches for 3 days', visit_start);
    insert into ehr.vitals (encounter_id, patient_id, facility_id, created_by, created_by_membership_id, recorded_at,
      height_cm, weight_kg, temperature_c, pulse_bpm, systolic_mmhg, diastolic_mmhg, oxygen_saturation_percent,
      source, created_at)
    values (today_encounter, patient_one, hospital, staff_account, doctor_membership, visit_start + interval '10 minutes',
      168, 72.4, 37.9, 78, 128, 82, 98, 'manual', visit_start + interval '10 minutes');
    insert into ehr.clinical_notes (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
      note_type, title, status, created_at)
    values (today_note, today_encounter, patient_one, hospital, staff_account, doctor_membership, 'consultation',
      'Fever for 3 days', 'draft', visit_start + interval '25 minutes');
    insert into ehr.clinical_note_revisions (clinical_note_id, patient_id, facility_id, revision_no, content,
      change_reason, supersedes_revision_no, created_by, created_by_membership_id, created_at)
    values (today_note, patient_one, hospital, 1,
      E'History\nFever, headache and body aches for 3 days. No vomiting. Appetite reduced.\n\nExamination\nWarm to touch, mild pallor, no neck stiffness.',
      'initial clinical note', null, staff_account, doctor_membership, visit_start + interval '25 minutes');
    perform set_config('app.change_reason', 'Consultation complete', true);
    update ehr.clinical_notes note
       set status = 'signed', signed_at = visit_start + interval '30 minutes', signed_by = staff_account
     where note.id = today_note;
    perform set_config('app.change_reason', '', true);
    insert into ehr.diagnoses (encounter_id, patient_id, facility_id, created_by, created_by_membership_id, code_system,
      code, display, clinical_status, verification_status, created_at)
    values (today_encounter, patient_one, hospital, staff_account, doctor_membership, 'ICD-10', 'B54',
      'Malaria (uncomplicated)', 'active', 'confirmed', visit_start + interval '32 minutes');
    insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
      medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
      instructions, starts_on, status, created_at)
    values (coartem_rx, today_encounter, patient_one, hospital, staff_account, doctor_membership, null, null,
      'Artemether-lumefantrine 80/480 mg tablets', 1, 'tablet(s)', 'Oral', 'Twice daily for 3 days', 'Take with food',
      (base at time zone 'Africa/Lagos')::date, 'active', visit_start + interval '40 minutes'),
      (paracetamol_rx, today_encounter, patient_one, hospital, staff_account, doctor_membership, null, null,
      'Paracetamol 500 mg tablets', 2, 'tablet(s)', 'Oral', 'Three times daily for 3 days', 'For fever and pain',
      (base at time zone 'Africa/Lagos')::date, 'active', visit_start + interval '42 minutes');
    insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
      test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information, created_at)
    values (mrdt_request, today_encounter, patient_one, hospital, staff_account, doctor_membership, 'LOCAL', 'MRDT',
      'Malaria rapid test', 'routine', 'active', 'Blood', 'Fever for 3 days.', visit_start + interval '45 minutes'),
      (fbc_request, today_encounter, patient_one, hospital, staff_account, doctor_membership, 'LOCAL', 'FBC',
      'Full blood count', 'routine', 'active', 'Blood', 'Fever for 3 days.', visit_start + interval '46 minutes');

    -- 6c. Chinedu today (D8): checked in, triage done, a malaria test and
    -- paracetamol ordered; the laboratory waits for his sample and the
    -- pharmacy has his prescription to hand over.
    insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
      status, started_at, chief_complaint, created_at)
    values (two_encounter, patient_two, hospital, staff_account, doctor_membership, 'ambulatory', 'in_progress',
      base - interval '40 minutes', 'Fever and headache since yesterday', base - interval '40 minutes');
    insert into ehr.vitals (encounter_id, patient_id, facility_id, created_by, created_by_membership_id, recorded_at,
      height_cm, weight_kg, temperature_c, pulse_bpm, systolic_mmhg, diastolic_mmhg, oxygen_saturation_percent,
      source, created_at)
    values (two_encounter, patient_two, hospital, staff_account, doctor_membership, base - interval '32 minutes',
      176, 78.0, 38.2, 92, 122, 78, 97, 'manual', base - interval '32 minutes');
    insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
      test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information, created_at)
    values (two_request, two_encounter, patient_two, hospital, staff_account, doctor_membership, 'LOCAL', 'MRDT',
      'Malaria rapid test', 'routine', 'active', 'Blood', 'Fever since yesterday.', base - interval '20 minutes');
    insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
      medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
      instructions, starts_on, status, created_at)
    values (two_rx, two_encounter, patient_two, hospital, staff_account, doctor_membership, null, null,
      'Paracetamol 500 mg tablets', 2, 'tablet(s)', 'Oral', 'Three times daily for 3 days', 'For fever and pain',
      (base at time zone 'Africa/Lagos')::date, 'active', base - interval '18 minutes');

    -- The EHR's version rows of everything written above, read as the
    -- doctor (the audit names each).
    select coalesce(jsonb_agg(jsonb_build_object('facility', version_row.facility_id, 'patient', version_row.patient_id,
             'type', version_row.resource_type, 'id', version_row.resource_id, 'operation', version_row.operation,
             'version', version_row.version_no) order by version_row.id), '[]')
      into ehr_versions
      from ehr.record_versions version_row
     where version_row.correlation_id = story_correlation and version_row.recorded_at >= base;

    -- 7. The orders (D9), through the live commands: sent from Demo Hospital,
    -- accepted at Demo Laboratory and Demo Pharmacy by the same login (as a
    -- tester would), each identifying the patient by Health ID.
    for lab_order in select * from (values (1, mrdt_request, today_encounter, patient_one, 'HID-ZDEMAAA2'),
                                           (2, fbc_request, today_encounter, patient_one, 'HID-ZDEMAAA2'),
                                           (3, two_request, two_encounter, patient_two, 'HID-ZDEMAAA3'))
                                   orders(n, order_id, encounter_id, patient_id, health_id)
    loop
      perform identity.demo_story_context(staff_subject, doctor_membership, hospital, story_correlation);
      select sent.route_id into route_row from ehr.send_order_route(gen_random_uuid(), 'lab_request',
        lab_order.patient_id, lab_order.order_id, lab_order.encounter_id, 1, laboratory, 'order-route-lab-attestation-v1',
        'sealed-demo-story-lab-send-' || lab_order.n, encode(sha256(convert_to('sealed-demo-story-lab-send-' || lab_order.n, 'UTF8')), 'hex')) sent;
      routes := routes || route_row.route_id;
      perform identity.demo_story_context(staff_subject, lab_membership, laboratory, story_correlation);
      select accepted.work_item_id into work_item from lab.accept_order_route(route_row.route_id, 1, 'health_id',
        lab_order.health_id, 'sealed-demo-story-lab-accept-' || lab_order.n,
        encode(sha256(convert_to('sealed-demo-story-lab-accept-' || lab_order.n, 'UTF8')), 'hex')) accepted
       where accepted.result = 'accepted';
      if work_item is null then
        raise exception using errcode = '55000', message = '0102: SEALED_DEMO_STORY_ORDER_NOT_ACCEPTED';
      end if;
      if lab_order.n < 3 then
        result_id := identity.demo_story_lab_result(work_item, staff_account, lab_membership, story_correlation,
          case lab_order.n when 1 then 'Rapid diagnostic test kit' else 'Haematology analyser' end,
          case lab_order.n when 1 then 'Fever for 3 days. Malaria rapid test requested by Dr Tunde Bello.'
                           else 'Fever for 3 days. Full blood count requested by Dr Tunde Bello.' end,
          case lab_order.n when 1 then 'Positive (P. falciparum)'
                           else 'Hb 12.8 g/dL, WBC 7.2 ×10^9/L, platelets 210 ×10^9/L' end,
          case lab_order.n when 1 then 'Negative' end,
          case lab_order.n when 1 then 'abnormal' else 'normal' end);
        lab_results := lab_results || jsonb_build_object('id', result_id, 'patient', lab_order.patient_id);
      end if;
    end loop;
    for rx_order in select * from (values (1, coartem_rx, today_encounter, patient_one, 'HID-ZDEMAAA2', 6),
                                          (2, paracetamol_rx, today_encounter, patient_one, 'HID-ZDEMAAA2', 18),
                                          (3, two_rx, two_encounter, patient_two, 'HID-ZDEMAAA3', null))
                                  orders(n, order_id, encounter_id, patient_id, health_id, quantity)
    loop
      perform identity.demo_story_context(staff_subject, doctor_membership, hospital, story_correlation);
      select sent.route_id into route_row from ehr.send_order_route(gen_random_uuid(), 'prescription',
        rx_order.patient_id, rx_order.order_id, rx_order.encounter_id, 1, pharmacy_site,
        'order-route-prescription-attestation-v1', 'sealed-demo-story-rx-send-' || rx_order.n,
        encode(sha256(convert_to('sealed-demo-story-rx-send-' || rx_order.n, 'UTF8')), 'hex')) sent;
      routes := routes || route_row.route_id;
      perform identity.demo_story_context(staff_subject, pharmacist_membership, pharmacy_site, story_correlation);
      select accepted.work_item_id into work_item from pharmacy.accept_order_route(route_row.route_id, 1, 'health_id',
        rx_order.health_id, 'Patient is here to collect the prescription', 'sealed-demo-story-rx-accept-' || rx_order.n,
        encode(sha256(convert_to('sealed-demo-story-rx-accept-' || rx_order.n, 'UTF8')), 'hex')) accepted
       where accepted.result = 'accepted';
      if work_item is null then
        raise exception using errcode = '55000', message = '0102: SEALED_DEMO_STORY_ORDER_NOT_ACCEPTED';
      end if;
      if rx_order.quantity is not null then
        insert into pharmacy.dispensings (work_item_id, work_item_version, patient_id, facility_id,
          medication_code_system, medication_code, medication_display, quantity_dispensed, quantity_unit, dispensed_by,
          dispensed_by_membership_id, reason, idempotency_key, request_sha256, correlation_id)
        select item.id, 1, item.patient_id, item.facility_id, item.medication_code_system, item.medication_code,
               item.medication_display, rx_order.quantity, 'tablets', staff_account, pharmacist_membership,
               dispensing_reason, 'sealed-demo-story-dispense-' || rx_order.n,
               encode(sha256(convert_to('sealed-demo-story-dispense-' || rx_order.n, 'UTF8')), 'hex'), story_correlation
          from pharmacy.work_items item where item.id = work_item
        returning id into dispensing_id;
        dispensings := dispensings || jsonb_build_object('id', dispensing_id, 'patient', rx_order.patient_id);
      end if;
    end loop;
  end if;

  -- 8. Demo Outreach (D11), with the charts: the video's two campaigns and
  -- four field registrations, written as outreach-api writes them (the
  -- campaign, its creator as admin member and events; each case and its
  -- received event), by the demo login's nurse membership; no outbox row.
  -- No phone number is stored, and no case is linked to a patient or to a
  -- campaign (outreach.validate_registration_campaign_write reads the
  -- campaign member FOR SHARE, which forced row-level security refuses an
  -- applier without BYPASSRLS: outreach.campaign_members has no UPDATE
  -- policy).
  if charts_seeded then
    outreach_seeded := true;
    perform identity.demo_story_context(staff_subject, nurse_membership, outreach_site, story_correlation);
    insert into outreach.campaigns (id, facility_id, created_by_account_id, created_by_membership_id, name, services,
      starts_at, created_at)
    values (campaign, outreach_site, staff_account, nurse_membership, 'Ajegunle health week',
      array['registration', 'vitals'], base - interval '3 days', base - interval '3 days'),
      (planned_campaign, outreach_site, staff_account, nurse_membership, 'Makoko school screening', array['vitals'],
      base + interval '10 days', base - interval '1 day');
    insert into outreach.campaign_members (campaign_id, facility_id, membership_id, role, added_by_account_id,
      added_by_membership_id)
    values (campaign, outreach_site, nurse_membership, 'admin', staff_account, nurse_membership),
           (planned_campaign, outreach_site, nurse_membership, 'admin', staff_account, nurse_membership);
    insert into outreach.campaign_events (campaign_id, facility_id, event_type, actor_account_id, actor_membership_id,
      details, correlation_id)
    select created.id, outreach_site, event_kind, staff_account, nurse_membership,
           case event_kind when 'campaign_created' then jsonb_build_object('name', created.name, 'services', created.services)
                           else jsonb_build_object('membershipId', nurse_membership, 'role', 'admin') end,
           story_correlation
      from outreach.campaigns created
     cross join unnest(array['campaign_created', 'campaign_member_added']) event_kind
     where created.id in (campaign, planned_campaign);
    update outreach.campaigns set status = 'active', row_version = row_version + 1 where id = campaign;
    insert into outreach.campaign_events (campaign_id, facility_id, event_type, actor_account_id, actor_membership_id,
      details, correlation_id)
    values (campaign, outreach_site, 'campaign_status_changed', staff_account, nurse_membership,
      jsonb_build_object('status', 'active'), story_correlation);
    for story_case in select * from (values ('Kemi Balogun', 34, 'female', interval '40 minutes'),
                                            ('Ibrahim Musa', 61, 'male', interval '2 hours'),
                                            ('Chiamaka Obi', 8, 'female', interval '1 day'),
                                            ('Segun Adewale', 45, 'unknown', interval '2 days'))
                                    cases(full_name, age_years, sex, age_of_case)
    loop
      with registered as (
        insert into outreach.registration_cases (facility_id, created_by_account_id, created_by_membership_id,
          local_command_id, temporary_patient_id, full_name, sex, age_years, campaign_id, created_at)
        values (outreach_site, staff_account, nurse_membership, gen_random_uuid(), 'tmp_' || gen_random_uuid()::text,
          story_case.full_name, story_case.sex, story_case.age_years,
          null, base - story_case.age_of_case)
        returning id, temporary_patient_id)
      insert into outreach.registration_case_events (registration_case_id, event_type, facility_id,
        temporary_patient_id, actor_account_id, actor_membership_id)
      select registered.id, 'registration_case_received', outreach_site, registered.temporary_patient_id, staff_account,
             nurse_membership
        from registered
      returning registration_case_id into case_id;
      case_ids := case_ids || case_id;
    end loop;
  end if;

  -- 9. The notices the order commands put in the patients' inboxes (sent,
  -- accepted) are marked read in this transaction, so no phone or computer
  -- notification is ever due for them (D12); the patient still sees them.
  if charts_seeded then
    update notification.inbox_items item set read_at = clock_timestamp()
     where item.resource_type = 'order-route' and item.resource_id = any (routes) and item.read_at is null
       and item.account_id in (account_one, account_two);
  end if;

  -- 10. The audit (D13): one row of the migration's own for every row
  -- written or changed (actor system, provenance migration, source system
  -- hid-sealed-demo, correlation id 0102-sealed-demo-story), never a
  -- patient's or a clinician's, and with ids only; the PIN's says its cost,
  -- never the hash.
  perform identity.demo_story_context(null, null, null, story_correlation);
  insert into audit.events (correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type,
    resource_id, provenance, source_system, details)
  select story_correlation, 'system', seeded.facility_id, seeded.patient_id, seeded.action, 'success',
         seeded.resource_type, seeded.resource_id, 'migration', 'hid-sealed-demo', seeded.details
    from (
      select null::uuid as facility_id, renamed_patient as patient_id, 'identity.sealed-demo.seed-name' as action,
             'patient' as resource_type, renamed_patient::text as resource_id, '{}'::jsonb as details
        from unnest(renamed_patients) renamed_patient
      union all
      select null, null, 'identity.sealed-demo.seed-name', 'account', renamed_account::text, '{}'::jsonb
        from unnest(renamed_accounts) renamed_account
      union all
      select null, null, 'identity.sealed-demo.seed-name', 'staff', renamed_staff_row::text, '{}'::jsonb
        from unnest(renamed_staff) renamed_staff_row
      union all
      select null, detail_patient, 'identity.sealed-demo.seed-profile', 'patient-profile-details', detail_patient::text,
             '{}'::jsonb
        from unnest(detail_patients) detail_patient
      union all
      select null, health_patient, 'identity.sealed-demo.seed-profile', 'patient-reported-health-profile',
             health_patient::text, '{}'::jsonb
        from unnest(health_patients) health_patient
      union all
      select null, pin_patient, 'identity.sealed-demo.seed-access-pin', 'patient-access-pin', pin_patient::text,
             jsonb_build_object('bcryptCost', 12)
        from unnest(pin_patients) pin_patient
      union all
      select (version_row->>'facility')::uuid, (version_row->>'patient')::uuid, 'identity.sealed-demo.seed-record',
             version_row->>'type', version_row->>'id',
             jsonb_build_object('operation', version_row->>'operation', 'version', (version_row->>'version')::bigint)
        from jsonb_array_elements(ehr_versions) version_row
      union all
      select route.ordering_facility_id, route.patient_id, 'identity.sealed-demo.seed-order', 'order-route',
             route.id::text, jsonb_build_object('kind', route.kind, 'state', route.state)
        from ehr.order_routes route where route.id = any (routes)
      union all
      select laboratory, (lab_result->>'patient')::uuid, 'identity.sealed-demo.seed-record', 'lab-result',
             lab_result->>'id', jsonb_build_object('version', 1, 'released', false)
        from jsonb_array_elements(lab_results) lab_result
      union all
      select pharmacy_site, (dispensing->>'patient')::uuid, 'identity.sealed-demo.seed-record', 'dispensing',
             dispensing->>'id', '{}'::jsonb
        from jsonb_array_elements(dispensings) dispensing
      union all
      select outreach_site, null, 'identity.sealed-demo.seed-record', 'outreach-campaign', created_campaign::text,
             '{}'::jsonb
        from unnest(case when outreach_seeded then array[campaign, planned_campaign] else array[]::uuid[] end)
             created_campaign
      union all
      select outreach_site, null, 'identity.sealed-demo.seed-record', 'outreach-registration-case',
             registered_case::text, '{}'::jsonb
        from unnest(case_ids) registered_case) seeded;
  get diagnostics audited = row_count;
  if charts_seeded then
    insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, provenance, source_system,
      details)
    values (story_correlation, 'system', 'identity.sealed-demo.seed-story', 'success', 'sealed-demo-tenant',
      'migration', 'hid-sealed-demo', jsonb_build_object('rowsAudited', audited, 'renamed', renamed,
        'profiles', profiles_set, 'pins', pins_set, 'orders', cardinality(routes),
        'registrationCases', cardinality(case_ids)));
  end if;

  for step in 1..array_length(setting_names, 1) loop
    perform set_config(setting_names[step], coalesce(saved_settings[step], ''), true);
  end loop;

  return jsonb_build_object('changed', inserted, 'renamed', renamed, 'pins', pins_set, 'profiles', profiles_set,
    'charts', charts_seeded, 'orders', cardinality(routes), 'registrationCases', cardinality(case_ids),
    'audited', audited);
end
$$;

-- 2. No grant: the three functions are the applier's alone (runtime-grants.sql
-- revokes them from PUBLIC too).
revoke all on function identity.demo_story_context(text,uuid,uuid,text),
  identity.demo_story_lab_result(uuid,uuid,uuid,text,text,text,text,text,text),
  identity.demo_story_install(text) from public;

-- 3. Post-checks.
do $$
begin
  if (select count(*) from pg_proc proc
       where proc.oid in ('identity.demo_story_context(text,uuid,uuid,text)'::regprocedure,
                          'identity.demo_story_lab_result(uuid,uuid,uuid,text,text,text,text,text,text)'::regprocedure,
                          'identity.demo_story_install(text)'::regprocedure)
         and proc.proowner = (select oid from pg_roles where rolname = current_user)
         and proc.prosecdef = (proc.proname = 'demo_story_install')
         and proc.proconfig = array['search_path=pg_catalog, pg_temp']
         and proc.provolatile = 'v'
         and not exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                          where acl.grantee <> proc.proowner)) <> 3 then
    raise exception using errcode = '55000', message = '0102: the story functions are not as this file made them';
  end if;
end
$$;

-- 4. Comments.
comment on function identity.demo_story_context(text,uuid,uuid,text) is
  '0102: sets the request context a service sets (actor, membership, facility, correlation id, direct care) for the rest of the transaction. Called only by identity.demo_story_install.';
comment on function identity.demo_story_lab_result(uuid,uuid,uuid,text,text,text,text,text,text) is
  '0102: the Lab''s own steps for one accepted demo work item as lab-api writes them (accession, sample collected and received, test run, a text result entered), with their event rows, no outbox or application audit row; not checked or released (a second person must check). Called only by identity.demo_story_install.';
comment on function identity.demo_story_install(text) is
  '0102: fills the sealed demo tenant with the demo video''s made-up story: names (Adaeze Okafor, Chinedu Okafor and eight others; the staff login Dr Tunde Bello), profile details and health information, the given bcrypt PIN hash (cost 12) for Patient One and Two where they have none, Adaeze''s visit six weeks ago and today''s visit, Chinedu checked in, orders sent through the live commands to Demo Laboratory and Demo Pharmacy and accepted there, two results entered, two dispensings, two Outreach campaigns and four registrations. Demo rows only (55000 otherwise); the order notices are marked read, nothing is sent; one migration audit row per row written (actor system, provenance migration, hid-sealed-demo, 0102-sealed-demo-story). A second call changes nothing.';

-- 5. The seed, on Amazon RDS only (D1), with the owner's PIN hash (bcrypt,
-- cost 12, made with pgcrypto; the PIN is in no file). A refusal raises 55000
-- and the release stops with nothing applied.
do $$
declare summary jsonb;
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'rds_superuser') then
    summary := identity.demo_story_install('$2a$12$6wGzpNmtDSCbABUkV4L3RuycrhLro8DjP6iLEPZmOL/CLLJ0zfwcO');
    raise notice '0102: sealed demo story installed: %', summary::text;
  else
    raise notice '0102: not an Amazon RDS database; the sealed demo story is not installed (the functions are)';
  end if;
end
$$;
