-- 0160 APPT-1 Appointments: bookings, clinics and check-in to the waiting list
-- (Release D, the department sprint the owner approved on 25 November 2026).
-- Written on staging-novu-ci-20261005 at 95fa1e52 (0001-0151) and merged
-- with Release E (0cfddcc9, 0001-0153, live). The number is provisional:
-- numbers are given at integration, in release order (#258). This file reads
-- nothing 0152-0154 create or change, so it applies on 0001-0151 and on
-- 0001-0154 alike. Release D's lanes go in order of readiness (coordinator,
-- #258, 25 November): this file accepts what Billing (0162-0167) and
-- Emergency (0168-0169) add to the shared role table and to the waiting-list
-- basis CHECK, so it applies before or after either of them (step 1 below).
-- The declaration in config/production-schema-compatibility.json stays
-- unsigned until the owner signs this file.
--
-- Decisions taken at the recommended option, not yet answered by the owner
-- (docs/EHR_PLANNED_CONTRACT.md, APPT-1): Q-APPT-1 A (check-in from an
-- appointment opens the waiting-list row in the same transaction), Q-APPT-2 A
-- (timed bookings with a server clash check; the clinician is optional),
-- Q-APPT-4 A (staff book; the portal is read only), Q-APPT-5 A (the design's
-- grants mapped onto the backend roles, table below), Q-APPT-6 A (the
-- challenger correction of 25 November: a booking is a check-in-only basis on
-- the appointment's own day, never an own-facility basis; a fresh search is
-- always accepted too).
--
-- Q-APPT-6, why check-in does not need a 10-minute search. 0135's
-- ehr.visit_queue_check_in takes only a matchRef from this member's own search
-- in the last 10 minutes (0132) or a patient who is already this facility's
-- own (0131). A patient booked days ahead from a search, and not yet this
-- facility's own, could not be checked in from the appointment. This file does
-- not make the booking an own-facility basis (0131 is unchanged; no booking
-- and no check-in ever opens the chart without a PIN, an approval or 0131).
-- Instead the booking stores how the patient was found (booking_basis: search
-- or own_facility) and the facility that booked them, and the appointment
-- itself is a narrow basis for one check-in only:
--   1. at the facility that booked it, by a member who holds
--      ehr.appointment.write and 0135's pair ehr.encounter.read and
--      ehr.encounter.write;
--   2. on the appointment's own Lagos day, while it is booked (or marked no
--      show that same day; the no-show is undone and recorded);
--   3. the patient is still active and not merged, and the facility's seal
--      still allows them (as 0135);
--   4. the desk confirms the patient's name and date of birth with them
--      (identityConfirmed: true, the same human check as after a search);
--   5. the waiting-list row gets check_in_basis 'appointment' and shows only
--      what the appointment list already shows the same staff;
--   6. the handle is the appointment id, never a bare patient id: an
--      appointment exists only because a member found the patient by a search
--      or as this facility's own.
-- With a matchRef the check-in goes through 0135's own function (basis
-- search) after the ref is checked to name the appointment's patient. If
-- Rahman or the DPO choose option B, the one change is that check-in without a
-- matchRef is refused unless the patient is this facility's own.
--
-- What it changes (nothing else):
-- A1 ehr.appointment_settings  one row per facility: default length (5-240
--                              minutes in steps of 5, 30 when there is no row).
-- A2 ehr.appointment_clinics   this facility's clinics: name (2-80, unique per
--                              facility ignoring case), department code (a 0114
--                              code), optional default length, active. Never
--                              deleted; making one inactive keeps its bookings.
-- A3 ehr.appointments          one row per booking: facility and organisation,
--                              patient, department, optional clinic and
--                              clinician, start, length, end and Lagos day,
--                              visit type, an optional short reason (0-200,
--                              not a diagnosis), status (booked, checked_in,
--                              cancelled, no_show), the booking basis, the
--                              waiting-list row (exactly when checked in), who
--                              booked and when, who changed the status and
--                              when, when the reminder went (0161), row version.
-- A4 ehr.appointment_events    one row per booking, change or check-in, with
--                              the Idempotency-Key and the request's SHA-256
--                              (unique per membership and key). A trigger
--                              refuses any update or delete.
--    All four have row-level security enabled and no policy or privilege for
--    any runtime role: only the functions below read or write them, as their
--    owner (0135's rule).
-- A5 auth.permissions          ehr.appointment.read and ehr.appointment.write.
--    auth.role_permissions     seven rows (Q-APPT-5 A): receptionist, doctor
--                              and clinician read and write; nurse read. Admin
--                              and org_admin keep organization.manage for the
--                              clinic list and the default length only.
--    audit.events              one row per role row added, as the system actor
--                              (auth.role-permission.add).
-- A6 ehr.visit_queue           the check_in_basis CHECK becomes ('search',
--                              'own_facility', 'appointment'), followed by any
--                              value another lane added before this file (after
--                              0168: 'emergency', the same CHECK 0168 leaves
--                              when it runs after this file). Nothing else in
--                              0135 changes; its functions read the basis as text.
-- A7 SECURITY DEFINER functions (search_path pg_catalog, pg_temp), owned like
--    0135's (the owner of identity.has_active_consent_grant), EXECUTE for
--    hid_ehr_runtime only: ehr.appointment_book, _list, _read, _patient_list,
--    _reschedule, _cancel, _mark_no_show, _check_in, _bookable_staff,
--    _clinic_list, _clinic_save, _settings_read, _settings_save. Helpers no
--    role may execute: ehr.appointment_cards, ehr.appointment_caller,
--    ehr.appointment_audit, ehr.appointment_idempotency,
--    ehr.appointment_events_immutable.
--    Each function checks the caller: an active membership at the session
--    facility, the code, direct care. A sealed demo or QA facility books and
--    sees only its own sealed patients, as 0135.
-- A8 Audit, in the request's transaction, refusals included (as 0135):
--    ehr.appointment.book, .read, .list (+ .list.shown per appointment),
--    .patient-list (+ .patient-list.shown), .reschedule, .cancel, .no-show,
--    .check-in (plus 0135's ehr.visit-queue.check-in), .clinic.save,
--    .settings.save. Rows hold ids, the outcome or refusal and the basis; never
--    a name, date of birth, Health ID, phone, reason text or clinic name.
--
-- Locks (measured with pg_locks before commit and compared by the suite),
-- taken first, NOWAIT: SHARE ROW EXCLUSIVE on identity.patients,
-- identity.facilities and identity.staff_facility_memberships (the foreign
-- keys of the new, empty tables) and on auth.role_permissions (the role table
-- cannot change between the preconditions and the post-checks); ACCESS
-- EXCLUSIVE on ehr.visit_queue (the CHECK swap and the new tables' foreign key;
-- the table is small, so the hold is milliseconds); ROW EXCLUSIVE on
-- auth.permissions and audit.events; ROW SHARE on auth.roles, auth.accounts and
-- identity.organizations (the new rows' and audit rows' foreign key checks);
-- ACCESS SHARE on identity.consent_directives,
-- identity.consent_directive_versions and identity.facility_profiles (read by
-- the functions; the preconditions read the catalog), auth.account_roles
-- (read by the closing count of the staff who gain each code) and
-- identity.sealed_demo_members and identity.sealed_qa_members (read by the
-- closing count, through identity.sealed_demo_facility and
-- identity.sealed_qa_facility, as soon as a membership reaches it, as on
-- production; taken up front like 0136, 0147 and 0151 take them, so they are
-- never locked late while the strong locks above are held). A busy table fails the
-- attempt at once, and its subtransaction releases what it took. The attempt
-- is made 50 times, 100 ms apart (about 5 seconds), so the file never waits for
-- one of its locks while holding the others; then 55P03 (nothing applied).
-- When this transaction already holds an earlier migration's locks that stop
-- other sessions' reads or writes (the runner's dry run applies every pending
-- file in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied. Both refusals begin "0160: " and end "run the release again at a
-- quieter time", so the runner's dry run rolls back and tries again (#306).
--
-- Old images on this schema: nothing calls the new functions. Today's ehr-api
-- maps any waiting-list basis other than own_facility to "search"
-- (visit-queue.service.ts), so an appointment check-in shows as "search" until
-- the new image ships; no access depends on it.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- functions and the four tables, take the seven role rows and the two codes
-- out, and take 'appointment' out of the CHECK (keeping every other value)
-- once no waiting-list row has basis 'appointment'.
--
-- The whole file is one statement (do $appt0160$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): markers of 0145, 0149 and 0150;
--    "0160: already applied" when every object of this file is there with the
--    role rows it adds, "0160: the schema is not in the reviewed state" for
--    any half state; the bodies this file calls or reads md5-pinned; every
--    code 0001-0151 give receptionist, doctor, clinician and nurse still held
--    (the four lists are written out; each one's md5 is the one this file
--    pinned before; codes another lane added are accepted) and no appointment
--    code yet; the waiting-list basis CHECK as 0135 left it, or with plain
--    values another lane added after 'search' and 'own_facility'.
-- 2. A1-A8.
-- 3. Post-checks: the four roles hold exactly their pinned codes plus this
--    file's; every other role row is unchanged; the CHECK is the new one; the
--    tables have row-level security and no privilege; the functions are
--    SECURITY DEFINER with the fixed search_path and EXECUTE only for
--    hid_ehr_runtime; exactly seven audit rows of this file.

do $appt0160$
declare
  v_attempt integer := 0;
  v_holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  v_mismatch text;
  v_reason constant text := 'APPT-1 Appointments (Release D, recommended Q-APPT-5 A)';
  v_correlation constant text := '0160-appointments-appt1';
  -- The waiting-list basis CHECK as found, its values in order, and the definition this file leaves.
  v_check_found text;
  v_basis_found text[];
  v_check_after text;
  v_rows_before text;
  v_owner name;
  v_audited integer;
  v_present integer;
  v_read_gain integer;
  v_write_gain integer;
begin
  -- 0. The locks, NOWAIT.
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table identity.patients, identity.facilities, identity.staff_facility_memberships, auth.role_permissions
    in share row exclusive mode nowait;
  lock table ehr.visit_queue in access exclusive mode nowait;
  lock table auth.permissions, audit.events in row exclusive mode nowait;
  lock table auth.roles, auth.accounts, identity.organizations in row share mode nowait;
  lock table identity.consent_directives, identity.consent_directive_versions, identity.facility_profiles,
    auth.account_roles, identity.sealed_demo_members, identity.sealed_qa_members in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0160: identity.patients, identity.facilities, identity.staff_facility_memberships, '
          || 'auth.role_permissions, ehr.visit_queue or a table 0160 reads or writes (the permissions, roles, '
          || 'accounts, organizations, consent directives, facility profiles, role assignments, sealed demo and QA '
          || 'members and audit.events) is busy, and this '
          || 'transaction already holds an earlier migration''s locks, so it does not wait; nothing applied; run '
          || 'the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0160: identity.patients, identity.facilities, identity.staff_facility_memberships, '
          || 'auth.role_permissions, ehr.visit_queue or a table 0160 reads or writes (the permissions, roles, '
          || 'accounts, organizations, consent directives, facility profiles, role assignments, sealed demo and QA '
          || 'members and audit.events) stayed busy for 5 '
          || 'seconds; nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if to_regprocedure('ehr.visit_queue_record_kinds(uuid[])') is null
     or to_regclass('ehr.catalog_versions') is null
     or not exists (select 1 from auth.role_permissions where role_code = 'doctor' and permission_code = 'ocr.job.start')
     or to_regclass('migration.schema_migrations') is null then
    raise exception using errcode = '55000', message = '0160: 0001-0151 must be applied first';
  end if;

  select count(*) into v_present
    from (values (to_regclass('ehr.appointment_settings')::oid), (to_regclass('ehr.appointment_clinics')::oid),
                 (to_regclass('ehr.appointments')::oid), (to_regclass('ehr.appointment_events')::oid),
                 (to_regprocedure('ehr.appointment_cards(uuid[], uuid, uuid, uuid)')::oid),
                 (to_regprocedure('ehr.appointment_book(text, uuid, text, uuid, uuid, timestamptz, integer, text, text, text, text)')::oid),
                 (to_regprocedure('ehr.appointment_check_in(uuid, bigint, boolean, text, text, text)')::oid),
                 ((select 1::oid where exists (select 1 from auth.permissions where code = 'ehr.appointment.read'))),
                 ((select 1::oid where exists (select 1 from auth.permissions where code = 'ehr.appointment.write'))))
         present(object_id)
   where present.object_id is not null;
  if v_present = 9
     and exists (select 1 from pg_constraint where conrelid = 'ehr.visit_queue'::regclass
                  and conname = 'visit_queue_check_in_basis_check'
                  and pg_get_constraintdef(oid) like '%appointment%')
     and (select count(*) from auth.role_permissions
           where permission_code in ('ehr.appointment.read', 'ehr.appointment.write')) = 7 then
    raise exception using errcode = '55000', message = '0160: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr' and proc.proname like 'appointment%')
     or exists (select 1 from auth.role_permissions where permission_code like 'ehr.appointment.%') then
    raise exception using errcode = '55000', message = '0160: the schema is not in the reviewed state (part of 0160 is there); nothing applied';
  end if;

  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.resolve_patient_search_ref(text,text)', '9a80a8997571565f0e99c96f1cba4697'),
      ('identity.own_facility_basis(uuid,uuid)', '16ec336ac3633a295bc4a89f0e9f7542'),
      ('identity.facility_departments_valid(text[])', '8c52c07209052d3045736fa26eb6ac52'),
      ('ehr.visit_queue_check_in(text,uuid)', '298bbe24dc23835a1969951b453ec061'),
      ('ehr.visit_queue_cards(uuid[],uuid,uuid,uuid)', '50b1288379241e45128d95ddec5419e5')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0160: these bodies are not as 0001-0151 left them: ' || v_mismatch;
  end if;
  if to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('platform.current_membership_id()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('platform.current_correlation_id()') is null
     or to_regprocedure('platform.current_purpose_of_use()') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null
     or to_regprocedure('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)') is null then
    raise exception using errcode = '55000', message = '0160: a function this file calls is missing';
  end if;
  select string_agg(code, ', ' order by code) into v_mismatch
    from (values ('receptionist'), ('doctor'), ('clinician'), ('nurse')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0160: role missing or inactive: ' || v_mismatch;
  end if;
  select string_agg(code, ', ' order by code) into v_mismatch
    from (values ('ehr.encounter.read'), ('ehr.encounter.write'), ('ehr.note.write'), ('organization.manage')) wanted(code)
   where not exists (select 1 from auth.permissions permission_row
                      where permission_row.code = wanted.code and permission_row.active);
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0160: permission missing or inactive: ' || v_mismatch;
  end if;
  -- The codes 0001-0151 give each of the four roles, in byte order. Each list's md5 joined by ',' (0150's form) is
  -- the md5 this file pinned before the coordinator's decision of 25 November (#258): every code must still be
  -- held, and codes another Release D lane adds (Billing's 0162) are accepted. No appointment code may be there yet
  -- (the half-state test above).
  select string_agg(wanted.role_code, ', ' order by wanted.role_code) into v_mismatch
    from (values
      ('receptionist', 'a06d876a6f2e1bbd524ed89e59acd110',
        array['ehr.document.read-own', 'ehr.document.write', 'ehr.encounter.read', 'ehr.encounter.write',
          'ehr.vital.read', 'identity.authorization.check', 'identity.consent.read', 'identity.consent.write',
          'identity.patient.read', 'identity.registration.write', 'ocr.job.read-own', 'ocr.job.start', 'ocr.job.write',
          'outreach.campaign.read', 'outreach.campaign.write', 'outreach.registration.read',
          'outreach.registration.write']),
      ('doctor', '9da3f7c9be69ae834e9f7a7555eb3e07',
        array['ehr.diagnosis.read', 'ehr.diagnosis.write', 'ehr.document.read', 'ehr.document.write',
          'ehr.encounter.read', 'ehr.encounter.write', 'ehr.lab-request.read', 'ehr.lab-request.write', 'ehr.note.read',
          'ehr.note.write', 'ehr.order-route.send', 'ehr.prescription.read', 'ehr.prescription.write', 'ehr.vital.read',
          'ehr.vital.write', 'identity.authorization.check', 'identity.break-glass.write', 'identity.consent.read',
          'identity.consent.write', 'identity.patient-access-pin.verify', 'identity.patient.open-own-facility',
          'identity.patient.read', 'identity.registration.write', 'lab.import.read', 'lab.import.write',
          'lab.result.released.read', 'lab.work-item.accept', 'ocr.job.read', 'ocr.job.start', 'ocr.job.write',
          'ocr.patient.confirm', 'ocr.publication.write', 'ocr.validation.write', 'pharmacy.dispensing.read',
          'pharmacy.import.read', 'pharmacy.import.write']),
      ('clinician', 'b42ca0335673e504cb40113a8e33ca55',
        array['ehr.diagnosis.read', 'ehr.diagnosis.write', 'ehr.document.read', 'ehr.document.write',
          'ehr.encounter.read', 'ehr.encounter.write', 'ehr.lab-request.read', 'ehr.lab-request.write', 'ehr.note.read',
          'ehr.note.write', 'ehr.order-route.send', 'ehr.prescription.read', 'ehr.prescription.write', 'ehr.vital.read',
          'ehr.vital.write', 'identity.authorization.check', 'identity.break-glass.write', 'identity.consent.read',
          'identity.consent.write', 'identity.patient-access-pin.verify', 'identity.patient.open-own-facility',
          'identity.patient.read', 'identity.registration.write', 'lab.import.read', 'lab.import.write',
          'lab.result.released.read', 'lab.work-item.accept', 'lab.work-item.read', 'ocr.job.read', 'ocr.job.start',
          'ocr.job.write', 'ocr.patient.confirm', 'ocr.publication.write', 'ocr.validation.write',
          'outreach.campaign.read', 'outreach.campaign.write', 'outreach.registration.read',
          'outreach.registration.write', 'pharmacy.dispensing.read', 'pharmacy.import.read', 'pharmacy.import.write',
          'pharmacy.work-item.read']),
      ('nurse', '1cf6eca65a5ea51b817db099e32a0ef2',
        array['ehr.diagnosis.read', 'ehr.document.read', 'ehr.document.write', 'ehr.encounter.read',
          'ehr.encounter.write', 'ehr.lab-request.read', 'ehr.note.read', 'ehr.note.write', 'ehr.prescription.read',
          'ehr.vital.read', 'ehr.vital.write', 'identity.authorization.check', 'identity.break-glass.write',
          'identity.consent.read', 'identity.consent.write', 'identity.patient-access-pin.verify',
          'identity.patient.open-own-facility', 'identity.patient.read', 'identity.registration.write',
          'lab.import.read', 'lab.import.write', 'lab.result.released.read', 'lab.work-item.accept',
          'lab.work-item.read', 'ocr.job.read', 'ocr.job.start', 'ocr.job.write', 'ocr.patient.confirm',
          'ocr.publication.write', 'ocr.validation.write', 'outreach.campaign.read', 'outreach.campaign.write',
          'outreach.registration.read', 'outreach.registration.write', 'pharmacy.dispensing.read',
          'pharmacy.import.read', 'pharmacy.import.write', 'pharmacy.work-item.read'])
    ) wanted(role_code, codes_md5, codes)
   where md5(array_to_string(wanted.codes, ',')) is distinct from wanted.codes_md5
      or not (wanted.codes <@ coalesce((select array_agg(grant_row.permission_code) from auth.role_permissions grant_row
                                         where grant_row.role_code = wanted.role_code), array[]::text[]));
  if v_mismatch is not null then
    raise exception using errcode = '55000',
      message = '0160: the role table is not in the reviewed state (' || v_mismatch || ' lacks a code 0001-0151 give '
        || 'it); nothing applied';
  end if;
  -- The waiting-list basis CHECK: 0135's two values first, then only plain values another Release D lane added
  -- (Emergency's 0168 adds 'emergency'), never 'appointment' (as 0168 accepts this file's CHECK). The definition
  -- must be exactly the IN list of those values, so no other condition and no NOT VALID.
  select pg_get_constraintdef(constraint_row.oid) into v_check_found from pg_constraint constraint_row
   where constraint_row.conrelid = 'ehr.visit_queue'::regclass
     and constraint_row.conname = 'visit_queue_check_in_basis_check' and constraint_row.contype = 'c';
  select array_agg(found.value[1] order by found.position) into v_basis_found
    from regexp_matches(coalesce(v_check_found, ''), '''([a-z][a-z0-9_]{0,39})''::text', 'g')
         with ordinality as found(value, position);
  if v_check_found is null or v_basis_found is null
     or v_check_found is distinct from format('CHECK ((check_in_basis = ANY (ARRAY[%s])))',
          (select string_agg(quote_literal(basis.value) || '::text', ', ' order by basis.position)
             from unnest(v_basis_found) with ordinality as basis(value, position)))
     or v_basis_found[1:2] is distinct from array['search', 'own_facility']
     or 'appointment' = any (v_basis_found)
     or cardinality(v_basis_found) <> (select count(distinct basis.value) from unnest(v_basis_found) basis(value)) then
    raise exception using errcode = '55000',
      message = '0160: the waiting-list basis CHECK is not as 0135 left it (search and own_facility, then only '
        || 'values another lane added); nothing applied';
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into v_rows_before from auth.role_permissions grant_row;

  -- A1. The default length.
  create table ehr.appointment_settings (
    facility_id uuid primary key references identity.facilities(id) on delete restrict,
    default_length_minutes integer not null default 30
      check (default_length_minutes between 5 and 240 and default_length_minutes % 5 = 0),
    row_version bigint not null default 1 check (row_version > 0),
    last_idempotency_key text check (last_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    last_request_sha256 char(64) check (last_request_sha256 ~ '^[0-9a-f]{64}$'),
    updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_at timestamptz not null default clock_timestamp()
  );
  alter table ehr.appointment_settings enable row level security;
  revoke all on ehr.appointment_settings from public;
  comment on table ehr.appointment_settings is
    '0160 (APPT-1): one row per facility, the default appointment length (30 minutes when there is no row). Only the appointment functions read and write it, as its owner.';

  -- A2. Clinics.
  create table ehr.appointment_clinics (
    id uuid primary key default gen_random_uuid(),
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    name text not null check (name = btrim(name) and length(name) between 2 and 80 and name !~ '[[:cntrl:]]'),
    department_code text not null check (identity.facility_departments_valid(array[department_code])),
    default_length_minutes integer
      check (default_length_minutes is null or (default_length_minutes between 5 and 240 and default_length_minutes % 5 = 0)),
    active boolean not null default true,
    row_version bigint not null default 1 check (row_version > 0),
    created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    created_at timestamptz not null default clock_timestamp(),
    updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_at timestamptz not null default clock_timestamp(),
    last_idempotency_key text not null check (last_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    last_request_sha256 char(64) not null check (last_request_sha256 ~ '^[0-9a-f]{64}$')
  );
  create unique index appointment_clinics_name_ux on ehr.appointment_clinics (facility_id, lower(name));
  create index appointment_clinics_key_idx on ehr.appointment_clinics (updated_by_membership_id, last_idempotency_key);
  create index appointment_clinics_created_by_idx on ehr.appointment_clinics (created_by_membership_id);
  alter table ehr.appointment_clinics enable row level security;
  revoke all on ehr.appointment_clinics from public;
  comment on table ehr.appointment_clinics is
    '0160 (APPT-1): this facility''s appointment clinics (name, department, optional default length, active). Never deleted. Only the appointment functions read and write it, as its owner.';

  -- A3. Appointments.
  create table ehr.appointments (
    id uuid primary key default gen_random_uuid(),
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    organization_id uuid not null,
    patient_id uuid not null references identity.patients(id) on delete restrict,
    department_code text not null check (identity.facility_departments_valid(array[department_code])),
    clinic_id uuid references ehr.appointment_clinics(id) on delete restrict,
    clinician_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    starts_at timestamptz not null check ((extract(epoch from starts_at) * 1000000)::bigint % 300000000 = 0),
    length_minutes integer not null check (length_minutes between 5 and 240 and length_minutes % 5 = 0),
    ends_at timestamptz not null,
    appointment_day date not null,
    visit_type text not null
      check (visit_type in ('new_visit', 'follow_up', 'results_review', 'antenatal', 'procedure', 'other')),
    reason text check (reason is null or (reason = btrim(reason) and length(reason) between 1 and 200
                                          and reason !~ '[[:cntrl:]]')),
    status text not null default 'booked' check (status in ('booked', 'checked_in', 'cancelled', 'no_show')),
    booking_basis text not null check (booking_basis in ('search', 'own_facility')),
    visit_queue_entry_id uuid references ehr.visit_queue(id) on delete restrict,
    booked_by_account_id uuid not null,
    booked_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    booked_at timestamptz not null default clock_timestamp(),
    status_changed_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    status_changed_at timestamptz not null default clock_timestamp(),
    updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_at timestamptz not null default clock_timestamp(),
    reminder_sent_at timestamptz,
    row_version bigint not null default 1 check (row_version > 0),
    constraint appointments_facility_organization_fk foreign key (facility_id, organization_id)
      references identity.facilities(id, organization_id) on delete restrict,
    constraint appointments_end_ck check (ends_at = starts_at + make_interval(mins => length_minutes)),
    constraint appointments_day_ck check (appointment_day = (starts_at at time zone 'Africa/Lagos')::date),
    constraint appointments_checked_in_ck check ((status = 'checked_in') = (visit_queue_entry_id is not null))
  );
  create index appointments_day_idx on ehr.appointments (facility_id, appointment_day, starts_at);
  create index appointments_clinician_idx on ehr.appointments (facility_id, clinician_membership_id, starts_at)
    where status in ('booked', 'checked_in') and clinician_membership_id is not null;
  create index appointments_patient_idx on ehr.appointments (patient_id, starts_at);
  create index appointments_facility_patient_booked_idx on ehr.appointments (facility_id, patient_id)
    where status = 'booked';
  create index appointments_reminder_idx on ehr.appointments (starts_at)
    where status = 'booked' and reminder_sent_at is null;
  create index appointments_clinic_idx on ehr.appointments (clinic_id) where clinic_id is not null;
  create index appointments_visit_queue_idx on ehr.appointments (visit_queue_entry_id) where visit_queue_entry_id is not null;
  create index appointments_booked_by_idx on ehr.appointments (booked_by_membership_id);
  alter table ehr.appointments enable row level security;
  revoke all on ehr.appointments from public;
  comment on table ehr.appointments is
    '0160 (APPT-1): one row per booking. No clinical content beyond an optional short booking reason (not a diagnosis). Cancelled ones are kept. Only the appointment functions read and write it, as its owner. A booking is never an own-facility basis (0131): it is a basis for one check-in on its own day only (Q-APPT-6 A).';

  -- A4. History.
  create table ehr.appointment_events (
    id uuid primary key default gen_random_uuid(),
    sequence_no bigint generated always as identity,
    appointment_id uuid not null references ehr.appointments(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    patient_id uuid not null references identity.patients(id) on delete restrict,
    kind text not null
      check (kind in ('booked', 'rescheduled', 'cancelled', 'no_show', 'no_show_undone', 'checked_in')),
    at timestamptz not null default clock_timestamp(),
    by_account_id uuid not null,
    by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    from_starts_at timestamptz,
    to_starts_at timestamptz,
    from_clinician_membership_id uuid,
    to_clinician_membership_id uuid,
    reason text,
    basis text check (basis is null or basis in ('search', 'own_facility', 'appointment')),
    outcome text check (outcome is null or outcome in ('checked_in', 'already_on_list')),
    visit_queue_entry_id uuid references ehr.visit_queue(id) on delete restrict,
    idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) check (request_sha256 ~ '^[0-9a-f]{64}$'),
    constraint appointment_events_reason_ck check (
      (kind in ('rescheduled', 'cancelled')) = (reason is not null)
      and (reason is null or (reason = btrim(reason) and length(reason) between 8 and 500))),
    constraint appointment_events_key_ck check ((idempotency_key is null) = (request_sha256 is null))
  );
  create unique index appointment_events_key_ux on ehr.appointment_events (by_membership_id, idempotency_key)
    where idempotency_key is not null;
  create index appointment_events_appointment_idx on ehr.appointment_events (appointment_id, sequence_no);
  create index appointment_events_patient_idx on ehr.appointment_events (patient_id);
  create index appointment_events_visit_queue_idx on ehr.appointment_events (visit_queue_entry_id)
    where visit_queue_entry_id is not null;
  alter table ehr.appointment_events enable row level security;
  revoke all on ehr.appointment_events from public;
  comment on table ehr.appointment_events is
    '0160 (APPT-1): one row per booking, change or check-in of an appointment, with the Idempotency-Key and the request''s SHA-256. Append only (a trigger refuses update and delete). Only the appointment functions read and write it, as its owner.';

  create function ehr.appointment_events_immutable()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    raise exception using errcode = '55000', message = 'APPOINTMENT_HISTORY_IMMUTABLE';
  end
  $fn$;
  revoke all on function ehr.appointment_events_immutable() from public;
  create trigger appointment_events_immutable
    before update or delete on ehr.appointment_events
    for each row execute function ehr.appointment_events_immutable();

  -- A6. The waiting-list basis: search, own_facility, appointment, then every value another lane added, in its
  -- order (so 0168 before or after this file leaves the same CHECK).
  alter table ehr.visit_queue drop constraint visit_queue_check_in_basis_check;
  execute format('alter table ehr.visit_queue add constraint visit_queue_check_in_basis_check check (check_in_basis in (%s))',
    (select string_agg(quote_literal(basis.value), ', ' order by basis.position)
       from unnest(array['search', 'own_facility', 'appointment'] || v_basis_found[3:]) with ordinality as basis(value, position)));

  -- A7. Helpers (no role may execute them; the functions below run them as their owner).
  create function ehr.appointment_caller(required_all text[], required_any text[])
  returns table (actor_subject text, actor_account uuid, actor_membership uuid, actor_facility uuid,
    actor_organization uuid, actor_staff uuid, actor_correlation text, actor_purpose text)
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    code text;
    any_held boolean := cardinality(coalesce(required_any, array[]::text[])) = 0;
  begin
    actor_subject := platform.current_actor_subject();
    actor_account := auth.account_id_for_subject(actor_subject);
    actor_membership := platform.current_membership_id();
    actor_facility := platform.current_facility_id();
    actor_correlation := platform.current_correlation_id();
    actor_purpose := platform.current_purpose_of_use();
    if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null then
      raise exception using errcode = '42501', message = 'APPOINTMENT_NOT_ALLOWED';
    end if;
    foreach code in array coalesce(required_all, array[]::text[]) loop
      if not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, code) then
        raise exception using errcode = '42501', message = 'APPOINTMENT_NOT_ALLOWED';
      end if;
    end loop;
    foreach code in array coalesce(required_any, array[]::text[]) loop
      if auth.membership_has_permission(actor_subject, actor_membership, actor_facility, code) then
        any_held := true;
      end if;
    end loop;
    if not any_held then
      raise exception using errcode = '42501', message = 'APPOINTMENT_NOT_ALLOWED';
    end if;
    select membership.organization_id, membership.staff_id into actor_organization, actor_staff
      from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account
       and membership.facility_id = actor_facility and membership.active
       and membership.migration_hold_reason is null;
    if not found then
      raise exception using errcode = '42501', message = 'APPOINTMENT_NOT_ALLOWED';
    end if;
    if actor_purpose is distinct from 'direct-care' then
      raise exception using errcode = '22023', message = 'APPOINTMENT_DIRECT_CARE_ONLY';
    end if;
    return next;
  end
  $fn$;
  revoke all on function ehr.appointment_caller(text[], text[]) from public;

  create function ehr.appointment_audit(a_subject text, a_account uuid, a_membership uuid, a_organization uuid,
    a_facility uuid, a_correlation text, a_purpose text, a_patient uuid, a_action text, a_outcome text,
    a_resource_type text, a_resource_id text, a_details jsonb)
  returns void
  language sql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      a_correlation, 'staff', a_subject, a_account, a_membership, a_organization, a_facility, a_patient,
      a_action, a_outcome, a_resource_type, a_resource_id, a_purpose, 'application', 'ehr-api',
      coalesce(a_details, '{}'::jsonb))
  $fn$;
  revoke all on function ehr.appointment_audit(text, uuid, uuid, uuid, uuid, text, text, uuid, text, text, text, text, jsonb) from public;

  -- The Idempotency-Key: 'new', 'replay' (the same key and body: the first
  -- answer's appointment and outcome) or 'reused' (the same key, another body).
  -- Under an advisory lock per membership and key, so two requests with one key
  -- never both act.
  create function ehr.appointment_idempotency(a_membership uuid, a_key text, a_sha text)
  returns table (state text, appointment_id uuid, outcome text, visit_queue_entry_id uuid)
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    found_event ehr.appointment_events%rowtype;
  begin
    if a_key is null or a_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or a_sha is null or a_sha !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'APPOINTMENT_IDEMPOTENCY_KEY_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('appointment-key:' || a_membership::text || ':' || a_key, 0));
    select event.* into found_event from ehr.appointment_events event
     where event.by_membership_id = a_membership and event.idempotency_key = a_key;
    if not found then
      state := 'new';
    elsif found_event.request_sha256 = a_sha then
      state := 'replay';
      appointment_id := found_event.appointment_id;
      outcome := found_event.outcome;
      visit_queue_entry_id := found_event.visit_queue_entry_id;
    else
      state := 'reused';
      appointment_id := found_event.appointment_id;
    end if;
    return next;
  end
  $fn$;
  revoke all on function ehr.appointment_idempotency(uuid, text, text) from public;

  -- The card: identity details and the booking, never clinical content, never a
  -- Health ID (its last 4 characters only). Reads identity.patients, the
  -- clinic and the deny directives (chart_blocked, as 0135's card).
  create function ehr.appointment_cards(requested_ids uuid[], viewer_facility uuid, viewer_organization uuid,
    viewer_staff uuid)
  returns table (ord bigint, appointment_id uuid, patient_id uuid, full_name text, sex text, date_of_birth date,
    health_id_last4 text, chart_blocked boolean, department_code text, clinic_id uuid, clinic_name text,
    clinician_membership_id uuid, starts_at timestamptz, ends_at timestamptz, length_minutes integer,
    appointment_day date, visit_type text, reason text, status text, booking_basis text,
    visit_queue_entry_id uuid, booked_at timestamptz, booked_by_membership_id uuid,
    status_changed_at timestamptz, reminder_sent_at timestamptz, row_version bigint)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ordering.ord_position, appointment.id, appointment.patient_id, patient.full_name, patient.gender,
           patient.dob, right(patient.hid_code, 4),
           exists (
             select 1
               from identity.consent_directives directive
               join identity.consent_directive_versions directive_version
                 on directive_version.directive_id = directive.id
                and directive_version.version_no = directive.current_version
              where directive.patient_id = appointment.patient_id
                and directive_version.status = 'active'
                and directive_version.provision_type = 'deny'
                and directive_version.starts_at <= clock_timestamp()
                and (directive_version.expires_at is null or directive_version.expires_at > clock_timestamp())
                and (directive_version.facility_id is null or directive_version.facility_id = viewer_facility)
                and (cardinality(directive_version.actions) = 0
                     or directive_version.actions && array['read_records', 'write_records']::text[])
                and (cardinality(directive_version.purposes) = 0 or 'direct-care' = any (directive_version.purposes))
                and (directive_version.grantee_type = 'all'
                     or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = viewer_facility)
                     or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = viewer_organization)
                     or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = viewer_staff))),
           appointment.department_code, appointment.clinic_id, clinic.name, appointment.clinician_membership_id,
           appointment.starts_at, appointment.ends_at, appointment.length_minutes, appointment.appointment_day,
           appointment.visit_type, appointment.reason, appointment.status, appointment.booking_basis,
           appointment.visit_queue_entry_id, appointment.booked_at, appointment.booked_by_membership_id,
           appointment.status_changed_at, appointment.reminder_sent_at, appointment.row_version
      from unnest(requested_ids) with ordinality ordering(id, ord_position)
      join ehr.appointments appointment on appointment.id = ordering.id and appointment.facility_id = viewer_facility
      join identity.patients patient on patient.id = appointment.patient_id
      left join ehr.appointment_clinics clinic on clinic.id = appointment.clinic_id
     order by ordering.ord_position
  $fn$;
  comment on function ehr.appointment_cards(uuid[], uuid, uuid, uuid) is
    '0160 (APPT-1): the appointment card of each given appointment at the viewer''s facility, in the given order: patient id, full name, sex, date of birth, last 4 characters of the Health ID, chart_blocked, the booking. Called by the appointment functions as their owner; no role may execute it.';
  revoke all on function ehr.appointment_cards(uuid[], uuid, uuid, uuid) from public;

  -- Book (route 1).
  create function ehr.appointment_book(requested_match_ref text, requested_patient_id uuid,
    requested_department_code text, requested_clinic_id uuid, requested_clinician_membership_id uuid,
    requested_starts_at timestamptz, requested_length_minutes integer, requested_visit_type text,
    requested_reason text, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, ord bigint, appointment_id uuid, patient_id uuid, full_name text,
    sex text, date_of_birth date, health_id_last4 text, chart_blocked boolean, department_code text, clinic_id uuid,
    clinic_name text, clinician_membership_id uuid, starts_at timestamptz, ends_at timestamptz,
    length_minutes integer, appointment_day date, visit_type text, reason text, status text, booking_basis text,
    visit_queue_entry_id uuid, booked_at timestamptz, booked_by_membership_id uuid, status_changed_at timestamptz,
    reminder_sent_at timestamptz, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    ref_value text := nullif(btrim(coalesce(requested_match_ref, '')), '');
    reason_value text := nullif(btrim(coalesce(requested_reason, '')), '');
    key_state record;
    patient_value uuid;
    basis_value text;
    refusal text;
    profile_departments text[];
    clinic_row ehr.appointment_clinics%rowtype;
    clinician_subject text;
    length_value integer;
    ends_value timestamptz;
    new_id uuid;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.appointment_caller(array['ehr.appointment.write'], null);
    if (ref_value is null) = (requested_patient_id is null) then
      raise exception using errcode = '22023', message = 'APPOINTMENT_NEEDS_ONE_PATIENT';
    end if;
    if (ref_value is not null and ref_value !~ '^psr_[A-Za-z0-9_-]{43}$')
       or requested_starts_at is null or requested_department_code is null
       or not identity.facility_departments_valid(array[requested_department_code])
       or requested_visit_type is null
       or requested_visit_type not in ('new_visit', 'follow_up', 'results_review', 'antenatal', 'procedure', 'other')
       or (reason_value is not null and (length(reason_value) > 200 or reason_value ~ '[[:cntrl:]]'))
       or (requested_length_minutes is not null
           and (requested_length_minutes not between 5 and 240 or requested_length_minutes % 5 <> 0)) then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;

    select * into key_state from ehr.appointment_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select appointment.patient_id from ehr.appointments appointment where appointment.id = key_state.appointment_id),
        'ehr.appointment.book', 'success', 'appointment', key_state.appointment_id::text,
        jsonb_build_object('replayed', true));
      return query select 'booked', true, card.*
        from ehr.appointment_cards(array[key_state.appointment_id], caller.actor_facility, caller.actor_organization,
                                   caller.actor_staff) card;
      return;
    elsif key_state.state = 'reused' then
      refusal := 'key_reused';
    end if;

    if refusal is null then
      if ref_value is not null then
        patient_value := identity.resolve_patient_search_ref(ref_value, 'direct-care');
        if patient_value is null then
          refusal := 'needs_search';
        else
          basis_value := 'search';
        end if;
      else
        select patient.id into patient_value
          from identity.patients patient
         where patient.id = requested_patient_id and patient.status = 'active'
           and identity.sealed_demo_facility(caller.actor_facility) = identity.sealed_demo_patient(patient.id)
           and identity.sealed_qa_facility(caller.actor_facility) = identity.sealed_qa_patient(patient.id);
        if patient_value is null then
          refusal := 'needs_search';
        elsif identity.own_facility_basis(patient_value, caller.actor_facility) is null then
          refusal := 'needs_search';
        else
          basis_value := 'own_facility';
        end if;
      end if;
    end if;

    if refusal is null
       and ((extract(epoch from requested_starts_at) * 1000000)::bigint % 300000000 <> 0
            or requested_starts_at < now_value - interval '15 minutes'
            or requested_starts_at > now_value + interval '366 days') then
      refusal := 'time_invalid';
    end if;
    if refusal is null then
      select profile.departments into profile_departments
        from identity.facility_profiles profile where profile.facility_id = caller.actor_facility
       order by profile.created_at desc nulls last limit 1;
      if profile_departments is not null and cardinality(profile_departments) > 0
         and not requested_department_code = any (profile_departments) then
        refusal := 'department_invalid';
      end if;
    end if;
    if refusal is null and requested_clinic_id is not null then
      select clinic.* into clinic_row from ehr.appointment_clinics clinic
       where clinic.id = requested_clinic_id and clinic.facility_id = caller.actor_facility and clinic.active
         and clinic.department_code = requested_department_code;
      if not found then
        refusal := 'clinic_invalid';
      end if;
    end if;
    if refusal is null and requested_clinician_membership_id is not null then
      select account_row.subject into clinician_subject
        from identity.staff_facility_memberships membership
        join auth.accounts account_row on account_row.id = membership.account_id
       where membership.id = requested_clinician_membership_id and membership.facility_id = caller.actor_facility
         and membership.active and membership.migration_hold_reason is null;
      if clinician_subject is null
         or not auth.membership_has_permission(clinician_subject, requested_clinician_membership_id,
                                               caller.actor_facility, 'ehr.encounter.write')
         or not auth.membership_has_permission(clinician_subject, requested_clinician_membership_id,
                                               caller.actor_facility, 'ehr.note.write') then
        refusal := 'clinician_invalid';
      end if;
    end if;

    if refusal is null then
      length_value := coalesce(requested_length_minutes, clinic_row.default_length_minutes,
        (select settings.default_length_minutes from ehr.appointment_settings settings
          where settings.facility_id = caller.actor_facility), 30);
      ends_value := requested_starts_at + make_interval(mins => length_value);
      -- Clash locks: the clinician, then the patient, always in that order.
      if requested_clinician_membership_id is not null then
        perform pg_advisory_xact_lock(hashtextextended('appointment-clinician:' || caller.actor_facility::text || ':'
          || requested_clinician_membership_id::text, 0));
        if exists (select 1 from ehr.appointments other
                    where other.facility_id = caller.actor_facility
                      and other.clinician_membership_id = requested_clinician_membership_id
                      and other.status in ('booked', 'checked_in')
                      and other.starts_at < ends_value and other.ends_at > requested_starts_at) then
          refusal := 'clinician_clash';
        end if;
      end if;
    end if;
    if refusal is null then
      perform pg_advisory_xact_lock(hashtextextended('appointment-patient:' || caller.actor_facility::text || ':'
        || patient_value::text, 0));
      if exists (select 1 from ehr.appointments other
                  where other.facility_id = caller.actor_facility and other.patient_id = patient_value
                    and other.status = 'booked'
                    and other.starts_at < ends_value and other.ends_at > requested_starts_at) then
        refusal := 'patient_clash';
      end if;
    end if;

    if refusal is not null then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        case when refusal in ('needs_search', 'key_reused') then null else patient_value end,
        'ehr.appointment.book', 'denied', 'appointment', null,
        jsonb_build_object('by', case when ref_value is not null then 'match_ref' else 'patient_id' end,
          'refusal', refusal));
      outcome := refusal;
      replayed := false;
      return next;
      return;
    end if;

    insert into ehr.appointments (facility_id, organization_id, patient_id, department_code, clinic_id,
      clinician_membership_id, starts_at, length_minutes, ends_at, appointment_day, visit_type, reason, status,
      booking_basis, booked_by_account_id, booked_by_membership_id, booked_at, status_changed_by_membership_id,
      status_changed_at, updated_by_membership_id, updated_at)
    values (caller.actor_facility, caller.actor_organization, patient_value, requested_department_code,
      requested_clinic_id, requested_clinician_membership_id, requested_starts_at, length_value, ends_value,
      (requested_starts_at at time zone 'Africa/Lagos')::date, requested_visit_type, reason_value, 'booked',
      basis_value, caller.actor_account, caller.actor_membership, now_value, caller.actor_membership, now_value,
      caller.actor_membership, now_value)
    returning id into new_id;
    insert into ehr.appointment_events (appointment_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, to_starts_at, to_clinician_membership_id, basis, idempotency_key, request_sha256)
    values (new_id, caller.actor_facility, patient_value, 'booked', now_value, caller.actor_account,
      caller.actor_membership, requested_starts_at, requested_clinician_membership_id, basis_value,
      requested_idempotency_key, requested_request_sha256);
    perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, patient_value,
      'ehr.appointment.book', 'success', 'appointment', new_id::text,
      jsonb_build_object('by', case when ref_value is not null then 'match_ref' else 'patient_id' end,
        'basis', basis_value, 'clinicId', requested_clinic_id, 'clinicianMembershipId', requested_clinician_membership_id));
    return query select 'booked', false, card.*
      from ehr.appointment_cards(array[new_id], caller.actor_facility, caller.actor_organization, caller.actor_staff) card;
  end
  $fn$;
  comment on function ehr.appointment_book(text, uuid, text, uuid, uuid, timestamptz, integer, text, text, text, text) is
    '0160 (APPT-1): book a patient at this facility. Exactly one of a matchRef from this member''s own direct-care search in the last 10 minutes (0132) or a patient who is already this facility''s own (0131); anything else answers needs_search, the same for every reason. Needs ehr.appointment.write here, for direct care. Clash checks under advisory locks per clinician then per patient. Outcomes booked (replayed for the same Idempotency-Key and body), needs_search, time_invalid, department_invalid, clinic_invalid, clinician_invalid, clinician_clash, patient_clash, key_reused. Audited (ehr.appointment.book).';
  revoke all on function ehr.appointment_book(text, uuid, text, uuid, uuid, timestamptz, integer, text, text, text, text) from public;

  -- The day list (route 2).
  create function ehr.appointment_list(requested_day date, requested_clinic_id uuid,
    requested_clinician_membership_id uuid, requested_statuses text[], requested_limit integer,
    after_starts_at timestamptz, after_booked_at timestamptz, after_id uuid)
  returns table (ord bigint, appointment_id uuid, patient_id uuid, full_name text, sex text, date_of_birth date,
    health_id_last4 text, chart_blocked boolean, department_code text, clinic_id uuid, clinic_name text,
    clinician_membership_id uuid, starts_at timestamptz, ends_at timestamptz, length_minutes integer,
    appointment_day date, visit_type text, reason text, status text, booking_basis text,
    visit_queue_entry_id uuid, booked_at timestamptz, booked_by_membership_id uuid,
    status_changed_at timestamptz, reminder_sent_at timestamptz, row_version bigint, has_more boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    found_ids uuid[];
    shown_ids uuid[];
    more boolean;
  begin
    select * into caller from ehr.appointment_caller(array['ehr.appointment.read'], null);
    if requested_day is null or requested_limit is null or requested_limit not between 1 and 200
       or (requested_statuses is not null and (cardinality(requested_statuses) = 0
           or not requested_statuses <@ array['booked', 'checked_in', 'cancelled', 'no_show']))
       or ((after_starts_at is null) <> (after_booked_at is null) or (after_starts_at is null) <> (after_id is null)) then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    select array_agg(listed.id order by listed.starts_at, listed.booked_at, listed.id) into found_ids
      from (
        select appointment.id, appointment.starts_at, appointment.booked_at
          from ehr.appointments appointment
         where appointment.facility_id = caller.actor_facility and appointment.appointment_day = requested_day
           and (requested_clinic_id is null or appointment.clinic_id = requested_clinic_id)
           and (requested_clinician_membership_id is null
                or appointment.clinician_membership_id = requested_clinician_membership_id)
           and (requested_statuses is null or appointment.status = any (requested_statuses))
           and (after_starts_at is null
                or (appointment.starts_at, appointment.booked_at, appointment.id) > (after_starts_at, after_booked_at, after_id))
         order by appointment.starts_at, appointment.booked_at, appointment.id
         limit requested_limit + 1
      ) listed;
    more := coalesce(cardinality(found_ids), 0) > requested_limit;
    shown_ids := coalesce(found_ids[1:requested_limit], array[]::uuid[]);

    perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
      'ehr.appointment.list', 'success', 'appointment-list', null,
      jsonb_build_object('day', requested_day, 'clinicId', requested_clinic_id,
        'clinicianMembershipId', requested_clinician_membership_id, 'statuses', to_jsonb(requested_statuses),
        'resultCount', cardinality(shown_ids), 'hasMore', more, 'page', after_id is not null));
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    )
    select caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
           caller.actor_organization, caller.actor_facility, appointment.patient_id, 'ehr.appointment.list.shown',
           'success', 'appointment', appointment.id::text, caller.actor_purpose, 'application', 'ehr-api',
           jsonb_build_object('status', appointment.status)
      from unnest(shown_ids) with ordinality ordering(id, ord_position)
      join ehr.appointments appointment on appointment.id = ordering.id
     order by ordering.ord_position;

    return query select card.*, more
      from ehr.appointment_cards(shown_ids, caller.actor_facility, caller.actor_organization, caller.actor_staff) card;
  end
  $fn$;
  comment on function ehr.appointment_list(date, uuid, uuid, text[], integer, timestamptz, timestamptz, uuid) is
    '0160 (APPT-1): this facility''s appointments on one Lagos day, optionally for one clinic, one clinician and some statuses, by start time, at most 200 a page (keyset after start, booking time and id). Needs ehr.appointment.read here, for direct care. Audited: one ehr.appointment.list row and one ehr.appointment.list.shown row per appointment shown.';
  revoke all on function ehr.appointment_list(date, uuid, uuid, text[], integer, timestamptz, timestamptz, uuid) from public;

  -- One appointment with its history (route 3).
  create function ehr.appointment_read(requested_appointment_id uuid)
  returns table (outcome text, ord bigint, appointment_id uuid, patient_id uuid, full_name text, sex text,
    date_of_birth date, health_id_last4 text, chart_blocked boolean, department_code text, clinic_id uuid,
    clinic_name text, clinician_membership_id uuid, starts_at timestamptz, ends_at timestamptz,
    length_minutes integer, appointment_day date, visit_type text, reason text, status text, booking_basis text,
    visit_queue_entry_id uuid, booked_at timestamptz, booked_by_membership_id uuid, status_changed_at timestamptz,
    reminder_sent_at timestamptz, row_version bigint, history jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    patient_value uuid;
  begin
    select * into caller from ehr.appointment_caller(array['ehr.appointment.read'], null);
    if requested_appointment_id is null then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    select appointment.patient_id into patient_value from ehr.appointments appointment
     where appointment.id = requested_appointment_id and appointment.facility_id = caller.actor_facility;
    if patient_value is null then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
        'ehr.appointment.read', 'failure', 'appointment', requested_appointment_id::text,
        jsonb_build_object('outcome', 'not_found'));
      outcome := 'not_found';
      return next;
      return;
    end if;
    perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, patient_value,
      'ehr.appointment.read', 'success', 'appointment', requested_appointment_id::text, '{}'::jsonb);
    return query
      select 'found', card.*,
             coalesce((select jsonb_agg(jsonb_build_object('kind', event.kind, 'at', event.at,
                         'byMembershipId', event.by_membership_id, 'fromStartsAt', event.from_starts_at,
                         'toStartsAt', event.to_starts_at, 'fromClinicianMembershipId', event.from_clinician_membership_id,
                         'toClinicianMembershipId', event.to_clinician_membership_id, 'reason', event.reason)
                         order by event.sequence_no)
                         from ehr.appointment_events event where event.appointment_id = requested_appointment_id),
                      '[]'::jsonb)
        from ehr.appointment_cards(array[requested_appointment_id], caller.actor_facility, caller.actor_organization,
                                   caller.actor_staff) card;
  end
  $fn$;
  comment on function ehr.appointment_read(uuid) is
    '0160 (APPT-1): one appointment of this facility with its history (booked, rescheduled, cancelled, no_show, no_show_undone, checked_in). Needs ehr.appointment.read here, for direct care. Another facility''s appointment answers not_found. Audited (ehr.appointment.read).';
  revoke all on function ehr.appointment_read(uuid) from public;

  -- One patient's appointments at this facility (route 4).
  create function ehr.appointment_patient_list(requested_patient_id uuid)
  returns table (ord bigint, appointment_id uuid, patient_id uuid, full_name text, sex text, date_of_birth date,
    health_id_last4 text, chart_blocked boolean, department_code text, clinic_id uuid, clinic_name text,
    clinician_membership_id uuid, starts_at timestamptz, ends_at timestamptz, length_minutes integer,
    appointment_day date, visit_type text, reason text, status text, booking_basis text,
    visit_queue_entry_id uuid, booked_at timestamptz, booked_by_membership_id uuid,
    status_changed_at timestamptz, reminder_sent_at timestamptz, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    shown_ids uuid[];
  begin
    select * into caller from ehr.appointment_caller(array['ehr.appointment.read'], null);
    if requested_patient_id is null then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    select coalesce(array_agg(listed.id order by listed.starts_at, listed.id), array[]::uuid[]) into shown_ids
      from (select appointment.id, appointment.starts_at from ehr.appointments appointment
             where appointment.facility_id = caller.actor_facility and appointment.patient_id = requested_patient_id
               and appointment.starts_at >= clock_timestamp() - interval '90 days'
             order by appointment.starts_at, appointment.id limit 200) listed;
    perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      case when cardinality(shown_ids) > 0 then requested_patient_id end,
      'ehr.appointment.patient-list', 'success', 'appointment-list', null,
      jsonb_build_object('resultCount', cardinality(shown_ids)));
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    )
    select caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
           caller.actor_organization, caller.actor_facility, appointment.patient_id, 'ehr.appointment.patient-list.shown',
           'success', 'appointment', appointment.id::text, caller.actor_purpose, 'application', 'ehr-api',
           jsonb_build_object('status', appointment.status)
      from unnest(shown_ids) with ordinality ordering(id, ord_position)
      join ehr.appointments appointment on appointment.id = ordering.id
     order by ordering.ord_position;
    return query select card.*
      from ehr.appointment_cards(shown_ids, caller.actor_facility, caller.actor_organization, caller.actor_staff) card;
  end
  $fn$;
  comment on function ehr.appointment_patient_list(uuid) is
    '0160 (APPT-1): this facility''s appointments of one patient (upcoming, and the last 90 days), at most 200, by start time; an empty list for a patient with none here. It shows nothing beyond the day list. Needs ehr.appointment.read here, for direct care. Audited (ehr.appointment.patient-list and one .shown row per appointment).';
  revoke all on function ehr.appointment_patient_list(uuid) from public;

  -- Reschedule (route 5).
  create function ehr.appointment_reschedule(requested_appointment_id uuid, requested_row_version bigint,
    requested_starts_at timestamptz, requested_length_minutes integer, requested_clinician_membership_id uuid,
    requested_clear_clinician boolean, requested_reason text, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, ord bigint, appointment_id uuid, patient_id uuid, full_name text,
    sex text, date_of_birth date, health_id_last4 text, chart_blocked boolean, department_code text, clinic_id uuid,
    clinic_name text, clinician_membership_id uuid, starts_at timestamptz, ends_at timestamptz,
    length_minutes integer, appointment_day date, visit_type text, reason text, status text, booking_basis text,
    visit_queue_entry_id uuid, booked_at timestamptz, booked_by_membership_id uuid, status_changed_at timestamptz,
    reminder_sent_at timestamptz, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    reason_value text := btrim(coalesce(requested_reason, ''));
    current_row ehr.appointments%rowtype;
    refusal text;
    clinician_value uuid;
    clinician_subject text;
    length_value integer;
    ends_value timestamptz;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.appointment_caller(array['ehr.appointment.write'], null);
    if requested_appointment_id is null or requested_row_version is null or requested_row_version < 1
       or requested_starts_at is null or length(reason_value) not between 8 and 500
       or (requested_clinician_membership_id is not null and coalesce(requested_clear_clinician, false))
       or (requested_length_minutes is not null
           and (requested_length_minutes not between 5 and 240 or requested_length_minutes % 5 <> 0)) then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    select * into key_state from ehr.appointment_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select appointment.patient_id from ehr.appointments appointment where appointment.id = key_state.appointment_id),
        'ehr.appointment.reschedule', 'success', 'appointment', key_state.appointment_id::text,
        jsonb_build_object('replayed', true));
      return query select 'updated', true, card.*
        from ehr.appointment_cards(array[key_state.appointment_id], caller.actor_facility, caller.actor_organization,
                                   caller.actor_staff) card;
      return;
    end if;

    select appointment.* into current_row from ehr.appointments appointment
     where appointment.id = requested_appointment_id and appointment.facility_id = caller.actor_facility;
    if not found then
      refusal := 'not_found';
    elsif key_state.state = 'reused' then
      refusal := 'key_reused';
    end if;
    if refusal is null then
      clinician_value := case when coalesce(requested_clear_clinician, false) then null
                              else coalesce(requested_clinician_membership_id, current_row.clinician_membership_id) end;
      length_value := coalesce(requested_length_minutes, current_row.length_minutes);
      ends_value := requested_starts_at + make_interval(mins => length_value);
      -- Clash locks first (the clinician, then the patient), then the row.
      if clinician_value is not null then
        perform pg_advisory_xact_lock(hashtextextended('appointment-clinician:' || caller.actor_facility::text || ':'
          || clinician_value::text, 0));
      end if;
      perform pg_advisory_xact_lock(hashtextextended('appointment-patient:' || caller.actor_facility::text || ':'
        || current_row.patient_id::text, 0));
      select appointment.* into current_row from ehr.appointments appointment
       where appointment.id = requested_appointment_id for update;
      if current_row.status <> 'booked' then
        refusal := 'not_booked';
      elsif current_row.row_version <> requested_row_version then
        refusal := 'changed';
      elsif (extract(epoch from requested_starts_at) * 1000000)::bigint % 300000000 <> 0
            or requested_starts_at < now_value - interval '15 minutes'
            or requested_starts_at > now_value + interval '366 days' then
        refusal := 'time_invalid';
      elsif requested_clinician_membership_id is not null then
        select account_row.subject into clinician_subject
          from identity.staff_facility_memberships membership
          join auth.accounts account_row on account_row.id = membership.account_id
         where membership.id = requested_clinician_membership_id and membership.facility_id = caller.actor_facility
           and membership.active and membership.migration_hold_reason is null;
        if clinician_subject is null
           or not auth.membership_has_permission(clinician_subject, requested_clinician_membership_id,
                                                 caller.actor_facility, 'ehr.encounter.write')
           or not auth.membership_has_permission(clinician_subject, requested_clinician_membership_id,
                                                 caller.actor_facility, 'ehr.note.write') then
          refusal := 'clinician_invalid';
        end if;
      end if;
    end if;
    if refusal is null and clinician_value is not null
       and exists (select 1 from ehr.appointments other
                    where other.facility_id = caller.actor_facility and other.id <> current_row.id
                      and other.clinician_membership_id = clinician_value
                      and other.status in ('booked', 'checked_in')
                      and other.starts_at < ends_value and other.ends_at > requested_starts_at) then
      refusal := 'clinician_clash';
    end if;
    if refusal is null
       and exists (select 1 from ehr.appointments other
                    where other.facility_id = caller.actor_facility and other.id <> current_row.id
                      and other.patient_id = current_row.patient_id and other.status = 'booked'
                      and other.starts_at < ends_value and other.ends_at > requested_starts_at) then
      refusal := 'patient_clash';
    end if;

    if refusal is not null then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.appointment.reschedule', case when refusal = 'not_found' then 'failure' else 'denied' end,
        'appointment', requested_appointment_id::text, jsonb_build_object('refusal', refusal));
      if refusal in ('not_found', 'key_reused') then
        outcome := refusal;
        replayed := false;
        return next;
        return;
      end if;
      return query select refusal, false, card.*
        from ehr.appointment_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
                                   caller.actor_staff) card;
      return;
    end if;

    update ehr.appointments appointment
       set starts_at = requested_starts_at, length_minutes = length_value, ends_at = ends_value,
           appointment_day = (requested_starts_at at time zone 'Africa/Lagos')::date,
           clinician_membership_id = clinician_value, reminder_sent_at = null,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = appointment.row_version + 1
     where appointment.id = current_row.id;
    insert into ehr.appointment_events (appointment_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_starts_at, to_starts_at, from_clinician_membership_id, to_clinician_membership_id,
      reason, idempotency_key, request_sha256)
    values (current_row.id, caller.actor_facility, current_row.patient_id, 'rescheduled', now_value,
      caller.actor_account, caller.actor_membership, current_row.starts_at, requested_starts_at,
      current_row.clinician_membership_id, clinician_value, reason_value, requested_idempotency_key,
      requested_request_sha256);
    perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      current_row.patient_id, 'ehr.appointment.reschedule', 'success', 'appointment', current_row.id::text,
      jsonb_build_object('clinicianChanged', clinician_value is distinct from current_row.clinician_membership_id,
        'lengthChanged', length_value <> current_row.length_minutes));
    return query select 'updated', false, card.*
      from ehr.appointment_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
                                 caller.actor_staff) card;
  end
  $fn$;
  comment on function ehr.appointment_reschedule(uuid, bigint, timestamptz, integer, uuid, boolean, text, text, text) is
    '0160 (APPT-1): move a booked appointment of this facility (a new time, optionally a new length or clinician, or none), with a reason (8-500; kept in the history, never audited). Clashes are checked again, excluding this appointment; the reminder is reset. Needs ehr.appointment.write here. Outcomes updated, not_found, not_booked, changed, time_invalid, clinician_invalid, clinician_clash, patient_clash, key_reused. Audited (ehr.appointment.reschedule).';
  revoke all on function ehr.appointment_reschedule(uuid, bigint, timestamptz, integer, uuid, boolean, text, text, text) from public;

  -- Cancel (route 6) and no-show (route 7): one function each, the same shape.
  create function ehr.appointment_cancel(requested_appointment_id uuid, requested_row_version bigint,
    requested_reason text, requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, ord bigint, appointment_id uuid, patient_id uuid, full_name text,
    sex text, date_of_birth date, health_id_last4 text, chart_blocked boolean, department_code text, clinic_id uuid,
    clinic_name text, clinician_membership_id uuid, starts_at timestamptz, ends_at timestamptz,
    length_minutes integer, appointment_day date, visit_type text, reason text, status text, booking_basis text,
    visit_queue_entry_id uuid, booked_at timestamptz, booked_by_membership_id uuid, status_changed_at timestamptz,
    reminder_sent_at timestamptz, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    reason_value text := btrim(coalesce(requested_reason, ''));
    current_row ehr.appointments%rowtype;
    refusal text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.appointment_caller(array['ehr.appointment.write'], null);
    if requested_appointment_id is null or requested_row_version is null or requested_row_version < 1
       or length(reason_value) not between 8 and 500 then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    select * into key_state from ehr.appointment_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select appointment.patient_id from ehr.appointments appointment where appointment.id = key_state.appointment_id),
        'ehr.appointment.cancel', 'success', 'appointment', key_state.appointment_id::text,
        jsonb_build_object('replayed', true));
      return query select 'updated', true, card.*
        from ehr.appointment_cards(array[key_state.appointment_id], caller.actor_facility, caller.actor_organization,
                                   caller.actor_staff) card;
      return;
    end if;
    select appointment.* into current_row from ehr.appointments appointment
     where appointment.id = requested_appointment_id and appointment.facility_id = caller.actor_facility
     for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state = 'reused' then
      refusal := 'key_reused';
    elsif current_row.status <> 'booked' then
      refusal := 'not_booked';
    elsif current_row.row_version <> requested_row_version then
      refusal := 'changed';
    end if;
    if refusal is not null then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.appointment.cancel', case when refusal = 'not_found' then 'failure' else 'denied' end,
        'appointment', requested_appointment_id::text, jsonb_build_object('refusal', refusal));
      if refusal in ('not_found', 'key_reused') then
        outcome := refusal;
        replayed := false;
        return next;
        return;
      end if;
      return query select refusal, false, card.*
        from ehr.appointment_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
                                   caller.actor_staff) card;
      return;
    end if;
    update ehr.appointments appointment
       set status = 'cancelled', status_changed_by_membership_id = caller.actor_membership,
           status_changed_at = now_value, updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = appointment.row_version + 1
     where appointment.id = current_row.id;
    insert into ehr.appointment_events (appointment_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_starts_at, from_clinician_membership_id, reason, idempotency_key, request_sha256)
    values (current_row.id, caller.actor_facility, current_row.patient_id, 'cancelled', now_value,
      caller.actor_account, caller.actor_membership, current_row.starts_at, current_row.clinician_membership_id,
      reason_value, requested_idempotency_key, requested_request_sha256);
    perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      current_row.patient_id, 'ehr.appointment.cancel', 'success', 'appointment', current_row.id::text, '{}'::jsonb);
    return query select 'updated', false, card.*
      from ehr.appointment_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
                                 caller.actor_staff) card;
  end
  $fn$;
  comment on function ehr.appointment_cancel(uuid, bigint, text, text, text) is
    '0160 (APPT-1): cancel a booked appointment of this facility, with a reason (8-500; kept in the history, never audited). Cancelled is final and the row is kept. Needs ehr.appointment.write here. Outcomes updated, not_found, not_booked, changed, key_reused. Audited (ehr.appointment.cancel).';
  revoke all on function ehr.appointment_cancel(uuid, bigint, text, text, text) from public;

  create function ehr.appointment_mark_no_show(requested_appointment_id uuid, requested_row_version bigint,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, ord bigint, appointment_id uuid, patient_id uuid, full_name text,
    sex text, date_of_birth date, health_id_last4 text, chart_blocked boolean, department_code text, clinic_id uuid,
    clinic_name text, clinician_membership_id uuid, starts_at timestamptz, ends_at timestamptz,
    length_minutes integer, appointment_day date, visit_type text, reason text, status text, booking_basis text,
    visit_queue_entry_id uuid, booked_at timestamptz, booked_by_membership_id uuid, status_changed_at timestamptz,
    reminder_sent_at timestamptz, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    current_row ehr.appointments%rowtype;
    refusal text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.appointment_caller(array['ehr.appointment.write'], null);
    if requested_appointment_id is null or requested_row_version is null or requested_row_version < 1 then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    select * into key_state from ehr.appointment_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select appointment.patient_id from ehr.appointments appointment where appointment.id = key_state.appointment_id),
        'ehr.appointment.no-show', 'success', 'appointment', key_state.appointment_id::text,
        jsonb_build_object('replayed', true));
      return query select 'updated', true, card.*
        from ehr.appointment_cards(array[key_state.appointment_id], caller.actor_facility, caller.actor_organization,
                                   caller.actor_staff) card;
      return;
    end if;
    select appointment.* into current_row from ehr.appointments appointment
     where appointment.id = requested_appointment_id and appointment.facility_id = caller.actor_facility
     for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state = 'reused' then
      refusal := 'key_reused';
    elsif current_row.status <> 'booked' then
      refusal := 'not_booked';
    elsif current_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif now_value < current_row.starts_at then
      refusal := 'too_early';
    end if;
    if refusal is not null then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.appointment.no-show', case when refusal = 'not_found' then 'failure' else 'denied' end,
        'appointment', requested_appointment_id::text, jsonb_build_object('refusal', refusal));
      if refusal in ('not_found', 'key_reused') then
        outcome := refusal;
        replayed := false;
        return next;
        return;
      end if;
      return query select refusal, false, card.*
        from ehr.appointment_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
                                   caller.actor_staff) card;
      return;
    end if;
    update ehr.appointments appointment
       set status = 'no_show', status_changed_by_membership_id = caller.actor_membership,
           status_changed_at = now_value, updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = appointment.row_version + 1
     where appointment.id = current_row.id;
    insert into ehr.appointment_events (appointment_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_starts_at, idempotency_key, request_sha256)
    values (current_row.id, caller.actor_facility, current_row.patient_id, 'no_show', now_value,
      caller.actor_account, caller.actor_membership, current_row.starts_at, requested_idempotency_key,
      requested_request_sha256);
    perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      current_row.patient_id, 'ehr.appointment.no-show', 'success', 'appointment', current_row.id::text, '{}'::jsonb);
    return query select 'updated', false, card.*
      from ehr.appointment_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
                                 caller.actor_staff) card;
  end
  $fn$;
  comment on function ehr.appointment_mark_no_show(uuid, bigint, text, text) is
    '0160 (APPT-1): mark a booked appointment of this facility as no-show, only once its start time has passed. Check-in the same Lagos day undoes it. No notice to the patient. Needs ehr.appointment.write here. Outcomes updated, not_found, not_booked, changed, too_early, key_reused. Audited (ehr.appointment.no-show).';
  revoke all on function ehr.appointment_mark_no_show(uuid, bigint, text, text) from public;

  -- Check-in (route 8; Q-APPT-1 A, Q-APPT-6 A).
  create function ehr.appointment_check_in(requested_appointment_id uuid, requested_row_version bigint,
    requested_identity_confirmed boolean, requested_match_ref text, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, ord bigint, appointment_id uuid, patient_id uuid, full_name text,
    sex text, date_of_birth date, health_id_last4 text, chart_blocked boolean, department_code text, clinic_id uuid,
    clinic_name text, clinician_membership_id uuid, starts_at timestamptz, ends_at timestamptz,
    length_minutes integer, appointment_day date, visit_type text, reason text, status text, booking_basis text,
    visit_queue_entry_id uuid, booked_at timestamptz, booked_by_membership_id uuid, status_changed_at timestamptz,
    reminder_sent_at timestamptz, row_version bigint, entry jsonb)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    key_state record;
    ref_value text := nullif(btrim(coalesce(requested_match_ref, '')), '');
    current_row ehr.appointments%rowtype;
    refusal text;
    resolved uuid;
    queue_result record;
    entry_value uuid;
    already boolean := false;
    basis_value text;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller
      from ehr.appointment_caller(array['ehr.appointment.write', 'ehr.encounter.read', 'ehr.encounter.write'], null);
    if requested_appointment_id is null or requested_row_version is null or requested_row_version < 1
       or (ref_value is not null and ref_value !~ '^psr_[A-Za-z0-9_-]{43}$') then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    if requested_identity_confirmed is distinct from true then
      raise exception using errcode = '22023', message = 'APPOINTMENT_IDENTITY_NOT_CONFIRMED';
    end if;
    select * into key_state from ehr.appointment_idempotency(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        (select appointment.patient_id from ehr.appointments appointment where appointment.id = key_state.appointment_id),
        'ehr.appointment.check-in', 'success', 'appointment', key_state.appointment_id::text,
        jsonb_build_object('replayed', true));
      return query select key_state.outcome, true, card.*,
          (select to_jsonb(queue_card) from ehr.visit_queue_cards(array[key_state.visit_queue_entry_id],
             caller.actor_facility, caller.actor_organization, caller.actor_staff) queue_card)
        from ehr.appointment_cards(array[key_state.appointment_id], caller.actor_facility, caller.actor_organization,
                                   caller.actor_staff) card;
      return;
    end if;

    select appointment.* into current_row from ehr.appointments appointment
     where appointment.id = requested_appointment_id and appointment.facility_id = caller.actor_facility
     for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state = 'reused' then
      refusal := 'key_reused';
    elsif current_row.status not in ('booked', 'no_show') then
      refusal := 'not_booked';
    elsif current_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif current_row.appointment_day <> today then
      refusal := 'wrong_day';
    elsif current_row.status = 'no_show' and (current_row.status_changed_at at time zone 'Africa/Lagos')::date <> today then
      refusal := 'not_booked';
    elsif not exists (select 1 from identity.patients patient
                       where patient.id = current_row.patient_id and patient.status = 'active'
                         and identity.sealed_demo_facility(caller.actor_facility) = identity.sealed_demo_patient(patient.id)
                         and identity.sealed_qa_facility(caller.actor_facility) = identity.sealed_qa_patient(patient.id)) then
      refusal := 'needs_search';
    elsif ref_value is not null then
      resolved := identity.resolve_patient_search_ref(ref_value, 'direct-care');
      if resolved is distinct from current_row.patient_id then
        refusal := 'needs_search';
      end if;
    end if;

    if refusal is null and ref_value is not null then
      -- A fresh search: 0135's own check-in (basis search), which audits itself.
      select * into queue_result from ehr.visit_queue_check_in(ref_value, null);
      if queue_result.outcome not in ('checked_in', 'already_open') then
        refusal := 'needs_search';
      else
        entry_value := queue_result.entry_id;
        already := queue_result.outcome = 'already_open';
        basis_value := 'search';
      end if;
    elsif refusal is null then
      -- The appointment as a check-in-only basis (Q-APPT-6 A), under 0135's own lock and open-row index.
      perform pg_advisory_xact_lock(hashtextextended(
        'visit-queue:' || caller.actor_facility::text || ':' || current_row.patient_id::text, 0));
      select queue_entry.id into entry_value
        from ehr.visit_queue queue_entry
       where queue_entry.facility_id = caller.actor_facility and queue_entry.patient_id = current_row.patient_id
         and queue_entry.closed_at is null;
      if found then
        already := true;
      else
        insert into ehr.visit_queue (facility_id, patient_id, queue_day, check_in_basis, checked_in_by_account_id,
          checked_in_by_membership_id, checked_in_at, stage_changed_at, updated_by_membership_id, updated_at)
        values (caller.actor_facility, current_row.patient_id, today, 'appointment', caller.actor_account,
          caller.actor_membership, now_value, now_value, caller.actor_membership, now_value)
        returning id into entry_value;
      end if;
      basis_value := 'appointment';
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.visit-queue.check-in', 'success', 'visit-queue-entry', entry_value::text,
        jsonb_build_object('by', 'appointment', 'basis', 'appointment', 'alreadyOpen', already,
          'appointmentId', current_row.id));
    end if;

    if refusal is not null then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
        current_row.patient_id, 'ehr.appointment.check-in', case when refusal = 'not_found' then 'failure' else 'denied' end,
        'appointment', requested_appointment_id::text,
        jsonb_build_object('by', case when ref_value is not null then 'match_ref' else 'appointment' end,
          'refusal', refusal));
      if refusal in ('not_found', 'key_reused') then
        outcome := refusal;
        replayed := false;
        return next;
        return;
      end if;
      return query select refusal, false, card.*, null::jsonb
        from ehr.appointment_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
                                   caller.actor_staff) card;
      return;
    end if;

    if current_row.status = 'no_show' then
      insert into ehr.appointment_events (appointment_id, facility_id, patient_id, kind, at, by_account_id,
        by_membership_id)
      values (current_row.id, caller.actor_facility, current_row.patient_id, 'no_show_undone', now_value,
        caller.actor_account, caller.actor_membership);
    end if;
    update ehr.appointments appointment
       set status = 'checked_in', visit_queue_entry_id = entry_value,
           status_changed_by_membership_id = caller.actor_membership, status_changed_at = now_value,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = appointment.row_version + 1
     where appointment.id = current_row.id;
    insert into ehr.appointment_events (appointment_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_starts_at, basis, outcome, visit_queue_entry_id, idempotency_key, request_sha256)
    values (current_row.id, caller.actor_facility, current_row.patient_id, 'checked_in', now_value,
      caller.actor_account, caller.actor_membership, current_row.starts_at, basis_value,
      case when already then 'already_on_list' else 'checked_in' end, entry_value, requested_idempotency_key,
      requested_request_sha256);
    perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose,
      current_row.patient_id, 'ehr.appointment.check-in', 'success', 'appointment', current_row.id::text,
      jsonb_build_object('basis', basis_value, 'alreadyOnList', already, 'fromNoShow', current_row.status = 'no_show',
        'visitQueueEntryId', entry_value));
    return query select case when already then 'already_on_list' else 'checked_in' end, false, card.*,
        (select to_jsonb(queue_card) from ehr.visit_queue_cards(array[entry_value], caller.actor_facility,
           caller.actor_organization, caller.actor_staff) queue_card)
      from ehr.appointment_cards(array[current_row.id], caller.actor_facility, caller.actor_organization,
                                 caller.actor_staff) card;
  end
  $fn$;
  comment on function ehr.appointment_check_in(uuid, bigint, boolean, text, text, text) is
    '0160 (APPT-1, Q-APPT-1 A and Q-APPT-6 A): check a booked patient in on this facility''s waiting list in the same transaction. Only on the appointment''s own Lagos day, from booked (or no_show marked that day, undone and recorded), with identityConfirmed true. With a matchRef it must name the appointment''s patient and goes through 0135''s ehr.visit_queue_check_in (basis search); without one the appointment is the basis for this one check-in (basis appointment), under 0135''s lock and open-row index. Never an own-facility basis, never a chart opening. Needs ehr.appointment.write, ehr.encounter.read and ehr.encounter.write here. Outcomes checked_in, already_on_list, not_found, not_booked, changed, wrong_day, needs_search, key_reused. Audited (ehr.appointment.check-in and ehr.visit-queue.check-in).';
  revoke all on function ehr.appointment_check_in(uuid, bigint, boolean, text, text, text) from public;

  -- Who can be booked against (route 10): 0135's assignee rule.
  create function ehr.appointment_bookable_staff()
  returns table (membership_id uuid)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
  begin
    select * into caller from ehr.appointment_caller(array['ehr.appointment.read'], null);
    return query
      select membership.id
        from identity.staff_facility_memberships membership
        join auth.accounts account_row on account_row.id = membership.account_id
       where membership.facility_id = caller.actor_facility and membership.active
         and membership.migration_hold_reason is null
         and auth.membership_has_permission(account_row.subject, membership.id, caller.actor_facility, 'ehr.encounter.write')
         and auth.membership_has_permission(account_row.subject, membership.id, caller.actor_facility, 'ehr.note.write')
       order by membership.id;
  end
  $fn$;
  comment on function ehr.appointment_bookable_staff() is
    '0160 (APPT-1): the membership ids of this facility a booking can name (active, holding ehr.encounter.write and ehr.note.write: nurse, clinician or doctor, 0135''s assignee rule). Ids only; names come from SX-9. Needs ehr.appointment.read here.';
  revoke all on function ehr.appointment_bookable_staff() from public;

  -- Clinics and the default length (route 9).
  create function ehr.appointment_clinic_list(requested_include_inactive boolean)
  returns table (clinic_id uuid, name text, department_code text, default_length_minutes integer, active boolean,
    row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
  begin
    select * into caller from ehr.appointment_caller(null, array['ehr.appointment.read', 'organization.manage']);
    return query
      select clinic.id, clinic.name, clinic.department_code, clinic.default_length_minutes, clinic.active,
             clinic.row_version
        from ehr.appointment_clinics clinic
       where clinic.facility_id = caller.actor_facility and (clinic.active or coalesce(requested_include_inactive, false))
       order by lower(clinic.name), clinic.id;
  end
  $fn$;
  comment on function ehr.appointment_clinic_list(boolean) is
    '0160 (APPT-1): this facility''s appointment clinics (active ones, or all). Needs ehr.appointment.read or organization.manage here.';
  revoke all on function ehr.appointment_clinic_list(boolean) from public;

  create function ehr.appointment_clinic_save(requested_clinic_id uuid, requested_row_version bigint,
    requested_name text, requested_department_code text, requested_default_length integer,
    requested_clear_default boolean, requested_active boolean, requested_idempotency_key text,
    requested_request_sha256 text)
  returns table (outcome text, replayed boolean, clinic_id uuid, name text, department_code text,
    default_length_minutes integer, active boolean, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    name_value text := nullif(btrim(coalesce(requested_name, '')), '');
    current_row ehr.appointment_clinics%rowtype;
    refusal text;
    saved_id uuid;
    profile_departments text[];
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.appointment_caller(array['organization.manage'], null);
    if requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$'
       or (name_value is not null and (length(name_value) not between 2 and 80 or name_value ~ '[[:cntrl:]]'))
       or (requested_department_code is not null
           and not identity.facility_departments_valid(array[requested_department_code]))
       or (requested_default_length is not null
           and (requested_default_length not between 5 and 240 or requested_default_length % 5 <> 0))
       or (requested_default_length is not null and coalesce(requested_clear_default, false))
       or (requested_clinic_id is null and (name_value is null or requested_department_code is null
                                            or requested_row_version is not null))
       or (requested_clinic_id is not null and (requested_row_version is null or requested_row_version < 1
                                                or requested_department_code is not null)) then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('appointment-key:' || caller.actor_membership::text || ':'
      || requested_idempotency_key, 0));
    select clinic.* into current_row from ehr.appointment_clinics clinic
     where clinic.facility_id = caller.actor_facility and clinic.updated_by_membership_id = caller.actor_membership
       and clinic.last_idempotency_key = requested_idempotency_key;
    if found then
      if current_row.last_request_sha256 = requested_request_sha256 then
        perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
          'ehr.appointment.clinic.save', 'success', 'appointment-clinic', current_row.id::text,
          jsonb_build_object('replayed', true));
        return query select 'saved', true, current_row.id, current_row.name, current_row.department_code,
          current_row.default_length_minutes, current_row.active, current_row.row_version;
        return;
      end if;
      refusal := 'key_reused';
    end if;

    if refusal is null and requested_clinic_id is null then
      select profile.departments into profile_departments
        from identity.facility_profiles profile where profile.facility_id = caller.actor_facility
       order by profile.created_at desc nulls last limit 1;
      if profile_departments is not null and cardinality(profile_departments) > 0
         and not requested_department_code = any (profile_departments) then
        refusal := 'department_invalid';
      end if;
    elsif refusal is null then
      select clinic.* into current_row from ehr.appointment_clinics clinic
       where clinic.id = requested_clinic_id and clinic.facility_id = caller.actor_facility for update;
      if not found then
        refusal := 'not_found';
      elsif current_row.row_version <> requested_row_version then
        refusal := 'changed';
      end if;
    end if;
    if refusal is null and name_value is not null
       and exists (select 1 from ehr.appointment_clinics other
                    where other.facility_id = caller.actor_facility and lower(other.name) = lower(name_value)
                      and other.id is distinct from requested_clinic_id) then
      refusal := 'name_taken';
    end if;
    if refusal is not null then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
        'ehr.appointment.clinic.save', case when refusal = 'not_found' then 'failure' else 'denied' end,
        'appointment-clinic', requested_clinic_id::text, jsonb_build_object('refusal', refusal));
      outcome := refusal;
      replayed := false;
      return next;
      return;
    end if;
    if requested_clinic_id is null then
      insert into ehr.appointment_clinics (facility_id, name, department_code, default_length_minutes, active,
        created_by_membership_id, created_at, updated_by_membership_id, updated_at, last_idempotency_key,
        last_request_sha256)
      values (caller.actor_facility, name_value, requested_department_code, requested_default_length,
        coalesce(requested_active, true), caller.actor_membership, now_value, caller.actor_membership, now_value,
        requested_idempotency_key, requested_request_sha256)
      returning id into saved_id;
    else
      update ehr.appointment_clinics clinic
         set name = coalesce(name_value, clinic.name),
             default_length_minutes = case when coalesce(requested_clear_default, false) then null
                                           else coalesce(requested_default_length, clinic.default_length_minutes) end,
             active = coalesce(requested_active, clinic.active),
             updated_by_membership_id = caller.actor_membership, updated_at = now_value,
             last_idempotency_key = requested_idempotency_key, last_request_sha256 = requested_request_sha256,
             row_version = clinic.row_version + 1
       where clinic.id = requested_clinic_id
      returning clinic.id into saved_id;
    end if;
    perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
      'ehr.appointment.clinic.save', 'success', 'appointment-clinic', saved_id::text,
      jsonb_build_object('created', requested_clinic_id is null, 'nameChanged', name_value is not null,
        'activeChanged', requested_active is not null));
    return query select 'saved', false, clinic.id, clinic.name, clinic.department_code, clinic.default_length_minutes,
        clinic.active, clinic.row_version
      from ehr.appointment_clinics clinic where clinic.id = saved_id;
  end
  $fn$;
  comment on function ehr.appointment_clinic_save(uuid, bigint, text, text, integer, boolean, boolean, text, text) is
    '0160 (APPT-1): create a clinic of this facility (name, department, optional default length) or change one (name, default length, active; never its department, never deleted). Needs organization.manage here. Outcomes saved (replayed for the same Idempotency-Key and body), not_found, changed, name_taken, department_invalid, key_reused. Audited (ehr.appointment.clinic.save; never the clinic name).';
  revoke all on function ehr.appointment_clinic_save(uuid, bigint, text, text, integer, boolean, boolean, text, text) from public;

  create function ehr.appointment_settings_read()
  returns table (default_length_minutes integer, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
  begin
    select * into caller from ehr.appointment_caller(null, array['ehr.appointment.read', 'organization.manage']);
    return query
      select coalesce(settings.default_length_minutes, 30), coalesce(settings.row_version, 0)
        from (select 1) one_row
        left join ehr.appointment_settings settings on settings.facility_id = caller.actor_facility;
  end
  $fn$;
  comment on function ehr.appointment_settings_read() is
    '0160 (APPT-1): this facility''s default appointment length (30 and row version 0 when never set). Needs ehr.appointment.read or organization.manage here.';
  revoke all on function ehr.appointment_settings_read() from public;

  create function ehr.appointment_settings_save(requested_row_version bigint, requested_default_length integer,
    requested_idempotency_key text, requested_request_sha256 text)
  returns table (outcome text, replayed boolean, default_length_minutes integer, row_version bigint)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    caller record;
    current_row ehr.appointment_settings%rowtype;
    refusal text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.appointment_caller(array['organization.manage'], null);
    if requested_row_version is null or requested_row_version < 0 or requested_default_length is null
       or requested_default_length not between 5 and 240 or requested_default_length % 5 <> 0
       or requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('appointment-settings:' || caller.actor_facility::text, 0));
    select settings.* into current_row from ehr.appointment_settings settings
     where settings.facility_id = caller.actor_facility for update;
    if found and current_row.updated_by_membership_id = caller.actor_membership
       and current_row.last_idempotency_key = requested_idempotency_key then
      if current_row.last_request_sha256 = requested_request_sha256 then
        perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
          caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
          'ehr.appointment.settings.save', 'success', 'appointment-settings', caller.actor_facility::text,
          jsonb_build_object('replayed', true));
        return query select 'saved', true, current_row.default_length_minutes, current_row.row_version;
        return;
      end if;
      refusal := 'key_reused';
    elsif coalesce(current_row.row_version, 0) <> requested_row_version then
      refusal := 'changed';
    end if;
    if refusal is not null then
      perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
        caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
        'ehr.appointment.settings.save', 'denied', 'appointment-settings', caller.actor_facility::text,
        jsonb_build_object('refusal', refusal));
      outcome := refusal;
      replayed := false;
      return next;
      return;
    end if;
    insert into ehr.appointment_settings (facility_id, default_length_minutes, row_version, last_idempotency_key,
      last_request_sha256, updated_by_membership_id, updated_at)
    values (caller.actor_facility, requested_default_length, 1, requested_idempotency_key, requested_request_sha256,
      caller.actor_membership, now_value)
    on conflict (facility_id) do update
      set default_length_minutes = excluded.default_length_minutes,
          row_version = ehr.appointment_settings.row_version + 1,
          last_idempotency_key = excluded.last_idempotency_key,
          last_request_sha256 = excluded.last_request_sha256,
          updated_by_membership_id = excluded.updated_by_membership_id, updated_at = excluded.updated_at;
    perform ehr.appointment_audit(caller.actor_subject, caller.actor_account, caller.actor_membership,
      caller.actor_organization, caller.actor_facility, caller.actor_correlation, caller.actor_purpose, null,
      'ehr.appointment.settings.save', 'success', 'appointment-settings', caller.actor_facility::text,
      jsonb_build_object('defaultLengthMinutes', requested_default_length));
    return query select 'saved', false, settings.default_length_minutes, settings.row_version
      from ehr.appointment_settings settings where settings.facility_id = caller.actor_facility;
  end
  $fn$;
  comment on function ehr.appointment_settings_save(bigint, integer, text, text) is
    '0160 (APPT-1): set this facility''s default appointment length (5-240 in steps of 5), with the row version read (0 when never set). Needs organization.manage here. Outcomes saved (replayed for the same Idempotency-Key and body), changed, key_reused. Audited (ehr.appointment.settings.save).';
  revoke all on function ehr.appointment_settings_save(bigint, integer, text, text) from public;

  -- Owners and EXECUTE (as 0135: the owner of identity.has_active_consent_grant).
  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
  if v_owner <> current_user then
    execute format('alter table ehr.appointment_settings owner to %I', v_owner);
    execute format('alter table ehr.appointment_clinics owner to %I', v_owner);
    execute format('alter table ehr.appointments owner to %I', v_owner);
    execute format('alter table ehr.appointment_events owner to %I', v_owner);
    execute (select string_agg(format('alter function %s owner to %I', proc.oid::regprocedure, v_owner), '; ')
               from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where namespace.nspname = 'ehr' and proc.proname like 'appointment%');
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function
      ehr.appointment_book(text, uuid, text, uuid, uuid, timestamptz, integer, text, text, text, text),
      ehr.appointment_list(date, uuid, uuid, text[], integer, timestamptz, timestamptz, uuid),
      ehr.appointment_read(uuid),
      ehr.appointment_patient_list(uuid),
      ehr.appointment_reschedule(uuid, bigint, timestamptz, integer, uuid, boolean, text, text, text),
      ehr.appointment_cancel(uuid, bigint, text, text, text),
      ehr.appointment_mark_no_show(uuid, bigint, text, text),
      ehr.appointment_check_in(uuid, bigint, boolean, text, text, text),
      ehr.appointment_bookable_staff(),
      ehr.appointment_clinic_list(boolean),
      ehr.appointment_clinic_save(uuid, bigint, text, text, integer, boolean, boolean, text, text),
      ehr.appointment_settings_read(),
      ehr.appointment_settings_save(bigint, integer, text, text)
      to hid_ehr_runtime;
  end if;

  -- A5. The two codes and the seven role rows (Q-APPT-5 A), one audit row each.
  insert into auth.permissions (code, description) values
    ('ehr.appointment.read', 'See this facility''s appointments (APPT-1, 0160)'),
    ('ehr.appointment.write', 'Book, move, cancel, mark no-show and check in this facility''s appointments (APPT-1, 0160)');
  insert into auth.role_permissions (role_code, permission_code) values
    ('receptionist', 'ehr.appointment.read'), ('receptionist', 'ehr.appointment.write'),
    ('doctor', 'ehr.appointment.read'), ('doctor', 'ehr.appointment.write'),
    ('clinician', 'ehr.appointment.read'), ('clinician', 'ehr.appointment.write'),
    ('nurse', 'ehr.appointment.read');
  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  )
  select v_correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission',
         grant_row.role_code || '/' || grant_row.permission_code, 'healthcare-operations', v_reason, 'migration',
         'hid-0160',
         jsonb_build_object('roleCode', grant_row.role_code, 'permissionCode', grant_row.permission_code,
           'migration', '0160', 'decision', 'Q-APPT-5 A (recommended option)')
    from auth.role_permissions grant_row
   where grant_row.permission_code in ('ehr.appointment.read', 'ehr.appointment.write')
   order by grant_row.role_code collate "C", grant_row.permission_code collate "C";

  -- 3. Post-checks.
  select count(*) into v_audited from audit.events event_row where event_row.correlation_id = v_correlation;
  if (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                        order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
        from auth.role_permissions grant_row where grant_row.permission_code like 'ehr.appointment.%')
     is distinct from 'clinician ehr.appointment.read,clinician ehr.appointment.write,doctor ehr.appointment.read,'
       || 'doctor ehr.appointment.write,nurse ehr.appointment.read,receptionist ehr.appointment.read,'
       || 'receptionist ehr.appointment.write'
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                           ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
           from auth.role_permissions grant_row where grant_row.permission_code not like 'ehr.appointment.%')
        is distinct from v_rows_before
     or v_audited <> 7 then
    raise exception using errcode = '55000', message = '0160: post-check failed (the role table)';
  end if;
  -- On 0001-0153 exactly CHECK ((check_in_basis = ANY (ARRAY['search'::text, 'own_facility'::text,
  -- 'appointment'::text]))); after 0168, 'emergency'::text follows 'appointment'::text.
  select pg_get_constraintdef(constraint_row.oid) into v_check_after from pg_constraint constraint_row
   where constraint_row.conrelid = 'ehr.visit_queue'::regclass
     and constraint_row.conname = 'visit_queue_check_in_basis_check' and constraint_row.contype = 'c'
     and constraint_row.convalidated;
  if v_check_after is distinct from format('CHECK ((check_in_basis = ANY (ARRAY[%s])))',
       (select string_agg(quote_literal(basis.value) || '::text', ', ' order by basis.position)
          from unnest(array['search', 'own_facility', 'appointment'] || v_basis_found[3:])
               with ordinality as basis(value, position))) then
    raise exception using errcode = '55000', message = '0160: post-check failed (the waiting-list basis CHECK)';
  end if;
  if exists (select 1 from pg_class class_row, lateral aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) acl
              where class_row.oid in ('ehr.appointment_settings'::regclass, 'ehr.appointment_clinics'::regclass,
                                      'ehr.appointments'::regclass, 'ehr.appointment_events'::regclass)
                and acl.grantee <> class_row.relowner)
     or (select count(*) from pg_class
          where oid in ('ehr.appointment_settings'::regclass, 'ehr.appointment_clinics'::regclass,
                        'ehr.appointments'::regclass, 'ehr.appointment_events'::regclass)
            and relrowsecurity) <> 4 then
    raise exception using errcode = '55000', message = '0160: post-check failed (a table is granted to a role or lacks row-level security)';
  end if;
  if exists (select 1 from pg_proc proc
               join pg_namespace namespace on namespace.oid = proc.pronamespace,
               lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where namespace.nspname = 'ehr' and proc.proname like 'appointment%'
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime'
                     or proc.proname in ('appointment_cards', 'appointment_caller', 'appointment_audit',
                                         'appointment_idempotency', 'appointment_events_immutable')))
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr' and proc.proname like 'appointment%' and proc.prosecdef
            and proc.proconfig = array['search_path=pg_catalog, pg_temp']) <> 13
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr' and proc.proname like 'appointment%') <> 18 then
    raise exception using errcode = '55000', message = '0160: post-check failed (the functions'' security or grants)';
  end if;

  -- What the role rows give, at real (not sealed) facilities: the members who gain each code.
  select count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.appointment.read'),
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.appointment.write')
    into v_read_gain, v_write_gain
    from identity.staff_facility_memberships membership
    join auth.account_roles assignment on assignment.membership_id = membership.id and assignment.revoked_at is null
    join auth.role_permissions grant_row on grant_row.role_code = assignment.role_code
   where membership.active and membership.facility_id is not null
     and grant_row.permission_code in ('ehr.appointment.read', 'ehr.appointment.write')
     and not identity.sealed_demo_facility(membership.facility_id)
     and not identity.sealed_qa_facility(membership.facility_id);
  raise notice '0160: appointments installed; ehr.appointment.read now held by % active staff memberships and ehr.appointment.write by % at real facilities; seven role rows, seven audit rows.',
    v_read_gain, v_write_gain;
end
$appt0160$;
