-- 0145: unknown patient records (ID-7, Akos P0-4 and P0-1, Release B; the
-- planned contract's "ID-7: Unknown patient record"). Booked as 0146 on
-- hid-system#258; numbers are given in merge order at the Release B
-- cut-off. This file requires 0001-0138 applied: it replaces 0131's basis,
-- 0132's search and 0138's NIN-link pre-check (each pinned by md5).
--
-- A record for a person who cannot say who they are: someone unconscious
-- or confused, or a child brought in alone. It is a real patient with a
-- Health ID, so visits, vitals, notes, orders and lab and pharmacy work
-- attach to it as usual. It has no login, no NIN and no phone, and it is
-- found only at the facility that made it. Consent rules are unchanged
-- except one addition: the record is "this facility's own" (0131) there.
--
-- D1 The record kind is derived, never stored on identity.patients: a
--    patient is 'unknown' while its identity.unknown_patients row is not
--    'identified' (open, sent_for_review, cancelled; merged is kept for
--    ID-8), and 'standard' otherwise; its date of birth is estimated while it
--    is unknown and has one. identity.patient_record_kind(patient) answers
--    the kind for the Identity runtime (patient-lookup and the staff patient
--    profile). An unknown record never has a login: the trigger
--    patients_unknown_no_login refuses an account on it (P0001
--    PATIENT_RECORD_UNKNOWN). So identity.patients gains no column and is
--    never locked against its readers (Ola's #302 review, item 4).
-- D2 identity.unknown_patients: one row per unknown record, owner only (no
--    runtime privilege; only this file's functions read or write it): the
--    facility that made it, the label (U-0001 and up, unique per facility),
--    the reason, the status (open, sent_for_review, identified, cancelled;
--    merged is kept for ID-8), the arrival note's ciphertext and key
--    version (Identity encrypts it; it never reaches a list, log or audit
--    row), who made it and the request's idempotency key and digest; then
--    the identify step (who, when, the proposed name, date of birth, sex
--    and contact, the candidates with their match reasons), and the
--    approver's decision (confirm-separate or cancel, who, when, the
--    reason). Its row_version is the record's version in every answer. The
--    contact given at identify stays here, facility-held and unverified, and
--    never becomes the patient's own sign-in phone (the clinical owner's
--    recommendation, Ola on #302): an erasure erases it (D14), a cancel nulls it with the held
--    details (D9), and ID-2's duplicate rule reads its lookup hash (D13).
-- D3 identity.refuse_nin_for_unknown_patient() and the trigger
--    patient_identifiers_unknown_patient: a NIN is never attached to a
--    record that is still unknown (P0001 PATIENT_RECORD_UNKNOWN). 0138's
--    pre-check answers 'unknown_record' first, so QoreID is never asked.
-- D4 0131's identity.own_facility_basis gains 'created_here': the record
--    was made as unknown at this facility and is not cancelled or merged.
--    It lasts after identify and confirm-separate, so doctors keep the
--    PIN-free opening and ID-6 can add the NIN after identification.
-- D5 0132's identity.staff_patient_search is recreated with record_kind at
--    the end of its answer. An unknown record is never found by search
--    everywhere or by emergency search; at this facility a Health ID alone
--    finds it (the wristband).
-- D6 0138's identity.patient_nin_link_precheck answers 'unknown_record' for
--    this facility's record that is still unknown; another facility gets
--    'not_permitted' first, as for any patient that is not its own.
-- D7 Six SECURITY DEFINER functions for the Identity runtime (the routes of
--    the planned contract, plus the review read): create, list, read,
--    identify, review and decide (confirm-separate or cancel). Each needs a
--    staff session at its facility, purpose healthcare-operations, an
--    active unheld membership and identity.registration.write (create,
--    list, read, identify) or identity.registration.approve (review,
--    confirm-separate, cancel). Each sees only this facility's unknown
--    records: another facility's or a missing one answers not_found, with
--    the reason in the audit row. Writes are idempotent (the caller's key
--    and the request's digest), and a replay writes its own audit row
--    (replayed: true), since it answers the card again; an identify
--    replayed after the record was cancelled is refused as a fresh one is
--    (UNKNOWN_PATIENT_CANCELLED). Every call writes
--    its audit row (identity.unknown-patient.create, .list and one
--    .list.shown per card, .read, .identify, .review and one .review.shown
--    per candidate, .confirm-separate, .cancel): patient ids, outcome or
--    refusal kind, counts; never a name, date of birth, phone, Health ID or
--    the arrival note.
-- D8 identify runs 0130's possible-duplicate rule (the same date of birth
--    and last name or swapped names, the same phone, among active standard
--    patients the facility's seal allows, and open registrations without a
--    NIN and other records in review, at facilities of the same seal). None:
--    the record becomes standard with the given details (identified). Any:
--    the details are held and the record stays unknown, hidden from search,
--    until an approver who did not identify it reviews them with the
--    candidates (review) and confirms it separate (sent_for_review; ID-8's
--    merge comes in Release C). A sex not given keeps the one recorded at
--    creation.
-- D9 cancel: an approver, while the record is open or in review and nothing
--    clinical is attached (no visit that is not cancelled or entered in
--    error; no note, vitals, prescription, lab request, diagnosis, allergy
--    or document). The patient becomes inactive, an open waiting-list entry
--    is closed as cancelled (its own audit row), and the held details and
--    contact are nulled.
-- D10 The sealed QA facility may make unknown records (owner's open point,
--    built as recommended unless told otherwise); each becomes a sealed QA
--    patient. A sealed demo facility is refused.
-- D11 The clinical tables' owner may read them (ehr.clinical_notes,
--    diagnoses, documents, lab_requests, prescriptions, recorded_allergies,
--    vitals) only during D9's check: row-level security on each is forced,
--    and the check must see a record whoever wrote it. The policies
--    (<table>_cancel_check_read) open only while
--    ehr.unknown_patient_cancel_scans holds this backend transaction's
--    marker, which identity.decide_unknown_patient writes just before the
--    check and deletes just after (0130's marker pattern). Each policy's test
--    is one scalar subquery, evaluated once per statement (an InitPlan), so
--    no reader of these tables pays it per row. So every other
--    owner-run function and trigger that reads these tables sees exactly what
--    it saw before, and the owner without a session still sees nothing. Each
--    policy tests the owner's membership first. The marker table is the
--    owner's only; ehr.unknown_patient_cancel_scan_open() is executable by
--    PUBLIC (PostgreSQL checks EXECUTE on every function of a plan) and
--    answers only whether this backend's own transaction holds a marker. The
--    visits keep 0131's encounters_owner_read. No hid_ role other than the
--    owner is a member of any of the seven tables' owners (post-check, in
--    0133's form: MEMBER, so a NOINHERIT membership counts too).
-- D12 ehr.visit_queue_record_kinds(entry ids): the record kind and the
--    estimated date of birth of this facility's waiting-list entries, for
--    the EHR runtime, so ehr-api adds recordKind to EHR-C7's cards without
--    0135's four functions being replaced.
-- D13 0130's identity.register_patient_without_nin, replaced (md5-pinned):
--    a record that is still unknown is never a candidate; a Health ID the
--    patient states that is this facility's unknown record is refused
--    (P0001 PATIENT_RECORD_UNKNOWN: identify that record instead); at
--    another facility it is not a candidate, since that facility can neither
--    identify nor link it, but it sends the case to an approver
--    (review_required, kind stated_health_id, no candidate row), and the
--    audit row names the record (statedUnknownRecordPatientId), for ID-8;
--    an identified record's held
--    phone counts as a phone match; a record in review whose held details
--    look like the same person counts as an open registration; a replay
--    writes its audit row. The trigger registration_cases_unknown_patient
--    refuses any registration case that resolves to a record that is still
--    unknown (P0001 PATIENT_RECORD_UNKNOWN), whichever path writes it.
-- D14 0114's identity.erase_patient_facility_contacts, replaced
--    (md5-pinned; same answer): it also nulls the patient's held contact
--    and its lookup hash on identity.unknown_patients, and counts them in
--    its audit row.
--
-- Locks, taken first (section 0b), NOWAIT: ACCESS EXCLUSIVE on the seven
-- clinical tables of D11 (CREATE POLICY); SHARE ROW EXCLUSIVE on
-- identity.patients (the no-login trigger, and the foreign key of the new
-- table), identity.patient_identifiers and identity.registration_cases (the
-- triggers), auth.accounts, identity.facilities and
-- identity.staff_facility_memberships (the foreign keys of the new table);
-- ACCESS SHARE on ehr.encounters and identity.consent_grants (named by the
-- SQL functions' bodies, which are parsed when created). SHARE ROW EXCLUSIVE
-- does not block reads, so no identity table is closed to its readers, but
-- a write to one of those tables in flight stops the attempt. Only the
-- clinical tables are closed to their readers: the EHR, Pharmacy and Lab
-- runtimes, and, for ehr.documents, also the OCR worker's job poll (0107's
-- ocr.claim_worker_job_fair joins it, every second by default) and ocr-api's
-- job writes (0112's ocr.validate_job_write reads it FOR SHARE).
-- That is every existing table this file locks (pg_locks before commit), at
-- the strongest mode it takes, besides ROW EXCLUSIVE on audit.events, which
-- validating the audit helper's INSERT takes and which blocks only SHARE and
-- stronger. A busy table fails the attempt at once and its subtransaction
-- releases what it took; the attempt is made again every 100 ms for at most
-- 5 seconds, then 55P03 (nothing applied). When this transaction already
-- holds an earlier migration's locks that stop other sessions' reads or
-- writes (the runner's dry run), one attempt and no sleep: 55P03 at once,
-- nothing applied. Either refusal is this file's own busy refusal, which
-- the runner's dry run rolls back and runs again from the start, within its
-- bound (services/ehr-api/scripts/dry-run-attempts.mjs).
--
-- Old services on this schema: identity.patients is unchanged, so today's
-- identity-api reads patients as before; it reads search answers by column
-- name, so the extra record_kind column changes nothing for it; it never
-- calls the new functions; its NIN link (0138) answers an unknown record
-- with its generic refusal, and its desk registration answers
-- PATIENT_RECORD_UNKNOWN as an unavailable error. identity-api and ehr-api
-- of this branch call identity.patient_record_kind and
-- ehr.visit_queue_record_kinds only where they exist.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 0b. Locks, NOWAIT (55P03 and nothing applied).
-- 1. The unknown record (D2).         2. The kind and no login (D1).
-- 3. No NIN while unknown (D3).       4. The basis (D4).
-- 5. The search (D5).                 6. The NIN-link pre-check (D6).
-- 7. The commands (D7-D10).           8. The waiting list's kinds (D12).
-- 9. The cancel-check policies (D11). 10. ID-2's registration (D13).
-- 11. The contact eraser (D14).       12. Owners and EXECUTE (here and in
--     runtime-grants.sql).            13. Post-checks.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regclass('identity.patient_nin_links') is null
     or to_regprocedure('identity.patient_nin_link_precheck(uuid,character,text,character)') is null then
    raise exception using errcode = '55000', message = '0145: 0001-0138 must be applied first';
  end if;
  if to_regclass('identity.unknown_patients') is not null
     or to_regprocedure('identity.patient_record_kind(uuid)') is not null then
    raise exception using errcode = '55000', message = '0145: already applied';
  end if;
  if exists (select 1 from pg_trigger
              where (tgrelid = 'identity.patients'::regclass and tgname = 'patients_unknown_no_login')
                 or (tgrelid = 'identity.registration_cases'::regclass and tgname = 'registration_cases_unknown_patient')) then
    raise exception using errcode = '55000', message = '0145: a trigger of this file already exists';
  end if;
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('identity.own_facility_basis(uuid,uuid)', '629709624cc0eaafb96a47b685f6a4f9'),
      ('identity.staff_patient_search(text,text,text,date,text,text[],text,text)', '7a3bc8ac5275cffac8438300366480b0'),
      ('identity.patient_nin_link_precheck(uuid,character,text,character)', '570a2a53d2251ff6db7fbf489ec835f1'),
      ('identity.register_patient_without_nin(uuid,text,text,date,text,text,text,bytea,bytea,text,text,text,text,text)',
       '5782de6e51b2747ad4131efa4221fbdc'),
      ('identity.erase_patient_facility_contacts(uuid,text)', '06dfceb83bfb64cb5afaa668de2cc60e'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)',
       '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97')
    ) expected(signature, body_md5)
   where to_regprocedure(expected.signature) is null
      or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0145: these functions are not as this file reads or replaces them: ' || mismatch;
  end if;
  select string_agg(expected.table_name || '.' || expected.column_name, ', ') into mismatch
    from (values
      ('identity.patients', 'account_id', 'uuid'), ('identity.patients', 'hid_code', 'text'),
      ('identity.patients', 'first_name', 'text'), ('identity.patients', 'last_name', 'text'),
      ('identity.patients', 'full_name', 'text'), ('identity.patients', 'gender', 'text'),
      ('identity.patients', 'dob', 'date'), ('identity.patients', 'status', 'text'),
      ('identity.patients', 'phone_lookup_hmac', 'character(64)'),
      ('identity.patient_identifiers', 'identifier_type', 'text'),
      ('identity.registration_cases', 'identity_evidence', 'text'),
      ('identity.registration_cases', 'resolved_patient_id', 'uuid'),
      ('identity.registration_cases', 'facility_id', 'uuid'),
      ('identity.desk_registration_phone_lookups', 'phone_lookup_hmac', 'character(64)'),
      ('ehr.encounters', 'status', 'text'), ('ehr.visit_queue', 'facility_id', 'uuid'),
      ('ehr.visit_queue', 'stage', 'text'), ('ehr.visit_queue', 'closed_at', 'timestamp with time zone'),
      ('ehr.visit_queue', 'stage_changed_at', 'timestamp with time zone'),
      ('ehr.visit_queue', 'updated_by_membership_id', 'uuid'),
      ('ehr.clinical_notes', 'patient_id', 'uuid'), ('ehr.diagnoses', 'patient_id', 'uuid'),
      ('ehr.documents', 'patient_id', 'uuid'), ('ehr.lab_requests', 'patient_id', 'uuid'),
      ('ehr.prescriptions', 'patient_id', 'uuid'), ('ehr.recorded_allergies', 'patient_id', 'uuid'),
      ('ehr.vitals', 'patient_id', 'uuid')) expected(table_name, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = to_regclass(expected.table_name)
                        and attribute.attname = expected.column_name and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0145: these columns are not as this file reads them: ' || mismatch;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'identity.patients'::regclass
                  and conname = 'patients_status_check') then
    raise exception using errcode = '55000', message = '0145: identity.patients has no patients_status_check';
  end if;
end
$$;

-- 0b. Locks (see Locks), NOWAIT, at most 5 s; one attempt when this
-- transaction already holds an earlier migration's locks.
do $locks$
declare
  attempt integer := 0;
  holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.clinical_notes, ehr.diagnoses, ehr.documents, ehr.lab_requests,
        ehr.prescriptions, ehr.recorded_allergies, ehr.vitals in access exclusive mode nowait;
      lock table identity.patients, identity.patient_identifiers, identity.registration_cases, auth.accounts,
        identity.facilities, identity.staff_facility_memberships in share row exclusive mode nowait;
      lock table ehr.encounters, identity.consent_grants in access share mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0145: a clinical table, or a write to the patients, identifiers, registrations, accounts, facilities or memberships, is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0145: a clinical table, or a write to the patients, identifiers, registrations, accounts, facilities or memberships, stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 1. The unknown record (D2).
create table identity.unknown_patients (
  patient_id uuid primary key references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  label_number integer not null check (label_number between 1 and 999999),
  label text not null generated always as (
    'U-' || case when label_number < 10000 then lpad(label_number::text, 4, '0') else label_number::text end) stored,
  unknown_reason text not null
    check (unknown_reason in ('unconscious', 'confused', 'unaccompanied_child', 'cannot_communicate', 'other')),
  status text not null default 'open'
    check (status in ('open', 'sent_for_review', 'identified', 'cancelled', 'merged')),
  arrival_note_ciphertext bytea check (arrival_note_ciphertext is null
    or octet_length(arrival_note_ciphertext) between 30 and 8192),
  arrival_note_key_version text check (arrival_note_key_version is null
    or length(arrival_note_key_version) between 1 and 64),
  created_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  identified_by_account_id uuid references auth.accounts(id) on delete restrict,
  identified_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  identified_at timestamptz,
  identify_idempotency_key text check (identify_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  identify_request_sha256 char(64) check (identify_request_sha256 ~ '^[0-9a-f]{64}$'),
  proposed_first_name text check (length(proposed_first_name) between 1 and 100),
  proposed_last_name text check (length(proposed_last_name) between 1 and 100),
  proposed_dob date,
  proposed_gender text check (proposed_gender in ('female', 'male', 'intersex', 'other', 'unknown')),
  contact_phone_ciphertext bytea check (contact_phone_ciphertext is null
    or octet_length(contact_phone_ciphertext) between 30 and 2048),
  contact_address_ciphertext bytea check (contact_address_ciphertext is null
    or octet_length(contact_address_ciphertext) between 30 and 4096),
  contact_key_version text check (contact_key_version is null or length(contact_key_version) between 1 and 64),
  contact_phone_lookup_hmac char(64) check (contact_phone_lookup_hmac ~ '^[0-9a-f]{64}$'),
  candidate_count integer check (candidate_count >= 0),
  candidates jsonb check (candidates is null or jsonb_typeof(candidates) = 'array'),
  open_registration_count integer check (open_registration_count >= 0),
  decision text check (decision in ('confirmed_separate', 'cancelled')),
  decided_by_account_id uuid references auth.accounts(id) on delete restrict,
  decided_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  decided_at timestamptz,
  decision_reason text check (length(btrim(decision_reason)) between 8 and 500),
  decision_idempotency_key text check (decision_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  decision_request_sha256 char(64) check (decision_request_sha256 ~ '^[0-9a-f]{64}$'),
  row_version bigint not null default 1 check (row_version > 0),
  updated_at timestamptz not null default clock_timestamp(),
  constraint unknown_patients_label_uq unique (facility_id, label_number),
  constraint unknown_patients_idempotency_uq unique (created_by_account_id, facility_id, idempotency_key),
  constraint unknown_patients_note_ck check ((arrival_note_ciphertext is null) = (arrival_note_key_version is null)),
  constraint unknown_patients_contact_ck check (
    (contact_phone_ciphertext is null) = (contact_address_ciphertext is null)
    and (contact_phone_ciphertext is null) = (contact_key_version is null)
    and (contact_phone_ciphertext is null) = (contact_phone_lookup_hmac is null)),
  constraint unknown_patients_identified_ck check (
    (status = 'open') = (identified_at is null)
    or status = 'cancelled'),
  constraint unknown_patients_decision_ck check (
    (decision is null) = (decided_at is null)
    and (decision is null) = (decided_by_account_id is null)
    and (decision is null) = (decision_reason is null)
    and (decision <> 'cancelled' or status = 'cancelled')
    and (decision <> 'confirmed_separate' or status = 'identified'))
);
create index unknown_patients_facility_created_idx on identity.unknown_patients (facility_id, created_at desc, patient_id desc);
create index unknown_patients_identified_phone_idx on identity.unknown_patients (contact_phone_lookup_hmac)
  where contact_phone_lookup_hmac is not null;
revoke all on identity.unknown_patients from public;

-- 2. The record kind and no login (D1).
create function identity.patient_record_kind(requested_patient_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select case when exists (select 1 from identity.unknown_patients unknown_record
                            where unknown_record.patient_id = requested_patient_id
                              and unknown_record.status <> 'identified')
              then 'unknown' else 'standard' end
$$;
create function identity.refuse_login_for_unknown_patient()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if exists (select 1 from identity.unknown_patients unknown_record
              where unknown_record.patient_id = new.id and unknown_record.status <> 'identified') then
    raise exception using errcode = 'P0001', message = 'PATIENT_RECORD_UNKNOWN';
  end if;
  return new;
end
$$;
revoke all on function identity.refuse_login_for_unknown_patient() from public;
create trigger patients_unknown_no_login
  before update of account_id on identity.patients
  for each row when (new.account_id is not null)
  execute function identity.refuse_login_for_unknown_patient();

-- 3. No NIN on a record that is still unknown (D3).
create function identity.refuse_nin_for_unknown_patient()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if exists (select 1 from identity.unknown_patients unknown_record
              where unknown_record.patient_id = new.patient_id and unknown_record.status <> 'identified') then
    raise exception using errcode = 'P0001', message = 'PATIENT_RECORD_UNKNOWN';
  end if;
  return new;
end
$$;
revoke all on function identity.refuse_nin_for_unknown_patient() from public;
create trigger patient_identifiers_unknown_patient
  before insert or update of patient_id, identifier_type on identity.patient_identifiers
  for each row when (new.identifier_type = 'nin')
  execute function identity.refuse_nin_for_unknown_patient();

-- 4. The basis (D4): 0131's text with one case added first.
create or replace function identity.own_facility_basis(requested_patient_id uuid, requested_facility_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select case
    when exists (
      select 1
        from identity.unknown_patients unknown_record
       where unknown_record.patient_id = requested_patient_id
         and unknown_record.facility_id = requested_facility_id
         and unknown_record.status in ('open', 'sent_for_review', 'identified'))
      then 'created_here'
    when exists (
      select 1
        from identity.registration_cases registration
        join identity.patients patient on patient.id = registration.resolved_patient_id
       where registration.facility_id = requested_facility_id
         and registration.resolved_patient_id = requested_patient_id
         and (
           (registration.identity_evidence = 'nin_verified'
            and registration.status = 'resolved_existing_identity'
            and exists (select 1 from identity.patient_identifiers identifier
                         where identifier.patient_id = registration.resolved_patient_id
                           and identifier.identifier_type = 'nin'
                           and identifier.lookup_hmac = registration.nin_lookup_hmac
                           and identifier.verified and identifier.revoked_at is null))
           or (registration.identity_evidence = 'nin_verified'
               and registration.status in ('approved_new_identity', 'linked_existing')
               and exists (select 1 from identity.patient_identifiers identifier
                            where identifier.patient_id = registration.resolved_patient_id
                              and identifier.identifier_type = 'nin'
                              and identifier.registration_case_id = registration.id
                              and identifier.verified and identifier.revoked_at is null))
           or (registration.identity_evidence = 'none'
               and registration.status = 'approved_new_identity'
               and patient.source_system = 'hid-desk-registration')
           or (registration.identity_evidence = 'none'
               and registration.status = 'linked_existing'
               and exists (select 1 from identity.consent_grants grant_row
                            where grant_row.patient_id = registration.resolved_patient_id
                              and grant_row.facility_id = requested_facility_id
                              and grant_row.source_system = 'hid'
                              and grant_row.purpose_of_use = 'direct-care'
                              and not grant_row.break_glass
                              and grant_row.created_at >= registration.updated_at
                              and (grant_row.authorization_method = 'patient_access_pin'
                                   or (grant_row.authorization_method is null
                                       and grant_row.granted_by_patient_id = grant_row.patient_id))))
         ))
      then 'registered_here'
    when exists (
      select 1
        from ehr.encounters encounter
       where encounter.patient_id = requested_patient_id
         and encounter.facility_id = requested_facility_id
         and encounter.started_at >= statement_timestamp() - interval '24 months'
         and encounter.status not in ('cancelled', 'entered_in_error')
         and not encounter.imported_paper_records
         and exists (select 1 from identity.consent_grants grant_row
                      where grant_row.patient_id = encounter.patient_id
                        and grant_row.facility_id = encounter.facility_id
                        and grant_row.membership_id = encounter.created_by_membership_id
                        and grant_row.source_system = 'hid'
                        and grant_row.migration_hold_reason is null
                        and grant_row.purpose_of_use = 'direct-care'
                        and not grant_row.break_glass and grant_row.scope <> 'break_glass'
                        and grant_row.starts_at <= encounter.created_at
                        and grant_row.expires_at > encounter.created_at
                        and (grant_row.revoked_at is null or grant_row.revoked_at > encounter.created_at)
                        and (grant_row.authorization_method = 'patient_access_pin'
                             or (grant_row.authorization_method is null
                                 and grant_row.granted_by_patient_id = grant_row.patient_id))))
      then 'visit_here'
  end
$$;

comment on function identity.own_facility_basis(uuid, uuid) is
  '0131 (ID-4, owner Q101 of 18 November 2026), with 0145 (ID-7): created_here (made as an unknown record at this facility, not cancelled or merged; it outlives identify), registered_here (a registration at this facility that created the patient, resolved the patient''s checked NIN, attached its checked NIN, or, without a NIN, was linked and then confirmed by the patient), visit_here (a visit here started in the last 24 months, not cancelled or entered in error, not imported paper records, started under a grant the patient gave to the member who started it), or null. Check-in-only, emergency-only and own-facility-only visits do not count.';

-- 5. The search (D5): 0132's text with the Health-ID-alone rule and record_kind.
drop function identity.staff_patient_search(text, text, text, date, text, text[], text, text);
create function identity.staff_patient_search(
  requested_mode text, requested_first_name text, requested_last_name text, requested_dob date,
  requested_hid text, requested_phone_hmacs text[], requested_reason text, requested_criteria_hash text)
returns table (outcome text, reach text, match_ref text, full_name text, sex text, date_of_birth date,
  health_id_last4 text, nin_verified boolean, match_ref_expires_at timestamptz, record_kind text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  actor_correlation text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_organization uuid;
  emergency boolean;
  first_value text;
  last_value text;
  hid_value text;
  phone_values char(64)[];
  reason_value text;
  kinds text[] := array[]::text[];
  reach_value text;
  card_limit integer;
  query_text text;
  found_ids uuid[];
  outcome_value text;
  action_value text;
  ref_expiry timestamptz;
  token text;
  patient_row record;
  shown_ids uuid[] := array[]::uuid[];
  health_id_alone boolean;
begin
  if requested_mode is null or requested_mode not in ('standard', 'emergency') then
    raise exception using errcode = '22023', message = 'PATIENT_SEARCH_INVALID';
  end if;
  emergency := requested_mode = 'emergency';
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
          case when emergency then 'identity.break-glass.write' else 'identity.registration.write' end) then
    raise exception using errcode = '42501', message = 'PATIENT_SEARCH_NOT_PERMITTED';
  end if;
  select membership.organization_id into actor_organization
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.account_id = actor_account
     and membership.facility_id = actor_facility and membership.active
     and membership.migration_hold_reason is null;
  if not found then
    raise exception using errcode = '42501', message = 'PATIENT_SEARCH_NOT_PERMITTED';
  end if;
  if actor_purpose is distinct from (case when emergency then 'emergency' else 'direct-care' end)
     or not exists (select 1 from identity.purpose_of_use_codes code
                     where code.code = actor_purpose and code.active) then
    raise exception using errcode = '22023', message = 'PATIENT_SEARCH_PURPOSE';
  end if;
  if emergency then
    perform platform.require_control_enabled('break_glass_enabled');
  end if;

  first_value := nullif(lower(regexp_replace(btrim(coalesce(requested_first_name, '')), '\s+', ' ', 'g')), '');
  last_value := nullif(lower(regexp_replace(btrim(coalesce(requested_last_name, '')), '\s+', ' ', 'g')), '');
  hid_value := nullif(upper(btrim(coalesce(requested_hid, ''))), '');
  reason_value := nullif(btrim(coalesce(requested_reason, '')), '');
  if length(first_value) > 100 or length(last_value) > 100
     or (hid_value is not null and hid_value !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$')
     or (requested_dob is not null and (requested_dob > current_date or requested_dob < date '1880-01-01'))
     or coalesce(cardinality(requested_phone_hmacs), 0) > 2
     or exists (select 1 from unnest(requested_phone_hmacs) hmac where hmac is null or hmac !~ '^[0-9a-f]{64}$')
     or (requested_criteria_hash is not null and requested_criteria_hash !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = '22023', message = 'PATIENT_SEARCH_INVALID';
  end if;
  if coalesce(cardinality(requested_phone_hmacs), 0) > 0 then
    phone_values := requested_phone_hmacs::char(64)[];
  end if;
  if emergency then
    if reason_value is null or length(reason_value) < 8 or length(reason_value) > 500 then
      raise exception using errcode = '22023', message = 'PATIENT_SEARCH_REASON_REQUIRED';
    end if;
    if first_value is null or last_value is null or requested_dob is null
       or hid_value is not null or phone_values is not null then
      raise exception using errcode = '22023', message = 'PATIENT_SEARCH_EMERGENCY_KEYS';
    end if;
  elsif reason_value is not null then
    raise exception using errcode = '22023', message = 'PATIENT_SEARCH_INVALID';
  end if;

  if first_value is not null then kinds := array_append(kinds, 'first_name'); end if;
  if last_value is not null then kinds := array_append(kinds, 'last_name'); end if;
  if requested_dob is not null then kinds := array_append(kinds, 'date_of_birth'); end if;
  if hid_value is not null then kinds := array_append(kinds, 'health_id'); end if;
  if phone_values is not null then kinds := array_append(kinds, 'phone'); end if;

  if emergency
     or (first_value is not null and last_value is not null and requested_dob is not null)
     or (hid_value is not null and (last_value is not null or requested_dob is not null))
     or (phone_values is not null and last_value is not null) then
    reach_value := 'everywhere';
  elsif (last_value is not null and requested_dob is not null) or phone_values is not null
     or hid_value is not null then
    reach_value := 'here';
  end if;
  -- 0145 (ID-7): an unknown patient record is found only by its Health ID
  -- alone at this facility (the wristband), never by any other search.
  health_id_alone := not emergency and reach_value = 'here' and hid_value is not null
    and first_value is null and last_value is null and requested_dob is null and phone_values is null;
  card_limit := case when emergency then 5 else 10 end;
  action_value := case when emergency then 'identity.patient.emergency-search' else 'identity.patient.search' end;

  -- Expired references go, a few at a time.
  delete from identity.patient_search_refs old_ref
   where old_ref.token_sha256 in (select expired.token_sha256 from identity.patient_search_refs expired
                                   where expired.expires_at < clock_timestamp() limit 200);

  if reach_value is null then
    outcome_value := 'too_broad';
  else
    -- Only the keys given, so each search uses its index (Health ID, phone,
    -- or last name with first name and date of birth).
    query_text := 'select array_agg(matched.id order by matched.sort_name, matched.id) from ('
      || 'select patient.id, lower(patient.full_name) as sort_name from identity.patients patient'
      || ' where patient.status = ''active'''
      || case when health_id_alone then '' else ' and not exists (select 1 from identity.unknown_patients unknown_record'
           || ' where unknown_record.patient_id = patient.id and unknown_record.status <> ''identified'')' end
      || case when last_value is not null then ' and lower(patient.last_name) = $2' else '' end
      || case when first_value is not null then ' and lower(patient.first_name) = $3' else '' end
      || case when requested_dob is not null then ' and patient.dob = $4' else '' end
      || case when hid_value is not null then ' and upper(patient.hid_code) = $5' else '' end
      || case when phone_values is not null then ' and patient.phone_lookup_hmac = any ($6)' else '' end
      || ' and identity.sealed_demo_facility($1) = identity.sealed_demo_patient(patient.id)'
      || ' and identity.sealed_qa_facility($1) = identity.sealed_qa_patient(patient.id)'
      || case when reach_value = 'here' then ' and identity.own_facility_basis(patient.id, $1) is not null' else '' end
      || ' order by lower(patient.full_name), patient.id limit ' || (card_limit + 1)::text
      || ') matched';
    execute query_text into found_ids
      using actor_facility, last_value, first_value, requested_dob, hid_value, phone_values;
    if coalesce(cardinality(found_ids), 0) = 0 then
      outcome_value := case
        -- Owner Q100 B, as the staff Health ID lookup answers it: no patient
        -- record of any status has the Health ID.
        when hid_value is not null and not exists (
          select 1 from identity.patients patient where upper(patient.hid_code) = hid_value)
          then 'no_such_health_id'
        else 'no_match' end;
    elsif cardinality(found_ids) > card_limit then
      outcome_value := 'too_many';
    else
      outcome_value := 'found';
    end if;
  end if;

  if outcome_value = 'found' then
    ref_expiry := clock_timestamp();
    for patient_row in
      select patient.id, patient.full_name, patient.gender, patient.dob, patient.hid_code,
             case when exists (select 1 from identity.unknown_patients unknown_record
                                where unknown_record.patient_id = patient.id and unknown_record.status <> 'identified')
                  then 'unknown' else 'standard' end as record_kind,
             exists (select 1 from identity.patient_identifiers nin_identifier
                      where nin_identifier.patient_id = patient.id and nin_identifier.identifier_type = 'nin'
                        and nin_identifier.verified and nin_identifier.revoked_at is null) as nin_checked,
             ordering.ord_position
        from unnest(found_ids) with ordinality ordering(id, ord_position)
        join identity.patients patient on patient.id = ordering.id
       order by ordering.ord_position
    loop
      token := 'psr_' || translate(encode(public.gen_random_bytes(32), 'base64'), '+/=', '-_');
      insert into identity.patient_search_refs (token_sha256, patient_id, account_id, membership_id, facility_id,
        purpose_of_use, search_mode, created_at, expires_at)
      values (encode(sha256(convert_to(token, 'UTF8')), 'hex'), patient_row.id, actor_account, actor_membership,
        actor_facility, actor_purpose, requested_mode, ref_expiry, ref_expiry + interval '10 minutes');
      insert into audit.events (
        correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
        organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
        purpose_of_use, provenance, source_system, details
      ) values (
        actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
        actor_organization, actor_facility, patient_row.id, action_value || '.shown', 'success',
        'patient', patient_row.id::text, actor_purpose, 'application', 'identity-api',
        jsonb_build_object('mode', requested_mode, 'reach', reach_value, 'criteria', to_jsonb(kinds))
      );
      shown_ids := shown_ids || patient_row.id;
      outcome := 'found'; reach := reach_value; match_ref := token; full_name := patient_row.full_name;
      sex := patient_row.gender; date_of_birth := patient_row.dob;
      health_id_last4 := right(patient_row.hid_code, 4); nin_verified := patient_row.nin_checked;
      match_ref_expires_at := ref_expiry + interval '10 minutes'; record_kind := patient_row.record_kind;
      return next;
    end loop;
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, null, action_value,
    case when outcome_value = 'too_broad' then 'denied' else 'success' end,
    'patient-search', null, actor_purpose, case when emergency then reason_value end, 'application', 'identity-api',
    jsonb_build_object('mode', requested_mode, 'reach', reach_value, 'criteria', to_jsonb(kinds),
      'criteriaHash', requested_criteria_hash, 'outcome', outcome_value,
      'resultCount', cardinality(shown_ids), 'patientIds', to_jsonb(shown_ids))
  );

  if outcome_value <> 'found' then
    outcome := outcome_value; reach := reach_value; match_ref := null; full_name := null; sex := null;
    date_of_birth := null; health_id_last4 := null; nin_verified := null; match_ref_expires_at := null;
    record_kind := null;
    return next;
  end if;
end
$$;

comment on function identity.staff_patient_search(text, text, text, date, text, text[], text, text) is
  '0132 (ID-3a, ID-3b; owner decisions of 18 November 2026), with 0145 (ID-7): staff patient search. standard (identity.registration.write, direct care): strong keys (first + last name + date of birth; Health ID + last name or date of birth; phone + last name) find any active standard patient, weak keys (last name + date of birth; phone; Health ID) only this facility''s own patients (0131 basis); a Health ID alone also finds this facility''s unknown records; at most 10 cards. emergency (identity.break-glass.write, emergency purpose, break_glass_enabled, a reason of 8-500 characters): exact first + last name + date of birth only, standard records only, at most 5 cards. Outcomes found, no_match, no_such_health_id, too_many, too_broad. Cards carry a 10-minute matchRef and the record kind, never a Health ID or patient id. Audited per search (key kinds and the caller''s keyed hash, never the values) and per patient shown.';

-- 6. The NIN-link pre-check (D6): 0138's text with 'unknown_record'.
create or replace function identity.patient_nin_link_precheck(
  requested_patient_id uuid, requested_lookup_hmac char(64),
  requested_idempotency_key text, requested_request_sha256 char(64)
) returns table (decision text, first_name text, last_name text, date_of_birth date)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  patient_value uuid;
  stored_sha256 char(64);
  stored_patient uuid;
  existing_hmac char(64);
begin
  if actor_account is null or actor_membership is null or actor_facility is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not exists (select 1 from identity.staff_facility_memberships membership
                     where membership.id = actor_membership and membership.account_id = actor_account
                       and membership.facility_id = actor_facility and membership.active
                       and membership.migration_hold_reason is null)
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
                                           'identity.registration.write') then
    raise exception using errcode = '42501', message = 'NIN_LINK_DENIED';
  end if;
  if requested_patient_id is null or requested_lookup_hmac is null or requested_lookup_hmac !~ '^[0-9a-f]{64}$'
     or requested_idempotency_key is null
     or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'NIN_LINK_INVALID';
  end if;
  select link.request_sha256, link.patient_id into stored_sha256, stored_patient
    from identity.patient_nin_links link
   where link.actor_account_id = actor_account and link.idempotency_key = requested_idempotency_key;
  if found then
    return query select case when stored_sha256 = requested_request_sha256 and stored_patient = requested_patient_id
                             then 'replay' else 'key_reused' end, null::text, null::text, null::date;
    return;
  end if;
  select patient.id into patient_value
    from identity.patients patient
   where patient.id = requested_patient_id and patient.status = 'active'
     and identity.sealed_demo_facility(actor_facility) = identity.sealed_demo_patient(patient.id)
     and identity.sealed_qa_facility(actor_facility) = identity.sealed_qa_patient(patient.id);
  if patient_value is null then
    return query select 'not_found'::text, null::text, null::text, null::date;
    return;
  end if;
  if identity.own_facility_basis(patient_value, actor_facility) is null then
    return query select 'not_permitted'::text, null::text, null::text, null::date;
    return;
  end if;
  -- 0145 (ID-7): this facility's record that is still unknown is identified
  -- first (another facility got not_permitted above, as for any patient).
  if exists (select 1 from identity.unknown_patients unknown_record
              where unknown_record.patient_id = patient_value and unknown_record.status <> 'identified') then
    return query select 'unknown_record'::text, null::text, null::text, null::date;
    return;
  end if;
  select identifier.lookup_hmac into existing_hmac
    from identity.patient_identifiers identifier
   where identifier.patient_id = patient_value and identifier.identifier_type = 'nin'
     and identifier.verified and identifier.revoked_at is null
   order by identifier.lookup_hmac = requested_lookup_hmac desc
   limit 1;
  if existing_hmac is not null then
    return query select case when existing_hmac = requested_lookup_hmac then 'already_linked' else 'has_nin' end,
                        null::text, null::text, null::date;
    return;
  end if;
  -- The legacy crosswalk (0057, as 0058 and 0092 keep it): not while its NIN
  -- inventory is incomplete (identity.legacy_nin_crosswalk_ready()), and
  -- never a NIN other than the one attested for this patient.
  if not identity.legacy_nin_crosswalk_ready() then
    return query select 'try_later'::text, null::text, null::text, null::date;
    return;
  end if;
  if exists (select 1 from migration.legacy_nin_crosswalk crosswalk
              where crosswalk.patient_id = patient_value and crosswalk.status = 'active'
                and crosswalk.nin_state = 'attested_exact'
                and crosswalk.nin_lookup_hmac is distinct from requested_lookup_hmac) then
    return query select 'source_nin_differs'::text, null::text, null::text, null::date;
    return;
  end if;
  -- Eligible: the record's name and date of birth, which identity-api
  -- compares with the NIN record (either order, as the patient's own check).
  return query select 'eligible'::text, patient.first_name, patient.last_name, patient.dob
    from identity.patients patient where patient.id = patient_value;
end;
$$;

-- 7. The commands (D7-D10).

-- The caller of every command: a staff session at its facility for
-- healthcare-operations, an active unheld membership there, the permission.
create function identity.unknown_patient_actor(required_permission text,
  out actor_subject text, out actor_account uuid, out actor_membership uuid, out actor_facility uuid,
  out actor_organization uuid, out actor_correlation text)
returns record
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  actor_subject := platform.current_actor_subject();
  actor_account := auth.account_id_for_subject(actor_subject);
  actor_membership := platform.current_membership_id();
  actor_facility := platform.current_facility_id();
  actor_correlation := platform.current_correlation_id();
  select membership.organization_id into actor_organization
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.account_id = actor_account
     and membership.facility_id = actor_facility and membership.active
     and membership.migration_hold_reason is null;
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or actor_organization is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, required_permission) then
    raise exception using errcode = '42501', message = 'UNKNOWN_PATIENT_DENIED';
  end if;
end
$$;

-- One audit row of these routes, as the caller (ids, kinds and counts only).
create function identity.unknown_patient_audit(actor_subject text, actor_account uuid, actor_membership uuid,
  actor_facility uuid, actor_organization uuid, actor_correlation text, audit_action text, audit_outcome text,
  audit_patient uuid, audit_reason text, audit_details jsonb)
returns void
language sql
volatile
set search_path = pg_catalog, pg_temp
as $$
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, audit_patient, audit_action, audit_outcome, 'unknown-patient',
    audit_patient::text, 'healthcare-operations', audit_reason, 'application', 'identity-api', audit_details
  )
$$;

-- The cards of the given records, in the given order. While a record is
-- unknown its name is "Unknown patient" and its label, never the
-- placeholders in first_name and last_name.
create function identity.unknown_patient_cards(requested_ids uuid[])
returns table (ord bigint, patient_id uuid, record_kind text, label text, display_name text, sex text,
  date_of_birth date, dob_estimated boolean, health_id_last4 text, unknown_reason text, status text,
  created_at timestamptz, row_version bigint, nin_verified boolean)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select ordering.ord_position, unknown_record.patient_id,
         case when unknown_record.status = 'identified' then 'standard' else 'unknown' end, unknown_record.label,
         case when unknown_record.status = 'identified' then patient.full_name
              else 'Unknown patient ' || unknown_record.label end,
         patient.gender, patient.dob, unknown_record.status <> 'identified' and patient.dob is not null,
         right(patient.hid_code, 4),
         unknown_record.unknown_reason, unknown_record.status, unknown_record.created_at,
         unknown_record.row_version,
         exists (select 1 from identity.patient_identifiers identifier
                  where identifier.patient_id = unknown_record.patient_id and identifier.identifier_type = 'nin'
                    and identifier.verified and identifier.revoked_at is null)
    from unnest(requested_ids) with ordinality ordering(id, ord_position)
    join identity.unknown_patients unknown_record on unknown_record.patient_id = ordering.id
    join identity.patients patient on patient.id = unknown_record.patient_id
   order by ordering.ord_position
$$;

-- 7a. Make an unknown record (identity.registration.write).
create function identity.create_unknown_patient(
  requested_patient_id uuid, requested_hid_code text, requested_gender text, requested_estimated_age integer,
  requested_reason text, requested_note_ciphertext bytea, requested_note_key_version text,
  requested_idempotency_key text, requested_request_sha256 text)
returns table (patient_id uuid, hid_code text, record_kind text, label text, display_name text, sex text,
  date_of_birth date, dob_estimated boolean, status text, created_at timestamptz, row_version bigint,
  facility_daily_count integer, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
  lagos_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  existing identity.unknown_patients%rowtype;
  next_number integer;
  label_value text;
  birth_date date;
  daily_count integer;
begin
  select * into actor from identity.unknown_patient_actor('identity.registration.write');
  if identity.sealed_demo_facility(actor.actor_facility) then
    raise exception using errcode = '42501', message = 'UNKNOWN_PATIENT_SEALED_FACILITY';
  end if;
  if requested_patient_id is null
     or coalesce(requested_hid_code, '') !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'
     or requested_gender is null or requested_gender not in ('female', 'male', 'intersex', 'other', 'unknown')
     or (requested_estimated_age is not null and requested_estimated_age not between 0 and 120)
     or requested_reason is null
     or requested_reason not in ('unconscious', 'confused', 'unaccompanied_child', 'cannot_communicate', 'other')
     or (requested_note_ciphertext is null) <> (requested_note_key_version is null)
     or coalesce(requested_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or coalesce(requested_request_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'UNKNOWN_PATIENT_INVALID';
  end if;

  -- One record at a time per facility: the label, the replay and the count.
  perform pg_advisory_xact_lock(hashtextextended('unknown-patient-facility:' || actor.actor_facility::text, 146));
  select unknown_record.* into existing from identity.unknown_patients unknown_record
   where unknown_record.created_by_account_id = actor.actor_account
     and unknown_record.facility_id = actor.actor_facility
     and unknown_record.idempotency_key = requested_idempotency_key;
  if found then
    if existing.request_sha256 <> requested_request_sha256 then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    -- A replay answers the Health ID and the card again, so it is audited too.
    perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_facility, actor.actor_organization, actor.actor_correlation, 'identity.unknown-patient.create',
      'success', existing.patient_id, null, jsonb_build_object('replayed', true, 'status', existing.status));
    return query select card.patient_id, patient.hid_code, card.record_kind, card.label, card.display_name,
        card.sex, card.date_of_birth, card.dob_estimated, card.status, card.created_at, card.row_version,
        null::integer, true
      from identity.unknown_patient_cards(array[existing.patient_id]) card
      join identity.patients patient on patient.id = card.patient_id;
    return;
  end if;

  select coalesce(max(unknown_record.label_number), 0) + 1 into next_number
    from identity.unknown_patients unknown_record where unknown_record.facility_id = actor.actor_facility;
  label_value := 'U-' || case when next_number < 10000 then lpad(next_number::text, 4, '0') else next_number::text end;
  select count(*)::integer into daily_count
    from identity.unknown_patients unknown_record
   where unknown_record.facility_id = actor.actor_facility
     and unknown_record.created_at >= (lagos_today::timestamp at time zone 'Africa/Lagos');
  -- 1 July of (this Lagos year minus the age); never after today (age 0 before July).
  if requested_estimated_age is not null then
    birth_date := least(make_date(extract(year from lagos_today)::integer - requested_estimated_age, 7, 1),
                        lagos_today);
  end if;

  insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status,
    source_system)
  values (requested_patient_id, requested_hid_code, 'Unknown', label_value, 'Unknown patient ' || label_value,
    birth_date, requested_gender, 'active', 'hid-unknown-patient');
  -- At the sealed QA facility the record is a sealed QA patient (D10).
  if identity.sealed_qa_facility(actor.actor_facility) then
    insert into identity.sealed_qa_members (member_kind, member_id) values ('patient', requested_patient_id);
  end if;
  insert into identity.unknown_patients (patient_id, facility_id, label_number, unknown_reason,
    arrival_note_ciphertext, arrival_note_key_version, created_by_account_id, created_by_membership_id,
    idempotency_key, request_sha256)
  values (requested_patient_id, actor.actor_facility, next_number, requested_reason, requested_note_ciphertext,
    requested_note_key_version, actor.actor_account, actor.actor_membership, requested_idempotency_key,
    requested_request_sha256);
  perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
    actor.actor_facility, actor.actor_organization, actor.actor_correlation, 'identity.unknown-patient.create',
    'success', requested_patient_id, null,
    jsonb_build_object('unknownReason', requested_reason, 'dateOfBirthEstimated', birth_date is not null,
      'arrivalNoteRecorded', requested_note_ciphertext is not null, 'facilityDailyCount', daily_count + 1,
      'sealedQa', identity.sealed_qa_facility(actor.actor_facility)));
  return query select card.patient_id, requested_hid_code, card.record_kind, card.label, card.display_name,
      card.sex, card.date_of_birth, card.dob_estimated, card.status, card.created_at, card.row_version,
      daily_count + 1, false
    from identity.unknown_patient_cards(array[requested_patient_id]) card;
end
$$;

-- 7b. This facility's unknown records, newest first (identity.registration.write).
-- status 'open': still unknown (open or sent_for_review); 'all': every one.
create function identity.list_unknown_patients(requested_status text, requested_limit integer,
  requested_after_created_at timestamptz, requested_after_patient_id uuid)
returns table (patient_id uuid, record_kind text, label text, display_name text, sex text, date_of_birth date,
  dob_estimated boolean, health_id_last4 text, unknown_reason text, status text, created_at timestamptz,
  row_version bigint, nin_verified boolean, has_more boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
  found_ids uuid[];
  more boolean;
  shown uuid;
begin
  select * into actor from identity.unknown_patient_actor('identity.registration.write');
  if requested_status is null or requested_status not in ('open', 'all')
     or requested_limit is null or requested_limit not between 1 and 100
     or (requested_after_created_at is null) <> (requested_after_patient_id is null) then
    raise exception using errcode = '22023', message = 'UNKNOWN_PATIENT_INVALID';
  end if;
  select array_agg(page.patient_id order by page.created_at desc, page.patient_id desc) into found_ids
    from (select unknown_record.patient_id, unknown_record.created_at
            from identity.unknown_patients unknown_record
           where unknown_record.facility_id = actor.actor_facility
             and (requested_status = 'all' or unknown_record.status in ('open', 'sent_for_review'))
             and (requested_after_created_at is null
                  or (unknown_record.created_at, unknown_record.patient_id)
                     < (requested_after_created_at, requested_after_patient_id))
           order by unknown_record.created_at desc, unknown_record.patient_id desc
           limit requested_limit + 1) page;
  found_ids := coalesce(found_ids, array[]::uuid[]);
  more := cardinality(found_ids) > requested_limit;
  if more then
    found_ids := found_ids[1:requested_limit];
  end if;
  perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
    actor.actor_facility, actor.actor_organization, actor.actor_correlation, 'identity.unknown-patient.list',
    'success', null, null,
    jsonb_build_object('status', requested_status, 'resultCount', cardinality(found_ids), 'hasMore', more,
      'patientIds', to_jsonb(found_ids)));
  foreach shown in array found_ids loop
    perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_facility, actor.actor_organization, actor.actor_correlation,
      'identity.unknown-patient.list.shown', 'success', shown, null, jsonb_build_object('status', requested_status));
  end loop;
  return query select card.patient_id, card.record_kind, card.label, card.display_name, card.sex,
      card.date_of_birth, card.dob_estimated, card.health_id_last4, card.unknown_reason, card.status,
      card.created_at, card.row_version, card.nin_verified, more
    from identity.unknown_patient_cards(found_ids) card
   order by card.ord;
end
$$;

-- Why a record is not this facility's unknown record, for the audit row.
create function identity.unknown_patient_missing_reason(requested_patient_id uuid, requested_facility_id uuid)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when requested_patient_id is null then 'no_patient_id'
    when exists (select 1 from identity.unknown_patients unknown_record
                  where unknown_record.patient_id = requested_patient_id
                    and unknown_record.facility_id <> requested_facility_id) then 'other_facility'
    when exists (select 1 from identity.patients patient where patient.id = requested_patient_id) then 'not_unknown_record'
    else 'no_such_patient' end
$$;

-- 7c. One record, with its arrival note's ciphertext (identity.registration.write).
create function identity.read_unknown_patient(requested_patient_id uuid)
returns table (outcome text, patient_id uuid, record_kind text, label text, display_name text, sex text,
  date_of_birth date, dob_estimated boolean, health_id_last4 text, unknown_reason text, status text,
  created_at timestamptz, row_version bigint, nin_verified boolean, arrival_note_ciphertext bytea,
  arrival_note_key_version text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
  record_row identity.unknown_patients%rowtype;
begin
  select * into actor from identity.unknown_patient_actor('identity.registration.write');
  select unknown_record.* into record_row from identity.unknown_patients unknown_record
   where unknown_record.patient_id = requested_patient_id and unknown_record.facility_id = actor.actor_facility;
  if not found then
    perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_facility, actor.actor_organization, actor.actor_correlation, 'identity.unknown-patient.read',
      'denied', null, null,
      jsonb_build_object('refusal', 'not_found',
        'notFoundReason', identity.unknown_patient_missing_reason(requested_patient_id, actor.actor_facility)));
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text, null::date,
      null::boolean, null::text, null::text, null::text, null::timestamptz, null::bigint, null::boolean,
      null::bytea, null::text;
    return;
  end if;
  perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
    actor.actor_facility, actor.actor_organization, actor.actor_correlation, 'identity.unknown-patient.read',
    'success', record_row.patient_id, null,
    jsonb_build_object('status', record_row.status, 'arrivalNoteShown', record_row.arrival_note_ciphertext is not null));
  return query select 'found'::text, card.patient_id, card.record_kind, card.label, card.display_name, card.sex,
      card.date_of_birth, card.dob_estimated, card.health_id_last4, card.unknown_reason, card.status,
      card.created_at, card.row_version, card.nin_verified, record_row.arrival_note_ciphertext,
      record_row.arrival_note_key_version
    from identity.unknown_patient_cards(array[record_row.patient_id]) card;
end
$$;

-- 7d. Identify (identity.registration.write): 0130's possible-duplicate rule.
create function identity.identify_unknown_patient(
  requested_patient_id uuid, requested_expected_version bigint, requested_first_name text,
  requested_last_name text, requested_dob date, requested_gender text, requested_phone_lookup_hmacs text,
  requested_phone_ciphertext bytea, requested_address_ciphertext bytea, requested_contact_key_version text,
  requested_idempotency_key text, requested_request_sha256 text)
returns table (outcome text, patient_id uuid, record_kind text, label text, display_name text, sex text,
  date_of_birth date, dob_estimated boolean, status text, row_version bigint, candidate_count integer,
  replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
  lagos_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  first_value text := btrim(coalesce(requested_first_name, ''));
  last_value text := btrim(coalesce(requested_last_name, ''));
  phone_hmacs character(64)[];
  has_contact boolean := requested_phone_ciphertext is not null;
  record_row identity.unknown_patients%rowtype;
  candidate_json jsonb;
  candidates_found integer;
  open_cases integer;
  kinds text[];
  qa_facility boolean;
  demo_facility boolean;
  identified boolean;
begin
  select * into actor from identity.unknown_patient_actor('identity.registration.write');
  if requested_expected_version is null
     or length(first_value) not between 1 and 100 or length(last_value) not between 1 and 100
     or requested_dob is null or requested_dob < date '1900-01-01' or requested_dob > lagos_today
     or (requested_gender is not null and requested_gender not in ('female', 'male', 'intersex', 'other', 'unknown'))
     or coalesce(requested_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or coalesce(requested_request_sha256, '') !~ '^[0-9a-f]{64}$'
     or (requested_phone_ciphertext is null) <> (requested_address_ciphertext is null)
     or (requested_phone_ciphertext is null) <> (requested_contact_key_version is null)
     or (requested_phone_ciphertext is null) <> (requested_phone_lookup_hmacs is null)
     or (requested_phone_lookup_hmacs is not null
         and requested_phone_lookup_hmacs !~ '^[0-9a-f]{64}(,[0-9a-f]{64})?$') then
    raise exception using errcode = '22023', message = 'UNKNOWN_PATIENT_INVALID';
  end if;
  -- As ID-2 (owner Q106): a phone and address, except for a child (under 18 on today's Lagos date).
  if not has_contact and requested_dob <= (lagos_today - interval '18 years')::date then
    raise exception using errcode = '22023', message = 'UNKNOWN_PATIENT_PHONE_REQUIRED';
  end if;
  if requested_phone_lookup_hmacs is not null then
    phone_hmacs := string_to_array(requested_phone_lookup_hmacs, ',')::character(64)[];
  end if;

  select unknown_record.* into record_row from identity.unknown_patients unknown_record
   where unknown_record.patient_id = requested_patient_id and unknown_record.facility_id = actor.actor_facility
   for update;
  if not found then
    perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_facility, actor.actor_organization, actor.actor_correlation, 'identity.unknown-patient.identify',
      'denied', null, null,
      jsonb_build_object('refusal', 'not_found',
        'notFoundReason', identity.unknown_patient_missing_reason(requested_patient_id, actor.actor_facility)));
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text, null::date,
      null::boolean, null::text, null::bigint, null::integer, false;
    return;
  end if;
  if record_row.identify_idempotency_key = requested_idempotency_key then
    if record_row.identify_request_sha256 <> requested_request_sha256 then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    -- A record cancelled since (from sent_for_review) is refused as a fresh
    -- identify is, never answered "identified" again.
    if record_row.status = 'cancelled' then
      raise exception using errcode = 'P0001', message = 'UNKNOWN_PATIENT_CANCELLED';
    end if;
    perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_facility, actor.actor_organization, actor.actor_correlation, 'identity.unknown-patient.identify',
      'success', record_row.patient_id, null, jsonb_build_object('replayed', true, 'status', record_row.status));
    return query select case when record_row.status = 'sent_for_review' then 'sent_for_review' else 'identified' end,
        card.patient_id, card.record_kind, card.label, card.display_name, card.sex, card.date_of_birth,
        card.dob_estimated, card.status, card.row_version, record_row.candidate_count, true
      from identity.unknown_patient_cards(array[record_row.patient_id]) card;
    return;
  end if;
  if record_row.status <> 'open' then
    raise exception using errcode = 'P0001',
      message = case when record_row.status = 'cancelled' then 'UNKNOWN_PATIENT_CANCELLED'
                     else 'UNKNOWN_PATIENT_ALREADY_IDENTIFIED' end;
  end if;
  if record_row.row_version <> requested_expected_version then
    raise exception using errcode = '40001', message = 'VERSION_CONFLICT';
  end if;

  -- 0130's rule, with the same lock on the date of birth, so a desk
  -- registration of the same person at the same moment sees this one.
  perform pg_advisory_xact_lock(hashtextextended('no-nin-registration-dob:' || requested_dob::text, 0));
  qa_facility := identity.sealed_qa_facility(actor.actor_facility);
  demo_facility := identity.sealed_demo_facility(actor.actor_facility);
  select coalesce(jsonb_agg(jsonb_build_object('patientId', ranked.patient_id, 'score', ranked.score,
           'reasons', to_jsonb(ranked.reasons)) order by ranked.score desc, ranked.patient_id), '[]'::jsonb)
    into candidate_json
    from (
      select hits.patient_id, max(hits.score) as score,
             array_agg(distinct hits.reason order by hits.reason) as reasons
        from (
          select patient.id as patient_id, 90 as score, unnest(case
                   when lower(patient.first_name) = lower(first_value)
                     then array['date_of_birth', 'first_name', 'last_name']
                   else array['date_of_birth', 'last_name'] end) as reason
            from identity.patients patient
           where patient.status = 'active' and patient.dob = requested_dob
             and lower(patient.last_name) = lower(last_value)
             and not exists (select 1 from identity.unknown_patients unknown_record
                                where unknown_record.patient_id = patient.id and unknown_record.status <> 'identified')
          union all
          select patient.id, 85, unnest(array['date_of_birth', 'first_name', 'last_name'])
            from identity.patients patient
           where patient.status = 'active' and patient.dob = requested_dob
             and lower(patient.last_name) = lower(first_value) and lower(patient.first_name) = lower(last_value)
             and not exists (select 1 from identity.unknown_patients unknown_record
                                where unknown_record.patient_id = patient.id and unknown_record.status <> 'identified')
          union all
          select patient.id, 80, 'phone'
            from identity.patients patient
           where phone_hmacs is not null and patient.status = 'active'
             and patient.phone_lookup_hmac = any (phone_hmacs)
             and not exists (select 1 from identity.unknown_patients unknown_record
                                where unknown_record.patient_id = patient.id and unknown_record.status <> 'identified')
          union all
          select lookup.patient_id, 80, 'phone'
            from identity.desk_registration_phone_lookups lookup
            join identity.patients patient on patient.id = lookup.patient_id and patient.status = 'active'
           where phone_hmacs is not null and lookup.phone_lookup_hmac = any (phone_hmacs)
             and not exists (select 1 from identity.unknown_patients unknown_record
                                where unknown_record.patient_id = patient.id and unknown_record.status <> 'identified')
          union all
          -- An identified record's phone given at identify, held on its row (D2).
          select other_record.patient_id, 80, 'phone'
            from identity.unknown_patients other_record
            join identity.patients patient on patient.id = other_record.patient_id and patient.status = 'active'
           where phone_hmacs is not null and other_record.status = 'identified'
             and other_record.contact_phone_lookup_hmac = any (phone_hmacs)
        ) hits
       where hits.patient_id <> record_row.patient_id
         and identity.sealed_demo_patient(hits.patient_id) = demo_facility
         and identity.sealed_qa_patient(hits.patient_id) = qa_facility
       group by hits.patient_id
       order by max(hits.score) desc, hits.patient_id
       limit 20
    ) ranked;
  candidates_found := jsonb_array_length(candidate_json);
  -- Open registrations without a NIN, and other unknown records in review,
  -- that look like the same person, at facilities of this facility's seal
  -- only (a QA record never sees, or is seen by, a real one).
  select (select count(*)::integer
            from identity.registration_cases registration
           where registration.identity_evidence = 'none' and registration.status = 'review_required'
             and identity.sealed_qa_facility(registration.facility_id) = qa_facility
             and identity.sealed_demo_facility(registration.facility_id) = demo_facility
             and ((registration.dob = requested_dob and lower(registration.last_name) = lower(last_value))
                  or (phone_hmacs is not null and exists (
                    select 1 from identity.desk_registration_phone_lookups lookup
                     where lookup.registration_case_id = registration.id
                       and lookup.phone_lookup_hmac = any (phone_hmacs)))))
       + (select count(*)::integer
            from identity.unknown_patients other_record
           where other_record.status = 'sent_for_review' and other_record.patient_id <> record_row.patient_id
             and identity.sealed_qa_facility(other_record.facility_id) = qa_facility
             and identity.sealed_demo_facility(other_record.facility_id) = demo_facility
             and ((other_record.proposed_dob = requested_dob
                   and lower(other_record.proposed_last_name) = lower(last_value))
                  or (phone_hmacs is not null and other_record.contact_phone_lookup_hmac = any (phone_hmacs))))
    into open_cases;
  kinds := array_remove(array[
    case when exists (select 1 from jsonb_array_elements(candidate_json) item where item -> 'reasons' ? 'date_of_birth')
      then 'name_and_date_of_birth' end,
    case when exists (select 1 from jsonb_array_elements(candidate_json) item where item -> 'reasons' ? 'phone')
      then 'phone' end,
    case when open_cases > 0 then 'open_registration' end], null);
  identified := candidates_found = 0 and open_cases = 0;

  if identified then
    update identity.patients patient
       set first_name = first_value, last_name = last_value, full_name = first_value || ' ' || last_value,
           dob = requested_dob, gender = coalesce(requested_gender, patient.gender),
           updated_at = clock_timestamp(), row_version = patient.row_version + 1
     where patient.id = record_row.patient_id;
  end if;
  update identity.unknown_patients unknown_record
     set status = case when identified then 'identified' else 'sent_for_review' end,
         identified_by_account_id = actor.actor_account, identified_by_membership_id = actor.actor_membership,
         identified_at = clock_timestamp(), identify_idempotency_key = requested_idempotency_key,
         identify_request_sha256 = requested_request_sha256,
         proposed_first_name = first_value, proposed_last_name = last_value, proposed_dob = requested_dob,
         proposed_gender = requested_gender, contact_phone_ciphertext = requested_phone_ciphertext,
         contact_address_ciphertext = requested_address_ciphertext,
         contact_key_version = requested_contact_key_version, contact_phone_lookup_hmac = phone_hmacs[1],
         candidate_count = candidates_found,
         candidates = candidate_json,
         open_registration_count = open_cases,
         updated_at = clock_timestamp(), row_version = unknown_record.row_version + 1
   where unknown_record.patient_id = record_row.patient_id;
  perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
    actor.actor_facility, actor.actor_organization, actor.actor_correlation, 'identity.unknown-patient.identify',
    'success', record_row.patient_id, null,
    jsonb_build_object('outcome', case when identified then 'identified' else 'sent_for_review' end,
      'candidateCount', candidates_found,
      'candidatePatientIds', (select coalesce(jsonb_agg(item -> 'patientId'), '[]'::jsonb)
                                from jsonb_array_elements(candidate_json) item),
      'openRegistrationCount', open_cases, 'duplicateKinds', to_jsonb(kinds), 'contactRecorded', has_contact));
  return query select case when identified then 'identified' else 'sent_for_review' end,
      card.patient_id, card.record_kind, card.label, card.display_name, card.sex, card.date_of_birth,
      card.dob_estimated, card.status, card.row_version, candidates_found, false
    from identity.unknown_patient_cards(array[record_row.patient_id]) card;
end
$$;

-- 7e. An approver's decision (identity.registration.approve):
-- confirm_separate applies the held details; cancel makes the patient
-- inactive while nothing clinical is attached.
create function identity.decide_unknown_patient(
  requested_patient_id uuid, requested_decision text, requested_expected_version bigint, requested_reason text,
  requested_idempotency_key text, requested_request_sha256 text)
returns table (outcome text, patient_id uuid, record_kind text, label text, display_name text, sex text,
  date_of_birth date, dob_estimated boolean, status text, row_version bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
  reason_value text := btrim(coalesce(requested_reason, ''));
  action_value text;
  record_row identity.unknown_patients%rowtype;
  queue_entry record;
  queue_closed integer := 0;
begin
  select * into actor from identity.unknown_patient_actor('identity.registration.approve');
  if requested_decision is null or requested_decision not in ('confirm_separate', 'cancel') then
    raise exception using errcode = '22023', message = 'UNKNOWN_PATIENT_INVALID';
  end if;
  action_value := case requested_decision when 'confirm_separate' then 'identity.unknown-patient.confirm-separate'
                  else 'identity.unknown-patient.cancel' end;
  if requested_expected_version is null or length(reason_value) not between 8 and 500
     or coalesce(requested_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or coalesce(requested_request_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'UNKNOWN_PATIENT_INVALID';
  end if;
  select unknown_record.* into record_row from identity.unknown_patients unknown_record
   where unknown_record.patient_id = requested_patient_id and unknown_record.facility_id = actor.actor_facility
   for update;
  if not found then
    perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_facility, actor.actor_organization, actor.actor_correlation, action_value, 'denied', null, null,
      jsonb_build_object('refusal', 'not_found',
        'notFoundReason', identity.unknown_patient_missing_reason(requested_patient_id, actor.actor_facility)));
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text, null::date,
      null::boolean, null::text, null::bigint, false;
    return;
  end if;
  if record_row.decision_idempotency_key = requested_idempotency_key then
    if record_row.decision_request_sha256 <> requested_request_sha256
       or record_row.decision is distinct from
          (case requested_decision when 'confirm_separate' then 'confirmed_separate' else 'cancelled' end) then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_facility, actor.actor_organization, actor.actor_correlation, action_value, 'success',
      record_row.patient_id, null, jsonb_build_object('replayed', true, 'status', record_row.status));
    return query select case when requested_decision = 'cancel' then 'cancelled' else 'identified' end,
        card.patient_id, card.record_kind, card.label, card.display_name, card.sex, card.date_of_birth,
        card.dob_estimated, card.status, card.row_version, true
      from identity.unknown_patient_cards(array[record_row.patient_id]) card;
    return;
  end if;
  if requested_decision = 'confirm_separate' then
    if record_row.status <> 'sent_for_review' then
      raise exception using errcode = 'P0001',
        message = case when record_row.status = 'cancelled' then 'UNKNOWN_PATIENT_CANCELLED'
                       else 'UNKNOWN_PATIENT_NOT_IN_REVIEW' end;
    end if;
    if record_row.identified_by_account_id = actor.actor_account then
      raise exception using errcode = '42501', message = 'UNKNOWN_PATIENT_SECOND_PERSON_REQUIRED';
    end if;
  else
    if record_row.status not in ('open', 'sent_for_review') then
      raise exception using errcode = 'P0001',
        message = case when record_row.status = 'cancelled' then 'UNKNOWN_PATIENT_CANCELLED'
                       else 'UNKNOWN_PATIENT_ALREADY_IDENTIFIED' end;
    end if;
  end if;
  if record_row.row_version <> requested_expected_version then
    raise exception using errcode = '40001', message = 'VERSION_CONFLICT';
  end if;

  if requested_decision = 'confirm_separate' then
    update identity.patients patient
       set first_name = record_row.proposed_first_name, last_name = record_row.proposed_last_name,
           full_name = record_row.proposed_first_name || ' ' || record_row.proposed_last_name,
           dob = record_row.proposed_dob, gender = coalesce(record_row.proposed_gender, patient.gender),
           updated_at = clock_timestamp(), row_version = patient.row_version + 1
     where patient.id = record_row.patient_id;
  else
    -- Nothing clinical may be attached, at any facility (D9). Only this
    -- check runs with the marker (D11).
    insert into ehr.unknown_patient_cancel_scans (backend_pid, transaction_started_at)
    values (pg_backend_pid(), transaction_timestamp()) on conflict do nothing;
    if exists (select 1 from ehr.encounters encounter
                where encounter.patient_id = record_row.patient_id
                  and encounter.status not in ('cancelled', 'entered_in_error'))
       or exists (select 1 from ehr.clinical_notes note where note.patient_id = record_row.patient_id)
       or exists (select 1 from ehr.vitals vital where vital.patient_id = record_row.patient_id)
       or exists (select 1 from ehr.prescriptions prescription where prescription.patient_id = record_row.patient_id)
       or exists (select 1 from ehr.lab_requests request where request.patient_id = record_row.patient_id)
       or exists (select 1 from ehr.diagnoses diagnosis where diagnosis.patient_id = record_row.patient_id)
       or exists (select 1 from ehr.recorded_allergies allergy where allergy.patient_id = record_row.patient_id)
       or exists (select 1 from ehr.documents document where document.patient_id = record_row.patient_id) then
      raise exception using errcode = 'P0001', message = 'UNKNOWN_PATIENT_HAS_RECORDS';
    end if;
    delete from ehr.unknown_patient_cancel_scans scan
     where scan.backend_pid = pg_backend_pid() and scan.transaction_started_at = transaction_timestamp();
    update identity.patients patient
       set status = 'inactive', updated_at = clock_timestamp(), row_version = patient.row_version + 1
     where patient.id = record_row.patient_id;
    -- An open waiting-list entry (0135) would point at a chart nobody can
    -- open: it is closed as cancelled, with 0135's own audit action.
    for queue_entry in
      update ehr.visit_queue entry
         set stage = 'cancelled', stage_changed_at = clock_timestamp(), closed_at = clock_timestamp(),
             updated_by_membership_id = actor.actor_membership, updated_at = clock_timestamp(),
             row_version = entry.row_version + 1
       where entry.patient_id = record_row.patient_id and entry.closed_at is null
      returning entry.id, entry.facility_id, entry.stage
    loop
      queue_closed := queue_closed + 1;
      insert into audit.events (
        correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
        organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
        purpose_of_use, provenance, source_system, details
      ) values (
        actor.actor_correlation, 'staff', actor.actor_subject, actor.actor_account, actor.actor_membership,
        actor.actor_organization, queue_entry.facility_id, record_row.patient_id, 'ehr.visit-queue.update',
        'success', 'visit-queue-entry', queue_entry.id::text, 'healthcare-operations', 'application',
        'identity-api', jsonb_build_object('outcome', 'updated', 'stage', 'cancelled',
          'closedBy', 'identity.unknown-patient.cancel'));
    end loop;
  end if;
  update identity.unknown_patients unknown_record
     set status = case when requested_decision = 'cancel' then 'cancelled' else 'identified' end,
         decision = case when requested_decision = 'cancel' then 'cancelled' else 'confirmed_separate' end,
         decided_by_account_id = actor.actor_account, decided_by_membership_id = actor.actor_membership,
         decided_at = clock_timestamp(), decision_reason = reason_value,
         decision_idempotency_key = requested_idempotency_key, decision_request_sha256 = requested_request_sha256,
         -- A cancelled record keeps no held details or contact (D9).
         proposed_first_name = case when requested_decision = 'cancel' then null else unknown_record.proposed_first_name end,
         proposed_last_name = case when requested_decision = 'cancel' then null else unknown_record.proposed_last_name end,
         proposed_dob = case when requested_decision = 'cancel' then null else unknown_record.proposed_dob end,
         proposed_gender = case when requested_decision = 'cancel' then null else unknown_record.proposed_gender end,
         contact_phone_ciphertext = case when requested_decision = 'cancel' then null
                                         else unknown_record.contact_phone_ciphertext end,
         contact_address_ciphertext = case when requested_decision = 'cancel' then null
                                           else unknown_record.contact_address_ciphertext end,
         contact_key_version = case when requested_decision = 'cancel' then null else unknown_record.contact_key_version end,
         contact_phone_lookup_hmac = case when requested_decision = 'cancel' then null
                                          else unknown_record.contact_phone_lookup_hmac end,
         updated_at = clock_timestamp(), row_version = unknown_record.row_version + 1
   where unknown_record.patient_id = record_row.patient_id;
  perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
    actor.actor_facility, actor.actor_organization, actor.actor_correlation, action_value, 'success',
    record_row.patient_id, reason_value,
    jsonb_build_object('previousStatus', record_row.status,
      'outcome', case when requested_decision = 'cancel' then 'cancelled' else 'identified' end)
      || case when requested_decision = 'cancel' then jsonb_build_object('waitingListEntriesClosed', queue_closed)
              else '{}'::jsonb end);
  return query select case when requested_decision = 'cancel' then 'cancelled' else 'identified' end,
      card.patient_id, card.record_kind, card.label, card.display_name, card.sex, card.date_of_birth,
      card.dob_estimated, card.status, card.row_version, false
    from identity.unknown_patient_cards(array[record_row.patient_id]) card;
end
$$;

-- 7f. The approver's review (identity.registration.approve): what
-- confirm-separate would confirm, and what it might duplicate. Only for a
-- record in review, and never for the member who identified it. One audit
-- row for the read, and one per candidate shown, naming that candidate.
create function identity.review_unknown_patient(requested_patient_id uuid)
returns table (outcome text, patient_id uuid, label text, status text, row_version bigint,
  proposed_first_name text, proposed_last_name text, proposed_date_of_birth date, proposed_sex text,
  identified_at timestamptz, open_registration_count integer, candidates jsonb)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor record;
  record_row identity.unknown_patients%rowtype;
  refusal text;
  shown_cards jsonb;
  shown_ids uuid[];
  shown uuid;
begin
  select * into actor from identity.unknown_patient_actor('identity.registration.approve');
  select unknown_record.* into record_row from identity.unknown_patients unknown_record
   where unknown_record.patient_id = requested_patient_id and unknown_record.facility_id = actor.actor_facility;
  if not found then
    perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_facility, actor.actor_organization, actor.actor_correlation, 'identity.unknown-patient.review',
      'denied', null, null,
      jsonb_build_object('refusal', 'not_found',
        'notFoundReason', identity.unknown_patient_missing_reason(requested_patient_id, actor.actor_facility)));
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::bigint, null::text, null::text,
      null::date, null::text, null::timestamptz, null::integer, null::jsonb;
    return;
  end if;
  refusal := case when record_row.status <> 'sent_for_review' then 'not_in_review'
                  when record_row.identified_by_account_id = actor.actor_account then 'second_person_required' end;
  if refusal is not null then
    perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_facility, actor.actor_organization, actor.actor_correlation, 'identity.unknown-patient.review',
      'denied', record_row.patient_id, null, jsonb_build_object('refusal', refusal, 'status', record_row.status));
    return query select refusal, record_row.patient_id, null::text, record_row.status, record_row.row_version,
      null::text, null::text, null::date, null::text, null::timestamptz, null::integer, null::jsonb;
    return;
  end if;
  -- Each candidate as it is now, if still a patient the facility's seal
  -- allows: full name, date of birth, sex, last 4 of the Health ID, why it
  -- matched and whether it is still active. Never its id or full Health ID.
  select coalesce(jsonb_agg(jsonb_build_object(
           'position', item.ord, 'fullName', patient.full_name, 'dateOfBirth', patient.dob, 'sex', patient.gender,
           'healthIdLast4', right(patient.hid_code, 4), 'matchReasons', item.value -> 'reasons',
           'active', patient.status = 'active') order by item.ord), '[]'::jsonb),
         coalesce(array_agg(patient.id order by item.ord), array[]::uuid[])
    into shown_cards, shown_ids
    from jsonb_array_elements(coalesce(record_row.candidates, '[]'::jsonb)) with ordinality item(value, ord)
    join identity.patients patient on patient.id = (item.value ->> 'patientId')::uuid
   where identity.sealed_qa_patient(patient.id) = identity.sealed_qa_facility(actor.actor_facility)
     and identity.sealed_demo_patient(patient.id) = identity.sealed_demo_facility(actor.actor_facility);
  perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
    actor.actor_facility, actor.actor_organization, actor.actor_correlation, 'identity.unknown-patient.review',
    'success', record_row.patient_id, null,
    jsonb_build_object('candidateCount', cardinality(shown_ids), 'candidatePatientIds', to_jsonb(shown_ids),
      'openRegistrationCount', record_row.open_registration_count));
  foreach shown in array shown_ids loop
    perform identity.unknown_patient_audit(actor.actor_subject, actor.actor_account, actor.actor_membership,
      actor.actor_facility, actor.actor_organization, actor.actor_correlation, 'identity.unknown-patient.review.shown',
      'success', shown, null, jsonb_build_object('unknownPatientId', record_row.patient_id));
  end loop;
  return query select 'found'::text, record_row.patient_id, record_row.label, record_row.status,
    record_row.row_version, record_row.proposed_first_name, record_row.proposed_last_name, record_row.proposed_dob,
    record_row.proposed_gender, record_row.identified_at, record_row.open_registration_count, shown_cards;
