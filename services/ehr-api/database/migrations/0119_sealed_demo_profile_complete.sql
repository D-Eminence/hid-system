-- 0119 Sealed demo profiles complete (owner decision of 2026-11-03: the demo
-- patients' profiles must reach 100%; the declaration signed separately):
-- Adaeze Okafor (HID-ZDEMAAA2) and Chinedu Okafor (HID-ZDEMAAA3), the two
-- patient logins of the sealed demo tenant (0098, 0102), get the two items of
-- the patient portal's completion card that the seal kept open: a phone
-- number and a verified NIN. Both are clearly fictional: the phone numbers
-- are in the UK's range reserved for drama (no subscriber holds them), and no
-- NIN is stored at all, so nothing can ever be sent to or matched by the NIN
-- service. Nothing here is a real person, and nothing is sent.
--
-- Decisions:
-- D1 The completion card (apps/patient-web profileCompletion.ts) counts
--    twelve items. After 0102 Adaeze and Chinedu hold eight (email, gender,
--    date of birth, state, hospital, HMO, blood group, genotype); the photo
--    and an emergency contact are the owner's to add in the app (0102 D4).
--    The phone and the NIN are the two the seal kept open: 0098 G5 refuses
--    any phone for a demo patient, and a verified NIN needed a QoreID check,
--    which 0098 G6 refuses for demo accounts. G6 stays exactly as it is.
-- D2 The phone is a reviewed change to the seal (the G7 pattern, 0098 D11).
--    A migration cannot write a phone the portal can show: Identity encrypts
--    it with its own key and shows only a number it can decrypt
--    (PatientContactReader). So the owner types the number on each demo
--    patient's profile page, and the database admits exactly one number per
--    demo patient: +447700900102 for Adaeze (Patient One) and +447700900103
--    for Chinedu (Patient Two), the UK drama range the repository's tests
--    already use (Nigeria publishes no fictional range, so a Nigerian-looking
--    number could belong to a real subscriber now or later).
--    New identity.demo_profile_phone_allowed(subject, session, phone,
--    lookup HMAC), Identity's check before change_my_phone (42501 without a
--    live patient session): true for every patient who is not a demo
--    patient; for a demo patient, true only for its own number with a
--    well-formed HMAC (64 lowercase hex characters), and then it records
--    "<patient id>:<HMAC>" in hid.sealed_demo_phone_hmac for the rest of the
--    transaction; false otherwise (and the recorded value is cleared). Its
--    name is not sealed_demo_* so that 0098's set of fifteen sealed_demo_*
--    functions is unchanged.
--    G5's body (identity.patient_contact_changes_sealed_demo, CREATE OR
--    REPLACE; the trigger, owner, ACL, SECURITY DEFINER, search_path and
--    error are unchanged) now refuses a demo patient's phone change (22023
--    PATIENT_CONTACT_CHANGE_INVALID) unless the recorded value is exactly
--    that patient's id and the change's HMAC. So an Identity image that never
--    asks the check (every image before this release) still has every demo
--    phone refused; the eight fictional patients without a login have no
--    number and are refused always; every other guard (G1-G4, G6, G7, the
--    eight replaced bodies) is untouched. The database holds only the HMAC
--    and the ciphertext, so it cannot tell that the HMAC is the checked
--    number's, and any session can set hid.sealed_demo_phone_hmac itself:
--    as for G7, that a demo patient's number is the fictional one rests on
--    Identity (PatientContactChangeService.changePhone computes the HMAC
--    from the same normalized number it checks and encrypts).
--    No SMS can follow: production sends none; OTP recovery texts only a
--    public enrollment's verified phone (otp.service verifiedEnrollmentPhone)
--    and the demo patients have no enrollment; a phone's recovery code goes
--    to the verified email, a demo mailbox; the phone-change notice goes to
--    that email too; phoneVerified stays false.
-- D3 The NIN is a seed, with no DDL on any live table. A verified NIN item
--    is an identity.patient_identifiers row of type 'nin', verified and not
--    revoked (identity.patient_self_profile's ninVerified, 0092). Such a row
--    needs exactly one provenance (0058's two CHECKs): a registration case,
--    a public enrollment, or a patient's own QoreID evidence. The last two
--    are QoreID's (verification_evidence.provider is fixed to 'qoreid', 0034)
--    and writing one would fake a QoreID check. So each patient gets a
--    resolved registration case at Demo Hospital, written as the demo
--    login's doctor membership (as 0102 writes the charts), with provider
--    'hid-sealed-demo' (registration_cases.verification_provider is free
--    text; 'deterministic-test' is already used there), and the identifier
--    row naming that case.
-- D4 No NIN is stored. lookup_hmac (and the case's nin_lookup_hmac) is
--    sha256('hid-sealed-demo:0119:nin:' || patient id): not an HMAC under
--    Identity's key, so no NIN anyone types can match it (sign-up's
--    identity.public_patient_nin_already_bound, the self-check's
--    identity.patient_self_nin_eligibility, staff registration). The
--    ciphertext is a plain-text marker of more than 30 bytes
--    ('hid-sealed-demo:0119:no-nin-stored:' || patient id), not Identity's
--    envelope (which starts with byte 1), and nothing decrypts it; the key
--    version is 'hid-sealed-demo'; the last four are '0000' and the hint
--    '****0000'.
-- D5 It says truthfully that NIMC did not check it: verification_provider
--    and source_system 'hid-sealed-demo', verification_reference
--    '0119-sealed-demo-profile'; the patient's assurance stays
--    CONTACT_VERIFIED (never NIN_VERIFIED); no verification_evidence row, no
--    authoritative profile, no patients.nin_hash or nin_ciphertext, no QoreID
--    quota row. The NIN self-check cannot reach QoreID for a demo patient:
--    identity.patient_self_nin_eligibility answers 'denied' (assurance source
--    is 'hid-sealed-demo', not 'hid-public-signup', and from now on a NIN
--    identifier exists) before any quota or QoreID call, and G6 stays as a
--    second wall; the portal hides its "Verify your NIN" card once ninVerified
--    is true. The card and the shared card will show the demo patients as
--    NIN-verified (owner decision of 2026-11-03).
-- D6 identity.demo_profile_install() (SECURITY DEFINER, the applier's,
--    granted to no role) writes the NIN rows. It runs on Amazon RDS only
--    (where the role rds_superuser exists), as 0098 D3 and 0102 D1; CI,
--    acceptance, the staging upgrade rehearsal and throwaway clusters get
--    the functions only, and the suite sealed-demo-profile calls the seed
--    itself. For each of Adaeze and Chinedu that has no NIN identifier (a
--    patient who already has one is skipped, so a second call writes
--    nothing): the request context of the demo doctor membership at Demo
--    Hospital (identity.demo_story_context, correlation id
--    0119-sealed-demo-profile); one identity.registration_cases row (fixed
--    id 98d00119-0000-4000-8000-00000000000n, status
--    resolved_existing_identity, resolved to the patient, names, date of
--    birth and gender from the patient row, the values of D4 and D5, a fixed
--    idempotency key and its sha256); one patient_identifiers row (fixed id
--    98d00119-0000-4000-8000-00000000001n). Assurance, evidence,
--    authoritative profiles and quota are left alone. Platform overview
--    counts are unchanged (0098 excludes demo facilities, and the case is
--    resolved).
-- D7 It refuses (55000, nothing written): SEALED_DEMO_PROFILE_NOT_DEMO (a
--    row it would touch is not the sealed demo tenant's as 0098 left it:
--    Demo Hospital, the staff login and its doctor membership there, the two
--    patient logins and their patients), SEALED_DEMO_PROFILE_PATIENT_NOT_READY
--    (Adaeze or Chinedu is not active, or their login is not active),
--    SEALED_DEMO_PROFILE_ROLE_MISSING (the doctor membership is not active,
--    has lost identity.registration.write, or the staff record has no name),
--    SEALED_DEMO_PROFILE_ID_TAKEN (a fixed id is held by a row the seed did
--    not write). The photo and the emergency contact are not required: the
--    owner adds them in the app, before or after.
-- D8 The audit tells the truth: one row of the migration's own for every
--    row written (actor system, provenance migration, source system
--    hid-sealed-demo, correlation id 0119-sealed-demo-profile, action
--    identity.sealed-demo.seed-record; ids only, never a NIN, hint or HMAC)
--    and one summary row (identity.sealed-demo.seed-profile, counts only)
--    when anything was written. No row names a patient or a clinician as its
--    actor. The registration case names the demo login as its creator,
--    because it is written as that doctor membership.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0103 applied and every object relied on
--    exists (else "0119: 0001-0103 must be applied first"); no function of
--    this file exists (else "0119: already applied"); the bodies the new
--    functions call or rely on, and the G5 body replaced, are byte for byte
--    the ones 0001-0103 gave them (md5 of pg_proc.prosrc); the G5 trigger and
--    0058's two CHECKs on identity.patient_identifiers are as 0058 and 0098
--    made them; the applying role owns (or is a member of the owner of) the
--    G5 function and the three tables the seed writes, and may create in
--    schema identity (else 42501).
-- 1. The phone: the check and G5's new body. 2. The NIN seed. 3. Grants (the
--    check to the Identity runtime and the schema test runtime; the seed to
--    none; both revoked from PUBLIC; the same in runtime-grants.sql).
--    4. Post-checks (owner, SECURITY DEFINER, search_path, volatility, ACL; G5
--    as before but for its body; the trigger unchanged; the nine sealed
--    demo triggers enabled). 5. Comments. 6. The seed, on Amazon RDS only.
--
-- Locks: none up front. CREATE OR REPLACE of G5 takes no table lock. On
-- production the seed takes ROW EXCLUSIVE on identity.registration_cases,
-- identity.patient_identifiers and audit.events and row locks on the two
-- patients, for the length of the release transaction.
--
-- Order of release: this file before the Identity image that asks
-- identity.demo_profile_phone_allowed (an image that asks it before it
-- exists would fail every patient's phone change). An Identity image that
-- does not ask it keeps working as today for every real patient, and every
-- demo phone stays refused. After both are deployed the owner enters the two
-- numbers on the two profile pages.
--
-- Applied migrations 0001-0103 are immutable. No down migration: the seeded
-- rows are ordinary demo rows; 0098's off switch (disable the accounts,
-- suspend the facilities) still applies, and applying 0098's G5 body again
-- restores "a demo patient never holds a phone" for new changes.
--
-- Before signing, the owner runs this read-only query on production; it must
-- answer rds 1, patients_ready 2, photos 2, emergency_contacts 2 or more
-- (otherwise the card stops below 100% until the owner adds them; 0119
-- applies anyway), nin_identifiers 0, phones 0, doctor_ok true, audit 0:
--   select (select count(*) from pg_roles where rolname = 'rds_superuser') as rds,
--          (select count(*) from identity.patients patient join auth.accounts account on account.id = patient.account_id
--            where patient.id in ('98d00009-0000-4000-8000-000000000001', '98d00009-0000-4000-8000-000000000002')
--              and patient.status = 'active' and account.status = 'active') as patients_ready,
--          (select count(*) from identity.patient_profile_photos where patient_id in
--             ('98d00009-0000-4000-8000-000000000001', '98d00009-0000-4000-8000-000000000002')) as photos,
--          (select count(*) from identity.patient_emergency_contacts where status <> 'deactivated' and patient_id in
--             ('98d00009-0000-4000-8000-000000000001', '98d00009-0000-4000-8000-000000000002')) as emergency_contacts,
--          (select count(*) from identity.patient_identifiers where identifier_type = 'nin' and patient_id in
--             ('98d00009-0000-4000-8000-000000000001', '98d00009-0000-4000-8000-000000000002')) as nin_identifiers,
--          (select count(*) from identity.patients where phone_lookup_hmac is not null and id in
--             ('98d00009-0000-4000-8000-000000000001', '98d00009-0000-4000-8000-000000000002')) as phones,
--          (identity.has_active_membership('sealed-demo:98d00003-0000-4000-8000-000000000001',
--             '98d00005-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001')
--           and auth.membership_has_permission('sealed-demo:98d00003-0000-4000-8000-000000000001',
--             '98d00005-0000-4000-8000-000000000001', '98d00002-0000-4000-8000-000000000001',
--             'identity.registration.write')) as doctor_ok,
--          (select count(*) from audit.events where correlation_id = '0119-sealed-demo-profile') as audit;

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  -- a. Prerequisites (0001-0103).
  if to_regclass('identity.sealed_demo_members') is null
     or to_regprocedure('identity.sealed_demo_install()') is null
     or to_regprocedure('identity.sealed_demo_patient(uuid)') is null
     or to_regprocedure('identity.sealed_demo_account(uuid)') is null
     or to_regprocedure('identity.sealed_demo_facility(uuid)') is null
     or to_regprocedure('identity.patient_contact_changes_sealed_demo()') is null
     or to_regprocedure('identity.demo_story_context(text,uuid,uuid,text)') is null
     or to_regprocedure('identity.demo_story_install(text)') is null
     or to_regprocedure('identity.patient_self_session(text,uuid)') is null
     or to_regprocedure('identity.patient_self_profile(text,uuid)') is null
     or to_regprocedure('identity.patient_self_contact(text,uuid)') is null
     or to_regprocedure('identity.patient_self_nin_eligibility(text,uuid,character)') is null
     or to_regprocedure('identity.change_my_phone(text,uuid,uuid,character,character[],bytea,text,boolean)') is null
     or to_regprocedure('identity.validate_registration_case_write()') is null
     or to_regprocedure('identity.has_active_membership(text,uuid,uuid)') is null
     or to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or to_regclass('identity.patient_contact_changes') is null
     or to_regclass('identity.patient_identifiers') is null
     or to_regclass('identity.registration_cases') is null
     or to_regclass('identity.patient_profile_photos') is null
     or to_regclass('identity.patient_emergency_contacts') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('identity.staff') is null
     or to_regclass('audit.events') is null then
    raise exception using errcode = '55000', message = '0119: 0001-0103 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regprocedure('identity.demo_profile_phone_allowed(text,uuid,text,character)') is not null
     or to_regprocedure('identity.demo_profile_install()') is not null
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'identity' and proc.proname like 'demo\_profile\_%') then
    raise exception using errcode = '55000', message = '0119: already applied';
  end if;
  -- c. The body replaced (G5, as 0098 wrote it) and the bodies the new
  -- functions call or rely on, as 0001-0103 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.patient_contact_changes_sealed_demo()', 'e325df7f56e9438c114f105849fcd523'),
      ('identity.qoreid_quota_counters_sealed_demo()', 'c36f6bf340c57501397fa844045df5f8'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_demo_account(uuid)', '16eae1d6c33b3bef793796cf66f1cdf6'),
      ('identity.patient_self_session(text,uuid)', '378cd66a28347ef82a7faee8d2c65a15'),
      ('identity.patient_self_profile(text,uuid)', '2cabe696e87feb2ab4f97bf8d114aa0b'),
      ('identity.patient_self_contact(text,uuid)', '8c13fd4487498822274bd2e6daf6c7d4'),
      ('identity.patient_self_nin_eligibility(text,uuid,character)', '2d454e5cf6a0a8dd1305148b24ff446d'),
      ('identity.change_my_phone(text,uuid,uuid,character,character[],bytea,text,boolean)',
       'f6c1f43b077f95e60f8abe77846c38ee'),
      ('identity.validate_registration_case_write()', '5a7f6b2a0ba328acbdee00ef2a8f02cc'),
      ('identity.demo_story_context(text,uuid,uuid,text)', 'e305cd13f1ba5eb4ee82791203eee7ee'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa')) expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0119: 0001-0103 must be applied first',
      detail = 'Bodies that differ: ' || mismatch;
  end if;
  -- d. G5's trigger, and 0058's provenance CHECKs on identity.patient_identifiers.
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'identity.patient_contact_changes'::regclass
         and trigger_row.tgname = 'patient_contact_changes_sealed_demo' and trigger_row.tgenabled = 'O'
         and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER patient_contact_changes_sealed_demo BEFORE INSERT ON '
           || 'identity.patient_contact_changes FOR EACH ROW WHEN ((new.channel = ''phone''::text)) EXECUTE FUNCTION '
           || 'identity.patient_contact_changes_sealed_demo()') <> 1
     or (select count(*) from pg_constraint constraint_row
          where constraint_row.conrelid = 'identity.patient_identifiers'::regclass
            and (constraint_row.conname, pg_get_constraintdef(constraint_row.oid)) in (
              ('patient_identifiers_nin_verification_ck',
               'CHECK (((identifier_type <> ''nin''::text) OR (verified AND (verified_at IS NOT NULL) AND '
               || '(verification_provider IS NOT NULL) AND ((length(verification_provider) >= 1) AND '
               || '(length(verification_provider) <= 100)) AND (verification_reference IS NOT NULL) AND '
               || '((length(verification_reference) >= 1) AND (length(verification_reference) <= 255)) AND '
               || '(num_nonnulls(registration_case_id, public_enrollment_id, patient_self_evidence_id) = 1))))'),
              ('patient_identifiers_registration_case_ck',
               'CHECK ((((identifier_type = ''nin''::text) AND (num_nonnulls(registration_case_id, '
               || 'public_enrollment_id, patient_self_evidence_id) = 1)) OR ((identifier_type <> ''nin''::text) AND '
               || '(registration_case_id IS NULL) AND (public_enrollment_id IS NULL) AND '
               || '(patient_self_evidence_id IS NULL))))'))) <> 2 then
    raise exception using errcode = '55000', message = '0119: 0001-0103 must be applied first',
      detail = 'The G5 trigger or the identifier provenance checks differ';
  end if;
  -- e. The applier may replace G5 and write the seed's tables, and may create
  -- in schema identity.
  if not has_schema_privilege(current_user, 'identity', 'CREATE')
     or not pg_has_role(current_user, (select proc.proowner from pg_proc proc
                                        where proc.oid = 'identity.patient_contact_changes_sealed_demo()'::regprocedure),
                        'MEMBER')
     or exists (select 1 from pg_class relation
                 where relation.oid in ('identity.registration_cases'::regclass, 'identity.patient_identifiers'::regclass,
                                        'audit.events'::regclass)
                   and not pg_has_role(current_user, relation.relowner, 'MEMBER')) then
    raise exception using errcode = '42501',
      message = '0119: the applying role must create in schema identity and own G5 and the tables the seed writes';
  end if;
end
$$;

-- 1. The phone (D2).
-- Identity's check before a patient's phone change: true unless the live
-- session's patient is a demo patient and the number is not that patient's
-- own fictional one with a well-formed HMAC. When it is true for a demo
-- patient, "<patient id>:<HMAC>" is recorded in hid.sealed_demo_phone_hmac
-- for the rest of the transaction, and G5 admits that patient's phone change
-- only with that HMAC. It cannot verify that the HMAC is the number's, and
-- any session can set that setting itself: that a demo patient's number is
-- the fictional one rests on Identity, which computes the HMAC from the same
-- normalized number it checks and encrypts.
create function identity.demo_profile_phone_allowed(requested_subject text, requested_session uuid,
  requested_phone text, requested_lookup_hmac character(64))
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  demo_phone text;
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if not identity.sealed_demo_patient(patient_id_value) then
    return true;
  end if;
  -- Adaeze (Patient One) and Chinedu (Patient Two), UK drama range; the
  -- eight fictional patients have no number.
  demo_phone := case patient_id_value
                  when '98d00009-0000-4000-8000-000000000001' then '+447700900102'
                  when '98d00009-0000-4000-8000-000000000002' then '+447700900103' end;
  if demo_phone is not null and requested_phone is not distinct from demo_phone
     and coalesce(requested_lookup_hmac::text ~ '^[0-9a-f]{64}$', false) then
    perform set_config('hid.sealed_demo_phone_hmac', patient_id_value::text || ':' || requested_lookup_hmac::text, true);
    return true;
  end if;
  perform set_config('hid.sealed_demo_phone_hmac', '', true);
  return false;
end
$$;

-- G5 (0098), its body replaced: a demo patient's phone change only with the
-- number identity.demo_profile_phone_allowed admitted for that patient in
-- this transaction. CREATE OR REPLACE keeps the trigger, the owner and the
-- ACL.
create or replace function identity.patient_contact_changes_sealed_demo()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if identity.sealed_demo_patient(new.patient_id)
     and current_setting('hid.sealed_demo_phone_hmac', true)
         is distinct from new.patient_id::text || ':' || new.new_lookup_hmac::text then
    raise exception using errcode = '22023', message = 'PATIENT_CONTACT_CHANGE_INVALID';
  end if;
  return new;
end
$$;

-- 2. The NIN seed (D3-D8). Every read before any write; refusals raise 55000
-- with a message that names no person.
create function identity.demo_profile_install()
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  profile_correlation constant text := '0119-sealed-demo-profile';
  demo_provider constant text := 'hid-sealed-demo';
  staff_account constant uuid := '98d00003-0000-4000-8000-000000000001';
  staff_record constant uuid := '98d00004-0000-4000-8000-000000000001';
  staff_subject constant text := 'sealed-demo:98d00003-0000-4000-8000-000000000001';
  hospital constant uuid := '98d00002-0000-4000-8000-000000000001';
  doctor_membership constant uuid := '98d00005-0000-4000-8000-000000000001';
  -- patient, account, registration case, identifier
  targets constant jsonb := '[
    {"patient": "98d00009-0000-4000-8000-000000000001", "account": "98d00008-0000-4000-8000-000000000001",
     "case": "98d00119-0000-4000-8000-000000000001", "identifier": "98d00119-0000-4000-8000-000000000011"},
    {"patient": "98d00009-0000-4000-8000-000000000002", "account": "98d00008-0000-4000-8000-000000000002",
     "case": "98d00119-0000-4000-8000-000000000002", "identifier": "98d00119-0000-4000-8000-000000000012"}]';
  target record;
  patient_row identity.patients%rowtype;
  marker text;
  pseudo_hmac text;
  idempotency text;
  cases_written uuid[] := array[]::uuid[];
  identifiers_written uuid[] := array[]::uuid[];
  patients_written uuid[] := array[]::uuid[];
  audited bigint := 0;
  saved_settings text[] := array[current_setting('app.actor_subject', true), current_setting('app.membership_id', true),
    current_setting('app.facility_id', true), current_setting('app.correlation_id', true),
    current_setting('app.purpose_of_use', true), current_setting('app.patient_id', true),
    current_setting('app.session_id', true), current_setting('app.account_id', true),
    current_setting('app.change_reason', true)];
  setting_names constant text[] := array['app.actor_subject', 'app.membership_id', 'app.facility_id',
    'app.correlation_id', 'app.purpose_of_use', 'app.patient_id', 'app.session_id', 'app.account_id',
    'app.change_reason'];
  step integer;
