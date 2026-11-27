\set ON_ERROR_STOP on
-- ID-8a (0207): merge requests and the review list. Rollback-only, fictional
-- values only. Every command runs as the Identity API's runtime role
-- (hid_identity_api_runtime) in the staff context identity-api sets.
--
--   1. the source rule: this facility's unknown record (open, in review,
--      identified) and desk record are allowed; one made at another facility,
--      a standard record never registered here and an inactive (cancelled)
--      unknown record are PATIENT_NOT_FOUND; a NIN Verified one, one with a
--      login, one with a staff enrolment, one with an open outreach claim are
--      MERGE_SOURCE_NOT_ALLOWED (an expired outreach code is not open; a
--      claimed or invalidated one is in 10);
--   2. the target: the ref of this member's own standard search, made under
--      direct-care, is resolved while the request runs under
--      healthcare-operations (0132's resolver answers null there: the pairing
--      this file exists for); another member's, an expired, an emergency and
--      a malformed ref are MERGE_SEARCH_FIRST; the source itself is
--      MERGE_SAME_RECORD; an inactive, an unknown and a sealed QA target are
--      MERGE_TARGET_NOT_ALLOWED; at the sealed QA facility a sealed QA source
--      goes to a sealed QA target;
--   3. the answer: the source card, the target card without a patient id or
--      counts, the moves counts equal to the source's rows (another
--      facility's visit included; vitals entered in error not counted; 0 for
--      a source with none), replay and key reuse, MERGE_ALREADY_OPEN;
--   4. list mine and facility, the permissions, the status filter, paging;
--   5. read by the asker, an approver, another desk member and another
--      facility's approver;
--   6. refuse: the asker refused (MERGE_SECOND_PERSON_REQUIRED), the version,
--      the replay, key reuse, MERGE_ALREADY_DECIDED; cancel: only the asker,
--      the version, the replay, MERGE_ALREADY_DECIDED; a new request after a
--      cancel;
--   7. audit rows: one per command (replays included), both patient ids and
--      the counts, never a name, date of birth, phone or Health ID; refusals
--      write nothing here (identity-api writes them) and carry the ids in
--      their DETAIL only when the caller may see the request;
--   8. the marker is never left behind (and one held before is kept), the
--      owner reads nothing clinical outside it, and no runtime role can touch
--      the table or the helpers;
--   9. structure: the reserved ID-8b columns are null, the CHECKs refuse a
--      status without its shape;
--  10. the rest of the source rule (a desk record here whose patient is not
--      active, one made at another facility, another facility's desk record
--      this facility only linked: PATIENT_NOT_FOUND; a claimed or invalidated
--      outreach code and a verified identifier that is not a NIN: allowed), a
--      sealed demo target, another facility's approver refusing (decided and
--      open: not found, no ids), the list's status filter and newest-first
--      order across pages, sourceStillAllowed false and requestedByMe false
--      for an approver after the source gains an open claim, the refusal's
--      DETAIL with both patients, an account with a membership at each
--      facility (its key is not replayed at the other, it cannot cancel there,
--      its mine list there is empty), the lab member on the mine list and
--      cancel, notes and vitals counted through the visits equal to the
--      source's rows by patient, an inactive or held membership.
begin;

set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('e2070000-0000-4000-8000-000000000001', 'Merge Suite Hospital Group', 'merge-suite-hospital-group'),
  ('e2070000-0000-4000-8000-000000000002', 'Merge Suite Other Group', 'merge-suite-other-group'),
  ('e2070000-0000-4000-8000-000000000003', 'Merge Suite QA Group', 'merge-suite-qa-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e2071000-0000-4000-8000-000000000001', 'e2070000-0000-4000-8000-000000000001', 'Merge Suite Hospital', 'MRG-H',
   'Africa/Lagos', true, 'verified'),
  ('e2071000-0000-4000-8000-000000000002', 'e2070000-0000-4000-8000-000000000002', 'Merge Suite Other', 'MRG-O',
   'Africa/Lagos', true, 'verified'),
  ('e2071000-0000-4000-8000-000000000003', 'e2070000-0000-4000-8000-000000000003', 'Merge Suite QA', 'MRG-Q',
   'Africa/Lagos', true, 'verified');
insert into identity.sealed_qa_members (member_kind, member_id) values
  ('organization', 'e2070000-0000-4000-8000-000000000003'), ('facility', 'e2071000-0000-4000-8000-000000000003'),
  ('account', 'e2072000-0000-4000-8000-000000000007');
-- Members: 1 desk H, 2 desk H, 3 admin H, 4 admin H, 5 desk O, 6 admin O, 7 desk Q (sealed QA), 8 lab H.
create temporary table merge_members (n integer primary key, facility uuid, organization uuid, role_code text)
  on commit drop;
insert into merge_members values
  (1, 'e2071000-0000-4000-8000-000000000001', 'e2070000-0000-4000-8000-000000000001', 'receptionist'),
  (2, 'e2071000-0000-4000-8000-000000000001', 'e2070000-0000-4000-8000-000000000001', 'receptionist'),
  (3, 'e2071000-0000-4000-8000-000000000001', 'e2070000-0000-4000-8000-000000000001', 'admin'),
  (4, 'e2071000-0000-4000-8000-000000000001', 'e2070000-0000-4000-8000-000000000001', 'admin'),
  (5, 'e2071000-0000-4000-8000-000000000002', 'e2070000-0000-4000-8000-000000000002', 'receptionist'),
  (6, 'e2071000-0000-4000-8000-000000000002', 'e2070000-0000-4000-8000-000000000002', 'admin'),
  (7, 'e2071000-0000-4000-8000-000000000003', 'e2070000-0000-4000-8000-000000000003', 'receptionist'),
  (8, 'e2071000-0000-4000-8000-000000000001', 'e2070000-0000-4000-8000-000000000001', 'lab');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e2072000-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:merge:member-' || n,
  'member' || n || '@merge-suite.invalid', 'Merge Suite Member ' || n, 'active' from merge_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e2073000-0000-4000-8000-00000000000' || n)::uuid, ('e2072000-0000-4000-8000-00000000000' || n)::uuid,
  'Merge Suite Member ' || n, 'member' || n || '@merge-suite.invalid', 'verified', role_code from merge_members;
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
select ('e2074000-0000-4000-8000-00000000000' || n)::uuid, ('e2073000-0000-4000-8000-00000000000' || n)::uuid,
  ('e2072000-0000-4000-8000-00000000000' || n)::uuid, organization, facility, role_code, role_code, true, true
  from merge_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e2075000-0000-4000-8000-00000000000' || n)::uuid, ('e2072000-0000-4000-8000-00000000000' || n)::uuid,
  role_code, 'facility', ('e2074000-0000-4000-8000-00000000000' || n)::uuid, facility, 'Merge suite member'
  from merge_members;

-- Patients (fictional). Sources: 1 unknown here (open), 2 desk record here, 3 unknown made at O, 4 desk record here
-- with a verified NIN, 5 desk record here with a login, 6 desk record here with a staff enrolment (and so its
-- login), 7 desk record here with an open outreach claim, 8 unknown here cancelled (inactive), 13 unknown at the
-- sealed QA facility, 14 a standard record never registered here, 15 unknown here identified, 16 unknown here in
-- review, 17 desk record here with an expired outreach claim. Targets: 9 standard (NIN verified), 10 standard but
-- inactive, 11 another unknown here, 12 sealed QA standard.
create function pg_temp.patient(n integer) returns uuid language sql immutable as $f$
  select ('e2076000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid;
$f$;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status, source_system) values
  (pg_temp.patient(1), 'HID-MRGA2B', 'Unknown', 'U-0001', 'Unknown patient U-0001', date '1991-07-01', 'male', 'active', 'hid-unknown-patient'),
  (pg_temp.patient(2), 'HID-MRGC3D', 'Kemi', 'Adeyemi', 'Kemi Adeyemi', date '1988-02-03', 'female', 'active', 'hid-desk-registration'),
  (pg_temp.patient(3), 'HID-MRGE4F', 'Unknown', 'U-0001', 'Unknown patient U-0001', null, 'female', 'active', 'hid-unknown-patient'),
  (pg_temp.patient(4), 'HID-MRGG5H', 'Tunde', 'Bakare', 'Tunde Bakare', date '1979-04-05', 'male', 'active', 'hid-desk-registration'),
  (pg_temp.patient(5), 'HID-MRGJ6K', 'Ngozi', 'Eze', 'Ngozi Eze', date '1995-06-07', 'female', 'active', 'hid-desk-registration'),
  (pg_temp.patient(6), 'HID-MRGL7M', 'Sola', 'Ojo', 'Sola Ojo', date '1983-08-09', 'male', 'active', 'hid-desk-registration'),
  (pg_temp.patient(7), 'HID-MRGN8P', 'Femi', 'Lawal', 'Femi Lawal', date '1990-10-11', 'male', 'active', 'hid-desk-registration'),
  (pg_temp.patient(8), 'HID-MRGQ9R', 'Unknown', 'U-0002', 'Unknown patient U-0002', null, 'male', 'inactive', 'hid-unknown-patient'),
  (pg_temp.patient(9), 'HID-MRGS2T', 'Musa', 'Bello', 'Musa Bello', date '1990-03-14', 'male', 'active', 'hid'),
  (pg_temp.patient(10), 'HID-MRGU3V', 'Inactive', 'Target', 'Inactive Target', date '1970-01-01', 'female', 'inactive', 'hid'),
  (pg_temp.patient(11), 'HID-MRGW4X', 'Unknown', 'U-0003', 'Unknown patient U-0003', null, 'female', 'active', 'hid-unknown-patient'),
  (pg_temp.patient(12), 'HID-MRGY5Z', 'Quality', 'Patient', 'Quality Patient', date '1985-05-05', 'female', 'active', 'hid'),
  (pg_temp.patient(13), 'HID-MRGA6C', 'Unknown', 'U-0001', 'Unknown patient U-0001', null, 'female', 'active', 'hid-unknown-patient'),
  (pg_temp.patient(14), 'HID-MRGD7E', 'Never', 'Here', 'Never Here', date '1960-06-06', 'male', 'active', 'hid'),
  (pg_temp.patient(15), 'HID-MRGF8G', 'Ada', 'Nwosu', 'Ada Nwosu', date '1993-03-03', 'female', 'active', 'hid-unknown-patient'),
  (pg_temp.patient(16), 'HID-MRGH9J', 'Unknown', 'U-0005', 'Unknown patient U-0005', null, 'male', 'active', 'hid-unknown-patient'),
  (pg_temp.patient(17), 'HID-MRGK2L', 'Bisi', 'Oni', 'Bisi Oni', date '1999-09-09', 'female', 'active', 'hid-desk-registration');