end
$$;

-- 8. The waiting list's record kinds (D12), for the EHR runtime.
create function ehr.visit_queue_record_kinds(requested_entry_ids uuid[])
returns table (entry_id uuid, record_kind text, dob_estimated boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
begin
  if actor_membership is null or actor_facility is null
     or not exists (select 1 from identity.staff_facility_memberships membership
                     where membership.id = actor_membership and membership.facility_id = actor_facility
                       and membership.account_id = auth.account_id_for_subject(actor_subject)
                       and membership.active and membership.migration_hold_reason is null)
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.encounter.read') then
    raise exception using errcode = '42501', message = 'VISIT_QUEUE_DENIED';
  end if;
  if coalesce(cardinality(requested_entry_ids), 0) > 500 then
    raise exception using errcode = '22023', message = 'VISIT_QUEUE_INVALID';
  end if;
  return query select entry.id,
      case when unknown_record.patient_id is null then 'standard' else 'unknown' end,
      unknown_record.patient_id is not null and patient.dob is not null
    from ehr.visit_queue entry
    join identity.patients patient on patient.id = entry.patient_id
    left join identity.unknown_patients unknown_record
      on unknown_record.patient_id = entry.patient_id and unknown_record.status <> 'identified'
   where entry.id = any (coalesce(requested_entry_ids, array[]::uuid[]))
     and entry.facility_id = actor_facility;
end
$$;

-- 9. The clinical tables' owner may read them during cancel's check only (D11).
create table ehr.unknown_patient_cancel_scans (
  backend_pid integer not null,
  transaction_started_at timestamptz not null,
  primary key (backend_pid, transaction_started_at)
);
revoke all on ehr.unknown_patient_cancel_scans from public;
create function ehr.unknown_patient_cancel_scan_open()
returns boolean
language sql
stable
security definer
cost 1
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from ehr.unknown_patient_cancel_scans scan
                  where scan.backend_pid = pg_backend_pid()
                    and scan.transaction_started_at = transaction_timestamp())