begin
  -- One profile install at a time (0098's and 0102's lock family, a key of
  -- its own).
  perform pg_advisory_xact_lock(hashtextextended('hid-sealed-demo-profile-install', 0));

  -- 1. Every row touched is the sealed demo tenant's as 0098 left it (D7).
  if (select count(*) from identity.sealed_demo_members member
       where (member.member_kind = 'facility' and member.member_id = hospital)
          or (member.member_kind = 'account' and member.member_id in (select (t->>'account')::uuid
                                                                       from jsonb_array_elements(targets) t))
          or (member.member_kind = 'account' and member.member_id = staff_account)
          or (member.member_kind = 'patient' and member.member_id in (select (t->>'patient')::uuid
                                                                       from jsonb_array_elements(targets) t))) <> 6
     or not exists (select 1 from identity.staff_facility_memberships membership
                     where membership.id = doctor_membership and membership.account_id = staff_account
                       and membership.staff_id = staff_record and membership.facility_id = hospital)
     or not exists (select 1 from identity.staff staff_row
                     where staff_row.id = staff_record and staff_row.account_id = staff_account)
     or (select count(*) from identity.patients patient
          join jsonb_array_elements(targets) t on (t->>'patient')::uuid = patient.id
         where patient.account_id = (t->>'account')::uuid) <> 2 then
    raise exception using errcode = '55000', message = '0119: SEALED_DEMO_PROFILE_NOT_DEMO';
  end if;
  -- 2. The two patients and their logins are active.
  if (select count(*) from identity.patients patient
        join auth.accounts account on account.id = patient.account_id
        join jsonb_array_elements(targets) t on (t->>'patient')::uuid = patient.id
       where patient.status = 'active' and account.status = 'active') <> 2 then
    raise exception using errcode = '55000', message = '0119: SEALED_DEMO_PROFILE_PATIENT_NOT_READY';
  end if;
  -- 3. The doctor membership may write registration cases at Demo Hospital,
  -- and the staff record has a name.
  if not identity.has_active_membership(staff_subject, doctor_membership, hospital)
     or not auth.membership_has_permission(staff_subject, doctor_membership, hospital, 'identity.registration.write')
     or not exists (select 1 from identity.staff staff_row
                     where staff_row.id = staff_record and length(btrim(coalesce(staff_row.full_name, ''))) > 0) then
    raise exception using errcode = '55000', message = '0119: SEALED_DEMO_PROFILE_ROLE_MISSING';
  end if;

  -- The doctor membership's request context, as Identity sets it for a
  -- registration; restored at the end.
  perform identity.demo_story_context(staff_subject, doctor_membership, hospital, profile_correlation);

  -- 4. A fixed id held by a row this seed did not write.
  if exists (select 1 from identity.registration_cases registration
               join jsonb_array_elements(targets) t on (t->>'case')::uuid = registration.id
              where registration.verification_provider is distinct from demo_provider
                 or registration.resolved_patient_id is distinct from (t->>'patient')::uuid)
     or exists (select 1 from identity.patient_identifiers identifier
                  join jsonb_array_elements(targets) t on (t->>'identifier')::uuid = identifier.id
                 where identifier.source_system is distinct from demo_provider
                    or identifier.patient_id is distinct from (t->>'patient')::uuid)
     or exists (select 1 from identity.registration_cases registration
                  join jsonb_array_elements(targets) t on (t->>'case')::uuid = registration.id
                 where not exists (select 1 from identity.patient_identifiers identifier
                                    where identifier.patient_id = (t->>'patient')::uuid
                                      and identifier.identifier_type = 'nin')) then
    raise exception using errcode = '55000', message = '0119: SEALED_DEMO_PROFILE_ID_TAKEN';
  end if;

  -- 5. For each patient without a NIN identifier: the resolved case and the
  -- identifier (D3-D5).
  for target in select (t->>'patient')::uuid as patient_id, (t->>'case')::uuid as case_id,
                       (t->>'identifier')::uuid as identifier_id
                  from jsonb_array_elements(targets) t order by t->>'patient' loop
    select patient.* into patient_row from identity.patients patient where patient.id = target.patient_id for update;
    if exists (select 1 from identity.patient_identifiers identifier
                where identifier.patient_id = target.patient_id and identifier.identifier_type = 'nin') then
      continue;
    end if;
    marker := 'hid-sealed-demo:0119:no-nin-stored:' || target.patient_id::text;
    pseudo_hmac := encode(sha256(convert_to('hid-sealed-demo:0119:nin:' || target.patient_id::text, 'UTF8')), 'hex');
    idempotency := 'sealed-demo-0119-nin-' || target.patient_id::text;
    insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
      first_name, last_name, full_name, dob, gender, nin_ciphertext, nin_lookup_hmac, nin_last4, nin_key_version,
      verification_provider, verification_reference, verified_at, idempotency_key, request_sha256,
      resolved_patient_id)
    values (target.case_id, hospital, staff_account, doctor_membership, 'resolved_existing_identity',
      patient_row.first_name, patient_row.last_name, patient_row.full_name, patient_row.dob, patient_row.gender,
      convert_to(marker, 'UTF8'), pseudo_hmac, '0000', demo_provider, demo_provider, profile_correlation,
      clock_timestamp(), idempotency, encode(sha256(convert_to(idempotency, 'UTF8')), 'hex'), target.patient_id);
    insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
      encryption_key_version, display_hint, verified, source_system, registration_case_id, verified_at,
      verification_provider, verification_reference)
    values (target.identifier_id, target.patient_id, 'nin', convert_to(marker, 'UTF8'), pseudo_hmac, demo_provider,
      '****0000', true, demo_provider, target.case_id, clock_timestamp(), demo_provider, profile_correlation);
    cases_written := cases_written || target.case_id;
    identifiers_written := identifiers_written || target.identifier_id;
    patients_written := patients_written || target.patient_id;
  end loop;

  -- 6. The audit (D8): one migration row per row written, and the summary.
  if cardinality(patients_written) > 0 then
    insert into audit.events (correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type,
      resource_id, provenance, source_system, details)
    select profile_correlation, 'system', hospital, written.patient_id, 'identity.sealed-demo.seed-record', 'success',
           written.resource_type, written.resource_id::text, 'migration', demo_provider, '{}'::jsonb
      from (select patient_id, 'registration-case' as resource_type, case_id as resource_id
              from unnest(patients_written, cases_written) as pairs(patient_id, case_id)
            union all
            select patient_id, 'patient-identifier', identifier_id
              from unnest(patients_written, identifiers_written) as pairs(patient_id, identifier_id)) written;
    get diagnostics audited = row_count;
    insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, provenance, source_system,
      details)
    values (profile_correlation, 'system', 'identity.sealed-demo.seed-profile', 'success', 'sealed-demo-tenant',
      'migration', demo_provider, jsonb_build_object('rowsAudited', audited,
        'registrationCases', cardinality(cases_written), 'ninIdentifiers', cardinality(identifiers_written)));
  end if;

  for step in 1..array_length(setting_names, 1) loop
    perform set_config(setting_names[step], coalesce(saved_settings[step], ''), true);
  end loop;

  return jsonb_build_object('registrationCases', cardinality(cases_written),
    'ninIdentifiers', cardinality(identifiers_written), 'audited', audited);
