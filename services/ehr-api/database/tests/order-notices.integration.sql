-- 0159 (ORD-11, owner decision Q128 A): notices to the doctor who ordered a
-- lab request or a prescription, written by the zz_order_notice triggers and
-- read through the EHR runtime's definers (the clinical owner's design note
-- on hid-system#258, 26 November 2026). Rollback-only, apart from this
-- session's temporary helpers. Releases, invalidations, dispensings and
-- reversals run as the exact Lab and Pharmacy runtimes, in the sessions the
-- services set; the notices are read through the EHR runtime. It passes on
-- a superuser owner and on a NOSUPERUSER NOBYPASSRLS one (production's);
-- 17a shows the difference that matters.
-- Cases (the labels start with their number):
--   1. EXECUTE on the five definers for the EHR runtime only; no runtime
--      role reads or writes the three tables; each zz_order_notice fires
--      after its table's route return;
--   2. own lab work at GH: a release is lab_result_ready to the order's
--      creator at the ordering facility; a later version is
--      lab_result_corrected; a version flagged critical_candidate is
--      lab_result_critical (needs Seen), a correction too (critical, then
--      corrected, then ready); a second result on the order merges into the
--      unread ready notice (count 2, version 2, last event and source moved);
--   3. own pharmacy work at GH (0133's send): the first fill is
--      prescription_dispensed, a refill writes nothing, each reversal (the
--      refill's too) is dispensing_reversed, merged while unread;
--   4. routed lab work at L1, found through the route reports: ready,
--      corrected, critical (the report's flag), withdrawn for a released
--      version; a version never released, entered in error: no notice and
--      no gap;
--   5. routed pharmacy work at PH1: dispensed, then reversed;
--   6. 0088's reports in the window, lab and pharmacy: the command's own
--      invalidation and reversal are notices; no gap;
--   7. 0090's late corrections by members without the patient's consent
--      (who then read none of the work item), lab and pharmacy: notices;
--      no gap;
--   8. every notice went to DA at GH; routed ones carry their route;
--   9. DA's summary; the unread list page by page (critical not Seen first,
--      then newest, each once); every notice; a routed and an own row as
--      listed; the audit rows (one per list, one per patient shown, none
--      for the summary);
--  10. DA's sibling membership at GH reads the same; DA's pharmacist
--      membership the prescription notices only; another doctor at GH, DA
--      at another facility, a doctor there, GH's pharmacist (own work
--      switched on) and GH's laboratory read nothing of DA's; a
--      receptionist, an emergency session and a session without a
--      membership are refused; bad arguments; none of it changes a notice;
--  11. mark read with versions: a stale version changes nothing (the notice
--      stays unread and counted); the current one reads it; an unknown pair
--      is not counted; one audit row per patient; a release after the ready
--      notice was read starts a new one;
--  12. a critical notice read but not Seen stays counted and on top; Seen
--      records the account and membership (version 3, read time kept); Seen
--      again changes nothing; Seen through the sibling membership;
--  13. access ended (DA's consents for Q end): Q's notices are listed with
--      no patient, card, visit or display, the critical one in its place;
--      mark read works; Seen is refused (42501 ORDER_NOTICE_CONSENT_REQUIRED);
--  14. the release notes' count check: source rows = events in notices +
--      gaps, and no gap;
--  15. the switch off: no notice and no gap;
--  16. the catch rule under READ COMMITTED (the switch's read made to
--      fail): 40P01 in 0088's report is a gap row and the report goes
--      through; 40001 is raised again; any other SQLSTATE is a gap;
--  17. the sweep in withSystemTransaction's session, where the owner reads
--      no EHR order unless it bypasses row-level security: notices past
--      their time go, one expire audit row each, and gaps after 90 days;
--      kept: critical notices never Seen, a read one inside 90 days, and
--      anything under an unreleased hold on the patient, the recipient or
--      the Seen account; a released hold keeps nothing; the batch's bounds;
--  18. other lanes' triggers: 0159 taken away, then the file run as
--      written (psql \ir): with Billing's two it applies; another lane's
--      trigger, Billing's name with another type, and Billing's reversal
--      trigger on the other table are each refused by section 0 (and by the
--      post-check when left in place);
--  19. SERIALIZABLE (a second transaction with a small fixture of its own):
--      after a new notice, a merge, a critical notice, a dispensing and a
--      reversal, the transaction holds no SIRead lock on the notices, the
--      gaps or their indexes, so writes on different orders cannot conflict
--      through them; 40P01 and 40001 are raised again (the services retry);
--      any other SQLSTATE is a gap.
-- A concurrent pair (two releases on different orders, both committing)
-- needs committed rows, which a rollback-only suite cannot hold; 19 checks
-- what it rests on.
-- When 0159 takes its final number, case 18's \ir path and the refusal
-- texts it expects change with it.
-- Fixture: the P4c suites' shared fixture (each suite carries its own copy,
-- so it runs alone; synthetic values only, uuid prefix e4c):
--   Platform: SA (platform_super_admin), SU (support_admin), FR
--     (facility_review_admin), AU (security_auditor).
--   Governed hospital GH (an approved admin_review hospital application, the
--     ordering facility A): DA doctor (MDCN licence attested by the facility),
--     CA clinician, NA nurse, LA lab, PA pharmacist, RA receptionist, GA
--     org_admin; each but GA holds a direct-care write consent for patients P,
--     Q and N at GH.
--   Governed hospital H3 (a third facility): D3 doctor with a consent for P.
--   Governed laboratory GL (approved laboratory application, product
--     laboratory at GL, registered address): GLM lab.
--   Self-signed-up and reviewed (through P4's sign-up and P4b's review):
--     laboratory L1 (method cac_registered_contact; its administrator LB1
--     holds lab), with LB2 lab and RB receptionist added; pharmacy PH1
--     (pharmacist administrator PB1), with PB2 pharmacist added.
--   Patients P and Q with active accounts (a live patient session each), N
--     without an account. Encounters EP, EQ and EN at GH.
-- And this suite's own: 51 LC lab and 52 D2 doctor at GH (D2 with consents
-- for P and Q), and three more memberships of DA's account, 53 clinician at
-- GH, 54 doctor at H3 and 55 pharmacist at GH, each with DA's consents
-- there. GH's own lab items are accepted by LA (owner SQL, as lab-api takes
-- them), their results entered by LC and checked by LA (owner SQL), and
-- released by LA; GH's prescriptions go to its own pharmacy through 0133's
-- send and are dispensed by PA.
\set ON_ERROR_STOP on
set plpgsql.variable_conflict = error;

-- Helpers for both transactions, made before the first one, so they last
-- for this session only (temporary functions; nothing is kept).
-- A member's session as ehr-api, lab-api and pharmacy-api set it (the new
-- images also set app.own_facility_work, 0133 D13), by membership number:
-- the account, subject and facility are the membership's.
create function pg_temp.as_member(member integer, purpose text default 'direct-care')
returns void language sql security definer as $f$
  select set_config('app.own_facility_work', '0133', true),
    set_config('app.actor_subject', account_row.subject, true),
    set_config('app.membership_id', membership.id::text, true),
    set_config('hid.test.actor_account', account_row.id::text, true),
    set_config('app.facility_id', membership.facility_id::text, true),
    set_config('app.correlation_id', 'order-notices-' || member || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true)
    from identity.staff_facility_memberships membership
    join auth.accounts account_row on account_row.id = membership.account_id
   where membership.id = ('e4c13000-0000-4000-8000-0000000000' || member)::uuid
$f$;
-- A case: stops the suite at once when it fails, and counts it otherwise
-- in a sequence, which keeps its count across ROLLBACK TO SAVEPOINT (the
-- cases below undo their own changes that way).
create temporary sequence order_notices_passed;
grant usage, select on sequence pg_temp.order_notices_passed to public;
create function pg_temp.same(label text, actual text, expected text) returns void language plpgsql as $f$
begin
  if coalesce(actual, 'null') is distinct from expected then
    raise exception 'ORD-11 order notices suite failed: %: expected [%] got [%]', label, expected,
      coalesce(actual, 'null');
  end if;
  perform nextval('pg_temp.order_notices_passed');
end
$f$;
-- A kept id.
create function pg_temp.id(name text) returns uuid language sql stable as $f$
  select current_setting('hid.test.' || name)::uuid
$f$;
-- Owner SQL, as lab-api takes an order of its own facility (as replica, as
-- the own-facility suite writes it): DA's lab request becomes a work item at
-- GH accepted by LA, with its one requested test. Answers the work item.
create function pg_temp.own_lab_item(lab_request_id uuid)
returns uuid language plpgsql as $f$
declare
  request ehr.lab_requests%rowtype;
  item_id uuid := gen_random_uuid();
begin
  select * into request from ehr.lab_requests where id = lab_request_id;
  set local session_replication_role = replica;
  insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
    source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
    requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
  values (item_id, request.patient_id, request.facility_id, request.facility_id, request.id, request.row_version,
    request.encounter_id, 'accepted', 'routine', request.test_code_system, request.test_code, request.test_display,
    request.created_by, request.created_at, 'e4c10000-0000-4000-8000-000000000014',
    'e4c13000-0000-4000-8000-000000000014', 'order-notices-item-' || item_id, repeat('b', 64),
    'order-notices-fixture');
  insert into lab.work_item_requested_tests (id, work_item_id, facility_id, patient_id, ordinal, code_system, code, name)
  values (gen_random_uuid(), item_id, request.facility_id, request.patient_id, 1, request.test_code_system,
    request.test_code, request.test_display);
  set local session_replication_role = origin;
  return item_id;
end
$f$;
-- Owner SQL: a received specimen and a completed run on an own item, with
-- result version 1 (the flag given) entered by LC and checked by LA, as
-- lab-api leaves them. Answers the result; hid.test.<label>_check_1 keeps
-- the check.
create function pg_temp.own_result(work_item uuid, label text, flag text, value numeric)
returns uuid language plpgsql as $f$
declare
  item lab.work_items%rowtype;
  test_id uuid;
  accession_ref uuid;
  next_ordinal integer;
  requirement_ref uuid := gen_random_uuid();
  specimen_ref uuid := gen_random_uuid();
  execution_ref uuid := gen_random_uuid();
  made_result uuid := gen_random_uuid();
  check_id uuid := gen_random_uuid();
begin
  select * into item from lab.work_items where id = work_item;
  select test.id into test_id from lab.work_item_requested_tests test where test.work_item_id = work_item;
  set local session_replication_role = replica;
  select accession_row.id into accession_ref from lab.accessions accession_row
   where accession_row.work_item_id = work_item;
  if accession_ref is null then
    accession_ref := gen_random_uuid();
    insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
      idempotency_key, request_sha256, correlation_id)
    values (accession_ref, work_item, item.patient_id, item.facility_id, item.priority,
      'e4c10000-0000-4000-8000-000000000051', 'e4c13000-0000-4000-8000-000000000051',
      'order-notices-acc-' || label || '-000001', repeat('a', 64), 'order-notices-fixture');
  end if;
  select coalesce(max(requirement.ordinal), 0) + 1 into next_ordinal
    from lab.specimen_requirements requirement where requirement.accession_id = accession_ref;
  insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
  values (requirement_ref, accession_ref, item.patient_id, item.facility_id, next_ordinal, 'whole blood');
  insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type, status,
    collected_at, collected_by, collected_by_membership_id, received_at, received_by, received_by_membership_id,
    row_version)
  values (specimen_ref, requirement_ref, accession_ref, item.patient_id, item.facility_id, 'whole blood', 'received',
    clock_timestamp(), 'e4c10000-0000-4000-8000-000000000051', 'e4c13000-0000-4000-8000-000000000051', clock_timestamp(),
    'e4c10000-0000-4000-8000-000000000051', 'e4c13000-0000-4000-8000-000000000051', 3);
  insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, status,
    started_by, started_by_membership_id, started_at, completed_by, completed_by_membership_id, completed_at,
    idempotency_key, request_sha256, correlation_id, row_version)
  values (execution_ref, accession_ref, specimen_ref, test_id, item.patient_id, item.facility_id, 'completed',
    'e4c10000-0000-4000-8000-000000000051', 'e4c13000-0000-4000-8000-000000000051', clock_timestamp(),
    'e4c10000-0000-4000-8000-000000000051', 'e4c13000-0000-4000-8000-000000000051', clock_timestamp(),
    'order-notices-run-' || label || '-000001', repeat('a', 64), 'order-notices-fixture', 2);
  insert into lab.results (id, execution_id, patient_id, facility_id, created_by, created_by_membership_id)
  values (made_result, execution_ref, item.patient_id, item.facility_id, 'e4c10000-0000-4000-8000-000000000051',
    'e4c13000-0000-4000-8000-000000000051');
  insert into lab.result_revisions (result_id, execution_id, patient_id, facility_id, version, result_type,
    numeric_value, unit, reference_range, abnormal_flag, entered_by, entered_by_membership_id, idempotency_key,
    request_sha256, correlation_id, revision_kind)
  values (made_result, execution_ref, item.patient_id, item.facility_id, 1, 'numeric', value, 'g/dL', '12.0-15.5',
    flag, 'e4c10000-0000-4000-8000-000000000051', 'e4c13000-0000-4000-8000-000000000051',
    'order-notices-rev-' || label || '-000001', repeat('a', 64), 'order-notices-fixture', 'original');
  insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
    verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
  values (check_id, made_result, execution_ref, item.patient_id, item.facility_id, 1,
    'e4c10000-0000-4000-8000-000000000014', 'e4c13000-0000-4000-8000-000000000014', clock_timestamp(),
    'Checked by the second scientist', 'order-notices-check-' || label || '-000001', repeat('a', 64),
    'order-notices-fixture');
  set local session_replication_role = origin;
  perform set_config('hid.test.' || label || '_check_1', check_id::text, true);
  return made_result;
end
$f$;
-- Owner SQL: version n of an own result (a correction of n - 1, the flag
-- given), entered by LC and checked by LA. Answers the check.
create function pg_temp.own_version(result uuid, label text, version_number integer, flag text, value numeric)
returns uuid language plpgsql as $f$
declare
  head lab.results%rowtype;
  check_id uuid := gen_random_uuid();
begin
  select * into head from lab.results where id = result;
  set local session_replication_role = replica;
  insert into lab.result_revisions (result_id, execution_id, patient_id, facility_id, version, result_type,
    numeric_value, unit, reference_range, abnormal_flag, entered_by, entered_by_membership_id, correction_reason,
    idempotency_key, request_sha256, correlation_id, revision_kind, supersedes_version)
  values (result, head.execution_id, head.patient_id, head.facility_id, version_number, 'numeric', value, 'g/dL',
    '12.0-15.5', flag, 'e4c10000-0000-4000-8000-000000000051', 'e4c13000-0000-4000-8000-000000000051',
    'Read again after calibration', 'order-notices-rev-' || label || '-00000' || version_number, repeat('a', 64),
    'order-notices-fixture', 'correction', version_number - 1);
  update lab.results set current_version = version_number where id = result;
  insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
    verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
  values (check_id, result, head.execution_id, head.patient_id, head.facility_id, version_number,
    'e4c10000-0000-4000-8000-000000000014', 'e4c13000-0000-4000-8000-000000000014', clock_timestamp(),
    'Checked the correction', 'order-notices-check-' || label || '-00000' || version_number, repeat('a', 64),
    'order-notices-fixture');
  set local session_replication_role = origin;
  return check_id;
end
$f$;
-- lab-api's release statement, as the session's member.
create function pg_temp.release_as(result uuid, version_number bigint, check_id uuid, key text)
returns void language plpgsql as $f$
declare head record;
begin
  select result_row.execution_id, result_row.patient_id, result_row.facility_id into head
    from lab.results result_row where result_row.id = result;
  insert into lab.result_releases (verification_id, result_id, execution_id, patient_id, facility_id, result_version,
    released_by, released_by_membership_id, released_at, reason, idempotency_key, request_sha256, correlation_id)
  values (check_id, result, head.execution_id, head.patient_id, head.facility_id, version_number,
    current_setting('hid.test.actor_account')::uuid, current_setting('app.membership_id')::uuid, clock_timestamp(),
    'Released to the requester', key, repeat('b', 64), current_setting('app.correlation_id'));
end
$f$;
-- A prescription by DA for patient n (1 P, 2 Q, 3 N), active, with refills
-- (30-day fills) or none, as ehr-api writes it through the EHR runtime;
-- then GH's own pharmacy send (0133 D7) as DA. Answers the prescription.
create function pg_temp.own_rx(n integer, refills integer default null)
returns uuid language plpgsql as $f$
declare
  created uuid := gen_random_uuid();
  sent record;
begin
  perform pg_temp.as_member(11);
  insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
    instructions, starts_on, status, refills_allowed, duration_value, duration_unit)
  values (created, ('e4c50000-0000-4000-8000-00000000000' || n)::uuid, ('e4c30000-0000-4000-8000-00000000000' || n)::uuid,
    'e4c21000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000011',
    'e4c13000-0000-4000-8000-000000000011', 'urn:p4c:medication', 'amoxicillin-500', 'Amoxicillin 500 mg', 1,
    'capsule', 'oral', 'Every 8 hours', 'Take after food', current_date, 'active', refills, 30, 'day');
  select * into sent from ehr.send_prescription_to_own_pharmacy(created, 1);
  if sent.outcome is distinct from 'sent' then
    raise exception 'ORD-11 suite: the own pharmacy send of % answered %', created, sent.outcome;
  end if;
  return created;
end
$f$;
-- A prescription's own work item at GH.
create function pg_temp.item_of(prescription uuid) returns uuid language sql security definer as $f$
  select item.id from pharmacy.work_items item
   where item.source_ehr_prescription_id = prescription and item.order_route_id is null
$f$;
-- pharmacy-api's dispensing of a fill, as the session's member.
create function pg_temp.dispense_fill(work_item uuid, fill integer, key text)
returns uuid language plpgsql as $f$
declare
  item record;
  created uuid := gen_random_uuid();