insert into identity.sealed_qa_members (member_kind, member_id) values
  ('patient', pg_temp.patient(12)), ('patient', pg_temp.patient(13));
update identity.patients set account_id = 'e2072000-0000-4000-8000-000000000005' where id = pg_temp.patient(5);
update identity.patients set account_id = 'e2072000-0000-4000-8000-000000000006' where id = pg_temp.patient(6);
insert into identity.unknown_patients (patient_id, facility_id, label_number, unknown_reason, status, created_by_account_id,
  created_by_membership_id, idempotency_key, request_sha256, identified_at)
select pg_temp.patient(record.n), record.facility, record.label_number, 'unconscious', record.status,
  ('e2072000-0000-4000-8000-00000000000' || record.member)::uuid, ('e2074000-0000-4000-8000-00000000000' || record.member)::uuid,
  'merge-suite-unknown-' || lpad(record.n::text, 4, '0'), repeat('a', 64),
  case when record.status = 'open' or record.status = 'cancelled' then null else clock_timestamp() end
  from (values (1, 'e2071000-0000-4000-8000-000000000001'::uuid, 1, 'open', 1),
               (3, 'e2071000-0000-4000-8000-000000000002'::uuid, 1, 'open', 5),
               (8, 'e2071000-0000-4000-8000-000000000001'::uuid, 2, 'cancelled', 1),
               (11, 'e2071000-0000-4000-8000-000000000001'::uuid, 3, 'open', 1),
               (13, 'e2071000-0000-4000-8000-000000000003'::uuid, 1, 'open', 7),
               (15, 'e2071000-0000-4000-8000-000000000001'::uuid, 4, 'identified', 1),
               (16, 'e2071000-0000-4000-8000-000000000001'::uuid, 5, 'sent_for_review', 1))
       as record(n, facility, label_number, status, member);
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
  first_name, last_name, full_name, dob, identity_evidence, no_nin_reason, idempotency_key, request_sha256,
  resolved_patient_id, reviewed_by_account_id, reviewed_by_membership_id, review_reason, review_idempotency_key,
  review_request_sha256)
select ('e2077000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'e2071000-0000-4000-8000-000000000001',
  'e2072000-0000-4000-8000-000000000001', 'e2074000-0000-4000-8000-000000000001', 'approved_new_identity',
  patient.first_name, patient.last_name, patient.full_name, patient.dob, 'none', 'no_nin',
  'merge-suite-case-' || lpad(n::text, 4, '0'), repeat('b', 64), patient.id, 'e2072000-0000-4000-8000-000000000001',
  'e2074000-0000-4000-8000-000000000001', 'Registered at the desk without a NIN',
  'merge-suite-review-' || lpad(n::text, 4, '0'), repeat('c', 64)
  from unnest(array[2, 4, 5, 6, 7, 17]) n join identity.patients patient on patient.id = pg_temp.patient(n);
insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
  encryption_key_version, display_hint, verified, source_system, verified_at, verification_provider,
  verification_reference, registration_case_id, revoked_at, revocation_reason)
select ('e2078000-0000-4000-8000-0000000000' || lpad(nin.n::text, 2, '0'))::uuid, pg_temp.patient(nin.n), 'nin',
  decode(repeat('5a', 40), 'hex'), repeat(nin.hmac, 64), 'k1', '1111', true, 'merge-suite', clock_timestamp(), 'qoreid',
  'MERGE-SUITE-' || nin.n, ('e2077000-0000-4000-8000-0000000000' || lpad(nin.n::text, 2, '0'))::uuid,
  case when nin.revoked then clock_timestamp() end, case when nin.revoked then 'Fictional revocation' end
  -- p4 and p9 hold a verified NIN; p2's was revoked, so p2 stays NIN Not Verified.
  from (values (4, 'd', false), (9, 'e', false), (2, 'f', true)) as nin(n, hmac, revoked);
insert into identity.patient_enrollments (case_id, patient_id, account_id, facility_id, actor_account_id,
  actor_membership_id, idempotency_key, request_sha256, reason)
values ('e2077000-0000-4000-8000-000000000006', pg_temp.patient(6), 'e2072000-0000-4000-8000-000000000006',
  'e2071000-0000-4000-8000-000000000001', 'e2072000-0000-4000-8000-000000000003', 'e2074000-0000-4000-8000-000000000003',
  'merge-suite-enrol-0006', repeat('a', 64), 'Enrolled at the desk with the patient present');
insert into identity.outreach_health_id_claims (patient_id, registration_case_id, code_hmac, code_key_version,
  hmac_key_version, expires_at) values
  (pg_temp.patient(7), 'e2077000-0000-4000-8000-000000000007', repeat('1', 64), 'v1', 'v1', clock_timestamp() + interval '2 days'),
  (pg_temp.patient(17), 'e2077000-0000-4000-8000-000000000017', repeat('2', 64), 'v1', 'v1', clock_timestamp() - interval '1 day');

-- The source's clinical rows (p1): 2 visits here and 1 at the other facility (3), 3 notes, 5 recorded vitals and 1
-- entered in error, 1 diagnosis, 2 prescriptions, 1 lab request, 1 document, 1 allergy. Nothing for p2.
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e2079000-0000-4000-8000-00000000000' || n)::uuid, pg_temp.patient(1),
  case when n = 3 then 'e2071000-0000-4000-8000-000000000002'::uuid else 'e2071000-0000-4000-8000-000000000001'::uuid end,
  'e2072000-0000-4000-8000-000000000003', 'e2074000-0000-4000-8000-000000000003', 'emergency', 'in_progress',
  clock_timestamp() from generate_series(1, 3) n;
insert into ehr.clinical_notes (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id, note_type, title)
select gen_random_uuid(), 'e2079000-0000-4000-8000-000000000001', pg_temp.patient(1), 'e2071000-0000-4000-8000-000000000001',
  'e2072000-0000-4000-8000-000000000003', 'e2074000-0000-4000-8000-000000000003', 'progress', 'Fictional note ' || n
  from generate_series(1, 3) n;
insert into ehr.vitals (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id, recorded_at,
  pulse_bpm, status, status_changed_at)
select gen_random_uuid(), 'e2079000-0000-4000-8000-000000000001', pg_temp.patient(1), 'e2071000-0000-4000-8000-000000000001',
  'e2072000-0000-4000-8000-000000000003', 'e2074000-0000-4000-8000-000000000003', clock_timestamp(), 60 + n,
  case when n = 6 then 'entered_in_error' else 'recorded' end, case when n = 6 then clock_timestamp() end
  from generate_series(1, 6) n;
insert into ehr.diagnoses (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id, code_system,
  code, display, clinical_status, verification_status)
values (gen_random_uuid(), 'e2079000-0000-4000-8000-000000000001', pg_temp.patient(1), 'e2071000-0000-4000-8000-000000000001',
  'e2072000-0000-4000-8000-000000000003', 'e2074000-0000-4000-8000-000000000003', 'icd11', 'XX00', 'Fictional finding',
  'active', 'provisional');
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_display, frequency, instructions, status)
select gen_random_uuid(), 'e2079000-0000-4000-8000-000000000001', pg_temp.patient(1), 'e2071000-0000-4000-8000-000000000001',
  'e2072000-0000-4000-8000-000000000003', 'e2074000-0000-4000-8000-000000000003', 'Fictional tablet ' || n, 'daily',
  'With water', 'active' from generate_series(1, 2) n;
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, status)
values (gen_random_uuid(), 'e2079000-0000-4000-8000-000000000001', pg_temp.patient(1), 'e2071000-0000-4000-8000-000000000001',
  'e2072000-0000-4000-8000-000000000003', 'e2074000-0000-4000-8000-000000000003', 'local', 'FBC', 'Fictional count', 'active');
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, declared_media_type, retention_class)
values (gen_random_uuid(), pg_temp.patient(1), 'e2071000-0000-4000-8000-000000000001', 'e2072000-0000-4000-8000-000000000003',
  'e2074000-0000-4000-8000-000000000003', 'fictional.pdf', 'merge-suite', 'merge-suite/fictional.pdf', 'application/pdf',
  'clinical');
insert into ehr.recorded_allergies (id, patient_id, facility_id, created_by, created_by_membership_id, substance, severity)
values (gen_random_uuid(), pg_temp.patient(1), 'e2071000-0000-4000-8000-000000000001', 'e2072000-0000-4000-8000-000000000003',
  'e2074000-0000-4000-8000-000000000003', 'Fictional allergen', 'mild');
set local session_replication_role = origin;

-- The staff context identity-api sets.
create function pg_temp.as_member(n integer, correlation text, purpose text default 'healthcare-operations')
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:merge:member-' || n, true),
    set_config('app.membership_id', 'e2074000-0000-4000-8000-00000000000' || n, true),
    set_config('app.facility_id', case when n in (5, 6) then 'e2071000-0000-4000-8000-000000000002'
      when n = 7 then 'e2071000-0000-4000-8000-000000000003' else 'e2071000-0000-4000-8000-000000000001' end, true),
    set_config('app.correlation_id', correlation, true), set_config('app.purpose_of_use', purpose, true);