$$;
revoke all on function ehr.unknown_patient_cancel_scan_open() from public;
grant execute on function ehr.unknown_patient_cancel_scan_open() to public;
do $$
declare
  table_name text;
begin
  foreach table_name in array array['clinical_notes', 'diagnoses', 'documents', 'lab_requests', 'prescriptions',
                                    'recorded_allergies', 'vitals'] loop
    -- One scalar subquery with no outer reference: an InitPlan, so the test
    -- runs once per statement, never per row, for every role that reads the
    -- table, wherever it stands among the table's policies. The names sort
    -- before 0143's prescriptions_scan_my_orders and
    -- lab_requests_scan_my_orders, which 0143 requires to be asked first
    -- (its D1), whichever of the two files is applied first.
    execute format('create policy %I on ehr.%I for select using ((select case when pg_has_role((select relation.relowner '
      || 'from pg_class relation where relation.oid = %L::regclass), %L) '
      || 'then ehr.unknown_patient_cancel_scan_open() else false end))',
      table_name || '_cancel_check_read', table_name, 'ehr.' || table_name, 'USAGE');
  end loop;
end
$$;

-- 10. ID-2's registration (D13): 0130's text, with 0145's changes marked, and a trigger for every path that resolves a registration.
create or replace function identity.register_patient_without_nin(
  requested_case_id uuid,
  requested_first_name text,
  requested_last_name text,
  requested_dob date,
  requested_gender text,
  requested_no_nin_reason text,
  requested_phone_lookup_hmacs text,
  requested_phone_ciphertext bytea,
  requested_address_ciphertext bytea,
  requested_contact_key_version text,
  requested_stated_hid text,
  requested_idempotency_key text,
  requested_request_sha256 text,
  requested_hid_code text)