end
$$;

-- 3. Grants (here and in runtime-grants.sql): the phone check to the Identity
-- runtime and the schema test runtime; the seed to no role.
revoke all on function identity.demo_profile_phone_allowed(text,uuid,text,character),
  identity.demo_profile_install() from public;
do $$
declare grantee text;
begin
  foreach grantee in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant execute on function identity.demo_profile_phone_allowed(text,uuid,text,character) to %I',
        grantee);
    end if;
  end loop;
end
$$;

-- 4. Post-checks.
do $$
declare
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  if (select count(*) from pg_proc proc
       where proc.oid in ('identity.demo_profile_phone_allowed(text,uuid,text,character)'::regprocedure,
                          'identity.demo_profile_install()'::regprocedure)
         and proc.proowner = applier and proc.prosecdef and proc.provolatile = 'v'
         and proc.prolang = (select oid from pg_language where lanname = 'plpgsql')
         and proc.proconfig = array['search_path=pg_catalog, pg_temp']
         and not exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                          where acl.grantee <> proc.proowner
                            and (proc.proname = 'demo_profile_install'
                                 or acl.grantee not in (select oid from pg_roles
                                                         where rolname in ('hid_identity_runtime',
                                                                           'hid_schema_test_runtime'))))) <> 2
     or exists (select 1 from pg_roles role_row
                 where role_row.rolname in ('hid_identity_runtime', 'hid_schema_test_runtime')
                   and not has_function_privilege(role_row.oid,
                         'identity.demo_profile_phone_allowed(text,uuid,text,character)', 'EXECUTE')) then
    raise exception using errcode = '55000', message = '0119: the new functions are not as this file made them';
  end if;
  -- G5: as 0098 made it but for its body; its trigger unchanged; the nine
  -- sealed demo triggers enabled.
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'identity.patient_contact_changes_sealed_demo()'::regprocedure
                    and proc.prosecdef and proc.provolatile = 'v'
                    and proc.prorettype = 'trigger'::regtype
                    and proc.proconfig = array['search_path=pg_catalog, pg_temp']
                    and not exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                                     where acl.grantee <> proc.proowner))
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = 'identity.patient_contact_changes'::regclass
            and trigger_row.tgname = 'patient_contact_changes_sealed_demo' and trigger_row.tgenabled = 'O'
            and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER patient_contact_changes_sealed_demo BEFORE INSERT ON '
              || 'identity.patient_contact_changes FOR EACH ROW WHEN ((new.channel = ''phone''::text)) EXECUTE FUNCTION '
              || 'identity.patient_contact_changes_sealed_demo()') <> 1
     or (select count(*) from pg_trigger trigger_row where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
          and trigger_row.tgname in ('sealed_demo_members_immutable', 'sealed_demo_members_no_truncate',
            'consent_grants_sealed_demo', 'staff_memberships_sealed_demo', 'account_roles_sealed_demo',
            'patient_share_invitations_sealed_demo', 'patient_contact_changes_sealed_demo',
            'qoreid_quota_counters_sealed_demo', 'patient_emergency_contacts_sealed_demo')) <> 9 then
    raise exception using errcode = '55000', message = '0119: the seal is not as 0098 and this file made it';
  end if;