begin
  select candidate.patient_id, candidate.facility_id, candidate.medication_code_system, candidate.medication_code,
         candidate.medication_display into item
    from pharmacy.work_items candidate where candidate.id = work_item;
  insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id, medication_code_system,
    medication_code, medication_display, quantity_dispensed, quantity_unit, dispensed_by, dispensed_by_membership_id,
    reason, idempotency_key, request_sha256, correlation_id, fill_number)
  values (created, work_item, 1, item.patient_id, item.facility_id, item.medication_code_system, item.medication_code,
    item.medication_display, 21, 'capsule', current_setting('hid.test.actor_account')::uuid,
    current_setting('app.membership_id')::uuid, 'Dispensed the full course', key, repeat('c', 64),
    current_setting('app.correlation_id'), fill);
  return created;
end
$f$;
-- pharmacy-api's reversal of a dispensing, as the session's member.
create function pg_temp.reverse(dispensing uuid, key text)
returns uuid language plpgsql as $f$
declare
  found_row record;
  created uuid := gen_random_uuid();
begin
  select dispensed.work_item_id, dispensed.patient_id, dispensed.facility_id into found_row
    from pharmacy.dispensings dispensed where dispensed.id = dispensing;
  insert into pharmacy.dispensing_reversals (id, dispensing_id, dispensing_version, work_item_id, patient_id,
    facility_id, reversed_by, reversed_by_membership_id, reason, idempotency_key, request_sha256, correlation_id)
  values (created, dispensing, 1, found_row.work_item_id, found_row.patient_id, found_row.facility_id,
    current_setting('hid.test.actor_account')::uuid, current_setting('app.membership_id')::uuid,
    'Wrong strength handed out', key, repeat('e', 64), current_setting('app.correlation_id'));
  return created;
end
$f$;
-- The owner's view of an order's notices, oldest first: kind:count:version,
-- then read, seen, needs-seen and routed where they apply.
create function pg_temp.notices(wanted_order uuid) returns text language sql security definer as $f$
  select coalesce(string_agg(format('%s:%s:%s%s%s%s%s', notice.kind, notice.event_count, notice.row_version,
           case when notice.read_at is null then '' else ':read' end,
           case when notice.seen_at is null then '' else ':seen' end,
           case when notice.needs_seen then ':needs-seen' else '' end,
           case when notice.order_route_id is null then '' else ':routed' end),
           ' ' order by notice.created_at, notice.id), 'none')
    from ehr.order_notices notice where notice.order_id = wanted_order
$f$;
-- The latest notice of an order and kind, as the owner reads it.
create function pg_temp.notice(wanted_order uuid, wanted_kind text) returns jsonb
language sql security definer as $f$
  select to_jsonb(notice) from ehr.order_notices notice where notice.order_id = wanted_order and notice.kind = wanted_kind
   order by notice.created_at desc, notice.id desc limit 1
$f$;
create function pg_temp.gaps() returns bigint language sql security definer as $f$
  select count(*) from ehr.order_notice_gaps
$f$;
-- The session's summary as one line (kind unread/critical not Seen), or
-- the refusal.
create function pg_temp.summary() returns text language plpgsql as $f$
declare answer text;
begin
  select coalesce(string_agg(summary_row.kind || ' ' || summary_row.unread_count || '/'
           || summary_row.critical_not_seen_count, ', ' order by summary_row.kind), 'none')
    into answer from ehr.order_notice_summary() summary_row;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- Every page of the session's list, followed by its cursor: the ids in
-- order, then the has_more flag of each page.
create function pg_temp.pages(wanted_state text, page_size integer) returns text language plpgsql as $f$
declare
  cursor_id uuid;
  listed uuid[] := array[]::uuid[];
  flags text := '';
  page_ids uuid[];
  page_more boolean;
begin
  loop
    select array_agg(listing.notice_id order by listing.ordinality), bool_or(listing.has_more)
      into page_ids, page_more
      from ehr.list_order_notices(wanted_state, cursor_id, page_size) with ordinality listing;
    exit when page_ids is null;
    listed := listed || page_ids;
    flags := flags || case when page_more then 'm' else '.' end;
    exit when not page_more;
    cursor_id := page_ids[cardinality(page_ids)];
  end loop;
  return array_to_string(listed, ',') || ' ' || flags;
end
$f$;
-- The order the list must give, as the owner computes it: critical notices
-- not Seen first, then newest (last event, id), for a recipient at GH.
create function pg_temp.expected_order(wanted_state text, recipient uuid) returns text
language sql security definer as $f$
  select coalesce(array_to_string(array_agg(notice.id order by
           case when notice.needs_seen and notice.seen_at is null then 1 else 0 end desc, notice.last_event_at desc,
           notice.id desc), ','), '')
    from ehr.order_notices notice
   where notice.ordering_facility_id = 'e4c21000-0000-4000-8000-000000000001' and notice.recipient_account_id = recipient
     and (wanted_state = 'all' or notice.read_at is null or (notice.needs_seen and notice.seen_at is null))
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
-- A statement's single value as text, or 'SQLSTATE message'.
create function pg_temp.value_of(statement text) returns text language plpgsql as $f$
declare answer text;
begin
  execute statement into answer;
  return coalesce(answer, 'null');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- For the catch rule: the switch's row as a view whose read raises the
-- SQLSTATE kept in order_notices.fail (the trigger reads it first).
create function pg_temp.fail_now() returns boolean language plpgsql as $f$
begin
  raise exception using errcode = current_setting('order_notices.fail'), message = 'ORD-11 suite: injected failure';
end
$f$;
-- For the trigger preconditions: an event trigger that, when the file's
-- section 4 makes its first trigger, drops the extra trigger a case added,
-- so the rest of the file runs clean and psql keeps section 0's refusal as
-- its last error (ON_ERROR_ROLLBACK undoes only that statement).
create function pg_temp.drop_extra_trigger() returns event_trigger language plpgsql as $f$
declare statement text := current_setting('order_notices.drop_extra', true);
begin
  if coalesce(statement, '') <> '' then
    perform set_config('order_notices.drop_extra', '', true);
    execute statement;
  end if;
end
$f$;
begin;

do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;

insert into identity.purpose_of_use_codes (code, display, source_system)
values ('direct-care', 'Direct patient care', 'p4c-test') on conflict (code) do nothing;

-- Platform administrators (standalone, no facility membership).
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e4c10000-0000-4000-8000-000000000001', 'synthetic:p4c:super', 'super@p4c.invalid', 'P4c Super Admin', 'active'),
  ('e4c10000-0000-4000-8000-000000000002', 'synthetic:p4c:support', 'support@p4c.invalid', 'P4c Support', 'active'),
  ('e4c10000-0000-4000-8000-000000000003', 'synthetic:p4c:reviewer', 'reviewer@p4c.invalid', 'P4c Reviewer', 'active'),
  ('e4c10000-0000-4000-8000-000000000004', 'synthetic:p4c:auditor', 'auditor@p4c.invalid', 'P4c Auditor', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('e4c11000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform', 'P4c suite super admin'),
  ('e4c11000-0000-4000-8000-000000000002', 'e4c10000-0000-4000-8000-000000000002', 'support_admin', 'platform', 'P4c suite support admin'),
  ('e4c11000-0000-4000-8000-000000000003', 'e4c10000-0000-4000-8000-000000000003', 'facility_review_admin', 'platform', 'P4c suite facility reviewer'),
  ('e4c11000-0000-4000-8000-000000000004', 'e4c10000-0000-4000-8000-000000000004', 'security_auditor', 'platform', 'P4c suite security auditor');

-- Governed organizations: hospital GH, hospital H3, laboratory GL.
insert into identity.organizations (id, name, slug) values
  ('e4c20000-0000-4000-8000-000000000001', 'P4c Governed Hospital Ltd', 'p4c-governed-hospital'),
  ('e4c20000-0000-4000-8000-000000000003', 'P4c Third Hospital Ltd', 'p4c-third-hospital'),
  ('e4c20000-0000-4000-8000-000000000002', 'P4c Governed Diagnostics Ltd', 'p4c-governed-diagnostics');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e4c21000-0000-4000-8000-000000000001', 'e4c20000-0000-4000-8000-000000000001', 'P4c General Hospital',
   'P4C-GH', 'Africa/Lagos', true, 'verified'),
  ('e4c21000-0000-4000-8000-000000000003', 'e4c20000-0000-4000-8000-000000000003', 'P4c Third Hospital',
   'P4C-H3', 'Africa/Lagos', true, 'verified'),
  ('e4c21000-0000-4000-8000-000000000002', 'e4c20000-0000-4000-8000-000000000002', 'P4c Governed Laboratory',
   'P4C-GL', 'Africa/Lagos', true, 'verified');
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, provider_reference,
  verified_at, organization_id, facility_id, reviewed_by_account_id, review_reason, reviewed_at,
  verified_organization_name, verified_entity_type, verified_registration_date, verified_address, verified_registry_status)
select ('e4c22000-0000-4000-8000-00000000000' || g.n)::uuid, g.product, g.legal_name, g.kind, g.cac,
  'Governed Admin ' || g.n, 'admin' || g.n || '@p4c-governed.invalid', 'approved', 'verified', '77' || g.n,
  clock_timestamp(), ('e4c20000-0000-4000-8000-00000000000' || g.n)::uuid,
  ('e4c21000-0000-4000-8000-00000000000' || g.n)::uuid, 'e4c10000-0000-4000-8000-000000000001',
  'Governed approval for the P4c suites', clock_timestamp(), g.legal_name, 'Private Company Limited by Shares',
  '2019-05-01', g.n || ' Governed Road, Ikeja, Lagos', 'active'
  from (values (1, 'ehr', 'hospital', 'RC9944001', 'P4c Governed Hospital Ltd'),
               (2, 'laboratory', 'laboratory', 'RC9944002', 'P4c Governed Diagnostics Ltd'),
               (3, 'ehr', 'hospital', 'RC9944003', 'P4c Third Hospital Ltd')) g(n, product, kind, cac, legal_name);
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id)
select ('e4c20000-0000-4000-8000-00000000000' || n)::uuid, product, ('e4c21000-0000-4000-8000-00000000000' || n)::uuid,
  'active', ('e4c22000-0000-4000-8000-00000000000' || n)::uuid
  from (values (1, 'ehr'), (2, 'laboratory'), (3, 'ehr')) g(n, product);
-- (The binding trigger copies from a ready_for_review application at
-- approval; the fixture writes the approved binding directly.)
set local session_replication_role = replica;
insert into identity.organization_cac_registrations (cac_registration_number, organization_id, primary_facility_id,
  source_application_id, verified_organization_name, verified_entity_type, verified_registration_date, verified_address,
  verified_registry_status, organization_name_source, entity_type_source, registration_date_source, address_source,
  registry_status_source)
values ('RC9944002', 'e4c20000-0000-4000-8000-000000000002', 'e4c21000-0000-4000-8000-000000000002',
  'e4c22000-0000-4000-8000-000000000002', 'P4c Governed Diagnostics Ltd', 'Private Company Limited by Shares',
  '2019-05-01', '2 Governed Road, Ikeja, Lagos', 'active', 'qoreid', 'qoreid', 'qoreid', 'qoreid', 'qoreid');
set local session_replication_role = origin;