$f$;
create function pg_temp.key(label text) returns text language sql immutable as $f$ select 'merge-suite-key-' || label; $f$;
create function pg_temp.sha(label text) returns text language sql immutable as $f$
  select encode(sha256(convert_to('merge-suite-' || label, 'UTF8')), 'hex');
$f$;
-- A matchRef token: 'psr_' and 43 characters.
create function pg_temp.token(label text) returns text language sql immutable as $f$
  select 'psr_' || substr(md5(label) || md5(label || '-2'), 1, 43);
$f$;
-- A ref written as 0132's search writes it (the owner's table; for the cases a search would not issue).
create function pg_temp.ref(label text, patient uuid, member integer, purpose text default 'direct-care',
  age interval default interval '1 minute') returns text language plpgsql security definer as $f$
declare
  made timestamptz := clock_timestamp() - age;
begin
  insert into identity.patient_search_refs (token_sha256, patient_id, account_id, membership_id, facility_id,
    purpose_of_use, search_mode, created_at, expires_at)
  values (encode(sha256(convert_to(pg_temp.token(label), 'UTF8')), 'hex'), patient,
    ('e2072000-0000-4000-8000-00000000000' || member)::uuid, ('e2074000-0000-4000-8000-00000000000' || member)::uuid,
    case when member in (5, 6) then 'e2071000-0000-4000-8000-000000000002'::uuid
         when member = 7 then 'e2071000-0000-4000-8000-000000000003'::uuid
         else 'e2071000-0000-4000-8000-000000000001'::uuid end,
    purpose, case when purpose = 'emergency' then 'emergency' else 'standard' end,
    made, made + interval '10 minutes');
  return pg_temp.token(label);
end
$f$;
-- One call: {"rows": [...]} or {"error": "<sqlstate> <message>", "detail": ...}.
create function pg_temp.call(statement text) returns jsonb language plpgsql as $f$
declare
  answer jsonb;
  state text;
  message text;
  detail text;
begin
  execute format('select coalesce(jsonb_agg(to_jsonb(call_row)), ''[]''::jsonb) from (%s) call_row', statement) into answer;
  return jsonb_build_object('rows', answer);
exception when others then
  get stacked diagnostics state = returned_sqlstate, message = message_text, detail = pg_exception_detail;
  -- 0207's refusals carry JSON; any other error's DETAIL (a foreign key's, say) is kept as text.
  begin
    return jsonb_build_object('error', state || ' ' || message, 'detail', nullif(detail, '')::jsonb);
  exception when invalid_text_representation then
    return jsonb_build_object('error', state || ' ' || message, 'detail', to_jsonb(detail));
  end;
end
$f$;
-- A statement that returns no rows: its SQLSTATE, or 'ok'.
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate;
end
$f$;
create function pg_temp.outcome(answer jsonb) returns text language sql immutable as $f$
  select coalesce(answer ->> 'error', 'ok');
$f$;
create function pg_temp.request(source uuid, ref text, label text, reason text default 'Identified by family at the bedside today')
returns jsonb language sql as $f$
  select pg_temp.call(format('select * from identity.request_patient_merge(%L, %L, %L, %L, %L)', source, ref, reason,
    pg_temp.key(label), pg_temp.sha(label)));
$f$;
-- A case: stops the suite at once when it fails.
create function pg_temp.expect(case_name text, expected text, actual text) returns void language plpgsql as $f$
begin
  if expected is distinct from coalesce(actual, 'null') then
    raise exception '0207 suite failed: %: expected [%] got [%]', case_name, expected, coalesce(actual, 'null');
  end if;
  perform set_config('m207.passed', (coalesce(nullif(current_setting('m207.passed', true), ''), '0')::integer + 1)::text, true);
end
$f$;
-- Audit rows of this suite's actions, as the suite's owner reads them.
create function pg_temp.audited(correlation text) returns text language sql security definer as $f$
  select coalesce(string_agg(event.action || ' ' || event.outcome || ' ' || coalesce(event.patient_id::text, '-'), '; '
                             order by event.sequence_id), 'none')
    from audit.events event where event.correlation_id = correlation;
$f$;
create function pg_temp.merge_status(merge uuid) returns text language sql security definer as $f$
  select merge_row.status || ' v' || merge_row.version from identity.patient_merges merge_row where merge_row.id = merge;
$f$;
grant execute on all functions in schema pg_temp to hid_identity_api_runtime;
create temporary table merge_ids (label text primary key, id uuid) on commit drop;
grant select, insert on merge_ids to hid_identity_api_runtime;

-- 2a. The pairing: member 1's own standard search, under direct-care, issues the card for p9; under
-- healthcare-operations 0132's resolver answers nothing for it (requested direct-care is not the session's purpose),
-- and the request resolves it all the same.
set local role hid_identity_api_runtime;
select pg_temp.as_member(1, 'merge-suite-search-0001', 'direct-care');
select match_ref as search_ref from identity.staff_patient_search('standard', 'Musa', 'Bello', date '1990-03-14', null, null,
  null, null) where outcome = 'found' \gset
select pg_temp.as_member(1, 'merge-suite-pairing-0001');
select pg_temp.expect('2a 0132''s resolver answers nothing under healthcare-operations for a direct-care ref', 'null',
  (select identity.resolve_patient_search_ref(:'search_ref', 'direct-care')::text));

-- 1. The source rule (a fresh ref each time, so only the source decides).
select pg_temp.as_member(1, 'merge-suite-source-0001');
select pg_temp.expect('1a another facility''s unknown record', 'P0001 PATIENT_NOT_FOUND',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(3), pg_temp.ref('s3', pg_temp.patient(9), 1), 's3')));
select pg_temp.expect('1b a standard record never registered here', 'P0001 PATIENT_NOT_FOUND',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(14), pg_temp.ref('s14', pg_temp.patient(9), 1), 's14')));
select pg_temp.expect('1c a cancelled (inactive) unknown record', 'P0001 PATIENT_NOT_FOUND',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(8), pg_temp.ref('s8', pg_temp.patient(9), 1), 's8')));
select pg_temp.expect('1d a missing patient', 'P0001 PATIENT_NOT_FOUND',
  pg_temp.outcome(pg_temp.request('e2076000-0000-4000-8000-000000000099', pg_temp.ref('s99', pg_temp.patient(9), 1), 's99')));
select pg_temp.expect('1e NIN Verified', 'P0001 MERGE_SOURCE_NOT_ALLOWED',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(4), pg_temp.ref('s4', pg_temp.patient(9), 1), 's4')));
select pg_temp.expect('1f with a login', 'P0001 MERGE_SOURCE_NOT_ALLOWED',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(5), pg_temp.ref('s5', pg_temp.patient(9), 1), 's5')));
select pg_temp.expect('1g with a staff enrolment', 'P0001 MERGE_SOURCE_NOT_ALLOWED',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(6), pg_temp.ref('s6', pg_temp.patient(9), 1), 's6')));
select pg_temp.expect('1h with an open outreach claim (enrolment in progress)', 'P0001 MERGE_SOURCE_NOT_ALLOWED',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(7), pg_temp.ref('s7', pg_temp.patient(9), 1), 's7')));
select pg_temp.expect('1i the refusal names the source in its DETAIL (it is this facility''s)',
  pg_temp.patient(7)::text,
  pg_temp.request(pg_temp.patient(7), pg_temp.ref('s7b', pg_temp.patient(9), 1), 's7b') -> 'detail' ->> 'sourcePatientId');
select pg_temp.expect('1j PATIENT_NOT_FOUND carries no id', '{}',
  (pg_temp.request(pg_temp.patient(3), pg_temp.ref('s3b', pg_temp.patient(9), 1), 's3b') -> 'detail')::text);

-- 2. The target.
select pg_temp.expect('2b another member''s ref', '42501 MERGE_SEARCH_FIRST',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(2), pg_temp.ref('t2', pg_temp.patient(9), 2), 't2')));
select pg_temp.expect('2c an expired ref', '42501 MERGE_SEARCH_FIRST',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(2), pg_temp.ref('t3', pg_temp.patient(9), 1, 'direct-care',
    interval '11 minutes'), 't3')));
select pg_temp.expect('2d an emergency search''s ref', '42501 MERGE_SEARCH_FIRST',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(2), pg_temp.ref('t4', pg_temp.patient(9), 1, 'emergency'), 't4')));
select pg_temp.expect('2e a malformed ref', '42501 MERGE_SEARCH_FIRST',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(2), 'psr_not-a-real-reference', 't5')));
select pg_temp.expect('2e2 a well-formed ref nobody issued', '42501 MERGE_SEARCH_FIRST',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(2), pg_temp.token('never-issued'), 't5b')));
select pg_temp.expect('2f the source itself (a Health ID search finds this facility''s unknown record)',
  'P0001 MERGE_SAME_RECORD',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(1), pg_temp.ref('t6', pg_temp.patient(1), 1), 't6')));
select pg_temp.expect('2g an inactive target', 'P0001 MERGE_TARGET_NOT_ALLOWED',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(2), pg_temp.ref('t7', pg_temp.patient(10), 1), 't7')));
select pg_temp.expect('2h an unknown target', 'P0001 MERGE_TARGET_NOT_ALLOWED',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(2), pg_temp.ref('t8', pg_temp.patient(11), 1), 't8')));
select pg_temp.expect('2i a target across the seals (sealed QA)', 'P0001 MERGE_TARGET_NOT_ALLOWED',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(2), pg_temp.ref('t9', pg_temp.patient(12), 1), 't9')));
select pg_temp.expect('2j a request under direct-care is refused (healthcare-operations only)', '42501 MERGE_DENIED',
  (select pg_temp.outcome(pg_temp.request(pg_temp.patient(2), :'search_ref', 't10'))
     from pg_temp.as_member(1, 'merge-suite-purpose-0001', 'direct-care')));
select pg_temp.as_member(1, 'merge-suite-source-0002');
select pg_temp.expect('2k the lab member (no identity.registration.write)', '42501 MERGE_DENIED',
  (select pg_temp.outcome(pg_temp.request(pg_temp.patient(2), :'search_ref', 't11'))
     from pg_temp.as_member(8, 'merge-suite-lab-0001')));
