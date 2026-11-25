-- 0162 BILL-1 (Release D): the billing and pharmacy-stock codes, the two new
-- staff roles cashier and billing_officer, and the schema commercial.
-- Written on claude/sprint-billing-backend at cc80db3f (staging-novu-ci-20261005
-- at 95fa1e52, that is 0001-0151 applied: Releases A, B and C and 0150-0151).
-- The number is provisional (Release D block 0162-0167); 0152-0154 are booked
-- by Ola and nothing here reads them. No migration number appears inside a
-- function body this file makes, so renumbering keeps every md5. The
-- declaration in config/production-schema-compatibility.json is signed
-- separately: until the owner signs this file it stays an unsigned draft.
--
-- Owner decisions: the two-week sprint approval of 25 November 2026 ("yes to
-- all, start tonight"), which approves BILL-5 (the new roles cashier and
-- billing_officer) in principle; this file still needs the owner's verbatim
-- signature. BILL-17 (the two QA logins) is built at the recommended option
-- and is not yet answered: the owner confirms that cashier@ and billing@
-- healthidentitydirectory.com receive mail before signing, or the QA step is
-- left out of the signed file. The planned contract's section "BILL-1: Patient
-- billing release 1, with pharmacy point-of-care stock" is what this builds.
--
-- WHAT IT DOES (nothing else)
-- B1 schema commercial, owned by the applier, no privilege for anyone (0163
--    grants USAGE to the EHR and Pharmacy runtimes with its functions).
-- B2 auth.permissions: 17 new codes, the point-of-care spec's list less its
--    two lab codes, plus billing.bill.adjust and billing.report.read:
--      billing.settings.manage, billing.catalogue.read,
--      billing.catalogue.manage, billing.bill.read, billing.bill.create,
--      billing.bill.adjust, billing.bill.defer, billing.payment.record,
--      billing.payment.confirm, billing.payment.void, billing.payment.waive,
--      billing.shift.own, billing.shift.manage, billing.report.read,
--      pharmacy.walk-in.create, pharmacy.stock.read, pharmacy.stock.manage.
-- B3 auth.roles: cashier and billing_officer (no licence, like the front
--    desk).
-- B4 auth.role_permissions: 58 rows, exactly the contract's table:
--      cashier (5): billing.catalogue.read, billing.bill.read,
--        billing.bill.create, billing.payment.record, billing.shift.own;
--      billing_officer (13): the cashier's, plus billing.bill.adjust,
--        billing.bill.defer, billing.payment.confirm, billing.payment.void,
--        billing.payment.waive, billing.shift.manage,
--        billing.catalogue.manage, billing.report.read;
--      admin and org_admin (10 each): billing.settings.manage,
--        billing.catalogue.read, billing.catalogue.manage,
--        billing.bill.read, billing.bill.adjust, billing.payment.confirm,
--        billing.payment.void, billing.payment.waive, billing.shift.manage,
--        billing.report.read;
--      receptionist (5): the cashier's five (small clinics take money at
--        the desk);
--      pharmacist (8): billing.catalogue.read, billing.bill.read,
--        billing.bill.create, billing.payment.record, billing.shift.own,
--        pharmacy.stock.read, pharmacy.stock.manage, pharmacy.walk-in.create;
--      lab (4): billing.catalogue.read, billing.bill.read,
--        billing.payment.record, billing.shift.own;
--      doctor, nurse and clinician (1 each): billing.bill.defer.
--    Neither new role gets an ehr.*, identity.patient.read or clinical code:
--    a cashier sees only what a bill shows. No code is taken from any role.
-- B5 The two roles are given like any staff role (BILL-5: "added and
--    removed like any other role (SX-4)"), with no licence, exactly as the
--    front desk:
--    identity.staff_invitable_roles(text, text) is replaced: hospital and
--      clinic (and 'other' with ehr or migrate) gain cashier and
--      billing_officer; laboratory and pharmacy (and 'other' with those
--      products) gain cashier. md5 pinned before (0086's) and after.
--    Seven functions that name the five invitable roles in their own text
--      are recreated from their current definition with three textual
--      replacements and nothing else, each md5 pinned before and after:
--        R1 ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist')
--           -> the same list plus 'cashier', 'billing_officer';
--        R2 = 'receptionist'  -> in ('receptionist', 'cashier', 'billing_officer');
--        R3 <> 'receptionist' -> not in ('receptionist', 'cashier', 'billing_officer').
--      identity.staff_invitation_fields_valid (R1 1, R2 1, R3 1),
--      identity.attach_invited_member (R3 1),
--      identity.change_facility_staff_role (R1 1, R2 2, R3 2),
--      identity.add_facility_staff_role (R1 1, R2 7, R3 1),
--      identity.remove_facility_staff_role (R1 1),
--      identity.admin_add_facility_staff_role (R1 1, R2 6, R3 1),
--      identity.admin_remove_facility_staff_role (R1 1).
--      CREATE OR REPLACE keeps each function's owner, ACL, SECURITY DEFINER
--      and search_path, so no grant changes.
--    identity.staff_invitations: its two role checks,
--      staff_invitations_role_code_check and staff_invitations_licence_ck,
--      are replaced by the same rules with the two roles added (no licence,
--      as the receptionist), added NOT VALID and validated under the lock.
--      Every existing row met the narrower rule, so validation cannot fail.
-- B6 0136-style count (numbers only, no stop): a NOTICE with, for each new
--    code, how many active memberships at real facilities (not the sealed
--    demo or QA tenants) gain it. There is no stop because the file only
--    adds and every billing route stays switched off at real facilities
--    until go-live (COMMERCIAL_BILLING_ENABLED, owner sprint approval).
-- B7 audit.events, as the system actor (no account, membership, facility or
--    patient), correlation 0162-billing-roles-and-codes, source hid-0162:
--    one auth.permission.add per code (17), one auth.role.add per role (2)
--    and one auth.role-permission.add per row (58): 77 rows. Details hold
--    the codes, the migration and the decision; never a name or address.
-- B8 Sealed QA step (BILL-17, recommended option, not yet answered), only
--    where 0123 installed the sealed QA tenant (QA Hospital is a QA
--    facility), exactly as 0151 seeds its two: two fictional logins at QA
--    Hospital, pending_reset, no password stored, email verified:
--      cashier@healthidentitydirectory.com "QA Cashier" (cashier),
--        account c0a00003-0000-4000-8000-00000000000a, staff
--        c0a00004-0000-4000-8000-00000000000a, membership
--        c0a00005-0000-4000-8000-0000000000a1;
--      billing@healthidentitydirectory.com "QA Billing Officer"
--        (billing_officer), account c0a00003-0000-4000-8000-00000000000b,
--        staff c0a00004-0000-4000-8000-00000000000b, membership
--        c0a00005-0000-4000-8000-0000000000b1;
--    each a sealed QA member first (so 0123's seal sees it), one staff
--    record, one membership, one facility role with the membership's id, and
--    one audit row identity.sealed-qa.staff-login-add. Refused 55000 "0162:
--    SEALED_QA_ADDRESS_TAKEN" when an address is held elsewhere (0123's
--    rule), "0162: SEALED_QA_ID_TAKEN" when a fixed id is. On every other
--    database (CI, throwaway clusters, the rehearsal) nothing is written for
--    this step, not even an audit row, and a NOTICE says so.
--
-- Locks, taken first, NOWAIT, in one attempt made up to 50 times 100 ms
-- apart (about 5 seconds), so the file never waits for one of its locks while
-- holding the others; then 55P03 "0162: ... busy ...; nothing applied; run
-- the release again at a quieter time". When this transaction already holds
-- an earlier migration's locks that stop other sessions (the runner's dry run
-- applies every pending file in one transaction), one attempt, no sleep.
--   SHARE ROW EXCLUSIVE: auth.roles, auth.permissions, auth.role_permissions
--     (other writers wait; every reader, each request's permission check
--     included, goes on);
--   ACCESS EXCLUSIVE: identity.staff_invitations (its two checks are
--     replaced; a small table, held for milliseconds);
--   ROW EXCLUSIVE: audit.events, identity.sealed_qa_members, auth.accounts,
--     identity.staff, identity.staff_facility_memberships, auth.account_roles
--     (the QA step's rows; taken on every database, as 0151 does);
--   SHARE: identity.organization_applications (no application can name a QA
--     address between the check and commit);
--   ROW SHARE: identity.organizations, identity.facilities, identity.patients,
--     identity.outreach_organisations (the new rows' and the audit rows'
--     foreign keys and 0123's triggers);
--   ACCESS SHARE: identity.sealed_demo_members (0123's demo-overlap trigger);
--   and 0123's sealed QA install lock (tried, not waited for).
-- Other waits are not NOWAIT and the runner's lock_timeout (5 s) ends them.
--
-- Old services on this schema: the new codes are held by roles no old
-- service checks for; the replaced role functions answer exactly as before
-- for the five old roles (only the new roles are added to their lists), so
-- Release C's images are unaffected. New services on a schema without this
-- file: the billing routes answer 503 BILLING_UNAVAILABLE.
--
-- Undo (not in the ledger; docs/rollback/0162_billing_roles_and_codes.md):
-- revoke both roles' assignments, delete the 58 role rows, the two roles and
-- the 17 codes, restore the eight functions and the two checks from their
-- pinned definitions, and drop schema commercial if 0163 is not applied.
--
-- The whole file is one statement (do $bill1$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (above).
-- 1. Preconditions (55000, or 42501 for ownership; nothing applied):
--    a. markers of the earlier files whose objects it uses only: 0123 (the
--       sealed QA tenant) and 0150 (doctor's ocr.job.start, one of the codes
--       d requires); c, d and e check everything else it reads exactly;
--    b. not applied yet ("0162: already applied" when every object is exactly
--       as this file leaves it; "0162: ... not in the reviewed state" when
--       any of its objects exists otherwise);
--    c. the eight role functions and the two checks exactly as Release C
--       leaves them (md5 of pg_proc.prosrc, SECURITY DEFINER, search_path
--       and grants, and the check definitions); these
--       stay exact because this file rewrites them, so a change another lane
--       made to them is refused, never overwritten (no wave 1 lane makes one);
--    d. the eight roles active, each still holding every code 0001-0151 gave
--       it (listed); codes other release lanes add to them are accepted, so
--       no role's whole list is pinned (coordinator, #258, 25 November 2026:
--       wave 1 releases in order of readiness); roles and codes this file adds
--       absent, schema commercial absent;
--    e. the QA step's helpers and seal triggers as 0151 checks them, and
--       one owner for what it writes (0151's step f).
-- 2. B1-B8.
-- 3. Post-checks: the 58 rows of the new codes (md5 pinned), the role table
--    compared row by row with the table before step 2 plus exactly those 58
--    rows (so no other role's code changes), the eight
--    functions' md5 after with their owner, SECURITY DEFINER, search_path
--    and grants unchanged, the two checks, the schema and its ACL, the 77
--    audit rows (plus 2 where the QA tenant is installed), the QA step's rows.

do $bill1$
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
  correlation constant text := '0162-billing-roles-and-codes';
  decision constant text := 'BILL-5 (owner sprint approval, 25 November 2026)';
  reason_text constant text := 'Owner sprint approval (25 November 2026), BILL-5: billing roles and codes';
  -- The new codes and their descriptions.
  new_codes constant jsonb := '[
    ["billing.settings.manage", "Change the facility''s payment settings"],
    ["billing.catalogue.read", "Read the facility''s price list"],
    ["billing.catalogue.manage", "Add and change items on the facility''s price list"],
    ["billing.bill.read", "Read the facility''s bills and receipts"],
    ["billing.bill.create", "Make bills and add lines to them"],
    ["billing.bill.adjust", "Cancel bill lines and void bills"],
    ["billing.bill.defer", "Defer a bill so care goes ahead first"],
    ["billing.payment.record", "Take payments and record HMO cover"],
    ["billing.payment.confirm", "Confirm that a bank transfer arrived"],
    ["billing.payment.void", "Void a payment or cancel an HMO cover taken by someone else"],
    ["billing.payment.waive", "Waive what a patient owes, with a reason"],
    ["billing.shift.own", "Open and close one''s own till day"],
    ["billing.shift.manage", "See and close every till day at the facility"],
    ["billing.report.read", "Read outstanding balances and what HMOs owe"],
    ["pharmacy.walk-in.create", "Sell at the pharmacy counter"],
    ["pharmacy.stock.read", "Read the pharmacy''s stock"],
    ["pharmacy.stock.manage", "Receive and adjust the pharmacy''s stock"]]';
  -- Each role's codes as 0001-0151 leave them (Release C and 0150; 0152-0153 add none). Every one must still be
  -- held. Codes other release lanes add to these roles are accepted (coordinator, #258, 25 November 2026: wave 1
  -- releases in order of readiness), so no role's whole list is pinned.
  release_c_codes constant jsonb := '{
    "admin": ["audit.read", "identity.registration.approve", "identity.registration.write", "lab.accession.read",
      "lab.execution.read", "lab.import.read", "lab.result.released.read", "ocr.job.read", "organization.manage",
      "outreach.campaign.read", "outreach.campaign.write", "outreach.registration.read", "outreach.registration.write",
      "pharmacy.dispensing.read", "pharmacy.import.read", "workforce.manage"],
    "clinician": ["ehr.diagnosis.read", "ehr.diagnosis.write", "ehr.document.read", "ehr.document.write",
      "ehr.encounter.read", "ehr.encounter.write", "ehr.lab-request.read", "ehr.lab-request.write", "ehr.note.read",
      "ehr.note.write", "ehr.order-route.send", "ehr.prescription.read", "ehr.prescription.write", "ehr.vital.read",
      "ehr.vital.write", "identity.authorization.check", "identity.break-glass.write", "identity.consent.read",
      "identity.consent.write", "identity.patient-access-pin.verify", "identity.patient.open-own-facility",
      "identity.patient.read", "identity.registration.write", "lab.import.read", "lab.import.write",
      "lab.result.released.read", "lab.work-item.accept", "lab.work-item.read", "ocr.job.read", "ocr.job.start",
      "ocr.job.write", "ocr.patient.confirm", "ocr.publication.write", "ocr.validation.write", "outreach.campaign.read",
      "outreach.campaign.write", "outreach.registration.read", "outreach.registration.write",
      "pharmacy.dispensing.read", "pharmacy.import.read", "pharmacy.import.write", "pharmacy.work-item.read"],
    "doctor": ["ehr.diagnosis.read", "ehr.diagnosis.write", "ehr.document.read", "ehr.document.write",
      "ehr.encounter.read", "ehr.encounter.write", "ehr.lab-request.read", "ehr.lab-request.write", "ehr.note.read",
      "ehr.note.write", "ehr.order-route.send", "ehr.prescription.read", "ehr.prescription.write", "ehr.vital.read",
      "ehr.vital.write", "identity.authorization.check", "identity.break-glass.write", "identity.consent.read",
      "identity.consent.write", "identity.patient-access-pin.verify", "identity.patient.open-own-facility",
      "identity.patient.read", "identity.registration.write", "lab.import.read", "lab.import.write",
      "lab.result.released.read", "lab.work-item.accept", "ocr.job.read", "ocr.job.start", "ocr.job.write",
      "ocr.patient.confirm", "ocr.publication.write", "ocr.validation.write", "pharmacy.dispensing.read",
      "pharmacy.import.read", "pharmacy.import.write"],
    "lab": ["ehr.document.read", "ehr.document.write", "ehr.lab-request.read", "ehr.lab-request.write",
      "identity.authorization.check", "identity.consent.read", "identity.consent.write", "identity.patient.read",
      "lab.accession.create", "lab.accession.read", "lab.execution.complete", "lab.execution.read",
      "lab.execution.start", "lab.import.read", "lab.import.write", "lab.order-route.receive", "lab.result.correct",
      "lab.result.enter", "lab.result.entered-in-error", "lab.result.release", "lab.result.released.read",
      "lab.result.revise-released", "lab.result.verify", "lab.specimen.collect", "lab.specimen.receive",
      "lab.specimen.reject", "lab.work-item.accept", "lab.work-item.read"],
    "nurse": ["ehr.diagnosis.read", "ehr.document.read", "ehr.document.write", "ehr.encounter.read",
      "ehr.encounter.write", "ehr.lab-request.read", "ehr.note.read", "ehr.note.write", "ehr.prescription.read",
      "ehr.vital.read", "ehr.vital.write", "identity.authorization.check", "identity.break-glass.write",
      "identity.consent.read", "identity.consent.write", "identity.patient-access-pin.verify",
      "identity.patient.open-own-facility", "identity.patient.read", "identity.registration.write", "lab.import.read",
      "lab.import.write", "lab.result.released.read", "lab.work-item.accept", "lab.work-item.read", "ocr.job.read",
      "ocr.job.start", "ocr.job.write", "ocr.patient.confirm", "ocr.publication.write", "ocr.validation.write",
      "outreach.campaign.read", "outreach.campaign.write", "outreach.registration.read", "outreach.registration.write",
      "pharmacy.dispensing.read", "pharmacy.import.read", "pharmacy.import.write", "pharmacy.work-item.read"],
    "org_admin": ["audit.read", "identity.registration.approve", "identity.registration.write", "organization.manage",
      "outreach.campaign.read", "outreach.campaign.write", "outreach.registration.read", "outreach.registration.write",
      "workforce.manage"],
    "pharmacist": ["ehr.encounter.read", "ehr.prescription.read", "identity.authorization.check",
      "identity.consent.read", "identity.consent.write", "identity.patient.read", "pharmacy.dispensing.create",
      "pharmacy.dispensing.read", "pharmacy.dispensing.reverse", "pharmacy.import.read", "pharmacy.import.write",
      "pharmacy.order-route.receive", "pharmacy.work-item.accept", "pharmacy.work-item.read"],
    "receptionist": ["ehr.document.read-own", "ehr.document.write", "ehr.encounter.read", "ehr.encounter.write",
      "ehr.vital.read", "identity.authorization.check", "identity.consent.read", "identity.consent.write",
      "identity.patient.read", "identity.registration.write", "ocr.job.read-own", "ocr.job.start", "ocr.job.write",
      "outreach.campaign.read", "outreach.campaign.write", "outreach.registration.read",
      "outreach.registration.write"]}';
  -- The 58 rows this file adds: md5 of "role code" pairs in byte order (collate "C"), joined by ','.
  rows_md5 constant text := 'd73e63d61ea5cc52bbf1bcd56fa69304';
  -- The eight role functions' SECURITY DEFINER, search_path and grants (to roles other than the owner), as Release C
  -- leaves them and as they must be after CREATE OR REPLACE: "definer|search_path|grantee:privilege,...".
  function_settings constant jsonb := '{
    "identity.staff_invitable_roles(text,text)": "false|search_path=pg_catalog, pg_temp|",
    "identity.staff_invitation_fields_valid(text,text,text,text,text,text)":
      "false|search_path=pg_catalog, identity, pg_temp|",
    "identity.attach_invited_member(identity.staff_invitations,uuid,uuid,boolean)":
      "false|search_path=pg_catalog, identity, auth, platform, pg_temp|",
    "identity.change_facility_staff_role(uuid,bigint,text,text,text,text,text)":
      "true|search_path=pg_catalog, identity, auth, audit, platform, pg_temp|hid_identity_runtime:EXECUTE,hid_schema_test_runtime:EXECUTE",
    "identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)":
      "true|search_path=pg_catalog, pg_temp|hid_identity_runtime:EXECUTE",
    "identity.remove_facility_staff_role(uuid,bigint,text,text)": "true|search_path=pg_catalog, pg_temp|hid_identity_runtime:EXECUTE",
    "identity.admin_add_facility_staff_role(uuid,uuid,bigint,text,text,text,text,text,text,character)":
      "true|search_path=pg_catalog, pg_temp|hid_identity_runtime:EXECUTE",
    "identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character)":
      "true|search_path=pg_catalog, pg_temp|hid_identity_runtime:EXECUTE"}';
  -- The role functions: md5 of pg_proc.prosrc before (Release C) and after
  -- this file, and how many times each replacement applies.
  role_functions constant jsonb := '[
    {"f": "identity.staff_invitation_fields_valid(text,text,text,text,text,text)",
     "before": "a19f57eb883418bc352d7a5b0fdab991", "after": "877683d94b2d2c3e0726577220e24016", "r1": 1, "r2": 1, "r3": 1},
    {"f": "identity.attach_invited_member(identity.staff_invitations,uuid,uuid,boolean)",
     "before": "b4e714b7c1c3ab2ac402a1ae1e675882", "after": "692051178a30671c722b4cc7e99de451", "r1": 0, "r2": 0, "r3": 1},
    {"f": "identity.change_facility_staff_role(uuid,bigint,text,text,text,text,text)",
     "before": "478b9dc8c9e4996b86b1e06fb81c3116", "after": "037de5a60631073c230609174605effd", "r1": 1, "r2": 2, "r3": 2},
    {"f": "identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)",
     "before": "1ca56a2cdd0231341d9f3b48441b2074", "after": "e06820432c71323c5a5d15b982734bc9", "r1": 1, "r2": 7, "r3": 1},
    {"f": "identity.remove_facility_staff_role(uuid,bigint,text,text)",
     "before": "8da5860b2edbd3ee7205e4473b30fbc7", "after": "b526657aeb92bc20a6286c4e2a70ed08", "r1": 1, "r2": 0, "r3": 0},
    {"f": "identity.admin_add_facility_staff_role(uuid,uuid,bigint,text,text,text,text,text,text,character)",
     "before": "e12a01443fad2b903f22533153810b0f", "after": "149336ed451e6388243e2b75849c87ee", "r1": 1, "r2": 6, "r3": 1},
    {"f": "identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character)",
     "before": "9d326012bf28739a62cef768b613f181", "after": "9af4f13a831710c79a323be88b779fc0", "r1": 1, "r2": 0, "r3": 0}]';
  r1_old constant text := $r$('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist')$r$;
  r1_new constant text := $r$('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier', 'billing_officer')$r$;
  r2_old constant text := $r$= 'receptionist'$r$;
  r2_new constant text := $r$in ('receptionist', 'cashier', 'billing_officer')$r$;
  r3_old constant text := $r$<> 'receptionist'$r$;
  r3_new constant text := $r$not in ('receptionist', 'cashier', 'billing_officer')$r$;
  invitable_before_md5 constant text := 'b6f4068712d97284fd95d169e3bde0cf';
  invitable_after_md5 constant text := 'd43c8b94981d500263462d0ae2664b8a';
  role_check_before constant text := 'CHECK ((role_code = ANY (ARRAY[''doctor''::text, ''nurse''::text, ''lab''::text, ''pharmacist''::text, ''receptionist''::text])))';
  licence_check_before constant text := 'CHECK ((((role_code = ''receptionist''::text) AND (licence_body IS NULL) AND (licence_number IS NULL)) OR ((role_code <> ''receptionist''::text) AND (licence_body = identity.staff_role_licence_body(role_code)) AND identity.licence_number_valid(licence_number))))';
  role_check_after constant text := 'CHECK ((role_code = ANY (ARRAY[''doctor''::text, ''nurse''::text, ''lab''::text, ''pharmacist''::text, ''receptionist''::text, ''cashier''::text, ''billing_officer''::text])))';
  licence_check_after constant text := 'CHECK ((((role_code = ANY (ARRAY[''receptionist''::text, ''cashier''::text, ''billing_officer''::text])) AND (licence_body IS NULL) AND (licence_number IS NULL)) OR ((role_code <> ALL (ARRAY[''receptionist''::text, ''cashier''::text, ''billing_officer''::text])) AND (licence_body = identity.staff_role_licence_body(role_code)) AND identity.licence_number_valid(licence_number))))';
  -- Sealed QA step (BILL-17).
  qa_hospital_organization constant uuid := 'c0a00001-0000-4000-8000-000000000001';
  qa_hospital constant uuid := 'c0a00002-0000-4000-8000-000000000001';
  qa_role_reason constant text := 'Sealed QA tenant: QA Hospital cashier and billing officer (0162, BILL-17)';
  qa_audit_reason constant text := 'BILL-17 (recommended option): a cashier and a billing officer login at QA Hospital, sealed QA only';
  qa_correlation constant text := '0162-sealed-qa-cashier-billing';
  logins constant jsonb := '[
    {"account": "c0a00003-0000-4000-8000-00000000000a", "staff": "c0a00004-0000-4000-8000-00000000000a",
     "membership": "c0a00005-0000-4000-8000-0000000000a1",
     "subject": "sealed-qa:c0a00003-0000-4000-8000-00000000000a",
     "email": "cashier@healthidentitydirectory.com", "name": "QA Cashier", "role": "cashier"},
    {"account": "c0a00003-0000-4000-8000-00000000000b", "staff": "c0a00004-0000-4000-8000-00000000000b",
     "membership": "c0a00005-0000-4000-8000-0000000000b1",
     "subject": "sealed-qa:c0a00003-0000-4000-8000-00000000000b",
     "email": "billing@healthidentitydirectory.com", "name": "QA Billing Officer", "role": "billing_officer"}]';
  role_rows constant jsonb := '{
    "cashier": ["billing.catalogue.read", "billing.bill.read", "billing.bill.create", "billing.payment.record",
      "billing.shift.own"],
    "billing_officer": ["billing.catalogue.read", "billing.bill.read", "billing.bill.create", "billing.payment.record",
      "billing.shift.own", "billing.bill.adjust", "billing.bill.defer", "billing.payment.confirm",
      "billing.payment.void", "billing.payment.waive", "billing.shift.manage", "billing.catalogue.manage",
      "billing.report.read"]}';
  found_absent boolean;
  missing text;
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
  owner_oid oid;
  saved_role text;
  installed boolean;
  rows_before text;
  entry jsonb;
  source text;
  replaced text;
  held integer;
  exact integer;
  step bigint;
  written integer := 0;
  counts text;