-- Governed staff. n: 11 DA doctor, 12 CA clinician, 13 NA nurse, 14 LA lab,
-- 15 PA pharmacist, 16 RA receptionist, 17 GA org_admin (GH); 21 GLM lab
-- (GL); 26 D3 doctor (H3).
insert into auth.accounts (id, subject, email, display_name, status)
select ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, 'synthetic:p4c:' || s.code,
  s.code || '@p4c-staff.invalid', s.full_name, 'active'
  from (values (11, 'da', 'Ada Doctor'), (12, 'ca', 'Bayo Clinician'), (13, 'na', 'Chika Nurse'),
               (14, 'la', 'Dele Lab'), (15, 'pa', 'Efe Pharmacist'), (16, 'ra', 'Funmi Reception'),
               (17, 'ga', 'Gbade Admin'), (21, 'glm', 'Hassan Governed Lab'), (26, 'd3', 'Ifeoma Third Doctor'))
       s(n, code, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.full_name, s.code || '@p4c-staff.invalid', 'verified', s.role
  from (values (11, 'da', 'Ada Doctor', 'doctor'), (12, 'ca', 'Bayo Clinician', 'clinician'),
               (13, 'na', 'Chika Nurse', 'nurse'), (14, 'la', 'Dele Lab', 'lab'), (15, 'pa', 'Efe Pharmacist', 'pharmacist'),
               (16, 'ra', 'Funmi Reception', 'receptionist'), (17, 'ga', 'Gbade Admin', 'org_admin'),
               (21, 'glm', 'Hassan Governed Lab', 'lab'), (26, 'd3', 'Ifeoma Third Doctor', 'doctor'))
       s(n, code, full_name, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c20000-0000-4000-8000-00000000000' || s.org)::uuid,
  ('e4c21000-0000-4000-8000-00000000000' || s.org)::uuid, s.role, s.role, true, true
  from (values (11, 1, 'doctor'), (12, 1, 'clinician'), (13, 1, 'nurse'), (14, 1, 'lab'), (15, 1, 'pharmacist'),
               (16, 1, 'receptionist'), (17, 1, 'org_admin'), (21, 2, 'lab'), (26, 3, 'doctor')) s(n, org, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e4c11000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.role, 'facility', ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c21000-0000-4000-8000-00000000000' || s.org)::uuid, 'P4c suite governed role'
  from (values (11, 1, 'doctor'), (12, 1, 'clinician'), (13, 1, 'nurse'), (14, 1, 'lab'), (15, 1, 'pharmacist'),
               (16, 1, 'receptionist'), (17, 1, 'org_admin'), (21, 2, 'lab'), (26, 3, 'doctor')) s(n, org, role);
-- DA's licence, attested by GH's administrator (P4b's attestation table).
insert into identity.staff_licence_attestations (organization_id, facility_id, account_id, staff_id, membership_id,
  role_code, role_grant_id, licence_body, licence_number, attested_person_name, verification_method,
  attested_by_account_id, attested_by_membership_id, attestation_version, attested_at, correlation_id)
values ('e4c20000-0000-4000-8000-000000000001', 'e4c21000-0000-4000-8000-000000000001',
  'e4c10000-0000-4000-8000-000000000011', 'e4c12000-0000-4000-8000-000000000011',
  'e4c13000-0000-4000-8000-000000000011', 'doctor', 'e4c11000-0000-4000-8000-000000000011', 'MDCN', 'MDCN/45678',
  'Ada Doctor', 'facility_attestation', 'e4c10000-0000-4000-8000-000000000017', 'e4c13000-0000-4000-8000-000000000017',
  'facility-staff-attestation-v1', clock_timestamp(), 'p4c-fixture-licence');

-- Patients: P and Q with active accounts and a live patient session, N
-- without an account.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e4c10000-0000-4000-8000-000000000041', 'synthetic:p4c:patient-p', 'patient-p@p4c.invalid', 'Patience Okafor', 'active'),
  ('e4c10000-0000-4000-8000-000000000042', 'synthetic:p4c:patient-q', 'patient-q@p4c.invalid', 'Quadri Bello', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e4c30000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000041', 'HID-P4CPATP',
   'Patience', 'Okafor', 'Patience Okafor', 'female', '1990-04-12', 'active'),
  ('e4c30000-0000-4000-8000-000000000002', 'e4c10000-0000-4000-8000-000000000042', 'HID-P4CPATQ',
   'Quadri', 'Bello', 'Quadri Bello', 'male', '1985-09-30', 'active'),
  ('e4c30000-0000-4000-8000-000000000003', null, 'HID-P4CPATN', 'Nkem', 'Eze', 'Nkem Eze', 'female', null, 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('e4c31000-0000-4000-8000-00000000000' || n)::uuid, ('e4c10000-0000-4000-8000-00000000004' || n)::uuid,
  ('e4c31000-0000-4000-8000-00000000000' || n)::uuid, md5('p4c-session-' || n) || md5('p4c-session-' || n),
  gen_random_uuid(), 1, 'password', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour',
  clock_timestamp() + interval '2 hours', 'patient', ('e4c30000-0000-4000-8000-00000000000' || n)::uuid
  from generate_series(1, 2) n;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
select gen_random_uuid(), ('e4c30000-0000-4000-8000-00000000000' || p.n)::uuid,
  ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c21000-0000-4000-8000-00000000000' || s.org)::uuid,
  'write_records', 'active', 'P4c suite direct-care consent', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '30 days', false, 'direct-care'
  from (values (11, 1), (12, 1), (13, 1), (14, 1), (15, 1), (16, 1), (26, 3)) s(n, org)
  cross join generate_series(1, 3) p(n)
 where s.n <> 26 or p.n = 1;

-- Self sign-ups through the real commands, then support's review: 1
-- laboratory L1 (lab), 2 pharmacy PH1 (pharmacist).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:p4c:super', true),
  set_config('app.correlation_id', 'p4c-fixture-controls', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'), 'P4c suite opens facility sign-up');
select platform.admin_set_control('cross_facility_orders_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'cross_facility_orders_enabled'), 'P4c suite opens orders between facilities');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'p4c-fixture-signup', true),
  set_config('app.purpose_of_use', '', true);
create function pg_temp.p4c_sign_up(n integer, product text, kind text, cac text, admin_name text, admin_email text,
  legal_name text)
returns void language plpgsql as $f$
declare
  application_id uuid;
  current_application record;
  activated record;
  challenge_id uuid := ('e4c40000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
  code_hmac char(64) := encode(sha256(('p4c-otp-' || n)::bytea), 'hex');
  session_hmac char(64) := encode(sha256(('p4c-session-' || n)::bytea), 'hex');
begin
  application_id := identity.submit_self_service_organization_application(product, kind, cac, admin_name,
    admin_email, encode(sha256(('p4c-network-' || n)::bytea), 'hex'));
  select * into current_application from identity.public_get_organization_application(cac, admin_email, product);
  perform identity.public_record_organization_cac_result(application_id, current_application.row_version,
    'verified', '9944' || n, cac, legal_name, 'Private Company Limited by Shares', '2021-02-0' || (n % 9 + 1),
    n || ' Sign-up Street, Yaba, Lagos', 'active');
  perform identity.begin_self_service_provider_enrollment(cac, admin_email, product, challenge_id, code_hmac,
    admin_name, kind);
  if not identity.verify_organization_profile_completion_challenge(challenge_id, code_hmac, session_hmac) then
    raise exception 'P4c sign-up % was not verified', n;
  end if;
  select * into activated from identity.activate_self_service_provider_enrollment(session_hmac,
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  perform set_config('hid.test.app_' || n, application_id::text, true);
  perform set_config('hid.test.facility_' || n, activated.facility_id::text, true);
  perform set_config('hid.test.account_' || n, activated.account_id::text, true);
  perform set_config('hid.test.org_' || n, activated.organization_id::text, true);
end
$f$;
reset role;
grant execute on function pg_temp.p4c_sign_up(integer,text,text,text,text,text,text) to hid_identity_api_runtime;
set local role hid_identity_api_runtime;
select pg_temp.p4c_sign_up(1, 'laboratory', 'laboratory', 'RC9945001', 'Kemi Lab Admin', 'kemi@p4c-lab.invalid',
  'P4c Sign-up Laboratory Ltd');
select pg_temp.p4c_sign_up(2, 'pharmacy', 'pharmacy', 'RC9945002', 'Lanre Pharmacy Admin',
  'lanre@p4c-pharmacy.invalid', 'P4c Sign-up Pharmacy Ltd');
select set_config('app.actor_subject', 'synthetic:p4c:super', true),
  set_config('app.correlation_id', 'p4c-fixture-review', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select identity.admin_review_self_service_facility(current_setting('hid.test.app_1')::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('unreviewed') application
    where application.application_id = current_setting('hid.test.app_1')::uuid),
  'Reached the laboratory on its CAC contact number', 'lab', 'cac_registered_contact', 'MLSCN', 'MLS/10001');
select identity.admin_review_self_service_facility(current_setting('hid.test.app_2')::uuid,
  (select application.row_version from identity.admin_list_self_service_facilities('unreviewed') application
    where application.application_id = current_setting('hid.test.app_2')::uuid),
  'Reached the pharmacy on its CAC contact number', 'pharmacist', 'cac_registered_contact', 'PCN', 'PCN/20002');
reset role;
select set_config('hid.test.membership_' || n,
  (select membership.id::text from identity.staff_facility_memberships membership
    where membership.account_id = current_setting('hid.test.account_' || n)::uuid), true),
  set_config('hid.test.subject_' || n,
  (select account.subject from auth.accounts account where account.id = current_setting('hid.test.account_' || n)::uuid),
  true)
  from generate_series(1, 2) n;

-- L1's second lab member LB2 (31) and receptionist RB (32); PH1's second
-- pharmacist PB2 (33). No consent grants at L1 or PH1.
insert into auth.accounts (id, subject, email, display_name, status)
select ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, 'synthetic:p4c:' || s.code,
  s.code || '@p4c-staff.invalid', s.full_name, 'active'
  from (values (31, 'lb2', 'Musa Second Lab'), (32, 'rb', 'Ngozi Lab Reception'), (33, 'pb2', 'Ola Second Pharmacist'))
       s(n, code, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.full_name, s.code || '@p4c-staff.invalid', 'verified', s.role
  from (values (31, 'lb2', 'Musa Second Lab', 'lab'), (32, 'rb', 'Ngozi Lab Reception', 'receptionist'),
               (33, 'pb2', 'Ola Second Pharmacist', 'pharmacist')) s(n, code, full_name, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, current_setting('hid.test.org_' || s.site)::uuid,
  current_setting('hid.test.facility_' || s.site)::uuid, s.role, s.role, true, true
  from (values (31, 1, 'lab'), (32, 1, 'receptionist'), (33, 2, 'pharmacist')) s(n, site, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e4c11000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.role, 'facility', ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid,
  current_setting('hid.test.facility_' || s.site)::uuid, 'P4c suite invited role'
  from (values (31, 1, 'lab'), (32, 1, 'receptionist'), (33, 2, 'pharmacist')) s(n, site, role);

-- Encounters at GH for P, Q and N, written by DA through the EHR runtime.
set local role hid_ehr_api_runtime;
select set_config('app.actor_subject', 'synthetic:p4c:da', true),
  set_config('app.membership_id', 'e4c13000-0000-4000-8000-000000000011', true),
  set_config('app.facility_id', 'e4c21000-0000-4000-8000-000000000001', true),
  set_config('app.correlation_id', 'p4c-fixture-ehr', true),
  set_config('app.purpose_of_use', 'direct-care', true);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e4c50000-0000-4000-8000-00000000000' || n)::uuid, ('e4c30000-0000-4000-8000-00000000000' || n)::uuid,
  'e4c21000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000011',
  'e4c13000-0000-4000-8000-000000000011', 'ambulatory', 'in_progress', clock_timestamp()
  from generate_series(1, 3) n;
reset role;

-- Session helpers.
create function pg_temp.as_staff(member integer, facility uuid, purpose text default 'direct-care')
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:p4c:' || case member when 11 then 'da' when 12 then 'ca'
      when 13 then 'na' when 14 then 'la' when 15 then 'pa' when 16 then 'ra' when 17 then 'ga' when 21 then 'glm'
      when 26 then 'd3' when 31 then 'lb2' when 32 then 'rb' when 33 then 'pb2' when 18 then 'dr' when 19 then 'dx'
      when 22 then 'gpm' when 23 then 'gl2a' when 24 then 'gl3' when 25 then 'llm' when 27 then 'gl2b'
      else 'unknown' end, true),
    set_config('app.membership_id', 'e4c13000-0000-4000-8000-0000000000' || member, true),
    set_config('hid.test.actor_account', 'e4c10000-0000-4000-8000-0000000000' || member, true),
    set_config('app.facility_id', facility::text, true),
    set_config('app.correlation_id', 'p4c-suite-' || member || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true);
$f$;
create function pg_temp.as_signup_admin(n integer, purpose text default 'direct-care')
returns void language sql as $f$
  select set_config('app.actor_subject', current_setting('hid.test.subject_' || n), true),
    set_config('app.membership_id', current_setting('hid.test.membership_' || n), true),
    set_config('hid.test.actor_account', current_setting('hid.test.account_' || n), true),
    set_config('app.facility_id', current_setting('hid.test.facility_' || n), true),
    set_config('app.correlation_id', 'p4c-suite-admin-' || n || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', purpose, true),
    set_config('app.patient_id', '', true);
$f$;
create function pg_temp.as_platform(admin integer)
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:p4c:' || case admin when 1 then 'super' when 2 then 'support'
      when 3 then 'reviewer' when 4 then 'auditor' else 'unknown' end, true),
    set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'p4c-suite-platform-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', 'healthcare-operations', true),
    set_config('app.patient_id', '', true);
$f$;
create function pg_temp.as_patient(n integer)
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:p4c:patient-' || case n when 1 then 'p' else 'q' end, true),
    set_config('app.account_id', 'e4c10000-0000-4000-8000-00000000004' || n, true),
    set_config('app.session_id', 'e4c31000-0000-4000-8000-00000000000' || n, true),
    set_config('app.patient_id', 'e4c30000-0000-4000-8000-00000000000' || n, true),
    set_config('app.self_authorized_until', (clock_timestamp() + interval '5 minutes')::text, true),
    set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true),
    set_config('app.correlation_id', 'p4c-suite-patient-' || n || '-' || substr(md5(random()::text), 1, 8), true),
    set_config('app.purpose_of_use', 'patient-self', true);
$f$;
-- A lab request or prescription by DA for patient n (1 P, 2 Q, 3 N), in the
-- given status, through the EHR runtime; answers its id.
create function pg_temp.lab_request(n integer, request_status text, clinical text default 'Fever for three days')
returns uuid language plpgsql as $f$
declare created uuid := gen_random_uuid();
begin
  perform pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
  insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information)
  values (created, ('e4c50000-0000-4000-8000-00000000000' || n)::uuid, ('e4c30000-0000-4000-8000-00000000000' || n)::uuid,
    'e4c21000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000011',
    'e4c13000-0000-4000-8000-000000000011', 'http://loinc.org', '718-7', 'Haemoglobin', 'urgent', request_status,
    'whole-blood', clinical);
  return created;
end
$f$;
create function pg_temp.prescription(n integer, prescription_status text)
returns uuid language plpgsql as $f$
declare created uuid := gen_random_uuid();
begin
  perform pg_temp.as_staff(11, 'e4c21000-0000-4000-8000-000000000001');
  insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
    instructions, starts_on, status)
  values (created, ('e4c50000-0000-4000-8000-00000000000' || n)::uuid, ('e4c30000-0000-4000-8000-00000000000' || n)::uuid,
    'e4c21000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000011',
    'e4c13000-0000-4000-8000-000000000011', 'urn:p4c:medication', 'amoxicillin-500', 'Amoxicillin 500 mg', 1,
    'capsule', 'oral', 'Every 8 hours', 'Take after food for seven days', current_date, prescription_status);
  return created;
end
$f$;
-- Send an order (kind, order, receiving facility) as member m: answers the route id.
create function pg_temp.send(m integer, kind text, order_id uuid, receiving uuid, key text,
  attestation text default null)
returns uuid language plpgsql as $f$
declare
  source_row record;
  sent record;
begin
  perform pg_temp.as_staff(m, 'e4c21000-0000-4000-8000-000000000001');
  if kind = 'lab_request' then
    select source_order.patient_id, source_order.encounter_id, source_order.row_version into source_row
      from ehr.lab_requests source_order where source_order.id = order_id;
  else
    select source_order.patient_id, source_order.encounter_id, source_order.row_version into source_row
      from ehr.prescriptions source_order where source_order.id = order_id;
  end if;
  select * into sent from ehr.send_order_route(gen_random_uuid(), kind, source_row.patient_id, order_id,
    source_row.encounter_id, source_row.row_version, receiving,
    coalesce(attestation, case kind when 'lab_request' then 'order-route-lab-attestation-v1'
                                   else 'order-route-prescription-attestation-v1' end),
    key, encode(sha256(key::bytea), 'hex'));
  return sent.route_id;
end
$f$;
-- The SQLSTATE and message of a statement, or 'ok'.
create function pg_temp.outcome(statement text)
returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_ehr_api_runtime, hid_lab_api_runtime, '
      'hid_pharmacy_api_runtime, hid_identity_api_runtime, hid_schema_test_runtime', proc.signature);
  end loop;
end $$;
-- Owner SQL: a received, completed execution with a verified result
-- version for a route-backed Lab work item at L1 (entered by LB2, verified by
-- LB1; triggers and keys off), as the Lab's own commands leave it. Answers
-- the result id; its execution and verification are set as hid.test.<label>_*.
create function pg_temp.lab_chain(work_item uuid, label text, numeric_value numeric)
returns uuid language plpgsql as $f$
declare
  item lab.work_items%rowtype;
  test_id uuid;
  accession_id uuid := gen_random_uuid();
  requirement_id uuid := gen_random_uuid();
  specimen_id uuid := gen_random_uuid();
  execution_id uuid := gen_random_uuid();
  result_id uuid := gen_random_uuid();
  verification_id uuid := gen_random_uuid();
begin
  select * into item from lab.work_items where id = work_item;
  select test.id into test_id from lab.work_item_requested_tests test where test.work_item_id = work_item;
  set local session_replication_role = replica;
  insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
    idempotency_key, request_sha256, correlation_id)
  values (accession_id, work_item, item.patient_id, item.facility_id, item.priority,
    'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', 'p4c-chain-acc-' || label || '-000',
    repeat('a', 64), 'p4c-chain');
  insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
  values (requirement_id, accession_id, item.patient_id, item.facility_id, 1, 'whole blood');
  insert into lab.specimens (id, requirement_id, accession_id, patient_id, facility_id, specimen_type, status,
    collected_at, collected_by, collected_by_membership_id, received_at, received_by, received_by_membership_id,
    row_version)
  values (specimen_id, requirement_id, accession_id, item.patient_id, item.facility_id, 'whole blood', 'received',
    clock_timestamp(), 'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', clock_timestamp(),
    'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', 3);
  insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id, status,
    started_by, started_by_membership_id, started_at, completed_by, completed_by_membership_id, completed_at,
    idempotency_key, request_sha256, correlation_id, row_version)
  values (execution_id, accession_id, specimen_id, test_id, item.patient_id, item.facility_id, 'completed',
    'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', clock_timestamp(),
    'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031', clock_timestamp(),
    'p4c-chain-exe-' || label || '-000', repeat('a', 64), 'p4c-chain', 2);
  insert into lab.results (id, execution_id, patient_id, facility_id, created_by, created_by_membership_id)
  values (result_id, execution_id, item.patient_id, item.facility_id, 'e4c10000-0000-4000-8000-000000000031',
    'e4c13000-0000-4000-8000-000000000031');
  insert into lab.result_revisions (result_id, execution_id, patient_id, facility_id, version, result_type,
    numeric_value, unit, reference_range, abnormal_flag, entered_by, entered_by_membership_id, idempotency_key,
    request_sha256, correlation_id, revision_kind)
  values (result_id, execution_id, item.patient_id, item.facility_id, 1, 'numeric', numeric_value, 'g/dL', '12.0-15.5',
    case when numeric_value < 12 then 'low' else 'normal' end, 'e4c10000-0000-4000-8000-000000000031',
    'e4c13000-0000-4000-8000-000000000031', 'p4c-chain-rev-' || label || '-001', repeat('a', 64), 'p4c-chain',
    'original');
  insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
    verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
  values (verification_id, result_id, execution_id, item.patient_id, item.facility_id, 1,
    item.accepted_by, item.accepted_by_membership_id, clock_timestamp(), 'Verified by the second scientist',
    'p4c-chain-ver-' || label || '-001', repeat('a', 64), 'p4c-chain');
  set local session_replication_role = origin;
  perform set_config('hid.test.' || label || '_execution', execution_id::text, true);
  perform set_config('hid.test.' || label || '_verification_1', verification_id::text, true);
  return result_id;
end
$f$;
-- Owner SQL: a corrected version (2) of a result, verified (triggers off).
create function pg_temp.lab_correction(result_id uuid, label text, numeric_value numeric, verifier uuid,
  verifier_membership uuid)
returns uuid language plpgsql as $f$
declare
  head lab.results%rowtype;
  verification_id uuid := gen_random_uuid();
begin
  select * into head from lab.results where id = result_id;
  set local session_replication_role = replica;
  insert into lab.result_revisions (result_id, execution_id, patient_id, facility_id, version, result_type,
    numeric_value, unit, reference_range, abnormal_flag, entered_by, entered_by_membership_id, correction_reason,
    idempotency_key, request_sha256, correlation_id, revision_kind, supersedes_version)
  values (result_id, head.execution_id, head.patient_id, head.facility_id, 2, 'numeric', numeric_value, 'g/dL',
    '12.0-15.5', 'normal', 'e4c10000-0000-4000-8000-000000000031', 'e4c13000-0000-4000-8000-000000000031',
    'Analyser recalibrated', 'p4c-chain-rev-' || label || '-002', repeat('a', 64), 'p4c-chain', 'correction', 1);
  update lab.results set current_version = 2 where id = result_id;
  insert into lab.result_verifications (id, result_id, execution_id, patient_id, facility_id, result_version,
    verified_by, verified_by_membership_id, verified_at, reason, idempotency_key, request_sha256, correlation_id)
  values (verification_id, result_id, head.execution_id, head.patient_id, head.facility_id, 2, verifier,
    verifier_membership, clock_timestamp(), 'Verified the correction', 'p4c-chain-ver-' || label || '-002',
    repeat('a', 64), 'p4c-chain');
  set local session_replication_role = origin;
  return verification_id;
end
$f$;
-- The Lab's release statement, as the session's member (route access or consent).
create function pg_temp.release(result_id uuid, result_version bigint, verification_id uuid, key text)
returns void language plpgsql as $f$
declare head record;
begin
  select result_row.execution_id, result_row.patient_id, result_row.facility_id into head
    from lab.results result_row where result_row.id = result_id;
  insert into lab.result_releases (verification_id, result_id, execution_id, patient_id, facility_id, result_version,
    released_by, released_by_membership_id, released_at, reason, idempotency_key, request_sha256, correlation_id)
  values (verification_id, result_id, head.execution_id, head.patient_id, head.facility_id, result_version,
    current_setting('hid.test.actor_account')::uuid, current_setting('app.membership_id')::uuid, clock_timestamp(),
    'Released to the requester',
    key, repeat('b', 64), current_setting('app.correlation_id'));
end
$f$;
-- The Pharmacy's dispensing statement, as the session's member.
create function pg_temp.dispense(work_item uuid, key text)
returns uuid language plpgsql as $f$
declare item record; created uuid := gen_random_uuid();
begin
  select candidate.patient_id, candidate.facility_id, candidate.medication_code_system, candidate.medication_code,
         candidate.medication_display into item
    from pharmacy.work_items candidate where candidate.id = work_item;
  insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id, medication_code_system,
    medication_code, medication_display, quantity_dispensed, quantity_unit, dispensed_by, dispensed_by_membership_id,
    reason, idempotency_key, request_sha256, correlation_id)
  values (created, work_item, 1, item.patient_id, item.facility_id, item.medication_code_system, item.medication_code,
    item.medication_display, 21, 'capsule', current_setting('hid.test.actor_account')::uuid,
    current_setting('app.membership_id')::uuid,
    'Dispensed the full course', key, repeat('c', 64), current_setting('app.correlation_id'));
  return created;
end
$f$;

-- Recorded checks: each statement's outcome ('ok' or SQLSTATE and message)
-- against the expected one; pg_temp.report() fails the suite listing every
-- difference.
create temp table p4c_checks (n serial primary key, label text not null, expected text not null, actual text not null);
create function pg_temp.check(label text, statement text, expected text)
returns void language plpgsql as $f$
begin
  insert into p4c_checks (label, expected, actual) values (label, expected, pg_temp.outcome(statement));
end
$f$;
create function pg_temp.assert(label text, condition boolean, detail text default null)
returns void language plpgsql as $f$
begin
  insert into p4c_checks (label, expected, actual)
  values (label, 'true', coalesce(condition::text, 'null')
    || case when condition then '' else coalesce(' (' || detail || ')', '') end);
end
$f$;
create function pg_temp.report()
returns void language plpgsql as $f$
declare failures text; total integer;
begin
  select count(*) into total from p4c_checks;
  select string_agg(format('%s: expected %s, got %s', c.label, c.expected, c.actual), E'\n' order by c.n)
    into failures from p4c_checks c where c.actual <> c.expected;
  if failures is not null then
    raise exception E'P4c checks failed:\n%', failures;
  end if;
  raise notice 'P4c checks passed: %', total;
end
$f$;
grant select, insert on p4c_checks to hid_ehr_api_runtime, hid_lab_api_runtime, hid_pharmacy_api_runtime,
  hid_identity_api_runtime, hid_schema_test_runtime;
grant usage on sequence p4c_checks_n_seq to hid_ehr_api_runtime, hid_lab_api_runtime, hid_pharmacy_api_runtime,
  hid_identity_api_runtime, hid_schema_test_runtime;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_ehr_api_runtime, hid_lab_api_runtime, '
      'hid_pharmacy_api_runtime, hid_identity_api_runtime, hid_schema_test_runtime', proc.signature);
  end loop;
end $$;
reset role;

-- P4c's acceptance helpers, as the late-correction suite has them: at L1 by
-- LB1, at PH1 by PB1. Answer the work item.
create function pg_temp.accept_lab(route uuid) returns uuid language plpgsql as $f$
declare accepted record;
begin
  perform pg_temp.as_signup_admin(1);
  select * into accepted from lab.accept_order_route(route, 1, 'health_id', 'HID-P4CPATP',
    'order-notices-accept-' || substr(md5(route::text), 1, 12), repeat('a', 64));
  if accepted.result is distinct from 'accepted' then
    raise exception 'ORD-11 suite: the lab acceptance of % answered %', route, accepted.result;
  end if;
  return accepted.work_item_id;
end
$f$;
create function pg_temp.accept_rx(route uuid) returns uuid language plpgsql as $f$
declare accepted record;
begin
  perform pg_temp.as_signup_admin(2);
  select * into accepted from pharmacy.accept_order_route(route, 1, 'health_id', 'HID-P4CPATP',
    'Patient collected the prescription', 'order-notices-accept-' || substr(md5(route::text), 1, 12), repeat('a', 64));
  if accepted.result is distinct from 'accepted' then
    raise exception 'ORD-11 suite: the pharmacy acceptance of % answered %', route, accepted.result;
  end if;
  return accepted.work_item_id;
end
$f$;
-- A route's version, as the owner reads it.
create function pg_temp.route_version(route uuid) returns bigint language sql security definer as $f$
  select route_row.row_version from ehr.order_routes route_row where route_row.id = route
$f$;
-- Owner SQL: moves a route's clock back (triggers off), as the lifecycle suite.
create function pg_temp.age_route(route uuid, created_by interval, completed_by interval)
returns void language plpgsql as $f$
begin
  set local session_replication_role = replica;
  update ehr.order_routes set created_at = created_at - created_by, respond_by = respond_by - created_by,
    accepted_at = accepted_at - created_by, completed_at = completed_at - completed_by,
    writes_end_at = writes_end_at - completed_by, access_ends_at = access_ends_at - completed_by
   where id = route;
  set local session_replication_role = origin;
end
$f$;
-- lab-api's invalidation (entered in error), as the session's member.
create function pg_temp.invalidate(result uuid, version_number bigint, key text)
returns void language plpgsql as $f$
declare head record;
begin
  select result_row.execution_id, result_row.patient_id, result_row.facility_id into head
    from lab.results result_row where result_row.id = result;
  insert into lab.result_invalidations (result_id, execution_id, patient_id, facility_id, result_version, disposition,
    actor_id, actor_membership_id, reason, idempotency_key, request_sha256, correlation_id)
  values (result, head.execution_id, head.patient_id, head.facility_id, version_number, 'entered_in_error',
    current_setting('hid.test.actor_account')::uuid, current_setting('app.membership_id')::uuid,
    'The specimen belonged to another patient', key, repeat('d', 64), current_setting('app.correlation_id'));
end
$f$;
-- Every notice of the fixture's patients, as the owner reads it (for "nothing
-- changed").
create function pg_temp.fingerprint() returns text language sql security definer as $f$
  select md5(coalesce(string_agg(to_jsonb(notice)::text, ',' order by notice.id), ''))
    from ehr.order_notices notice
   where notice.patient_id in ('e4c30000-0000-4000-8000-000000000001', 'e4c30000-0000-4000-8000-000000000002',
           'e4c30000-0000-4000-8000-000000000003')
$f$;
-- The audit rows a correlation id wrote: action (patient: P, Q or -), in order.
create function pg_temp.audited(correlation text) returns text language sql security definer as $f$
  select coalesce(string_agg(event.action || ' ' || case event.patient_id
           when 'e4c30000-0000-4000-8000-000000000001' then 'P' when 'e4c30000-0000-4000-8000-000000000002' then 'Q'
           when 'e4c30000-0000-4000-8000-000000000003' then 'N' else '-' end, ', ' order by event.sequence_id),
           'none')
    from audit.events event where event.correlation_id = correlation and event.action like 'ehr.order-notice.%'
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to hid_ehr_api_runtime, hid_lab_api_runtime, '
      'hid_pharmacy_api_runtime, hid_identity_api_runtime, hid_schema_test_runtime', proc.signature);
  end loop;
end $$;

-- ORD-11's own fixture, beside P4c's. n: 51 LC lab at GH (enters the own
-- results LA checks), 52 D2 a second doctor at GH (consent for P and Q),
-- and three more memberships of DA's own account (staff 11): 53 clinician
-- at GH (a sibling membership), 54 doctor at H3, 55 pharmacist at GH (it may
-- read prescriptions, not lab requests). 53 and 55 hold DA's consents at GH,
-- 54 one for P at H3.
insert into auth.accounts (id, subject, email, display_name, status)
select ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, 'synthetic:p4c:' || s.code,
  s.code || '@p4c-staff.invalid', s.full_name, 'active'
  from (values (51, 'lc', 'Kunle Second Lab'), (52, 'd2', 'Lola Second Doctor')) s(n, code, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.full_name, s.code || '@p4c-staff.invalid', 'verified', s.role
  from (values (51, 'lc', 'Kunle Second Lab', 'lab'), (52, 'd2', 'Lola Second Doctor', 'doctor'))
       s(n, code, full_name, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c12000-0000-4000-8000-0000000000' || s.staff)::uuid,
  ('e4c10000-0000-4000-8000-0000000000' || s.staff)::uuid, ('e4c20000-0000-4000-8000-00000000000' || s.org)::uuid,
  ('e4c21000-0000-4000-8000-00000000000' || s.org)::uuid, s.role, s.role, s.n in (51, 52), true
  from (values (51, 51, 1, 'lab'), (52, 52, 1, 'doctor'), (53, 11, 1, 'clinician'), (54, 11, 3, 'doctor'),
               (55, 11, 1, 'pharmacist')) s(n, staff, org, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e4c11000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.staff)::uuid,
  s.role, 'facility', ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c21000-0000-4000-8000-00000000000' || s.org)::uuid, 'ORD-11 suite role'
  from (values (51, 51, 1, 'lab'), (52, 52, 1, 'doctor'), (53, 11, 1, 'clinician'), (54, 11, 3, 'doctor'),
               (55, 11, 1, 'pharmacist')) s(n, staff, org, role);
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
select gen_random_uuid(), ('e4c30000-0000-4000-8000-00000000000' || c.patient)::uuid,
  ('e4c12000-0000-4000-8000-0000000000' || c.staff)::uuid, ('e4c10000-0000-4000-8000-0000000000' || c.staff)::uuid,
  ('e4c13000-0000-4000-8000-0000000000' || c.n)::uuid, ('e4c21000-0000-4000-8000-00000000000' || c.org)::uuid,
  'write_records', 'active', 'ORD-11 suite direct-care consent', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '30 days', false, 'direct-care'
  from (values (52, 52, 1, 1), (52, 52, 1, 2), (53, 11, 1, 1), (53, 11, 1, 2), (53, 11, 1, 3), (54, 11, 3, 1),
               (55, 11, 1, 1), (55, 11, 1, 2), (55, 11, 1, 3)) c(n, staff, org, patient);
select set_config('hid.test.gaps_before', pg_temp.gaps()::text, true);

-- 1. Who may run and read what.
select pg_temp.same('1a EXECUTE on the new functions: the five definers to the EHR runtime and its login role only',
  (select string_agg(role_row.rolname || ':' || proc.proname, ' ' order by role_row.rolname, proc.proname)
     from pg_roles role_row
     cross join pg_proc proc
     join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'ehr' and role_row.rolname like 'hid\_%'
      and (proc.proname like 'order\_notice\_%' or proc.proname in ('list_order_notices', 'mark_order_notices_read',
             'mark_order_notice_seen', 'sweep_order_notices'))
      and has_function_privilege(role_row.oid, proc.oid, 'EXECUTE')),
  'hid_ehr_api_runtime:list_order_notices hid_ehr_api_runtime:mark_order_notice_seen '
  || 'hid_ehr_api_runtime:mark_order_notices_read hid_ehr_api_runtime:order_notice_summary '
  || 'hid_ehr_api_runtime:sweep_order_notices hid_ehr_runtime:list_order_notices hid_ehr_runtime:mark_order_notice_seen '
  || 'hid_ehr_runtime:mark_order_notices_read hid_ehr_runtime:order_notice_summary hid_ehr_runtime:sweep_order_notices');
select pg_temp.same('1b no runtime role may read or write the notices, the gaps or the switch',
  (select count(*)::text from pg_roles role_row
     cross join (values ('ehr.order_notices'), ('ehr.order_notice_gaps'), ('ehr.order_notice_switch')) t(name)
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(privilege)
    where role_row.rolname like 'hid\_%' and has_table_privilege(role_row.oid, t.name, p.privilege)), '0');
select pg_temp.same('1c each zz_order_notice fires after its table''s route return (AFTER INSERT, origin, name order)',
  (select string_agg(trigger_row.tgrelid::regclass::text || ':' || (select string_agg(after_row.tgname, ',' order by
            after_row.tgname collate "C") from pg_trigger after_row
            where after_row.tgrelid = trigger_row.tgrelid and not after_row.tgisinternal and after_row.tgtype = 5
              and after_row.tgenabled = 'O'), ' ' order by trigger_row.tgrelid::regclass::text)
     from pg_trigger trigger_row where trigger_row.tgname = 'zz_order_notice'),
  'lab.result_invalidations:result_invalidations_order_route_return,zz_order_notice '
  || 'lab.result_releases:result_releases_order_route_return,zz_order_notice '
  || 'pharmacy.dispensing_reversals:dispensing_reversals_order_route_return,zz_order_notice '
  || 'pharmacy.dispensings:dispensings_order_route_return,zz_order_notice');

-- 2. Own lab work at GH: DA's lab requests A, B (P) and QL (Q), taken by GH's
-- laboratory (LA accepts, LC enters, LA checks and releases under P's and
-- Q's consent).
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_a', pg_temp.lab_request(1, 'active')::text, true);
select set_config('hid.test.lr_b', pg_temp.lab_request(1, 'active')::text, true);
select set_config('hid.test.lr_q', pg_temp.lab_request(2, 'active')::text, true);
reset role;
select set_config('hid.test.item_a', pg_temp.own_lab_item(pg_temp.id('lr_a'))::text, true);
select set_config('hid.test.item_b', pg_temp.own_lab_item(pg_temp.id('lr_b'))::text, true);
select set_config('hid.test.item_q', pg_temp.own_lab_item(pg_temp.id('lr_q'))::text, true);
select set_config('hid.test.res_a1', pg_temp.own_result(pg_temp.id('item_a'), 'a1', 'low', 10.9)::text, true);
select set_config('hid.test.res_a2', pg_temp.own_result(pg_temp.id('item_a'), 'a2', 'normal', 12.6)::text, true);
select set_config('hid.test.res_b1', pg_temp.own_result(pg_temp.id('item_b'), 'b1', 'critical_candidate', 5.1)::text, true);
select set_config('hid.test.res_q1', pg_temp.own_result(pg_temp.id('item_q'), 'q1', 'critical_candidate', 4.8)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_member(14);
select pg_temp.same('2a LA releases A1 v1 (low)', pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L,
  'order-notices-release-a1-1')$s$, pg_temp.id('res_a1'), pg_temp.id('a1_check_1'))), 'ok');
reset role;
select pg_temp.same('2a an own release: lab_result_ready, one event, no route',
  pg_temp.notices(pg_temp.id('lr_a')), 'lab_result_ready:1:1');
select pg_temp.same('2a the recipient is the order''s creator at the ordering facility; the source is the release',
  (select format('%s %s %s %s %s %s v%s %s %s', notice ->> 'recipient_account_id', notice ->> 'ordering_facility_id',
     notice ->> 'order_kind', notice ->> 'patient_id', notice ->> 'source_table',
     (notice ->> 'source_row_id')::uuid = (select release.id from lab.result_releases release
                                            where release.result_id = pg_temp.id('res_a1')),
     notice ->> 'result_version', (notice ->> 'result_id')::uuid = pg_temp.id('res_a1'),
     notice ->> 'first_event_at' = notice ->> 'last_event_at')
     from pg_temp.notice(pg_temp.id('lr_a'), 'lab_result_ready') notice),
  'e4c10000-0000-4000-8000-000000000011 e4c21000-0000-4000-8000-000000000001 lab_request '
  || 'e4c30000-0000-4000-8000-000000000001 lab.result_releases t v1 t t');
select set_config('hid.test.a1_check_2', pg_temp.own_version(pg_temp.id('res_a1'), 'a1', 2, 'normal', 12.2)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_member(14);
select pg_temp.same('2b LA releases A1 v2 (a correction, normal)',
  pg_temp.try(format($s$select pg_temp.release_as(%L, 2, %L,
  'order-notices-release-a1-2')$s$, pg_temp.id('res_a1'), pg_temp.id('a1_check_2'))), 'ok');
select pg_temp.same('2c LA releases A2 v1 (a second result on the same order)',
  pg_temp.try(format($s$select pg_temp.release_as(%L,
  1, %L, 'order-notices-release-a2-1')$s$, pg_temp.id('res_a2'), pg_temp.id('a2_check_1'))), 'ok');
select pg_temp.same('2d LA releases B1 v1 (critical)', pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L,
  'order-notices-release-b1-1')$s$, pg_temp.id('res_b1'), pg_temp.id('b1_check_1'))), 'ok');