select pg_temp.expect('2l a reason of 7 characters', '22023 MERGE_INVALID',
  (select pg_temp.outcome(pg_temp.request(pg_temp.patient(2), :'search_ref', 't12', 'Too shr'))
     from pg_temp.as_member(1, 'merge-suite-short-0001')));
select pg_temp.as_member(7, 'merge-suite-qa-0001');
select pg_temp.expect('2m a sealed QA source into a target outside the seal', 'P0001 MERGE_TARGET_NOT_ALLOWED',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(13), pg_temp.ref('t14', pg_temp.patient(9), 7), 'qa2')));
select pg_temp.expect('2n at the sealed QA facility, a sealed QA source into a sealed QA target', 'ok requested',
  (select pg_temp.outcome(answer) || ' ' || (answer -> 'rows' -> 0 -> 'merge' ->> 'status')
     from pg_temp.request(pg_temp.patient(13), pg_temp.ref('t13', pg_temp.patient(12), 7), 'qa1') answer));

-- 3. The answer (member 1 asks to merge p1 into p9 with the searched ref).
select pg_temp.as_member(1, 'merge-suite-request-0001');
select pg_temp.request(pg_temp.patient(1), :'search_ref', 'r1') as first_answer \gset
insert into merge_ids values ('r1', (:'first_answer'::jsonb -> 'rows' -> 0 -> 'merge' ->> 'mergeId')::uuid);
select pg_temp.expect('3a requested, version 1, not replayed', 'requested 1 false',
  (select (answer -> 'merge' ->> 'status') || ' ' || (answer -> 'merge' ->> 'version') || ' ' || (answer ->> 'replayed')
     from (select :'first_answer'::jsonb -> 'rows' -> 0 as answer) one));
select pg_temp.expect('3b the source card',
  '{"sex": "male", "fullName": "Unknown patient U-0001", "ninStatus": "not_verified", "patientId": "'
    || pg_temp.patient(1) || '", "recordKind": "unknown", "dateOfBirth": "1991-07-01", "healthIdLast4": "GA2B", '
    || '"dateOfBirthEstimated": true}',
  (:'first_answer'::jsonb -> 'rows' -> 0 -> 'merge' -> 'source')::text);
select pg_temp.expect('3c the target card: the search card, no patient id, no counts',
  '{"sex": "male", "fullName": "Musa Bello", "ninStatus": "verified", "recordKind": "standard", "dateOfBirth": "1990-03-14", '
    || '"healthIdLast4": "GS2T"}',
  (:'first_answer'::jsonb -> 'rows' -> 0 -> 'merge' -> 'target')::text);
select pg_temp.expect('3d the moves: the source''s rows (a visit at another facility counted, a vital entered in error not)',
  '{"notes": 3, "visits": 3, "vitals": 5, "allergies": 1, "diagnoses": 1, "documents": 1, "labRequests": 1, "prescriptions": 2}',
  (:'first_answer'::jsonb -> 'rows' -> 0 -> 'merge' -> 'moves')::text);
select pg_temp.expect('3e the target''s id is in the answer for identity-api''s audit rows only', pg_temp.patient(9)::text,
  :'first_answer'::jsonb -> 'rows' -> 0 -> 'merge' ->> 'targetPatientId');
select pg_temp.expect('3f still allowed, asked by me, no undoUntil', 'true true null',
  (select (merge ->> 'sourceStillAllowed') || ' ' || (merge ->> 'requestedByMe') || ' ' || coalesce(merge ->> 'undoUntil', 'null')
     from (select :'first_answer'::jsonb -> 'rows' -> 0 -> 'merge' as merge) one));
select pg_temp.expect('3g the replay: the same request, replayed', 'true same',
  (select (answer -> 'rows' -> 0 ->> 'replayed') || ' '
          || case when (answer -> 'rows' -> 0 -> 'merge' ->> 'mergeId')::uuid = (select id from merge_ids where label = 'r1')
                  then 'same' else 'other' end
     from pg_temp.request(pg_temp.patient(1), pg_temp.ref('r1x', pg_temp.patient(9), 1), 'r1') answer));
select pg_temp.expect('3h the same key with another request', '23505 IDEMPOTENCY_KEY_REUSED',
  pg_temp.outcome(pg_temp.call(format('select * from identity.request_patient_merge(%L, %L, %L, %L, %L)', pg_temp.patient(1),
    :'search_ref', 'Identified by family at the bedside today', pg_temp.key('r1'), pg_temp.sha('r1-other')))));
select pg_temp.expect('3i a second request for the same source', 'P0001 MERGE_ALREADY_OPEN',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(1), :'search_ref', 'r1-again')));
select pg_temp.expect('3j even by another member', 'P0001 MERGE_ALREADY_OPEN',
  (select pg_temp.outcome(pg_temp.request(pg_temp.patient(1), pg_temp.ref('r1m2', pg_temp.patient(9), 2), 'r1-m2'))
     from pg_temp.as_member(2, 'merge-suite-request-0002')));
-- The desk record p2 (no clinical rows), and identified and in-review unknown records, by the admin (member 3).
select pg_temp.as_member(3, 'merge-suite-request-0003');
select pg_temp.request(pg_temp.patient(2), pg_temp.ref('r2', pg_temp.patient(9), 3), 'r2') as second_answer \gset
insert into merge_ids values ('r2', (:'second_answer'::jsonb -> 'rows' -> 0 -> 'merge' ->> 'mergeId')::uuid);
select pg_temp.expect('3k a desk record: allowed; its moves are 0; its card is standard and NIN Not Verified (revoked NIN)',
  'ok {"notes": 0, "visits": 0, "vitals": 0, "allergies": 0, "diagnoses": 0, "documents": 0, "labRequests": 0, "prescriptions": 0} standard not_verified false',
  pg_temp.outcome(:'second_answer'::jsonb) || ' ' || (:'second_answer'::jsonb -> 'rows' -> 0 -> 'merge' -> 'moves')::text
    || ' ' || (:'second_answer'::jsonb -> 'rows' -> 0 -> 'merge' -> 'source' ->> 'recordKind')
    || ' ' || (:'second_answer'::jsonb -> 'rows' -> 0 -> 'merge' -> 'source' ->> 'ninStatus')
    || ' ' || (:'second_answer'::jsonb -> 'rows' -> 0 -> 'merge' -> 'source' ->> 'dateOfBirthEstimated'));
select pg_temp.request(pg_temp.patient(15), pg_temp.ref('r15', pg_temp.patient(9), 3), 'r15') as identified_answer \gset
insert into merge_ids values ('r15', (:'identified_answer'::jsonb -> 'rows' -> 0 -> 'merge' ->> 'mergeId')::uuid);
select pg_temp.expect('3l an identified unknown record (standard now) is still this facility''s own', 'ok standard',
  pg_temp.outcome(:'identified_answer'::jsonb) || ' '
    || (:'identified_answer'::jsonb -> 'rows' -> 0 -> 'merge' -> 'source' ->> 'recordKind'));
select pg_temp.expect('3m an unknown record in review', 'ok unknown',
  (select pg_temp.outcome(answer) || ' ' || (answer -> 'rows' -> 0 -> 'merge' -> 'source' ->> 'recordKind')
     from pg_temp.request(pg_temp.patient(16), pg_temp.ref('r16', pg_temp.patient(9), 3), 'r16') answer));
select pg_temp.expect('3n a desk record whose outreach code expired', 'ok',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(17), pg_temp.ref('r17', pg_temp.patient(9), 3), 'r17')));

-- 4. The list.
select pg_temp.as_member(1, 'merge-suite-list-0001');
select pg_temp.expect('4a mine (desk): only my requests here', 'r1',
  (select string_agg(label, ',' order by label) from merge_ids
    where id in (select (row_ -> 'merge' ->> 'mergeId')::uuid
                   from jsonb_array_elements(pg_temp.call('select * from identity.list_patient_merges(''mine'', null, 100, null, null)') -> 'rows') row_)));
select pg_temp.expect('4b facility (desk): refused', '42501 MERGE_DENIED',
  pg_temp.outcome(pg_temp.call('select * from identity.list_patient_merges(''facility'', null, 100, null, null)')));
select pg_temp.expect('4c an invalid view or limit', '22023 MERGE_INVALID 22023 MERGE_INVALID 22023 MERGE_INVALID',
  pg_temp.outcome(pg_temp.call('select * from identity.list_patient_merges(''all'', null, 10, null, null)')) || ' '
  || pg_temp.outcome(pg_temp.call('select * from identity.list_patient_merges(''mine'', null, 101, null, null)')) || ' '
  || pg_temp.outcome(pg_temp.call('select * from identity.list_patient_merges(''mine'', ''open'', 10, null, null)')));
select pg_temp.as_member(3, 'merge-suite-list-0002');
select pg_temp.call('select * from identity.list_patient_merges(''facility'', ''requested'', 2, null, null)') as page_one \gset
select pg_temp.expect('4d facility (approver): every request here, newest first, two per page, more to come',
  '2 true', jsonb_array_length(:'page_one'::jsonb -> 'rows') || ' ' || (:'page_one'::jsonb -> 'rows' -> 0 ->> 'has_more'));
select pg_temp.expect('4e the next page by (created_at, id), then the end', '5 false',
  (select count(*) + 2 || ' ' || bool_or((row_ ->> 'has_more')::boolean)
     from jsonb_array_elements(pg_temp.call(format(
       'select * from identity.list_patient_merges(''facility'', ''requested'', 100, %L, %L)',
       :'page_one'::jsonb -> 'rows' -> 1 -> 'merge' ->> 'requestedAt', :'page_one'::jsonb -> 'rows' -> 1 -> 'merge' ->> 'mergeId'))
       -> 'rows') row_));