returns table (case_id uuid, case_status text, case_version bigint, subject_patient_id uuid,
  subject_hid_code text, candidate_count integer, facility_daily_count integer, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  actor_correlation text := platform.current_correlation_id();
  actor_organization uuid;
  lagos_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  first_value text := btrim(coalesce(requested_first_name, ''));
  last_value text := btrim(coalesce(requested_last_name, ''));
  stated_value text := upper(btrim(requested_stated_hid));
  phone_hmacs character(64)[];
  has_contact boolean := requested_phone_ciphertext is not null;
  existing identity.registration_cases%rowtype;
  facility_count integer;
  open_cases integer;
  candidates_found integer;
  candidate_json jsonb;
  new_patient uuid;
  desk_reason constant text := 'No possible duplicates: created at the desk without a NIN';
  kinds text[];
  stated_unknown_record uuid; -- 0145: another facility's unknown record, by the stated Health ID
begin
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not exists (select 1 from identity.staff_facility_memberships membership
                     where membership.id = actor_membership and membership.account_id = actor_account
                       and membership.facility_id = actor_facility and membership.active
                       and membership.migration_hold_reason is null)
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'identity.registration.write') then
    raise exception using errcode = '42501', message = 'NO_NIN_REGISTRATION_DENIED';
  end if;
  select membership.organization_id into actor_organization
    from identity.staff_facility_memberships membership where membership.id = actor_membership;
  if identity.sealed_demo_facility(actor_facility) or identity.sealed_qa_facility(actor_facility) then
    raise exception using errcode = '42501', message = 'NO_NIN_REGISTRATION_SEALED_FACILITY';
  end if;

  -- The request.
  if requested_case_id is null
     or length(first_value) not between 1 and 100 or length(last_value) not between 1 and 100
     or requested_dob is null or requested_dob < date '1900-01-01' or requested_dob > lagos_today
     or (requested_gender is not null and requested_gender not in ('female', 'male', 'intersex', 'other', 'unknown'))
     or requested_no_nin_reason is null
     or requested_no_nin_reason not in ('nin_service_unavailable', 'no_nin', 'not_carried', 'child', 'foreign_national')
     or coalesce(requested_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or coalesce(requested_request_sha256, '') !~ '^[0-9a-f]{64}$'
     or coalesce(requested_hid_code, '') !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'
     or (stated_value is not null and stated_value !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$')
     -- The phone and the address come together (0114's contact row), with their lookup.
     or (requested_phone_ciphertext is null) <> (requested_address_ciphertext is null)
     or (requested_phone_ciphertext is null) <> (requested_contact_key_version is null)
     or (requested_phone_ciphertext is null) <> (requested_phone_lookup_hmacs is null)
     or (requested_phone_lookup_hmacs is not null
         and requested_phone_lookup_hmacs !~ '^[0-9a-f]{64}(,[0-9a-f]{64})?$') then
    raise exception using errcode = '22023', message = 'NO_NIN_REGISTRATION_INVALID';
  end if;
  -- Owner Q106: a phone is required, except for a child (under 18 on today's Lagos date).
  if requested_no_nin_reason = 'child'
     and requested_dob <= (lagos_today - interval '18 years')::date then
    raise exception using errcode = '22023', message = 'NO_NIN_REGISTRATION_NOT_A_CHILD';
  end if;
  if requested_no_nin_reason <> 'child' and not has_contact then
    raise exception using errcode = '22023', message = 'NO_NIN_REGISTRATION_PHONE_REQUIRED';
  end if;
  if requested_phone_lookup_hmacs is not null then
    phone_hmacs := string_to_array(requested_phone_lookup_hmacs, ',')::character(64)[];
  end if;

  -- An idempotent retry.
  select * into existing from identity.registration_cases registration
   where registration.facility_id = actor_facility and registration.created_by_account_id = actor_account
     and registration.idempotency_key = requested_idempotency_key;
  if found then
    if existing.request_sha256 is distinct from requested_request_sha256 or existing.identity_evidence <> 'none' then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    -- 0145: a replay answers the patient and its Health ID again, so it is audited too.
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
      actor_organization, actor_facility, existing.resolved_patient_id, 'identity.registration.without-nin', 'success',
      'registration-case', existing.id::text, 'healthcare-operations', 'application', 'identity-api',
      jsonb_build_object('replayed', true, 'status', existing.status)
    );
    return query select existing.id, existing.status, existing.row_version, existing.resolved_patient_id,
      (select patient.hid_code from identity.patients patient where patient.id = existing.resolved_patient_id),
      (select count(*)::integer from identity.registration_case_candidates candidate where candidate.case_id = existing.id),
      null::integer, true;
    return;
  end if;

  -- No daily limit (owner Q109): the facility's count today is only for the
  -- operations alert, so it is read without a lock.
  select count(*) into facility_count
    from identity.registration_cases registration
   where registration.facility_id = actor_facility
     and registration.identity_evidence = 'none'
     and registration.created_at >= (lagos_today::timestamp at time zone 'Africa/Lagos');

  -- 0145 (ID-7, D13): a stated Health ID that is this facility's record that
  -- is still unknown is identified there, not registered again.
  if stated_value is not null and exists (
       select 1 from identity.patients patient
         join identity.unknown_patients unknown_record on unknown_record.patient_id = patient.id
        where upper(patient.hid_code) = stated_value and patient.status = 'active'
          and unknown_record.status <> 'identified' and unknown_record.facility_id = actor_facility) then
    raise exception using errcode = 'P0001', message = 'PATIENT_RECORD_UNKNOWN';
  end if;
  -- 0145 (ID-7, D13): a stated Health ID that is another facility's record
  -- that is still unknown is no candidate (this facility can neither
  -- identify nor link it before ID-8), but it sends the case to an approver,
  -- and the audit row names the record. A sealed record never counts (this
  -- facility is not sealed).
  if stated_value is not null then
    select patient.id into stated_unknown_record
      from identity.patients patient
      join identity.unknown_patients unknown_record on unknown_record.patient_id = patient.id
     where upper(patient.hid_code) = stated_value and patient.status = 'active'
       and unknown_record.status <> 'identified'
       and not identity.sealed_demo_patient(patient.id) and not identity.sealed_qa_patient(patient.id);
  end if;

  -- One registration without a NIN for a date of birth at a time, so two
  -- desks registering the same person see each other.
  perform pg_advisory_xact_lock(hashtextextended('no-nin-registration-dob:' || requested_dob::text, 0));

  select coalesce(jsonb_agg(jsonb_build_object('patientId', ranked.patient_id, 'score', ranked.score,
           'reasons', to_jsonb(ranked.reasons)) order by ranked.score desc, ranked.patient_id), '[]'::jsonb)
    into candidate_json
    from (
      select hits.patient_id, max(hits.score) as score,
             array_agg(distinct hits.reason order by hits.reason) as reasons
        from (
          -- The same date of birth with the same last name, or the names swapped.
          select patient.id as patient_id, 90 as score, unnest(case
                   when lower(patient.first_name) = lower(first_value)
                     then array['date_of_birth', 'first_name', 'last_name']
                   else array['date_of_birth', 'last_name'] end) as reason
            from identity.patients patient
           where patient.status = 'active' and patient.dob = requested_dob
             and lower(patient.last_name) = lower(last_value)
             and not exists (select 1 from identity.unknown_patients unknown_record
                              where unknown_record.patient_id = patient.id and unknown_record.status <> 'identified')
          union all
          select patient.id, 85, unnest(array['date_of_birth', 'first_name', 'last_name'])
            from identity.patients patient
           where patient.status = 'active' and patient.dob = requested_dob
             and lower(patient.last_name) = lower(first_value) and lower(patient.first_name) = lower(last_value)
             and not exists (select 1 from identity.unknown_patients unknown_record
                              where unknown_record.patient_id = patient.id and unknown_record.status <> 'identified')
          -- The same phone: a sign-in phone, or one a desk recorded.
          union all
          select patient.id, 80, 'phone'
            from identity.patients patient
           where phone_hmacs is not null and patient.status = 'active'
             and patient.phone_lookup_hmac = any (phone_hmacs)
             and not exists (select 1 from identity.unknown_patients unknown_record
                              where unknown_record.patient_id = patient.id and unknown_record.status <> 'identified')
          union all
          select lookup.patient_id, 80, 'phone'
            from identity.desk_registration_phone_lookups lookup
            join identity.patients patient on patient.id = lookup.patient_id and patient.status = 'active'
           where phone_hmacs is not null and lookup.phone_lookup_hmac = any (phone_hmacs)
             and not exists (select 1 from identity.unknown_patients unknown_record
                              where unknown_record.patient_id = patient.id and unknown_record.status <> 'identified')
          -- 0145: an identified unknown record's phone, held on its row.
          union all
          select held.patient_id, 80, 'phone'
            from identity.unknown_patients held
            join identity.patients patient on patient.id = held.patient_id and patient.status = 'active'
           where phone_hmacs is not null and held.status = 'identified'
             and held.contact_phone_lookup_hmac = any (phone_hmacs)
          -- The Health ID the patient stated.
          union all
          select patient.id, 65, 'stated_hid'
            from identity.patients patient
           where stated_value is not null and patient.status = 'active'
             and upper(patient.hid_code) = stated_value
             and not exists (select 1 from identity.unknown_patients unknown_record
                              where unknown_record.patient_id = patient.id and unknown_record.status <> 'identified')
        ) hits
       -- This facility is not sealed (refused above), so a sealed demo or QA
       -- patient is never a candidate here.
       where not identity.sealed_demo_patient(hits.patient_id)
         and not identity.sealed_qa_patient(hits.patient_id)
       group by hits.patient_id
       order by max(hits.score) desc, hits.patient_id
       limit 20
    ) ranked;
  candidates_found := jsonb_array_length(candidate_json);

  -- Open registrations without a NIN that look like the same person.
  select count(*)::integer into open_cases
    from identity.registration_cases registration
   where registration.identity_evidence = 'none' and registration.status = 'review_required'
     and ((registration.dob = requested_dob and lower(registration.last_name) = lower(last_value))
          or (phone_hmacs is not null and exists (
            select 1 from identity.desk_registration_phone_lookups lookup
             where lookup.registration_case_id = registration.id
               and lookup.phone_lookup_hmac = any (phone_hmacs))));
  -- 0145: an unknown record in review whose held details look like the same
  -- person (a real facility's only: this facility is not sealed).
  open_cases := open_cases + (
    select count(*)::integer
      from identity.unknown_patients held
     where held.status = 'sent_for_review'
       and not identity.sealed_qa_facility(held.facility_id) and not identity.sealed_demo_facility(held.facility_id)
       and ((held.proposed_dob = requested_dob and lower(held.proposed_last_name) = lower(last_value))
            or (phone_hmacs is not null and held.contact_phone_lookup_hmac = any (phone_hmacs))));

  kinds := array_remove(array[
    case when exists (select 1 from jsonb_array_elements(candidate_json) item where item -> 'reasons' ? 'date_of_birth')
      then 'name_and_date_of_birth' end,
    case when exists (select 1 from jsonb_array_elements(candidate_json) item where item -> 'reasons' ? 'phone')
      then 'phone' end,
    case when exists (select 1 from jsonb_array_elements(candidate_json) item where item -> 'reasons' ? 'stated_hid')
           or stated_unknown_record is not null -- 0145
      then 'stated_health_id' end,
    case when open_cases > 0 then 'open_registration' end], null);

  insert into identity.no_nin_case_writes (case_id) values (requested_case_id);

  if candidates_found = 0 and open_cases = 0 and stated_unknown_record is null then -- 0145: and no such record
    -- Owner Q106: no possible duplicates, so the same desk person creates the record.
    new_patient := pg_catalog.gen_random_uuid();
    insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status, source_system)
    values (new_patient, requested_hid_code, first_value, last_value, first_value || ' ' || last_value,
            requested_dob, requested_gender, 'active', 'hid-desk-registration');
    insert into identity.registration_cases (
      id, facility_id, created_by_account_id, created_by_membership_id, status,
      first_name, last_name, full_name, dob, gender, identity_evidence, no_nin_reason,
      idempotency_key, request_sha256, resolved_patient_id,
      review_idempotency_key, review_request_sha256, reviewed_by_account_id, reviewed_by_membership_id, review_reason
    ) values (
      requested_case_id, actor_facility, actor_account, actor_membership, 'approved_new_identity',
      first_value, last_value, first_value || ' ' || last_value, requested_dob, requested_gender, 'none',
      requested_no_nin_reason, requested_idempotency_key, requested_request_sha256, new_patient,
      requested_idempotency_key, requested_request_sha256, actor_account, actor_membership, desk_reason
    );
  else
    insert into identity.registration_cases (
      id, facility_id, created_by_account_id, created_by_membership_id, status,
      first_name, last_name, full_name, dob, gender, identity_evidence, no_nin_reason,
      idempotency_key, request_sha256
    ) values (
      requested_case_id, actor_facility, actor_account, actor_membership, 'review_required',
      first_value, last_value, first_value || ' ' || last_value, requested_dob, requested_gender, 'none',
      requested_no_nin_reason, requested_idempotency_key, requested_request_sha256
    );
    insert into identity.registration_case_candidates (case_id, patient_id, match_score, match_reasons)
    select requested_case_id, (item ->> 'patientId')::uuid, (item ->> 'score')::smallint, item -> 'reasons'
      from jsonb_array_elements(candidate_json) item;
  end if;

  -- The marker lives only for the write it allows.
  delete from identity.no_nin_case_writes marker
   where marker.case_id = requested_case_id and marker.transaction_id = pg_current_xact_id();

  if has_contact then
    insert into identity.registration_case_contacts (
      registration_case_id, facility_id, phone_ciphertext, address_ciphertext, key_version,
      stated_hid_code, created_by_account_id, created_by_membership_id
    ) values (requested_case_id, actor_facility, requested_phone_ciphertext, requested_address_ciphertext,
      requested_contact_key_version, stated_value, actor_account, actor_membership);
    insert into identity.desk_registration_phone_lookups (registration_case_id, facility_id, patient_id, phone_lookup_hmac)
    values (requested_case_id, actor_facility, new_patient, phone_hmacs[1]);
    if new_patient is not null then
      insert into identity.patient_facility_contacts (
        patient_id, facility_id, registration_case_id, phone_ciphertext, address_ciphertext, key_version,
        created_by_account_id, created_by_membership_id)
      values (new_patient, actor_facility, requested_case_id, requested_phone_ciphertext,
        requested_address_ciphertext, requested_contact_key_version, actor_account, actor_membership);
    end if;
  end if;

  insert into identity.registration_case_events (
    case_id, event_type, actor_account_id, actor_membership_id, facility_id, patient_id, reason, details
  ) values (
    requested_case_id, case when new_patient is null then 'review_required' else 'approved_new_identity' end,
    actor_account, actor_membership, actor_facility, new_patient,
    case when new_patient is null then null else desk_reason end,
    jsonb_build_object('withoutNin', true, 'noNinReason', requested_no_nin_reason,
      'candidateCount', candidates_found, 'openRegistrationCount', open_cases,
      'duplicateKinds', to_jsonb(kinds), 'contactRecorded', has_contact,
      'statedHealthId', stated_value is not null)
      -- 0145: only when the stated Health ID is another facility's unknown record.
      || case when stated_unknown_record is not null then jsonb_build_object('statedUnknownRecord', true)
              else '{}'::jsonb end
  );
  if new_patient is not null then
    insert into identity.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id, patient_id, correlation_id, payload
    ) values ('PatientRegistered', requested_case_id, 2, actor_facility, new_patient, actor_correlation,
      jsonb_build_object('source', 'desk-registration-without-nin'));
  end if;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, new_patient, 'identity.registration.without-nin', 'success',
    'registration-case', requested_case_id::text, 'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('status', case when new_patient is null then 'review_required' else 'approved_new_identity' end,
      'noNinReason', requested_no_nin_reason, 'candidateCount', candidates_found,
      'candidatePatientIds', (select coalesce(jsonb_agg(item -> 'patientId'), '[]'::jsonb)
                                from jsonb_array_elements(candidate_json) item),
      'openRegistrationCount', open_cases, 'duplicateKinds', to_jsonb(kinds),
      'contactRecorded', has_contact, 'facilityDailyCount', facility_count + 1)
      -- 0145: the link to another facility's unknown record, kept for ID-8.
      || case when stated_unknown_record is not null
              then jsonb_build_object('statedUnknownRecordPatientId', stated_unknown_record) else '{}'::jsonb end
  );
  return query select requested_case_id,
    case when new_patient is null then 'review_required' else 'approved_new_identity' end,
    1::bigint, new_patient, case when new_patient is null then null else requested_hid_code end,
    candidates_found, facility_count + 1, false;