reset role;
select set_config('hid.test.a1_check_3', pg_temp.own_version(pg_temp.id('res_a1'), 'a1', 3, 'critical_candidate',
  5.4)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_member(14);
select pg_temp.same('2e LA releases A1 v3 (a correction, critical)',
  pg_temp.try(format($s$select pg_temp.release_as(%L, 3, %L,
  'order-notices-release-a1-3')$s$, pg_temp.id('res_a1'), pg_temp.id('a1_check_3'))), 'ok');
select pg_temp.same('2f LA releases Q1 v1 (critical, for Q)', pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L,
  'order-notices-release-q1-1')$s$, pg_temp.id('res_q1'), pg_temp.id('q1_check_1'))), 'ok');
reset role;
select pg_temp.same('2b-2e precedence (critical, then corrected, then ready) and the merge of ready per order: A',
  pg_temp.notices(pg_temp.id('lr_a')),
  'lab_result_ready:2:2 lab_result_corrected:1:1 lab_result_critical:1:1:needs-seen');
select pg_temp.same('2c the merged notice moved its last event and source to A2; its first event stays A1''s',
  (select format('%s %s %s', (notice ->> 'result_id')::uuid = pg_temp.id('res_a2'),
     (notice ->> 'first_event_at')::timestamptz < (notice ->> 'last_event_at')::timestamptz,
     (notice ->> 'last_event_at')::timestamptz = (select release.released_at from lab.result_releases release
                                                  where release.result_id = pg_temp.id('res_a2')))
     from pg_temp.notice(pg_temp.id('lr_a'), 'lab_result_ready') notice), 't t t');
select pg_temp.same('2d a first release flagged critical: lab_result_critical, needs Seen',
  pg_temp.notices(pg_temp.id('lr_b')), 'lab_result_critical:1:1:needs-seen');
select pg_temp.same('2e a critical correction keeps its result and version (the critical key)',
  (select (notice ->> 'result_id')::uuid = pg_temp.id('res_a1') and notice ->> 'result_version' = '3'
     from pg_temp.notice(pg_temp.id('lr_a'), 'lab_result_critical') notice)::text, 'true');
select pg_temp.same('2f Q''s critical result', pg_temp.notices(pg_temp.id('lr_q')), 'lab_result_critical:1:1:needs-seen');

-- 3. Own pharmacy at GH: DA's prescription RA for P with one refill, QX for
-- Q, and C for P (kept for case 18), each sent to GH's own pharmacy; PA
-- dispenses and reverses.
set local role hid_ehr_api_runtime;
select set_config('hid.test.rx_a', pg_temp.own_rx(1, 1)::text, true);
select set_config('hid.test.rx_q', pg_temp.own_rx(2)::text, true);
select set_config('hid.test.rx_c', pg_temp.own_rx(1)::text, true);
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(15);
select set_config('hid.test.disp_a1', pg_temp.dispense_fill(pg_temp.item_of(pg_temp.id('rx_a')), 1,
  'order-notices-fill-a-0001')::text, true);
reset role;
select pg_temp.same('3a the first fill: prescription_dispensed, the dispensing as its source',
  pg_temp.notices(pg_temp.id('rx_a')) || ' ' || (select format('%s %s %s', notice ->> 'source_table',
    notice ->> 'dispensing_id' = pg_temp.id('disp_a1')::text, notice ->> 'recipient_account_id')
    from pg_temp.notice(pg_temp.id('rx_a'), 'prescription_dispensed') notice),
  'prescription_dispensed:1:1 pharmacy.dispensings t e4c10000-0000-4000-8000-000000000011');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(15);
select set_config('hid.test.rev_a1', pg_temp.reverse(pg_temp.id('disp_a1'), 'order-notices-reverse-a-0001')::text, true);
select set_config('hid.test.disp_a2', pg_temp.dispense_fill(pg_temp.item_of(pg_temp.id('rx_a')), 2,
  'order-notices-fill-a-0002')::text, true);
