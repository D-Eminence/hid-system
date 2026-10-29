-- 0098 Sealed demo tenant (owner decision of 2026-10-29, "Sealed demo, yes";
-- the declaration signed separately): four demo facilities in production that
-- testers sign in to without creating accounts, sealed off from every real
-- patient, facility and person. Production has no separate staging backend
-- (its resources are named hid-staging-*), so the demo lives beside real
-- tenants and the seal is enforced in the database, where access is.
--
-- Decisions:
-- D1 One new owner-only table, identity.sealed_demo_members (kind, id), marks
--    the demo organizations, facilities, accounts and patients. No live table
--    gains a column.
-- D2 One pair rule: a facility and a patient may be linked only if both are
--    demo or neither is; so may an account and a facility. It is enforced
--    where links are made: consent grants, staff memberships, platform roles,
--    order routes, the two directories, the Health ID lookups and the
--    addresses a demo patient types. The read gates
--    (identity.has_active_consent_grant, ehr.context_allows,
--    ehr.order_route_access_allows) are unchanged: they follow grants and
--    routes, which can no longer cross the boundary.
-- D3 This file always installs the table, the helpers and the seal. It seeds
--    the demo tenant only on Amazon RDS (where the role rds_superuser exists):
--    production is the only RDS PostgreSQL instance; CI, acceptance, the
--    staging upgrade rehearsal and throwaway clusters are plain PostgreSQL 16
--    and get the seal only, so every existing suite and gate is unchanged
--    (one counts organizations; the TUF rehearsal compares every historical
--    table before and after the upgrade).
-- D4 Demo organizations are governed: none has a self-service application.
--    Demo Laboratory and Demo Pharmacy each get an approved admin_review
--    application and their product (laboratory, pharmacy), which an order's
--    receiving facility needs (identity.order_route_destination_eligible).
-- D5 The three accounts are seeded pending_reset, without a password, their
--    email verified. The owner sets each password through the normal
--    forgot-password flow to the owner's mailboxes; recovery is unchanged
--    (auth.complete_recovery_otp accepts pending_reset and makes the account
--    active). No password or password hash is in this file.
-- D6 Patient One and Patient Two each share their record with the demo login
--    at Demo Hospital (doctor) and at Demo Outreach (nurse): the install
--    writes the consent grant and share row the patient's own Share action
--    writes (identity.write_patient_share's values, column for column: level
--    clinical_collaboration, until revoked, which is 365 days of direct-care
--    write_records, granted by the patient, so the patient can revoke it in
--    the portal), but the audit tells the truth: the patients did not share,
--    the migration did. So no audit row names a patient as its actor; each
--    share has one row of the migration's own (actor system, provenance
--    migration, source system hid-sealed-demo, action
--    identity.sealed-demo.seed-share, correlation id
--    0098-sealed-demo-install, the grant as its resource, the patient and
--    facility as its subject). Testers
--    write in those two charts from the first day: visits, notes, vitals,
--    orders, outreach links, documents. These four shares are the only
--    grants seeded. The eight fictional patients have no login, so no
--    consent: they can only be looked up and break-glassed, and break-glass
--    is a read-only emergency summary (has_active_consent_grant gives it
--    read_records for the emergency purpose only); their charts are empty.
--    Approving requests, new shares, the PIN, emergency contacts and
--    invitations are patient actions that Identity holds for 24 hours after
--    any OTP recovery (live rule, unchanged), so they are tested once the
--    owner's password resets are a day old. Nothing is sent and no real
--    limit changes.
-- D7 Demo Health IDs have 8 characters and start ZDEM (the generator issues
--    6 since 2026-10-27 and 16 before); the install refuses any that is
--    taken.
-- D8 Every QoreID quota consumption by a demo account is refused, so demo
--    activity never causes a paid QoreID lookup.
-- D9 The platform overview counts real tenants only. The admin console marks
--    the demo tenant in every list that shows it (Identity, not this file):
--    the facility list and detail, the principals list, search and CSV
--    export, the identity reviews, the platform audit events, the order-route
--    search and the wrong-patient reports (through identity.sealed_demo_ids
--    and identity.sealed_demo_facility) and the organization applications
--    (through identity.sealed_demo_application) say demo: true.
-- D10 The install refuses (SEALED_DEMO_ADDRESS_TAKEN) while a demo address is
--    named by an open organization application (its first administrator) or
--    a pending staff invitation: seeding the account would break that
--    application's approval or that invitation's acceptance.
-- D11 A demo patient's emergency contact is checked in the database too (G7):
--    it refuses an SMS contact, and an email contact added in a transaction
--    where identity.sealed_demo_contact_allowed did not record that
--    contact's HMAC (an Identity before 0098 never asks it). The database
--    holds only the contact's HMAC and ciphertext, so it cannot tell whether
--    either belongs to the address the check was given, and any session can
--    set hid.sealed_demo_contact_hmac itself. That the destination is one of
--    the three demo mailboxes rests on Identity
--    (EmergencyContactService.add computes the HMAC from the same normalized
--    address it checks and encrypts).
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0097 applied (0097's table among the
--    objects checked; the ledger is not read, so a dry run of several pending
--    files passes) and every object relied on exists (else "0098: 0001-0097
--    must be applied first"); no object of this file exists (else "0098:
--    already applied"); the eight bodies replaced in section 5 and the 13
--    bodies the new ones call or rely on are byte for byte the ones 0001-0097
--    gave them, and the 41 bodies the order-route suites pin are unchanged
--    (md5 of pg_proc.prosrc); identity.patients has its six policies and
--    patients_registration_read reads as 0011 wrote it; the indexes, CHECKs,
--    roles, purpose of use and columns the seed and the seal rely on are as
--    0001-0097 made them; no table the seed reads forces row-level security,
--    except identity.staff_invitations, whose forced policies must let the
--    applier read every row, and identity.patient_consent_shares, whose
--    forced policy must let the applier read and insert every row; the
--    applying role, which will own every new
--    object, owns (or is a member of the owners of) the eight replaced
--    functions, identity.patients, the seven tables that get a trigger and
--    every table the seed reads or writes (identity.patient_consent_shares
--    among them), may create in schema identity, read the role and
--    permission tables and insert into audit.events, and each replaced
--    function's owner holds the applier's privileges (so the replaced bodies
--    may call the new helpers). Every attribute of the replaced functions but
--    the body is recorded and compared after the replacement (section 7).
-- 1. SHARE ROW EXCLUSIVE on the seven tables that get a trigger, up front
--    (see Locks).
-- 2. identity.sealed_demo_members: (member_kind organization, facility,
--    account or patient; member_id; recorded_at), primary key (kind, id), no
--    foreign key (no lock on a live table), row-level security enabled (not
--    forced) with one policy for its owner, no grant to any role, and two
--    triggers that refuse updates, deletes and TRUNCATE
--    (platform.reject_mutation). Not forced: the owner bypasses the policy,
--    so a helper owned by the table's owner always reads every member, and a
--    helper whose owner has lost access fails with 42501 instead of
--    answering "not demo" (if the table, the helpers or the applying role
--    ever change hands or names, the seal fails closed).
-- 3. Helpers, each with search_path pg_catalog, pg_temp, revoked from PUBLIC:
--    identity.sealed_demo_ids(kind) (the ids of a kind, as a sorted array)
--    and identity.sealed_demo_facility(id), SQL SECURITY DEFINER, EXECUTE for
--    hid_identity_runtime and hid_schema_test_runtime (identity.patients'
--    policy calls them as the reader; the admin lists read them);
--    identity.sealed_demo_application(id) (whether an organization
--    application is a demo facility's; the same EXECUTE, for the admin
--    applications list); identity.sealed_demo_patient(id) and
--    identity.sealed_demo_account(id), the owner's; identity.
--    sealed_demo_recipient(address), immutable SQL: an exact allowlist, true
--    only for operations@healthidentitydirectory.com,
--    patient1@healthidentitydirectory.com and
--    patient2@healthidentitydirectory.com (any case, outer blanks trimmed),
--    the owner's three mailboxes, the demo logins' own addresses; no pattern
--    and no plus-address; identity.sealed_demo_contact_allowed(subject,
--    session, channel, destination, destination HMAC), volatile, for
--    Identity's emergency-contact check (42501 without a live patient
--    session; true unless the patient is demo and the contact is not an
--    email to a demo mailbox with a well-formed HMAC (64 lowercase hex
--    characters); when it is true for a demo patient it records the HMAC in
--    hid.sealed_demo_contact_hmac for the rest of the transaction, which G7
--    requires); and identity.sealed_demo_install(),
--    the seed (section 10), the owner's.
-- 4. Seven triggers, each BEFORE, FOR EACH ROW, its function SECURITY DEFINER
--    and the owner's:
--    G1 consent_grants_sealed_demo (insert, or update of patient_id,
--       membership_id or facility_id): the grant's facility (or its
--       membership's) and its patient must both be demo or both real; else
--       42501 SEALED_DEMO_BOUNDARY. Covers every way a grant is written:
--       an approved access request, break-glass, a patient PIN, a patient
--       share or confirmed invitation, legacy cutover. It sorts before
--       consent_grants_self_service_probation, so it refuses first.
--    G2 staff_memberships_sealed_demo (insert, or update of account_id or
--       facility_id): the account and the facility must both be demo or both
--       real; else 42501 SEALED_DEMO_MEMBERSHIP_REFUSED. The demo login can
--       never join a real facility (an invitation or an organization
--       approval naming its address) and no real account a demo one.
--    G3 account_roles_sealed_demo (insert, or update of account_id,
--       scope_type or revoked_at, when an unrevoked platform role): a demo
--       account never holds a platform role; else 42501
--       SEALED_DEMO_PLATFORM_ROLE_REFUSED.
--    G4 patient_share_invitations_sealed_demo (insert, or update of
--       invitee_email or accepted_membership_id): a demo patient invites only
--       a demo mailbox (22023 SHARE_INVITATION_EMAIL_INVALID, the message
--       Identity already answers 400 for); an invitation is accepted only by
--       a membership on the patient's side of the boundary (42501
--       SEALED_DEMO_BOUNDARY).
--    G5 patient_contact_changes_sealed_demo (insert of a phone change): a
--       demo patient never holds a phone (22023 PATIENT_CONTACT_CHANGE_INVALID,
--       which Identity answers 400), so no SMS is ever due for one.
--    G6 qoreid_quota_counters_sealed_demo (insert of an account-scope row):
--       a demo account consumes no QoreID quota (42501
--       QOREID_QUOTA_PERMISSION_DENIED, an existing answer), so it never
--       causes a QoreID call (platform.consume_qoreid_quota upserts that row
--       before every call; a BEFORE INSERT trigger fires on ON CONFLICT too).
--    G7 patient_emergency_contacts_sealed_demo (insert, or update of channel
--       or destination_hmac, of a contact that is not deactivated): for a
--       demo patient it refuses (42501
--       EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED) an SMS contact, and an
--       email contact whose HMAC identity.sealed_demo_contact_allowed did not
--       record in this transaction (so an Identity image before 0098, which
--       never asks the check, adds none). The database holds only the
--       contact's HMAC and ciphertext, so it cannot tell whether either
--       belongs to the address the check was given, and any session can set
--       hid.sealed_demo_contact_hmac itself: that the destination is one of
--       the three demo mailboxes rests on Identity
--       (EmergencyContactService.add computes the HMAC from the same
--       normalized address it checks and encrypts). Deactivation (removal,
--       opt-out, account deletion) is never refused.
-- 5. Eight bodies replaced (CREATE OR REPLACE), each its latest body byte for
--    byte plus one clause that is always true for real tenants:
--    R1 identity.create_access_request (0010), R2
--       identity.activate_break_glass (0031) and R3
--       identity.access_patient_with_pin (0075): the Health ID lookup also
--       requires the actor's facility and the patient to be on the same side;
--       across the boundary the answer is an unknown Health ID's (P0002
--       "Patient is not available" before any lock; for the PIN, verified
--       false with only the actor's window counted and no PIN read), with no
--       request, grant, inbox item or outbox row.
--    R4 ehr.send_order_route (0086): a receiving facility on the other side
--       is ORDER_ROUTE_DESTINATION_INELIGIBLE (routes are inserted only here,
--       so work items, acceptance, returns and corrections follow).
--    R5 identity.search_order_destinations (0086): candidates are on the
--       sender's side only, in the candidate query before its limit.
--    R6 identity.search_share_providers (0095): clinicians are on the
--       patient's side only.
--    R7 identity.start_my_email_change (0094): a demo patient may change to a
--       demo mailbox only; any other address answers 'unavailable' (Identity's
--       409 CONTACT_UNAVAILABLE) with nothing recorded and no code sent.
--    R8 identity.admin_platform_overview (0027): every count leaves the demo
--       tenant out.
-- 6. Grants, here and in runtime-grants.sql: EXECUTE on
--    identity.sealed_demo_ids, identity.sealed_demo_facility,
--    identity.sealed_demo_application and identity.sealed_demo_contact_allowed
--    to hid_identity_runtime and hid_schema_test_runtime; every other new
--    function the owner's alone; nothing on the table. The replaced functions
--    keep their ACLs.
-- 7. Post-checks: the table (row-level security enabled, not forced), its
--    policy and ACL; every new function's owner, SECURITY DEFINER,
--    search_path, volatility and exact ACL; whoever reads identity.patients
--    under its policies may run the two helpers the policy calls; the nine
--    triggers' definitions, enabled 'O'; the replaced functions keep every
--    attribute but the body and have this file's bodies; the 41 pinned
--    bodies are unchanged and the order-route privilege suite's 97 functions
--    are still 97.
-- 8. Comments.
-- 9. Section 0's temporary helper and tables dropped.
-- 10. The seed, on Amazon RDS only (D3): identity.sealed_demo_install(),
--    which refuses (55000, nothing written, the release stops) when
--    operations@healthidentitydirectory.com or either patient address
--    belongs to any account that is not deleted and is not the demo's, to a
--    staff record that is not the demo's, to the first administrator of an
--    open organization application (pending_verification or
--    ready_for_review) or to the invitee of a pending staff invitation that
--    has not expired (SEALED_DEMO_ADDRESS_TAKEN); when a fixed id is held by
--    a row that is not the demo's (SEALED_DEMO_ID_TAKEN); when a slug,
--    facility code, Health ID or CAC is held by a real row
--    (SEALED_DEMO_KEY_TAKEN); or when a demo account has a real membership,
--    a platform role or (the staff login) a patient record
--    (SEALED_DEMO_ACCOUNT_NOT_SEALED); or when a share would be written to a
--    membership the patient could not choose in the share directory
--    (identity.share_provider_eligible's rule, less the active sign-in the
--    owner's password reset gives the staff login: an active staff record,
--    membership, facility and organization, a clinical role, the
--    identity.consent.write permission, no self-service application;
--    SEALED_DEMO_SHARE_INELIGIBLE). It never attaches demo access to an
--    existing account. Rows are inserted ON CONFLICT DO NOTHING and nothing
--    existing is updated (passwords, statuses, names); the four shares (D6)
--    are written once each under the correlation id 0098-sealed-demo-install
--    (a consent grant and a share row each, with the values
--    identity.write_patient_share gives, and one audit row each: actor
--    system, provenance migration, source system hid-sealed-demo, action
--    identity.sealed-demo.seed-share, no patient as actor), and never again
--    (not even after the patient revokes one; nor beside an active share the
--    patient already holds; nothing is replaced or revoked): a second call
--    inserts nothing and answers the same counts. Its own audit row (action
--    identity.sealed-demo.install, the same actor, provenance, source system
--    and correlation id) holds counts only. So the seed writes five audit
--    rows, none of them a patient's.
-- 11. Last, identity.patients' policy patients_registration_read (0011): the
--    same two permission checks, and the row is a demo patient exactly when
--    the current facility is a demo facility. A registration clerk or doctor
--    at a demo facility reads demo patients only, and real staff never read a
--    demo patient; a Health ID across the boundary is then not found
--    (Identity's 404), not forbidden. Both helper calls are InitPlans (once a
--    query). Checked at once: the expression as written here, and still six
--    policies on identity.patients.
--
-- The seeded tenant (source_system hid-sealed-demo on every row that has the
-- column, except the four consent grants, which keep the default hid as
-- every patient share does):
--   Organizations and facilities, each verified and active, Africa/Lagos:
--     Demo Hospital (DEMO-HOSPITAL), Demo Laboratory (DEMO-LABORATORY),
--     Demo Pharmacy (DEMO-PHARMACY), Demo Outreach (DEMO-OUTREACH).
--   The staff login operations@healthidentitydirectory.com ("Demo
--     Operations", verified staff): one membership at each facility with
--     doctor (Hospital), lab (Laboratory), pharmacist (Pharmacy) or nurse
--     (Outreach), and org_admin at each (facility audit pages); no platform
--     role. EHR and Migrate (document upload, lab and pharmacy imports)
--     through doctor; the lab chain and receiving through lab; dispensing and
--     receiving through pharmacist; outreach through nurse. The facility is
--     chosen after sign-in as for any staff member with several facilities.
--   Two patient logins, patient1@healthidentitydirectory.com and
--     patient2@healthidentitydirectory.com (HID-ZDEMAAA2 Demo Patient One,
--     HID-ZDEMAAA3 Demo Patient Two), each
--     sharing with the demo login at Demo Hospital and Demo Outreach (D6),
--     and eight fictional patients without a login or any contact detail
--     (HID-ZDEMBBB2 to HID-ZDEMBBB9, Demo Patient Three to Ten).
--   Before testers start, the owner sets the three passwords once with
--     Forgot password, at least 24 hours before patient approvals, new
--     shares, the PIN, emergency contacts or invitations are tested (the
--     live recovery hold). The logins are shared by every tester: testers
--     never use Forgot password on them (each recovery restarts that
--     patient's 24-hour hold), and five wrong passwords in 15 minutes lock
--     the shared login for 15 minutes for everyone (live rule).
--   What testers do: sign in at ehr., migrate., lab., pharmacy. and
--     outreach. as the staff login and pick a facility. At Demo Hospital
--     (doctor) or Demo Outreach (nurse), open Patient One's or Patient Two's
--     chart through the seeded share and write in it: visits, notes, vitals,
--     lab requests and prescriptions, outreach links, documents (Migrate's
--     document upload, lab and pharmacy imports). Orders go from Demo
--     Hospital to Demo Laboratory or Demo Pharmacy for Patient One or Two (an
--     order's patient needs an active login, live rule V12); the same login
--     switches facility and accepts, returns results or dispenses.
--     Break-glass (emergency purpose, a reason, 5-240 minutes) on any demo
--     patient gives a read-only emergency summary; the eight fictional
--     patients can only be looked up and break-glassed, and their charts are
--     empty. Requests to Patient One or Two are approved by that patient in
--     the patient portal once the 24-hour hold has passed; the patients then
--     also share, set a PIN and add emergency contacts and invitees, each one
--     of the three demo addresses (the allowlist; any other is refused). To
--     test accepting an invitation, the patient invites
--     operations@healthidentitydirectory.com (the staff login's own
--     address), which accepts it at Demo Hospital or Demo Outreach; an
--     invitation to patient1@ or patient2@ is delivered to that mailbox but
--     can never be accepted (acceptance needs a staff login whose own
--     verified address it is). A demo patient's email change is refused for
--     any other address, and each allowlisted address is already a demo
--     login's, so a demo patient keeps its address.
--     Migrate's OCR job creation is not available to testers, nor to any
--     tenant: it needs a healthcare-operations grant, which no portal path
--     issues (a platform-wide limitation tracked separately; this file
--     widens nothing). The owner can see which purposes production has with
--     select code, active from identity.purpose_of_use_codes order by 1.
--
-- Before signing, the owner runs this read-only query on production; every
-- count must be 0 and rds must be 1 (an address already used by one of the
-- owner's own logins, such as a platform administrator, or named by an open
-- application or a pending staff invitation, must be freed first, or the
-- release stops on it):
--   with addresses(address) as (values ('operations@healthidentitydirectory.com'),
--          ('patient1@healthidentitydirectory.com'),
--          ('patient2@healthidentitydirectory.com')),
--        health_ids(hid) as (values ('HID-ZDEMAAA2'), ('HID-ZDEMAAA3'), ('HID-ZDEMBBB2'),
--          ('HID-ZDEMBBB3'), ('HID-ZDEMBBB4'), ('HID-ZDEMBBB5'), ('HID-ZDEMBBB6'), ('HID-ZDEMBBB7'),
--          ('HID-ZDEMBBB8'), ('HID-ZDEMBBB9'))
--   select (select count(*) from auth.accounts a join addresses on lower(a.email) = address
--            where a.status <> 'deleted') as accounts,
--          (select count(*) from identity.staff s join addresses on lower(s.email) = address) as staff,
--          (select count(*) from identity.organization_applications a join addresses
--            on lower(a.administrator_email) = address
--            where a.status in ('pending_verification', 'ready_for_review')) as open_applications,
--          (select count(*) from identity.staff_invitations i join addresses on lower(i.invitee_email) = address
--            where i.status = 'pending' and i.expires_at > now()) as pending_invitations,
--          (select count(*) from identity.patients p join health_ids on upper(p.hid_code) = hid) as patients,
--          (select count(*) from identity.patient_identifiers i join health_ids on upper(i.public_value) = hid
--            where i.identifier_type = 'hid_code') as identifiers,
--          (select count(*) from identity.facilities where upper(code) in ('DEMO-HOSPITAL',
--            'DEMO-LABORATORY', 'DEMO-PHARMACY', 'DEMO-OUTREACH')) as facility_codes,
--          (select count(*) from identity.organizations where lower(slug) in ('sealed-demo-hospital',
--            'sealed-demo-laboratory', 'sealed-demo-pharmacy', 'sealed-demo-outreach')) as slugs,
--          (select count(*) from identity.organization_applications where status <> 'rejected'
--            and cac_registration_number in ('RC00000000000000098002', 'RC00000000000000098003')) as cacs,
--          (select count(*) from (
--             select id from identity.organizations union all select id from identity.facilities
--             union all select id from auth.accounts union all select id from identity.staff
--             union all select id from identity.staff_facility_memberships
--             union all select id from auth.account_roles union all select id from identity.organization_applications
--             union all select id from identity.patients union all select id from identity.patient_identifiers) fixed
--            where fixed.id::text ~ '^98d0000[1-9a]-0000-4000-8000-') as fixed_ids,
--          (select count(*) from pg_roles where rolname = 'rds_superuser') as rds;
--
-- Locks: SHARE ROW EXCLUSIVE on identity.consent_grants,
-- identity.staff_facility_memberships, auth.account_roles,
-- identity.patient_share_invitations, identity.patient_contact_changes,
-- platform.qoreid_quota_counters and identity.patient_emergency_contacts (the
-- triggers), taken up front, and ACCESS EXCLUSIVE on identity.patients (the
-- policy) taken in section 11, the last statement but its check, each NOWAIT
-- every 10 ms for at most 5 seconds (then 55P03 "... stayed busy for 5
-- seconds; run the release again later", nothing applied), held to commit:
-- writes to the seven tables wait for the apply, and reads of
-- identity.patients wait only from section 11 to commit. On production the
-- seed (section 10) takes ROW EXCLUSIVE on the tables it writes (the four
-- shares among them: identity.consent_grants, identity.patient_consent_shares,
-- audit.events).
-- Replacing the eight functions neither waits for nor blocks their calls.
-- The measured locks and timings are in config/production-schema-
-- compatibility.json.
--
-- Old services on this schema: the previous Identity, EHR, Lab and Pharmacy
-- images give real tenants the same answers (every new clause is true for
-- them, and G7 never refuses a real patient's contact). The previous Identity
-- image does not ask identity.sealed_demo_contact_allowed, so G7 refuses
-- every emergency contact a demo patient adds through it (403; nothing is
-- added or sent), and it sends no demo field in the admin lists. The new
-- 42501 refusals arise only on demo paths. Applied migrations 0001 through
-- 0097 are immutable.
--
-- Off switch and removal. To switch the demo off (if the seal is ever found
-- wanting, or testing ends), a platform administrator sets the three demo
-- accounts to disabled and revokes their sessions in the admin console
-- (auth.admin_transition_account, revokeSessions), and suspends Demo
-- Hospital, Demo Laboratory, Demo Pharmacy and Demo Outreach
-- (identity.admin_transition_facility); no trigger of this file stands in the
-- way, and the rows stay sealed (the triggers, the policy and the R1-R8
-- clauses stay in force). Removing the demo needs a new reviewed migration
-- that drops the triggers sealed_demo_members_immutable and
-- sealed_demo_members_no_truncate before deleting the demo rows and their
-- member rows. This file has no down migration, and rolling back the images
-- leaves the seed and the seal in place.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0090's to 0097's helper).
create function pg_temp.sealed_demo_0098_holds(holder oid, object_owner oid, object_acl aclitem[],
  object_type "char", wanted text)
returns boolean
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  with recursive held(role_id) as (
    select holder
    union
    select membership.roleid from pg_catalog.pg_auth_members membership join held on membership.member = held.role_id
  )
  select object_owner in (select held.role_id from held)
    or exists (select 1 from pg_catalog.aclexplode(coalesce(object_acl, pg_catalog.acldefault(object_type, object_owner))) acl
                where acl.privilege_type = wanted
                  and (acl.grantee = 0 or acl.grantee in (select held.role_id from held)))
$$;

-- Every attribute of the eight replaced functions but the body, compared in
-- section 7.
create temporary table sealed_demo_0098_replaced as
  select proc.oid, proc.oid::regprocedure::text as what, proc.proowner, proc.proacl, proc.prolang,
         proc.provolatile, proc.prosecdef, proc.proconfig, proc.prorettype, proc.proretset,
         proc.proargnames, proc.proallargtypes, proc.proargmodes, proc.proargtypes
    from pg_proc proc
   where proc.oid in (to_regprocedure('identity.create_access_request(text,text,text,integer)'),
                      to_regprocedure('identity.activate_break_glass(text,text,integer)'),
                      to_regprocedure('identity.access_patient_with_pin(text,text,integer)'),
                      to_regprocedure('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)'),
                      to_regprocedure('identity.search_order_destinations(text,text)'),
                      to_regprocedure('identity.search_share_providers(text,uuid,text)'),
                      to_regprocedure('identity.start_my_email_change(text,uuid,uuid,text,character,bytea,text,character,text,integer,integer,integer)'),
                      to_regprocedure('identity.admin_platform_overview()'));

-- The bodies the order-route suites pin (order-routes-cannot-complete's 41),
-- checked here and again in section 7.
create temporary table sealed_demo_0098_pins (signature text primary key, digest text not null);
insert into sealed_demo_0098_pins values
  ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'),
  ('auth.account_has_platform_permission(uuid,text)', '2145c72b864abf1b69d23d96265e5ba7'),
  ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
  ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
  ('ehr.close_order_route(uuid,text,text,boolean)', 'd0c8c11573bc3fd5cc764553d55b1820'),
  ('ehr.guard_order_route_mutation()', '6a01bc885cd54f87a1bee8c0ebc100a4'),
  ('ehr.lock_receiving_route(text,uuid,uuid,uuid)', 'b73b01f7ca721adb0de4e834dd566e3a'),
  ('ehr.order_route_access_allows(text,uuid,uuid,text)', '175eff453979c964889283a29bb8f34f'),
  ('ehr.order_route_access_open()', 'd0b8aff4c2a656c30872b95286071457'),
  ('ehr.order_route_allows(uuid,uuid,text)', 'b80c2df6c380f7c7e20d166da94e56d2'),
  ('ehr.order_route_destination_type(text)', '9ce8c8706abc84e98ae3e1c86a24515f'),
  ('ehr.order_route_effective_state(ehr.order_routes)', '934300a9e58a7f6789b1dc24520fabad'),
  ('ehr.order_route_notify_patient(ehr.order_routes,text)', '31a11a44325846699036367b7e56b46e'),
  ('ehr.order_route_receive_permission(text)', '4c9f4acbafb062ff9a2cda113ccad037'),
  ('ehr.order_route_receiver(text)', '61eed3f80f2502aadc338581142214a5'),
  ('ehr.order_route_staff_actor(boolean)', 'b1873dca92164652cc1977a90acb6184'),
  ('ehr.order_route_system_audit(ehr.order_routes,text,text,boolean,jsonb)', '6c54f543a495e35d9ebd029450d49e0a'),
  ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'),
  ('ehr.require_order_route_first_event()', 'ae41186236e61c14f252bfa38a008e6a'),
  ('ehr.write_order_route_change(ehr.order_routes,ehr.order_routes,text,text,text)', 'b11691bfe99d65a93d60eefe0fc8c0c1'),
  ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)', '8b12ce866ee75cce411a2721795ffb92'),
  ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
  ('identity.lock_self_service_application(uuid)', '4eeb309085494a7652c19e7d6365e131'),
  ('identity.order_route_destination_eligible(uuid,text)', '6b274d9be9056cefc831a9fd92040bc6'),
  ('identity.order_route_destination_listed(uuid)', '2a2025d538db2686c1ca5a03e0354923'),
  ('identity.order_route_platform_actor(text[])', '599cccfdba5e9b4c46cde4dd2814a541'),
  ('identity.organization_self_service_state(uuid)', 'c67aa5224b2aa3d95e4415e26787d470'),
  ('identity.patient_account_deletion_due(uuid)', 'b032c1a385770e20e4930534a203863d'),
  ('identity.patient_self_session(text,uuid)', '378cd66a28347ef82a7faee8d2c65a15'),
  ('lab.context_allows(uuid,uuid,text)', '57e689661a6227e34d3bde9562468951'),
  ('lab.patient_self_context(uuid)', '39aeca12d2c59b69877800a9a3a7c50b'),
  ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', '0b5689f31a3ce00f9313fe1e55244fad'),
  ('platform.control_enabled(text)', 'ed17b9d8097417363c0a6343e52aa47f'),
  ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
  ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
  ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
  ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
  ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
  ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
  ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
  ('platform.require_control_enabled(text)', '90887489d15eab24f8f71b145bb02320');

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  -- a. Prerequisites (0001-0097).
  if to_regclass('identity.organizations') is null
     or to_regclass('identity.facilities') is null
     or to_regclass('auth.accounts') is null
     or to_regclass('auth.roles') is null
     or to_regclass('auth.account_roles') is null
     or to_regclass('identity.staff') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('identity.organization_applications') is null
     or to_regclass('identity.organization_products') is null
     or to_regclass('identity.patients') is null
     or to_regclass('identity.patient_identifiers') is null
     or to_regclass('identity.patient_assurance_states') is null
     or to_regclass('identity.registration_cases') is null
     or to_regclass('identity.consent_grants') is null
     or to_regclass('identity.patient_share_invitations') is null
     or to_regclass('identity.patient_contact_changes') is null
     or to_regclass('platform.qoreid_quota_counters') is null
     or to_regclass('identity.patient_emergency_contacts') is null
     or to_regclass('identity.staff_invitations') is null
     or to_regclass('identity.patient_consent_shares') is null
     or to_regclass('identity.purpose_of_use_codes') is null
     or to_regclass('audit.events') is null
     or to_regclass('notification.web_push_subscriptions') is null
     or to_regprocedure('identity.create_access_request(text,text,text,integer)') is null
     or to_regprocedure('identity.activate_break_glass(text,text,integer)') is null
     or to_regprocedure('identity.access_patient_with_pin(text,text,integer)') is null
     or to_regprocedure('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)') is null
     or to_regprocedure('identity.search_order_destinations(text,text)') is null
     or to_regprocedure('identity.search_share_providers(text,uuid,text)') is null
     or to_regprocedure('identity.start_my_email_change(text,uuid,uuid,text,character,bytea,text,character,text,integer,integer,integer)') is null
     or to_regprocedure('identity.admin_platform_overview()') is null
     or to_regprocedure('identity.patient_self_session(text,uuid)') is null
     or to_regprocedure('platform.reject_mutation()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('identity.write_patient_share(uuid,uuid,text,uuid,text,text,text,uuid,text,text)') is null
     or (select count(*) from sealed_demo_0098_replaced) <> 8 then
    raise exception using errcode = '55000', message = '0098: 0001-0097 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('identity.sealed_demo_members') is not null
     or exists (select 1 from pg_trigger trigger_row
                 where not trigger_row.tgisinternal
                   and trigger_row.tgname in ('consent_grants_sealed_demo', 'staff_memberships_sealed_demo',
                     'account_roles_sealed_demo', 'patient_share_invitations_sealed_demo',
                     'patient_contact_changes_sealed_demo', 'qoreid_quota_counters_sealed_demo',
                     'patient_emergency_contacts_sealed_demo', 'sealed_demo_members_immutable',
                     'sealed_demo_members_no_truncate'))
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'identity'
                   and (proc.proname like 'sealed\_demo\_%' or proc.proname like '%\_sealed\_demo')) then
    raise exception using errcode = '55000', message = '0098: already applied';
  end if;
  -- c. The eight bodies replaced in section 5 (as 0010, 0031, 0075, 0086,
  -- 0086, 0095, 0094 and 0027 left them), the 13 bodies the new ones call or
  -- rely on, and the 41 the order-route suites pin.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.create_access_request(text,text,text,integer)', '7d96f075988f5ad86b2ad6e8fb663db1'),
      ('identity.activate_break_glass(text,text,integer)', '9b512cd26038e462385b6cbb30340d09'),
      ('identity.access_patient_with_pin(text,text,integer)', '88c55e2ce17bab0c6ccb4cbe5f9f6723'),
      ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', 'f2578d557ca26b29e24140bbac377ca8'),
      ('identity.search_order_destinations(text,text)', '2aa65629a724112da4ec2dc2b64fcc9d'),
      ('identity.search_share_providers(text,uuid,text)', 'c2530e7a1ae16a91f4a9d931da978c83'),
      ('identity.start_my_email_change(text,uuid,uuid,text,character,bytea,text,character,text,integer,integer,integer)',
       '367d15e7dfdd4d50702dc7ecb51397d1'),
      ('identity.admin_platform_overview()', 'b7b7560a3531ccd6550f25bed562e810'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('identity.patient_self_session(text,uuid)', '378cd66a28347ef82a7faee8d2c65a15'),
      ('identity.order_route_destination_eligible(uuid,text)', '6b274d9be9056cefc831a9fd92040bc6'),
      ('identity.staff_management_actor(boolean)', '677d7d0d0d5e5ebaef13940b1d1ce395'),
      ('platform.consume_qoreid_quota(text,uuid,uuid,character,character)', '5e2aee48fb68322660e4938d15e85c58'),
      ('identity.write_patient_share(uuid,uuid,text,uuid,text,text,text,uuid,text,text)', 'e7bce33a905c66e224f0fb7dff513701'),
      ('identity.accept_share_invitation(uuid)', '1beff9a4a52b8d9d4f4f58a479f5e576'),
      ('identity.approve_access_request(uuid)', 'af9482ccb8b9d9aa8486035478ac4e94'),
      ('identity.change_my_phone(text,uuid,uuid,character,character[],bytea,text,boolean)', 'f6c1f43b077f95e60f8abe77846c38ee'),
      ('auth.complete_recovery_otp(uuid,text,text,text)', '42664ddffa923bab2eb9de6f42456a82'),
      ('identity.current_patient_account(text)', 'c6a720c38e084e19d04147bb1146592d'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is null then
    select string_agg(format('%s md5 %s', pinned.signature, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
      into mismatch
      from sealed_demo_0098_pins pinned
      left join pg_proc proc on proc.oid = to_regprocedure(pinned.signature)
     where md5(proc.prosrc) is distinct from pinned.digest;
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0098: a function this migration replaces or relies on has another body than 0001-0097 gave it: %s', mismatch);
  end if;
  -- d. identity.patients' six policies and the one section 11 rewrites; the
  -- indexes the install's checks and inserts rely on; the CHECKs it relies
  -- on; the five roles it grants; row-level security on the tables it reads.
  if (select array_agg(policy_row.polname::text order by policy_row.polname) from pg_policy policy_row
       where policy_row.polrelid = 'identity.patients'::regclass)
     is distinct from array['patients_governed_enrollment_update', 'patients_public_enrollment_insert',
       'patients_public_enrollment_system_read', 'patients_registration_insert', 'patients_registration_read',
       'patients_staff_read']
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'identity.patients'::regclass
                       and policy_row.polname = 'patients_registration_read'
                       and policy_row.polcmd = 'r' and policy_row.polpermissive
                       and policy_row.polroles = '{0}'::oid[] and policy_row.polwithcheck is null
                       and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                         = '(auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(), platform.current_facility_id(), ''identity.registration.write''::text) OR auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(), platform.current_facility_id(), ''identity.registration.approve''::text))') then
    raise exception using errcode = '55000',
      message = '0098: identity.patients'' policies are not as 0001-0097 left them';
  end if;
  select string_agg(expected.what, '; ') into mismatch
    from (values
      ('accounts_email_ci_uq', 'CREATE UNIQUE INDEX accounts_email_ci_uq ON auth.accounts USING btree (lower(email)) WHERE ((email IS NOT NULL) AND (status <> ''deleted''::text))'),
      ('staff_email_ci_uq', 'CREATE UNIQUE INDEX staff_email_ci_uq ON identity.staff USING btree (lower(email))'),
      ('patients_hid_code_ci_uq', 'CREATE UNIQUE INDEX patients_hid_code_ci_uq ON identity.patients USING btree (upper(hid_code))'),
      ('patient_identifiers_public_uq', 'CREATE UNIQUE INDEX patient_identifiers_public_uq ON identity.patient_identifiers USING btree (identifier_type, upper(public_value)) WHERE (public_value IS NOT NULL)'),
      ('organizations_slug_ci_uq', 'CREATE UNIQUE INDEX organizations_slug_ci_uq ON identity.organizations USING btree (lower(slug))'),
      ('facilities_code_ci_uq', 'CREATE UNIQUE INDEX facilities_code_ci_uq ON identity.facilities USING btree (upper(code))'),
      ('organization_applications_open_cac_product_uq', 'CREATE UNIQUE INDEX organization_applications_open_cac_product_uq ON identity.organization_applications USING btree (cac_registration_number, product_code) WHERE (status <> ''rejected''::text)'))
         expected(what, definition)
   where not exists (select 1 from pg_index index_row
                      where pg_get_indexdef(index_row.indexrelid) = expected.definition);
  if mismatch is null then
    select string_agg(format('%s.%s', expected.relation_name, expected.constraint_name), '; ') into mismatch
      from (values
        ('identity.facilities', 'facilities_active_status_ck', 'CHECK ((active = (lifecycle_status = ''verified''::text)))'),
        ('identity.facilities', 'facilities_lifecycle_status_ck', 'CHECK ((lifecycle_status = ANY (ARRAY[''pending''::text, ''verified''::text, ''rejected''::text, ''suspended''::text])))'),
        ('auth.accounts', 'accounts_status_check', 'CHECK ((status = ANY (ARRAY[''active''::text, ''pending_reset''::text, ''locked''::text, ''disabled''::text, ''deleted''::text])))'),
        ('auth.accounts', 'accounts_check', 'CHECK (((password_hash IS NULL) = (password_algorithm IS NULL)))'),
        ('identity.patients', 'patients_hid_code_check', 'CHECK ((hid_code ~ ''^HID-[A-HJ-NP-Z2-9]{6,32}$''::text))'),
        ('identity.patient_identifiers', 'patient_identifiers_check', 'CHECK ((((identifier_type = ''hid_code''::text) AND (public_value IS NOT NULL) AND (value_ciphertext IS NULL) AND (lookup_hmac IS NULL)) OR ((identifier_type <> ''hid_code''::text) AND (public_value IS NULL) AND (value_ciphertext IS NOT NULL) AND (lookup_hmac IS NOT NULL) AND (encryption_key_version IS NOT NULL))))'),
        ('auth.account_roles', 'account_roles_check1', 'CHECK ((((scope_type = ''platform''::text) AND (membership_id IS NULL) AND (facility_id IS NULL)) OR ((scope_type = ''facility''::text) AND (membership_id IS NOT NULL) AND (facility_id IS NOT NULL))))'),
        ('identity.organization_applications', 'organization_applications_check', 'CHECK (((status <> ALL (ARRAY[''ready_for_review''::text, ''approved''::text])) OR ((verification_result = ''verified''::text) AND (verified_at IS NOT NULL))))'),
        ('identity.organization_applications', 'organization_applications_check1', 'CHECK (((status <> ''approved''::text) OR ((organization_id IS NOT NULL) AND (facility_id IS NOT NULL))))'),
        ('identity.organization_applications', 'organization_applications_verified_legal_name_ck', 'CHECK (((status <> ALL (ARRAY[''ready_for_review''::text, ''approved''::text])) OR ((verification_result = ''verified''::text) AND (verified_at IS NOT NULL) AND (verified_organization_name IS NOT NULL))))'),
        ('identity.organization_applications', 'organization_applications_review_check_self_service', 'CHECK (((status <> ALL (ARRAY[''approved''::text, ''rejected''::text])) OR ((reviewed_at IS NOT NULL) AND (length(btrim(COALESCE(review_reason, ''''::text))) >= 8) AND ((approval_mode = ''self_service''::text) OR (reviewed_by_account_id IS NOT NULL)))))'),
        ('identity.organization_applications', 'organization_applications_cac_registration_number_check', 'CHECK ((cac_registration_number ~ ''^(RC|BN|IT)[0-9]{4,20}$''::text))'),
        ('identity.organization_applications', 'organization_applications_approval_mode_check', 'CHECK ((approval_mode = ANY (ARRAY[''admin_review''::text, ''self_service''::text])))'),
        ('identity.patient_assurance_states', 'patient_assurance_states_state_check', 'CHECK ((state = ANY (ARRAY[''LEGACY_MIGRATED''::text, ''CONTACT_VERIFIED''::text, ''NIN_PENDING''::text, ''NIN_VERIFIED''::text, ''MANUAL_REVIEW''::text])))'),
        ('identity.patient_contact_changes', 'patient_contact_changes_channel_check', 'CHECK ((channel = ANY (ARRAY[''email''::text, ''phone''::text])))'),
        ('platform.qoreid_quota_counters', 'qoreid_quota_counters_scope_type_check', 'CHECK ((scope_type = ANY (ARRAY[''account''::text, ''target''::text])))'),
        ('identity.organization_applications', 'organization_applications_status_check', 'CHECK ((status = ANY (ARRAY[''pending_verification''::text, ''ready_for_review''::text, ''approved''::text, ''rejected''::text])))'),
        ('identity.staff_invitations', 'staff_invitations_status_check', 'CHECK ((status = ANY (ARRAY[''pending''::text, ''accepted''::text, ''revoked''::text, ''expired''::text])))'),
        ('identity.patient_emergency_contacts', 'patient_emergency_contacts_channel_check', 'CHECK ((channel = ANY (ARRAY[''email''::text, ''sms''::text])))'),
        ('identity.patient_emergency_contacts', 'patient_emergency_contacts_status_check', 'CHECK ((status = ANY (ARRAY[''unverified''::text, ''verified''::text, ''deactivated''::text])))'))
           expected(relation_name, constraint_name, definition)
     where not exists (select 1 from pg_constraint constraint_row
                        where constraint_row.conrelid = expected.relation_name::regclass
                          and constraint_row.conname = expected.constraint_name and constraint_row.contype = 'c'
                          and pg_get_constraintdef(constraint_row.oid) = expected.definition);
  end if;
  if mismatch is null
     and not exists (select 1 from pg_constraint constraint_row
                      where constraint_row.conrelid = 'identity.organization_applications'::regclass
                        and constraint_row.conname = 'organization_applications_profile_provenance_ck'
                        and md5(pg_get_constraintdef(constraint_row.oid)) = '960cb8dadf8b29ce9a986d3d761e6aa0') then
    mismatch := 'identity.organization_applications.organization_applications_profile_provenance_ck';
  end if;
  if mismatch is null then
    select string_agg(expected.code, '; ') into mismatch
      from (values ('doctor'), ('lab'), ('pharmacist'), ('nurse'), ('org_admin')) expected(code)
     where not exists (select 1 from auth.roles role_row where role_row.code = expected.code and role_row.active);
  end if;
  if mismatch is null
     and not exists (select 1 from identity.purpose_of_use_codes purpose
                      where purpose.code = 'direct-care' and purpose.active) then
    mismatch := 'identity.purpose_of_use_codes direct-care';
  end if;
  if mismatch is null then
    select string_agg(relation.oid::regclass::text, '; ') into mismatch
      from pg_class relation
     where relation.oid in ('identity.organizations'::regclass, 'identity.facilities'::regclass,
             'auth.accounts'::regclass, 'identity.staff'::regclass, 'identity.staff_facility_memberships'::regclass,
             'auth.account_roles'::regclass, 'identity.organization_applications'::regclass,
             'identity.organization_products'::regclass, 'identity.patients'::regclass,
             'identity.patient_identifiers'::regclass, 'identity.patient_assurance_states'::regclass,
             'identity.consent_grants'::regclass, 'audit.events'::regclass)
       and (relation.relforcerowsecurity
         or (relation.oid = 'identity.patients'::regclass and not relation.relrowsecurity));
  end if;
  -- identity.staff_invitations forces row-level security (0086); the install
  -- reads it as the applier, so a permissive policy for every role must show
  -- the applier every row (true, or the applier's own name).
  if mismatch is null
     and exists (select 1 from pg_class relation
                  where relation.oid = 'identity.staff_invitations'::regclass and relation.relrowsecurity)
     and not exists (select 1 from pg_policy policy_row
                      where policy_row.polrelid = 'identity.staff_invitations'::regclass
                        and policy_row.polpermissive and policy_row.polcmd in ('r', '*')
                        and policy_row.polroles = '{0}'::oid[]
                        and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                          in ('true', format('(CURRENT_USER = %L::name)', current_user))) then
    mismatch := 'identity.staff_invitations row-level security hides rows from the applier';
  end if;
  -- identity.patient_consent_shares forces row-level security too (0095); the
  -- install reads and inserts its share rows as the applier, so a permissive
  -- policy for every role and every command must admit the applier (true, or
  -- the applier's own name) in both its USING and its WITH CHECK.
  if mismatch is null
     and exists (select 1 from pg_class relation
                  where relation.oid = 'identity.patient_consent_shares'::regclass and relation.relrowsecurity)
     and not exists (select 1 from pg_policy policy_row
                      where policy_row.polrelid = 'identity.patient_consent_shares'::regclass
                        and policy_row.polpermissive and policy_row.polcmd = '*'
                        and policy_row.polroles = '{0}'::oid[]
                        and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                          in ('true', format('(CURRENT_USER = %L::name)', current_user))
                        and coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid),
                              pg_get_expr(policy_row.polqual, policy_row.polrelid))
                          in ('true', format('(CURRENT_USER = %L::name)', current_user))) then
    mismatch := 'identity.patient_consent_shares row-level security hides rows from the applier or refuses its inserts';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0098: an index, CHECK, role or row-level security setting this migration relies on differs from 0001-0097: %s', mismatch);
  end if;
  -- e. The columns the install writes and compares, as 0001-0097 made them.
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('identity.organizations', 'id', 'uuid', true), ('identity.organizations', 'name', 'text', true),
      ('identity.organizations', 'slug', 'text', true), ('identity.organizations', 'active', 'boolean', true),
      ('identity.organizations', 'source_system', 'text', true),
      ('identity.facilities', 'id', 'uuid', true), ('identity.facilities', 'organization_id', 'uuid', true),
      ('identity.facilities', 'name', 'text', true), ('identity.facilities', 'code', 'text', true),
      ('identity.facilities', 'active', 'boolean', true), ('identity.facilities', 'timezone', 'text', true),
      ('identity.facilities', 'lifecycle_status', 'text', true), ('identity.facilities', 'status_reason', 'text', false),
      ('identity.facilities', 'source_system', 'text', true),
      ('auth.accounts', 'id', 'uuid', true), ('auth.accounts', 'subject', 'text', true),
      ('auth.accounts', 'email', 'text', false), ('auth.accounts', 'display_name', 'text', false),
      ('auth.accounts', 'status', 'text', true), ('auth.accounts', 'password_hash', 'text', false),
      ('auth.accounts', 'email_verified_at', 'timestamp with time zone', false),
      ('auth.accounts', 'source_system', 'text', true),
      ('identity.staff', 'id', 'uuid', true), ('identity.staff', 'account_id', 'uuid', true),
      ('identity.staff', 'full_name', 'text', true), ('identity.staff', 'email', 'text', true),
      ('identity.staff', 'verification_status', 'text', true), ('identity.staff', 'default_role', 'text', true),
      ('identity.staff', 'active', 'boolean', true), ('identity.staff', 'source_system', 'text', true),
      ('identity.staff_facility_memberships', 'id', 'uuid', true),
      ('identity.staff_facility_memberships', 'staff_id', 'uuid', true),
      ('identity.staff_facility_memberships', 'account_id', 'uuid', true),
      ('identity.staff_facility_memberships', 'organization_id', 'uuid', true),
      ('identity.staff_facility_memberships', 'facility_id', 'uuid', false),
      ('identity.staff_facility_memberships', 'membership_role', 'text', true),
      ('identity.staff_facility_memberships', 'app_role', 'text', true),
      ('identity.staff_facility_memberships', 'is_primary', 'boolean', true),
      ('identity.staff_facility_memberships', 'active', 'boolean', true),
      ('identity.staff_facility_memberships', 'source_system', 'text', true),
      ('auth.account_roles', 'id', 'uuid', true), ('auth.account_roles', 'account_id', 'uuid', true),
      ('auth.account_roles', 'role_code', 'text', true), ('auth.account_roles', 'scope_type', 'text', true),
      ('auth.account_roles', 'membership_id', 'uuid', false), ('auth.account_roles', 'facility_id', 'uuid', false),
      ('auth.account_roles', 'granted_by', 'uuid', false), ('auth.account_roles', 'revoked_at', 'timestamp with time zone', false),
      ('auth.account_roles', 'grant_reason', 'text', true),
      ('identity.organization_applications', 'id', 'uuid', true),
      ('identity.organization_applications', 'product_code', 'text', true),
      ('identity.organization_applications', 'organization_name', 'text', false),
      ('identity.organization_applications', 'organization_type', 'text', true),
      ('identity.organization_applications', 'cac_registration_number', 'text', true),
      ('identity.organization_applications', 'administrator_name', 'text', true),
      ('identity.organization_applications', 'administrator_email', 'text', true),
      ('identity.organization_applications', 'status', 'text', true),
      ('identity.organization_applications', 'verification_result', 'text', false),
      ('identity.organization_applications', 'verified_at', 'timestamp with time zone', false),
      ('identity.organization_applications', 'organization_id', 'uuid', false),
      ('identity.organization_applications', 'facility_id', 'uuid', false),
      ('identity.organization_applications', 'first_admin_account_id', 'uuid', false),
      ('identity.organization_applications', 'reviewed_by_account_id', 'uuid', false),
      ('identity.organization_applications', 'review_reason', 'text', false),
      ('identity.organization_applications', 'reviewed_at', 'timestamp with time zone', false),
      ('identity.organization_applications', 'verified_organization_name', 'text', false),
      ('identity.organization_applications', 'approval_mode', 'text', true),
      ('identity.organization_products', 'organization_id', 'uuid', true),
      ('identity.organization_products', 'product_code', 'text', true),
      ('identity.organization_products', 'facility_id', 'uuid', true),
      ('identity.organization_products', 'status', 'text', true),
      ('identity.organization_products', 'source_application_id', 'uuid', true),
      ('identity.patients', 'id', 'uuid', true), ('identity.patients', 'account_id', 'uuid', false),
      ('identity.patients', 'hid_code', 'text', true), ('identity.patients', 'first_name', 'text', true),
      ('identity.patients', 'last_name', 'text', true), ('identity.patients', 'full_name', 'text', true),
      ('identity.patients', 'gender', 'text', false), ('identity.patients', 'dob', 'date', false),
      ('identity.patients', 'status', 'text', true), ('identity.patients', 'source_system', 'text', true),
      ('identity.patient_identifiers', 'id', 'uuid', true), ('identity.patient_identifiers', 'patient_id', 'uuid', true),
      ('identity.patient_identifiers', 'identifier_type', 'text', true),
      ('identity.patient_identifiers', 'public_value', 'text', false),
      ('identity.patient_identifiers', 'verified', 'boolean', true),
      ('identity.patient_identifiers', 'source_system', 'text', true),
      ('identity.patient_assurance_states', 'patient_id', 'uuid', true),
      ('identity.patient_assurance_states', 'account_id', 'uuid', true),
      ('identity.patient_assurance_states', 'state', 'text', true),
      ('identity.patient_assurance_states', 'source_system', 'text', true),
      ('identity.patient_assurance_states', 'contact_verified_at', 'timestamp with time zone', false),
      ('identity.consent_grants', 'patient_id', 'uuid', true), ('identity.consent_grants', 'membership_id', 'uuid', true),
      ('identity.consent_grants', 'facility_id', 'uuid', false),
      ('identity.consent_grants', 'id', 'uuid', true), ('identity.consent_grants', 'request_id', 'uuid', false),
      ('identity.consent_grants', 'staff_id', 'uuid', true), ('identity.consent_grants', 'account_id', 'uuid', true),
      ('identity.consent_grants', 'scope', 'text', true), ('identity.consent_grants', 'status', 'text', true),
      ('identity.consent_grants', 'granted_by_patient_id', 'uuid', false),
      ('identity.consent_grants', 'reason', 'text', true),
      ('identity.consent_grants', 'starts_at', 'timestamp with time zone', true),
      ('identity.consent_grants', 'expires_at', 'timestamp with time zone', true),
      ('identity.consent_grants', 'break_glass', 'boolean', true),
      ('identity.consent_grants', 'purpose_of_use', 'text', false),
      ('identity.consent_grants', 'authorization_method', 'text', false),
      ('identity.patient_consent_shares', 'consent_grant_id', 'uuid', true),
      ('identity.patient_consent_shares', 'patient_id', 'uuid', true),
      ('identity.patient_consent_shares', 'membership_id', 'uuid', true),
      ('identity.patient_consent_shares', 'level', 'text', true),
      ('identity.patient_consent_shares', 'duration_preset', 'text', true),
      ('identity.patient_consent_shares', 'created_via', 'text', true),
      ('identity.patient_consent_shares', 'invitation_id', 'uuid', false),
      ('identity.patient_consent_shares', 'replaced_consent_grant_id', 'uuid', false),
      ('identity.patient_consent_shares', 'idempotency_key', 'text', false),
      ('identity.patient_consent_shares', 'request_sha256', 'character(64)', false),
      ('identity.staff_facility_memberships', 'migration_hold_reason', 'text', false),
      ('auth.roles', 'code', 'text', true), ('auth.roles', 'active', 'boolean', true),
      ('auth.role_permissions', 'role_code', 'text', true), ('auth.role_permissions', 'permission_code', 'text', true),
      ('auth.permissions', 'code', 'text', true), ('auth.permissions', 'active', 'boolean', true),
      ('identity.patient_share_invitations', 'patient_id', 'uuid', true),
      ('identity.patient_share_invitations', 'invitee_email', 'text', true),
      ('identity.patient_share_invitations', 'accepted_membership_id', 'uuid', false),
      ('identity.patient_contact_changes', 'patient_id', 'uuid', true),
      ('identity.patient_contact_changes', 'channel', 'text', true),
      ('platform.qoreid_quota_counters', 'scope_type', 'text', true),
      ('platform.qoreid_quota_counters', 'scope_id', 'uuid', true),
      ('identity.registration_cases', 'facility_id', 'uuid', true),
      ('identity.consent_grants', 'correlation_id', 'text', false),
      ('identity.staff_invitations', 'invitee_email', 'text', true),
      ('identity.staff_invitations', 'status', 'text', true),
      ('identity.staff_invitations', 'expires_at', 'timestamp with time zone', true),
      ('identity.patient_emergency_contacts', 'patient_id', 'uuid', true),
      ('identity.patient_emergency_contacts', 'channel', 'text', true),
      ('identity.patient_emergency_contacts', 'destination_hmac', 'character(64)', false),
      ('identity.patient_emergency_contacts', 'status', 'text', true))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = expected.relation_name::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0098: a column this migration relies on differs from 0001-0097: %s', mismatch);
  end if;
  -- f. Privileges, never through a superuser's bypass (production's migrator
  -- has none). The applier owns (or is a member of the owners of) the eight
  -- replaced functions, identity.patients (its policy), the seven tables
  -- that get a trigger and every table the install reads or writes (so that
  -- row-level security, enabled but not forced on some of them, hides no
  -- row from the install; identity.patient_consent_shares among them, whose
  -- forced policy is checked above), and may read the role and permission
  -- tables (the shares' eligibility) and insert into audit.events; each
  -- replaced function's owner holds the applier's privileges, so that the
  -- replaced bodies may call the new helpers, which the applier owns.
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s does not own %s', holder.rolname, relation.oid::regclass) as what
        from pg_class relation
        join pg_roles holder on holder.oid = applier
       where relation.oid in ('identity.patients'::regclass, 'identity.consent_grants'::regclass,
               'identity.staff_facility_memberships'::regclass, 'auth.account_roles'::regclass,
               'identity.patient_share_invitations'::regclass, 'identity.patient_contact_changes'::regclass,
               'platform.qoreid_quota_counters'::regclass, 'identity.organizations'::regclass,
               'identity.facilities'::regclass, 'auth.accounts'::regclass, 'identity.staff'::regclass,
               'identity.organization_applications'::regclass, 'identity.organization_products'::regclass,
               'identity.patient_identifiers'::regclass, 'identity.patient_assurance_states'::regclass,
               'identity.registration_cases'::regclass, 'identity.patient_emergency_contacts'::regclass,
               'identity.staff_invitations'::regclass, 'identity.patient_consent_shares'::regclass)
         and not pg_temp.sealed_demo_0098_holds(applier, relation.relowner, null::aclitem[], 'r', 'OWNER')
      union all
      select format('%s lacks %s on %s', holder.rolname, wanted.privilege, relation.oid::regclass)
        from (values ('audit.events', 'INSERT'), ('auth.roles', 'SELECT'), ('auth.role_permissions', 'SELECT'),
                     ('auth.permissions', 'SELECT')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
        join pg_roles holder on holder.oid = applier
       where not pg_temp.sealed_demo_0098_holds(applier, relation.relowner, relation.relacl, 'r', wanted.privilege)
      union all
      select format('%s lacks %s on schema %s', holder.rolname, wanted.privilege, namespace.nspname)
        from (values ('identity', 'CREATE'), ('identity', 'USAGE'), ('auth', 'USAGE'), ('platform', 'USAGE'),
                     ('audit', 'USAGE'), ('ehr', 'USAGE')) wanted(schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
        join pg_roles holder on holder.oid = applier
       where not pg_temp.sealed_demo_0098_holds(applier, namespace.nspowner, namespace.nspacl, 'n', wanted.privilege)
      union all
      select format('%s lacks EXECUTE on %s', holder.rolname, proc.oid::regprocedure)
        from (values ('identity.patient_self_session(text,uuid)'), ('platform.reject_mutation()'),
                     ('platform.current_facility_id()')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
        join pg_roles holder on holder.oid = applier
       where not pg_temp.sealed_demo_0098_holds(applier, proc.proowner, proc.proacl, 'f', 'EXECUTE')
      union all
      select format('%s may not replace %s (owner %s)', current_user, replaced.what, pg_get_userbyid(replaced.proowner))
        from sealed_demo_0098_replaced replaced
       where not pg_temp.sealed_demo_0098_holds(applier, replaced.proowner, null::aclitem[], 'f', 'OWNER')
      union all
      select format('%s (owner of %s) would not hold %s''s helpers', pg_get_userbyid(replaced.proowner), replaced.what,
               current_user)
        from sealed_demo_0098_replaced replaced
       where not pg_temp.sealed_demo_0098_holds(replaced.proowner, applier, null::aclitem[], 'f', 'OWNER')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0098: missing privileges: %s', mismatch);
  end if;
  raise notice '0098: owners checked: %', (
    select string_agg(format('%s=%s', owned.what, owned.owner), ', ' order by owned.what)
      from (select replaced.what, pg_get_userbyid(replaced.proowner) as owner from sealed_demo_0098_replaced replaced
            union all
            select relation.oid::regclass::text, pg_get_userbyid(relation.relowner) from pg_class relation
             where relation.oid in ('identity.patients'::regclass, 'identity.consent_grants'::regclass,
                     'identity.staff_facility_memberships'::regclass, 'auth.account_roles'::regclass,
                     'identity.patient_share_invitations'::regclass, 'identity.patient_contact_changes'::regclass,
                     'platform.qoreid_quota_counters'::regclass, 'identity.patient_emergency_contacts'::regclass)
            union all
            select 'new table and functions', current_user::text) owned);
end
$$;

-- 1. The locks the seven triggers take, up front and bounded.
do $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table identity.consent_grants, identity.staff_facility_memberships, auth.account_roles,
        identity.patient_share_invitations, identity.patient_contact_changes, platform.qoreid_quota_counters,
        identity.patient_emergency_contacts
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0098: a table that gets a sealed demo trigger stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 2. The demo tenant's members. No foreign key: a lock on no live table, and
-- a member row outlives nothing (members are never updated, deleted or
-- truncated). Row-level security is enabled but not forced: the owner
-- bypasses the policy, so the helpers (the owner's) always read every member,
-- and a helper whose owner has lost access raises 42501 rather than answering
-- "not demo".
create table identity.sealed_demo_members (
  member_kind text not null check (member_kind in ('organization', 'facility', 'account', 'patient')),
  member_id uuid not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (member_kind, member_id)
);
create trigger sealed_demo_members_immutable
  before update or delete on identity.sealed_demo_members
  for each row execute function platform.reject_mutation();
create trigger sealed_demo_members_no_truncate
  before truncate on identity.sealed_demo_members
  for each statement execute function platform.reject_mutation();
alter table identity.sealed_demo_members enable row level security;
do $$
begin
  execute format('create policy sealed_demo_members_owner on identity.sealed_demo_members '
    || 'for all using (current_user = %L) with check (current_user = %L)', current_user, current_user);
end
$$;
revoke all on identity.sealed_demo_members from public;

-- 3. Helpers.
create function identity.sealed_demo_ids(requested_kind text)
returns uuid[]
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(array_agg(member.member_id order by member.member_id), '{}'::uuid[])
    from identity.sealed_demo_members member
   where member.member_kind = requested_kind
$$;

create function identity.sealed_demo_facility(requested_facility_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from identity.sealed_demo_members member
                  where member.member_kind = 'facility' and member.member_id = requested_facility_id)
$$;

create function identity.sealed_demo_patient(requested_patient_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from identity.sealed_demo_members member
                  where member.member_kind = 'patient' and member.member_id = requested_patient_id)
$$;

create function identity.sealed_demo_account(requested_account_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from identity.sealed_demo_members member
                  where member.member_kind = 'account' and member.member_id = requested_account_id)
$$;

-- The owner's mailboxes, an exact allowlist of three addresses (the demo
-- logins' own): no pattern, no plus-address. Any case, outer blanks trimmed.
create function identity.sealed_demo_recipient(requested_address text)
returns boolean
language sql immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(lower(btrim(requested_address)) in ('operations@healthidentitydirectory.com',
    'patient1@healthidentitydirectory.com', 'patient2@healthidentitydirectory.com'), false)
$$;

-- Identity's check before a patient adds an emergency contact (the database
-- holds only the contact's ciphertext and HMAC, so Identity asks with the
-- normalized destination and its HMAC): true unless the live session's
-- patient is a demo patient and the contact is not an email to one of the
-- owner's mailboxes with a well-formed HMAC (64 lowercase hex characters).
-- When it is true for a demo patient, the HMAC it was given is recorded in
-- hid.sealed_demo_contact_hmac for the rest of the transaction, and G7
-- admits a demo patient's email contact only with the recorded HMAC. It
-- cannot verify that the HMAC is the given address's, and any session can
-- set that setting itself: that a demo patient's contact is a demo mailbox
-- rests on Identity, which computes the HMAC from the same normalized
-- address it checks and encrypts.
create function identity.sealed_demo_contact_allowed(requested_subject text, requested_session uuid,
  requested_channel text, requested_destination text, requested_destination_hmac character(64))
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if not identity.sealed_demo_patient(patient_id_value) then
    return true;
  end if;
  if coalesce(requested_channel = 'email', false) and identity.sealed_demo_recipient(requested_destination)
     and coalesce(requested_destination_hmac::text ~ '^[0-9a-f]{64}$', false) then
    perform set_config('hid.sealed_demo_contact_hmac', requested_destination_hmac::text, true);
    return true;
  end if;
  return false;
end
$$;

-- Whether an organization application is a demo facility's (the admin
-- applications list marks it; Identity may not read the applications table).
create function identity.sealed_demo_application(requested_application_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from identity.organization_applications application
                  where application.id = requested_application_id
                    and identity.sealed_demo_facility(application.facility_id))
$$;

-- Section 10's seed. Every read before any write; refusals raise 55000 with a
-- message that names no address, Health ID or person.
create function identity.sealed_demo_install()
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  staff_account constant uuid := '98d00003-0000-4000-8000-000000000001';
  staff_record constant uuid := '98d00004-0000-4000-8000-000000000001';
  install_reason constant text := 'Sealed demo tenant installed by migration 0098';
  role_reason constant text := 'Sealed demo tenant (0098, owner decision)';
  demo_organizations constant jsonb := '[
    {"id": "98d00001-0000-4000-8000-000000000001", "name": "Demo Hospital", "slug": "sealed-demo-hospital"},
    {"id": "98d00001-0000-4000-8000-000000000002", "name": "Demo Laboratory", "slug": "sealed-demo-laboratory"},
    {"id": "98d00001-0000-4000-8000-000000000003", "name": "Demo Pharmacy", "slug": "sealed-demo-pharmacy"},
    {"id": "98d00001-0000-4000-8000-000000000004", "name": "Demo Outreach", "slug": "sealed-demo-outreach"}]';
  demo_facilities constant jsonb := '[
    {"id": "98d00002-0000-4000-8000-000000000001", "organization_id": "98d00001-0000-4000-8000-000000000001",
     "name": "Demo Hospital", "code": "DEMO-HOSPITAL"},
    {"id": "98d00002-0000-4000-8000-000000000002", "organization_id": "98d00001-0000-4000-8000-000000000002",
     "name": "Demo Laboratory", "code": "DEMO-LABORATORY"},
    {"id": "98d00002-0000-4000-8000-000000000003", "organization_id": "98d00001-0000-4000-8000-000000000003",
     "name": "Demo Pharmacy", "code": "DEMO-PHARMACY"},
    {"id": "98d00002-0000-4000-8000-000000000004", "organization_id": "98d00001-0000-4000-8000-000000000004",
     "name": "Demo Outreach", "code": "DEMO-OUTREACH"}]';
  demo_accounts constant jsonb := '[
    {"id": "98d00003-0000-4000-8000-000000000001", "subject": "sealed-demo:98d00003-0000-4000-8000-000000000001",
     "email": "operations@healthidentitydirectory.com", "display_name": "Demo Operations"},
    {"id": "98d00008-0000-4000-8000-000000000001", "subject": "patient:98d00008-0000-4000-8000-000000000001",
     "email": "patient1@healthidentitydirectory.com", "display_name": "Demo Patient One"},
    {"id": "98d00008-0000-4000-8000-000000000002", "subject": "patient:98d00008-0000-4000-8000-000000000002",
     "email": "patient2@healthidentitydirectory.com", "display_name": "Demo Patient Two"}]';
  demo_memberships constant jsonb := '[
    {"id": "98d00005-0000-4000-8000-000000000001", "organization_id": "98d00001-0000-4000-8000-000000000001",
     "facility_id": "98d00002-0000-4000-8000-000000000001", "role": "doctor", "is_primary": true},
    {"id": "98d00005-0000-4000-8000-000000000002", "organization_id": "98d00001-0000-4000-8000-000000000002",
     "facility_id": "98d00002-0000-4000-8000-000000000002", "role": "lab", "is_primary": false},
    {"id": "98d00005-0000-4000-8000-000000000003", "organization_id": "98d00001-0000-4000-8000-000000000003",
     "facility_id": "98d00002-0000-4000-8000-000000000003", "role": "pharmacist", "is_primary": false},
    {"id": "98d00005-0000-4000-8000-000000000004", "organization_id": "98d00001-0000-4000-8000-000000000004",
     "facility_id": "98d00002-0000-4000-8000-000000000004", "role": "nurse", "is_primary": false}]';
  demo_roles constant jsonb := '[
    {"id": "98d00006-0000-4000-8000-000000000011", "membership_id": "98d00005-0000-4000-8000-000000000001",
     "facility_id": "98d00002-0000-4000-8000-000000000001", "role": "doctor"},
    {"id": "98d00006-0000-4000-8000-000000000012", "membership_id": "98d00005-0000-4000-8000-000000000001",
     "facility_id": "98d00002-0000-4000-8000-000000000001", "role": "org_admin"},
    {"id": "98d00006-0000-4000-8000-000000000021", "membership_id": "98d00005-0000-4000-8000-000000000002",
     "facility_id": "98d00002-0000-4000-8000-000000000002", "role": "lab"},
    {"id": "98d00006-0000-4000-8000-000000000022", "membership_id": "98d00005-0000-4000-8000-000000000002",
     "facility_id": "98d00002-0000-4000-8000-000000000002", "role": "org_admin"},
    {"id": "98d00006-0000-4000-8000-000000000031", "membership_id": "98d00005-0000-4000-8000-000000000003",
     "facility_id": "98d00002-0000-4000-8000-000000000003", "role": "pharmacist"},
    {"id": "98d00006-0000-4000-8000-000000000032", "membership_id": "98d00005-0000-4000-8000-000000000003",
     "facility_id": "98d00002-0000-4000-8000-000000000003", "role": "org_admin"},
    {"id": "98d00006-0000-4000-8000-000000000041", "membership_id": "98d00005-0000-4000-8000-000000000004",
     "facility_id": "98d00002-0000-4000-8000-000000000004", "role": "nurse"},
    {"id": "98d00006-0000-4000-8000-000000000042", "membership_id": "98d00005-0000-4000-8000-000000000004",
     "facility_id": "98d00002-0000-4000-8000-000000000004", "role": "org_admin"}]';
  demo_applications constant jsonb := '[
    {"id": "98d00007-0000-4000-8000-000000000002", "organization_id": "98d00001-0000-4000-8000-000000000002",
     "facility_id": "98d00002-0000-4000-8000-000000000002", "product": "laboratory", "kind": "laboratory",
     "cac": "RC00000000000000098002", "name": "Demo Laboratory"},
    {"id": "98d00007-0000-4000-8000-000000000003", "organization_id": "98d00001-0000-4000-8000-000000000003",
     "facility_id": "98d00002-0000-4000-8000-000000000003", "product": "pharmacy", "kind": "pharmacy",
     "cac": "RC00000000000000098003", "name": "Demo Pharmacy"}]';
  demo_patients constant jsonb := '[
    {"id": "98d00009-0000-4000-8000-000000000001", "identifier_id": "98d0000a-0000-4000-8000-000000000001",
     "account_id": "98d00008-0000-4000-8000-000000000001", "hid": "HID-ZDEMAAA2", "last": "Patient One",
     "gender": "female", "dob": "1985-03-14"},
    {"id": "98d00009-0000-4000-8000-000000000002", "identifier_id": "98d0000a-0000-4000-8000-000000000002",
     "account_id": "98d00008-0000-4000-8000-000000000002", "hid": "HID-ZDEMAAA3", "last": "Patient Two",
     "gender": "male", "dob": "1990-07-02"},
    {"id": "98d00009-0000-4000-8000-000000000003", "identifier_id": "98d0000a-0000-4000-8000-000000000003",
     "account_id": null, "hid": "HID-ZDEMBBB2", "last": "Patient Three", "gender": "male", "dob": "1950-01-10"},
    {"id": "98d00009-0000-4000-8000-000000000004", "identifier_id": "98d0000a-0000-4000-8000-000000000004",
     "account_id": null, "hid": "HID-ZDEMBBB3", "last": "Patient Four", "gender": "female", "dob": "1962-05-21"},
    {"id": "98d00009-0000-4000-8000-000000000005", "identifier_id": "98d0000a-0000-4000-8000-000000000005",
     "account_id": null, "hid": "HID-ZDEMBBB4", "last": "Patient Five", "gender": "male", "dob": "1971-09-30"},
    {"id": "98d00009-0000-4000-8000-000000000006", "identifier_id": "98d0000a-0000-4000-8000-000000000006",
     "account_id": null, "hid": "HID-ZDEMBBB5", "last": "Patient Six", "gender": "female", "dob": "1978-12-02"},
    {"id": "98d00009-0000-4000-8000-000000000007", "identifier_id": "98d0000a-0000-4000-8000-000000000007",
     "account_id": null, "hid": "HID-ZDEMBBB6", "last": "Patient Seven", "gender": "male", "dob": "1999-04-18"},
    {"id": "98d00009-0000-4000-8000-000000000008", "identifier_id": "98d0000a-0000-4000-8000-000000000008",
     "account_id": null, "hid": "HID-ZDEMBBB7", "last": "Patient Eight", "gender": "female", "dob": "2004-08-25"},
    {"id": "98d00009-0000-4000-8000-000000000009", "identifier_id": "98d0000a-0000-4000-8000-000000000009",
     "account_id": null, "hid": "HID-ZDEMBBB8", "last": "Patient Nine", "gender": "male", "dob": "2012-02-11"},
    {"id": "98d00009-0000-4000-8000-000000000010", "identifier_id": "98d0000a-0000-4000-8000-000000000010",
     "account_id": null, "hid": "HID-ZDEMBBB9", "last": "Patient Ten", "gender": "female", "dob": "2020-06-06"}]';
  -- D6: Patient One and Patient Two share with the doctor membership at Demo
  -- Hospital and the nurse membership at Demo Outreach.
  demo_shares constant jsonb := '[
    {"patient_id": "98d00009-0000-4000-8000-000000000001", "membership_id": "98d00005-0000-4000-8000-000000000001"},
    {"patient_id": "98d00009-0000-4000-8000-000000000001", "membership_id": "98d00005-0000-4000-8000-000000000004"},
    {"patient_id": "98d00009-0000-4000-8000-000000000002", "membership_id": "98d00005-0000-4000-8000-000000000001"},
    {"patient_id": "98d00009-0000-4000-8000-000000000002", "membership_id": "98d00005-0000-4000-8000-000000000004"}]';
  share_correlation constant text := '0098-sealed-demo-install';
  demo_share record;
  share_membership record;
  share_grant uuid;
  share_start timestamptz;
  step bigint;
  inserted bigint := 0;
begin
  -- One install at a time.
  perform pg_advisory_xact_lock(hashtextextended('hid-sealed-demo-install', 0));

  -- 1. An address of the demo tenant belongs to another account (not
  -- deleted) or staff record, or is named by an open organization
  -- application (its first administrator) or a pending staff invitation:
  -- demo access is never attached to it, and seeding it would break that
  -- application's approval or that invitation's acceptance. (The demo's own
  -- applications are approved, so a second call passes.)
  if exists (select 1 from auth.accounts account
               join jsonb_to_recordset(demo_accounts) demo(id uuid, email text) on lower(account.email) = demo.email
              where account.status <> 'deleted' and account.id <> demo.id)
     or exists (select 1 from identity.staff staff_row
                  join jsonb_to_recordset(demo_accounts) demo(id uuid, email text) on lower(staff_row.email) = demo.email
                 where staff_row.id <> staff_record)
     or exists (select 1 from identity.organization_applications application
                  join jsonb_to_recordset(demo_accounts) demo(id uuid, email text)
                    on lower(application.administrator_email) = demo.email
                 where application.status in ('pending_verification', 'ready_for_review'))
     or exists (select 1 from identity.staff_invitations invitation
                  join jsonb_to_recordset(demo_accounts) demo(id uuid, email text)
                    on lower(invitation.invitee_email) = demo.email
                 where invitation.status = 'pending' and invitation.expires_at > clock_timestamp()) then
    raise exception using errcode = '55000', message = '0098: SEALED_DEMO_ADDRESS_TAKEN';
  end if;

  -- 2. A fixed id is held by a row that is not the demo's: no demo marker,
  -- or another email, subject, organization, facility, account, role or
  -- Health ID than the demo's.
  if exists (select 1 from identity.organizations organization
               join jsonb_to_recordset(demo_organizations) demo(id uuid, slug text) on demo.id = organization.id
              where lower(organization.slug) <> demo.slug
                 or not exists (select 1 from identity.sealed_demo_members member
                                 where member.member_kind = 'organization' and member.member_id = organization.id))
     or exists (select 1 from identity.facilities facility
                  join jsonb_to_recordset(demo_facilities) demo(id uuid, organization_id uuid, code text)
                    on demo.id = facility.id
                 where facility.organization_id <> demo.organization_id or upper(facility.code) <> demo.code
                    or not identity.sealed_demo_facility(facility.id))
     or exists (select 1 from auth.accounts account
                  join jsonb_to_recordset(demo_accounts) demo(id uuid, subject text, email text) on demo.id = account.id
                 where account.subject <> demo.subject or lower(account.email) is distinct from demo.email
                    or account.status = 'deleted' or not identity.sealed_demo_account(account.id))
     or exists (select 1 from identity.staff staff_row
                 where (staff_row.id = staff_record or staff_row.account_id = staff_account)
                   and (staff_row.id <> staff_record or staff_row.account_id <> staff_account
                     or lower(staff_row.email) <> 'operations@healthidentitydirectory.com'))
     or exists (select 1 from identity.staff_facility_memberships membership
                  join jsonb_to_recordset(demo_memberships) demo(id uuid, organization_id uuid, facility_id uuid)
                    on demo.id = membership.id
                 where membership.account_id <> staff_account or membership.staff_id <> staff_record
                    or membership.organization_id <> demo.organization_id
                    or membership.facility_id is distinct from demo.facility_id)
     or exists (select 1 from auth.account_roles assignment
                  join jsonb_to_recordset(demo_roles) demo(id uuid, membership_id uuid, role text) on demo.id = assignment.id
                 where assignment.account_id <> staff_account or assignment.scope_type <> 'facility'
                    or assignment.membership_id is distinct from demo.membership_id or assignment.role_code <> demo.role)
     or exists (select 1 from identity.organization_applications application
                  join jsonb_to_recordset(demo_applications) demo(id uuid, organization_id uuid, facility_id uuid,
                    product text, cac text) on demo.id = application.id
                 where application.organization_id is distinct from demo.organization_id
                    or application.facility_id is distinct from demo.facility_id
                    or application.product_code <> demo.product or application.cac_registration_number <> demo.cac
                    or application.approval_mode <> 'admin_review')
     or exists (select 1 from identity.organization_products product
                  join jsonb_to_recordset(demo_applications) demo(id uuid, organization_id uuid, facility_id uuid,
                    product text) on demo.organization_id = product.organization_id and demo.product = product.product_code
                 where product.facility_id <> demo.facility_id or product.source_application_id <> demo.id)
     or exists (select 1 from identity.patients patient
                  join jsonb_to_recordset(demo_patients) demo(id uuid, account_id uuid, hid text) on demo.id = patient.id
                 where upper(patient.hid_code) <> demo.hid or patient.account_id is distinct from demo.account_id
                    or not identity.sealed_demo_patient(patient.id))
     or exists (select 1 from identity.patient_identifiers identifier
                  join jsonb_to_recordset(demo_patients) demo(id uuid, identifier_id uuid, hid text)
                    on demo.identifier_id = identifier.id
                 where identifier.patient_id <> demo.id or identifier.identifier_type <> 'hid_code'
                    or upper(identifier.public_value) is distinct from demo.hid)
     or exists (select 1 from identity.patient_assurance_states assurance
                  join jsonb_to_recordset(demo_patients) demo(id uuid, account_id uuid) on demo.id = assurance.patient_id
                 where assurance.account_id is distinct from demo.account_id) then
    raise exception using errcode = '55000', message = '0098: SEALED_DEMO_ID_TAKEN';
  end if;

  -- 3. A slug, facility code, Health ID or CAC of the demo tenant is held by
  -- a real row.
  if exists (select 1 from identity.organizations organization
               join jsonb_to_recordset(demo_organizations) demo(id uuid, slug text)
                 on lower(organization.slug) = demo.slug and organization.id <> demo.id)
     or exists (select 1 from identity.facilities facility
                  join jsonb_to_recordset(demo_facilities) demo(id uuid, code text)
                    on upper(facility.code) = demo.code and facility.id <> demo.id)
     or exists (select 1 from identity.patients patient
                  join jsonb_to_recordset(demo_patients) demo(id uuid, hid text)
                    on upper(patient.hid_code) = demo.hid and patient.id <> demo.id)
     or exists (select 1 from identity.patient_identifiers identifier
                  join jsonb_to_recordset(demo_patients) demo(identifier_id uuid, hid text)
                    on identifier.identifier_type = 'hid_code' and upper(identifier.public_value) = demo.hid
                   and identifier.id <> demo.identifier_id)
     or exists (select 1 from identity.organization_applications application
                  join jsonb_to_recordset(demo_applications) demo(id uuid, product text, cac text)
                    on application.cac_registration_number = demo.cac and application.product_code = demo.product
                   and application.status <> 'rejected' and application.id <> demo.id) then
    raise exception using errcode = '55000', message = '0098: SEALED_DEMO_KEY_TAKEN';
  end if;

  -- 4. A demo account holds a real membership, a platform role, or (the
  -- staff login) a patient record, or a patient login another patient
  -- record. Triggers G2 and G3 make the first two impossible once installed.
  if exists (select 1 from identity.staff_facility_memberships membership
               join jsonb_to_recordset(demo_accounts) demo(id uuid) on demo.id = membership.account_id
              where not identity.sealed_demo_facility(membership.facility_id))
     or exists (select 1 from auth.account_roles assignment
                  join jsonb_to_recordset(demo_accounts) demo(id uuid) on demo.id = assignment.account_id
                 where assignment.scope_type = 'platform' and assignment.revoked_at is null)
     or exists (select 1 from identity.patients patient where patient.account_id = staff_account)
     or exists (select 1 from identity.patients patient
                  join jsonb_to_recordset(demo_patients) demo(id uuid, account_id uuid)
                    on demo.account_id = patient.account_id and patient.id <> demo.id) then
    raise exception using errcode = '55000', message = '0098: SEALED_DEMO_ACCOUNT_NOT_SEALED';
  end if;

  -- Members first, so that the triggers see them; then the rows. Nothing
  -- existing is updated.
  insert into identity.sealed_demo_members (member_kind, member_id)
  select 'organization', demo.id from jsonb_to_recordset(demo_organizations) demo(id uuid)
  union all select 'facility', demo.id from jsonb_to_recordset(demo_facilities) demo(id uuid)
  union all select 'account', demo.id from jsonb_to_recordset(demo_accounts) demo(id uuid)
  union all select 'patient', demo.id from jsonb_to_recordset(demo_patients) demo(id uuid)
  on conflict (member_kind, member_id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.organizations (id, name, slug, active, source_system)
  select demo.id, demo.name, demo.slug, true, 'hid-sealed-demo'
    from jsonb_to_recordset(demo_organizations) demo(id uuid, name text, slug text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.facilities (id, organization_id, name, code, active, timezone, lifecycle_status,
    status_reason, source_system)
  select demo.id, demo.organization_id, demo.name, demo.code, true, 'Africa/Lagos', 'verified', install_reason,
         'hid-sealed-demo'
    from jsonb_to_recordset(demo_facilities) demo(id uuid, organization_id uuid, name text, code text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system)
  select demo.id, demo.subject, demo.email, demo.display_name, 'pending_reset', clock_timestamp(), 'hid-sealed-demo'
    from jsonb_to_recordset(demo_accounts) demo(id uuid, subject text, email text, display_name text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active,
    source_system)
  values (staff_record, staff_account, 'Demo Operations', 'operations@healthidentitydirectory.com', 'verified',
    'doctor', true, 'hid-sealed-demo')
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, source_system)
  select demo.id, staff_record, staff_account, demo.organization_id, demo.facility_id, demo.role, demo.role,
         demo.is_primary, true, 'hid-sealed-demo'
    from jsonb_to_recordset(demo_memberships) demo(id uuid, organization_id uuid, facility_id uuid, role text,
      is_primary boolean)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
  select demo.id, staff_account, demo.role, 'facility', demo.membership_id, demo.facility_id, role_reason
    from jsonb_to_recordset(demo_roles) demo(id uuid, membership_id uuid, facility_id uuid, role text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  -- Demo Laboratory and Demo Pharmacy: an approved governed application (the
  -- historical closed approval form: no profile, no provider fields) and
  -- their product, which an order's receiving facility needs.
  insert into identity.organization_applications (id, product_code, organization_name, organization_type,
    cac_registration_number, administrator_name, administrator_email, status, verification_result, verified_at,
    organization_id, facility_id, first_admin_account_id, reviewed_by_account_id, review_reason, reviewed_at,
    verified_organization_name, approval_mode)
  select demo.id, demo.product, demo.name, demo.kind, demo.cac, 'Demo Operations',
         'operations@healthidentitydirectory.com', 'approved', 'verified', clock_timestamp(), demo.organization_id,
         demo.facility_id, staff_account, staff_account, install_reason, clock_timestamp(), demo.name, 'admin_review'
    from jsonb_to_recordset(demo_applications) demo(id uuid, organization_id uuid, facility_id uuid, product text,
      kind text, cac text, name text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.organization_products (organization_id, product_code, facility_id, status,
    source_application_id)
  select demo.organization_id, demo.product, demo.facility_id, 'active', demo.id
    from jsonb_to_recordset(demo_applications) demo(id uuid, organization_id uuid, facility_id uuid, product text)
  on conflict (organization_id, product_code) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status,
    source_system)
  select demo.id, demo.account_id, demo.hid, 'Demo', demo.last, 'Demo ' || demo.last, demo.gender, demo.dob,
         'active', 'hid-sealed-demo'
    from jsonb_to_recordset(demo_patients) demo(id uuid, account_id uuid, hid text, last text, gender text, dob date)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.patient_identifiers (id, patient_id, identifier_type, public_value, verified, source_system)
  select demo.identifier_id, demo.id, 'hid_code', demo.hid, true, 'hid-sealed-demo'
    from jsonb_to_recordset(demo_patients) demo(id uuid, identifier_id uuid, hid text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.patient_assurance_states (patient_id, account_id, state, source_system, contact_verified_at)
  select demo.id, demo.account_id, 'CONTACT_VERIFIED', 'hid-sealed-demo', clock_timestamp()
    from jsonb_to_recordset(demo_patients) demo(id uuid, account_id uuid)
   where demo.account_id is not null
  on conflict (patient_id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  -- D6: the four shares. Each is the consent grant and the share row that the
  -- patient's own Share action writes (identity.write_patient_share, 0095,
  -- whose body section 0 pins), column for column: clinical_collaboration
  -- until revoked, 365 days of direct-care write_records, granted by the
  -- patient (so the patient revokes it in the portal), created_via search,
  -- under the install's correlation id. Not that function's audit row: the
  -- patients did not share, this migration did, so each share gets one audit
  -- row of its own (system, provenance migration,
  -- identity.sealed-demo.seed-share) and no audit row names a patient as its
  -- actor. Each is written under the patient's advisory lock (0087's key),
  -- only to a membership the patient could choose in the share directory
  -- (identity.share_provider_eligible's rule, less the active sign-in the
  -- staff login gets from the owner's password reset; else
  -- SEALED_DEMO_SHARE_INELIGIBLE), and once only: a pair that already has a
  -- grant with the install's correlation id (also one the patient revoked)
  -- or an active share is left alone, so nothing is ever replaced, revoked or
  -- restored. G1 checks each grant as it checks any other.
  for demo_share in select * from jsonb_to_recordset(demo_shares) demo(patient_id uuid, membership_id uuid)
  loop
    perform pg_advisory_xact_lock(hashtextextended('patient-access-pin:' || demo_share.patient_id::text, 0));
    continue when exists (select 1 from identity.consent_grants grant_row
                           where grant_row.patient_id = demo_share.patient_id
                             and grant_row.membership_id = demo_share.membership_id
                             and grant_row.correlation_id = share_correlation)
               or exists (select 1 from identity.patient_consent_shares share
                            join identity.consent_grants grant_row on grant_row.id = share.consent_grant_id
                           where share.patient_id = demo_share.patient_id
                             and share.membership_id = demo_share.membership_id
                             and grant_row.status = 'active' and grant_row.expires_at > clock_timestamp());
    select membership.id, membership.staff_id, membership.account_id, membership.facility_id
      into share_membership
      from identity.staff_facility_memberships membership
      join identity.staff staff_row on staff_row.id = membership.staff_id
      join identity.facilities facility on facility.id = membership.facility_id
      join identity.organizations organization on organization.id = membership.organization_id
     where membership.id = demo_share.membership_id and membership.account_id = staff_account
       and membership.active and membership.migration_hold_reason is null
       and staff_row.active and lower(staff_row.verification_status) in ('verified', 'approved', 'active')
       and facility.active and facility.organization_id = membership.organization_id and organization.active
       and exists (select 1 from auth.account_roles assignment
                    where assignment.account_id = membership.account_id and assignment.membership_id = membership.id
                      and assignment.facility_id = membership.facility_id and assignment.scope_type = 'facility'
                      and assignment.revoked_at is null and assignment.role_code in ('doctor', 'clinician', 'nurse'))
       and exists (select 1 from auth.account_roles assignment
                     join auth.roles role_row on role_row.code = assignment.role_code and role_row.active
                     join auth.role_permissions role_permission on role_permission.role_code = role_row.code
                      and role_permission.permission_code = 'identity.consent.write'
                     join auth.permissions permission_row on permission_row.code = role_permission.permission_code
                      and permission_row.active
                    where assignment.account_id = membership.account_id and assignment.membership_id = membership.id
                      and assignment.facility_id = membership.facility_id and assignment.scope_type = 'facility'
                      and assignment.revoked_at is null)
       and not exists (select 1 from identity.organization_applications application
                        where application.organization_id = membership.organization_id
                          and application.approval_mode = 'self_service');
    if not found then
      raise exception using errcode = '55000', message = '0098: SEALED_DEMO_SHARE_INELIGIBLE';
    end if;
    share_grant := gen_random_uuid();
    share_start := clock_timestamp();
    insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
      scope, status, granted_by_patient_id, reason, starts_at, expires_at, break_glass, correlation_id,
      purpose_of_use, authorization_method)
    values (share_grant, null, demo_share.patient_id, share_membership.staff_id, share_membership.account_id,
      share_membership.id, share_membership.facility_id, 'write_records', 'active', demo_share.patient_id,
      'Shared by the patient', share_start, share_start + interval '365 days', false, share_correlation,
      'direct-care', null);
    insert into identity.patient_consent_shares (consent_grant_id, patient_id, membership_id, level, duration_preset,
      created_via, invitation_id, replaced_consent_grant_id, idempotency_key, request_sha256)
    values (share_grant, demo_share.patient_id, demo_share.membership_id, 'clinical_collaboration', 'until_revoked',
      'search', null, null,
      'sealed-demo-share-' || demo_share.patient_id::text || '-' || demo_share.membership_id::text,
      encode(sha256(convert_to('sealed-demo-share:' || demo_share.patient_id::text || ':'
        || demo_share.membership_id::text, 'UTF8')), 'hex'));
    insert into audit.events (correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type,
      resource_id, provenance, source_system, details)
    values (share_correlation, 'system', share_membership.facility_id, demo_share.patient_id,
      'identity.sealed-demo.seed-share', 'success', 'consent-grant', share_grant::text, 'migration',
      'hid-sealed-demo', jsonb_build_object('scope', 'write_records', 'purpose', 'direct-care',
        'level', 'clinical_collaboration', 'duration', 'until_revoked', 'via', 'search'));
    inserted := inserted + 2;
  end loop;

  if inserted > 0 then
    insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, provenance,
      source_system, details)
    values ('0098-sealed-demo-install', 'system', 'identity.sealed-demo.install', 'success', 'sealed-demo-tenant',
      'migration', 'hid-sealed-demo', jsonb_build_object('rowsInserted', inserted, 'facilities', 4,
        'staffLogins', 1, 'patientLogins', 2, 'patients', 10, 'shares', 4));
  end if;

  return jsonb_build_object(
    'inserted', inserted,
    'organizations', (select count(*) from identity.sealed_demo_members member where member.member_kind = 'organization'),
    'facilities', (select count(*) from identity.sealed_demo_members member where member.member_kind = 'facility'),
    'accounts', (select count(*) from identity.sealed_demo_members member where member.member_kind = 'account'),
    'patients', (select count(*) from identity.sealed_demo_members member where member.member_kind = 'patient'),
    'memberships', (select count(*) from identity.staff_facility_memberships membership
                     where membership.account_id = staff_account and membership.active),
    'roles', (select count(*) from auth.account_roles assignment
               where assignment.account_id = staff_account and assignment.revoked_at is null),
    'shares', (select count(*) from identity.consent_grants grant_row
                where grant_row.correlation_id = share_correlation
                  and identity.sealed_demo_patient(grant_row.patient_id)));
end
$$;

-- 4. The seal's triggers.
-- G1: a grant links a facility and a patient on the same side.
create function identity.consent_grants_sealed_demo()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  grant_facility uuid := new.facility_id;
begin
  if grant_facility is null then
    select membership.facility_id into grant_facility
      from identity.staff_facility_memberships membership where membership.id = new.membership_id;
  end if;
  if identity.sealed_demo_facility(grant_facility) <> identity.sealed_demo_patient(new.patient_id) then
    raise exception using errcode = '42501', message = 'SEALED_DEMO_BOUNDARY';
  end if;
  return new;
end
$$;
create trigger consent_grants_sealed_demo
  before insert or update of patient_id, membership_id, facility_id on identity.consent_grants
  for each row execute function identity.consent_grants_sealed_demo();

-- G2: a membership links an account and a facility on the same side.
create function identity.staff_memberships_sealed_demo()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if identity.sealed_demo_account(new.account_id) <> identity.sealed_demo_facility(new.facility_id) then
    raise exception using errcode = '42501', message = 'SEALED_DEMO_MEMBERSHIP_REFUSED';
  end if;
  return new;
end
$$;
create trigger staff_memberships_sealed_demo
  before insert or update of account_id, facility_id on identity.staff_facility_memberships
  for each row execute function identity.staff_memberships_sealed_demo();

-- G3: a demo account holds no platform role.
create function identity.account_roles_sealed_demo()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if identity.sealed_demo_account(new.account_id) then
    raise exception using errcode = '42501', message = 'SEALED_DEMO_PLATFORM_ROLE_REFUSED';
  end if;
  return new;
end
$$;
create trigger account_roles_sealed_demo
  before insert or update of account_id, scope_type, revoked_at on auth.account_roles
  for each row when (new.scope_type = 'platform' and new.revoked_at is null)
  execute function identity.account_roles_sealed_demo();

-- G4: a demo patient invites a demo mailbox only; an invitation is accepted
-- on the patient's side of the boundary only.
create function identity.patient_share_invitations_sealed_demo()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  demo_patient boolean := identity.sealed_demo_patient(new.patient_id);
  accepting_facility uuid;
begin
  if demo_patient and not identity.sealed_demo_recipient(new.invitee_email) then
    raise exception using errcode = '22023', message = 'SHARE_INVITATION_EMAIL_INVALID';
  end if;
  if new.accepted_membership_id is not null then
    select membership.facility_id into accepting_facility
      from identity.staff_facility_memberships membership where membership.id = new.accepted_membership_id;
    if identity.sealed_demo_facility(accepting_facility) <> demo_patient then
      raise exception using errcode = '42501', message = 'SEALED_DEMO_BOUNDARY';
    end if;
  end if;
  return new;
end
$$;
create trigger patient_share_invitations_sealed_demo
  before insert or update of invitee_email, accepted_membership_id on identity.patient_share_invitations
  for each row execute function identity.patient_share_invitations_sealed_demo();

-- G5: a demo patient never holds a phone.
create function identity.patient_contact_changes_sealed_demo()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if identity.sealed_demo_patient(new.patient_id) then
    raise exception using errcode = '22023', message = 'PATIENT_CONTACT_CHANGE_INVALID';
  end if;
  return new;
end
$$;
create trigger patient_contact_changes_sealed_demo
  before insert on identity.patient_contact_changes
  for each row when (new.channel = 'phone')
  execute function identity.patient_contact_changes_sealed_demo();

-- G6: a demo account consumes no QoreID quota, so it causes no QoreID call.
create function identity.qoreid_quota_counters_sealed_demo()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if identity.sealed_demo_account(new.scope_id) then
    raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
  end if;
  return new;
end
$$;
create trigger qoreid_quota_counters_sealed_demo
  before insert on platform.qoreid_quota_counters
  for each row when (new.scope_type = 'account')
  execute function identity.qoreid_quota_counters_sealed_demo();

-- G7: for a demo patient, refuses an SMS contact, and an email contact whose
-- HMAC identity.sealed_demo_contact_allowed did not record in this
-- transaction. The database holds only the contact's HMAC and ciphertext, so
-- it cannot tell whether either belongs to the address the check was given,
-- and any session can set hid.sealed_demo_contact_hmac itself: that the
-- destination is one of the three demo mailboxes rests on Identity
-- (EmergencyContactService.add computes the HMAC from the same normalized
-- address it checks and encrypts). Deactivation is never refused.
create function identity.patient_emergency_contacts_sealed_demo()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.status <> 'deactivated'
     and (tg_op = 'INSERT' or new.channel is distinct from old.channel
          or new.destination_hmac is distinct from old.destination_hmac)
     and identity.sealed_demo_patient(new.patient_id)
     and (new.channel is distinct from 'email'
          or current_setting('hid.sealed_demo_contact_hmac', true) is distinct from new.destination_hmac::text) then
    raise exception using errcode = '42501', message = 'EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED';
  end if;
  return new;
end
$$;
create trigger patient_emergency_contacts_sealed_demo
  before insert or update of channel, destination_hmac on identity.patient_emergency_contacts
  for each row execute function identity.patient_emergency_contacts_sealed_demo();

-- 5. Eight bodies replaced: each body as 0001-0097 left it, byte for byte, and
-- one clause that is always true for real tenants. CREATE OR REPLACE keeps
-- the owner and the ACL.
-- R1 (0010): an access request finds a patient on the actor facility's side only.
create or replace function identity.create_access_request(
  requested_hid text,
  requested_scope text,
  requested_reason text,
  requested_duration_minutes integer
)
returns table (
  access_request_id uuid,
  subject_patient_id uuid,
  request_status text,
  request_scope text,
  request_purpose text,
  duration_minutes integer,
  requested_at timestamptz,
  existing_request boolean
)
language plpgsql
security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  actor_correlation_id text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_staff_id uuid;
  actor_organization_id uuid;
  patient_id_value uuid;
  request_id_value uuid;
  request_created_at timestamptz;
  request_duration_value integer;
  replayed boolean := false;
begin
  if actor_account_id is null
     or actor_membership_id is null
     or actor_facility_id is null
     or actor_correlation_id is null
     or not auth.membership_has_permission(
       actor_subject, actor_membership_id, actor_facility_id, 'identity.consent.write'
     ) then
    raise exception using errcode = '42501', message = 'Authorized consent command context is required';
  end if;
  if actor_purpose not in ('direct-care', 'healthcare-operations')
     or not exists (
       select 1 from identity.purpose_of_use_codes purpose
       where purpose.code = actor_purpose and purpose.active
     ) then
    raise exception using errcode = '22023', message = 'Invalid purpose for a standard access request';
  end if;
  if requested_scope not in ('read_records', 'write_records') then
    raise exception using errcode = '22023', message = 'Invalid access request scope';
  end if;
  if requested_duration_minutes not between 5 and 1440 then
    raise exception using errcode = '22023', message = 'Invalid access request duration';
  end if;
  if length(coalesce(btrim(requested_reason), '')) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'Invalid access request reason';
  end if;

  select membership.staff_id, membership.organization_id
    into actor_staff_id, actor_organization_id
  from identity.staff_facility_memberships membership
  where membership.id = actor_membership_id
    and membership.account_id = actor_account_id
    and membership.facility_id = actor_facility_id;
  if actor_staff_id is null then
    raise exception using errcode = '42501', message = 'Exact staff membership is required';
  end if;

  select patient_row.id
    into patient_id_value
  from identity.patients patient_row
  where upper(patient_row.hid_code) = upper(btrim(requested_hid))
    and patient_row.status = 'active'
    and identity.sealed_demo_facility(actor_facility_id) = identity.sealed_demo_patient(patient_row.id)
  limit 1;
  if patient_id_value is null then
    raise exception using errcode = 'P0002', message = 'Patient is not available';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    patient_id_value::text || ':' || actor_membership_id::text || ':' || requested_scope || ':' || actor_purpose, 0
  ));

  select request_row.id, request_row.created_at, request_row.requested_duration_minutes
    into request_id_value, request_created_at, request_duration_value
  from identity.access_requests request_row
  where request_row.patient_id = patient_id_value
    and request_row.membership_id = actor_membership_id
    and request_row.facility_id = actor_facility_id
    and request_row.scope = requested_scope
    and request_row.purpose_of_use = actor_purpose
    and request_row.status = 'pending'
    and not request_row.break_glass
    and request_row.migration_hold_reason is null
  order by request_row.created_at desc
  limit 1;

  if request_id_value is null then
    request_id_value := gen_random_uuid();
    request_duration_value := requested_duration_minutes;
    insert into identity.access_requests (
      id, patient_id, staff_id, membership_id, facility_id, scope,
      purpose_of_use, reason, status, requested_duration_minutes,
      break_glass, correlation_id
    ) values (
      request_id_value, patient_id_value, actor_staff_id, actor_membership_id,
      actor_facility_id, requested_scope, actor_purpose, btrim(requested_reason),
      'pending', requested_duration_minutes, false, actor_correlation_id
    )
    returning created_at into request_created_at;
  else
    replayed := true;
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    actor_membership_id, organization_id, facility_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'staff', actor_subject, actor_account_id,
    actor_membership_id, actor_organization_id, actor_facility_id, patient_id_value,
    case when replayed then 'identity.access-request.replay' else 'identity.access-request.create' end,
    'success', 'access-request', request_id_value::text, actor_purpose,
    btrim(requested_reason), 'application', 'ehr-api',
    jsonb_build_object(
      'scope', requested_scope,
      'duration_minutes', request_duration_value,
      'existing_request', replayed
    )
  );

  return query select
    request_id_value, patient_id_value, 'pending'::text, requested_scope,
    actor_purpose, request_duration_value, request_created_at, replayed;
end;
$$;

-- R2 (0031): break-glass finds a patient on the actor facility's side only.
create or replace function identity.activate_break_glass(
  requested_hid text,
  requested_reason text,
  requested_duration_minutes integer
)
returns table (
  access_request_id uuid,
  consent_grant_id uuid,
  subject_patient_id uuid,
  grant_status text,
  expires_at timestamptz,
  existing_grant boolean
)
language plpgsql
security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  actor_correlation_id text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_staff_id uuid;
  actor_organization_id uuid;
  patient_id_value uuid;
  request_id_value uuid;
  grant_id_value uuid;
  grant_expires_at timestamptz;
  replayed boolean := false;
begin
  if actor_account_id is null
     or actor_membership_id is null
     or actor_facility_id is null
     or actor_correlation_id is null
     or not auth.membership_has_permission(
       actor_subject, actor_membership_id, actor_facility_id, 'identity.break-glass.write'
     ) then
    raise exception using errcode = '42501', message = 'Authorized break-glass context is required';
  end if;
  if actor_purpose is distinct from 'emergency'
     or not exists (
       select 1 from identity.purpose_of_use_codes purpose
       where purpose.code = 'emergency' and purpose.active
     ) then
    raise exception using errcode = '22023', message = 'Break-glass requires the emergency purpose of use';
  end if;
  if requested_duration_minutes is null or requested_duration_minutes not between 5 and 240 then
    raise exception using errcode = '22023', message = 'Invalid break-glass duration';
  end if;
  if length(coalesce(btrim(requested_reason), '')) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'An explicit break-glass reason is required';
  end if;

  select membership.staff_id, membership.organization_id
    into actor_staff_id, actor_organization_id
  from identity.staff_facility_memberships membership
  where membership.id = actor_membership_id
    and membership.account_id = actor_account_id
    and membership.facility_id = actor_facility_id;
  if actor_staff_id is null then
    raise exception using errcode = '42501', message = 'Exact staff membership is required';
  end if;

  select patient_row.id
    into patient_id_value
  from identity.patients patient_row
  where upper(patient_row.hid_code) = upper(btrim(requested_hid))
    and patient_row.status = 'active'
    and identity.sealed_demo_facility(actor_facility_id) = identity.sealed_demo_patient(patient_row.id)
  limit 1;
  if patient_id_value is null then
    raise exception using errcode = 'P0002', message = 'Patient is not available';
  end if;

  -- Serialize this actor's activation window across patients and facilities.
  perform pg_advisory_xact_lock(hashtextextended(actor_account_id::text || ':emergency-rate', 0));

  perform pg_advisory_xact_lock(hashtextextended(
    patient_id_value::text || ':' || actor_membership_id::text || ':break-glass', 0
  ));

  select grant_row.request_id, grant_row.id, grant_row.expires_at
    into request_id_value, grant_id_value, grant_expires_at
  from identity.consent_grants grant_row
  where grant_row.patient_id = patient_id_value
    and grant_row.account_id = actor_account_id
    and grant_row.membership_id = actor_membership_id
    and grant_row.facility_id = actor_facility_id
    and grant_row.scope = 'break_glass'
    and grant_row.purpose_of_use = 'emergency'
    and grant_row.status = 'active'
    and grant_row.expires_at > clock_timestamp()
    and grant_row.migration_hold_reason is null
  order by grant_row.expires_at desc
  limit 1;

  if grant_id_value is null then
    -- Replays preserve access without consuming another activation. New grants
    -- are bounded to ten per account per rolling hour, including closed grants.
    if (select count(*) from identity.consent_grants recent
        where recent.account_id = actor_account_id and recent.break_glass
          and recent.starts_at > clock_timestamp() - interval '1 hour') >= 10 then
      raise exception using errcode = 'P0001', message = 'Emergency activation rate limit reached';
    end if;
    request_id_value := gen_random_uuid();
    grant_id_value := gen_random_uuid();
    grant_expires_at := clock_timestamp() + make_interval(mins => requested_duration_minutes);

    insert into identity.access_requests (
      id, patient_id, staff_id, membership_id, facility_id, scope,
      purpose_of_use, reason, status, requested_duration_minutes,
      break_glass, approved_at, correlation_id
    ) values (
      request_id_value, patient_id_value, actor_staff_id, actor_membership_id,
      actor_facility_id, 'break_glass', 'emergency', btrim(requested_reason),
      'approved', requested_duration_minutes, true, clock_timestamp(), actor_correlation_id
    );

    insert into identity.consent_grants (
      id, request_id, patient_id, staff_id, account_id, membership_id,
      facility_id, scope, purpose_of_use, status, reason, starts_at,
      expires_at, break_glass, correlation_id
    ) values (
      grant_id_value, request_id_value, patient_id_value, actor_staff_id,
      actor_account_id, actor_membership_id, actor_facility_id, 'break_glass',
      'emergency', 'active', btrim(requested_reason), clock_timestamp(),
      grant_expires_at, true, actor_correlation_id
    );
  else
    replayed := true;
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    actor_membership_id, organization_id, facility_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'staff', actor_subject, actor_account_id,
    actor_membership_id, actor_organization_id, actor_facility_id, patient_id_value,
    case when replayed then 'identity.break-glass.replay' else 'identity.break-glass.activate' end,
    'success', 'consent-grant', grant_id_value::text, 'emergency',
    btrim(requested_reason), 'application', 'identity-api',
    jsonb_build_object(
      'access_request_id', request_id_value,
      'duration_minutes', requested_duration_minutes,
      'expires_at', grant_expires_at,
      'existing_grant', replayed,
      'review_required', true
    )
  );

  if not replayed then
    -- Audit, grant and patient-notification intent commit atomically. No
    -- emergency reason, HID, demographics or record content enters delivery.
    insert into identity.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id, patient_id,
      correlation_id, payload
    ) values (
      'EmergencyAccessActivated', grant_id_value, 1, actor_facility_id,
      patient_id_value, actor_correlation_id,
      jsonb_build_object('consentGrantId', grant_id_value, 'reviewRequired', true)
    );
  end if;

  return query select
    request_id_value, grant_id_value, patient_id_value, 'active'::text,
    grant_expires_at, replayed;
end;
$$;

-- R3 (0075): a patient PIN finds a patient on the actor facility's side only.
create or replace function identity.access_patient_with_pin(
  requested_hid text,
  requested_pin text,
  requested_duration_minutes integer
)
returns table (
  verified boolean,
  access_request_id uuid,
  consent_grant_id uuid,
  subject_patient_id uuid,
  grant_status text,
  expires_at timestamptz,
  existing_grant boolean
)
language plpgsql security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id_value uuid := auth.account_id_for_subject(actor_subject);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  actor_correlation_id text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_staff_id uuid;
  actor_organization_id uuid;
  patient_id_value uuid;
  request_id_value uuid;
  grant_id_value uuid;
  grant_expires_at timestamptz;
  normalized_pin text := regexp_replace(coalesce(requested_pin, ''), E'\\s+', '', 'g');
  pin_row identity.patient_access_pins%rowtype;
  verification_hash text;
  pin_hash_cost integer;
  padding_cost integer;
  pin_matches boolean := false;
  actor_limit identity.patient_access_pin_actor_limits%rowtype;
  target_limit identity.patient_access_pin_target_limits%rowtype;
  replayed boolean := false;
  denial_action text := 'identity.patient-access-pin.verify-denied';
begin
  if actor_account_id_value is null or actor_membership_id is null or actor_facility_id is null
     or actor_correlation_id is null
     or not auth.membership_has_permission(
       actor_subject, actor_membership_id, actor_facility_id, 'identity.patient-access-pin.verify'
     ) then
    raise exception using errcode = '42501', message = 'Authorized patient PIN context is required';
  end if;
  if actor_purpose is distinct from 'direct-care'
     or not exists (select 1 from identity.purpose_of_use_codes
                    where code = 'direct-care' and active) then
    raise exception using errcode = '22023', message = 'Patient PIN access requires direct care';
  end if;
  if requested_duration_minutes is null or requested_duration_minutes not between 5 and 60 then
    raise exception using errcode = '22023', message = 'Invalid patient PIN access duration';
  end if;
  select membership.staff_id, membership.organization_id
    into actor_staff_id, actor_organization_id
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership_id
     and membership.account_id = actor_account_id_value
     and membership.facility_id = actor_facility_id
     and membership.active and membership.migration_hold_reason is null;
  if actor_staff_id is null then
    raise exception using errcode = '42501', message = 'Exact active staff membership is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    actor_account_id_value::text || ':' || actor_facility_id::text || ':patient-pin', 0
  ));
  insert into identity.patient_access_pin_actor_limits (actor_account_id, facility_id)
    values (actor_account_id_value, actor_facility_id)
    on conflict on constraint patient_access_pin_actor_limits_pkey do nothing;
  select * into actor_limit from identity.patient_access_pin_actor_limits as limit_row
   where limit_row.actor_account_id = actor_account_id_value
     and limit_row.facility_id = actor_facility_id for update;
  if actor_limit.locked_until is not null and actor_limit.locked_until > clock_timestamp() then
    insert into identity.patient_access_pin_attempts (
      actor_account_id, membership_id, facility_id, patient_id, outcome, correlation_id
    ) values (actor_account_id_value, actor_membership_id, actor_facility_id, null, 'locked', actor_correlation_id);
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, action, outcome, resource_type, purpose_of_use,
      provenance, source_system, details
    ) values (
      actor_correlation_id, 'staff', actor_subject, actor_account_id_value, actor_membership_id,
      actor_organization_id, actor_facility_id, denial_action, 'denied', 'patient-access-pin',
      'direct-care', 'application', 'identity-api', jsonb_build_object('rate_limited', true)
    );
    return query select false, null::uuid, null::uuid, null::uuid, null::text, null::timestamptz, false;
    return;
  end if;

  select patient_row.id into patient_id_value
    from identity.patients patient_row
   where upper(patient_row.hid_code) = upper(btrim(requested_hid))
     and patient_row.status = 'active'
     and identity.sealed_demo_facility(actor_facility_id) = identity.sealed_demo_patient(patient_row.id)
   limit 1;

  if patient_id_value is not null then
    -- The same lock is taken by patient PIN set/revoke commands. Without it,
    -- a verifier could read an old hash before a revocation and create a grant
    -- after the revocation had already closed prior grants.
    perform pg_advisory_xact_lock(hashtextextended(
      'patient-access-pin:' || patient_id_value::text, 0
    ));
    perform pg_advisory_xact_lock(hashtextextended(
      actor_account_id_value::text || ':' || actor_facility_id::text || ':' || patient_id_value::text || ':patient-pin', 0
    ));
    insert into identity.patient_access_pin_target_limits (actor_account_id, facility_id, patient_id)
      values (actor_account_id_value, actor_facility_id, patient_id_value)
      on conflict on constraint patient_access_pin_target_limits_pkey do nothing;
    select * into target_limit from identity.patient_access_pin_target_limits as limit_row
     where limit_row.actor_account_id = actor_account_id_value
       and limit_row.facility_id = actor_facility_id
       and limit_row.patient_id = patient_id_value for update;
    if target_limit.locked_until is not null and target_limit.locked_until > clock_timestamp() then
      insert into identity.patient_access_pin_attempts (
        actor_account_id, membership_id, facility_id, patient_id, outcome, correlation_id
      ) values (actor_account_id_value, actor_membership_id, actor_facility_id, patient_id_value, 'locked', actor_correlation_id);
      insert into audit.events (
        correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
        organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
        purpose_of_use, provenance, source_system, details
      ) values (
        actor_correlation_id, 'staff', actor_subject, actor_account_id_value, actor_membership_id,
        actor_organization_id, actor_facility_id, patient_id_value, denial_action, 'denied',
        'patient-access-pin', patient_id_value::text, 'direct-care', 'application', 'identity-api',
        jsonb_build_object('rate_limited', true)
      );
      return query select false, null::uuid, null::uuid, null::uuid, null::text, null::timestamptz, false;
      return;
    end if;
  end if;

  if patient_id_value is null or normalized_pin !~ '^[0-9]{4,8}$' then
    pin_row := null;
  else
    select * into pin_row from identity.patient_access_pins as secret_row
     where secret_row.patient_id = patient_id_value
       and secret_row.status = 'active'
       and secret_row.hash_algorithm = 'bcrypt';
  end if;

  -- PostgreSQL pgcrypto verifies the historic Blowfish `$2a$` setting, but
  -- returns a non-matching failure marker for `$2b$` and `$2y$` rather than
  -- raising an error. PINs are restricted to ASCII digits, for which those
  -- variants have the same bcrypt semantics. Keep the imported source hash
  -- byte-for-byte and normalize only the transient pgcrypto comparison value.
  if pin_row.patient_id is not null then
    verification_hash := case
      when pin_row.pin_hash ~ E'^\\$2[by]\\$' then '$2a$' || substring(pin_row.pin_hash from 5)
      else pin_row.pin_hash
    end;
  end if;

  -- Every permitted verifier consumes a bounded cost-12 bcrypt work budget.
  -- Historic `gen_salt('bf')` calls normally produced cost 06, while new HID
  -- PINs use cost 12. A cost-06 verifier plus dummy work at 06..11 has the
  -- same exponential-work total as one cost-12 verifier. The same construction
  -- works for every accepted 04..12 envelope. This avoids exposing an active
  -- legacy/current PIN through its bcrypt cost; out-of-range hashes are
  -- rejected at staging and by the table constraint.
  if pin_row.patient_id is null then
    perform public.crypt(normalized_pin, '$2a$12$C5UqoLY4dzh793px/LPNXeivTi5Z1q6uMC9AZF0woY.hZ6S/kPnf6');
  else
    pin_hash_cost := substring(verification_hash from 5 for 2)::integer;
    pin_matches := public.crypt(normalized_pin, verification_hash) = verification_hash;
    if pin_hash_cost < 12 then
      for padding_cost in pin_hash_cost..11 loop
        perform public.crypt(
          normalized_pin,
          '$2a$' || lpad(padding_cost::text, 2, '0')
            || '$C5UqoLY4dzh793px/LPNXeivTi5Z1q6uMC9AZF0woY.hZ6S/kPnf6'
        );
      end loop;
    end if;
  end if;
  if not pin_matches then
    update identity.patient_access_pin_actor_limits as limit_row
       set failure_count = case when window_started_at < clock_timestamp() - interval '15 minutes' then 1 else failure_count + 1 end,
           window_started_at = case when window_started_at < clock_timestamp() - interval '15 minutes' then clock_timestamp() else window_started_at end,
           locked_until = case when (case when window_started_at < clock_timestamp() - interval '15 minutes' then 1 else failure_count + 1 end) >= 5
             then clock_timestamp() + interval '15 minutes' else null end,
           updated_at = clock_timestamp()
     where limit_row.actor_account_id = actor_account_id_value
       and limit_row.facility_id = actor_facility_id;
    if patient_id_value is not null then
      update identity.patient_access_pin_target_limits as limit_row
         set failure_count = case when window_started_at < clock_timestamp() - interval '15 minutes' then 1 else failure_count + 1 end,
             window_started_at = case when window_started_at < clock_timestamp() - interval '15 minutes' then clock_timestamp() else window_started_at end,
             locked_until = case when (case when window_started_at < clock_timestamp() - interval '15 minutes' then 1 else failure_count + 1 end) >= 5
               then clock_timestamp() + interval '15 minutes' else null end,
             updated_at = clock_timestamp()
       where limit_row.actor_account_id = actor_account_id_value
         and limit_row.facility_id = actor_facility_id
         and limit_row.patient_id = patient_id_value;
    end if;
    insert into identity.patient_access_pin_attempts (
      actor_account_id, membership_id, facility_id, patient_id, outcome, correlation_id
    ) values (actor_account_id_value, actor_membership_id, actor_facility_id, patient_id_value, 'denied', actor_correlation_id);
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      actor_correlation_id, 'staff', actor_subject, actor_account_id_value, actor_membership_id,
      actor_organization_id, actor_facility_id, patient_id_value, denial_action, 'denied',
      'patient-access-pin', patient_id_value::text, 'direct-care', 'application', 'identity-api',
      jsonb_build_object('rate_limited', false)
    );
    return query select false, null::uuid, null::uuid, null::uuid, null::text, null::timestamptz, false;
    return;
  end if;

  -- A PIN cannot defeat a current patient deny directive. This mirrors the
  -- downstream authorization check before materializing the narrow grant.
  if exists (
    select 1
      from identity.consent_directives directive
      join identity.consent_directive_versions directive_version
        on directive_version.directive_id = directive.id
       and directive_version.version_no = directive.current_version
     where directive.patient_id = patient_id_value
       and directive_version.status = 'active'
       and directive_version.provision_type = 'deny'
       and directive_version.starts_at <= clock_timestamp()
       and (directive_version.expires_at is null or directive_version.expires_at > clock_timestamp())
       and (directive_version.facility_id is null or directive_version.facility_id = actor_facility_id)
       and (cardinality(directive_version.actions) = 0 or 'read_records' = any(directive_version.actions))
       and (cardinality(directive_version.purposes) = 0 or 'direct-care' = any(directive_version.purposes))
       and (
         directive_version.grantee_type = 'all'
         or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = actor_facility_id)
         or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = actor_organization_id)
         or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = actor_staff_id)
       )
  ) then
    insert into identity.patient_access_pin_attempts (
      actor_account_id, membership_id, facility_id, patient_id, outcome, correlation_id
    ) values (actor_account_id_value, actor_membership_id, actor_facility_id, patient_id_value, 'authorization_denied', actor_correlation_id);
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      actor_correlation_id, 'staff', actor_subject, actor_account_id_value, actor_membership_id,
      actor_organization_id, actor_facility_id, patient_id_value,
      'identity.patient-access-pin.authorization-denied', 'denied', 'patient-access-pin',
      patient_id_value::text, 'direct-care', 'application', 'identity-api', '{}'::jsonb
    );
    return query select false, null::uuid, null::uuid, null::uuid, null::text, null::timestamptz, false;
    return;
  end if;

  -- Only the verified patient's window is cleared. The actor's window is
  -- left to run out: a success for one patient must not forgive failed
  -- guesses at another (0075; main 0079).
  update identity.patient_access_pin_target_limits as limit_row
     set failure_count = 0, window_started_at = clock_timestamp(), locked_until = null, updated_at = clock_timestamp()
   where limit_row.actor_account_id = actor_account_id_value
     and limit_row.facility_id = actor_facility_id
     and limit_row.patient_id = patient_id_value;

  select grant_row.request_id, grant_row.id, grant_row.expires_at
    into request_id_value, grant_id_value, grant_expires_at
    from identity.consent_grants grant_row
   where grant_row.patient_id = patient_id_value
     and grant_row.account_id = actor_account_id_value
     and grant_row.membership_id = actor_membership_id
     and grant_row.facility_id = actor_facility_id
     and grant_row.scope = 'read_records'
     and grant_row.purpose_of_use = 'direct-care'
     and grant_row.authorization_method = 'patient_access_pin'
     and grant_row.status = 'active'
     and grant_row.expires_at > clock_timestamp()
     and grant_row.migration_hold_reason is null
   order by grant_row.expires_at desc
   limit 1;

  if grant_id_value is null then
    -- pg_catalog is searched before every SECURITY DEFINER search_path, while
    -- pgcrypto itself lives in public in this schema history. Qualify the UUID
    -- generator so a public-schema shadow can never be used here.
    request_id_value := pg_catalog.gen_random_uuid();
    grant_id_value := pg_catalog.gen_random_uuid();
    -- The command may be authorized in this same request transaction.
    -- current_timestamp is transaction-consistent; a later clock_timestamp()
    -- would leave starts_at future-dated versus the authorization default.
    grant_expires_at := current_timestamp + make_interval(mins => requested_duration_minutes);
    insert into identity.access_requests (
      id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use,
      reason, status, requested_duration_minutes, break_glass, approved_at,
      correlation_id, authorization_method
    ) values (
      request_id_value, patient_id_value, actor_staff_id, actor_membership_id,
      actor_facility_id, 'read_records', 'direct-care', 'Patient access PIN verification',
      'approved', requested_duration_minutes, false, current_timestamp, actor_correlation_id,
      'patient_access_pin'
    );
    insert into identity.consent_grants (
      id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
      scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass,
      correlation_id, authorization_method
    ) values (
      grant_id_value, request_id_value, patient_id_value, actor_staff_id, actor_account_id_value,
      actor_membership_id, actor_facility_id, 'read_records', 'direct-care', 'active',
      'Patient access PIN verification', current_timestamp, grant_expires_at, false,
      actor_correlation_id, 'patient_access_pin'
    );
  else
    replayed := true;
  end if;

  insert into identity.patient_access_pin_attempts (
    actor_account_id, membership_id, facility_id, patient_id, outcome, correlation_id
  ) values (actor_account_id_value, actor_membership_id, actor_facility_id, patient_id_value, 'success', actor_correlation_id);
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor_correlation_id, 'staff', actor_subject, actor_account_id_value, actor_membership_id,
    actor_organization_id, actor_facility_id, patient_id_value,
    case when replayed then 'identity.patient-access-pin.replay' else 'identity.patient-access-pin.verify' end,
    'success', 'consent-grant', grant_id_value::text, 'direct-care', 'application', 'identity-api',
    jsonb_build_object('access_request_id', request_id_value, 'duration_minutes', requested_duration_minutes,
      'expires_at', grant_expires_at, 'existing_grant', replayed, 'review_required', true)
  );
  if not replayed then
    insert into identity.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id, patient_id, correlation_id, payload
    ) values (
      'PatientAccessPinVerified', grant_id_value, 1, actor_facility_id, patient_id_value,
      actor_correlation_id, jsonb_build_object('consentGrantId', grant_id_value, 'reviewRequired', true)
    );
  end if;
  return query select true, request_id_value, grant_id_value, patient_id_value,
    'active'::text, grant_expires_at, replayed;
end;
$$;

-- R4 (0086): an order goes to a receiving facility on the sender's side only.
create or replace function ehr.send_order_route(
  requested_route_id uuid,
  requested_kind text,
  requested_patient_id uuid,
  requested_order_id uuid,
  requested_encounter_id uuid,
  expected_order_version bigint,
  requested_receiving_facility_id uuid,
  requested_attestation_text_version text,
  requested_idempotency_key text,
  requested_request_sha256 char(64)
) returns table (
  route_id uuid,
  reference text,
  state text,
  row_version bigint,
  created_at timestamptz,
  respond_by timestamptz,
  receiving_facility_name text,
  order_row_version bigint,
  order_status text,
  replayed boolean
)
language plpgsql security definer
set search_path = pg_catalog, ehr, identity, auth, lab, pharmacy, notification, platform, pg_temp
as $$
declare
  actor record;
  limits record;
  sent_at timestamptz;
  write_permission text := ehr.order_route_write_permission(requested_kind);
  prior ehr.order_routes%rowtype;
  stale ehr.order_routes%rowtype;
  changed ehr.order_routes%rowtype;
  inserted ehr.order_routes%rowtype;
  lab_order ehr.lab_requests%rowtype;
  prescription_order ehr.prescriptions%rowtype;
  order_found boolean := false;
  order_version bigint;
  order_state text;
  order_creator uuid;
  order_creator_membership uuid;
  receiving_facility identity.facilities%rowtype;
  previous_reason text;
  sender_name text;
  orderer_full_name text;
  licence_body text;
  licence_number text;
  replay_version bigint;
  replay_status text;
begin
  select * into actor from ehr.order_route_staff_actor(true);
  if not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id, actor.actor_facility_id,
           'ehr.order-route.send')
     or (write_permission is not null
       and not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id, actor.actor_facility_id,
             write_permission)) then
    raise exception using errcode = '42501', message = 'ORDER_ROUTE_PERMISSION_DENIED';
  end if;
  if write_permission is null or requested_route_id is null or requested_patient_id is null
     or requested_order_id is null or requested_encounter_id is null or requested_receiving_facility_id is null
     or expected_order_version is null or expected_order_version < 1
     or not coalesce(requested_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$', false)
     or not coalesce(requested_request_sha256 ~ '^[0-9a-f]{64}$', false)
     or not exists (select 1 from ehr.order_route_attestation_texts text_row
                     where text_row.version = requested_attestation_text_version
                       and text_row.kind = requested_kind) then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  perform platform.require_control_enabled('cross_facility_orders_enabled');

  -- Replay by the sender's idempotency key at this facility.
  select route.* into prior
    from ehr.order_routes route
   where route.sent_by_account_id = actor.actor_account_id
     and route.ordering_facility_id = actor.actor_facility_id
     and route.idempotency_key = requested_idempotency_key;
  if prior.id is not null then
    if prior.request_sha256 is distinct from requested_request_sha256 then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    if prior.kind = 'lab_request' then
      select source_order.row_version, source_order.status into replay_version, replay_status
        from ehr.lab_requests source_order where source_order.id = prior.source_lab_request_id;
    else
      select source_order.row_version, source_order.status into replay_version, replay_status
        from ehr.prescriptions source_order where source_order.id = prior.source_prescription_id;
    end if;
    return query select prior.id, prior.reference::text, ehr.order_route_effective_state(prior), prior.row_version,
      prior.created_at, prior.respond_by,
      (select facility.name from identity.facilities facility where facility.id = prior.receiving_facility_id),
      replay_version, replay_status, true;
    return;
  end if;

  if requested_attestation_text_version is distinct from (
       select text_row.version from ehr.order_route_attestation_texts text_row
        where text_row.kind = requested_kind
        order by text_row.created_at desc, text_row.version desc limit 1) then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ATTESTATION_OUTDATED';
  end if;

  -- The order: the patient's, in that encounter, at this facility, under the
  -- member's write consent; locked FOR NO KEY UPDATE (FEAS K1: a receiving
  -- Lab's work-item insert takes FOR KEY SHARE on it through its new key).
  if ehr.context_allows(requested_patient_id, actor.actor_facility_id, 'write_records') then
    if requested_kind = 'lab_request' then
      select source_order.* into lab_order
        from ehr.lab_requests source_order
       where source_order.id = requested_order_id and source_order.patient_id = requested_patient_id
         and source_order.encounter_id = requested_encounter_id
         and source_order.facility_id = actor.actor_facility_id
       for no key update;
      order_found := lab_order.id is not null;
      order_version := lab_order.row_version;
      order_state := lab_order.status;
      order_creator := lab_order.created_by;
      order_creator_membership := lab_order.created_by_membership_id;
    else
      select source_order.* into prescription_order
        from ehr.prescriptions source_order
       where source_order.id = requested_order_id and source_order.patient_id = requested_patient_id
         and source_order.encounter_id = requested_encounter_id
         and source_order.facility_id = actor.actor_facility_id
       for no key update;
      order_found := prescription_order.id is not null;
      order_version := prescription_order.row_version;
      order_state := prescription_order.status;
      order_creator := prescription_order.created_by;
      order_creator_membership := prescription_order.created_by_membership_id;
    end if;
  end if;
  if not order_found then
    raise exception using errcode = 'P0002', message = 'ORDER_NOT_FOUND';
  end if;
  if order_version <> expected_order_version then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_VERSION_CONFLICT';
  end if;
  if order_state not in ('draft', 'active') then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ORDER_NOT_ELIGIBLE';
  end if;

  -- The ordering organization's application, then the receiving one's (V4).
  select facility.* into receiving_facility from identity.facilities facility
   where facility.id = requested_receiving_facility_id;
  perform identity.lock_self_service_application(actor.actor_organization_id);
  if receiving_facility.id is not null then
    perform identity.lock_self_service_application(receiving_facility.organization_id);
  end if;
  if receiving_facility.id is null or receiving_facility.id = actor.actor_facility_id
     or not identity.order_route_destination_eligible(receiving_facility.id, requested_kind)
     or identity.sealed_demo_facility(receiving_facility.id) <> identity.sealed_demo_facility(actor.actor_facility_id) then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_DESTINATION_INELIGIBLE';
  end if;

  -- The order's routes, in id order; a sent route past respond_by is stored
  -- expired here.
  for stale in
    select route.* from ehr.order_routes route
     where (requested_kind = 'lab_request' and route.source_lab_request_id = requested_order_id)
        or (requested_kind = 'prescription' and route.source_prescription_id = requested_order_id)
     order by route.id
     for update
  loop
    if stale.state = 'sent' and clock_timestamp() >= stale.respond_by then
      changed := stale;
      changed.state := 'expired';
      changed.ended_at := clock_timestamp();
      changed.ended_kind := 'not_accepted';
      perform ehr.write_order_route_change(stale, changed, 'expired', 'system', 'not_accepted');
    end if;
  end loop;
  if exists (select 1 from ehr.order_routes route
              where ((requested_kind = 'lab_request' and route.source_lab_request_id = requested_order_id)
                  or (requested_kind = 'prescription' and route.source_prescription_id = requested_order_id))
                and route.state in ('sent', 'accepted', 'completed')) then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ALREADY_SENT';
  end if;
  if exists (select 1 from ehr.order_routes route
              where ((requested_kind = 'lab_request' and route.source_lab_request_id = requested_order_id)
                  or (requested_kind = 'prescription' and route.source_prescription_id = requested_order_id))
                and route.accepted_at is not null)
     or (requested_kind = 'lab_request'
       and exists (select 1 from lab.work_items item where item.source_ehr_order_id = requested_order_id))
     or (requested_kind = 'prescription'
       and exists (select 1 from pharmacy.work_items item where item.source_ehr_prescription_id = requested_order_id)) then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ORDER_IN_WORK';
  end if;
  select * into limits from ehr.order_route_limits();
  if (select count(*) from ehr.order_routes route
       where (requested_kind = 'lab_request' and route.source_lab_request_id = requested_order_id)
          or (requested_kind = 'prescription' and route.source_prescription_id = requested_order_id))
     >= limits.routes_per_order then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_RESEND_LIMIT';
  end if;
  if identity.patient_denies_order_route(requested_patient_id, receiving_facility.id) then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_PATIENT_DENIED';
  end if;

  -- The limits, serialized per sender and then per destination.
  perform pg_advisory_xact_lock(hashtextextended('order-route-sender:' || actor.actor_membership_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('order-route-destination:' || receiving_facility.id::text, 0));
  if (select count(*) from ehr.order_routes route
       where route.sent_by_membership_id = actor.actor_membership_id
         and route.created_at > clock_timestamp() - interval '24 hours') >= limits.sends_per_member_per_day then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_SEND_LIMIT';
  end if;
  if (select count(*) from ehr.order_routes route
       where route.ordering_facility_id = actor.actor_facility_id
         and route.receiving_facility_id = receiving_facility.id
         and route.created_at > clock_timestamp() - interval '24 hours') >= limits.sends_per_pair_per_day then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_PAIR_LIMIT';
  end if;
  if (select count(*) from ehr.order_routes route
       where route.receiving_facility_id = receiving_facility.id
         and route.state = 'sent'
         and route.respond_by > clock_timestamp()) >= limits.open_per_destination then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_DESTINATION_BUSY';
  end if;
  -- V12: the patient must have an active account, or the notice and the
  -- Stop of the sixth set could not reach them.
  if not exists (select 1 from identity.patients patient
                   join auth.accounts account on account.id = patient.account_id
                  where patient.id = requested_patient_id and patient.status = 'active'
                    and account.status = 'active') then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_PATIENT_APP_REQUIRED';
  end if;

  select left(btrim(staff.full_name), 200) into sender_name
    from identity.staff staff where staff.account_id = actor.actor_account_id;
  select left(btrim(staff.full_name), 200) into orderer_full_name
    from identity.staff staff where staff.account_id = order_creator;
  if coalesce(length(sender_name), 0) < 2 or coalesce(length(orderer_full_name), 0) < 2 then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  -- The orderer's licence: the newest facility attestation of the ordering
  -- membership in the doctor role whose role grant is still in force (P4b),
  -- else none ("Licence not on record").
  select attestation.licence_body, attestation.licence_number into licence_body, licence_number
    from identity.staff_licence_attestations attestation
    join auth.account_roles role_grant on role_grant.id = attestation.role_grant_id and role_grant.revoked_at is null
   where attestation.membership_id = order_creator_membership
     and attestation.role_code = 'doctor'
   order by attestation.recorded_at desc, attestation.id desc
   limit 1;

  -- Activate a draft (the EHR's own versioning trigger records the change).
  if order_state = 'draft' then
    previous_reason := current_setting('app.change_reason', true);
    perform set_config('app.change_reason', 'Activated to send to another facility', true);
    if requested_kind = 'lab_request' then
      update ehr.lab_requests source_order set status = 'active'
       where source_order.id = requested_order_id
      returning source_order.* into lab_order;
      order_version := lab_order.row_version;
    else
      update ehr.prescriptions source_order set status = 'active'
       where source_order.id = requested_order_id
      returning source_order.* into prescription_order;
      order_version := prescription_order.row_version;
    end if;
    perform set_config('app.change_reason', coalesce(previous_reason, ''), true);
    order_state := 'active';
  end if;

  sent_at := clock_timestamp();
  if requested_kind = 'lab_request' then
    insert into ehr.order_routes as route (id, kind, patient_id, ordering_organization_id, ordering_facility_id,
      source_lab_request_id, source_encounter_id, source_order_version, receiving_organization_id,
      receiving_facility_id, state, sent_by_account_id, sent_by_membership_id, created_at, respond_by,
      patient_agreement, attestation_text_version, attested_by_name, attested_receiving_facility_name,
      orderer_account_id, orderer_membership_id, orderer_name, orderer_licence_body, orderer_licence_number,
      test_code_system, test_code, test_display, priority, specimen_type_code, clinical_information, requested_at,
      idempotency_key, request_sha256, correlation_id)
    values (requested_route_id, 'lab_request', requested_patient_id, actor.actor_organization_id,
      actor.actor_facility_id, lab_order.id, lab_order.encounter_id, order_version,
      receiving_facility.organization_id, receiving_facility.id, 'sent', actor.actor_account_id,
      actor.actor_membership_id, sent_at, sent_at + interval '168 hours', 'clinician_attested',
      requested_attestation_text_version, sender_name, left(btrim(receiving_facility.name), 200),
      lab_order.created_by, lab_order.created_by_membership_id, orderer_full_name, licence_body, licence_number,
      lab_order.test_code_system, lab_order.test_code, lab_order.test_display, lab_order.priority,
      lab_order.specimen_type_code, lab_order.clinical_information, lab_order.created_at,
      requested_idempotency_key, requested_request_sha256, platform.current_correlation_id())
    returning route.* into inserted;
  else
    insert into ehr.order_routes as route (id, kind, patient_id, ordering_organization_id, ordering_facility_id,
      source_prescription_id, source_encounter_id, source_order_version, receiving_organization_id,
      receiving_facility_id, state, sent_by_account_id, sent_by_membership_id, created_at, respond_by,
      patient_agreement, attestation_text_version, attested_by_name, attested_receiving_facility_name,
      orderer_account_id, orderer_membership_id, orderer_name, orderer_licence_body, orderer_licence_number,
      medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code,
      frequency, instructions, starts_on, ends_on, prescribed_at,
      idempotency_key, request_sha256, correlation_id)
    values (requested_route_id, 'prescription', requested_patient_id, actor.actor_organization_id,
      actor.actor_facility_id, prescription_order.id, prescription_order.encounter_id, order_version,
      receiving_facility.organization_id, receiving_facility.id, 'sent', actor.actor_account_id,
      actor.actor_membership_id, sent_at, sent_at + interval '168 hours', 'clinician_attested',
      requested_attestation_text_version, sender_name, left(btrim(receiving_facility.name), 200),
      prescription_order.created_by, prescription_order.created_by_membership_id, orderer_full_name,
      licence_body, licence_number,
      prescription_order.medication_code_system, prescription_order.medication_code,
      prescription_order.medication_display, prescription_order.dose_quantity, prescription_order.dose_unit,
      prescription_order.route_code, prescription_order.frequency, prescription_order.instructions,
      prescription_order.starts_on, prescription_order.ends_on, prescription_order.created_at,
      requested_idempotency_key, requested_request_sha256, platform.current_correlation_id())
    returning route.* into inserted;
  end if;
  insert into ehr.order_route_events (route_id, event_version, event_type, side, actor_account_id,
    actor_membership_id, state_after, correlation_id)
  values (inserted.id, 1, 'created', 'ordering', actor.actor_account_id, actor.actor_membership_id, 'sent',
    platform.current_correlation_id());
  perform ehr.order_route_system_audit(inserted, 'receiving', 'ehr.order-route.received', false, null);
  perform ehr.order_route_notify_patient(inserted, 'ORDER_ROUTE_SENT');

  return query select inserted.id, inserted.reference::text, inserted.state, inserted.row_version,
    inserted.created_at, inserted.respond_by, receiving_facility.name, order_version, order_state, false;
end;
$$;

-- R5 (0086): the order directory lists facilities on the sender's side only.
create or replace function identity.search_order_destinations(requested_kind text, requested_query text)
returns table (
  facility_id uuid,
  facility_name text,
  organization_name text,
  registered_address text,
  new_on_health_id boolean
)
language plpgsql volatile security definer
set search_path = pg_catalog, identity, auth, ehr, platform, pg_temp
as $$
declare
  actor record;
  route_kind text := case requested_kind when 'lab_request' then 'lab_request' when 'laboratory' then 'lab_request'
                       when 'prescription' then 'prescription' when 'pharmacy' then 'prescription' end;
  pattern text;
  candidate record;
  found_count integer := 0;
begin
  select * into actor from ehr.order_route_staff_actor(false);
  if not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id, actor.actor_facility_id,
           'ehr.order-route.send') then
    raise exception using errcode = '42501', message = 'ORDER_ROUTE_PERMISSION_DENIED';
  end if;
  perform platform.require_control_enabled('cross_facility_orders_enabled');
  if route_kind is null or not coalesce(length(btrim(requested_query)) between 3 and 80, false) then
    raise exception using errcode = '22023', message = 'ORDER_DESTINATION_QUERY_INVALID';
  end if;
  pattern := '%' || replace(replace(replace(btrim(requested_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  for candidate in
    select facility.id, facility.name, facility.organization_id, organization.name as organization_name
      from identity.facilities facility
      join identity.organizations organization on organization.id = facility.organization_id
     where facility.id <> actor.actor_facility_id
       and facility.active
       and organization.active
       and identity.sealed_demo_facility(facility.id) = identity.sealed_demo_facility(actor.actor_facility_id)
       and (facility.name ilike pattern escape '\' or organization.name ilike pattern escape '\')
       and exists (select 1 from identity.organization_products product
                     join identity.organization_applications source_application
                       on source_application.id = product.source_application_id
                    where product.facility_id = facility.id and product.status = 'active'
                      and source_application.organization_type = ehr.order_route_destination_type(route_kind))
     order by facility.name, facility.id
     limit 200
  loop
    perform identity.lock_self_service_application(candidate.organization_id);
    if identity.order_route_destination_eligible(candidate.id, route_kind) then
      found_count := found_count + 1;
      return query select candidate.id, candidate.name, candidate.organization_name,
        identity.order_route_registered_address(candidate.id), identity.self_service_on_probation(candidate.id);
      exit when found_count >= 10;
    end if;
  end loop;
end;
$$;

-- R6 (0095): the share directory lists clinicians on the patient's side only.
create or replace function identity.search_share_providers(requested_subject text, requested_session uuid, requested_query text)
returns table (membership_id uuid, clinician_name text, role_code text, facility_name text,
  organization_name text, new_on_health_id boolean)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
  pattern text;
  candidate record;
  found_count integer := 0;
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if not coalesce(length(btrim(requested_query)) between 3 and 80, false) then
    raise exception using errcode = '22023', message = 'SHARE_SEARCH_QUERY_INVALID';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  pattern := '%' || replace(replace(replace(btrim(requested_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  for candidate in
    select membership.id, staff.full_name, facility.id as facility_id, facility.name as facility_name,
           organization.name as organization_name
      from identity.staff_facility_memberships membership
      join identity.staff staff on staff.id = membership.staff_id and staff.account_id = membership.account_id
      join identity.facilities facility on facility.id = membership.facility_id
      join identity.organizations organization on organization.id = membership.organization_id
     where membership.active and staff.active and facility.active and organization.active
       and membership.migration_hold_reason is null
       and identity.sealed_demo_facility(facility.id) = identity.sealed_demo_patient(patient_id_value)
       and membership.account_id <> account_id_value
       and (staff.full_name ilike pattern escape '\' or facility.name ilike pattern escape '\'
         or organization.name ilike pattern escape '\')
       and exists (select 1 from auth.account_roles assignment
                    where assignment.membership_id = membership.id and assignment.account_id = membership.account_id
                      and assignment.facility_id = membership.facility_id and assignment.scope_type = 'facility'
                      and assignment.revoked_at is null and assignment.role_code in ('doctor', 'clinician', 'nurse'))
     order by staff.full_name, membership.id
     limit 200
  loop
    if identity.share_provider_eligible(candidate.id) then
      found_count := found_count + 1;
      return query select candidate.id, candidate.full_name, identity.share_provider_role(candidate.id),
        candidate.facility_name, candidate.organization_name, identity.self_service_on_probation(candidate.facility_id);
      exit when found_count >= 25;
    end if;
  end loop;
  perform identity.share_audit('patient', requested_subject, account_id_value, null, null, patient_id_value,
    'identity.share-providers.search', 'success', 'share-provider-search', null, 'patient-self',
    jsonb_build_object('resultCount', found_count));
end
$$;

-- R7 (0094): a demo patient's email changes to a demo mailbox only.
create or replace function identity.start_my_email_change(
  requested_subject text, requested_session uuid, requested_change_id uuid, requested_email text,
  requested_lookup_hmac char(64), requested_ciphertext bytea, requested_key_version text,
  requested_verifier_hmac char(64), requested_verifier_key_version text, requested_ttl_seconds integer,
  requested_max_attempts integer, requested_resend_seconds integer
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  normalized_email text := lower(btrim(requested_email));
  account_row auth.accounts%rowtype;
begin
  if patient_id_value is null or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_change_id is null
     or normalized_email is null or length(normalized_email) > 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or coalesce(requested_lookup_hmac, '') !~ '^[0-9a-f]{64}$'
     or coalesce(requested_verifier_hmac, '') !~ '^[0-9a-f]{64}$'
     or requested_ciphertext is null or octet_length(requested_ciphertext) not between 30 and 2048
     or coalesce(length(requested_key_version), 0) not between 1 and 64
     or coalesce(length(requested_verifier_key_version), 0) not between 1 and 64
     or coalesce(requested_ttl_seconds, 0) not between 60 and 1800
     or coalesce(requested_max_attempts, 0) not between 1 and 10
     or coalesce(requested_resend_seconds, 0) not between 10 and 600 then
    raise exception using errcode = '22023', message = 'PATIENT_CONTACT_CHANGE_INVALID';
  end if;
  if identity.sealed_demo_patient(patient_id_value) and not identity.sealed_demo_recipient(normalized_email) then
    return 'unavailable';
  end if;
  -- One contact change of a patient at a time.
  perform pg_advisory_xact_lock(hashtextextended('patient-contact-change:' || patient_id_value::text, 0));
  select account.* into account_row
    from identity.patients patient
    join auth.accounts account on account.id = patient.account_id
   where patient.id = patient_id_value;
  -- An account that is also workforce (0093's test): its email is the staff
  -- sign-in and identity.staff's address too, which a patient's change must
  -- not move apart. Nothing is recorded.
  if exists (select 1 from auth.account_roles role_assignment where role_assignment.account_id = account_row.id)
     or exists (select 1 from identity.staff staff_record where staff_record.account_id = account_row.id)
     or exists (select 1 from identity.staff_facility_memberships membership
                 where membership.account_id = account_row.id) then
    return 'workforce';
  end if;
  -- The account's own address once verified; an unverified one goes through
  -- the code, which verifies it (6f).
  if lower(account_row.email) = normalized_email and account_row.email_verified_at is not null then
    return 'unchanged';
  end if;
  if exists (select 1 from identity.patient_contact_changes change_row
              where change_row.patient_id = patient_id_value and change_row.channel = 'email'
                and change_row.created_at > clock_timestamp() - make_interval(secs => requested_resend_seconds))
     or (select count(*) from identity.patient_contact_changes change_row
          where change_row.patient_id = patient_id_value and change_row.channel = 'email'
            and change_row.created_at > clock_timestamp() - interval '1 hour') >= 5 then
    return 'rate_limited';
  end if;
  update identity.patient_contact_changes
     set state = 'invalidated', invalidated_at = clock_timestamp(), invalidation_reason = 'superseded',
         new_ciphertext = null, row_version = row_version + 1
   where patient_id = patient_id_value and channel = 'email' and state = 'pending';
  -- Another account's email, another patient's contact email (as sign-up
  -- refuses it) or a staff record's email (staff_email_ci_uq; staff
  -- invitations read it): recorded without the address, so that it counts,
  -- and audited as denied (the superseded change with it).
  if exists (select 1 from auth.accounts other
              where lower(other.email) = normalized_email and other.status <> 'deleted'
                and other.id <> account_row.id)
     or exists (select 1 from identity.patients other
                 where other.email_lookup_hmac = requested_lookup_hmac and other.id <> patient_id_value)
     or exists (select 1 from identity.staff staff_record where lower(staff_record.email) = normalized_email) then
    insert into identity.patient_contact_changes (id, patient_id, account_id, channel, state, new_lookup_hmac,
      new_ciphertext, key_version, verifier_hmac, verifier_key_version, expires_at, max_attempts, delivery_outcome,
      invalidated_at, invalidation_reason)
    values (requested_change_id, patient_id_value, account_row.id, 'email', 'invalidated', requested_lookup_hmac,
      null, requested_key_version, requested_verifier_hmac, requested_verifier_key_version,
      clock_timestamp() + make_interval(secs => requested_ttl_seconds), requested_max_attempts, 'pending',
      clock_timestamp(), 'contact_unavailable');
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
      action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'patient', requested_subject, account_row.id, patient_id_value,
      'identity.patient.contact-change.start', 'denied', 'patient-contact-change', requested_change_id::text,
      'patient-self', 'application', 'identity-api', jsonb_build_object('channel', 'email', 'result', 'unavailable'));
    return 'unavailable';
  end if;
  insert into identity.patient_contact_changes (id, patient_id, account_id, channel, state, new_lookup_hmac,
    new_ciphertext, key_version, verifier_hmac, verifier_key_version, expires_at, max_attempts, delivery_outcome)
  values (requested_change_id, patient_id_value, account_row.id, 'email', 'pending', requested_lookup_hmac,
    requested_ciphertext, requested_key_version, requested_verifier_hmac, requested_verifier_key_version,
    clock_timestamp() + make_interval(secs => requested_ttl_seconds), requested_max_attempts, 'pending');
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'patient', requested_subject, account_row.id, patient_id_value,
    'identity.patient.contact-change.start', 'success', 'patient-contact-change', requested_change_id::text,
    'patient-self', 'application', 'identity-api', jsonb_build_object('channel', 'email'));
  return 'started';
end
$$;

-- R8 (0027): the platform overview counts real tenants only.
create or replace function identity.admin_platform_overview()
returns table (
  registered_patients bigint,
  facilities bigint,
  verified_facilities bigint,
  suspended_facilities bigint,
  active_memberships bigint,
  pending_identity_reviews bigint
)
language plpgsql
stable
security definer
set search_path = identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  return query select
    (select count(*) from identity.patients patient where patient.status <> 'deleted'
      and (patient.id = any ((select identity.sealed_demo_ids('patient'))::uuid[])) is not true),
    (select count(*) from identity.facilities facility
      where (facility.id = any ((select identity.sealed_demo_ids('facility'))::uuid[])) is not true),
    (select count(*) from identity.facilities facility where facility.lifecycle_status = 'verified'
      and (facility.id = any ((select identity.sealed_demo_ids('facility'))::uuid[])) is not true),
    (select count(*) from identity.facilities facility where facility.lifecycle_status = 'suspended'
      and (facility.id = any ((select identity.sealed_demo_ids('facility'))::uuid[])) is not true),
    (select count(*) from identity.staff_facility_memberships membership
      where membership.active and membership.migration_hold_reason is null
        and (membership.facility_id = any ((select identity.sealed_demo_ids('facility'))::uuid[])) is not true),
    (select count(*) from identity.registration_cases registration
      where registration.status in ('pending_new_identity_approval', 'review_required')
        and (registration.facility_id = any ((select identity.sealed_demo_ids('facility'))::uuid[])) is not true);
end
$$;

-- 6. Grants (here and in runtime-grants.sql).
revoke all on function identity.sealed_demo_ids(text), identity.sealed_demo_facility(uuid),
  identity.sealed_demo_patient(uuid), identity.sealed_demo_account(uuid), identity.sealed_demo_recipient(text),
  identity.sealed_demo_contact_allowed(text,uuid,text,text,character), identity.sealed_demo_application(uuid),
  identity.sealed_demo_install(), identity.consent_grants_sealed_demo(), identity.staff_memberships_sealed_demo(),
  identity.account_roles_sealed_demo(), identity.patient_share_invitations_sealed_demo(),
  identity.patient_contact_changes_sealed_demo(), identity.qoreid_quota_counters_sealed_demo(),
  identity.patient_emergency_contacts_sealed_demo() from public;

do $$
declare grantee text;
begin
  foreach grantee in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant execute on function identity.sealed_demo_ids(text), '
        || 'identity.sealed_demo_facility(uuid), identity.sealed_demo_application(uuid), '
        || 'identity.sealed_demo_contact_allowed(text,uuid,text,text,character) to %I', grantee);
    end if;
  end loop;
end
$$;

-- 7. Post-checks (after the grants, so the ACLs are the final ones; the
-- policy's in section 11).
do $$
declare
  applier oid := (select oid from pg_roles where rolname = current_user);
  mismatch text;
begin
  -- The table and its key belong to the applier; RLS enabled, not forced,
  -- with exactly the one owner policy; only the owner holds any privilege on
  -- it; no sequence.
  if exists (select 1 from pg_class relation
              where relation.oid in ('identity.sealed_demo_members'::regclass,
                      'identity.sealed_demo_members_pkey'::regclass)
                and relation.relowner <> applier)
     or not exists (select 1 from pg_class relation
                     where relation.oid = 'identity.sealed_demo_members'::regclass
                       and relation.relrowsecurity and not relation.relforcerowsecurity)
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid = 'identity.sealed_demo_members'::regclass) <> 1
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'identity.sealed_demo_members'::regclass
                       and policy_row.polname = 'sealed_demo_members_owner'
                       and policy_row.polpermissive and policy_row.polcmd = '*'
                       and policy_row.polroles = '{0}'::oid[]
                       and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                         = format('(CURRENT_USER = %L::name)', current_user)
                       and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid)
                         = format('(CURRENT_USER = %L::name)', current_user))
     or exists (select 1 from pg_class relation,
                  aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                 where relation.oid = 'identity.sealed_demo_members'::regclass
                   and acl.grantee <> relation.relowner)
     or exists (select 1 from pg_depend dependency join pg_class sequence_row on sequence_row.oid = dependency.objid
                 where sequence_row.relkind = 'S' and dependency.refobjid = 'identity.sealed_demo_members'::regclass) then
    raise exception using errcode = '55000', message = '0098: the table is not as this file makes it';
  end if;
  -- The 15 new functions: the applier's, with this search_path, language,
  -- volatility and SECURITY DEFINER (all but the recipient check).
  select string_agg(coalesce(proc.oid::regprocedure::text, expected.signature), ', ') into mismatch
    from (values
      ('identity.sealed_demo_ids(text)', true, 's', 'sql'),
      ('identity.sealed_demo_facility(uuid)', true, 's', 'sql'),
      ('identity.sealed_demo_patient(uuid)', true, 's', 'sql'),
      ('identity.sealed_demo_account(uuid)', true, 's', 'sql'),
      ('identity.sealed_demo_recipient(text)', false, 'i', 'sql'),
      ('identity.sealed_demo_contact_allowed(text,uuid,text,text,character)', true, 'v', 'plpgsql'),
      ('identity.sealed_demo_application(uuid)', true, 's', 'sql'),
      ('identity.sealed_demo_install()', true, 'v', 'plpgsql'),
      ('identity.consent_grants_sealed_demo()', true, 'v', 'plpgsql'),
      ('identity.staff_memberships_sealed_demo()', true, 'v', 'plpgsql'),
      ('identity.account_roles_sealed_demo()', true, 'v', 'plpgsql'),
      ('identity.patient_share_invitations_sealed_demo()', true, 'v', 'plpgsql'),
      ('identity.patient_contact_changes_sealed_demo()', true, 'v', 'plpgsql'),
      ('identity.qoreid_quota_counters_sealed_demo()', true, 'v', 'plpgsql'),
      ('identity.patient_emergency_contacts_sealed_demo()', true, 'v', 'plpgsql'))
         expected(signature, definer, volatility, language_name)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.signature)
   where proc.oid is null or proc.proowner <> applier or proc.prosecdef <> expected.definer
      or proc.provolatile::text <> expected.volatility
      or proc.prolang <> (select language_row.oid from pg_language language_row
                           where language_row.lanname = expected.language_name)
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[];
  if mismatch is not null
     or (select count(*) from pg_proc proc
          where proc.pronamespace = 'identity'::regnamespace
            and (proc.proname like 'sealed\_demo\_%' or proc.proname like '%\_sealed\_demo')) <> 15 then
    raise exception using errcode = '55000',
      message = format('0098: a new function is not as this file makes it: %s', coalesce(mismatch, 'count'));
  end if;
  -- The function ACLs: the two policy helpers, the application marker and the
  -- emergency-contact check to the owner and the two runtimes (each that
  -- exists holds EXECUTE); the other eleven to the owner only; never PUBLIC.
  select string_agg(format('%s to %s', granted.what, granted.grantee_name), '; ') into mismatch
    from (
      select proc.oid::regprocedure::text as what,
             case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end as grantee_name
        from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where proc.pronamespace = 'identity'::regnamespace
         and (proc.proname like 'sealed\_demo\_%' or proc.proname like '%\_sealed\_demo')
         and acl.grantee <> proc.proowner
         and (proc.oid not in ('identity.sealed_demo_ids(text)'::regprocedure,
                'identity.sealed_demo_facility(uuid)'::regprocedure,
                'identity.sealed_demo_application(uuid)'::regprocedure,
                'identity.sealed_demo_contact_allowed(text,uuid,text,text,character)'::regprocedure)
              or acl.grantee = 0
              or pg_get_userbyid(acl.grantee) not in ('hid_identity_runtime', 'hid_schema_test_runtime')
              or acl.privilege_type <> 'EXECUTE')
      union all
      select proc.oid::regprocedure::text, 'missing ' || role_row.rolname
        from pg_proc proc cross join pg_roles role_row
       where proc.oid in ('identity.sealed_demo_ids(text)'::regprocedure,
               'identity.sealed_demo_facility(uuid)'::regprocedure,
               'identity.sealed_demo_application(uuid)'::regprocedure,
               'identity.sealed_demo_contact_allowed(text,uuid,text,text,character)'::regprocedure)
         and role_row.rolname in ('hid_identity_runtime', 'hid_schema_test_runtime')
         and not exists (select 1 from aclexplode(proc.proacl) acl
                          where acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')
      union all
      -- Whoever reads identity.patients under its policies (not its owner, a
      -- superuser or a role that bypasses row-level security) runs the two
      -- helpers the policy calls.
      select 'identity.patients policy helpers', 'not executable by ' || role_row.rolname
        from pg_roles role_row
       where role_row.rolname !~ '^pg_' and not role_row.rolsuper and not role_row.rolbypassrls
         and has_table_privilege(role_row.oid, 'identity.patients', 'SELECT')
         and not pg_has_role(role_row.oid, (select relation.relowner from pg_class relation
                                             where relation.oid = 'identity.patients'::regclass), 'USAGE')
         and (not has_function_privilege(role_row.oid, 'identity.sealed_demo_ids(text)', 'EXECUTE')
           or not has_function_privilege(role_row.oid, 'identity.sealed_demo_facility(uuid)', 'EXECUTE'))) granted;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0098: a function ACL is not section 6''s: %s', mismatch);
  end if;
  -- The nine triggers are the ones this file creates.
  select string_agg(expected.trigger_name, '; ') into mismatch
    from (values
      ('identity.sealed_demo_members', 'sealed_demo_members_immutable',
       'CREATE TRIGGER sealed_demo_members_immutable BEFORE DELETE OR UPDATE ON identity.sealed_demo_members FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()'),
      ('identity.sealed_demo_members', 'sealed_demo_members_no_truncate',
       'CREATE TRIGGER sealed_demo_members_no_truncate BEFORE TRUNCATE ON identity.sealed_demo_members FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()'),
      ('identity.consent_grants', 'consent_grants_sealed_demo',
       'CREATE TRIGGER consent_grants_sealed_demo BEFORE INSERT OR UPDATE OF patient_id, membership_id, facility_id ON identity.consent_grants FOR EACH ROW EXECUTE FUNCTION identity.consent_grants_sealed_demo()'),
      ('identity.staff_facility_memberships', 'staff_memberships_sealed_demo',
       'CREATE TRIGGER staff_memberships_sealed_demo BEFORE INSERT OR UPDATE OF account_id, facility_id ON identity.staff_facility_memberships FOR EACH ROW EXECUTE FUNCTION identity.staff_memberships_sealed_demo()'),
      ('auth.account_roles', 'account_roles_sealed_demo',
       $t$CREATE TRIGGER account_roles_sealed_demo BEFORE INSERT OR UPDATE OF account_id, scope_type, revoked_at ON auth.account_roles FOR EACH ROW WHEN (((new.scope_type = 'platform'::text) AND (new.revoked_at IS NULL))) EXECUTE FUNCTION identity.account_roles_sealed_demo()$t$),
      ('identity.patient_share_invitations', 'patient_share_invitations_sealed_demo',
       'CREATE TRIGGER patient_share_invitations_sealed_demo BEFORE INSERT OR UPDATE OF invitee_email, accepted_membership_id ON identity.patient_share_invitations FOR EACH ROW EXECUTE FUNCTION identity.patient_share_invitations_sealed_demo()'),
      ('identity.patient_contact_changes', 'patient_contact_changes_sealed_demo',
       $t$CREATE TRIGGER patient_contact_changes_sealed_demo BEFORE INSERT ON identity.patient_contact_changes FOR EACH ROW WHEN ((new.channel = 'phone'::text)) EXECUTE FUNCTION identity.patient_contact_changes_sealed_demo()$t$),
      ('platform.qoreid_quota_counters', 'qoreid_quota_counters_sealed_demo',
       $t$CREATE TRIGGER qoreid_quota_counters_sealed_demo BEFORE INSERT ON platform.qoreid_quota_counters FOR EACH ROW WHEN ((new.scope_type = 'account'::text)) EXECUTE FUNCTION identity.qoreid_quota_counters_sealed_demo()$t$),
      ('identity.patient_emergency_contacts', 'patient_emergency_contacts_sealed_demo',
       'CREATE TRIGGER patient_emergency_contacts_sealed_demo BEFORE INSERT OR UPDATE OF channel, destination_hmac ON identity.patient_emergency_contacts FOR EACH ROW EXECUTE FUNCTION identity.patient_emergency_contacts_sealed_demo()'))
         expected(relation_name, trigger_name, definition)
   where not exists (select 1 from pg_trigger trigger_row
                      where trigger_row.tgrelid = expected.relation_name::regclass
                        and trigger_row.tgname = expected.trigger_name and trigger_row.tgenabled = 'O'
                        and pg_get_triggerdef(trigger_row.oid) = expected.definition);
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0098: a trigger is not as this file makes it: %s', mismatch);
  end if;
  -- The replaced functions keep every attribute but the body, and have the
  -- bodies this file gives them.
  select string_agg(replaced.what, ', ') into mismatch
    from sealed_demo_0098_replaced replaced
    join pg_proc proc on proc.oid = replaced.oid
   where (proc.proowner, proc.proacl, proc.prolang, proc.provolatile, proc.prosecdef, proc.proconfig,
          proc.prorettype, proc.proretset, proc.proargnames, proc.proallargtypes, proc.proargmodes, proc.proargtypes)
     is distinct from (replaced.proowner, replaced.proacl, replaced.prolang, replaced.provolatile,
          replaced.prosecdef, replaced.proconfig, replaced.prorettype, replaced.proretset,
          replaced.proargnames, replaced.proallargtypes, replaced.proargmodes, replaced.proargtypes);
  if mismatch is not null or (select count(*) from sealed_demo_0098_replaced replaced
                                join pg_proc proc on proc.oid = replaced.oid) <> 8 then
    raise exception using errcode = '55000',
      message = format('0098: a replaced function changed more than its body: %s', coalesce(mismatch, 'count'));
  end if;
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none')), '; ') into mismatch
    from (values
      ('identity.create_access_request(text,text,text,integer)', 'f88923a49a180c2180fdedb29bf2eccf'),
      ('identity.activate_break_glass(text,text,integer)', '6b888391ef7f0e4f264918baf00a6fe7'),
      ('identity.access_patient_with_pin(text,text,integer)', '830c1baa4bca3df57cc02b7b002a8831'),
      ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', '4202ba3bbf02abd7db34606d42adca9c'),
      ('identity.search_order_destinations(text,text)', '7890a21333d012621a36302fd7ad24cc'),
      ('identity.search_share_providers(text,uuid,text)', '2cc1107289f6ff4d55266c6ee4842932'),
      ('identity.start_my_email_change(text,uuid,uuid,text,character,bytea,text,character,text,integer,integer,integer)', 'b253ba70b4532a62b15eae6ae50465c1'),
      ('identity.admin_platform_overview()', '3b1b2ca005647190ea623c40afb4f96f'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0098: a replaced body is not the one this file gives: %s', mismatch);
  end if;
  -- The 41 bodies the order-route suites pin are unchanged, and the
  -- order-route privilege suite's 97 functions are still 97 (the 91 its name
  -- pattern finds and the six it names; no new function matches the pattern).
  select string_agg(pinned.signature, '; ') into mismatch
    from sealed_demo_0098_pins pinned
    left join pg_proc proc on proc.oid = to_regprocedure(pinned.signature)
   where md5(proc.prosrc) is distinct from pinned.digest;
  if mismatch is not null
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname in ('ehr', 'lab', 'pharmacy', 'identity')
            and (proc.proname ~ '(order_route|order_destination)'
              or proc.proname in ('sync_order_routes_on_order_change', 'close_order_routes_on_release')))
        + (select count(*) from (values ('identity.list_my_notification_inbox(integer)'),
             ('identity.mark_my_notification_read(uuid)'), ('lab.work_item_allows(uuid,uuid,uuid,text)'),
             ('pharmacy.work_item_allows(uuid,uuid,uuid,text)'), ('identity.admin_list_wrong_patient_reports(text,uuid)'),
             ('identity.admin_review_wrong_patient_report(uuid,bigint,text[],text,boolean)')) named(signature)
            where to_regprocedure(named.signature) is not null) <> 97 then
    raise exception using errcode = '55000',
      message = format('0098: an order-route function changed: %s', coalesce(mismatch, 'count'));
  end if;
end
$$;

-- 8. Comments.
comment on table identity.sealed_demo_members is
  '0098: the sealed demo tenant''s organizations, facilities, accounts and patients. Owner only (row-level security enabled, not forced, so the owner''s helpers always read it), never updated, deleted or truncated. A facility and a patient (an account and a facility) are linked only when both are members or neither is.';
comment on function identity.sealed_demo_ids(text) is
  '0098: the member ids of a kind (organization, facility, account, patient), sorted. For identity.patients'' registration read and the platform overview.';
comment on function identity.sealed_demo_facility(uuid) is
  '0098: whether the facility belongs to the sealed demo tenant (false for null).';
comment on function identity.sealed_demo_patient(uuid) is
  '0098: whether the patient belongs to the sealed demo tenant (false for null).';
comment on function identity.sealed_demo_account(uuid) is
  '0098: whether the account belongs to the sealed demo tenant (false for null).';
comment on function identity.sealed_demo_recipient(text) is
  '0098: whether an address is one of the owner''s three demo mailboxes, an exact allowlist (any case, outer blanks trimmed): operations@healthidentitydirectory.com, patient1@healthidentitydirectory.com, patient2@healthidentitydirectory.com.';
comment on function identity.sealed_demo_contact_allowed(text,uuid,text,text,character) is
  '0098: Identity''s check before a patient adds an emergency contact: true unless the live session''s patient is a demo patient and the contact is not an email to a demo mailbox with a well-formed HMAC (64 lowercase hex characters) (42501 without a live patient session). True for a demo patient records the HMAC it was given in hid.sealed_demo_contact_hmac for the transaction, which G7 requires of a demo patient''s email contact. It cannot verify that the HMAC is the given address''s, and any session can set that setting itself: that the contact is a demo mailbox rests on Identity (EmergencyContactService.add computes the HMAC from the same normalized address it checks and encrypts).';
comment on function identity.sealed_demo_application(uuid) is
  '0098: whether an organization application belongs to a sealed demo facility (the admin applications list marks it demo).';
comment on function identity.sealed_demo_install() is
  '0098: installs the sealed demo tenant (Demo Hospital, Demo Laboratory, Demo Pharmacy, Demo Outreach; the staff login operations@healthidentitydirectory.com, pending_reset without a password; two patient logins patient1@healthidentitydirectory.com and patient2@healthidentitydirectory.com, each sharing with the demo login at Demo Hospital and Demo Outreach, written with identity.write_patient_share''s grant and share values and audited as the migration''s (system, provenance migration, identity.sealed-demo.seed-share), never as the patient''s; eight fictional patients). Refuses (55000) an address, id or key held by a real row, an address named by an open organization application or a pending staff invitation, or a share to a membership the patient could not choose. Inserts only; a second call inserts nothing. The owner sets each password through forgot-password; testers write in Patient One''s and Two''s charts through the shares, break-glass (read-only) the fictional patients, and test patient approvals and new shares after the 24-hour recovery hold.';
comment on function identity.consent_grants_sealed_demo() is
  '0098 G1: a consent grant links a facility and a patient on the same side of the sealed demo boundary (42501 SEALED_DEMO_BOUNDARY).';
comment on function identity.staff_memberships_sealed_demo() is
  '0098 G2: a staff membership links an account and a facility on the same side of the sealed demo boundary (42501 SEALED_DEMO_MEMBERSHIP_REFUSED).';
comment on function identity.account_roles_sealed_demo() is
  '0098 G3: a sealed demo account holds no platform role (42501 SEALED_DEMO_PLATFORM_ROLE_REFUSED).';
comment on function identity.patient_share_invitations_sealed_demo() is
  '0098 G4: a demo patient invites a demo mailbox only (22023 SHARE_INVITATION_EMAIL_INVALID); an invitation is accepted on the patient''s side of the boundary only (42501 SEALED_DEMO_BOUNDARY).';
comment on function identity.patient_contact_changes_sealed_demo() is
  '0098 G5: a demo patient never holds a phone (22023 PATIENT_CONTACT_CHANGE_INVALID).';
comment on function identity.qoreid_quota_counters_sealed_demo() is
  '0098 G6: a sealed demo account consumes no QoreID quota, so it causes no QoreID call (42501 QOREID_QUOTA_PERMISSION_DENIED).';
comment on function identity.patient_emergency_contacts_sealed_demo() is
  '0098 G7: for a demo patient, refuses (42501 EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED) an SMS contact, and an email contact (not deactivated) whose HMAC identity.sealed_demo_contact_allowed did not record in this transaction. The database holds only an HMAC and ciphertext, so it cannot tell whether either belongs to the checked address, and any session can set hid.sealed_demo_contact_hmac itself: that the destination is one of the three demo mailboxes rests on Identity (EmergencyContactService.add computes the HMAC from the same normalized address it checks and encrypts).';

-- 9. Section 0's helpers.
drop function pg_temp.sealed_demo_0098_holds(oid, oid, aclitem[], "char", text);
drop table pg_temp.sealed_demo_0098_replaced;
drop table pg_temp.sealed_demo_0098_pins;

-- 10. The seed, on Amazon RDS only (D3). A refusal raises 55000 and the
-- release stops with nothing applied.
do $$
declare summary jsonb;
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'rds_superuser') then
    summary := identity.sealed_demo_install();
    raise notice '0098: sealed demo installed: %', summary::text;
  else
    raise notice '0098: not an Amazon RDS database; the sealed demo is not installed (the seal is)';
  end if;
end
$$;

-- 11. identity.patients' registration read (0011), sealed: the same two
-- permission checks, and a demo patient's row only at a demo facility (a real
-- patient's only at a real one). Last, so that the ACCESS EXCLUSIVE lock it
-- needs is held for the shortest time; bounded like section 1's.
do $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table identity.patients in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0098: identity.patients stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;
alter policy patients_registration_read on identity.patients
  using ((auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
            platform.current_facility_id(), 'identity.registration.write')
          or auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
            platform.current_facility_id(), 'identity.registration.approve'))
         and ((id = any ((select identity.sealed_demo_ids('patient'))::uuid[]))
              = (select identity.sealed_demo_facility(platform.current_facility_id()))));
do $$
begin
  -- The policy as this section writes it; identity.patients still has six.
  if (select count(*) from pg_policy policy_row where policy_row.polrelid = 'identity.patients'::regclass) <> 6
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'identity.patients'::regclass
                       and policy_row.polname = 'patients_registration_read'
                       and policy_row.polcmd = 'r' and policy_row.polpermissive
                       and policy_row.polroles = '{0}'::oid[] and policy_row.polwithcheck is null
                       and pg_get_expr(policy_row.polqual, policy_row.polrelid) = '((auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(), platform.current_facility_id(), ''identity.registration.write''::text) OR auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(), platform.current_facility_id(), ''identity.registration.approve''::text)) AND ((id = ANY (( SELECT identity.sealed_demo_ids(''patient''::text) AS sealed_demo_ids)::uuid[])) = ( SELECT identity.sealed_demo_facility(platform.current_facility_id()) AS sealed_demo_facility)))') then
    raise exception using errcode = '55000', message = '0098: identity.patients'' registration read is not section 11''s';
  end if;
end
$$;