select pg_temp.expect('4f another facility''s approver sees none of them', '0',
  (select jsonb_array_length(pg_temp.call('select * from identity.list_patient_merges(''facility'', null, 100, null, null)') -> 'rows')::text
     from pg_temp.as_member(6, 'merge-suite-list-0003')));
select pg_temp.expect('4g the list writes no audit row', 'none', pg_temp.audited('merge-suite-list-0002'));

-- 5. Read.
select pg_temp.as_member(1, 'merge-suite-read-0001');
select pg_temp.expect('5a the asker reads it', 'ok requested',
  (select pg_temp.outcome(answer) || ' ' || (answer -> 'rows' -> 0 -> 'merge' ->> 'status')
     from pg_temp.call(format('select * from identity.read_patient_merge(%L)', (select id from merge_ids where label = 'r1'))) answer));
select pg_temp.expect('5b the read''s audit row names the source; its details the target and the counts',
  'identity.patient-merge.read success ' || pg_temp.patient(1), pg_temp.audited('merge-suite-read-0001'));
select pg_temp.expect('5c another desk member: not found', 'P0001 MERGE_NOT_FOUND',
  (select pg_temp.outcome(pg_temp.call(format('select * from identity.read_patient_merge(%L)',
     (select id from merge_ids where label = 'r1')))) from pg_temp.as_member(2, 'merge-suite-read-0002')));
select pg_temp.expect('5d an approver here reads it', 'ok',
  (select pg_temp.outcome(pg_temp.call(format('select * from identity.read_patient_merge(%L)',
     (select id from merge_ids where label = 'r1')))) from pg_temp.as_member(4, 'merge-suite-read-0003')));
select pg_temp.as_member(6, 'merge-suite-read-0004');
select pg_temp.expect('5e another facility''s approver: not found, no ids', 'P0001 MERGE_NOT_FOUND {}',
  (select pg_temp.outcome(answer) || ' ' || (answer -> 'detail')::text
     from pg_temp.call(format('select * from identity.read_patient_merge(%L)', (select id from merge_ids where label = 'r1'))) answer));
select pg_temp.expect('5f the lab member: denied', '42501 MERGE_DENIED',
  (select pg_temp.outcome(pg_temp.call(format('select * from identity.read_patient_merge(%L)',
     (select id from merge_ids where label = 'r1')))) from pg_temp.as_member(8, 'merge-suite-read-0005')));

-- 6. Refuse and cancel.
select pg_temp.as_member(3, 'merge-suite-refuse-0001');
select pg_temp.expect('6a the asker cannot refuse (Q127 A); the DETAIL names the request', '42501 MERGE_SECOND_PERSON_REQUIRED '
    || (select id from merge_ids where label = 'r2'),
  (select pg_temp.outcome(answer) || ' ' || (answer -> 'detail' ->> 'mergeId')
     from pg_temp.call(format('select * from identity.refuse_patient_merge(%L, 1, %L, %L, %L)',
       (select id from merge_ids where label = 'r2'), 'Not the same person at all', pg_temp.key('f2'), pg_temp.sha('f2'))) answer));
select pg_temp.expect('6b a desk member cannot refuse', '42501 MERGE_DENIED',
  (select pg_temp.outcome(pg_temp.call(format('select * from identity.refuse_patient_merge(%L, 1, %L, %L, %L)',
     (select id from merge_ids where label = 'r1'), 'Not the same person at all', pg_temp.key('f1d'), pg_temp.sha('f1d'))))
     from pg_temp.as_member(2, 'merge-suite-refuse-0002')));
select pg_temp.as_member(4, 'merge-suite-refuse-0003');
select pg_temp.expect('6c another approver, a stale version', '40001 VERSION_CONFLICT',
  pg_temp.outcome(pg_temp.call(format('select * from identity.refuse_patient_merge(%L, 7, %L, %L, %L)',
    (select id from merge_ids where label = 'r2'), 'Not the same person at all', pg_temp.key('f2v'), pg_temp.sha('f2v')))));
select pg_temp.expect('6d another approver refuses: refused, version 2', 'ok refused 2 false',
  (select pg_temp.outcome(answer) || ' ' || (answer -> 'rows' -> 0 -> 'merge' ->> 'status') || ' '
          || (answer -> 'rows' -> 0 -> 'merge' ->> 'version') || ' ' || (answer -> 'rows' -> 0 ->> 'replayed')
     from pg_temp.call(format('select * from identity.refuse_patient_merge(%L, 1, %L, %L, %L)',
       (select id from merge_ids where label = 'r2'), 'Not the same person at all', pg_temp.key('f2'), pg_temp.sha('f2'))) answer));
select pg_temp.expect('6e its replay', 'ok true',
  (select pg_temp.outcome(answer) || ' ' || (answer -> 'rows' -> 0 ->> 'replayed')
     from pg_temp.call(format('select * from identity.refuse_patient_merge(%L, 1, %L, %L, %L)',
       (select id from merge_ids where label = 'r2'), 'Not the same person at all', pg_temp.key('f2'), pg_temp.sha('f2'))) answer));
select pg_temp.expect('6f the same key, another body', '23505 IDEMPOTENCY_KEY_REUSED',
  pg_temp.outcome(pg_temp.call(format('select * from identity.refuse_patient_merge(%L, 1, %L, %L, %L)',
    (select id from merge_ids where label = 'r2'), 'Another reason entirely', pg_temp.key('f2'), pg_temp.sha('f2-other')))));
select pg_temp.expect('6g the same key on another request', '23505 IDEMPOTENCY_KEY_REUSED',
  pg_temp.outcome(pg_temp.call(format('select * from identity.refuse_patient_merge(%L, 1, %L, %L, %L)',
    (select id from merge_ids where label = 'r1'), 'Not the same person at all', pg_temp.key('f2'), pg_temp.sha('f2')))));
select pg_temp.expect('6h already decided', 'P0001 MERGE_ALREADY_DECIDED',
  pg_temp.outcome(pg_temp.call(format('select * from identity.refuse_patient_merge(%L, 2, %L, %L, %L)',
    (select id from merge_ids where label = 'r2'), 'Not the same person at all', pg_temp.key('f2b'), pg_temp.sha('f2b')))));
select pg_temp.expect('6i a short reason', '22023 MERGE_INVALID',
  pg_temp.outcome(pg_temp.call(format('select * from identity.refuse_patient_merge(%L, 1, %L, %L, %L)',
    (select id from merge_ids where label = 'r1'), 'No', pg_temp.key('f1s'), pg_temp.sha('f1s')))));
select pg_temp.expect('6j the row: refused by member 4, the reason, version 2', 'refused v2',
  (select pg_temp.merge_status((select id from merge_ids where label = 'r2'))));
-- Cancel (r1, asked by member 1).
select pg_temp.expect('6k another desk member: not found', 'P0001 MERGE_NOT_FOUND',
  (select pg_temp.outcome(pg_temp.call(format('select * from identity.cancel_patient_merge(%L, 1, %L, %L)',
     (select id from merge_ids where label = 'r1'), pg_temp.key('c1x'), pg_temp.sha('c1x'))))
     from pg_temp.as_member(2, 'merge-suite-cancel-0001')));
select pg_temp.expect('6l an approver who did not ask: denied', '42501 MERGE_DENIED',
  (select pg_temp.outcome(pg_temp.call(format('select * from identity.cancel_patient_merge(%L, 1, %L, %L)',
     (select id from merge_ids where label = 'r1'), pg_temp.key('c1y'), pg_temp.sha('c1y'))))
     from pg_temp.as_member(4, 'merge-suite-cancel-0002')));
select pg_temp.as_member(1, 'merge-suite-cancel-0003');
select pg_temp.expect('6m the asker, a stale version', '40001 VERSION_CONFLICT',
  pg_temp.outcome(pg_temp.call(format('select * from identity.cancel_patient_merge(%L, 2, %L, %L)',
    (select id from merge_ids where label = 'r1'), pg_temp.key('c1v'), pg_temp.sha('c1v')))));
select pg_temp.expect('6n the asker cancels', 'ok cancelled 2',
  (select pg_temp.outcome(answer) || ' ' || (answer -> 'rows' -> 0 -> 'merge' ->> 'status') || ' '
          || (answer -> 'rows' -> 0 -> 'merge' ->> 'version')
     from pg_temp.call(format('select * from identity.cancel_patient_merge(%L, 1, %L, %L)',
       (select id from merge_ids where label = 'r1'), pg_temp.key('c1'), pg_temp.sha('c1'))) answer));
select pg_temp.expect('6o its replay; the same key with another body', 'ok true | 23505 IDEMPOTENCY_KEY_REUSED',
  (select pg_temp.outcome(answer) || ' ' || (answer -> 'rows' -> 0 ->> 'replayed')
     from pg_temp.call(format('select * from identity.cancel_patient_merge(%L, 1, %L, %L)',
       (select id from merge_ids where label = 'r1'), pg_temp.key('c1'), pg_temp.sha('c1'))) answer)
  || ' | ' || pg_temp.outcome(pg_temp.call(format('select * from identity.cancel_patient_merge(%L, 1, %L, %L)',
       (select id from merge_ids where label = 'r1'), pg_temp.key('c1'), pg_temp.sha('c1-other')))));
select pg_temp.expect('6p already decided (cancelled), and a refused one cannot be cancelled',
  'P0001 MERGE_ALREADY_DECIDED P0001 MERGE_ALREADY_DECIDED',
  pg_temp.outcome(pg_temp.call(format('select * from identity.cancel_patient_merge(%L, 2, %L, %L)',
    (select id from merge_ids where label = 'r1'), pg_temp.key('c1b'), pg_temp.sha('c1b')))) || ' '
  || (select pg_temp.outcome(pg_temp.call(format('select * from identity.cancel_patient_merge(%L, 2, %L, %L)',
       (select id from merge_ids where label = 'r2'), pg_temp.key('c2'), pg_temp.sha('c2'))))
        from pg_temp.as_member(3, 'merge-suite-cancel-0004')));