end
$$;

comment on function identity.register_patient_without_nin(uuid, text, text, date, text, text, text, bytea, bytea, text, text, text, text, text) is
  '0130 (ID-2, owner Q106 of 18 November 2026): the desk registers a patient without a NIN. No possible duplicate: the same desk person creates the patient at once (approved_new_identity, source hid-desk-registration). Any possible duplicate (same date of birth and last name, same phone, the stated Health ID, or an open registration without a NIN): review_required, for an approver. Phone and address required unless the reason is child (under 18). No daily limit (owner Q109); the count at the facility today is returned for an operations alert. Refused at sealed demo and QA facilities. Audited with criteria kinds only.';

comment on function identity.register_patient_without_nin(uuid, text, text, date, text, text, text, bytea, bytea, text, text, text, text, text) is
  '0130 (ID-2, owner Q106 of 18 November 2026), with 0145 (ID-7): the desk registers a patient without a NIN. No possible duplicate: the same desk person creates the patient at once (approved_new_identity, source hid-desk-registration). Any possible duplicate (same date of birth and last name, same phone, including an identified unknown record''s held phone, the stated Health ID, an open registration without a NIN, or an unknown record in review whose held details match): review_required, for an approver. A record that is still unknown is never a candidate; a stated Health ID of this facility''s unknown record is refused (PATIENT_RECORD_UNKNOWN: identify it), and of another facility''s sends the case for review with no candidate. Phone and address required unless the reason is child (under 18). No daily limit (owner Q109); the count at the facility today is returned for an operations alert. Refused at sealed demo and QA facilities. Audited with criteria kinds only, a replay too.';