begin
  loop
  attempt := attempt + 1;
  begin
  -- 0. The locks, NOWAIT.
  lock table auth.roles, auth.permissions, auth.role_permissions
    in share row exclusive mode nowait;
  lock table identity.staff_invitations
    in access exclusive mode nowait;
  lock table audit.events, identity.sealed_qa_members, auth.accounts, identity.staff,
             identity.staff_facility_memberships, auth.account_roles
    in row exclusive mode nowait;
  lock table identity.organization_applications
    in share mode nowait;
  lock table identity.organizations, identity.facilities, identity.patients, identity.outreach_organisations
    in row share mode nowait;
  lock table identity.sealed_demo_members
    in access share mode nowait;
  if not pg_try_advisory_xact_lock(hashtextextended('hid-sealed-qa-install', 0)) then
    raise exception using errcode = '55P03', message = '0162: the sealed QA install lock is held';
  end if;
  exit;

  exception when lock_not_available then
    if holding then
      raise exception using errcode = '55P03',
        message = '0162: a table 0162 writes or checks (the role table, staff invitations, audit events, the sealed '
          || 'QA members, accounts, staff records, staff memberships, account roles, organization applications and '
          || 'the tables their keys reference) or the sealed QA install lock is busy, and this transaction already '
          || 'holds an earlier migration''s locks, so it does not wait; nothing applied; run the release again at a '
          || 'quieter time';
    end if;
    if attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0162: a table 0162 writes or checks (the role table, staff invitations, audit events, the sealed '
          || 'QA members, accounts, staff records, staff memberships, account roles, organization applications and '
          || 'the tables their keys reference) or the sealed QA install lock stayed busy for 5 seconds; nothing '
          || 'applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- a. Markers of the earlier files whose objects this file uses only (coordinator, #258, 25 November 2026): 0123's
  -- sealed QA tenant (the QA step) and 0150's row (in the roles' codes, d). c, d and e check the rest exactly.
  if not exists (select 1 from auth.role_permissions where role_code = 'doctor' and permission_code = 'ocr.job.start')
     or to_regprocedure('identity.sealed_qa_install()') is null then
    raise exception using errcode = '55000', message = '0162: 0001-0151 must be applied first';
  end if;

  -- b. Not applied yet.
  if exists (select 1 from auth.roles where code in ('cashier', 'billing_officer'))
     or exists (select 1 from auth.permissions
                 where code in (select value->>0 from jsonb_array_elements(new_codes)))
     or to_regnamespace('commercial') is not null then
    if (select count(*) from auth.roles where code in ('cashier', 'billing_officer') and active) = 2
       and (select count(*) from auth.permissions
             where code in (select value->>0 from jsonb_array_elements(new_codes)) and active) = 17
       and to_regnamespace('commercial') is not null
       and (select md5(string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                                  order by grant_row.role_code collate "C", grant_row.permission_code collate "C"))
              from auth.role_permissions grant_row
             where grant_row.permission_code in (select value->>0 from jsonb_array_elements(new_codes))) = rows_md5
       and (select md5(proc.prosrc) from pg_proc proc
             where proc.oid = to_regprocedure('identity.staff_invitable_roles(text,text)')) = invitable_after_md5
       and not exists (select 1 from jsonb_array_elements(role_functions) fn
                        where (select md5(proc.prosrc) from pg_proc proc
                                where proc.oid = to_regprocedure(fn.value->>'f')) is distinct from fn.value->>'after')
       and (select count(*) from audit.events event_row where event_row.correlation_id = correlation) = 77 then
      raise exception using errcode = '55000', message = '0162: already applied';
    end if;
    raise exception using errcode = '55000',
      message = '0162: the role table is not in the reviewed state (a role, code or schema this file adds exists, '
        || 'with other content than 0162 leaves); nothing applied';
  end if;

  -- c. The role functions and the two checks as Release C leaves them.
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = to_regprocedure('identity.staff_invitable_roles(text,text)')) is distinct from invitable_before_md5 then
    raise exception using errcode = '55000',
      message = '0162: identity.staff_invitable_roles is not as 0086 made it; nothing applied';
  end if;
  select string_agg(fn.value->>'f', ', ') into missing
    from jsonb_array_elements(role_functions) fn
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(fn.value->>'f'))
         is distinct from fn.value->>'before';
  if missing is not null then
    raise exception using errcode = '55000',
      message = '0162: these role functions differ from Release C or are missing: ' || missing;
  end if;
  if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
       where constraint_row.conrelid = 'identity.staff_invitations'::regclass
         and constraint_row.conname = 'staff_invitations_role_code_check') is distinct from role_check_before
     or (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
          where constraint_row.conrelid = 'identity.staff_invitations'::regclass
            and constraint_row.conname = 'staff_invitations_licence_ck') is distinct from licence_check_before then
    raise exception using errcode = '55000',
      message = '0162: identity.staff_invitations'' role checks are not as Release C leaves them; nothing applied';
  end if;
  select string_agg(pinned.key, ', ' order by pinned.key) into missing
    from jsonb_each_text(function_settings) pinned
   where (select proc.prosecdef::text || '|' || coalesce(array_to_string(proc.proconfig, ';'), '') || '|'
                  || coalesce((select string_agg(granted.entry, ',' order by granted.entry collate "C")
                                 from (select case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
                                                || ':' || acl.privilege_type as entry
                                         from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                                        where acl.grantee <> proc.proowner) granted), '')
             from pg_proc proc where proc.oid = to_regprocedure(pinned.key)) is distinct from pinned.value;
  if missing is not null then
    raise exception using errcode = '55000',
      message = '0162: these role functions'' SECURITY DEFINER, search_path or grants differ from Release C: ' || missing;
  end if;

  -- d. The eight roles active, each still holding every code 0001-0151 gave it (others' additions accepted).
  select string_agg(pinned.key, ', ' order by pinned.key) into missing
    from jsonb_each(release_c_codes) pinned
   where not exists (select 1 from auth.roles role_row where role_row.code = pinned.key and role_row.active)
      or exists (select 1 from jsonb_array_elements_text(pinned.value) wanted(code)
                  where not exists (select 1 from auth.role_permissions grant_row
                                     where grant_row.role_code = pinned.key and grant_row.permission_code = wanted.code));
  if missing is not null then
    raise exception using errcode = '55000',
      message = '0162: these roles are inactive or lack a code 0001-0151 gave them: ' || missing;
  end if;

  -- e. The QA step's helpers and seal triggers as 0151 checks them.
  with expected(signature, digest) as (values
         ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
         ('identity.sealed_qa_account(uuid)', '2c19c76bff02b394097724f99e09fc9d'),
         ('identity.sealed_qa_recipient(text)', '7bb9434e607271d72c1e02f0961bce13'),
         ('identity.sealed_qa_members_not_demo()', 'b306df4f70f9d207467cedbf75a5c7aa'),
         ('identity.staff_memberships_sealed_qa()', '4c00d810e3be5d047b55c6d90573527f'),
         ('identity.account_roles_sealed_qa()', '6a95d1dd699daca074d901decd68d138'),
         ('identity.staff_memberships_sealed_demo()', 'cf5745fe353d90ce79b095983085266c'),
         ('identity.account_roles_sealed_demo()', 'f852b9f89d084a99f7489d9427a779fc')),
       differing as (
         select expected.signature from expected
          where to_regprocedure(expected.signature) is null
             or not exists (select 1 from pg_proc proc
                             where proc.oid = to_regprocedure(expected.signature)
                               and md5(proc.prosrc) = expected.digest))
  select exists (select 1 from differing), (select string_agg(differing.signature, ', ') from differing)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0162: these functions differ from 0123''s (and 0098''s) or are missing: %s', missing);
  end if;
  if exists (select 1 from jsonb_to_recordset(logins) login(email text)
              where not identity.sealed_qa_recipient(login.email)) then
    raise exception using errcode = '55000', message = '0162: an address is not of the owner''s domain';
  end if;
  owner_oid := (select relation.relowner from pg_class relation
                 where relation.oid = 'identity.sealed_qa_members'::regclass);
  with foreign_owned as (
         select expected.table_name as what
           from (values ('auth.accounts'), ('identity.staff'), ('identity.staff_facility_memberships'),
                        ('auth.account_roles'), ('audit.events'), ('auth.roles'), ('auth.permissions'),
                        ('auth.role_permissions'), ('identity.staff_invitations')) expected(table_name)
          where not exists (select 1 from pg_class relation
                             where relation.oid = to_regclass(expected.table_name) and relation.relowner = owner_oid)
         union all
         select expected.signature
           from (select 'identity.staff_invitable_roles(text,text)' union all
                 select fn.value->>'f' from jsonb_array_elements(role_functions) fn) expected(signature)
          where not exists (select 1 from pg_proc proc
                             where proc.oid = to_regprocedure(expected.signature) and proc.proowner = owner_oid))
  select exists (select 1 from foreign_owned), (select string_agg(foreign_owned.what, ', ') from foreign_owned)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '42501',
      message = format('0162: these are not owned by %s, the owner of identity.sealed_qa_members: %s',
        coalesce(pg_get_userbyid(owner_oid), 'nobody'), missing);
  end if;
  if not (applier = owner_oid
          or (pg_has_role(applier, owner_oid, 'USAGE') and pg_has_role(applier, owner_oid, 'SET'))) then
    raise exception using errcode = '42501',
      message = format('0162: %s must own, or inherit from and be able to SET ROLE to, %s', current_user,
        pg_get_userbyid(owner_oid));
  end if;
  select count(*) into held
    from jsonb_to_recordset(logins) login(account uuid, staff uuid, membership uuid)
   where exists (select 1 from auth.accounts account where account.id = login.account)
      or identity.sealed_qa_account(login.account)
      or exists (select 1 from identity.staff staff_row where staff_row.id = login.staff)
      or exists (select 1 from identity.staff_facility_memberships membership where membership.id = login.membership)
      or exists (select 1 from auth.account_roles assignment where assignment.id = login.membership);
  if held > 0 then
    raise exception using errcode = '55000', message = '0162: SEALED_QA_ID_TAKEN';
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into rows_before from auth.role_permissions grant_row;

  -- 2. B1 the schema.
  create schema commercial;
  revoke all on schema commercial from public;
  comment on schema commercial is
    '0162 (BILL-1, BILL-9): patient billing release 1. Tables are read and written only by its SECURITY DEFINER functions.';

  -- B2 the codes, B3 the roles, B4 the rows.
  insert into auth.permissions (code, description)
  select value->>0, value->>1 from jsonb_array_elements(new_codes);
  insert into auth.roles (code, description) values
    ('cashier', 'Cashier: takes payments, prints receipts and closes the till day; sees only what a bill shows'),
    ('billing_officer', 'Billing officer: the cashier''s work plus the price list, voids, waivers, transfers and reports');
  insert into auth.role_permissions (role_code, permission_code) values
    ('cashier', 'billing.catalogue.read'), ('cashier', 'billing.bill.read'), ('cashier', 'billing.bill.create'),
    ('cashier', 'billing.payment.record'), ('cashier', 'billing.shift.own'),
    ('billing_officer', 'billing.catalogue.read'), ('billing_officer', 'billing.bill.read'),
    ('billing_officer', 'billing.bill.create'), ('billing_officer', 'billing.payment.record'),
    ('billing_officer', 'billing.shift.own'), ('billing_officer', 'billing.bill.adjust'),
    ('billing_officer', 'billing.bill.defer'), ('billing_officer', 'billing.payment.confirm'),
    ('billing_officer', 'billing.payment.void'), ('billing_officer', 'billing.payment.waive'),
    ('billing_officer', 'billing.shift.manage'), ('billing_officer', 'billing.catalogue.manage'),
    ('billing_officer', 'billing.report.read'),
    ('admin', 'billing.settings.manage'), ('admin', 'billing.catalogue.read'), ('admin', 'billing.catalogue.manage'),
    ('admin', 'billing.bill.read'), ('admin', 'billing.bill.adjust'), ('admin', 'billing.payment.confirm'),
    ('admin', 'billing.payment.void'), ('admin', 'billing.payment.waive'), ('admin', 'billing.shift.manage'),
    ('admin', 'billing.report.read'),
    ('org_admin', 'billing.settings.manage'), ('org_admin', 'billing.catalogue.read'),
    ('org_admin', 'billing.catalogue.manage'), ('org_admin', 'billing.bill.read'), ('org_admin', 'billing.bill.adjust'),
    ('org_admin', 'billing.payment.confirm'), ('org_admin', 'billing.payment.void'),
    ('org_admin', 'billing.payment.waive'), ('org_admin', 'billing.shift.manage'), ('org_admin', 'billing.report.read'),
    ('receptionist', 'billing.catalogue.read'), ('receptionist', 'billing.bill.read'),
    ('receptionist', 'billing.bill.create'), ('receptionist', 'billing.payment.record'),
    ('receptionist', 'billing.shift.own'),
    ('pharmacist', 'billing.catalogue.read'), ('pharmacist', 'billing.bill.read'), ('pharmacist', 'billing.bill.create'),
    ('pharmacist', 'billing.payment.record'), ('pharmacist', 'billing.shift.own'), ('pharmacist', 'pharmacy.stock.read'),
    ('pharmacist', 'pharmacy.stock.manage'), ('pharmacist', 'pharmacy.walk-in.create'),
    ('lab', 'billing.catalogue.read'), ('lab', 'billing.bill.read'), ('lab', 'billing.payment.record'),
    ('lab', 'billing.shift.own'),
    ('doctor', 'billing.bill.defer'), ('nurse', 'billing.bill.defer'), ('clinician', 'billing.bill.defer');

  -- B5 the roles are given like any staff role.
  create or replace function identity.staff_invitable_roles(target_organization_type text, target_product_code text)
  returns text[]
  language sql immutable parallel safe
  set search_path = pg_catalog, pg_temp
  as $invitable$
  select case
    when target_organization_type in ('hospital', 'clinic')
      or (target_organization_type = 'other' and target_product_code in ('ehr', 'migrate'))
      then array['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier', 'billing_officer']
    when target_organization_type = 'laboratory'
      or (target_organization_type = 'other' and target_product_code = 'laboratory')
      then array['lab', 'receptionist', 'cashier']
    when target_organization_type = 'pharmacy'
      or (target_organization_type = 'other' and target_product_code = 'pharmacy')
      then array['pharmacist', 'receptionist', 'cashier']
    else array[]::text[]
  end
$invitable$;
  for entry in select value from jsonb_array_elements(role_functions) loop
    source := pg_get_functiondef(to_regprocedure(entry->>'f'));
    if (length(source) - length(replace(source, r1_old, ''))) / length(r1_old) <> (entry->>'r1')::integer
       or (length(source) - length(replace(source, r2_old, ''))) / length(r2_old) <> (entry->>'r2')::integer
       or (length(source) - length(replace(source, r3_old, ''))) / length(r3_old) <> (entry->>'r3')::integer then
      raise exception using errcode = '55000',
        message = '0162: ' || (entry->>'f') || ' does not name the roles as Release C does; nothing applied';
    end if;
    replaced := replace(replace(replace(source, r1_old, r1_new), r2_old, r2_new), r3_old, r3_new);
    execute replaced;
  end loop;
  alter table identity.staff_invitations drop constraint staff_invitations_role_code_check;
  alter table identity.staff_invitations drop constraint staff_invitations_licence_ck;
  alter table identity.staff_invitations add constraint staff_invitations_role_code_check
    check (role_code in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'cashier', 'billing_officer')) not valid;
  alter table identity.staff_invitations add constraint staff_invitations_licence_ck
    check ((role_code in ('receptionist', 'cashier', 'billing_officer') and licence_body is null
            and licence_number is null)
        or (role_code not in ('receptionist', 'cashier', 'billing_officer')
            and licence_body = identity.staff_role_licence_body(role_code)
            and identity.licence_number_valid(licence_number))) not valid;
  alter table identity.staff_invitations validate constraint staff_invitations_role_code_check;
  alter table identity.staff_invitations validate constraint staff_invitations_licence_ck;

  -- B6 the count (numbers only): active memberships at real facilities that gain each code.
  select string_agg(format('%s %s', code_row.code, coalesce(gained.members, 0)), '; ' order by code_row.code)
    into counts
    from (select value->>0 as code from jsonb_array_elements(new_codes)) code_row
    left join lateral (
      select count(distinct membership.id) as members
        from identity.staff_facility_memberships membership
        join auth.account_roles assignment on assignment.membership_id = membership.id
         and assignment.revoked_at is null and assignment.scope_type = 'facility'
        join auth.role_permissions grant_row on grant_row.role_code = assignment.role_code
         and grant_row.permission_code = code_row.code
       where membership.active
         and not identity.sealed_demo_facility(membership.facility_id)
         and not identity.sealed_qa_facility(membership.facility_id)) gained on true;
  raise notice '0162: active memberships at real facilities that gain each code (switched off until go-live): %', counts;

  -- B7 the audit rows.
  insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details)
  select correlation, 'system', 'auth.permission.add', 'success', 'permission', value->>0, 'healthcare-operations',
         reason_text, 'migration', 'hid-0162',
         jsonb_build_object('permissionCode', value->>0, 'migration', '0162', 'decision', decision)
    from jsonb_array_elements(new_codes);
  insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details)
  select correlation, 'system', 'auth.role.add', 'success', 'role', role_code, 'healthcare-operations', reason_text,
         'migration', 'hid-0162', jsonb_build_object('roleCode', role_code, 'migration', '0162', 'decision', decision)
    from (values ('cashier'), ('billing_officer')) added(role_code);
  insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details)
  select correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission',
         grant_row.role_code || '/' || grant_row.permission_code, 'healthcare-operations', reason_text, 'migration',
         'hid-0162', jsonb_build_object('roleCode', grant_row.role_code, 'permissionCode', grant_row.permission_code,
           'migration', '0162', 'decision', decision)
    from auth.role_permissions grant_row
   where grant_row.permission_code in (select value->>0 from jsonb_array_elements(new_codes))
   order by grant_row.role_code collate "C", grant_row.permission_code collate "C";

  -- B8 the sealed QA step.
  installed := exists (select 1 from identity.facilities facility
                        where facility.id = qa_hospital and facility.organization_id = qa_hospital_organization)
               and identity.sealed_qa_facility(qa_hospital);
  if not installed then
    raise notice '0162: the sealed QA tenant is not installed here (QA Hospital is not a QA facility): no QA login written';
  else
    if exists (select 1 from auth.accounts account
                 join jsonb_to_recordset(logins) login(account uuid, email text) on lower(account.email) = login.email
                where account.status <> 'deleted' and account.id <> login.account)
       or exists (select 1 from identity.staff staff_row
                    join jsonb_to_recordset(logins) login(staff uuid, email text) on lower(staff_row.email) = login.email
                   where staff_row.id is distinct from login.staff)
       or exists (select 1 from identity.organization_applications application
                    join jsonb_to_recordset(logins) login(email text)
                      on lower(application.administrator_email) = login.email
                   where application.status in ('pending_verification', 'ready_for_review'))
       or exists (select 1 from identity.staff_invitations invitation
                    join jsonb_to_recordset(logins) login(email text) on lower(invitation.invitee_email) = login.email
                   where invitation.status = 'pending' and invitation.expires_at > clock_timestamp()) then
      raise exception using errcode = '55000', message = '0162: SEALED_QA_ADDRESS_TAKEN';
    end if;
    saved_role := current_setting('role');
    if applier <> owner_oid then
      execute format('set local role %I', pg_get_userbyid(owner_oid));
    end if;
    insert into identity.sealed_qa_members (member_kind, member_id)
    select 'account', login.account from jsonb_to_recordset(logins) login(account uuid);
    get diagnostics step = row_count; written := written + step;
    insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system)
    select login.account, login.subject, login.email, login.name, 'pending_reset', clock_timestamp(), 'hid-sealed-qa'
      from jsonb_to_recordset(logins) login(account uuid, subject text, email text, name text);
    get diagnostics step = row_count; written := written + step;
    insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active,
      source_system)
    select login.staff, login.account, login.name, login.email, 'verified', login.role, true, 'hid-sealed-qa'
      from jsonb_to_recordset(logins) login(account uuid, staff uuid, email text, name text, role text);
    get diagnostics step = row_count; written := written + step;
    insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active, source_system)
    select login.membership, login.staff, login.account, qa_hospital_organization, qa_hospital, login.role, login.role,
           true, true, 'hid-sealed-qa'
      from jsonb_to_recordset(logins) login(account uuid, staff uuid, membership uuid, role text);
    get diagnostics step = row_count; written := written + step;
    insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    select login.membership, login.account, login.role, 'facility', login.membership, qa_hospital, qa_role_reason
      from jsonb_to_recordset(logins) login(account uuid, membership uuid, role text);
    get diagnostics step = row_count; written := written + step;
    insert into audit.events (correlation_id, actor_type, facility_id, action, outcome, resource_type, resource_id,
      purpose_of_use, reason, provenance, source_system, details)
    select qa_correlation, 'system', qa_hospital, 'identity.sealed-qa.staff-login-add', 'success', 'staff-membership',
           login.membership::text, 'healthcare-operations', qa_audit_reason, 'migration', 'hid-sealed-qa',
           jsonb_build_object('membershipId', login.membership, 'roleCode', login.role, 'migration', '0162',
             'decision', 'BILL-17 (recommended option)')
      from jsonb_to_recordset(logins) login(membership uuid, role text);
    get diagnostics step = row_count; written := written + step;
    perform set_config('role', saved_role, true);
  end if;

  -- 3. Post-checks.
  if (select md5(string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                            order by grant_row.role_code collate "C", grant_row.permission_code collate "C"))
        from auth.role_permissions grant_row
       where grant_row.permission_code in (select value->>0 from jsonb_array_elements(new_codes)))
     is distinct from rows_md5 then
    raise exception using errcode = '55000', message = '0162: post-check failed: the 58 rows of the new codes';
  end if;
  if (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                        ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
        from auth.role_permissions grant_row
       where grant_row.permission_code not in (select value->>0 from jsonb_array_elements(new_codes)))
     is distinct from rows_before
     or (select count(*) from auth.role_permissions grant_row
          where grant_row.permission_code in (select value->>0 from jsonb_array_elements(new_codes))) <> 58
     or (select count(*) from auth.role_permissions grant_row
          where grant_row.role_code in ('cashier', 'billing_officer')
            and grant_row.permission_code not like 'billing.%') <> 0 then
    raise exception using errcode = '55000', message = '0162: post-check failed: the role table';
  end if;
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = to_regprocedure('identity.staff_invitable_roles(text,text)')) is distinct from invitable_after_md5 then
    raise exception using errcode = '55000', message = '0162: post-check failed: identity.staff_invitable_roles';
  end if;
  select string_agg(fn.value->>'f', ', ') into missing
    from jsonb_array_elements(role_functions) fn
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(fn.value->>'f'))
         is distinct from fn.value->>'after';
  if missing is not null then
    raise exception using errcode = '55000', message = '0162: post-check failed: ' || missing;
  end if;
  select string_agg(pinned.key, ', ' order by pinned.key) into missing
    from jsonb_each_text(function_settings) pinned
   where (select proc.prosecdef::text || '|' || coalesce(array_to_string(proc.proconfig, ';'), '') || '|'
                  || coalesce((select string_agg(granted.entry, ',' order by granted.entry collate "C")
                                 from (select case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
                                                || ':' || acl.privilege_type as entry
                                         from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                                        where acl.grantee <> proc.proowner) granted), '')
             from pg_proc proc where proc.oid = to_regprocedure(pinned.key)) is distinct from pinned.value
      or (select proc.proowner from pg_proc proc where proc.oid = to_regprocedure(pinned.key)) is distinct from owner_oid;
  if missing is not null then
    raise exception using errcode = '55000',
      message = '0162: post-check failed: these role functions'' owner, SECURITY DEFINER, search_path or grants: ' || missing;
  end if;
  if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
       where constraint_row.conrelid = 'identity.staff_invitations'::regclass and constraint_row.convalidated
         and constraint_row.conname = 'staff_invitations_role_code_check') is distinct from role_check_after
     or (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
          where constraint_row.conrelid = 'identity.staff_invitations'::regclass and constraint_row.convalidated
            and constraint_row.conname = 'staff_invitations_licence_ck') is distinct from licence_check_after then
    raise exception using errcode = '55000', message = '0162: post-check failed: the invitation role checks';
  end if;
  if exists (select 1 from pg_namespace namespace,
               lateral aclexplode(coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))) acl
              where namespace.nspname = 'commercial' and acl.grantee <> namespace.nspowner)
     or (select nspowner from pg_namespace where nspname = 'commercial') <> applier then
    raise exception using errcode = '55000', message = '0162: post-check failed: schema commercial';
  end if;
  if (select count(*) from audit.events event_row
       where event_row.correlation_id = correlation and event_row.actor_type = 'system'
         and event_row.actor_account_id is null and event_row.actor_membership_id is null
         and event_row.facility_id is null and event_row.patient_id is null) <> 77 then
    raise exception using errcode = '55000', message = '0162: post-check failed: the audit rows';
  end if;
  if installed then
    if written <> 12
       or (select count(*)
             from jsonb_to_recordset(logins) login(account uuid, staff uuid, membership uuid, role text)
             join auth.accounts account on account.id = login.account and account.status = 'pending_reset'
              and account.password_hash is null
            where identity.sealed_qa_account(login.account)
              and (select count(*) from identity.staff_facility_memberships membership
                    where membership.account_id = login.account) = 1
              and (select count(*) from auth.account_roles assignment where assignment.account_id = login.account) = 1
              and exists (select 1 from auth.account_roles assignment
                           where assignment.id = login.membership and assignment.role_code = login.role
                             and assignment.facility_id = qa_hospital and assignment.revoked_at is null)) <> 2
       or (select count(*) from audit.events event_row where event_row.correlation_id = qa_correlation) <> 2 then
      raise exception using errcode = '55000', message = '0162: post-check failed: the two QA logins are not as written';
    end if;
  elsif exists (select 1 from jsonb_to_recordset(logins) login(account uuid)
                 where exists (select 1 from auth.accounts account where account.id = login.account))
        or exists (select 1 from audit.events event_row where event_row.correlation_id = qa_correlation) then
    raise exception using errcode = '55000', message = '0162: post-check failed: QA rows written without the QA tenant';
  end if;

  raise notice '0162: 17 codes, roles cashier and billing_officer, 58 role rows, 77 audit rows; the two roles are given like the front desk (no licence)%.',
    case when installed then '; QA Cashier and QA Billing Officer at QA Hospital (pending_reset)' else '' end;
end
$bill1$;