select pg_temp.as_member(1, 'merge-suite-request-0005');
select pg_temp.expect('6q after the cancel, the source may be asked for again', 'ok requested',
  (select pg_temp.outcome(answer) || ' ' || (answer -> 'rows' -> 0 -> 'merge' ->> 'status')
     from pg_temp.request(pg_temp.patient(1), pg_temp.ref('r1n', pg_temp.patient(9), 1), 'r1-new') answer));
select pg_temp.as_member(4, 'merge-suite-read-0006');
select pg_temp.expect('6r the refused one reads with its decision, no longer "still allowed"', 'refused Not the same person at all null',
  (select (answer -> 'rows' -> 0 -> 'merge' ->> 'status') || ' ' || (answer -> 'rows' -> 0 -> 'merge' ->> 'decisionReason')
          || ' ' || coalesce(answer -> 'rows' -> 0 -> 'merge' ->> 'sourceStillAllowed', 'null')
     from pg_temp.call(format('select * from identity.read_patient_merge(%L)', (select id from merge_ids where label = 'r2'))) answer));
reset role;

-- 7. Audit rows.
select pg_temp.expect('7a the request: one row naming the source, the target and the counts in details, the typed reason',
  'identity.patient-merge.request success ' || pg_temp.patient(1) || ' | ' || pg_temp.patient(9)
    || ' | {"notes": 3, "visits": 3, "vitals": 5, "allergies": 1, "diagnoses": 1, "documents": 1, "labRequests": 1, "prescriptions": 2}'
    || ' | Identified by family at the bedside today | patient-merge ' || (select id from merge_ids where label = 'r1'),
  (select event.action || ' ' || event.outcome || ' ' || event.patient_id || ' | ' || (event.details ->> 'targetPatientId')
          || ' | ' || (event.details -> 'moves')::text || ' | ' || event.reason || ' | ' || event.resource_type || ' '
          || event.resource_id
     from audit.events event where event.correlation_id = 'merge-suite-request-0001'
      and not (event.details ->> 'replayed')::boolean));
select pg_temp.expect('7b the replay and the later requests write their own rows; refusals write none here',
  'identity.patient-merge.request success 3 replayed 1',
  (select min(event.action) || ' ' || min(event.outcome) || ' ' || count(*) || ' replayed '
          || count(*) filter (where (event.details ->> 'replayed')::boolean)
     from audit.events event where event.correlation_id in ('merge-suite-request-0001', 'merge-suite-request-0005')));
select pg_temp.expect('7c refusals raised: no row of theirs here (identity-api writes it)', 'none none none none',
  pg_temp.audited('merge-suite-source-0001') || ' ' || pg_temp.audited('merge-suite-refuse-0001') || ' '
  || pg_temp.audited('merge-suite-read-0002') || ' ' || pg_temp.audited('merge-suite-cancel-0001'));
select pg_temp.expect('7d refuse and cancel: one row each, the replays too',
  'identity.patient-merge.refuse:2 identity.patient-merge.cancel:2',
  (select string_agg(action || ':' || total, ' ' order by action desc) from (
     select event.action, count(*) as total from audit.events event
      where event.correlation_id in ('merge-suite-refuse-0003', 'merge-suite-cancel-0003') group by event.action) counted));
select pg_temp.expect('7e no row of these functions holds a name, date of birth or Health ID', '0',
  (select count(*)::text from audit.events event, identity.patients patient
    where event.action like 'identity.patient-merge.%' and event.correlation_id like 'merge-suite-%'
      and patient.id in (pg_temp.patient(1), pg_temp.patient(2), pg_temp.patient(9), pg_temp.patient(12), pg_temp.patient(13),
                         pg_temp.patient(15), pg_temp.patient(16), pg_temp.patient(17))
      and (position(lower(patient.full_name) in lower(event.details::text || coalesce(event.reason, ''))) > 0
           or position(patient.hid_code in event.details::text || coalesce(event.reason, '')) > 0
           or position(right(patient.hid_code, 4) in event.details::text) > 0
           or (patient.dob is not null and position(patient.dob::text in event.details::text) > 0))));

-- 8. The marker, the owner's reads, the runtimes.
select pg_temp.expect('8a no marker is left behind', '0',
  (select count(*)::text from ehr.unknown_patient_cancel_scans scan where scan.backend_pid = pg_backend_pid()));
select set_config('app.actor_subject', '', true), set_config('app.membership_id', '', true),
  set_config('app.facility_id', '', true), set_config('app.purpose_of_use', '', true);
set local role relb_migrator;
select pg_temp.expect('8b outside the marker the owner reads no note, vital, diagnosis, prescription, lab request, document or allergy',
  '0 0 0 0 0 0 0',
  (select (select count(*) from ehr.clinical_notes) || ' ' || (select count(*) from ehr.vitals) || ' '
          || (select count(*) from ehr.diagnoses) || ' ' || (select count(*) from ehr.prescriptions) || ' '
          || (select count(*) from ehr.lab_requests) || ' ' || (select count(*) from ehr.documents) || ' '
          || (select count(*) from ehr.recorded_allergies)));
reset role;
-- A marker held before the call (another owner-run function's) is kept.
insert into ehr.unknown_patient_cancel_scans (backend_pid, transaction_started_at)
values (pg_backend_pid(), transaction_timestamp());
set local role hid_identity_api_runtime;
select pg_temp.as_member(4, 'merge-suite-read-0007');
select pg_temp.expect('8c a read with a marker already held answers', 'ok',
  pg_temp.outcome(pg_temp.call(format('select * from identity.read_patient_merge(%L)', (select id from merge_ids where label = 'r2')))));
reset role;
select pg_temp.expect('8d and leaves that marker in place', '1',
  (select count(*)::text from ehr.unknown_patient_cancel_scans scan where scan.backend_pid = pg_backend_pid()));
delete from ehr.unknown_patient_cancel_scans scan where scan.backend_pid = pg_backend_pid();
set local role hid_identity_api_runtime;
select pg_temp.expect('8e the Identity runtime cannot read or write the table', '42501 42501',
  split_part(pg_temp.outcome(pg_temp.call('select count(*) from identity.patient_merges')), ' ', 1) || ' '
  || pg_temp.try('delete from identity.patient_merges'));
select pg_temp.expect('8f nor run a helper', '42501 42501',
  split_part(pg_temp.outcome(pg_temp.call(format('select identity.patient_merge_source_state(%L, %L)', pg_temp.patient(1),
    'e2071000-0000-4000-8000-000000000001'))), ' ', 1) || ' '
  || split_part(pg_temp.outcome(pg_temp.call(format('select * from identity.patient_merge_items(array[%L]::uuid[], null)',
    (select id from merge_ids where label = 'r2')))), ' ', 1));
reset role;
select pg_temp.expect('8g no hid_ role holds a privilege on the table, nor EXECUTE on a helper; the Identity runtime alone on the five',
  '0 0 hid_identity_runtime',
  (select count(*)::text from pg_roles role_row
    where role_row.rolname like 'hid\_%'
      and (has_table_privilege(role_row.oid, 'identity.patient_merges', 'SELECT')
           or has_table_privilege(role_row.oid, 'identity.patient_merges', 'INSERT')
           or has_table_privilege(role_row.oid, 'identity.patient_merges', 'UPDATE')
           or has_table_privilege(role_row.oid, 'identity.patient_merges', 'DELETE')))
  || ' ' || (select count(*)::text from pg_roles role_row,
               unnest(array['identity.patient_merge_actor()', 'identity.patient_merge_audit(record,text,text,uuid,uuid,text,jsonb)',
                            'identity.patient_merge_source_state(uuid,uuid)', 'identity.patient_merge_target(text,uuid,uuid,uuid)',
                            'identity.patient_merge_items(uuid[],uuid)',
                            'identity.patient_merge_refusal(text,text,uuid,uuid,uuid)']) helper(signature)
              where role_row.rolname like 'hid\_%' and has_function_privilege(role_row.oid, helper.signature, 'EXECUTE'))
  || ' ' || (select string_agg(distinct pg_get_userbyid(acl.grantee), ',') from pg_proc proc,
               lateral aclexplode(proc.proacl) acl
              where proc.oid in ('identity.request_patient_merge(uuid,text,text,text,text)'::regprocedure,
                                 'identity.list_patient_merges(text,text,integer,timestamp with time zone,uuid)'::regprocedure,
                                 'identity.read_patient_merge(uuid)'::regprocedure,
                                 'identity.refuse_patient_merge(uuid,bigint,text,text,text)'::regprocedure,
                                 'identity.cancel_patient_merge(uuid,bigint,text,text)'::regprocedure)
                and acl.grantee <> proc.proowner));

-- 9. Structure.
select pg_temp.expect('9a ID-8b''s columns are null on every request; nothing merged', '0',
  (select count(*)::text from identity.patient_merges merge_row
    where merge_row.merged_at is not null or merge_row.undo_until is not null or merge_row.undone_at is not null
       or merge_row.undo_reason is not null or merge_row.status in ('merged', 'undone')));
select pg_temp.expect('9b the source records are unchanged by a request (still active, no account)', '0',
  (select count(*)::text from identity.patients patient
    where patient.id in (pg_temp.patient(1), pg_temp.patient(2)) and (patient.status <> 'active' or patient.account_id is not null)));
do $$
declare outcome text := 'stored';
begin
  begin
    update identity.patient_merges set status = 'merged' where id = (select id from merge_ids where label = 'r15');
  exception when check_violation then
    outcome := 'refused';
  end;
  perform pg_temp.expect('9c merged without merged_at, the approver and undo_until: refused by the shape CHECK', 'refused', outcome);
  outcome := 'stored';
  begin
    update identity.patient_merges set status = 'refused' where id = (select id from merge_ids where label = 'r15');
  exception when check_violation then
    outcome := 'refused';
  end;
  perform pg_temp.expect('9d refused without a decision: refused', 'refused', outcome);
end $$;

-- 10. Rules and answers no case above reaches (fictional).
reset role;
set local session_replication_role = replica;
-- p18 a desk record here whose patient is deceased; p20 a desk record made at O; p21 a desk record made at O that this
-- facility linked (linked_existing, no NIN evidence); p23 a sealed demo standard record; desk records here with an
-- outreach code already claimed (p24) or invalidated (p25), both unexpired, and with a verified identifier that is not
-- a NIN (p26): those three are still allowed.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status, source_system) values
  (pg_temp.patient(18), 'HID-MRGM3N', 'Dele', 'Ade', 'Dele Ade', date '1980-01-01', 'male', 'deceased', 'hid-desk-registration'),
  (pg_temp.patient(20), 'HID-MRGP4Q', 'Yemi', 'Ola', 'Yemi Ola', date '1981-01-01', 'female', 'active', 'hid-desk-registration'),
  (pg_temp.patient(21), 'HID-MRGR5S', 'Tola', 'Ige', 'Tola Ige', date '1982-01-01', 'female', 'active', 'hid-desk-registration'),
  (pg_temp.patient(23), 'HID-MRGT6U', 'Demo', 'Person', 'Demo Person', date '1983-01-01', 'male', 'active', 'hid'),
  (pg_temp.patient(24), 'HID-MRGV7W', 'Chidi', 'Okeke', 'Chidi Okeke', date '1984-01-01', 'male', 'active', 'hid-desk-registration'),
  (pg_temp.patient(25), 'HID-MRGX8Y', 'Halima', 'Sani', 'Halima Sani', date '1985-01-01', 'female', 'active', 'hid-desk-registration'),
  (pg_temp.patient(26), 'HID-MRGZ9A', 'Efe', 'Obi', 'Efe Obi', date '1986-01-01', 'male', 'active', 'hid-desk-registration');