end
$$;

-- 5. Comments.
comment on function identity.demo_profile_phone_allowed(text,uuid,text,character) is
  '0119: Identity''s check before a patient''s phone change: true unless the live session''s patient is a sealed demo patient and the number is not that patient''s own fictional one (Patient One +447700900102, Patient Two +447700900103, the UK drama range) with a well-formed HMAC (64 lowercase hex characters) (42501 without a live patient session). True for a demo patient records "<patient id>:<HMAC>" in hid.sealed_demo_phone_hmac for the transaction, which G5 requires of a demo patient''s phone change. It cannot verify that the HMAC is the given number''s, and any session can set that setting itself: that the number is the fictional one rests on Identity (PatientContactChangeService.changePhone computes the HMAC from the same normalized number it checks and encrypts).';
comment on function identity.patient_contact_changes_sealed_demo() is
  '0098 G5, body replaced by 0119: a demo patient''s phone change is refused (22023 PATIENT_CONTACT_CHANGE_INVALID) unless identity.demo_profile_phone_allowed admitted that patient''s fictional number with this change''s HMAC in the same transaction (an Identity image that never asks it adds no demo phone; the eight demo patients without a login have no number). No SMS is ever due for a demo patient.';
comment on function identity.demo_profile_install() is
  '0119: gives Adaeze Okafor and Chinedu Okafor (sealed demo Patient One and Two) a verified NIN item without any NIN: for each without a NIN identifier, a resolved registration case at Demo Hospital written as the demo doctor membership and a nin identifier naming it, provider and source hid-sealed-demo, a lookup value that is not an HMAC under Identity''s key, a plain-text marker in place of ciphertext, hint ****0000; assurance stays CONTACT_VERIFIED, no QoreID evidence, quota or authoritative profile. Demo rows only (55000 otherwise); one migration audit row per row written (actor system, provenance migration, hid-sealed-demo, 0119-sealed-demo-profile) and a summary. A second call writes nothing.';

-- 6. The seed, on Amazon RDS only (D6). A refusal raises 55000 and the
-- release stops with nothing applied.
do $$
declare summary jsonb;
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'rds_superuser') then
    summary := identity.demo_profile_install();
    raise notice '0119: sealed demo profiles seeded: %', summary::text;
  else
    raise notice '0119: not an Amazon RDS database; the sealed demo profiles are not seeded (the functions are)';
  end if;
end
$$;