reset role;
select pg_temp.same('3b a reversal: dispensing_reversed; then the refill (fill 2): no notice and no gap',
  pg_temp.notices(pg_temp.id('rx_a')) || ' gaps ' || (pg_temp.gaps() - current_setting('hid.test.gaps_before')::bigint),
  'prescription_dispensed:1:1 dispensing_reversed:1:1 gaps 0');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(15);
select set_config('hid.test.rev_a2', pg_temp.reverse(pg_temp.id('disp_a2'), 'order-notices-reverse-a-0002')::text, true);
select set_config('hid.test.disp_q1', pg_temp.dispense_fill(pg_temp.item_of(pg_temp.id('rx_q')), 1,
  'order-notices-fill-q-0001')::text, true);
reset role;
select pg_temp.same('3c the refill''s reversal tells the prescriber too, merged into the unread reversal notice',
  pg_temp.notices(pg_temp.id('rx_a')) || ' ' || (select format('%s %s %s', notice ->> 'source_row_id' =
    pg_temp.id('rev_a2')::text, notice ->> 'dispensing_id' = pg_temp.id('disp_a2')::text,
    notice ->> 'source_table') from pg_temp.notice(pg_temp.id('rx_a'), 'dispensing_reversed') notice),
  'prescription_dispensed:1:1 dispensing_reversed:2:2 t t pharmacy.dispensing_reversals');
select pg_temp.same('3d Q''s first fill', pg_temp.notices(pg_temp.id('rx_q')), 'prescription_dispensed:1:1');

-- 4. Routed lab work: DA's lab requests R1-R5 for P sent to L1, accepted by
-- LB1; each run and checked there (owner SQL, as the P4c suites). Found
-- through the route reports, never the work item.
set local role hid_ehr_api_runtime;
select set_config('hid.test.lr_r' || n, pg_temp.lab_request(1, 'active')::text, true) from generate_series(1, 5) n;
select set_config('hid.test.route_r' || n, pg_temp.send(11, 'lab_request', pg_temp.id('lr_r' || n),
  current_setting('hid.test.facility_1')::uuid, 'order-notices-send-r' || n)::text, true) from generate_series(1, 5) n;
reset role;
set local role hid_lab_api_runtime;
select set_config('hid.test.item_r' || n, pg_temp.accept_lab(pg_temp.id('route_r' || n))::text, true)
  from generate_series(1, 5) n;
reset role;
select set_config('hid.test.res_r' || n, pg_temp.lab_chain(pg_temp.id('item_r' || n), 'r' || n, 10.4)::text, true)
  from generate_series(1, 5) n;
-- R5's first version is flagged critical by the laboratory (owner SQL).
set local session_replication_role = replica;
update lab.result_revisions set abnormal_flag = 'critical_candidate'
 where result_id = pg_temp.id('res_r5') and version = 1;
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.same('4a LB1 releases R' || n || ' v1 under route access',
  pg_temp.try(format($s$select pg_temp.release(%L, 1, %L,
  %L)$s$, pg_temp.id('res_r' || n), current_setting('hid.test.r' || n || '_verification_1'),
  'order-notices-release-r' || n || '-1')), 'ok') from unnest(array[1, 5, 4, 3]) n;
reset role;
select pg_temp.same('4a a routed release: lab_result_ready with its route, to the route''s orderer at the ordering facility',
  pg_temp.notices(pg_temp.id('lr_r1')) || ' ' || (select format('%s %s %s %s', notice ->> 'order_route_id' =
    pg_temp.id('route_r1')::text, notice ->> 'order_id' = pg_temp.id('lr_r1')::text, notice ->> 'recipient_account_id',
    notice ->> 'ordering_facility_id') from pg_temp.notice(pg_temp.id('lr_r1'), 'lab_result_ready') notice),
  'lab_result_ready:1:1:routed t t e4c10000-0000-4000-8000-000000000011 e4c21000-0000-4000-8000-000000000001');
select pg_temp.same('4b a routed release flagged critical (the report''s copy of the flag): lab_result_critical',
  pg_temp.notices(pg_temp.id('lr_r5')) || ' ' || (select report.abnormal_flag from lab.order_route_result_reports report
    where report.route_id = pg_temp.id('route_r5') and report.kind = 'released'),
  'lab_result_critical:1:1:needs-seen:routed critical_candidate');
select set_config('hid.test.r1_verification_2', pg_temp.lab_correction(pg_temp.id('res_r1'), 'r1', 11.2,
  current_setting('hid.test.account_1')::uuid, current_setting('hid.test.membership_1')::uuid)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.same('4c LB2 releases R1 v2 (a correction)', pg_temp.try(format($s$select pg_temp.release(%L, 2, %L,
  'order-notices-release-r1-2')$s$, pg_temp.id('res_r1'), current_setting('hid.test.r1_verification_2'))), 'ok');
select pg_temp.as_signup_admin(1);
select pg_temp.same('4d LB1 marks R1 v2 entered in error', pg_temp.try(format($s$select pg_temp.invalidate(%L, 2,
  'order-notices-invalid-r1-2')$s$, pg_temp.id('res_r1'))), 'ok');
select pg_temp.same('4e LB1 marks R2 v1, never released, entered in error',
  pg_temp.try(format($s$select pg_temp.invalidate(%L, 1,
  'order-notices-invalid-r2-1')$s$, pg_temp.id('res_r2'))), 'ok');
reset role;
select pg_temp.same('4c-4d a routed correction, then its withdrawal: lab_result_corrected and lab_result_withdrawn',
  pg_temp.notices(pg_temp.id('lr_r1')),
  'lab_result_ready:1:1:routed lab_result_corrected:1:1:routed lab_result_withdrawn:1:1:routed');
select pg_temp.same('4d the withdrawal names the invalidation and the version withdrawn',
  (select format('%s %s %s', notice ->> 'source_table', notice ->> 'result_version',
     notice ->> 'source_row_id' = (select invalidation.id::text from lab.result_invalidations invalidation
                                    where invalidation.result_id = pg_temp.id('res_r1')))
     from pg_temp.notice(pg_temp.id('lr_r1'), 'lab_result_withdrawn') notice),
  'lab.result_invalidations 2 t');
select pg_temp.same('4e a version never released, entered in error: no notice and no gap',
  pg_temp.notices(pg_temp.id('lr_r2')) || ' gaps ' || (pg_temp.gaps() - current_setting('hid.test.gaps_before')::bigint),
  'none gaps 0');

-- 5. Routed pharmacy work: DA's prescriptions X1-X3 for P sent to PH1,
-- accepted by PB1, dispensed by PB2 under route access; X1 reversed by PB2.
set local role hid_ehr_api_runtime;
select set_config('hid.test.rx_x' || n, pg_temp.prescription(1, 'active')::text, true) from generate_series(1, 3) n;
select set_config('hid.test.route_x' || n, pg_temp.send(11, 'prescription', pg_temp.id('rx_x' || n),
  current_setting('hid.test.facility_2')::uuid, 'order-notices-send-x' || n)::text, true) from generate_series(1, 3) n;
reset role;
set local role hid_pharmacy_api_runtime;
select set_config('hid.test.item_x' || n, pg_temp.accept_rx(pg_temp.id('route_x' || n))::text, true)
  from generate_series(1, 3) n;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select set_config('hid.test.disp_x' || n, pg_temp.dispense(pg_temp.id('item_x' || n), 'order-notices-dispense-x' || n)::text,
  true) from generate_series(1, 3) n;
select set_config('hid.test.rev_x1', pg_temp.reverse(pg_temp.id('disp_x1'), 'order-notices-reverse-x-0001')::text, true);
reset role;
select pg_temp.same('5a a routed dispensing and its reversal, to DA at GH',
  pg_temp.notices(pg_temp.id('rx_x1')) || ' ' || (select format('%s %s', notice ->> 'order_route_id' =
    pg_temp.id('route_x1')::text, notice ->> 'recipient_account_id')
    from pg_temp.notice(pg_temp.id('rx_x1'), 'dispensing_reversed') notice),
  'prescription_dispensed:1:1:routed dispensing_reversed:1:1:routed t e4c10000-0000-4000-8000-000000000011');

-- 6. 0088 (reported in the window, READ COMMITTED, one attempt): LB2
-- reports R4 (v1 released) and PB2 reports X2 (dispensed) as accepted for
-- the wrong person; each command writes the invalidation or reversal itself.
set local role hid_lab_api_runtime;
select pg_temp.as_staff(31, current_setting('hid.test.facility_1')::uuid);
select pg_temp.same('6a LB2 reports R4 (0088)', pg_temp.value_of(format($s$select reported.result from
  lab.report_wrong_patient_order_route(%L, %s, 'someone_elses_details', 'The person gave another patient''s details',
  'order-notices-wrong-r4', %L) reported$s$, pg_temp.id('route_r4'), pg_temp.route_version(pg_temp.id('route_r4')),
  encode(sha256('order-notices-wrong-r4'::bytea), 'hex'))), 'ended');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.same('6b PB2 reports X2 (0088)', pg_temp.value_of(format($s$select reported.result from
  pharmacy.report_wrong_patient_order_route(%L, %s, 'someone_elses_details', 'Collected by a person using another '
  || 'patient''s details', 'order-notices-wrong-x2', %L) reported$s$, pg_temp.id('route_x2'),
  pg_temp.route_version(pg_temp.id('route_x2')), encode(sha256('order-notices-wrong-x2'::bytea), 'hex'))), 'ended');
reset role;
select pg_temp.same('6c 0088''s own invalidation and reversal reach DA through the route reports; no gap',
  pg_temp.notices(pg_temp.id('lr_r4')) || ' | ' || pg_temp.notices(pg_temp.id('rx_x2')) || ' | gaps '
  || (pg_temp.gaps() - current_setting('hid.test.gaps_before')::bigint),
  'lab_result_ready:1:1:routed lab_result_withdrawn:1:1:routed | prescription_dispensed:1:1:routed '
  || 'dispensing_reversed:1:1:routed | gaps 0');

-- 7. 0090 (corrected late, READ COMMITTED, one attempt) by members without
-- the patient's consent: support (FR) closes R3, then LB1 corrects it late;
-- X3's windows lapse (46 days), then PB1 corrects it late.
select pg_temp.same('7a LB1 and PB1 hold no consent for P',
  (select count(*)::text from identity.consent_grants grant_row
    where grant_row.patient_id = 'e4c30000-0000-4000-8000-000000000001'
      and grant_row.account_id in (current_setting('hid.test.account_1')::uuid,
            current_setting('hid.test.account_2')::uuid)), '0');
set local role hid_identity_api_runtime;
select pg_temp.as_platform(3);
select closed.state from identity.admin_close_order_route(pg_temp.id('route_r3'),
  pg_temp.route_version(pg_temp.id('route_r3')), 'The hospital asked support to close it') closed;
reset role;
select pg_temp.age_route(pg_temp.id('route_x3'), interval '46 days', interval '46 days');
set local role hid_lab_api_runtime;
select pg_temp.as_signup_admin(1);
select pg_temp.same('7b LB1 corrects R3 late (0090)', pg_temp.value_of(format($s$select corrected.result from
  lab.correct_wrong_patient_order_route(%L, %s, 'someone_elses_details', 'patient',
  (clock_timestamp() at time zone 'Africa/Lagos')::date, 'The patient says it was not them', 'order-notices-late-r3',
  %L) corrected$s$, pg_temp.id('route_r3'), pg_temp.route_version(pg_temp.id('route_r3')),
  encode(sha256('order-notices-late-r3'::bytea), 'hex'))), 'corrected');
select pg_temp.same('7c after it, LB1 reads none of R3''s work item (no consent, the route ended)',
  (select count(*)::text from lab.work_items where id = pg_temp.id('item_r3')), '0');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_signup_admin(2);
select pg_temp.same('7d PB1 corrects X3 late (0090)', pg_temp.value_of(format($s$select corrected.result from
  pharmacy.correct_wrong_patient_order_route(%L, %s, 'someone_elses_details', 'patient',
  (clock_timestamp() at time zone 'Africa/Lagos')::date, 'The patient says it was not them', 'order-notices-late-x3',
  %L) corrected$s$, pg_temp.id('route_x3'), pg_temp.route_version(pg_temp.id('route_x3')),
  encode(sha256('order-notices-late-x3'::bytea), 'hex'))), 'corrected');
select pg_temp.same('7e after it, PB1 reads none of X3''s work item',
  (select count(*)::text from pharmacy.work_items where id = pg_temp.id('item_x3')), '0');
reset role;
select pg_temp.same('7f 0090''s invalidation and reversal are notices, not gaps',
  pg_temp.notices(pg_temp.id('lr_r3')) || ' | ' || pg_temp.notices(pg_temp.id('rx_x3')) || ' | gaps '
  || (pg_temp.gaps() - current_setting('hid.test.gaps_before')::bigint),
  'lab_result_ready:1:1:routed lab_result_withdrawn:1:1:routed | prescription_dispensed:1:1:routed '
  || 'dispensing_reversed:1:1:routed | gaps 0');

-- 8. Every notice so far went to the order's creator (DA) at the ordering
-- facility (GH), with the route on routed ones only.
select pg_temp.same('8a the recipient and facility of every notice of the fixture''s patients',
  (select string_agg(distinct notice.recipient_account_id || ' ' || notice.ordering_facility_id, ', ')
     from ehr.order_notices notice
    where notice.patient_id in ('e4c30000-0000-4000-8000-000000000001', 'e4c30000-0000-4000-8000-000000000002',
            'e4c30000-0000-4000-8000-000000000003')),
  'e4c10000-0000-4000-8000-000000000011 e4c21000-0000-4000-8000-000000000001');
select pg_temp.same('8b routed notices carry their route, own ones none',
  (select format('%s routed, %s own, %s wrong', count(*) filter (where notice.order_route_id is not null),
     count(*) filter (where notice.order_route_id is null),
     count(*) filter (where notice.order_route_id is distinct from (select route.id from ehr.order_routes route
       where route.source_lab_request_id = notice.order_id or route.source_prescription_id = notice.order_id)))
     from ehr.order_notices notice
    where notice.patient_id in ('e4c30000-0000-4000-8000-000000000001', 'e4c30000-0000-4000-8000-000000000002')),
  '14 routed, 8 own, 0 wrong');

-- 9. What DA reads at GH (the EHR runtime, ehr-api's session).
set local role hid_ehr_api_runtime;
select pg_temp.as_member(11);
select pg_temp.same('9a DA''s summary: per kind, unread and critical not Seen', pg_temp.summary(),
  'dispensing_reversed 4/0, lab_result_corrected 2/0, lab_result_critical 4/4, lab_result_ready 4/0, '
  || 'lab_result_withdrawn 3/0, prescription_dispensed 5/0');
select pg_temp.same('9b the unread list, five a page by the cursor: critical not Seen first, then newest, each once',
  pg_temp.pages('unread', 5), pg_temp.expected_order('unread', 'e4c10000-0000-4000-8000-000000000011') || ' mmmm.');
select pg_temp.same('9c every notice, one page', pg_temp.pages('all', 50),
  pg_temp.expected_order('all', 'e4c10000-0000-4000-8000-000000000011') || ' .');
select pg_temp.same('9d the first four are the four critical notices',
  (select string_agg(listing.kind, ' ' order by listing.ordinality)
     from ehr.list_order_notices('unread', null, 5) with ordinality listing),
  'lab_result_critical lab_result_critical lab_result_critical lab_result_critical '
  || (select listing.kind from ehr.list_order_notices('unread', null, 5) with ordinality listing
       where listing.ordinality = 5));
select pg_temp.same('9e a routed critical notice as listed: its route, the order''s visit and test, the patient''s card',
  (select format('%s %s %s %s %s %s %s %s %s %s %s %s', listing.order_route_id = pg_temp.id('route_r5'),
     listing.encounter_id, listing.display, listing.patient_id, listing.full_name, listing.sex, listing.date_of_birth,
     listing.health_id_last4, listing.access_ended, listing.needs_seen, listing.version, listing.event_count)
     from ehr.list_order_notices('all', null, 50) listing where listing.order_id = pg_temp.id('lr_r5')),
  't e4c50000-0000-4000-8000-000000000001 Haemoglobin e4c30000-0000-4000-8000-000000000001 Patience Okafor female '
  || '1990-04-12 PATP f t 1 1');
select pg_temp.same('9f an own reversal notice as listed: no route, the medicine, two events at version 2',
  (select format('%s %s %s %s %s', listing.order_route_id is null, listing.display, listing.event_count,
     listing.version, listing.kind)
     from ehr.list_order_notices('all', null, 50) listing
    where listing.order_id = pg_temp.id('rx_a') and listing.kind = 'dispensing_reversed'),
  't Amoxicillin 500 mg 2 2 dispensing_reversed');
select pg_temp.as_member(11);
select set_config('hid.test.c9_list', current_setting('app.correlation_id'), true);
select count(*) from ehr.list_order_notices('unread', null, 50);
select pg_temp.as_member(11);
select set_config('hid.test.c9_summary', current_setting('app.correlation_id'), true);
select count(*) from ehr.order_notice_summary();
reset role;
select pg_temp.same('9g one list writes its row and one row per patient shown, first shown first; the summary none',
  pg_temp.audited(current_setting('hid.test.c9_list')) || ' | ' || pg_temp.audited(current_setting('hid.test.c9_summary')),
  'ehr.order-notice.list -, ehr.order-notice.list.shown P, ehr.order-notice.list.shown Q | none');
select pg_temp.same('9h the list row''s details',
  (select event.details::text from audit.events event
    where event.correlation_id = current_setting('hid.test.c9_list') and event.action = 'ehr.order-notice.list'),
  jsonb_build_object('state', 'unread', 'paged', false, 'resultCount', 22, 'accessEndedCount', 0, 'hasMore', false,
    'patientIds', jsonb_build_array('e4c30000-0000-4000-8000-000000000001', 'e4c30000-0000-4000-8000-000000000002'))::text);

-- 10. Everybody else, and refusals; none of it changes a notice.
select set_config('hid.test.fingerprint_10', pg_temp.fingerprint(), true);
select set_config('hid.test.n_b1', pg_temp.notice(pg_temp.id('lr_b'), 'lab_result_critical') ->> 'id', true),
  set_config('hid.test.n_a_ready', pg_temp.notice(pg_temp.id('lr_a'), 'lab_result_ready') ->> 'id', true),
  set_config('hid.test.n_a_critical', pg_temp.notice(pg_temp.id('lr_a'), 'lab_result_critical') ->> 'id', true),
  set_config('hid.test.n_q1', pg_temp.notice(pg_temp.id('lr_q'), 'lab_result_critical') ->> 'id', true),
  set_config('hid.test.n_r5', pg_temp.notice(pg_temp.id('lr_r5'), 'lab_result_critical') ->> 'id', true),
  set_config('hid.test.n_r1_ready', pg_temp.notice(pg_temp.id('lr_r1'), 'lab_result_ready') ->> 'id', true),
  set_config('hid.test.n_rx_a_dispensed', pg_temp.notice(pg_temp.id('rx_a'), 'prescription_dispensed') ->> 'id', true),
  set_config('hid.test.n_rx_a_reversed', pg_temp.notice(pg_temp.id('rx_a'), 'dispensing_reversed') ->> 'id', true),
  set_config('hid.test.n_rx_q', pg_temp.notice(pg_temp.id('rx_q'), 'prescription_dispensed') ->> 'id', true),
  set_config('hid.test.n_x1_dispensed', pg_temp.notice(pg_temp.id('rx_x1'), 'prescription_dispensed') ->> 'id', true);
set local role hid_ehr_api_runtime;
select pg_temp.as_member(53);
select pg_temp.same('10a DA''s sibling membership at GH (clinician) reads the same notices', pg_temp.summary(),
  'dispensing_reversed 4/0, lab_result_corrected 2/0, lab_result_critical 4/4, lab_result_ready 4/0, '
  || 'lab_result_withdrawn 3/0, prescription_dispensed 5/0');
select pg_temp.as_member(55);
select pg_temp.same('10b DA''s pharmacist membership at GH: the prescription notices only',
  pg_temp.summary() || ' | ' || (select count(*) || ' ' || string_agg(distinct listing.order_kind, ',')
    from ehr.list_order_notices('all', null, 50) listing)
  || ' | ' || pg_temp.try(format('select * from ehr.mark_order_notice_seen(%L)', pg_temp.id('n_b1')))
  || ' | ' || pg_temp.value_of(format('select ehr.mark_order_notices_read(array[%L]::uuid[], array[1]::bigint[])',
       pg_temp.id('n_r1_ready'))),
  'dispensing_reversed 4/0, prescription_dispensed 5/0 | 9 prescription | P0002 ORDER_NOTICE_NOT_FOUND | 0');
select pg_temp.as_member(52);
select pg_temp.same('10c D2, another doctor at GH with P''s and Q''s consent: nothing of DA''s',
  pg_temp.summary() || ' | ' || (select count(*) from ehr.list_order_notices('all', null, 50))
  || ' | ' || pg_temp.try(format('select * from ehr.mark_order_notice_seen(%L)', pg_temp.id('n_b1')))
  || ' | ' || pg_temp.value_of(format('select ehr.mark_order_notices_read(array[%L]::uuid[], array[1]::bigint[])',
       pg_temp.id('n_rx_a_dispensed')))
  || ' | ' || pg_temp.try(format('select * from ehr.list_order_notices(''all'', %L, 5)', pg_temp.id('n_b1'))),
  'none | 0 | P0002 ORDER_NOTICE_NOT_FOUND | 0 | 22023 ORDER_NOTICES_CURSOR_INVALID');
select pg_temp.as_member(54);
select pg_temp.same('10d DA at H3 (another facility, P''s consent there): nothing',
  pg_temp.summary() || ' | ' || (select count(*) from ehr.list_order_notices('all', null, 50))
  || ' | ' || pg_temp.try(format('select * from ehr.mark_order_notice_seen(%L)', pg_temp.id('n_r5'))),
  'none | 0 | P0002 ORDER_NOTICE_NOT_FOUND');
select pg_temp.as_member(26);
select pg_temp.same('10e D3 at H3: nothing', pg_temp.summary(), 'none');
select pg_temp.as_member(15);
select pg_temp.same('10f PA, GH''s pharmacist (own work switched on): nothing, and DA''s notice is not found',
  pg_temp.summary() || ' | ' || (select count(*) from ehr.list_order_notices('all', null, 50))
  || ' | ' || pg_temp.try(format('select * from ehr.mark_order_notice_seen(%L)', pg_temp.id('n_rx_a_dispensed'))),
  'none | 0 | P0002 ORDER_NOTICE_NOT_FOUND');
select pg_temp.as_member(14);
select pg_temp.same('10g LA, GH''s laboratory: nothing', pg_temp.summary(), 'none');
select pg_temp.as_member(16);
select pg_temp.same('10h RA, a receptionist (neither read permission): refused',
  pg_temp.summary() || ' | ' || pg_temp.try('select * from ehr.list_order_notices(''all'', null, 50)')
  || ' | ' || pg_temp.try(format('select * from ehr.mark_order_notice_seen(%L)', pg_temp.id('n_b1')))
  || ' | ' || pg_temp.try(format('select ehr.mark_order_notices_read(array[%L]::uuid[], array[1]::bigint[])',
       pg_temp.id('n_b1'))),
  '42501 ORDER_NOTICES_NOT_PERMITTED | 42501 ORDER_NOTICES_NOT_PERMITTED | 42501 ORDER_NOTICES_NOT_PERMITTED | '
  || '42501 ORDER_NOTICES_NOT_PERMITTED');
select pg_temp.as_member(11, 'emergency');
select pg_temp.same('10i DA in an emergency session: direct care only',
  pg_temp.summary() || ' | ' || pg_temp.try('select * from ehr.list_order_notices(''unread'', null, 5)'),
  '22023 ORDER_NOTICES_DIRECT_CARE_ONLY | 22023 ORDER_NOTICES_DIRECT_CARE_ONLY');
select pg_temp.as_member(11);
select set_config('app.membership_id', '', true);
select pg_temp.same('10j DA without a membership in the session: refused', pg_temp.summary(),
  '42501 ORDER_NOTICES_NOT_PERMITTED');
select pg_temp.as_member(11);
select pg_temp.same('10k bad arguments',
  pg_temp.try('select * from ehr.list_order_notices(''bogus'', null, 5)') || ' | '
  || pg_temp.try('select * from ehr.list_order_notices(null, null, 5)') || ' | '
  || pg_temp.try(format('select * from ehr.list_order_notices(''unread'', %L, 5)', gen_random_uuid())) || ' | '
  || pg_temp.try('select ehr.mark_order_notices_read(array[]::uuid[], array[]::bigint[])') || ' | '
  || pg_temp.try('select ehr.mark_order_notices_read(array(select gen_random_uuid() from generate_series(1, 101)), '
       || 'array(select 1::bigint from generate_series(1, 101)))') || ' | '
  || pg_temp.try(format('select ehr.mark_order_notices_read(array[%L]::uuid[], array[1, 2]::bigint[])',
       pg_temp.id('n_b1'))) || ' | '
  || pg_temp.try(format('select ehr.mark_order_notices_read(array[%L, null]::uuid[], array[1, 1]::bigint[])',
       pg_temp.id('n_b1'))) || ' | '
  || pg_temp.try(format('select * from ehr.mark_order_notice_seen(%L)', gen_random_uuid())),
  '22023 ORDER_NOTICES_LIST_INVALID | 22023 ORDER_NOTICES_LIST_INVALID | 22023 ORDER_NOTICES_CURSOR_INVALID | '
  || '22023 ORDER_NOTICES_READ_INVALID | 22023 ORDER_NOTICES_READ_INVALID | 22023 ORDER_NOTICES_READ_INVALID | '
  || '22023 ORDER_NOTICES_READ_INVALID | P0002 ORDER_NOTICE_NOT_FOUND');
reset role;
select pg_temp.same('10l none of case 10 changed a notice', pg_temp.fingerprint(),
  current_setting('hid.test.fingerprint_10'));

-- 11. Mark read with versions.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(11);
select pg_temp.same('11a a stale version (1; the reversal notice is at 2 after its merge): nothing changes',
  pg_temp.value_of(format('select ehr.mark_order_notices_read(array[%L]::uuid[], array[1]::bigint[])',
    pg_temp.id('n_rx_a_reversed'))) || ' | ' || pg_temp.summary(),
  '0 | dispensing_reversed 4/0, lab_result_corrected 2/0, lab_result_critical 4/4, lab_result_ready 4/0, '
  || 'lab_result_withdrawn 3/0, prescription_dispensed 5/0');
reset role;
select pg_temp.same('11a the stale pair leaves the notice unread at version 2', pg_temp.notices(pg_temp.id('rx_a')),
  'prescription_dispensed:1:1 dispensing_reversed:2:2');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(11);
select pg_temp.same('11b the current version (2): read, version 3, no longer counted; again (3): nothing',
  pg_temp.value_of(format('select ehr.mark_order_notices_read(array[%L]::uuid[], array[2]::bigint[])',
    pg_temp.id('n_rx_a_reversed'))) || ' ' || pg_temp.value_of(format(
    'select ehr.mark_order_notices_read(array[%L]::uuid[], array[3]::bigint[])', pg_temp.id('n_rx_a_reversed')))
  || ' | ' || pg_temp.summary(),
  '1 0 | dispensing_reversed 3/0, lab_result_corrected 2/0, lab_result_critical 4/4, lab_result_ready 4/0, '
  || 'lab_result_withdrawn 3/0, prescription_dispensed 5/0');
select pg_temp.as_member(11);
select set_config('hid.test.c11_read', current_setting('app.correlation_id'), true);
select pg_temp.same('11c three pairs, one an unknown notice: two change',
  pg_temp.value_of(format('select ehr.mark_order_notices_read(array[%L, %L, %L]::uuid[], array[1, 1, 1]::bigint[])',
    pg_temp.id('n_r1_ready'), pg_temp.id('n_x1_dispensed'), gen_random_uuid())), '2');
reset role;
select pg_temp.same('11c one read row per patient, naming the notices that changed',
  pg_temp.audited(current_setting('hid.test.c11_read')) || ' ' || (select event.details::text from audit.events event
    where event.correlation_id = current_setting('hid.test.c11_read') and event.action = 'ehr.order-notice.read'),
  'ehr.order-notice.read P ' || jsonb_build_object('noticeIds', (select jsonb_agg(listed order by listed)
    from unnest(array[pg_temp.id('n_r1_ready'), pg_temp.id('n_x1_dispensed')]) listed))::text);
set local role hid_ehr_api_runtime;
select pg_temp.as_member(11);
select pg_temp.same('11d A''s ready notice read at version 2', pg_temp.value_of(format(
  'select ehr.mark_order_notices_read(array[%L]::uuid[], array[2]::bigint[])', pg_temp.id('n_a_ready'))), '1');
reset role;
select set_config('hid.test.res_a3', pg_temp.own_result(pg_temp.id('item_a'), 'a3', 'normal', 12.9)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_member(14);
select pg_temp.same('11e LA releases A3 v1', pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L,
  'order-notices-release-a3-1')$s$, pg_temp.id('res_a3'), pg_temp.id('a3_check_1'))), 'ok');