insert into identity.sealed_demo_members (member_kind, member_id) values ('patient', pg_temp.patient(23));
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
  first_name, last_name, full_name, dob, identity_evidence, no_nin_reason, idempotency_key, request_sha256,
  resolved_patient_id, reviewed_by_account_id, reviewed_by_membership_id, review_reason, review_idempotency_key,
  review_request_sha256)
select ('e2077000-0000-4000-8000-0000000000' || lpad(c.n::text, 2, '0'))::uuid, c.facility, c.account, c.membership, c.status,
  patient.first_name, patient.last_name, patient.full_name, patient.dob, 'none', 'no_nin',
  'merge-suite-case-' || lpad(c.n::text, 4, '0'), repeat('b', 64), patient.id, c.account, c.membership,
  'Registered at the desk without a NIN', 'merge-suite-review-' || lpad(c.n::text, 4, '0'), repeat('c', 64)
  from (values (18, 18, 'e2071000-0000-4000-8000-000000000001'::uuid, 'e2072000-0000-4000-8000-000000000001'::uuid,
                'e2074000-0000-4000-8000-000000000001'::uuid, 'approved_new_identity'),
               (20, 20, 'e2071000-0000-4000-8000-000000000002'::uuid, 'e2072000-0000-4000-8000-000000000005'::uuid,
                'e2074000-0000-4000-8000-000000000005'::uuid, 'approved_new_identity'),
               (21, 21, 'e2071000-0000-4000-8000-000000000002'::uuid, 'e2072000-0000-4000-8000-000000000005'::uuid,
                'e2074000-0000-4000-8000-000000000005'::uuid, 'approved_new_identity'),
               (22, 21, 'e2071000-0000-4000-8000-000000000001'::uuid, 'e2072000-0000-4000-8000-000000000001'::uuid,
                'e2074000-0000-4000-8000-000000000001'::uuid, 'linked_existing'),
               (24, 24, 'e2071000-0000-4000-8000-000000000001'::uuid, 'e2072000-0000-4000-8000-000000000001'::uuid,
                'e2074000-0000-4000-8000-000000000001'::uuid, 'approved_new_identity'),
               (25, 25, 'e2071000-0000-4000-8000-000000000001'::uuid, 'e2072000-0000-4000-8000-000000000001'::uuid,
                'e2074000-0000-4000-8000-000000000001'::uuid, 'approved_new_identity'),
               (26, 26, 'e2071000-0000-4000-8000-000000000001'::uuid, 'e2072000-0000-4000-8000-000000000001'::uuid,
                'e2074000-0000-4000-8000-000000000001'::uuid, 'approved_new_identity'))
       as c(n, p, facility, account, membership, status)
  join identity.patients patient on patient.id = pg_temp.patient(c.p);
insert into identity.outreach_health_id_claims (patient_id, registration_case_id, code_hmac, code_key_version,
  hmac_key_version, expires_at, claimed_at, claimed_account_id, invalidated_at) values
  (pg_temp.patient(24), 'e2077000-0000-4000-8000-000000000024', repeat('3', 64), 'v1', 'v1', clock_timestamp() + interval '2 days',
   clock_timestamp(), 'e2072000-0000-4000-8000-000000000002', null),
  (pg_temp.patient(25), 'e2077000-0000-4000-8000-000000000025', repeat('4', 64), 'v1', 'v1', clock_timestamp() + interval '2 days',
   null, null, clock_timestamp());
insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
  encryption_key_version, display_hint, verified, source_system, verified_at)
values ('e2078000-0000-4000-8000-000000000026', pg_temp.patient(26), 'phone', decode(repeat('5b', 40), 'hex'), repeat('7', 64),
  'k1', '0001', true, 'merge-suite', clock_timestamp());
-- p16 (in review, asked for in 3m) gains a visit with 2 notes, a recorded vital and one entered in error.
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e2079000-0000-4000-8000-000000000004', pg_temp.patient(16), 'e2071000-0000-4000-8000-000000000001',
  'e2072000-0000-4000-8000-000000000003', 'e2074000-0000-4000-8000-000000000003', 'emergency', 'in_progress', clock_timestamp());
insert into ehr.clinical_notes (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id, note_type, title)
select gen_random_uuid(), 'e2079000-0000-4000-8000-000000000004', pg_temp.patient(16), 'e2071000-0000-4000-8000-000000000001',
  'e2072000-0000-4000-8000-000000000003', 'e2074000-0000-4000-8000-000000000003', 'progress', 'Fictional note ' || n
  from generate_series(1, 2) n;
insert into ehr.vitals (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id, recorded_at,
  pulse_bpm, status, status_changed_at)
select gen_random_uuid(), 'e2079000-0000-4000-8000-000000000004', pg_temp.patient(16), 'e2071000-0000-4000-8000-000000000001',
  'e2072000-0000-4000-8000-000000000003', 'e2074000-0000-4000-8000-000000000003', clock_timestamp(), 70 + n,
  case when n = 2 then 'entered_in_error' else 'recorded' end, case when n = 2 then clock_timestamp() end
  from generate_series(1, 2) n;
-- Member 1 also works at O (a second membership of the same account).
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
values ('e2074000-0000-4000-8000-000000000009', 'e2073000-0000-4000-8000-000000000001', 'e2072000-0000-4000-8000-000000000001',
  'e2070000-0000-4000-8000-000000000002', 'e2071000-0000-4000-8000-000000000002', 'receptionist', 'receptionist', false, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('e2075000-0000-4000-8000-000000000009', 'e2072000-0000-4000-8000-000000000001', 'receptionist', 'facility',
  'e2074000-0000-4000-8000-000000000009', 'e2071000-0000-4000-8000-000000000002', 'Merge suite member at O');
set local session_replication_role = origin;
create function pg_temp.merge_by_key(label text) returns uuid language sql security definer as $f$
  select merge_row.id from identity.patient_merges merge_row where merge_row.request_idempotency_key = pg_temp.key(label);
$f$;
create function pg_temp.newest(facility uuid, wanted text) returns text language sql security definer as $f$
  select string_agg(merge_row.id::text, ',' order by merge_row.created_at desc, merge_row.id desc)
    from identity.patient_merges merge_row where merge_row.facility_id = facility and merge_row.status = wanted;
$f$;
grant execute on all functions in schema pg_temp to hid_identity_api_runtime;
set local role hid_identity_api_runtime;
select pg_temp.as_member(1, 'merge-suite-extra-0001');
-- The source rule's facility, record and status checks.
select pg_temp.expect('10a a desk record here whose patient is not active', 'P0001 PATIENT_NOT_FOUND',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(18), pg_temp.ref('x18', pg_temp.patient(9), 1), 'x18')));
select pg_temp.expect('10b a desk record made at another facility', 'P0001 PATIENT_NOT_FOUND',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(20), pg_temp.ref('x20', pg_temp.patient(9), 1), 'x20')));
select pg_temp.expect('10c another facility''s desk record this facility linked (linked_existing)', 'P0001 PATIENT_NOT_FOUND',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(21), pg_temp.ref('x21', pg_temp.patient(9), 1), 'x21')));
-- The target's sealed demo side.
select pg_temp.expect('10d a target across the seals (sealed demo)', 'P0001 MERGE_TARGET_NOT_ALLOWED',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(26), pg_temp.ref('x23', pg_temp.patient(23), 1), 'x23')));
-- Not open, so still allowed: a claimed code, an invalidated code, a verified identifier that is not a NIN. (An
-- unverified NIN row cannot exist: 0138's patient_identifiers_nin_verification_ck.)
select pg_temp.expect('10e2 a desk record whose outreach code was claimed, one whose code was invalidated, one with a verified phone: allowed',
  'ok ok ok',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(24), pg_temp.ref('x24', pg_temp.patient(9), 1), 'x24')) || ' '
  || pg_temp.outcome(pg_temp.request(pg_temp.patient(25), pg_temp.ref('x25', pg_temp.patient(9), 1), 'x25')) || ' '
  || pg_temp.outcome(pg_temp.request(pg_temp.patient(26), pg_temp.ref('x26', pg_temp.patient(9), 1), 'x26')));