create function identity.refuse_registration_for_unknown_patient()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if exists (select 1 from identity.unknown_patients unknown_record
              where unknown_record.patient_id = new.resolved_patient_id and unknown_record.status <> 'identified') then
    raise exception using errcode = 'P0001', message = 'PATIENT_RECORD_UNKNOWN';
  end if;
  return new;
end
$$;
revoke all on function identity.refuse_registration_for_unknown_patient() from public;
create trigger registration_cases_unknown_patient
  before insert or update of resolved_patient_id on identity.registration_cases
  for each row when (new.resolved_patient_id is not null)
  execute function identity.refuse_registration_for_unknown_patient();

-- 11. The contact eraser (D14): 0114's text, with the held contact of an
-- unknown record added. Its owner and grants are kept (none).
create or replace function identity.erase_patient_facility_contacts(requested_patient_id uuid, requested_reason text)
returns table (facility_contacts integer, registration_contacts integer, stated_health_ids integer)
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  erased_facility integer;
  erased_registration integer;
  removed_stated integer;
  erased_unknown integer;
  erased_moment timestamptz := clock_timestamp();
  patient_hid_codes text[];
begin
  if requested_patient_id is null or requested_reason is null
     or requested_reason not in ('account_deleted', 'erasure_request') then
    raise exception using errcode = '22023', message = 'Invalid contact erasure request';
  end if;
  perform identity.assert_facility_contact_eraser();
  update identity.registration_case_contacts contact
     set phone_ciphertext = null, address_ciphertext = null, key_version = null, stated_hid_code = null,
         erased_at = erased_moment, erasure_reason = requested_reason
   where contact.erased_at is null
     and contact.registration_case_id in (
       select copied.registration_case_id from identity.patient_facility_contacts copied
        where copied.patient_id = requested_patient_id);
  get diagnostics erased_registration = row_count;
  update identity.patient_facility_contacts copied
     set phone_ciphertext = null, address_ciphertext = null, key_version = null,
         erased_at = erased_moment, erasure_reason = requested_reason
   where copied.patient_id = requested_patient_id and copied.erased_at is null;
  get diagnostics erased_facility = row_count;
  select coalesce(array_agg(distinct code), '{}'::text[]) into patient_hid_codes
    from (
      select upper(patient.hid_code) as code from identity.patients patient where patient.id = requested_patient_id
      union all
      select upper(identifier.public_value) from identity.patient_identifiers identifier
       where identifier.patient_id = requested_patient_id and identifier.identifier_type = 'hid_code'
         and identifier.public_value is not null
    ) codes;
  update identity.registration_case_contacts contact
     set stated_hid_code = null
   where contact.erased_at is null and contact.stated_hid_code = any (patient_hid_codes);
  get diagnostics removed_stated = row_count;
  -- 0145 (ID-7, D14): the contact given when an unknown record was identified.
  update identity.unknown_patients held
     set contact_phone_ciphertext = null, contact_address_ciphertext = null, contact_key_version = null,
         contact_phone_lookup_hmac = null, updated_at = erased_moment, row_version = held.row_version + 1
   where held.patient_id = requested_patient_id and held.contact_phone_ciphertext is not null;
  get diagnostics erased_unknown = row_count;
  insert into audit.events (
    correlation_id, actor_type, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    coalesce(platform.current_correlation_id(), gen_random_uuid()::text), 'system', requested_patient_id,
    'identity.patient-facility-contact.erase', 'success', 'patient', requested_patient_id::text,
    case when requested_reason = 'account_deleted' then 'patient-self' else 'healthcare-operations' end,
    'application', 'identity-api',
    jsonb_build_object('reason', requested_reason, 'facilityContacts', erased_facility,
      'registrationContacts', erased_registration, 'statedHealthIds', removed_stated,
      'unknownRecordContacts', erased_unknown)
  );
  return query select erased_facility, erased_registration, removed_stated;
