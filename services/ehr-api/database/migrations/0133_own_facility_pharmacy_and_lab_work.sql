-- 0133 This facility's own pharmacy and lab work: activated prescriptions go
-- to the hospital's own pharmacy by themselves, and the facility's pharmacy
-- and lab staff work on their own facility's work items without a personal
-- consent grant (ORD-2 of the Akos EHR plan of 18 November 2026, Release A,
-- lane D; it also fixes the plan's finding F2 and Akos item N-4). Written on
-- staging-novu-ci-20261005 at 1f5e2c2a, where 0001-0127 are applied. 0128
-- (hid-system#264) and 0129 (hid-system#266) are booked before this number
-- and replace nothing this file reads or replaces. This file requires
-- 0001-0127 applied. The declaration is signed separately.
--
-- Owner, 18 November 2026: "activated prescriptions go automatically to the
-- hospital's own pharmacy: YES", and "pharmacy and lab staff get their own
-- facility's work items only, never the chart".
--
-- THE GAP (F2). This facility's own pharmacy and lab work (no order route)
-- is read, and dispensed or worked on, only by a member who personally
-- holds a consent grant for the patient: the work items' read policies
-- (lab|pharmacy.work_item_allows, 0086 H8), the chain tables' policies
-- (lab|pharmacy.context_allows, 0086) and 0124's patient cards all ask the
-- member's own consent. So a prescription sent to the hospital's pharmacy
-- shows the pharmacist "To dispense 0" and a card without a name, and a
-- doctor, who does not hold pharmacy.work-item.accept, cannot send it there.
--
-- WHAT IT DOES
-- D1 identity.facility_work_member_allows(kind, patient, facility, action):
--    true when the session works for this facility's pharmacy ('pharmacy')
--    or laboratory ('lab'): purpose direct-care; the row's facility is the
--    session's; the member holds, at that facility, <kind>.work-item.read
--    and <kind>.order-route.receive (the permission that already lets the
--    pharmacist and the lab scientist work on another facility's orders;
--    held today by the pharmacist and lab roles only, so doctors, nurses,
--    clinicians, receptionists and admins gain nothing from it); the
--    membership is active (auth.membership_has_permission); the patient is
--    active; and no active deny directive of the patient covers this
--    member, facility, action and purpose (the same test as the consent
--    check's). Emergency sessions keep their own rule (break-glass) and do
--    not use this one.
-- D2 lab.work_item_allows and pharmacy.work_item_allows (0086 H8, the work
--    items' read and insert policies) gain one branch, for reads only: an
--    own work item (no route) is read when D1 allows its patient. This is
--    the item itself. Accepting a new item into the lab or pharmacy (an
--    insert) still needs the member's consent, as before (the automatic
--    send of D7 inserts in the prescriber's session, under the prescriber's
--    consent).
-- D3 The work chain, decided item by item: lab.own_work_chain_allows and
--    pharmacy.own_work_chain_allows(anchor, id, patient, facility, action)
--    are true when D1 allows the row's patient and the row belongs to an
--    own work item (no route) of that patient at that facility. The anchor
--    is the row's own key up to its work item: the work item itself
--    (work_item_id), an accession (accession_id: the accession's work item),
--    a specimen (specimen_id: its accession's) or an execution
--    (execution_id: its accession's); for Pharmacy the work item, a
--    dispensing or a reversal. Separate permissive policies named
--    own_work_read, own_work_insert and own_work_update use them on exactly
--    the chain tables the contract lists: Lab's work item events, requested
--    tests, accessions and their events, specimen requirements, specimens
--    and their events and command keys, executions and their events,
--    results, their revisions, events, verifications, releases and
--    invalidations; Pharmacy's work item events, dispensings and reversals
--    (read and insert; update where 0086 has an update policy: specimens,
--    executions, results), and pharmacy.outbox_events (insert only, for the
--    events Pharmacy writes about a work item, a dispensing or a reversal).
--    0086's lab|pharmacy.context_allows keep their bodies: the imported
--    evidence tables (the patient's OCR-imported outside medication and lab
--    records, which are chart data) gain nothing, and a route-backed item's
--    rows (another facility's order) never pass the own-work test, whatever
--    else the patient has here.
-- D4 lab.work_item_patient_cards and pharmacy.work_item_patient_cards (0124)
--    gain D1 next to the consent test, so the card shows the patient's name
--    on the item the member may now work on.
-- D5 ehr.prescriptions gains two policies for the owner of
--    pharmacy.validate_dispensing only (TO that role): the owner may read,
--    and lock FOR SHARE, the source prescription of an own pharmacy work
--    item that D1 lets the session work on
--    (pharmacy.own_work_source_prescription). The dispensing validator (0101)
--    reads the source prescription as its owner; under production's forced
--    row-level security it would otherwise find nothing for a pharmacist
--    without a consent grant and refuse every such dispensing
--    (PRESCRIPTION_SOURCE_NOT_DISPENSABLE). The lock policy's WITH CHECK is
--    false, so it gives no update. No runtime role reads ehr.prescriptions
--    through it: it names the owner only, and sections 0 and 8 stop the file
--    if any hid_ role is that owner's member. Every SECURITY DEFINER function
--    that owner runs sees, in a pharmacist's session, the source
--    prescriptions of that facility's own pharmacy work the pharmacist works
--    on, and nothing else. Of the seven that read ehr.prescriptions today:
--    validate_dispensing is the reader D5 is for; validate_work_item finds
--    such a prescription only when it is already in the pharmacy, and one
--    item per prescription and the work items' insert policy then refuse;
--    ehr.send_order_route, D7 and D8 refuse a pharmacist before they read;
--    ehr.patient_list_order_routes answers patient sessions only; and
--    identity.demo_story_install has no runtime grant (the suite lists the
--    seven and shows each).
-- D6 pharmacy.own_prescription_sends: one row per prescription sent by
--    itself to this facility's pharmacy: the version, patient, facility and
--    encounter, who sent it (the prescriber's account and membership), the
--    state (pending, then sent with the work item), attempts and the last
--    failure's SQLSTATE (no text), and withdrawn_at once the prescription is
--    put on hold, cancelled or entered in error after the send. Row-level
--    security on (not forced), no policy and no grant: only this file's
--    functions read or write it, with ids taken from the rows they checked.
--    No foreign key, so creating it locks none of the tables those ids name
--    (work items, like the rows they name, are never deleted).
-- D7 ehr.send_prescription_to_own_pharmacy(prescription, version) (SECURITY
--    DEFINER), for the EHR runtime, in the activation's own transaction:
--    the session must be direct-care and hold ehr.prescription.write here
--    (else 42501 OWN_PHARMACY_SEND_DENIED). It answers one row (outcome,
--    work item):
--      not_found     no such prescription here that the session may read;
--      not_prescriber the session is not the prescriber (account and
--                    membership): nothing is sent for someone else;
--      not_active    the prescription is not active;
--      changed       it is not at the given version;
--      routed        it has a live route to another facility;
--      already_in_pharmacy  a work item already exists for it (a
--                    pharmacist accepted it, or an earlier send);
--      no_pharmacy   nobody at this facility can work on pharmacy items
--                    (no active member holds pharmacy.work-item.read and
--                    pharmacy.order-route.receive here);
--      sent          the work item was created now;
--      pending       the attempt failed: the send row stays pending with the
--                    failure's SQLSTATE, and nothing else is written.
--    The work item is created exactly as pharmacy-api creates one (0100's
--    validator checks it against the prescription), with accepted_by the
--    prescriber, never a pharmacist, and the fixed reason "Sent
--    automatically when the prescription was activated"; one
--    prescription_accepted event and one PharmacyWorkItemCreated outbox
--    event with pharmacy-api's own payload (workItemId,
--    sourceEhrPrescriptionId, sourceEhrPrescriptionVersion, status
--    'accepted': the event dispatcher refuses any other key; the automatic
--    origin is the work item's accepted_by and acceptance_reason). The
--    attempt runs in a subtransaction, so a failure never undoes the
--    activation; a serialization failure or deadlock is raised, so the
--    caller's retry runs the whole transaction again. A second call for a
--    sent prescription answers already_in_pharmacy and writes nothing. A
--    pending send is tried again by the next call (the prescriber's "Send
--    to pharmacy").
-- D8 ehr.withdraw_own_pharmacy_send(prescription) (SECURITY
--    DEFINER), for the EHR runtime, in the transaction that puts the
--    prescription on hold, cancels it or enters it in error: the same
--    session test as D7; marks the send withdrawn (once) when the
--    prescription, as the session reads it, is no longer active. Dispensing
--    is refused anyway by 0101 (the version or status changed).
-- D9 pharmacy.own_work_access_for(resource, id, action) and
--    lab.own_work_access_for(resource, id, action) (SECURITY DEFINER,
--    STABLE), for their runtimes: the own work item (no route) the
--    resource belongs to, when D1 allows the session on it; else no row.
--    Pharmacy resources: work_item, dispensing; Lab: work_item, accession,
--    specimen, execution, result (as 0086's C16 and C17).
-- D10 pharmacy.own_work_item_states(ids) and lab.own_work_item_bases(ids)
--    (SECURITY DEFINER, STABLE), for their runtimes, at most 200 ids: for
--    each own work item at the session's facility the session may read,
--    the basis ('consent' when the member's consent test passes, else
--    'own-work'), and for Pharmacy whether its send was withdrawn. The APIs
--    write the audit rows of the work list with that basis.
-- D11 Grants, here and in runtime-grants.sql: D7 and D8 to hid_ehr_runtime;
--    D9 and D10 to hid_pharmacy_runtime or hid_lab_runtime; D3's functions
--    to the runtime that reads its schema's chain tables
--    (hid_lab_runtime, hid_pharmacy_runtime: a policy's function is executed
--    with the querying role's privileges, as 0086's context_allows is);
--    all of them to hid_schema_test_runtime; D1 and D5's helper to nobody
--    (the functions that call them run them as their owner). Revoked from
--    PUBLIC. The replaced functions keep their ACLs.
-- D12 No platform control and no new setting (the owner's rule: no new
--    settings unless unavoidable). ehr-api sends when the function exists
--    and answers the send as `pharmacyHandoff`; an older schema answers no
--    pharmacyHandoff and nothing else changes.
--
-- What it does not do: no new role permission (the plan's 0136 decides the
-- role table, still open); doctors still cannot accept into Pharmacy through
-- pharmacy-api; no Lab request is sent by itself (the plan does not ask it);
-- the prescription details of 0125 still need the member's consent (its
-- reader reads the chart's version snapshots), so a pharmacist without a
-- grant sees the item without them; no chart table gains a reader, and the
-- imported evidence tables keep 0086's policies.
--
-- 0. Preconditions (catalog reads only, from pg_class, pg_proc,
--    pg_namespace, pg_attribute and pg_policy, so a login that may not use a
--    schema reaches this file's own messages; each is a presence check that
--    raises when the thing is absent, never a comparison that can be null;
--    each failure raises 55000 or 42501 and nothing is applied):
--    a. 0001-0127 applied (the markers: 0123's identity.sealed_qa_members,
--       0124's two card readers, 0125's
--       pharmacy.work_item_prescription_details(uuid[]), 0126's
--       identity.organization_staff_kinds(uuid) and 0127's
--       auth.session_single_sign_on);
--    b. 0133 not applied (no table, function or policy of this file's names);
--    c. every column the new bodies and policies read or write, by name and
--       type;
--    d. the bodies replaced and relied on are byte for byte the ones
--       0001-0127 left (md5 of pg_proc.prosrc, joined by schema, name and
--       argument types; a missing function counts as a mismatch): 0086's
--       work_item_allows (both) and 0124's two card readers (replaced); the
--       consent test (0104's), the membership and permission checks, the
--       six session readers, 0086's context_allows (both) and the route
--       tests they and work_item_allows call, validate_work_item (0100) and
--       validate_dispensing (0101) (relied on);
--    e. one owner (pharmacy.work_items') owns every table this file locks,
--       gives a policy or reads in a new body, the replaced functions and
--       both validators (else 42501);
--    f. the applier is that owner, or a member that inherits it and may SET
--       ROLE to it (so the new objects are the owner's); that owner may
--       create in and use identity, lab, pharmacy and ehr and use auth and
--       platform (else 42501);
--    g. no hid_ role other than the owner is a member of it (D5's premise;
--       else 55000);
--    and it records the replaced functions' ACLs for section 8.
-- 1. Locks, NOWAIT, retried every 100 ms for at most 5 seconds, else 55P03
--    with nothing applied (see Locks).
-- 2. The applier acts as that owner for the rest of this transaction, so
--    every new object is the owner's.
-- 3. D1 and the replaced bodies (D2, D4).
-- 4. D3: the two chain functions and the 42 own-work policies.
-- 5. D6 and D5.
-- 6. D7-D10.
-- 7. Grants (D11) and comments.
-- 8. Post-checks: each new and replaced function's body (md5), owner,
--    SECURITY DEFINER, volatility, language, not STRICT and search_path;
--    the exact EXECUTE grants of each new function, whether or not each
--    grantee exists (each existing expected grantee holds EXECUTE, nothing
--    else is granted, PUBLIC included); the replaced functions' ACLs as
--    section 0 found them; the sends table's columns, types, NOT NULLs,
--    defaults, CHECKs, primary and unique keys, its index, row-level
--    security on and not forced, no policy and no grant; the two
--    ehr.prescriptions policies and the 42 own-work policies, exactly, and
--    row-level security still enabled and forced on every table that gained
--    one; D5's premise again; then D7 and D8 are fired once without a
--    session and must refuse with 42501 OWN_PHARMACY_SEND_DENIED, and D9
--    once per resource type with random ids and must answer no row (plpgsql
--    plans a query only when it first runs, so this proves the columns
--    those queries read exist).
--
-- Locks (measured with pg_locks before commit on a 0127 copy): section 1
-- takes, in one attempt, ACCESS EXCLUSIVE on ehr.prescriptions and on the 20
-- Lab and Pharmacy chain tables that gain a policy (CREATE POLICY needs it),
-- and ACCESS SHARE on the tables the new SQL functions read when they are
-- created (lab.work_items, pharmacy.work_items, identity.patients, the
-- consent directives and their versions, the memberships), all NOWAIT: a
-- busy table fails the attempt at once, its subtransaction releases what it
-- took, and the loop tries again 100 ms later, so the migration never waits
-- while holding a lock and no request queues behind a waiting lock; after
-- 50 attempts (5 seconds) it stops the release (55P03, nothing applied; the
-- same release can run again). Once taken, the locks last to commit: EHR
-- prescription reads and writes and every Lab and Pharmacy chain read and
-- write wait until then, a few milliseconds when 0133 releases alone (no row
-- is read or written, the new table is empty); if it ships with other
-- pending migrations, the runner's dry run of all of them in one
-- transaction holds the locks until that dry run ends. The replaced
-- functions' catalog rows are locked too; the new table takes no lock on
-- existing data. Section 0 takes no table lock.
--
-- Old services on this schema: today's images call none of the new
-- functions. They gain, through the changed policies, the pharmacist's and
-- lab scientist's view of this facility's own work: today's lab-api and
-- pharmacy-api list it (the list reads under row-level security), while a
-- single item, a dispensing and every chain command still ask Identity's
-- consent in today's images, so they answer as before until the new images
-- (which ask D9 first) are deployed. Applied migrations before 0133 are
-- immutable.

-- 0. Preconditions.
do $$
declare
  found_absent boolean;
  missing text;
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
  owner_oid oid;
begin
  -- a. 0001-0127 applied: 0123's sealed QA members table, 0124's, 0125's and
  -- 0126's readers and 0127's single sign-on table, read from the catalog.
  if not exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
                  where namespace.nspname = 'identity' and relation.relname = 'sealed_qa_members'
                    and relation.relkind = 'r')
     or not exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                     where (namespace.nspname, proc.proname, pg_catalog.oidvectortypes(proc.proargtypes)) in (
                       ('lab', 'work_item_patient_cards', 'uuid[]'),
                       ('pharmacy', 'work_item_patient_cards', 'uuid[]'),
                       ('pharmacy', 'work_item_prescription_details', 'uuid[]'),
                       ('identity', 'organization_staff_kinds', 'uuid'))
                    having count(distinct proc.oid) = 4)
     or not exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
                     where namespace.nspname = 'auth' and relation.relname = 'session_single_sign_on'
                       and relation.relkind = 'r') then
    raise exception using errcode = '55000', message = '0133: 0001-0127 must be applied first';
  end if;
  -- b. Not applied yet: no table, function or policy of this file's names.
  if exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
              where namespace.nspname = 'pharmacy' and relation.relname = 'own_prescription_sends')
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where (namespace.nspname, proc.proname) in (('identity', 'facility_work_member_allows'),
                         ('lab', 'own_work_chain_allows'), ('pharmacy', 'own_work_chain_allows'),
                         ('pharmacy', 'own_work_source_prescription'), ('ehr', 'send_prescription_to_own_pharmacy'),
                         ('ehr', 'withdraw_own_pharmacy_send'), ('pharmacy', 'own_work_access_for'),
                         ('lab', 'own_work_access_for'), ('pharmacy', 'own_work_item_states'),
                         ('lab', 'own_work_item_bases')))
     or exists (select 1 from pg_policy policy_row
                  join pg_class relation on relation.oid = policy_row.polrelid
                  join pg_namespace namespace on namespace.oid = relation.relnamespace
                 where (namespace.nspname in ('lab', 'pharmacy') and policy_row.polname like 'own\_work\_%')
                    or (namespace.nspname = 'ehr' and relation.relname = 'prescriptions'
                        and policy_row.polname like 'prescriptions\_own\_pharmacy\_%')) then
    raise exception using errcode = '55000', message = '0133: already applied';
  end if;
  -- c. Every column the new bodies and policies read or write, by name and
  -- type. The decision is an EXISTS over the absent columns (never null);
  -- the list only names them.
  with expected(schema_name, relation_name, column_names) as (values
         ('auth', 'accounts', array['id uuid', 'subject text']),
         ('ehr', 'order_routes', array['source_prescription_id uuid', 'state text',
           'respond_by timestamp with time zone']),
         ('ehr', 'prescriptions', array['id uuid', 'encounter_id uuid', 'patient_id uuid', 'facility_id uuid',
           'created_by uuid', 'created_by_membership_id uuid', 'status text', 'row_version bigint',
           'medication_code_system text', 'medication_code text', 'medication_display text',
           'dose_quantity numeric(12,4)', 'dose_unit text', 'route_code text', 'frequency text', 'instructions text',
           'starts_on date', 'ends_on date', 'created_at timestamp with time zone']),
         ('identity', 'consent_directive_versions', array['directive_id uuid', 'version_no integer', 'status text',
           'provision_type text', 'starts_at timestamp with time zone', 'expires_at timestamp with time zone',
           'facility_id uuid', 'actions text[]', 'purposes text[]', 'grantee_type text', 'grantee_id uuid']),
         ('identity', 'consent_directives', array['id uuid', 'patient_id uuid', 'current_version integer']),
         ('identity', 'patients', array['id uuid', 'status text', 'full_name text', 'gender text', 'dob date',
           'hid_code text']),
         ('identity', 'staff_facility_memberships', array['id uuid', 'account_id uuid', 'organization_id uuid',
           'staff_id uuid', 'facility_id uuid', 'active boolean']),
         ('lab', 'work_items', array['id uuid', 'patient_id uuid', 'facility_id uuid', 'order_route_id uuid']),
         ('lab', 'work_item_events', array['work_item_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'work_item_requested_tests', array['work_item_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'accessions', array['id uuid', 'work_item_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'accession_events', array['work_item_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'specimen_requirements', array['accession_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'specimens', array['id uuid', 'accession_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'specimen_events', array['accession_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'specimen_command_idempotency', array['specimen_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'test_executions', array['id uuid', 'accession_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'execution_events', array['execution_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'results', array['id uuid', 'execution_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'result_revisions', array['execution_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'result_events', array['execution_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'result_verifications', array['execution_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'result_releases', array['execution_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('lab', 'result_invalidations', array['execution_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('pharmacy', 'work_items', array['id uuid', 'patient_id uuid', 'facility_id uuid',
           'ordering_facility_id uuid', 'source_ehr_prescription_id uuid', 'source_ehr_prescription_version bigint',
           'source_encounter_id uuid', 'source_status text', 'medication_code_system text', 'medication_code text',
           'medication_display text', 'dose_quantity numeric(12,4)', 'dose_unit text', 'route_code text',
           'frequency text', 'instructions text', 'starts_on date', 'ends_on date', 'prescribed_by uuid',
           'prescribed_at timestamp with time zone', 'accepted_by uuid', 'accepted_by_membership_id uuid',
           'acceptance_reason text', 'idempotency_key text', 'request_sha256 character(64)', 'correlation_id text',
           'order_route_id uuid']),
         ('pharmacy', 'work_item_events', array['work_item_id uuid', 'patient_id uuid', 'facility_id uuid',
           'event_version integer', 'event_type text', 'actor_id uuid', 'actor_membership_id uuid', 'reason text',
           'correlation_id text']),
         ('pharmacy', 'dispensings', array['id uuid', 'work_item_id uuid', 'patient_id uuid', 'facility_id uuid']),
         ('pharmacy', 'dispensing_reversals', array['id uuid', 'work_item_id uuid', 'patient_id uuid',
           'facility_id uuid']),
         ('pharmacy', 'outbox_events', array['event_type text', 'aggregate_type text', 'aggregate_id uuid',
           'aggregate_version bigint', 'facility_id uuid', 'patient_id uuid', 'correlation_id text', 'payload jsonb'])),
       absent as (
         select expected.schema_name, expected.relation_name, wanted.column_name
           from expected cross join unnest(expected.column_names) wanted(column_name)
          where not exists (
            select 1 from pg_attribute attribute_row
              join pg_class relation on relation.oid = attribute_row.attrelid
              join pg_namespace namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = expected.schema_name and relation.relname = expected.relation_name
               and relation.relkind = 'r' and attribute_row.attnum > 0 and not attribute_row.attisdropped
               and attribute_row.attname || ' ' || format_type(attribute_row.atttypid, attribute_row.atttypmod)
                   = wanted.column_name))
  select exists (select 1 from absent),
         (select string_agg(format('%s.%s.%s', absent.schema_name, absent.relation_name, absent.column_name), '; ')
            from absent)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0133: a column this migration relies on is missing or of another type: %s', missing);
  end if;
  -- d. The bodies replaced and relied on (md5 of pg_proc.prosrc). A function
  -- missing at its signature counts as a mismatch.
  with expected(schema_name, proc_name, argument_types, digest) as (values
         -- Replaced: 0086's work items' policies, 0124's cards.
         ('lab', 'work_item_allows', 'uuid, uuid, uuid, text', 'b710e0c6b66ce87c8c4a059ad435b774'),
         ('pharmacy', 'work_item_allows', 'uuid, uuid, uuid, text', 'b710e0c6b66ce87c8c4a059ad435b774'),
         ('lab', 'work_item_patient_cards', 'uuid[]', '69b1836bb8d9493bdc0d6d7cc5e96515'),
         ('pharmacy', 'work_item_patient_cards', 'uuid[]', '5a944e144033d04f86771a33ef41247b'),
         -- Relied on.
         ('identity', 'has_active_consent_grant', 'uuid, text, uuid, uuid, text, text, timestamp with time zone',
           '732d11892dd4e27e1ff9093ae3b7de5a'),
         ('identity', 'has_active_membership', 'text, uuid, uuid', 'bb52953ef1cd08527db61230a671859e'),
         ('auth', 'membership_has_permission', 'text, uuid, uuid, text', '65e3eaff93fe729fd5c5b986b80c9dd6'),
         ('lab', 'context_allows', 'uuid, uuid, text', '57e689661a6227e34d3bde9562468951'),
         ('pharmacy', 'context_allows', 'uuid, uuid, text', '958a6e5cd2a534d158c82fe399b8f381'),
         ('ehr', 'order_route_access_allows', 'text, uuid, uuid, text', '175eff453979c964889283a29bb8f34f'),
         ('ehr', 'order_route_allows', 'uuid, uuid, text', 'b80c2df6c380f7c7e20d166da94e56d2'),
         ('pharmacy', 'validate_work_item', '', 'e2411539ee8c95a02dad46c03e24db05'),
         ('pharmacy', 'validate_dispensing', '', '17f7e8897bd2ab240332e4d2c9f757b7'),
         ('platform', 'current_facility_id', '', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
         ('platform', 'current_account_id', '', 'b715ffe72856836d13ab16656fa6e94a'),
         ('platform', 'current_membership_id', '', '641989704fea95f885fbc38c6feb5aa5'),
         ('platform', 'current_actor_subject', '', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
         ('platform', 'current_purpose_of_use', '', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
         ('platform', 'current_correlation_id', '', '48d3bf187101d33bfda51dac829aa223')),
       differing as (
         select expected.*,
                (select string_agg(md5(proc.prosrc), ',') from pg_proc proc
                   join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where namespace.nspname = expected.schema_name and proc.proname = expected.proc_name
                    and pg_catalog.oidvectortypes(proc.proargtypes) = expected.argument_types) as found
           from expected
          where not exists (
            select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
             where namespace.nspname = expected.schema_name and proc.proname = expected.proc_name
               and pg_catalog.oidvectortypes(proc.proargtypes) = expected.argument_types
               and md5(proc.prosrc) = expected.digest))
  select exists (select 1 from differing),
         (select string_agg(format('%s.%s(%s) md5 %s', differing.schema_name, differing.proc_name,
                   differing.argument_types, coalesce(differing.found, 'none (missing)')), '; ') from differing)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0133: a function this migration replaces or relies on differs from 0001-0127: %s', missing);
  end if;
  -- e. One owner: pharmacy.work_items' owns every table this file locks,
  -- gives a policy or reads in a new body, the replaced functions and both
  -- validators.
  owner_oid := (select relation.relowner from pg_class relation
                  join pg_namespace namespace on namespace.oid = relation.relnamespace
                 where namespace.nspname = 'pharmacy' and relation.relname = 'work_items' and relation.relkind = 'r');
  with expected_tables(schema_name, relation_name) as (values
         ('ehr', 'prescriptions'), ('ehr', 'order_routes'), ('auth', 'accounts'), ('identity', 'patients'),
         ('identity', 'consent_directives'), ('identity', 'consent_directive_versions'),
         ('identity', 'staff_facility_memberships'), ('lab', 'work_items'), ('lab', 'work_item_events'),
         ('lab', 'work_item_requested_tests'), ('lab', 'accessions'), ('lab', 'accession_events'),
         ('lab', 'specimen_requirements'), ('lab', 'specimens'), ('lab', 'specimen_events'),
         ('lab', 'specimen_command_idempotency'), ('lab', 'test_executions'), ('lab', 'execution_events'),
         ('lab', 'results'), ('lab', 'result_revisions'), ('lab', 'result_events'), ('lab', 'result_verifications'),
         ('lab', 'result_releases'), ('lab', 'result_invalidations'), ('pharmacy', 'work_items'),
         ('pharmacy', 'work_item_events'), ('pharmacy', 'dispensings'), ('pharmacy', 'dispensing_reversals'),
         ('pharmacy', 'outbox_events')),
       expected_functions(schema_name, proc_name, argument_types) as (values
         ('lab', 'work_item_allows', 'uuid, uuid, uuid, text'), ('pharmacy', 'work_item_allows', 'uuid, uuid, uuid, text'),
         ('lab', 'work_item_patient_cards', 'uuid[]'), ('pharmacy', 'work_item_patient_cards', 'uuid[]'),
         ('pharmacy', 'validate_work_item', ''), ('pharmacy', 'validate_dispensing', '')),
       foreign_owned as (
         select format('%s.%s', expected_tables.schema_name, expected_tables.relation_name) as what
           from expected_tables
          where not exists (select 1 from pg_class relation
                              join pg_namespace namespace on namespace.oid = relation.relnamespace
                             where namespace.nspname = expected_tables.schema_name
                               and relation.relname = expected_tables.relation_name
                               and relation.relowner = owner_oid)
         union all
         select format('%s.%s(%s)', expected_functions.schema_name, expected_functions.proc_name,
                  expected_functions.argument_types)
           from expected_functions
          where not exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                             where namespace.nspname = expected_functions.schema_name
                               and proc.proname = expected_functions.proc_name
                               and pg_catalog.oidvectortypes(proc.proargtypes) = expected_functions.argument_types
                               and proc.proowner = owner_oid))
  select exists (select 1 from foreign_owned), (select string_agg(foreign_owned.what, ', ') from foreign_owned)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '42501',
      message = format('0133: these are not owned by %s, the owner of pharmacy.work_items: %s',
        coalesce(pg_get_userbyid(owner_oid), 'nobody'), missing);
  end if;
  -- f. The applier is that owner, or a member that inherits it and may SET
  -- ROLE to it; that owner may create in and use the schemas.
  if not (applier = owner_oid
          or (pg_has_role(applier, owner_oid, 'USAGE') and pg_has_role(applier, owner_oid, 'SET'))) then
    raise exception using errcode = '42501',
      message = format('0133: %s must own, or inherit from and be able to SET ROLE to, %s, the owner of '
        || 'pharmacy.work_items, ehr.prescriptions and the Lab and Pharmacy work tables', current_user,
        pg_get_userbyid(owner_oid));
  end if;
  with wanted(schema_name, privilege) as (values
         ('identity', 'CREATE'), ('lab', 'CREATE'), ('pharmacy', 'CREATE'), ('ehr', 'CREATE'),
         ('identity', 'USAGE'), ('lab', 'USAGE'), ('pharmacy', 'USAGE'), ('ehr', 'USAGE'), ('auth', 'USAGE'),
         ('platform', 'USAGE')),
       lacking as (
         select wanted.* from wanted
          where not exists (select 1 from pg_namespace namespace
                             where namespace.nspname = wanted.schema_name
                               and has_schema_privilege(owner_oid, namespace.oid, wanted.privilege)))
  select exists (select 1 from lacking),
         (select string_agg(format('%s on schema %s', lacking.privilege, lacking.schema_name), ', ') from lacking)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '42501',
      message = format('0133: %s lacks %s', pg_get_userbyid(owner_oid), missing);
  end if;
  -- g. D5's premise: no hid_ role other than the owner is a member of it.
  select exists (select 1 from pg_roles role_row
                  where role_row.rolname like 'hid\_%' and role_row.oid <> owner_oid
                    and pg_has_role(role_row.oid, owner_oid, 'MEMBER')),
         (select string_agg(role_row.rolname, ', ' order by role_row.rolname) from pg_roles role_row
           where role_row.rolname like 'hid\_%' and role_row.oid <> owner_oid
             and pg_has_role(role_row.oid, owner_oid, 'MEMBER'))
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0133: these roles are members of %s, which section 5''s ehr.prescriptions policies name: %s',
        pg_get_userbyid(owner_oid), missing);
  end if;
  -- The replaced functions' ACLs, for section 8.
  perform set_config('hid_0133.replaced_acls',
    (select string_agg(format('%s.%s(%s)=%s', namespace.nspname, proc.proname, pg_catalog.oidvectortypes(proc.proargtypes),
              coalesce(proc.proacl::text, 'default')), ';' order by namespace.nspname, proc.proname)
       from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
      where (namespace.nspname, proc.proname) in (('lab', 'work_item_allows'), ('pharmacy', 'work_item_allows'),
              ('lab', 'work_item_patient_cards'), ('pharmacy', 'work_item_patient_cards'))), true);
  raise notice '0133: preconditions checked; applier %; owner %', current_user, pg_get_userbyid(owner_oid);
end
$$;

-- 1. Locks (see Locks), NOWAIT, at most 5 s. A failed attempt's
-- subtransaction releases what it took.
do $$
declare
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.prescriptions, lab.work_item_events, lab.work_item_requested_tests, lab.accessions,
        lab.accession_events, lab.specimen_requirements, lab.specimens, lab.specimen_events,
        lab.specimen_command_idempotency, lab.test_executions, lab.execution_events, lab.results,
        lab.result_revisions, lab.result_events, lab.result_verifications, lab.result_releases,
        lab.result_invalidations, pharmacy.work_item_events, pharmacy.dispensings, pharmacy.dispensing_reversals,
        pharmacy.outbox_events
        in access exclusive mode nowait;
      lock table lab.work_items, pharmacy.work_items, identity.patients, identity.consent_directives,
        identity.consent_directive_versions, identity.staff_facility_memberships
        in access share mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0133: ehr.prescriptions or a Lab or Pharmacy work table stayed busy for 5 seconds; nothing '
            || 'applied; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$$;

-- 2. Act as the owner for the rest of this transaction (a no-op when the
-- applier is the owner, as on every database built by one migration login).
do $$
declare
  owner_name text := (select pg_get_userbyid(relation.relowner) from pg_class relation
                       where relation.oid = 'pharmacy.work_items'::regclass);
begin
  if owner_name <> current_user then
    execute format('set local role %I', owner_name);
  end if;
end
$$;

-- 3. D1.
create function identity.facility_work_member_allows(work_kind text, row_patient_id uuid, row_facility_id uuid,
  requested_action text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(work_kind in ('pharmacy', 'lab'), false)
    and coalesce(requested_action in ('read_records', 'write_records'), false)
    and row_patient_id is not null
    and row_facility_id is not null
    and row_facility_id = platform.current_facility_id()
    and platform.current_purpose_of_use() = 'direct-care'
    and coalesce(auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
          row_facility_id, work_kind || '.work-item.read'), false)
    and coalesce(auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
          row_facility_id, work_kind || '.order-route.receive'), false)
    and exists (select 1 from identity.patients patient
                 where patient.id = row_patient_id and patient.status = 'active')
    and not exists (
      select 1
        from identity.consent_directives directive
        join identity.consent_directive_versions directive_version
          on directive_version.directive_id = directive.id
         and directive_version.version_no = directive.current_version
        join identity.staff_facility_memberships membership
          on membership.id = platform.current_membership_id()
         and membership.facility_id = row_facility_id
       where directive.patient_id = row_patient_id
         and directive_version.status = 'active'
         and directive_version.provision_type = 'deny'
         and directive_version.starts_at <= clock_timestamp()
         and (directive_version.expires_at is null or directive_version.expires_at > clock_timestamp())
         and (directive_version.facility_id is null or directive_version.facility_id = row_facility_id)
         and (cardinality(directive_version.actions) = 0 or requested_action = any(directive_version.actions))
         and (cardinality(directive_version.purposes) = 0 or 'direct-care' = any(directive_version.purposes))
         and (directive_version.grantee_type = 'all'
           or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = row_facility_id)
           or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = membership.organization_id)
           or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = membership.staff_id)))
$$;

-- D2. The work items' policies: 0086's text plus the own-work branch.
create or replace function lab.work_item_allows(row_patient_id uuid, row_facility_id uuid, row_route_id uuid,
  requested_action text)
returns boolean
language sql stable security definer
set search_path = lab, identity, platform, pg_temp
as $$
  select row_facility_id = platform.current_facility_id()
    and (identity.has_active_consent_grant(row_patient_id, platform.current_actor_subject(),
          platform.current_membership_id(), row_facility_id, requested_action, platform.current_purpose_of_use())
      or (row_route_id is not null and ehr.order_route_allows(row_route_id, row_facility_id, requested_action))
      or (row_route_id is null and requested_action = 'read_records'
          and identity.facility_work_member_allows('lab', row_patient_id, row_facility_id, requested_action)))
$$;

create or replace function pharmacy.work_item_allows(row_patient_id uuid, row_facility_id uuid, row_route_id uuid,
  requested_action text)
returns boolean
language sql stable security definer
set search_path = pharmacy, identity, platform, pg_temp
as $$
  select row_facility_id = platform.current_facility_id()
    and (identity.has_active_consent_grant(row_patient_id, platform.current_actor_subject(),
          platform.current_membership_id(), row_facility_id, requested_action, platform.current_purpose_of_use())
      or (row_route_id is not null and ehr.order_route_allows(row_route_id, row_facility_id, requested_action))
      or (row_route_id is null and requested_action = 'read_records'
          and identity.facility_work_member_allows('pharmacy', row_patient_id, row_facility_id, requested_action)))
$$;

-- D4. 0124's cards: its text plus the own-work branch.
create or replace function lab.work_item_patient_cards(requested_work_item_ids uuid[])
returns table (
  work_item_id uuid,
  patient_full_name text,
  patient_sex text,
  patient_date_of_birth date,
  patient_health_id_last4 text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
begin
  if requested_work_item_ids is null or cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'WORK_ITEM_PATIENT_CARDS_INVALID';
  end if;
  if session_facility is null
     or not coalesce(auth.membership_has_permission(platform.current_actor_subject(),
          platform.current_membership_id(), session_facility, 'lab.work-item.read'), false) then
    return;
  end if;
  return query
    select item.id, patient.full_name, patient.gender, patient.dob, right(patient.hid_code, 4)
      from lab.work_items item
      join identity.patients patient on patient.id = item.patient_id
     where item.id = any(requested_work_item_ids)
       and item.order_route_id is null
       and item.facility_id = session_facility
       and (identity.has_active_consent_grant(item.patient_id, platform.current_actor_subject(),
              platform.current_membership_id(), item.facility_id, 'read_records', platform.current_purpose_of_use())
         or identity.facility_work_member_allows('lab', item.patient_id, item.facility_id, 'read_records'))
     order by item.id;
end;
$$;

create or replace function pharmacy.work_item_patient_cards(requested_work_item_ids uuid[])
returns table (
  work_item_id uuid,
  patient_full_name text,
  patient_sex text,
  patient_date_of_birth date,
  patient_health_id_last4 text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
begin
  if requested_work_item_ids is null or cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'WORK_ITEM_PATIENT_CARDS_INVALID';
  end if;
  if session_facility is null
     or not coalesce(auth.membership_has_permission(platform.current_actor_subject(),
          platform.current_membership_id(), session_facility, 'pharmacy.work-item.read'), false) then
    return;
  end if;
  return query
    select item.id, patient.full_name, patient.gender, patient.dob, right(patient.hid_code, 4)
      from pharmacy.work_items item
      join identity.patients patient on patient.id = item.patient_id
     where item.id = any(requested_work_item_ids)
       and item.order_route_id is null
       and item.facility_id = session_facility
       and (identity.has_active_consent_grant(item.patient_id, platform.current_actor_subject(),
              platform.current_membership_id(), item.facility_id, 'read_records', platform.current_purpose_of_use())
         or identity.facility_work_member_allows('pharmacy', item.patient_id, item.facility_id, 'read_records'))
     order by item.id;
end;
$$;

-- 4. D3. The work chain, item by item. D1 first (it refuses everyone but
-- the facility's own lab or pharmacy staff before any table is read), then
-- the row's own work item: own (no route), of the row's patient, at the
-- row's facility. Under forced row-level security the owner reads each
-- table on the way up under that table's policies, so a row the session may
-- not see answers false.
create function lab.own_work_chain_allows(anchor_kind text, anchor_id uuid, row_patient_id uuid,
  row_facility_id uuid, requested_action text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(anchor_kind in ('work_item', 'accession', 'specimen', 'execution'), false)
    and anchor_id is not null
    and identity.facility_work_member_allows('lab', row_patient_id, row_facility_id, requested_action)
    and exists (
      select 1
        from lab.work_items item
       where item.id = case anchor_kind
               when 'work_item' then anchor_id
               when 'accession' then (select accession.work_item_id from lab.accessions accession
                                       where accession.id = anchor_id)
               when 'specimen' then (select accession.work_item_id from lab.specimens specimen
                                       join lab.accessions accession on accession.id = specimen.accession_id
                                      where specimen.id = anchor_id)
               when 'execution' then (select accession.work_item_id from lab.test_executions execution
                                        join lab.accessions accession on accession.id = execution.accession_id
                                       where execution.id = anchor_id)
             end
         and item.order_route_id is null
         and item.patient_id = row_patient_id
         and item.facility_id = row_facility_id)
$$;

create function pharmacy.own_work_chain_allows(anchor_kind text, anchor_id uuid, row_patient_id uuid,
  row_facility_id uuid, requested_action text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(anchor_kind in ('work_item', 'dispensing', 'reversal'), false)
    and anchor_id is not null
    and identity.facility_work_member_allows('pharmacy', row_patient_id, row_facility_id, requested_action)
    and exists (
      select 1
        from pharmacy.work_items item
       where item.id = case anchor_kind
               when 'work_item' then anchor_id
               when 'dispensing' then (select dispensing.work_item_id from pharmacy.dispensings dispensing
                                        where dispensing.id = anchor_id)
               when 'reversal' then (select reversal.work_item_id from pharmacy.dispensing_reversals reversal
                                      where reversal.id = anchor_id)
             end
         and item.order_route_id is null
         and item.patient_id = row_patient_id
         and item.facility_id = row_facility_id)
$$;

-- Lab: rows keyed by their work item.
create policy own_work_read on lab.work_item_events for select
  using (lab.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.work_item_events for insert
  with check (lab.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on lab.work_item_requested_tests for select
  using (lab.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.work_item_requested_tests for insert
  with check (lab.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on lab.accessions for select
  using (lab.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.accessions for insert
  with check (lab.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on lab.accession_events for select
  using (lab.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.accession_events for insert
  with check (lab.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'write_records'));
-- Lab: rows keyed by their accession.
create policy own_work_read on lab.specimen_requirements for select
  using (lab.own_work_chain_allows('accession', accession_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.specimen_requirements for insert
  with check (lab.own_work_chain_allows('accession', accession_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on lab.specimens for select
  using (lab.own_work_chain_allows('accession', accession_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.specimens for insert
  with check (lab.own_work_chain_allows('accession', accession_id, patient_id, facility_id, 'write_records'));
create policy own_work_update on lab.specimens for update
  using (lab.own_work_chain_allows('accession', accession_id, patient_id, facility_id, 'write_records'))
  with check (lab.own_work_chain_allows('accession', accession_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on lab.specimen_events for select
  using (lab.own_work_chain_allows('accession', accession_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.specimen_events for insert
  with check (lab.own_work_chain_allows('accession', accession_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on lab.test_executions for select
  using (lab.own_work_chain_allows('accession', accession_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.test_executions for insert
  with check (lab.own_work_chain_allows('accession', accession_id, patient_id, facility_id, 'write_records'));
create policy own_work_update on lab.test_executions for update
  using (lab.own_work_chain_allows('accession', accession_id, patient_id, facility_id, 'write_records'))
  with check (lab.own_work_chain_allows('accession', accession_id, patient_id, facility_id, 'write_records'));
-- Lab: a specimen command's key, read by writers only (as 0086's).
create policy own_work_read on lab.specimen_command_idempotency for select
  using (lab.own_work_chain_allows('specimen', specimen_id, patient_id, facility_id, 'write_records'));
create policy own_work_insert on lab.specimen_command_idempotency for insert
  with check (lab.own_work_chain_allows('specimen', specimen_id, patient_id, facility_id, 'write_records'));
-- Lab: rows keyed by their execution.
create policy own_work_read on lab.execution_events for select
  using (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.execution_events for insert
  with check (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on lab.results for select
  using (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.results for insert
  with check (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'write_records'));
create policy own_work_update on lab.results for update
  using (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'write_records'))
  with check (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on lab.result_revisions for select
  using (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.result_revisions for insert
  with check (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on lab.result_events for select
  using (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.result_events for insert
  with check (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on lab.result_verifications for select
  using (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.result_verifications for insert
  with check (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on lab.result_releases for select
  using (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.result_releases for insert
  with check (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on lab.result_invalidations for select
  using (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on lab.result_invalidations for insert
  with check (lab.own_work_chain_allows('execution', execution_id, patient_id, facility_id, 'write_records'));
-- Pharmacy: rows keyed by their work item.
create policy own_work_read on pharmacy.work_item_events for select
  using (pharmacy.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on pharmacy.work_item_events for insert
  with check (pharmacy.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on pharmacy.dispensings for select
  using (pharmacy.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on pharmacy.dispensings for insert
  with check (pharmacy.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'write_records'));
create policy own_work_read on pharmacy.dispensing_reversals for select
  using (pharmacy.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'read_records'));
create policy own_work_insert on pharmacy.dispensing_reversals for insert
  with check (pharmacy.own_work_chain_allows('work_item', work_item_id, patient_id, facility_id, 'write_records'));
-- Pharmacy: the events pharmacy-api writes about a work item, a dispensing
-- or a reversal (insert only; nobody but the event delivery reads them).
create policy own_work_insert on pharmacy.outbox_events for insert
  with check (pharmacy.own_work_chain_allows(
    case aggregate_type
      when 'pharmacy-work-item' then 'work_item'
      when 'medication-dispensing' then 'dispensing'
      when 'medication-dispensing-reversal' then 'reversal'
    end, aggregate_id, patient_id, facility_id, 'write_records'));

-- 5. D6. The sends.
create table pharmacy.own_prescription_sends (
  prescription_id uuid primary key,
  prescription_version bigint not null check (prescription_version > 0),
  patient_id uuid not null,
  facility_id uuid not null,
  encounter_id uuid not null,
  sent_by_account_id uuid not null,
  sent_by_membership_id uuid not null,
  state text not null default 'pending' check (state in ('pending', 'sent')),
  work_item_id uuid unique,
  attempts integer not null default 0 check (attempts between 0 and 1000),
  last_failure_sqlstate text check (last_failure_sqlstate is null or last_failure_sqlstate ~ '^[0-9A-Z]{5}$'),
  created_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  withdrawn_at timestamptz,
  check ((state = 'sent') = (work_item_id is not null and sent_at is not null)),
  check (withdrawn_at is null or state = 'sent')
);
create index own_prescription_sends_facility_idx on pharmacy.own_prescription_sends (facility_id, state, created_at);
alter table pharmacy.own_prescription_sends enable row level security;
revoke all on pharmacy.own_prescription_sends from public;

-- D5. The source prescription of an own pharmacy work item the session may
-- work on (the owner's policies on ehr.prescriptions call it).
create function pharmacy.own_work_source_prescription(row_prescription_id uuid, row_patient_id uuid,
  row_facility_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select identity.facility_work_member_allows('pharmacy', row_patient_id, row_facility_id, 'read_records')
    and exists (select 1 from pharmacy.work_items item
                 where item.source_ehr_prescription_id = row_prescription_id
                   and item.patient_id = row_patient_id
                   and item.facility_id = row_facility_id
                   and item.order_route_id is null)
$$;

do $$
declare
  validator_owner text := (select pg_get_userbyid(proc.proowner) from pg_proc proc
                            where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure);
begin
  execute format('create policy prescriptions_own_pharmacy_source_read on ehr.prescriptions for select to %I '
    || 'using (pharmacy.own_work_source_prescription(id, patient_id, facility_id))', validator_owner);
  execute format('create policy prescriptions_own_pharmacy_source_lock on ehr.prescriptions for update to %I '
    || 'using (pharmacy.own_work_source_prescription(id, patient_id, facility_id)) with check (false)',
    validator_owner);
end
$$;

-- 6. D7. The send.
create function ehr.send_prescription_to_own_pharmacy(requested_prescription_id uuid, requested_version bigint)
returns table (outcome text, work_item_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
  session_account uuid := platform.current_account_id();
  session_membership uuid := platform.current_membership_id();
  session_subject text := platform.current_actor_subject();
  session_correlation text := platform.current_correlation_id();
  fixed_reason constant text := 'Sent automatically when the prescription was activated';
  source ehr.prescriptions%rowtype;
  existing_item uuid;
  send_row pharmacy.own_prescription_sends%rowtype;
  created pharmacy.work_items%rowtype;
  failure_state text;
begin
  if requested_prescription_id is null or requested_version is null or requested_version < 1 then
    raise exception using errcode = '22023', message = 'OWN_PHARMACY_SEND_INVALID';
  end if;
  if session_facility is null or session_account is null or session_membership is null or session_subject is null
     or platform.current_purpose_of_use() is distinct from 'direct-care'
     or not coalesce(auth.membership_has_permission(session_subject, session_membership, session_facility,
          'ehr.prescription.write'), false) then
    raise exception using errcode = '42501', message = 'OWN_PHARMACY_SEND_DENIED';
  end if;
  -- Read as the owner: under forced row-level security only a prescription
  -- the session may read is found.
  select prescription.* into source
    from ehr.prescriptions prescription
   where prescription.id = requested_prescription_id and prescription.facility_id = session_facility;
  if source.id is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if source.created_by is distinct from session_account
     or source.created_by_membership_id is distinct from session_membership then
    return query select 'not_prescriber'::text, null::uuid;
    return;
  end if;
  if source.status is distinct from 'active' then
    return query select 'not_active'::text, null::uuid;
    return;
  end if;
  if source.row_version is distinct from requested_version then
    return query select 'changed'::text, null::uuid;
    return;
  end if;
  if exists (select 1 from ehr.order_routes route
              where route.source_prescription_id = source.id
                and (route.state in ('accepted', 'completed')
                  or (route.state = 'sent' and clock_timestamp() < route.respond_by))) then
    return query select 'routed'::text, null::uuid;
    return;
  end if;
  select item.id into existing_item from pharmacy.work_items item where item.source_ehr_prescription_id = source.id;
  if existing_item is not null then
    return query select 'already_in_pharmacy'::text, existing_item;
    return;
  end if;
  if not exists (
    select 1
      from identity.staff_facility_memberships membership
      join auth.accounts account on account.id = membership.account_id
     where membership.facility_id = session_facility
       and membership.active
       and coalesce(auth.membership_has_permission(account.subject, membership.id, session_facility,
             'pharmacy.work-item.read'), false)
       and coalesce(auth.membership_has_permission(account.subject, membership.id, session_facility,
             'pharmacy.order-route.receive'), false)) then
    return query select 'no_pharmacy'::text, null::uuid;
    return;
  end if;
  insert into pharmacy.own_prescription_sends (prescription_id, prescription_version, patient_id, facility_id,
    encounter_id, sent_by_account_id, sent_by_membership_id)
  values (source.id, source.row_version, source.patient_id, source.facility_id, source.encounter_id, session_account,
    session_membership)
  on conflict (prescription_id) do nothing;
  select send.* into send_row from pharmacy.own_prescription_sends send
   where send.prescription_id = source.id for update;
  if send_row.state = 'sent' then
    return query select 'already_in_pharmacy'::text, send_row.work_item_id;
    return;
  end if;
  begin
    insert into pharmacy.work_items (patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
      source_ehr_prescription_version, source_encounter_id, source_status, medication_code_system, medication_code,
      medication_display, dose_quantity, dose_unit, route_code, frequency, instructions, starts_on, ends_on,
      prescribed_by, prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason, idempotency_key,
      request_sha256, correlation_id)
    values (source.patient_id, source.facility_id, source.facility_id, source.id, source.row_version,
      source.encounter_id, 'active', source.medication_code_system, source.medication_code, source.medication_display,
      source.dose_quantity, source.dose_unit, source.route_code, source.frequency, source.instructions,
      source.starts_on, source.ends_on, source.created_by, source.created_at, session_account, session_membership,
      fixed_reason, 'own-pharmacy-send:' || source.id::text,
      encode(sha256(convert_to('own-pharmacy-send:' || source.id::text || ':' || source.row_version::text, 'UTF8')),
        'hex'),
      session_correlation)
    returning * into created;
    insert into pharmacy.work_item_events (work_item_id, patient_id, facility_id, event_version, event_type, actor_id,
      actor_membership_id, reason, correlation_id)
    values (created.id, created.patient_id, created.facility_id, 1, 'prescription_accepted', session_account,
      session_membership, fixed_reason, session_correlation);
    -- pharmacy-api's own payload for this event (PharmacyService.accept),
    -- the only keys the event dispatcher's Pharmacy contract admits.
    insert into pharmacy.outbox_events (event_type, aggregate_type, aggregate_id, aggregate_version, facility_id,
      patient_id, correlation_id, payload)
    values ('PharmacyWorkItemCreated', 'pharmacy-work-item', created.id, 1, created.facility_id, created.patient_id,
      session_correlation, jsonb_build_object('workItemId', created.id,
        'sourceEhrPrescriptionId', created.source_ehr_prescription_id,
        'sourceEhrPrescriptionVersion', created.source_ehr_prescription_version, 'status', 'accepted'));
    update pharmacy.own_prescription_sends send
       set state = 'sent', work_item_id = created.id, sent_at = clock_timestamp(),
           prescription_version = source.row_version, attempts = least(send.attempts + 1, 1000),
           last_failure_sqlstate = null
     where send.prescription_id = source.id;
  exception
    when serialization_failure or deadlock_detected then
      raise;
    when others then
      get stacked diagnostics failure_state = returned_sqlstate;
      update pharmacy.own_prescription_sends send
         set attempts = least(send.attempts + 1, 1000), prescription_version = source.row_version,
             last_failure_sqlstate = case when failure_state ~ '^[0-9A-Z]{5}$' then failure_state end
       where send.prescription_id = source.id;
      return query select 'pending'::text, null::uuid;
      return;
  end;
  return query select 'sent'::text, created.id;
end;
$$;

-- D8. The withdrawal.
create function ehr.withdraw_own_pharmacy_send(requested_prescription_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
  session_membership uuid := platform.current_membership_id();
  session_subject text := platform.current_actor_subject();
  source_status text;
  marked integer;
begin
  if requested_prescription_id is null then
    raise exception using errcode = '22023', message = 'OWN_PHARMACY_SEND_INVALID';
  end if;
  if session_facility is null or session_membership is null or session_subject is null
     or platform.current_purpose_of_use() is distinct from 'direct-care'
     or not coalesce(auth.membership_has_permission(session_subject, session_membership, session_facility,
          'ehr.prescription.write'), false) then
    raise exception using errcode = '42501', message = 'OWN_PHARMACY_SEND_DENIED';
  end if;
  select prescription.status into source_status
    from ehr.prescriptions prescription
   where prescription.id = requested_prescription_id and prescription.facility_id = session_facility;
  if source_status is null or source_status not in ('on_hold', 'cancelled', 'entered_in_error') then
    return false;
  end if;
  update pharmacy.own_prescription_sends send
     set withdrawn_at = clock_timestamp()
   where send.prescription_id = requested_prescription_id
     and send.facility_id = session_facility
     and send.state = 'sent'
     and send.withdrawn_at is null;
  get diagnostics marked = row_count;
  return marked > 0;
end;
$$;

-- D9. The own work item a Pharmacy or Lab resource belongs to.
create function pharmacy.own_work_access_for(requested_resource_type text, requested_resource_id uuid,
  requested_action text)
returns table (work_item_id uuid)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  item record;
begin
  if not coalesce(requested_resource_type in ('work_item', 'dispensing'), false)
     or not coalesce(requested_action in ('read_records', 'write_records'), false)
     or requested_resource_id is null then
    raise exception using errcode = '22023', message = 'OWN_WORK_ACCESS_INVALID';
  end if;
  if requested_resource_type = 'work_item' then
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from pharmacy.work_items candidate where candidate.id = requested_resource_id;
  else
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from pharmacy.dispensings dispensing
      join pharmacy.work_items candidate on candidate.id = dispensing.work_item_id
     where dispensing.id = requested_resource_id;
  end if;
  if item.id is null or item.order_route_id is not null
     or not identity.facility_work_member_allows('pharmacy', item.patient_id, item.facility_id, requested_action) then
    return;
  end if;
  return query select item.id;
end;
$$;

create function lab.own_work_access_for(requested_resource_type text, requested_resource_id uuid,
  requested_action text)
returns table (work_item_id uuid)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  item record;
begin
  if not coalesce(requested_resource_type in ('work_item', 'accession', 'specimen', 'execution', 'result'), false)
     or not coalesce(requested_action in ('read_records', 'write_records'), false)
     or requested_resource_id is null then
    raise exception using errcode = '22023', message = 'OWN_WORK_ACCESS_INVALID';
  end if;
  if requested_resource_type = 'work_item' then
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from lab.work_items candidate where candidate.id = requested_resource_id;
  elsif requested_resource_type = 'accession' then
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from lab.accessions accession
      join lab.work_items candidate on candidate.id = accession.work_item_id
     where accession.id = requested_resource_id;
  elsif requested_resource_type = 'specimen' then
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from lab.specimens specimen
      join lab.accessions accession on accession.id = specimen.accession_id
      join lab.work_items candidate on candidate.id = accession.work_item_id
     where specimen.id = requested_resource_id;
  elsif requested_resource_type = 'execution' then
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from lab.test_executions execution
      join lab.accessions accession on accession.id = execution.accession_id
      join lab.work_items candidate on candidate.id = accession.work_item_id
     where execution.id = requested_resource_id;
  else
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from lab.results result_row
      join lab.test_executions execution on execution.id = result_row.execution_id
      join lab.accessions accession on accession.id = execution.accession_id
      join lab.work_items candidate on candidate.id = accession.work_item_id
     where result_row.id = requested_resource_id;
  end if;
  if item.id is null or item.order_route_id is not null
     or not identity.facility_work_member_allows('lab', item.patient_id, item.facility_id, requested_action) then
    return;
  end if;
  return query select item.id;
end;
$$;

-- D10. Why the session sees each own work item, for the work list's audit rows.
create function pharmacy.own_work_item_states(requested_work_item_ids uuid[])
returns table (work_item_id uuid, basis text, withdrawn boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
begin
  if requested_work_item_ids is null or cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'OWN_WORK_ITEM_STATES_INVALID';
  end if;
  if session_facility is null then
    return;
  end if;
  return query
    select decided.id, decided.basis,
           exists (select 1 from pharmacy.own_prescription_sends send
                    where send.work_item_id = decided.id and send.withdrawn_at is not null)
      from (
        select item.id,
               case
                 when identity.has_active_consent_grant(item.patient_id, platform.current_actor_subject(),
                        platform.current_membership_id(), item.facility_id, 'read_records',
                        platform.current_purpose_of_use()) then 'consent'
                 when identity.facility_work_member_allows('pharmacy', item.patient_id, item.facility_id,
                        'read_records') then 'own-work'
               end as basis
          from pharmacy.work_items item
         where item.id = any(requested_work_item_ids)
           and item.order_route_id is null
           and item.facility_id = session_facility) decided
     where decided.basis is not null
     order by decided.id;
end;
$$;

create function lab.own_work_item_bases(requested_work_item_ids uuid[])
returns table (work_item_id uuid, basis text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
begin
  if requested_work_item_ids is null or cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'OWN_WORK_ITEM_STATES_INVALID';
  end if;
  if session_facility is null then
    return;
  end if;
  return query
    select decided.id, decided.basis
      from (
        select item.id,
               case
                 when identity.has_active_consent_grant(item.patient_id, platform.current_actor_subject(),
                        platform.current_membership_id(), item.facility_id, 'read_records',
                        platform.current_purpose_of_use()) then 'consent'
                 when identity.facility_work_member_allows('lab', item.patient_id, item.facility_id,
                        'read_records') then 'own-work'
               end as basis
          from lab.work_items item
         where item.id = any(requested_work_item_ids)
           and item.order_route_id is null
           and item.facility_id = session_facility) decided
     where decided.basis is not null
     order by decided.id;
end;
$$;

-- 7. Grants (D11; here and in runtime-grants.sql) and comments.
revoke all on function identity.facility_work_member_allows(text, uuid, uuid, text),
  lab.own_work_chain_allows(text, uuid, uuid, uuid, text),
  pharmacy.own_work_chain_allows(text, uuid, uuid, uuid, text),
  pharmacy.own_work_source_prescription(uuid, uuid, uuid),
  ehr.send_prescription_to_own_pharmacy(uuid, bigint),
  ehr.withdraw_own_pharmacy_send(uuid),
  pharmacy.own_work_access_for(text, uuid, text),
  lab.own_work_access_for(text, uuid, text),
  pharmacy.own_work_item_states(uuid[]),
  lab.own_work_item_bases(uuid[]) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.send_prescription_to_own_pharmacy(uuid, bigint),
      ehr.withdraw_own_pharmacy_send(uuid) to hid_ehr_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_pharmacy_runtime') then
    grant execute on function pharmacy.own_work_chain_allows(text, uuid, uuid, uuid, text),
      pharmacy.own_work_access_for(text, uuid, text), pharmacy.own_work_item_states(uuid[]) to hid_pharmacy_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_lab_runtime') then
    grant execute on function lab.own_work_chain_allows(text, uuid, uuid, uuid, text),
      lab.own_work_access_for(text, uuid, text), lab.own_work_item_bases(uuid[]) to hid_lab_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function lab.own_work_chain_allows(text, uuid, uuid, uuid, text),
      pharmacy.own_work_chain_allows(text, uuid, uuid, uuid, text),
      ehr.send_prescription_to_own_pharmacy(uuid, bigint), ehr.withdraw_own_pharmacy_send(uuid),
      pharmacy.own_work_access_for(text, uuid, text), pharmacy.own_work_item_states(uuid[]),
      lab.own_work_access_for(text, uuid, text), lab.own_work_item_bases(uuid[]) to hid_schema_test_runtime;
  end if;
end
$$;

comment on function identity.facility_work_member_allows(text, uuid, uuid, text) is
  '0133 D1: the session works for this facility''s pharmacy or laboratory (direct care, <kind>.work-item.read and <kind>.order-route.receive here), the patient is active and no deny directive covers the member. Called by the work items'' read policies, the chain functions and the cards; no runtime role executes it.';
comment on function lab.work_item_allows(uuid, uuid, uuid, text) is
  '0086 H8 with 0133 D2: this facility''s row and the member''s consent, the row''s order route, or (own work, no route, reads only) the facility''s lab staff (identity.facility_work_member_allows).';
comment on function pharmacy.work_item_allows(uuid, uuid, uuid, text) is
  '0086 H8 with 0133 D2: this facility''s row and the member''s consent, the row''s order route, or (own work, no route, reads only) the facility''s pharmacy staff (identity.facility_work_member_allows).';
comment on function lab.own_work_chain_allows(text, uuid, uuid, uuid, text) is
  '0133 D3: the facility''s lab staff (identity.facility_work_member_allows) and a row of an own Lab work item (no order route) of that patient at that facility, found from the row''s work item, accession, specimen or execution. The own_work_* policies of the Lab work chain call it; never the imported evidence.';
comment on function pharmacy.own_work_chain_allows(text, uuid, uuid, uuid, text) is
  '0133 D3: the facility''s pharmacy staff (identity.facility_work_member_allows) and a row of an own Pharmacy work item (no order route) of that patient at that facility, found from the row''s work item, dispensing or reversal. The own_work_* policies of the Pharmacy work chain call it; never the imported evidence.';
comment on function lab.work_item_patient_cards(uuid[]) is
  'The patient (name, sex, date of birth, last 4 of the Health ID) of each given work item that is this facility''s own work (no order route) and that the session''s member may read: lab.work-item.read here and the read consent test of the work items'' read policy (emergency included), or (0133) the facility''s lab staff. At most 200 ids.';
comment on function pharmacy.work_item_patient_cards(uuid[]) is
  'The patient (name, sex, date of birth, last 4 of the Health ID) of each given work item that is this facility''s own work (no order route) and that the session''s member may read: pharmacy.work-item.read here and the read consent test of the work items'' read policy (emergency included), or (0133) the facility''s pharmacy staff. At most 200 ids.';
comment on table pharmacy.own_prescription_sends is
  '0133 D6: prescriptions sent by themselves to this facility''s own pharmacy when activated: who sent them (the prescriber), pending or sent with the work item, attempts and the last failure''s SQLSTATE, and when they were withdrawn. Only 0133''s functions read or write it.';
comment on function pharmacy.own_work_source_prescription(uuid, uuid, uuid) is
  '0133 D5: the prescription is the source of an own pharmacy work item the session works on as this facility''s pharmacy staff. Used by two ehr.prescriptions policies for the owner of pharmacy.validate_dispensing only.';
comment on function ehr.send_prescription_to_own_pharmacy(uuid, bigint) is
  '0133 D7: sends the prescriber''s active prescription to this facility''s own pharmacy (a work item accepted by the prescriber with the fixed reason), in the caller''s transaction; answers not_found, not_prescriber, not_active, changed, routed, already_in_pharmacy, no_pharmacy, sent or pending.';
comment on function ehr.withdraw_own_pharmacy_send(uuid) is
  '0133 D8: marks a sent prescription withdrawn once it is on hold, cancelled or entered in error.';
comment on function pharmacy.own_work_access_for(text, uuid, text) is
  '0133 D9: the own work item (no route) a work item or dispensing belongs to, when the session works for this facility''s pharmacy.';
comment on function lab.own_work_access_for(text, uuid, text) is
  '0133 D9: the own work item (no route) a work item, accession, specimen, execution or result belongs to, when the session works for this facility''s laboratory.';
comment on function pharmacy.own_work_item_states(uuid[]) is
  '0133 D10: for each own work item here the session may read, consent or own-work, and whether its send was withdrawn. At most 200 ids.';
comment on function lab.own_work_item_bases(uuid[]) is
  '0133 D10: for each own lab work item here the session may read, consent or own-work. At most 200 ids.';

-- 8. Post-checks.
do $$
declare
  found_absent boolean;
  mismatch text;
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass);
  validator_owner oid := (select proc.proowner from pg_proc proc
                           where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure);
  error_state text;
  error_message text;
begin
  -- The 14 new and replaced bodies (md5), owner, SECURITY DEFINER,
  -- volatility, language, not STRICT, search_path.
  with expected(schema_name, proc_name, argument_types, digest, volatility, language_name, config) as (values
         ('identity', 'facility_work_member_allows', 'text, uuid, uuid, text', '474875a22f8c5e7b46846f1ddb1d5046', 's',
           'sql', 'search_path=pg_catalog, pg_temp'),
         ('lab', 'work_item_allows', 'uuid, uuid, uuid, text', 'a194e2b4437efd5bb1db5e3bf482aa69', 's', 'sql',
           'search_path=lab, identity, platform, pg_temp'),
         ('pharmacy', 'work_item_allows', 'uuid, uuid, uuid, text', '2c2236b85397574aefc131ebca4196cc', 's', 'sql',
           'search_path=pharmacy, identity, platform, pg_temp'),
         ('lab', 'work_item_patient_cards', 'uuid[]', '91e157a7d6f89edd46c14dbb095d1bc6', 's', 'plpgsql',
           'search_path=pg_catalog, pg_temp'),
         ('pharmacy', 'work_item_patient_cards', 'uuid[]', '0dc38390c3c40a1883b87345ce0d35bd', 's', 'plpgsql',
           'search_path=pg_catalog, pg_temp'),
         ('lab', 'own_work_chain_allows', 'text, uuid, uuid, uuid, text', 'cd166869d06a2c9a9cddbb6a04292c00', 's', 'sql',
           'search_path=pg_catalog, pg_temp'),
         ('pharmacy', 'own_work_chain_allows', 'text, uuid, uuid, uuid, text', 'bef3a9a843481841f315b3af175f86d1', 's', 'sql',
           'search_path=pg_catalog, pg_temp'),
         ('pharmacy', 'own_work_source_prescription', 'uuid, uuid, uuid', '41a9afd4ea6f708425b98d1fb6e6eb87', 's', 'sql',
           'search_path=pg_catalog, pg_temp'),
         ('ehr', 'send_prescription_to_own_pharmacy', 'uuid, bigint', 'b97d8e5f79a384060f3558ed4b26bdaf', 'v', 'plpgsql',
           'search_path=pg_catalog, pg_temp'),
         ('ehr', 'withdraw_own_pharmacy_send', 'uuid', '0d6717beb1e28897e40e378a242042db', 'v', 'plpgsql',
           'search_path=pg_catalog, pg_temp'),
         ('pharmacy', 'own_work_access_for', 'text, uuid, text', 'bb03e692d187fe85783fed28cc40413c', 's', 'plpgsql',
           'search_path=pg_catalog, pg_temp'),
         ('lab', 'own_work_access_for', 'text, uuid, text', '89336895a7a4878211fc44c45197e454', 's', 'plpgsql',
           'search_path=pg_catalog, pg_temp'),
         ('pharmacy', 'own_work_item_states', 'uuid[]', '5882cbdcf5dcebb96b3cabb95bba9801', 's', 'plpgsql',
           'search_path=pg_catalog, pg_temp'),
         ('lab', 'own_work_item_bases', 'uuid[]', '07e31d7ca86ac31255ad096d56363637', 's', 'plpgsql',
           'search_path=pg_catalog, pg_temp')),
       differing as (
         select expected.*,
                (select string_agg(format('md5=%s owner=%s definer=%s volatile=%s strict=%s config=%s',
                          md5(proc.prosrc), pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
                          proc.proisstrict, proc.proconfig), ',')
                   from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where namespace.nspname = expected.schema_name and proc.proname = expected.proc_name) as found
           from expected
          where (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                  where namespace.nspname = expected.schema_name and proc.proname = expected.proc_name) <> 1
             or not exists (
               select 1 from pg_proc proc
                 join pg_namespace namespace on namespace.oid = proc.pronamespace
                 join pg_language language_row on language_row.oid = proc.prolang
                where namespace.nspname = expected.schema_name and proc.proname = expected.proc_name
                  and pg_catalog.oidvectortypes(proc.proargtypes) = expected.argument_types
                  and md5(proc.prosrc) = expected.digest and proc.proowner = owner_oid and proc.prosecdef
                  and proc.provolatile = expected.volatility::"char" and language_row.lanname = expected.language_name
                  and not proc.proisstrict and proc.proconfig = array[expected.config]))
  select exists (select 1 from differing),
         (select string_agg(format('%s.%s(%s): %s', differing.schema_name, differing.proc_name, differing.argument_types,
                   coalesce(differing.found, 'missing')), '; ') from differing)
    into found_absent, mismatch;
  if found_absent then
    raise exception using errcode = '55000', message = format('0133: functions are not as this file makes them: %s', mismatch);
  end if;
  -- The new functions' exact EXECUTE grants: each expected grantee that
  -- exists holds EXECUTE (not grantable); nothing else is granted, PUBLIC
  -- included. Decided by EXISTS, so a role that does not exist never makes a
  -- comparison null.
  with expected(schema_name, proc_name, grantee_name) as (values
         ('ehr', 'send_prescription_to_own_pharmacy', 'hid_ehr_runtime'),
         ('ehr', 'send_prescription_to_own_pharmacy', 'hid_schema_test_runtime'),
         ('ehr', 'withdraw_own_pharmacy_send', 'hid_ehr_runtime'),
         ('ehr', 'withdraw_own_pharmacy_send', 'hid_schema_test_runtime'),
         ('lab', 'own_work_chain_allows', 'hid_lab_runtime'),
         ('lab', 'own_work_chain_allows', 'hid_schema_test_runtime'),
         ('lab', 'own_work_access_for', 'hid_lab_runtime'),
         ('lab', 'own_work_access_for', 'hid_schema_test_runtime'),
         ('lab', 'own_work_item_bases', 'hid_lab_runtime'),
         ('lab', 'own_work_item_bases', 'hid_schema_test_runtime'),
         ('pharmacy', 'own_work_chain_allows', 'hid_pharmacy_runtime'),
         ('pharmacy', 'own_work_chain_allows', 'hid_schema_test_runtime'),
         ('pharmacy', 'own_work_access_for', 'hid_pharmacy_runtime'),
         ('pharmacy', 'own_work_access_for', 'hid_schema_test_runtime'),
         ('pharmacy', 'own_work_item_states', 'hid_pharmacy_runtime'),
         ('pharmacy', 'own_work_item_states', 'hid_schema_test_runtime')),
       new_functions as (
         select proc.oid, namespace.nspname, proc.proname, proc.proowner, proc.proacl
           from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where (namespace.nspname, proc.proname) in (('identity', 'facility_work_member_allows'),
                  ('lab', 'own_work_chain_allows'), ('pharmacy', 'own_work_chain_allows'),
                  ('pharmacy', 'own_work_source_prescription'), ('ehr', 'send_prescription_to_own_pharmacy'),
                  ('ehr', 'withdraw_own_pharmacy_send'), ('pharmacy', 'own_work_access_for'),
                  ('lab', 'own_work_access_for'), ('pharmacy', 'own_work_item_states'), ('lab', 'own_work_item_bases'))),
       granted as (
         select new_functions.nspname, new_functions.proname, privilege.grantee, privilege.privilege_type,
                privilege.is_grantable
           from new_functions
          cross join aclexplode(coalesce(new_functions.proacl, acldefault('f', new_functions.proowner))) privilege
          where privilege.grantee <> new_functions.proowner),
       wrong as (
         select format('%s.%s granted %s to %s', granted.nspname, granted.proname, granted.privilege_type,
                  case when granted.grantee = 0 then 'PUBLIC' else pg_get_userbyid(granted.grantee)::text end) as what
           from granted
          where not exists (select 1 from expected join pg_roles role_row on role_row.rolname = expected.grantee_name
                             where expected.schema_name = granted.nspname and expected.proc_name = granted.proname
                               and role_row.oid = granted.grantee and granted.privilege_type = 'EXECUTE'
                               and not granted.is_grantable)
         union all
         select format('%s.%s lacks EXECUTE for %s', expected.schema_name, expected.proc_name, expected.grantee_name)
           from expected join pg_roles role_row on role_row.rolname = expected.grantee_name
          where not exists (select 1 from granted
                             where granted.nspname = expected.schema_name and granted.proname = expected.proc_name
                               and granted.grantee = role_row.oid and granted.privilege_type = 'EXECUTE'))
  select exists (select 1 from wrong), (select string_agg(wrong.what, '; ') from wrong)
    into found_absent, mismatch;
  if found_absent then
    raise exception using errcode = '55000', message = format('0133: the new functions'' grants are not section 7''s: %s',
      mismatch);
  end if;
  -- The replaced functions keep their ACLs.
  if (select string_agg(format('%s.%s(%s)=%s', namespace.nspname, proc.proname, pg_catalog.oidvectortypes(proc.proargtypes),
            coalesce(proc.proacl::text, 'default')), ';' order by namespace.nspname, proc.proname)
        from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
       where (namespace.nspname, proc.proname) in (('lab', 'work_item_allows'), ('pharmacy', 'work_item_allows'),
               ('lab', 'work_item_patient_cards'), ('pharmacy', 'work_item_patient_cards')))
     is distinct from nullif(current_setting('hid_0133.replaced_acls', true), '') then
    raise exception using errcode = '55000', message = '0133: a replaced function''s ACL changed';
  end if;
  -- The sends table: columns, keys, CHECKs, index, row-level security on and
  -- not forced, no policy, no grant.
  if ((select array_agg(attribute_row.attname::text || ':' || format_type(attribute_row.atttypid, attribute_row.atttypmod)
          || ':' || attribute_row.attnotnull::text || ':'
          || coalesce(pg_get_expr(column_default.adbin, column_default.adrelid), '-') order by attribute_row.attnum)
         from pg_attribute attribute_row
         left join pg_attrdef column_default
           on column_default.adrelid = attribute_row.attrelid and column_default.adnum = attribute_row.attnum
        where attribute_row.attrelid = 'pharmacy.own_prescription_sends'::regclass and attribute_row.attnum > 0
          and not attribute_row.attisdropped)
      = array['prescription_id:uuid:true:-', 'prescription_version:bigint:true:-', 'patient_id:uuid:true:-',
              'facility_id:uuid:true:-', 'encounter_id:uuid:true:-', 'sent_by_account_id:uuid:true:-',
              'sent_by_membership_id:uuid:true:-', 'state:text:true:''pending''::text', 'work_item_id:uuid:false:-',
              'attempts:integer:true:0', 'last_failure_sqlstate:text:false:-',
              'created_at:timestamp with time zone:true:clock_timestamp()', 'sent_at:timestamp with time zone:false:-',
              'withdrawn_at:timestamp with time zone:false:-']) is not true then
    raise exception using errcode = '55000', message = '0133: the columns of pharmacy.own_prescription_sends are not this file''s';
  end if;
  if ((select array_agg(constraint_row.contype::text || ' ' || pg_get_constraintdef(constraint_row.oid)
          order by constraint_row.contype, pg_get_constraintdef(constraint_row.oid))
         from pg_constraint constraint_row
        where constraint_row.conrelid = 'pharmacy.own_prescription_sends'::regclass)
      = array['c CHECK (((attempts >= 0) AND (attempts <= 1000)))',
              'c CHECK (((last_failure_sqlstate IS NULL) OR (last_failure_sqlstate ~ ''^[0-9A-Z]{5}$''::text)))',
              'c CHECK (((state = ''sent''::text) = ((work_item_id IS NOT NULL) AND (sent_at IS NOT NULL))))',
              'c CHECK (((withdrawn_at IS NULL) OR (state = ''sent''::text)))', 'c CHECK ((prescription_version > 0))',
              'c CHECK ((state = ANY (ARRAY[''pending''::text, ''sent''::text])))', 'p PRIMARY KEY (prescription_id)',
              'u UNIQUE (work_item_id)']) is not true
     or exists (select 1 from pg_constraint constraint_row
                 where constraint_row.conrelid = 'pharmacy.own_prescription_sends'::regclass
                   and (not constraint_row.convalidated or constraint_row.condeferrable))
     or ((select array_agg(pg_get_indexdef(index_row.indexrelid) order by pg_get_indexdef(index_row.indexrelid))
            from pg_index index_row where index_row.indrelid = 'pharmacy.own_prescription_sends'::regclass)
         = array['CREATE INDEX own_prescription_sends_facility_idx ON pharmacy.own_prescription_sends USING btree '
                   || '(facility_id, state, created_at)',
                 'CREATE UNIQUE INDEX own_prescription_sends_pkey ON pharmacy.own_prescription_sends USING btree '
                   || '(prescription_id)',
                 'CREATE UNIQUE INDEX own_prescription_sends_work_item_id_key ON pharmacy.own_prescription_sends USING '
                   || 'btree (work_item_id)']) is not true then
    raise exception using errcode = '55000', message = '0133: the keys of pharmacy.own_prescription_sends are not this file''s';
  end if;
  if (select relation.relrowsecurity and not relation.relforcerowsecurity and relation.relkind = 'r'
             and relation.relowner = owner_oid
        from pg_class relation where relation.oid = 'pharmacy.own_prescription_sends'::regclass) is not true
     or exists (select 1 from pg_policy policy_row where policy_row.polrelid = 'pharmacy.own_prescription_sends'::regclass)
     or exists (select 1 from pg_class relation,
                       aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
                 where relation.oid = 'pharmacy.own_prescription_sends'::regclass
                   and privilege.grantee <> relation.relowner) then
    raise exception using errcode = '55000',
      message = format('0133: pharmacy.own_prescription_sends must have row-level security on, not forced, no policy '
        || 'and no grant: %s', (select coalesce(relation.relacl::text, 'default') from pg_class relation
                                 where relation.oid = 'pharmacy.own_prescription_sends'::regclass));
  end if;
  -- D5's two policies, naming only the validator's owner.
  if (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'ehr.prescriptions'::regclass
         and policy_row.polroles = array[validator_owner] and policy_row.polpermissive
         and ((policy_row.polname = 'prescriptions_own_pharmacy_source_read' and policy_row.polcmd = 'r'
               and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                 = 'pharmacy.own_work_source_prescription(id, patient_id, facility_id)'
               and policy_row.polwithcheck is null)
           or (policy_row.polname = 'prescriptions_own_pharmacy_source_lock' and policy_row.polcmd = 'w'
               and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                 = 'pharmacy.own_work_source_prescription(id, patient_id, facility_id)'
               and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = 'false'))) <> 2
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid = 'ehr.prescriptions'::regclass
            and policy_row.polname like 'prescriptions\_own\_pharmacy\_%') <> 2 then
    raise exception using errcode = '55000', message = '0133: the ehr.prescriptions policies are not section 5''s';
  end if;
  -- D3's 42 policies, exactly: permissive, for everyone, each with its
  -- anchor; and row-level security still enabled and forced on each table.
  with anchors(schema_name, relation_name, anchor_kind, anchor_column, read_action, has_read, has_update) as (values
         ('lab', 'work_item_events', 'work_item', 'work_item_id', 'read_records', true, false),
         ('lab', 'work_item_requested_tests', 'work_item', 'work_item_id', 'read_records', true, false),
         ('lab', 'accessions', 'work_item', 'work_item_id', 'read_records', true, false),
         ('lab', 'accession_events', 'work_item', 'work_item_id', 'read_records', true, false),
         ('lab', 'specimen_requirements', 'accession', 'accession_id', 'read_records', true, false),
         ('lab', 'specimens', 'accession', 'accession_id', 'read_records', true, true),
         ('lab', 'specimen_events', 'accession', 'accession_id', 'read_records', true, false),
         ('lab', 'test_executions', 'accession', 'accession_id', 'read_records', true, true),
         ('lab', 'specimen_command_idempotency', 'specimen', 'specimen_id', 'write_records', true, false),
         ('lab', 'execution_events', 'execution', 'execution_id', 'read_records', true, false),
         ('lab', 'results', 'execution', 'execution_id', 'read_records', true, true),
         ('lab', 'result_revisions', 'execution', 'execution_id', 'read_records', true, false),
         ('lab', 'result_events', 'execution', 'execution_id', 'read_records', true, false),
         ('lab', 'result_verifications', 'execution', 'execution_id', 'read_records', true, false),
         ('lab', 'result_releases', 'execution', 'execution_id', 'read_records', true, false),
         ('lab', 'result_invalidations', 'execution', 'execution_id', 'read_records', true, false),
         ('pharmacy', 'work_item_events', 'work_item', 'work_item_id', 'read_records', true, false),
         ('pharmacy', 'dispensings', 'work_item', 'work_item_id', 'read_records', true, false),
         ('pharmacy', 'dispensing_reversals', 'work_item', 'work_item_id', 'read_records', true, false),
         ('pharmacy', 'outbox_events', null, null, null, false, false)),
       expected(schema_name, relation_name, policy_name, command, qual, with_check) as (
         select anchors.schema_name, anchors.relation_name, 'own_work_read', 'r',
                format('%s.own_work_chain_allows(%L::text, %s, patient_id, facility_id, %L::text)', anchors.schema_name,
                  anchors.anchor_kind, anchors.anchor_column, anchors.read_action), null
           from anchors where anchors.has_read
         union all
         select anchors.schema_name, anchors.relation_name, 'own_work_insert', 'a', null,
                case when anchors.anchor_kind is not null
                  then format('%s.own_work_chain_allows(%L::text, %s, patient_id, facility_id, %L::text)',
                         anchors.schema_name, anchors.anchor_kind, anchors.anchor_column, 'write_records')
                  -- The outbox: the aggregate's type names the anchor.
                  else 'pharmacy.own_work_chain_allows( CASE aggregate_type WHEN ''pharmacy-work-item''::text THEN '
                    || '''work_item''::text WHEN ''medication-dispensing''::text THEN ''dispensing''::text WHEN '
                    || '''medication-dispensing-reversal''::text THEN ''reversal''::text ELSE NULL::text END, '
                    || 'aggregate_id, patient_id, facility_id, ''write_records''::text)'
                end
           from anchors
         union all
         select anchors.schema_name, anchors.relation_name, 'own_work_update', 'w',
                format('%s.own_work_chain_allows(%L::text, %s, patient_id, facility_id, %L::text)', anchors.schema_name,
                  anchors.anchor_kind, anchors.anchor_column, 'write_records'),
                format('%s.own_work_chain_allows(%L::text, %s, patient_id, facility_id, %L::text)', anchors.schema_name,
                  anchors.anchor_kind, anchors.anchor_column, 'write_records')
           from anchors where anchors.has_update),
       actual as (
         select namespace.nspname as schema_name, relation.relname as relation_name, policy_row.polname as policy_name,
                policy_row.polcmd::text as command,
                regexp_replace(pg_get_expr(policy_row.polqual, policy_row.polrelid), '\s+', ' ', 'g') as qual,
                regexp_replace(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '\s+', ' ', 'g') as with_check,
                policy_row.polpermissive,
                policy_row.polroles
           from pg_policy policy_row
           join pg_class relation on relation.oid = policy_row.polrelid
           join pg_namespace namespace on namespace.oid = relation.relnamespace
          where namespace.nspname in ('lab', 'pharmacy') and policy_row.polname like 'own\_work\_%'),
       wrong as (
         select format('missing or different: %s.%s %s', expected.schema_name, expected.relation_name,
                  expected.policy_name) as what
           from expected
          where not exists (select 1 from actual
                             where actual.schema_name = expected.schema_name
                               and actual.relation_name = expected.relation_name
                               and actual.policy_name = expected.policy_name and actual.command = expected.command
                               and actual.qual is not distinct from expected.qual
                               and actual.with_check is not distinct from expected.with_check
                               and actual.polpermissive and actual.polroles = array[0::oid])
         union all
         select format('unexpected: %s.%s %s', actual.schema_name, actual.relation_name, actual.policy_name)
           from actual
          where not exists (select 1 from expected
                             where expected.schema_name = actual.schema_name
                               and expected.relation_name = actual.relation_name
                               and expected.policy_name = actual.policy_name)
         union all
         select format('row-level security not enabled and forced: %s.%s', anchors.schema_name, anchors.relation_name)
           from anchors
          where not exists (select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
                             where namespace.nspname = anchors.schema_name and relation.relname = anchors.relation_name
                               and relation.relrowsecurity and relation.relforcerowsecurity))
  select exists (select 1 from wrong) or (select count(*) from expected) <> 42,
         (select string_agg(wrong.what, '; ') from wrong)
    into found_absent, mismatch;
  if found_absent or (select count(*) from pg_policy policy_row
                        join pg_class relation on relation.oid = policy_row.polrelid
                        join pg_namespace namespace on namespace.oid = relation.relnamespace
                       where namespace.nspname in ('lab', 'pharmacy') and policy_row.polname like 'own\_work\_%') <> 42 then
    raise exception using errcode = '55000', message = format('0133: the own-work policies are not section 4''s: %s',
      coalesce(mismatch, 'not 42'));
  end if;
  -- D5's premise again.
  if exists (select 1 from pg_roles role_row
              where role_row.rolname like 'hid\_%' and role_row.oid <> validator_owner
                and pg_has_role(role_row.oid, validator_owner, 'MEMBER')) then
    raise exception using errcode = '55000',
      message = format('0133: a hid_ role is a member of %s, which section 5''s ehr.prescriptions policies name',
        pg_get_userbyid(validator_owner));
  end if;
  -- Fire D7 and D8 once without a session: each must refuse with exactly
  -- 42501 OWN_PHARMACY_SEND_DENIED and write nothing.
  begin
    perform ehr.send_prescription_to_own_pharmacy(gen_random_uuid(), 1);
    error_state := 'no error';
  exception when others then
    get stacked diagnostics error_state = returned_sqlstate, error_message = message_text;
  end;
  if error_state is distinct from '42501' or error_message is distinct from 'OWN_PHARMACY_SEND_DENIED' then
    raise exception using errcode = '55000',
      message = format('0133: the send must refuse a call without a session with 42501 OWN_PHARMACY_SEND_DENIED; it '
        || 'answered %s %s', error_state, coalesce(error_message, ''));
  end if;
  error_state := null;
  error_message := null;
  begin
    perform ehr.withdraw_own_pharmacy_send(gen_random_uuid());
    error_state := 'no error';
  exception when others then
    get stacked diagnostics error_state = returned_sqlstate, error_message = message_text;
  end;
  if error_state is distinct from '42501' or error_message is distinct from 'OWN_PHARMACY_SEND_DENIED' then
    raise exception using errcode = '55000',
      message = format('0133: the withdrawal must refuse a call without a session with 42501 OWN_PHARMACY_SEND_DENIED; '
        || 'it answered %s %s', error_state, coalesce(error_message, ''));
  end if;
  -- Fire D9 once per resource type with a random id: no such row, no row
  -- answered; each branch's query is planned on its first run.
  if exists (select 1 from unnest(array['work_item', 'dispensing']) resource_type
              cross join lateral pharmacy.own_work_access_for(resource_type, gen_random_uuid(), 'read_records'))
     or exists (select 1 from unnest(array['work_item', 'accession', 'specimen', 'execution', 'result']) resource_type
                 cross join lateral lab.own_work_access_for(resource_type, gen_random_uuid(), 'read_records')) then
    raise exception using errcode = '55000', message = '0133: the own-work access check answered a row for no row';
  end if;
  if exists (select 1 from pharmacy.own_prescription_sends) then
    raise exception using errcode = '55000', message = '0133: pharmacy.own_prescription_sends is not empty';
  end if;
end
$$;

reset role;