-- Another facility's approver cannot refuse this facility's requests, decided or open: not found, no ids.
select pg_temp.as_member(6, 'merge-suite-extra-0002');
select pg_temp.expect('10e another facility''s approver refuses this facility''s requests (decided, then open)',
  'P0001 MERGE_NOT_FOUND {} | P0001 MERGE_NOT_FOUND {}',
  (select pg_temp.outcome(answer) || ' ' || coalesce((answer -> 'detail')::text, 'null')
     from pg_temp.call(format('select * from identity.refuse_patient_merge(%L, 2, %L, %L, %L)',
       pg_temp.merge_by_key('r1'), 'Not the same person at all', pg_temp.key('x-o-refuse'), pg_temp.sha('x-o-refuse'))) answer)
  || ' | ' ||
  (select pg_temp.outcome(answer) || ' ' || coalesce((answer -> 'detail')::text, 'null')
     from pg_temp.call(format('select * from identity.refuse_patient_merge(%L, 1, %L, %L, %L)',
       pg_temp.merge_by_key('r15'), 'Not the same person at all', pg_temp.key('x-o-refuse2'), pg_temp.sha('x-o-refuse2'))) answer));
-- The list's status filter and its newest-first order.
select pg_temp.as_member(3, 'merge-suite-extra-0003');
select pg_temp.expect('10f the status filter: refused, then cancelled', 'r2 | r1',
  (select string_agg(label, ',') from merge_ids where id in (select (row_ -> 'merge' ->> 'mergeId')::uuid
     from jsonb_array_elements(pg_temp.call('select * from identity.list_patient_merges(''facility'', ''refused'', 100, null, null)') -> 'rows') row_))
  || ' | ' || (select string_agg(label, ',') from merge_ids where id in (select (row_ -> 'merge' ->> 'mergeId')::uuid
     from jsonb_array_elements(pg_temp.call('select * from identity.list_patient_merges(''facility'', ''cancelled'', 100, null, null)') -> 'rows') row_)));
select pg_temp.call('select * from identity.list_patient_merges(''facility'', ''requested'', 2, null, null)') as x_page_one \gset
select pg_temp.expect('10g the two pages, in order, are every open request here newest first, each once',
  pg_temp.newest('e2071000-0000-4000-8000-000000000001', 'requested'),
  (select string_agg(row_ -> 'merge' ->> 'mergeId', ',' order by position) from (
     select row_, position from jsonb_array_elements(:'x_page_one'::jsonb -> 'rows') with ordinality page(row_, position)
     union all
     select row_, 100 + position from jsonb_array_elements(pg_temp.call(format(
       'select * from identity.list_patient_merges(''facility'', ''requested'', 100, %L, %L)',
       :'x_page_one'::jsonb -> 'rows' -> 1 -> 'merge' ->> 'requestedAt', :'x_page_one'::jsonb -> 'rows' -> 1 -> 'merge' ->> 'mergeId'))
       -> 'rows') with ordinality page(row_, position)) pages));
select pg_temp.expect('10g2 the open requests here are more than one page', 'true',
  (select (count(*) > 2)::text from regexp_split_to_table(pg_temp.newest('e2071000-0000-4000-8000-000000000001', 'requested'), ',')));
-- A source that gains a disqualifier after the request, read by an approver who did not ask.
reset role;
set local session_replication_role = replica;
update identity.outreach_health_id_claims set expires_at = clock_timestamp() + interval '2 days'
 where patient_id = pg_temp.patient(17);
set local session_replication_role = origin;
set local role hid_identity_api_runtime;
select pg_temp.as_member(4, 'merge-suite-extra-0004');
select pg_temp.expect('10h an open request whose source has since gained an open outreach claim: not still allowed; not asked by me',
  'false false',
  (select (answer -> 'rows' -> 0 -> 'merge' ->> 'sourceStillAllowed') || ' ' || (answer -> 'rows' -> 0 -> 'merge' ->> 'requestedByMe')
     from pg_temp.call(format('select * from identity.read_patient_merge(%L)', pg_temp.merge_by_key('r17'))) answer));
-- The refusal's DETAIL names both patients (identity-api's denied row takes the target from it).
select pg_temp.as_member(3, 'merge-suite-extra-0005');
select pg_temp.expect('10i MERGE_SECOND_PERSON_REQUIRED''s DETAIL names the merge and both patients',
  pg_temp.merge_by_key('r15') || ' ' || pg_temp.patient(15) || ' ' || pg_temp.patient(9),
  (select (answer -> 'detail' ->> 'mergeId') || ' ' || (answer -> 'detail' ->> 'sourcePatientId') || ' '
          || (answer -> 'detail' ->> 'targetPatientId')
     from pg_temp.call(format('select * from identity.refuse_patient_merge(%L, 1, %L, %L, %L)',
       pg_temp.merge_by_key('r15'), 'Not the same person at all', pg_temp.key('x-self'), pg_temp.sha('x-self'))) answer));
-- Member 1 at O, with its other membership: its key from H is not replayed there, and H's request is not its to cancel
-- there.
select set_config('app.actor_subject', 'synthetic:merge:member-1', true),
  set_config('app.membership_id', 'e2074000-0000-4000-8000-000000000009', true),
  set_config('app.facility_id', 'e2071000-0000-4000-8000-000000000002', true),
  set_config('app.correlation_id', 'merge-suite-extra-0006', true), set_config('app.purpose_of_use', 'healthcare-operations', true);
select pg_temp.expect('10j the same account at another facility: its key is not replayed there', '23505 IDEMPOTENCY_KEY_REUSED',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(1), pg_temp.ref('x-r1n-o', pg_temp.patient(9), 1), 'r1-new')));
select pg_temp.expect('10k the same account at another facility cannot cancel this facility''s request', 'P0001 MERGE_NOT_FOUND',
  pg_temp.outcome(pg_temp.call(format('select * from identity.cancel_patient_merge(%L, 1, %L, %L)',
    pg_temp.merge_by_key('r1-new'), pg_temp.key('x-o-cancel'), pg_temp.sha('x-o-cancel')))));
select pg_temp.expect('10k2 and its mine list there holds none of its requests at H', '0',
  jsonb_array_length(pg_temp.call('select * from identity.list_patient_merges(''mine'', null, 100, null, null)') -> 'rows')::text);
-- The lab member (no identity.registration.write): the mine list and cancel.
select pg_temp.as_member(8, 'merge-suite-extra-0009');
select pg_temp.expect('10l the lab member: the mine list and cancel are denied', '42501 MERGE_DENIED 42501 MERGE_DENIED',
  pg_temp.outcome(pg_temp.call('select * from identity.list_patient_merges(''mine'', null, 100, null, null)')) || ' '
  || pg_temp.outcome(pg_temp.call(format('select * from identity.cancel_patient_merge(%L, 1, %L, %L)',
       pg_temp.merge_by_key('r1-new'), pg_temp.key('x-lab-cancel'), pg_temp.sha('x-lab-cancel')))));
-- The moves of notes and vitals, counted through the visits, equal the source's rows by patient (D4).
select pg_temp.as_member(4, 'merge-suite-extra-0010');
select (pg_temp.call(format('select * from identity.read_patient_merge(%L)', pg_temp.merge_by_key('r16'))) -> 'rows' -> 0
          -> 'merge' -> 'moves') as moves_16,
       (pg_temp.call(format('select * from identity.read_patient_merge(%L)', pg_temp.merge_by_key('r1-new'))) -> 'rows' -> 0
          -> 'merge' -> 'moves') as moves_1 \gset
reset role;
insert into ehr.unknown_patient_cancel_scans (backend_pid, transaction_started_at)
values (pg_backend_pid(), transaction_timestamp());
set local role relb_migrator;
select string_agg((select count(*) from ehr.clinical_notes row_ where row_.patient_id = pg_temp.patient(n)) || ' '
         || (select count(*) from ehr.vitals row_ where row_.patient_id = pg_temp.patient(n)), ' | ' order by n desc) as direct
  from unnest(array[1, 16]) n \gset
reset role;
delete from ehr.unknown_patient_cancel_scans scan where scan.backend_pid = pg_backend_pid();
select pg_temp.expect('10m notes and vitals counted through the visits: the source''s own, as the owner counts them by patient',
  '1 2 1 | 3 3 5 | 2 1 | 3 5',
  (:'moves_16'::jsonb ->> 'visits') || ' ' || (:'moves_16'::jsonb ->> 'notes') || ' ' || (:'moves_16'::jsonb ->> 'vitals')
  || ' | ' || (:'moves_1'::jsonb ->> 'visits') || ' ' || (:'moves_1'::jsonb ->> 'notes') || ' ' || (:'moves_1'::jsonb ->> 'vitals')
  || ' | ' || :'direct');
-- An inactive membership and one on a migration hold.
set local session_replication_role = replica;
update identity.staff_facility_memberships set active = false where id = 'e2074000-0000-4000-8000-000000000002';
set local session_replication_role = origin;
set local role hid_identity_api_runtime;
select pg_temp.as_member(2, 'merge-suite-extra-0007');
select pg_temp.expect('10n an inactive membership', '42501 MERGE_DENIED',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(2), pg_temp.ref('x-inactive', pg_temp.patient(9), 2), 'x-inactive')));
reset role;
set local session_replication_role = replica;
update identity.staff_facility_memberships set active = true, migration_hold_reason = 'Fictional migration hold'
 where id = 'e2074000-0000-4000-8000-000000000002';
set local session_replication_role = origin;
set local role hid_identity_api_runtime;
select pg_temp.as_member(2, 'merge-suite-extra-0008');
select pg_temp.expect('10o a membership on a migration hold', '42501 MERGE_DENIED',
  pg_temp.outcome(pg_temp.request(pg_temp.patient(2), pg_temp.ref('x-hold', pg_temp.patient(9), 2), 'x-hold')));
reset role;
select pg_temp.expect('10p no marker is left behind by these either', '0',
  (select count(*)::text from ehr.unknown_patient_cancel_scans scan where scan.backend_pid = pg_backend_pid()));

select current_setting('m207.passed') as passed \gset
\echo '0207 merge requests suite: ' :passed ' cases passed'
rollback;