reset role;
select pg_temp.same('11e a release after the ready notice was read starts a new one (the merge key is unread rows only)',
  pg_temp.notices(pg_temp.id('lr_a')),
  'lab_result_ready:2:3:read lab_result_corrected:1:1 lab_result_critical:1:1:needs-seen lab_result_ready:1:1');

-- 12. Critical notices: read is not Seen.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(11);
select pg_temp.same('12a B1''s critical notice read',
  pg_temp.value_of(format('select ehr.mark_order_notices_read(array[%L]::uuid[], array[1]::bigint[])',
    pg_temp.id('n_b1'))), '1');
select pg_temp.same('12a it is no longer unread, but still counted as not Seen',
  (select summary_row.unread_count || '/' || summary_row.critical_not_seen_count
     from ehr.order_notice_summary() summary_row where summary_row.kind = 'lab_result_critical'), '3/4');
select pg_temp.same('12b and still on top of the unread list, read',
  (select string_agg(listing.kind || ':' || (listing.read_at is not null), ' ' order by listing.ordinality)
     from ehr.list_order_notices('unread', null, 4) with ordinality listing)
  || ' | ' || (select listing.ordinality <= 4 from ehr.list_order_notices('unread', null, 50) with ordinality listing
                where listing.notice_id = pg_temp.id('n_b1'))
  || ' | ' || (pg_temp.pages('unread', 50) = pg_temp.expected_order('unread', 'e4c10000-0000-4000-8000-000000000011')
               || ' .'),
  'lab_result_critical:false lab_result_critical:false lab_result_critical:false lab_result_critical:true | true | true');
reset role;
select set_config('hid.test.b1_read_at', pg_temp.notice(pg_temp.id('lr_b'), 'lab_result_critical') ->> 'read_at', true);
set local role hid_ehr_api_runtime;
select pg_temp.as_member(11);
select set_config('hid.test.c12_seen', current_setting('app.correlation_id'), true);
select pg_temp.same('12c Seen: the notice as listed, Seen, version 3, its read time kept',
  (select format('%s %s %s %s %s %s %s %s', seen.notice_id = pg_temp.id('n_b1'), seen.seen_at is not null, seen.version,
     seen.read_at = (select (pg_temp.notice(pg_temp.id('lr_b'), 'lab_result_critical') ->> 'read_at')::timestamptz),
     seen.access_ended, seen.full_name, seen.display, seen.needs_seen)
     from ehr.mark_order_notice_seen(pg_temp.id('n_b1')) seen),
  't t 3 t f Patience Okafor Haemoglobin t');
select pg_temp.same('12d Seen again: unchanged (version 3)',
  (select seen.version::text from ehr.mark_order_notice_seen(pg_temp.id('n_b1')) seen), '3');
select pg_temp.as_member(11);
select pg_temp.same('12e no longer counted or listed as unread',
  (select summary_row.unread_count || '/' || summary_row.critical_not_seen_count from ehr.order_notice_summary() summary_row
    where summary_row.kind = 'lab_result_critical')
  || ' | ' || (select count(*) from ehr.list_order_notices('unread', null, 50) listing
                where listing.notice_id = pg_temp.id('n_b1')),
  '3/3 | 0');
reset role;
select pg_temp.same('12f Seen records DA''s account and membership; two seen rows, the second already Seen',
  (select format('%s %s %s', notice ->> 'seen_by_account_id', notice ->> 'seen_by_membership_id',
     notice ->> 'read_at' = current_setting('hid.test.b1_read_at'))
     from pg_temp.notice(pg_temp.id('lr_b'), 'lab_result_critical') notice)
  || ' | ' || pg_temp.audited(current_setting('hid.test.c12_seen')) || ' | '
  || (select string_agg(event.details ->> 'alreadySeen', ',' order by event.sequence_id) from audit.events event
       where event.correlation_id = current_setting('hid.test.c12_seen') and event.action = 'ehr.order-notice.seen'
         and event.resource_id = pg_temp.id('n_b1')::text),
  'e4c10000-0000-4000-8000-000000000011 e4c13000-0000-4000-8000-000000000011 t | ehr.order-notice.seen P, '
  || 'ehr.order-notice.seen P | false,true');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(53);
select pg_temp.same('12g the sibling membership marks A''s critical notice Seen (it was unread)',
  (select seen.version::text from ehr.mark_order_notice_seen(pg_temp.id('n_a_critical')) seen), '2');
reset role;
select pg_temp.same('12g Seen records the sibling membership, and marks it read',
  (select format('%s %s', notice ->> 'seen_by_membership_id', notice ->> 'read_at' is not null)
     from pg_temp.notice(pg_temp.id('lr_a'), 'lab_result_critical') notice),
  'e4c13000-0000-4000-8000-000000000053 t');

-- 13. Access ended: DA's consents for Q end (each of DA's memberships;
-- owner SQL, ended before this transaction began, since the consent test
-- reads the transaction's time).
set local session_replication_role = replica;
update identity.consent_grants set expires_at = starts_at + interval '1 minute'
 where patient_id = 'e4c30000-0000-4000-8000-000000000002' and account_id = 'e4c10000-0000-4000-8000-000000000011';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(11);
select set_config('hid.test.c13_list', current_setting('app.correlation_id'), true);
select pg_temp.same('13a Q''s two notices are listed with access ended: no patient, card, visit or display',
  (select string_agg(format('%s:%s:%s', listing.kind, listing.access_ended, num_nulls(listing.patient_id,
     listing.full_name, listing.sex, listing.date_of_birth, listing.health_id_last4, listing.encounter_id,
     listing.display)), ' ' order by listing.ordinality)
     from ehr.list_order_notices('unread', null, 50) with ordinality listing
    where listing.notice_id in (pg_temp.id('n_q1'), pg_temp.id('n_rx_q'))),
  'lab_result_critical:t:7 prescription_dispensed:t:7');
reset role;
select pg_temp.same('13b that list counts two ended and names P only',
  (select event.details ->> 'accessEndedCount' || ' ' || (event.details -> 'patientIds')::text
    from audit.events event where event.correlation_id = current_setting('hid.test.c13_list')
     and event.action = 'ehr.order-notice.list')
  || ' | ' || pg_temp.audited(current_setting('hid.test.c13_list')),
  '2 ["e4c30000-0000-4000-8000-000000000001"] | ehr.order-notice.list -, ehr.order-notice.list.shown P');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(11);
select pg_temp.same('13c Q''s critical notice is second (R5 and Q1 are the critical notices not Seen)',
  (select string_agg(listing.notice_id::text, ' ' order by listing.ordinality)
     from ehr.list_order_notices('unread', null, 2) with ordinality listing),
  pg_temp.id('n_r5') || ' ' || pg_temp.id('n_q1'));
select pg_temp.same('13d mark read needs no access; Seen does',
  pg_temp.value_of(format('select ehr.mark_order_notices_read(array[%L]::uuid[], array[1]::bigint[])',
    pg_temp.id('n_rx_q'))) || ' | ' || pg_temp.try(format('select * from ehr.mark_order_notice_seen(%L)',
    pg_temp.id('n_q1'))) || ' | ' || (select summary_row.unread_count || '/' || summary_row.critical_not_seen_count
    from ehr.order_notice_summary() summary_row where summary_row.kind = 'lab_result_critical'),
  '1 | 42501 ORDER_NOTICE_CONSENT_REQUIRED | 2/2');