end;
$$;

-- 12. Owners and EXECUTE (here and in runtime-grants.sql).
revoke all on function identity.unknown_patient_actor(text),
  identity.unknown_patient_audit(text, uuid, uuid, uuid, uuid, text, text, text, uuid, text, jsonb),
  identity.unknown_patient_cards(uuid[]), identity.unknown_patient_missing_reason(uuid, uuid),
  identity.create_unknown_patient(uuid, text, text, integer, text, bytea, text, text, text),
  identity.list_unknown_patients(text, integer, timestamp with time zone, uuid),
  identity.read_unknown_patient(uuid),
  identity.identify_unknown_patient(uuid, bigint, text, text, date, text, text, bytea, bytea, text, text, text),
  identity.decide_unknown_patient(uuid, text, bigint, text, text, text),
  identity.review_unknown_patient(uuid), identity.patient_record_kind(uuid),
  identity.staff_patient_search(text, text, text, date, text, text[], text, text),
  ehr.visit_queue_record_kinds(uuid[]) from public;
do $$
declare
  grant_owner name := (select pg_get_userbyid(proowner) from pg_proc
                        where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
  function_name text;
begin
  if grant_owner <> current_user then
    execute format('alter table identity.unknown_patients owner to %I', grant_owner);
    execute format('alter table ehr.unknown_patient_cancel_scans owner to %I', grant_owner);
    foreach function_name in array array[
      'identity.refuse_nin_for_unknown_patient()', 'identity.refuse_login_for_unknown_patient()',
      'identity.refuse_registration_for_unknown_patient()', 'identity.patient_record_kind(uuid)',
      'identity.unknown_patient_actor(text)',
      'identity.unknown_patient_audit(text, uuid, uuid, uuid, uuid, text, text, text, uuid, text, jsonb)',
      'identity.unknown_patient_cards(uuid[])', 'identity.unknown_patient_missing_reason(uuid, uuid)',
      'identity.create_unknown_patient(uuid, text, text, integer, text, bytea, text, text, text)',
      'identity.list_unknown_patients(text, integer, timestamp with time zone, uuid)',
      'identity.read_unknown_patient(uuid)',
      'identity.identify_unknown_patient(uuid, bigint, text, text, date, text, text, bytea, bytea, text, text, text)',
      'identity.decide_unknown_patient(uuid, text, bigint, text, text, text)',
      'identity.review_unknown_patient(uuid)',
      'identity.staff_patient_search(text, text, text, date, text, text[], text, text)',
      'ehr.visit_queue_record_kinds(uuid[])', 'ehr.unknown_patient_cancel_scan_open()'] loop
      execute format('alter function %s owner to %I', function_name, grant_owner);
    end loop;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function
      identity.create_unknown_patient(uuid, text, text, integer, text, bytea, text, text, text),
      identity.list_unknown_patients(text, integer, timestamp with time zone, uuid),
      identity.read_unknown_patient(uuid),
      identity.identify_unknown_patient(uuid, bigint, text, text, date, text, text, bytea, bytea, text, text, text),
      identity.decide_unknown_patient(uuid, text, bigint, text, text, text),
      identity.review_unknown_patient(uuid), identity.patient_record_kind(uuid),
      identity.staff_patient_search(text, text, text, date, text, text[], text, text) to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.visit_queue_record_kinds(uuid[]) to hid_ehr_runtime;
  end if;
end
$$;

comment on function identity.create_unknown_patient(uuid, text, text, integer, text, bytea, text, text, text) is
  '0145 (ID-7): make an unknown patient record at this facility (identity.registration.write): a real patient with a Health ID, record_kind unknown, no login, NIN or phone, labelled U-0001 and up per facility. Refused at a sealed demo facility; at the sealed QA facility the record is a sealed QA patient. Idempotent by the caller''s key.';
comment on function identity.decide_unknown_patient(uuid, text, bigint, text, text, text) is
  '0145 (ID-7): an approver (identity.registration.approve) confirms a record in review separate (the held details apply; not the member who identified it) or cancels a record made in error (only while nothing clinical is attached; the patient becomes inactive).';

-- 13. Post-checks.
do $$
declare
  identity_runtime boolean := exists (select 1 from pg_roles where rolname = 'hid_identity_runtime');
  ehr_runtime boolean := exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime');
  function_name text;
begin
  if (select count(*) from pg_trigger
       where ((tgrelid = 'identity.patients'::regclass and tgname = 'patients_unknown_no_login')
              or (tgrelid = 'identity.registration_cases'::regclass and tgname = 'registration_cases_unknown_patient'))
         and tgenabled = 'O') <> 2 then
    raise exception using errcode = '55000', message = '0145 post-check: the no-login or registration trigger is missing';
  end if;
  -- D14 runs as 0114's owner: it must be able to erase the held contact.
  if not has_table_privilege((select proowner from pg_proc
                               where oid = 'identity.erase_patient_facility_contacts(uuid,text)'::regprocedure),
                             'identity.unknown_patients', 'UPDATE') then
    raise exception using errcode = '55000', message = '0145 post-check: the contact eraser cannot erase an unknown record''s contact';
  end if;
  if not (select prosecdef from pg_proc
           where oid = 'identity.register_patient_without_nin(uuid,text,text,date,text,text,text,bytea,bytea,text,text,text,text,text)'::regprocedure)
     or has_function_privilege('public', 'identity.erase_patient_facility_contacts(uuid,text)', 'EXECUTE') then
    raise exception using errcode = '55000', message = '0145 post-check: a replaced registration or erasure function is not as intended';
  end if;
  if pg_get_function_result('identity.staff_patient_search(text,text,text,date,text,text[],text,text)'::regprocedure)
       not like '%record_kind text)' then
    raise exception using errcode = '55000', message = '0145 post-check: the search does not answer record_kind';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'identity.patient_identifiers'::regclass
                  and tgname = 'patient_identifiers_unknown_patient' and tgenabled = 'O') then
    raise exception using errcode = '55000', message = '0145 post-check: the NIN trigger is missing';
  end if;
  if (select count(*) from pg_policy policy join pg_class relation on relation.oid = policy.polrelid
       join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'ehr' and policy.polname = relation.relname || '_cancel_check_read'
        -- one scalar subquery (an InitPlan), never a per-row test
        and regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '\s+', ' ', 'g') like '( SELECT CASE WHEN pg_has_role(%'
        and relation.relname in ('clinical_notes', 'diagnoses', 'documents', 'lab_requests', 'prescriptions',
                                 'recorded_allergies', 'vitals')) <> 7 then
    raise exception using errcode = '55000', message = '0145 post-check: a cancel-check policy is missing';
  end if;
  if exists (select 1 from pg_class relation, aclexplode(relation.relacl) acl
              where relation.oid = 'ehr.unknown_patient_cancel_scans'::regclass and acl.grantee <> relation.relowner) then
    raise exception using errcode = '55000', message = '0145 post-check: the cancel-check marker table is granted to a role';
  end if;
  -- D11's premise, in 0133's form: no hid_ role but the owner is a member of
  -- any of the seven tables' owners (MEMBER, so NOINHERIT counts too).
  if exists (select 1 from pg_roles role_row,
                    (select distinct relation.relowner from pg_class relation
                      where relation.oid in ('ehr.clinical_notes'::regclass, 'ehr.diagnoses'::regclass,
                                             'ehr.documents'::regclass, 'ehr.lab_requests'::regclass,
                                             'ehr.prescriptions'::regclass, 'ehr.recorded_allergies'::regclass,
                                             'ehr.vitals'::regclass)) table_owner
              where role_row.rolname like 'hid\_%' and role_row.oid <> table_owner.relowner
                and pg_has_role(role_row.oid, table_owner.relowner, 'MEMBER')) then
    raise exception using errcode = '55000', message = '0145 post-check: a hid_ role is a member of a clinical table''s owner';
  end if;
  foreach function_name in array array[
    'identity.create_unknown_patient(uuid,text,text,integer,text,bytea,text,text,text)',
    'identity.list_unknown_patients(text,integer,timestamp with time zone,uuid)',
    'identity.read_unknown_patient(uuid)',
    'identity.identify_unknown_patient(uuid,bigint,text,text,date,text,text,bytea,bytea,text,text,text)',
    'identity.decide_unknown_patient(uuid,text,bigint,text,text,text)',
    'identity.review_unknown_patient(uuid)', 'identity.patient_record_kind(uuid)',
    'identity.staff_patient_search(text,text,text,date,text,text[],text,text)'] loop
    if not exists (select 1 from pg_proc proc where proc.oid = to_regprocedure(function_name) and proc.prosecdef
                    and proc.proconfig = array['search_path=pg_catalog, pg_temp'])
       or has_function_privilege('public', function_name, 'EXECUTE')
       or (identity_runtime and not has_function_privilege('hid_identity_runtime', function_name, 'EXECUTE'))
       or (ehr_runtime and has_function_privilege('hid_ehr_runtime', function_name, 'EXECUTE')) then
      raise exception using errcode = '55000', message = '0145 post-check: ' || function_name || ' is not as intended';
    end if;
  end loop;
  if has_function_privilege('public', 'ehr.visit_queue_record_kinds(uuid[])', 'EXECUTE')
     or (ehr_runtime and not has_function_privilege('hid_ehr_runtime', 'ehr.visit_queue_record_kinds(uuid[])', 'EXECUTE'))
     or (identity_runtime and has_function_privilege('hid_identity_runtime', 'ehr.visit_queue_record_kinds(uuid[])', 'EXECUTE')) then
    raise exception using errcode = '55000', message = '0145 post-check: ehr.visit_queue_record_kinds is not as intended';
  end if;
  foreach function_name in array array['identity.unknown_patient_actor(text)',
    'identity.unknown_patient_audit(text,uuid,uuid,uuid,uuid,text,text,text,uuid,text,jsonb)',
    'identity.unknown_patient_cards(uuid[])', 'identity.unknown_patient_missing_reason(uuid,uuid)',
    'identity.refuse_nin_for_unknown_patient()', 'identity.refuse_login_for_unknown_patient()',
    'identity.refuse_registration_for_unknown_patient()', 'identity.own_facility_basis(uuid,uuid)'] loop
    if has_function_privilege('public', function_name, 'EXECUTE')
       or (identity_runtime and has_function_privilege('hid_identity_runtime', function_name, 'EXECUTE'))
       or (ehr_runtime and has_function_privilege('hid_ehr_runtime', function_name, 'EXECUTE')) then
      raise exception using errcode = '55000', message = '0145 post-check: ' || function_name || ' is granted to a role';
    end if;
  end loop;
end
$$;