reset role;
select pg_temp.same('13e the refused Seen changed nothing', pg_temp.notices(pg_temp.id('lr_q')) || ' | '
  || pg_temp.notices(pg_temp.id('rx_q')), 'lab_result_critical:1:1:needs-seen | prescription_dispensed:1:2:read');

-- 14. The count check (as the release notes run it): per source table, the
-- source rows of the fixture's patients against the notices' events and the
-- gaps. Fills above 1 and invalidations of versions never released write
-- nothing.
select pg_temp.same('14 sources = events counted in notices + gaps',
  (select format('releases %s invalidations %s first fills %s reversals %s = notices %s + gaps %s',
     (select count(*) from lab.result_releases release where release.patient_id = any(patients)),
     (select count(*) from lab.result_invalidations invalidation where invalidation.patient_id = any(patients)
        and exists (select 1 from lab.result_releases release where release.result_id = invalidation.result_id
                     and release.result_version = invalidation.result_version)),
     (select count(*) from pharmacy.dispensings dispensing where dispensing.patient_id = any(patients)
        and dispensing.fill_number = 1),
     (select count(*) from pharmacy.dispensing_reversals reversal where reversal.patient_id = any(patients)),
     (select sum(notice.event_count) from ehr.order_notices notice where notice.patient_id = any(patients)),
     pg_temp.gaps() - current_setting('hid.test.gaps_before')::bigint)
     from (select array['e4c30000-0000-4000-8000-000000000001', 'e4c30000-0000-4000-8000-000000000002',
             'e4c30000-0000-4000-8000-000000000003']::uuid[] as patients) fixture),
  'releases 12 invalidations 3 first fills 5 reversals 5 = notices 25 + gaps 0');

-- 15. The switch off (the undo's first step): no notice and no gap.
update ehr.order_notice_switch set enabled = false, changed_at = clock_timestamp();
select set_config('hid.test.fingerprint_15', pg_temp.fingerprint(), true);
select set_config('hid.test.res_a4', pg_temp.own_result(pg_temp.id('item_a'), 'a4', 'normal', 13.1)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_member(14);
select pg_temp.same('15a LA releases A4 with the switch off', pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L,
  'order-notices-release-a4-1')$s$, pg_temp.id('res_a4'), pg_temp.id('a4_check_1'))), 'ok');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(15);
select pg_temp.same('15b PA reverses Q''s fill with the switch off', pg_temp.try(format($s$select pg_temp.reverse(%L,
  'order-notices-reverse-q-0001')$s$, pg_temp.id('disp_q1'))), 'ok');
reset role;
select pg_temp.same('15c the switch off: the release and the reversal wrote no notice and no gap',
  (pg_temp.fingerprint() = current_setting('hid.test.fingerprint_15'))::text || ' gaps '
  || (pg_temp.gaps() - current_setting('hid.test.gaps_before')::bigint), 'true gaps 0');
update ehr.order_notice_switch set enabled = true, changed_at = clock_timestamp();

-- 16. The catch rule under READ COMMITTED (0088's and 0090's commands, one
-- attempt). The switch's row is swapped for a view whose read raises a
-- chosen SQLSTATE (owner SQL; the trigger reads the switch first). All of
-- it is undone at the end.
savepoint catch_rule;
set local role hid_ehr_api_runtime;
select set_config('hid.test.rx_x4', pg_temp.prescription(1, 'active')::text, true);
select set_config('hid.test.route_x4', pg_temp.send(11, 'prescription', pg_temp.id('rx_x4'),
  current_setting('hid.test.facility_2')::uuid, 'order-notices-send-x4')::text, true);
reset role;
set local role hid_pharmacy_api_runtime;
select set_config('hid.test.item_x4', pg_temp.accept_rx(pg_temp.id('route_x4'))::text, true);
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select set_config('hid.test.disp_x4', pg_temp.dispense(pg_temp.id('item_x4'), 'order-notices-dispense-x4')::text, true);
reset role;
alter table ehr.order_notice_switch rename to order_notice_switch_kept;
create view ehr.order_notice_switch as
  select true as singleton, pg_temp.fail_now() as enabled, clock_timestamp() as changed_at;
grant select on ehr.order_notice_switch to public;
select set_config('order_notices.fail', '40P01', true);
select set_config('hid.test.gaps_16', pg_temp.gaps()::text, true);
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(33, current_setting('hid.test.facility_2')::uuid);
select pg_temp.same('16a a deadlock (40P01) in the trigger under READ COMMITTED: 0088''s report still goes through',
  pg_temp.value_of(format($s$select reported.result from pharmacy.report_wrong_patient_order_route(%L, %s,
    'someone_elses_details', 'Collected by a person using another patient''s details', 'order-notices-wrong-x4', %L)
    reported$s$, pg_temp.id('route_x4'), pg_temp.route_version(pg_temp.id('route_x4')),
    encode(sha256('order-notices-wrong-x4'::bytea), 'hex'))), 'ended');
reset role;
select pg_temp.same('16b it becomes one gap row (no patient), and no notice',
  (select format('%s %s %s %s %s %s %s', pg_temp.gaps() - current_setting('hid.test.gaps_16')::bigint,
     gap.source_table, gap.source_row_id = (select reversal.id from pharmacy.dispensing_reversals reversal
                                             where reversal.dispensing_id = pg_temp.id('disp_x4')),
     gap.failure_state, coalesce(gap.failure_reason, '-'), gap.kind, gap.order_kind)
     from ehr.order_notice_gaps gap order by gap.recorded_at desc limit 1)
  || ' | ' || pg_temp.notices(pg_temp.id('rx_x4')),
  '1 pharmacy.dispensing_reversals t 40P01 - dispensing_reversed prescription | prescription_dispensed:1:1:routed');
savepoint catch_serialization;
select set_config('order_notices.fail', '40001', true);
select set_config('hid.test.res_a5', pg_temp.own_result(pg_temp.id('item_a'), 'a5', 'normal', 12.4)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_member(14);
select pg_temp.same('16c a serialization failure (40001) is raised again: the release fails, to be retried',
  pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L, 'order-notices-release-a5-1')$s$, pg_temp.id('res_a5'),
    pg_temp.id('a5_check_1'))), '40001 ORD-11 suite: injected failure');
reset role;
rollback to savepoint catch_serialization;
select set_config('order_notices.fail', '22012', true);
select set_config('hid.test.res_a6', pg_temp.own_result(pg_temp.id('item_a'), 'a6', 'normal', 12.5)::text, true);
set local role hid_lab_api_runtime;
select pg_temp.as_member(14);
select pg_temp.same('16d any other error: the release goes through',
  pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L,
  'order-notices-release-a6-1')$s$, pg_temp.id('res_a6'), pg_temp.id('a6_check_1'))), 'ok');
reset role;
select pg_temp.same('16d ... and leaves a gap with its SQLSTATE (the kind not known yet)',
  (select format('%s %s %s %s', gap.source_table, gap.failure_state, coalesce(gap.kind, '-'), gap.order_kind)
     from ehr.order_notice_gaps gap order by gap.recorded_at desc limit 1), 'lab.result_releases 22012 - lab_request');
rollback to savepoint catch_rule;
select pg_temp.same('16e undone: the switch table is back and on, no gap', (select count(*) || ' ' || bool_and(enabled)
  from ehr.order_notice_switch) || ' gaps ' || (pg_temp.gaps() - current_setting('hid.test.gaps_before')::bigint),
  '1 true gaps 0');

-- 17. The sweep (ehr-api's 10-minute timer, withSystemTransaction: only
-- app.actor_subject and app.correlation_id). Every notice of the fixture
-- is moved 91 days back (owner SQL), one read notice to 89 days; two gap
-- rows, 91 and 10 days old. Kept: the two critical notices never Seen (R5,
-- Q1) and the read one inside 90 days. On the NOSUPERUSER NOBYPASSRLS build
-- this is the production owner's path: the table's owner reads no EHR order
-- in that session (17a), so only the stored recipient lets a hold match.
create function pg_temp.owner_reads_requests() returns bigint language plpgsql as $f$
declare
  owner_name text := (select pg_get_userbyid(relation.relowner) from pg_class relation
                       where relation.oid = 'ehr.order_notices'::regclass);
  found bigint;
begin
  execute format('set local role %I', owner_name);
  select count(*) into found from ehr.lab_requests request
   where request.patient_id = 'e4c30000-0000-4000-8000-000000000001';
  reset role;
  return found;
end
$f$;
create function pg_temp.as_system(correlation text) returns void language sql as $f$
  select set_config('app.actor_subject', 'system:auth', true), set_config('app.correlation_id', correlation, true),
    set_config('app.facility_id', '', true), set_config('app.membership_id', '', true),
    set_config('app.purpose_of_use', '', true), set_config('app.own_facility_work', '', true),
    set_config('app.patient_id', '', true)
$f$;
-- The notices of P and Q left: R5, Q1 and the read one by name, then how
-- many others.
create function pg_temp.left_after() returns text language sql as $f$
  select concat_ws(' ', case when bool_or(notice.id = pg_temp.id('n_r5')) then 'R5' end,
           case when bool_or(notice.id = pg_temp.id('n_q1')) then 'Q1' end,
           case when bool_or(notice.id = pg_temp.id('n_rx_a_reversed')) then 'read89' end,
           '+' || count(*) filter (where notice.id not in (pg_temp.id('n_r5'), pg_temp.id('n_q1'),
             pg_temp.id('n_rx_a_reversed'))))
    from ehr.order_notices notice
   where notice.patient_id in ('e4c30000-0000-4000-8000-000000000001', 'e4c30000-0000-4000-8000-000000000002')
$f$;
-- The sweep as the EHR runtime in a system session: its answer, the
-- notices left and the suite's gap rows left.
create function pg_temp.sweep(correlation text, batch integer default 1000) returns text language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.as_system(correlation);
  execute 'set local role hid_ehr_api_runtime';
  answer := pg_temp.value_of(format('select ehr.sweep_order_notices(%s)', batch));
  reset role;
  return answer || ' | ' || pg_temp.left_after() || ' | gaps '
    || (select count(*) from ehr.order_notice_gaps gap where gap.source_table = 'order-notices-suite');
end
$f$;
select pg_temp.as_system('order-notices-owner-read');
select pg_temp.same('17a in the sweep''s session the table owner reads P''s lab requests only when it bypasses '
    || 'row-level security (a superuser owner); production''s NOBYPASSRLS owner reads none',
  pg_temp.owner_reads_requests()::text,
  (select case when role_row.rolsuper or role_row.rolbypassrls then '7' else '0' end from pg_roles role_row
    where role_row.oid = (select relation.relowner from pg_class relation
                           where relation.oid = 'ehr.order_notices'::regclass)));
update ehr.order_notices set first_event_at = first_event_at - interval '91 days',
  last_event_at = last_event_at - interval '91 days', read_at = read_at - interval '91 days',
  seen_at = seen_at - interval '91 days'
 where patient_id in ('e4c30000-0000-4000-8000-000000000001', 'e4c30000-0000-4000-8000-000000000002');
update ehr.order_notices set read_at = clock_timestamp() - interval '89 days' where id = pg_temp.id('n_rx_a_reversed');
insert into ehr.order_notice_gaps (source_table, failure_reason, recorded_at) values
  ('order-notices-suite', 'old', clock_timestamp() - interval '91 days'),
  ('order-notices-suite', 'recent', clock_timestamp() - interval '10 days');
savepoint sweep_case;
select pg_temp.same('17b no hold: 20 notices and the old gap go; the critical notices never Seen and the read one '
    || 'inside 90 days stay', pg_temp.sweep('order-notices-sweep-17b'), '21 | R5 Q1 read89 +0 | gaps 1');
select pg_temp.same('17b one expire row per notice, as the system, with its patient and facility',
  (select format('%s %s %s %s', count(*), string_agg(distinct event.actor_type, ','),
     count(distinct event.patient_id), string_agg(distinct event.facility_id::text, ','))
     from audit.events event where event.correlation_id = 'order-notices-sweep-17b'
      and event.action = 'ehr.order-notice.expire'),
  '20 system 2 e4c21000-0000-4000-8000-000000000001');
rollback to savepoint sweep_case;
insert into platform.legal_holds (subject_type, subject_id, reason)
values ('patient', 'e4c30000-0000-4000-8000-000000000001', 'ORD-11 suite hold on patient P');
select pg_temp.same('17c a hold on the patient (P): only Q''s expired notice goes',
  pg_temp.sweep('order-notices-sweep-17c'), '2 | R5 Q1 read89 +19 | gaps 1');
rollback to savepoint sweep_case;
insert into platform.legal_holds (subject_type, subject_id, reason)
values ('account', 'e4c10000-0000-4000-8000-000000000011', 'ORD-11 suite hold on account DA');
select pg_temp.same('17d a hold on the recipient''s account (DA): no notice goes, the old gap does',
  pg_temp.sweep('order-notices-sweep-17d'), '1 | R5 Q1 read89 +20 | gaps 1');
rollback to savepoint sweep_case;
-- (The definers write the Seen account as the recipient's own; owner SQL
-- gives B1's Seen another account, D2's, to test that match alone.)
update ehr.order_notices set seen_by_account_id = 'e4c10000-0000-4000-8000-000000000052' where id = pg_temp.id('n_b1');
insert into platform.legal_holds (subject_type, subject_id, reason)
values ('account', 'e4c10000-0000-4000-8000-000000000052', 'ORD-11 suite hold on account D2');
select pg_temp.same('17e a hold on the account that marked a notice Seen keeps that notice',
  pg_temp.sweep('order-notices-sweep-17e') || ' | B1 ' || (select count(*) from ehr.order_notices notice
    where notice.id = pg_temp.id('n_b1')), '20 | R5 Q1 read89 +1 | gaps 1 | B1 1');
rollback to savepoint sweep_case;
insert into platform.legal_holds (subject_type, subject_id, reason, placed_at, released_at, released_by_account_id,
  release_reason)
values ('patient', 'e4c30000-0000-4000-8000-000000000001', 'ORD-11 suite released hold on P',
  clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day', 'e4c10000-0000-4000-8000-000000000001',
  'Released after the review');
select pg_temp.same('17f a released hold keeps nothing', pg_temp.sweep('order-notices-sweep-17f'),
  '21 | R5 Q1 read89 +0 | gaps 1');
rollback to savepoint sweep_case;
select pg_temp.same('17g a batch of one: one notice and one gap; a batch of 0 or 1001 is refused',
  split_part(pg_temp.sweep('order-notices-sweep-17g', 1), ' ', 1) || ' | '
  || split_part(pg_temp.sweep('order-notices-sweep-17g2', 0), ' |', 1) || ' | '
  || split_part(pg_temp.sweep('order-notices-sweep-17g3', 1001), ' |', 1),
  '2 | 22023 ORDER_NOTICE_SWEEP_BATCH_INVALID | 22023 ORDER_NOTICE_SWEEP_BATCH_INVALID');
rollback to savepoint sweep_case;

-- 18. Other lanes' triggers on the four tables (the file's section 0 g and
-- its post-check). 0159 is taken away for this transaction (its triggers,
-- functions and tables dropped; owner SQL), the case's triggers are added,
-- and the file is run as written (psql \ir), each in a savepoint undone
-- afterwards. The file's busy check sees this transaction's own locks and
-- makes one attempt, which succeeds. psql's ON_ERROR_ROLLBACK undoes only
-- the statement that fails and runs the rest of the file (the runner, which
-- runs the file as one transaction, would apply nothing).
\set run0159 '\\set ON_ERROR_STOP off \\set ON_ERROR_ROLLBACK on \\set QUIET on \\set LAST_ERROR_SQLSTATE 00000 \\set LAST_ERROR_MESSAGE applied \\ir ../migrations/0159_order_notices.sql \\set QUIET off \\set ON_ERROR_ROLLBACK off \\set ON_ERROR_STOP on'
create function pg_temp.take_0159_away() returns void language plpgsql as $f$
declare proc record;
begin
  drop trigger zz_order_notice on lab.result_releases;
  drop trigger zz_order_notice on lab.result_invalidations;
  drop trigger zz_order_notice on pharmacy.dispensings;
  drop trigger zz_order_notice on pharmacy.dispensing_reversals;
  for proc in select function_row.oid::regprocedure as signature from pg_proc function_row
                join pg_namespace namespace on namespace.oid = function_row.pronamespace
               where namespace.nspname = 'ehr'
                 and (function_row.proname like 'order\_notice\_%' or function_row.proname in ('list_order_notices',
                        'mark_order_notices_read', 'mark_order_notice_seen', 'sweep_order_notices')) loop
    execute format('drop function %s', proc.signature);
  end loop;
  drop table ehr.order_notices, ehr.order_notice_gaps, ehr.order_notice_switch;
end
$f$;
-- What 0159 leaves: its tables, functions and triggers, and the switch.
create function pg_temp.made_0159() returns text language plpgsql as $f$
declare switch_state text := 'none';
begin
  if to_regclass('ehr.order_notice_switch') is not null then
    execute 'select coalesce(string_agg(switch_row.enabled::text, '',''), ''empty'') '
      || 'from ehr.order_notice_switch switch_row' into switch_state;
  end if;
  return format('%s tables, %s functions, %s triggers, switch %s',
    (select count(*) from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'ehr' and relation.relkind = 'r'
        and relation.relname in ('order_notices', 'order_notice_gaps', 'order_notice_switch')),
    (select count(*) from pg_proc function_row join pg_namespace namespace on namespace.oid = function_row.pronamespace
      where namespace.nspname = 'ehr' and (function_row.proname like 'order\_notice\_%'
        or function_row.proname in ('list_order_notices', 'mark_order_notices_read', 'mark_order_notice_seen',
              'sweep_order_notices'))),
    (select count(*) from pg_trigger trigger_row where trigger_row.tgname = 'zz_order_notice'),
    switch_state);
end
$f$;
-- A table's triggers as name:function:type:mode, in name order.
create function pg_temp.triggers_on(table_name text) returns text language sql as $f$
  select string_agg(trigger_row.tgname || ':' || trigger_row.tgfoid::regprocedure::text || ':' || trigger_row.tgtype || ':'
           || trigger_row.tgenabled::text, ' ' order by trigger_row.tgname::text collate "C")
    from pg_trigger trigger_row where trigger_row.tgrelid = table_name::regclass and not trigger_row.tgisinternal
$f$;
-- Stand-ins for Billing's two trigger functions (#336, 0167), when Billing
-- is not applied here, and another lane's trigger function.
create schema if not exists commercial;
do $$
begin
  if to_regprocedure('commercial.hook_dispensing()') is null then
    create function commercial.hook_dispensing() returns trigger language plpgsql as $b$ begin return new; end $b$;
  end if;
  if to_regprocedure('commercial.hook_dispensing_reversal()') is null then
    create function commercial.hook_dispensing_reversal() returns trigger language plpgsql
      as $b$ begin return new; end $b$;
  end if;
end $$;
create schema order_notices_suite;
create function order_notices_suite.other_lane() returns trigger language plpgsql as $b$ begin return null; end $b$;

savepoint other_lanes;
select pg_temp.take_0159_away();
select pg_temp.same('18a 0159 taken away for the cases below', pg_temp.made_0159(),
  '0 tables, 0 functions, 0 triggers, switch none');
drop trigger if exists zz_billing_stock_and_gate on pharmacy.dispensings;
drop trigger if exists zz_billing_reversal on pharmacy.dispensing_reversals;
create trigger zz_billing_stock_and_gate before insert on pharmacy.dispensings
  for each row execute function commercial.hook_dispensing();
create trigger zz_billing_reversal before insert on pharmacy.dispensing_reversals
  for each row execute function commercial.hook_dispensing_reversal();
:run0159
select pg_temp.same('18b Billing''s two triggers (BEFORE INSERT, origin): the file applies as written',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE' || ' | ' || pg_temp.made_0159(),
  '00000 applied | 3 tables, 13 functions, 4 triggers, switch true');
select pg_temp.same('18c the two dispensing tables then: Release E''s and 0154''s, Billing''s and zz_order_notice',
  pg_temp.triggers_on('pharmacy.dispensings') || ' | ' || pg_temp.triggers_on('pharmacy.dispensing_reversals'),
  'dispensings_claim_prescription:pharmacy.claim_prescription_dispensing():5:A '
  || 'dispensings_order_route_return:pharmacy.return_order_route_dispensing():5:O '
  || 'pharmacy_dispensing_validate:pharmacy.validate_dispensing():7:O '
  || 'pharmacy_dispensings_immutable:pharmacy.reject_immutable_evidence():27:O '
  || 'prescription_claim_key_immutable:pharmacy.refuse_claim_key_change():19:A '
  || 'zz_billing_stock_and_gate:commercial.hook_dispensing():7:O zz_order_notice:ehr.order_notice_from_dispensing():5:O | '
  || 'dispensing_reversals_order_route_return:pharmacy.return_order_route_reversal():5:O '
  || 'pharmacy_dispensing_reversal_validate:pharmacy.validate_dispensing_reversal():7:O '
  || 'pharmacy_dispensing_reversals_immutable:pharmacy.reject_immutable_evidence():27:O '
  || 'zz_billing_reversal:commercial.hook_dispensing_reversal():7:O '
  || 'zz_order_notice:ehr.order_notice_from_reversal():5:O');
rollback to savepoint other_lanes;
-- Any other trigger is refused by section 0. The event trigger drops the
-- case's trigger when the file makes its first trigger (section 4), so the
-- rest of the file runs clean and psql keeps section 0's refusal as the
-- last error; without it (18g) the post-check refuses too.
select pg_temp.take_0159_away();
drop trigger if exists zz_billing_stock_and_gate on pharmacy.dispensings;
drop trigger if exists zz_billing_reversal on pharmacy.dispensing_reversals;
create trigger zz_other_lane after insert on lab.result_releases
  for each row execute function order_notices_suite.other_lane();
create event trigger order_notices_suite_drop on ddl_command_end when tag in ('CREATE TRIGGER')
  execute function pg_temp.drop_extra_trigger();
select set_config('order_notices.drop_extra', 'drop trigger zz_other_lane on lab.result_releases', true);
:run0159
select pg_temp.same('18d another lane''s trigger on lab.result_releases: section 0 refuses',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE',
  '55000 0159: the triggers on lab.result_releases are not the ones Release E and 0154 left (Billing''s two aside)');
rollback to savepoint other_lanes;
select pg_temp.take_0159_away();
drop trigger if exists zz_billing_stock_and_gate on pharmacy.dispensings;
create trigger zz_billing_stock_and_gate after insert on pharmacy.dispensings
  for each row execute function commercial.hook_dispensing();
create event trigger order_notices_suite_drop on ddl_command_end when tag in ('CREATE TRIGGER')
  execute function pg_temp.drop_extra_trigger();
select set_config('order_notices.drop_extra', 'drop trigger zz_billing_stock_and_gate on pharmacy.dispensings', true);
:run0159
select pg_temp.same('18e Billing''s name on pharmacy.dispensings but AFTER INSERT: refused',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE',
  '55000 0159: the triggers on pharmacy.dispensings are not the ones Release E and 0154 left (Billing''s two aside)');
rollback to savepoint other_lanes;
select pg_temp.take_0159_away();
drop trigger if exists zz_billing_stock_and_gate on pharmacy.dispensings;
drop trigger if exists zz_billing_reversal on pharmacy.dispensing_reversals;
create trigger zz_billing_reversal before insert on pharmacy.dispensings
  for each row execute function commercial.hook_dispensing_reversal();
create event trigger order_notices_suite_drop on ddl_command_end when tag in ('CREATE TRIGGER')
  execute function pg_temp.drop_extra_trigger();
select set_config('order_notices.drop_extra', 'drop trigger zz_billing_reversal on pharmacy.dispensings', true);
:run0159
select pg_temp.same('18f Billing''s reversal trigger on the dispensings table: refused',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE',
  '55000 0159: the triggers on pharmacy.dispensings are not the ones Release E and 0154 left (Billing''s two aside)');
rollback to savepoint other_lanes;
select pg_temp.take_0159_away();
create trigger zz_other_lane after insert on lab.result_releases
  for each row execute function order_notices_suite.other_lane();
:run0159
select pg_temp.same('18g with the other trigger left in place the post-check refuses as well',
  :'LAST_ERROR_SQLSTATE' || ' ' || :'LAST_ERROR_MESSAGE',
  '55000 0159: the triggers on lab.result_releases are not as this file leaves them, or zz_order_notice does not fire '
  || 'after the route return');
rollback to savepoint other_lanes;
select pg_temp.same('18h 0159 is back as it was', pg_temp.made_0159(), '3 tables, 13 functions, 4 triggers, switch true');

do $$
begin
  if currval('pg_temp.order_notices_passed') is distinct from 112 then
    raise exception 'ORD-11 order notices suite failed: % cases ran in the first transaction, % expected',
      currval('pg_temp.order_notices_passed'), 112;
  end if;
  raise notice 'ORD-11 order notices suite: % cases passed (READ COMMITTED)', currval('pg_temp.order_notices_passed');
end $$;
rollback;

-- 19. SERIALIZABLE, as lab-api's release and pharmacy-api's dispensing and
-- reversal run (each retries 40001 and 40P01). A second transaction, so it
-- can be SERIALIZABLE from its start; its own small fixture: GH, DA, LA, PA
-- and LC and patient P, with P4c's ids. One transaction cannot hold a
-- concurrent pair; what lets two of them on different orders commit is that
-- the triggers never read ehr.order_notices (they only insert, with ON
-- CONFLICT), so this transaction holds no SIRead lock on it or its indexes.
begin isolation level serializable;
select setval('pg_temp.order_notices_passed', 1, false);
insert into identity.purpose_of_use_codes (code, display, source_system)
values ('direct-care', 'Direct patient care', 'order-notices-test') on conflict (code) do nothing;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e4c10000-0000-4000-8000-000000000001', 'synthetic:p4c:super', 'super@p4c.invalid', 'P4c Super Admin', 'active');
insert into identity.organizations (id, name, slug) values
  ('e4c20000-0000-4000-8000-000000000001', 'P4c Governed Hospital Ltd', 'p4c-governed-hospital');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e4c21000-0000-4000-8000-000000000001', 'e4c20000-0000-4000-8000-000000000001', 'P4c General Hospital',
   'P4C-GH', 'Africa/Lagos', true, 'verified');
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, provider_reference,
  verified_at, organization_id, facility_id, reviewed_by_account_id, review_reason, reviewed_at,
  verified_organization_name, verified_entity_type, verified_registration_date, verified_address, verified_registry_status)
values ('e4c22000-0000-4000-8000-000000000001', 'ehr', 'P4c Governed Hospital Ltd', 'hospital', 'RC9944001',
  'Governed Admin 1', 'admin1@p4c-governed.invalid', 'approved', 'verified', '771', clock_timestamp(),
  'e4c20000-0000-4000-8000-000000000001', 'e4c21000-0000-4000-8000-000000000001',
  'e4c10000-0000-4000-8000-000000000001', 'Governed approval for the P4c suites', clock_timestamp(),
  'P4c Governed Hospital Ltd', 'Private Company Limited by Shares', '2019-05-01', '1 Governed Road, Ikeja, Lagos',
  'active');
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id)
values ('e4c20000-0000-4000-8000-000000000001', 'ehr', 'e4c21000-0000-4000-8000-000000000001', 'active',
  'e4c22000-0000-4000-8000-000000000001');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, 'synthetic:p4c:' || s.code,
  s.code || '@p4c-staff.invalid', s.full_name, 'active'
  from (values (11, 'da', 'Ada Doctor'), (14, 'la', 'Dele Lab'), (15, 'pa', 'Efe Pharmacist'),
               (51, 'lc', 'Kunle Second Lab')) s(n, code, full_name);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.full_name, s.code || '@p4c-staff.invalid', 'verified', s.role
  from (values (11, 'da', 'Ada Doctor', 'doctor'), (14, 'la', 'Dele Lab', 'lab'),
               (15, 'pa', 'Efe Pharmacist', 'pharmacist'), (51, 'lc', 'Kunle Second Lab', 'lab'))
       s(n, code, full_name, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c12000-0000-4000-8000-0000000000' || s.n)::uuid,
  ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid, 'e4c20000-0000-4000-8000-000000000001',
  'e4c21000-0000-4000-8000-000000000001', s.role, s.role, true, true
  from (values (11, 'doctor'), (14, 'lab'), (15, 'pharmacist'), (51, 'lab')) s(n, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e4c11000-0000-4000-8000-0000000000' || s.n)::uuid, ('e4c10000-0000-4000-8000-0000000000' || s.n)::uuid,
  s.role, 'facility', ('e4c13000-0000-4000-8000-0000000000' || s.n)::uuid, 'e4c21000-0000-4000-8000-000000000001',
  'ORD-11 suite role'
  from (values (11, 'doctor'), (14, 'lab'), (15, 'pharmacist'), (51, 'lab')) s(n, role);
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e4c10000-0000-4000-8000-000000000041', 'synthetic:p4c:patient-p', 'patient-p@p4c.invalid', 'Patience Okafor', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e4c30000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000041', 'HID-P4CPATP',
   'Patience', 'Okafor', 'Patience Okafor', 'female', '1990-04-12', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, break_glass, purpose_of_use)
select gen_random_uuid(), 'e4c30000-0000-4000-8000-000000000001', ('e4c12000-0000-4000-8000-0000000000' || n)::uuid,
  ('e4c10000-0000-4000-8000-0000000000' || n)::uuid, ('e4c13000-0000-4000-8000-0000000000' || n)::uuid,
  'e4c21000-0000-4000-8000-000000000001', 'write_records', 'active', 'ORD-11 suite direct-care consent',
  clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days', false, 'direct-care'
  from unnest(array[11, 14, 15]) n;
-- DA's visit and two lab requests (S1, S2), through the EHR runtime.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(11);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e4c50000-0000-4000-8000-000000000001', 'e4c30000-0000-4000-8000-000000000001',
  'e4c21000-0000-4000-8000-000000000001', 'e4c10000-0000-4000-8000-000000000011',
  'e4c13000-0000-4000-8000-000000000011', 'ambulatory', 'in_progress', clock_timestamp());
insert into ehr.lab_requests (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  test_code_system, test_code, test_display, priority, status, specimen_type_code, clinical_information)
select ('e4c60000-0000-4000-8000-00000000000' || n)::uuid, 'e4c50000-0000-4000-8000-000000000001',
  'e4c30000-0000-4000-8000-000000000001', 'e4c21000-0000-4000-8000-000000000001',
  'e4c10000-0000-4000-8000-000000000011', 'e4c13000-0000-4000-8000-000000000011', 'http://loinc.org', '718-7',
  'Haemoglobin', 'urgent', 'active', 'whole-blood', 'Fever for three days'
  from generate_series(1, 2) n;
select set_config('hid.test.rx_s', pg_temp.own_rx(1)::text, true);
reset role;
select set_config('hid.test.item_s' || n, pg_temp.own_lab_item(('e4c60000-0000-4000-8000-00000000000' || n)::uuid)::text,
  true) from generate_series(1, 2) n;
select set_config('hid.test.res_s1', pg_temp.own_result(pg_temp.id('item_s1'), 's1', 'normal', 12.8)::text, true);
select set_config('hid.test.res_s2', pg_temp.own_result(pg_temp.id('item_s1'), 's2', 'normal', 12.7)::text, true);
select set_config('hid.test.res_s3', pg_temp.own_result(pg_temp.id('item_s2'), 's3', 'critical_candidate', 5.0)::text,
  true);
select set_config('hid.test.res_s4', pg_temp.own_result(pg_temp.id('item_s2'), 's4', 'normal', 12.6)::text, true);
select pg_temp.same('19a this transaction is SERIALIZABLE', current_setting('transaction_isolation'), 'serializable');
set local role hid_lab_api_runtime;
select pg_temp.as_member(14);
select pg_temp.same('19b LA releases S1 and S2 (one order: a new notice, then the merge) and S3 (critical)',
  pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L, 'order-notices-release-s1-1')$s$, pg_temp.id('res_s1'),
    pg_temp.id('s1_check_1'))) || ' ' || pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L,
    'order-notices-release-s2-1')$s$, pg_temp.id('res_s2'), pg_temp.id('s2_check_1'))) || ' '
  || pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L, 'order-notices-release-s3-1')$s$,
    pg_temp.id('res_s3'), pg_temp.id('s3_check_1'))), 'ok ok ok');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(15);
select set_config('hid.test.disp_s', pg_temp.dispense_fill(pg_temp.item_of(pg_temp.id('rx_s')), 1,
  'order-notices-fill-s-0001')::text, true);
select set_config('hid.test.rev_s', pg_temp.reverse(pg_temp.id('disp_s'), 'order-notices-reverse-s-0001')::text, true);
reset role;
select pg_temp.same('19c after an insert, a merge, a critical insert, a dispensing and a reversal: SIRead locks held, '
    || 'none on the notices, their indexes or the gaps (read before anything here reads them)',
  (select format('%s %s', count(*) > 0, count(*) filter (where held.relation in (select relation.oid from pg_class relation
       where relation.oid in ('ehr.order_notices'::regclass, 'ehr.order_notice_gaps'::regclass)
          or relation.oid in (select index_row.indexrelid from pg_index index_row
                               where index_row.indrelid in ('ehr.order_notices'::regclass,
                                       'ehr.order_notice_gaps'::regclass)))))
     from pg_locks held where held.pid = pg_backend_pid() and held.mode = 'SIReadLock'),
  't 0');
select pg_temp.same('19d the notices, as under READ COMMITTED',
  pg_temp.notices('e4c60000-0000-4000-8000-000000000001') || ' | ' || pg_temp.notices('e4c60000-0000-4000-8000-000000000002')
  || ' | ' || pg_temp.notices(pg_temp.id('rx_s')),
  'lab_result_ready:2:2 | lab_result_critical:1:1:needs-seen | prescription_dispensed:1:1 dispensing_reversed:1:1');
-- The catch rule under SERIALIZABLE: 40001 and 40P01 are raised again (the
-- services retry the whole transaction); anything else is a gap.
alter table ehr.order_notice_switch rename to order_notice_switch_kept;
create view ehr.order_notice_switch as
  select true as singleton, pg_temp.fail_now() as enabled, clock_timestamp() as changed_at;
grant select on ehr.order_notice_switch to public;
set local role hid_lab_api_runtime;
select pg_temp.as_member(14);
select set_config('order_notices.fail', '40P01', true);
select pg_temp.same('19e a deadlock (40P01) is raised again under SERIALIZABLE: the release fails, to be retried',
  pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L, 'order-notices-release-s4-1')$s$, pg_temp.id('res_s4'),
    pg_temp.id('s4_check_1'))), '40P01 ORD-11 suite: injected failure');
select set_config('order_notices.fail', '40001', true);
select pg_temp.same('19f so is a serialization failure (40001)',
  pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L, 'order-notices-release-s4-1')$s$, pg_temp.id('res_s4'),
    pg_temp.id('s4_check_1'))), '40001 ORD-11 suite: injected failure');
select set_config('order_notices.fail', '22012', true);
select pg_temp.same('19g any other error: the release goes through',
  pg_temp.try(format($s$select pg_temp.release_as(%L, 1, %L, 'order-notices-release-s4-1')$s$, pg_temp.id('res_s4'),
    pg_temp.id('s4_check_1'))), 'ok');
reset role;
select pg_temp.same('19g ... with a gap row', (select count(*) || ' ' || string_agg(gap.failure_state, ',')
  from ehr.order_notice_gaps gap where gap.source_table = 'lab.result_releases'), '1 22012');

do $$
begin
  if currval('pg_temp.order_notices_passed') is distinct from 8 then
    raise exception 'ORD-11 order notices suite failed: % cases ran in the second transaction, % expected',
      currval('pg_temp.order_notices_passed'), 8;
  end if;
  raise notice 'ORD-11 order notices suite: % cases passed (SERIALIZABLE)', currval('pg_temp.order_notices_passed');
end $$;
rollback;
