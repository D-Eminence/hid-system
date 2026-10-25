-- Facility self sign-up (provider self-service onboarding), switched off.
--
-- Owner decision D14 (2026-10-23): a hospital, laboratory or pharmacy signs
-- itself up through "Setup Your Facility" without a platform administrator
-- approving it first; the administrator finishes by setting a password
-- (second decision: no authenticator). Owner decision of 2026-10-24: every
-- self-signed-up facility appears for support, who review it within a
-- business day ("alert + daily review").
--
-- This ports main's 0061, 0062 (with db49a0d's loop fix and 46a173f's
-- activation wrapper) and 0063 (08c906f) onto this branch, with these
-- changes, recorded in docs/MAIN_TO_NOVU_PORT.md:
--   A1  the platform control provider_self_service_enabled, seeded OFF; the
--       submit command and the activation wrapper require it;
--   A4  prune_verification_quotas keeps the body live at merge (0049) and
--       adds this migration's two counter tables (not main 0085's body);
--   A5  the runtime grants are made here as well as in runtime-grants.sql,
--       since a release applies only migrations;
--   A6  a platform-wide daily QoreID CAC lookup cap, a third argument of the
--       quota command, with its own counter table;
--   A8  an unactivated self-service application lapses 24 hours after it was
--       submitted: the next submit for its CAC and product, on the
--       self-service or the governed path, rejects it (reviewed_at set, an
--       explanatory review_reason, row_version bumped), invalidates its email
--       challenges and sessions, audits identity.organization.self-service.lapse
--       and opens a new application;
--   A10 activation sets the account's email_verified_at and
--       password_changed_at (the email code has just proved the mailbox);
--   A11 the self-service commands take the governed path's advisory-lock
--       keys ('org-application:' and 'org-cac:'), so the two paths serialize;
--   the support review: three nullable review columns on the application
--       and two platform-administration commands that work for a standalone
--       platform administrator (no facility membership), as 0064's commands do.
-- The adversarial review of this port added (each recorded in
-- docs/MAIN_TO_NOVU_PORT.md):
--   R1  an activation pre-check in its own committed transaction, before
--       Identity computes the 64 MiB argon2id hash: it charges a budget of 5
--       attempts per completion session and ends the session on an answer
--       that can never succeed (email already registered, CAC already bound,
--       legal name already used, application not ready);
--   R2  support's release of a fraudulent self sign-up: once the facility is
--       suspended and the administrator disabled, it closes the application,
--       removes the CAC binding, suspends the product, deactivates and renames
--       the organization and revokes the administrator's facility roles, so
--       the real company can sign up;
--   R3  support's list and rejection of open self-service applications, the
--       applicant's own stale application resumed rather than lapsed, the
--       submitting network kept on the application, and a 7-day refusal to
--       reopen a closed self-service application's CAC and product for its
--       email or network (narrowed by R15);
--   R5  at most 10 emailed codes a day to one administrator email across
--       every self-service application;
--   R6  the administrator name and organization type the activated account
--       keeps are those of the request whose emailed code proved the mailbox;
--   R7  (CRITIC C13) no organization CAC lookup for a self-signed-up
--       organization support has not reviewed;
--   R8  the seed keeps platform.control_settings's FORCE row-level security
--       state as it finds it;
--   R12 support's unreviewed list shows the oldest activation first.
-- The website's second contract (each recorded in docs/MAIN_TO_NOVU_PORT.md)
-- added two read-only commands:
--   R13 the confirmation read: before the password, the applicant sees the
--       verified legal name the activation will register, with the CAC
--       number, product, organization type and administrator it will keep,
--       so a mistyped CAC number that names another real company can be
--       caught before any account exists;
--   R14 the emailed code's state: whether start's code went out, the code
--       still in force and the wait before a new one, so start can say that
--       no code was sent (R5's and 0056's limits) instead of answering as if
--       one had been.
-- The second review of this port changed (each recorded in
-- docs/MAIN_TO_NOVU_PORT.md):
--   R15 R3's 7-day refusal locked real applicants out: a lapse the same
--       submit had just made counted against it and was rolled back with
--       it, so a mistyped email kept its network out indefinitely, and
--       support's rejection only started the 7 days. Now a lapse refuses no
--       one; instead an email or network that already had an application for
--       the CAC and product closed in the last 7 days opens a new one without
--       a hold (anyone else's submit lapses it at once), so a squatter
--       renewing from its own network gains nothing; only support's
--       rejection or release sets a 7-day refusal, unless support lets the
--       applicant retry, and support can waive one in force; and the
--       activation pre-check's 'email_registered' closes the application, so
--       the applicant can start again at once with another email;
--   R16 support's open-applications list shows the applications that hold a
--       CAC now first (verified ones first, then the newest), with the total
--       and an exact CAC number search, so stale or made-up ones cannot hide
--       a live squat;
--   R17 0056's governed code command sends codes for governed applications
--       only: its logic is an owner-only helper that the self-service command
--       calls for self-service ones, so the governed route (or a previous
--       Identity) cannot bypass R5's limit per email or R6's stored details.
-- The applicant's withdrawal (recorded in docs/MAIN_TO_NOVU_PORT.md):
--   R18 "This isn't my organization": from the verified completion session,
--       the applicant closes its own open self-service application, so a
--       mistyped CAC number stops being held; no refusal is set (like any
--       closure, a new application of that email or network for the same
--       CAC and product within 7 days is opened without a hold), its codes
--       and sessions end and the withdrawal is audited.
-- Section 5 (P4b, owner decisions of 2026-10-24 and 2026-10-25: full access
-- after support's review, and facility staff invitations; recorded in
-- docs/MAIN_TO_NOVU_PORT.md) adds:
--   * the restricted role org_admin_awaiting_review (six of org_admin's
--     permissions, none reaching patient data), which the activation now
--     grants instead of org_admin, after it records the activation on the
--     application;
--   * the review gate, a trigger on auth.account_roles: at a pending
--     organization only the restricted role may be active, at a released one
--     no facility role, and the restricted role only at a pending one;
--   * support's review, replaced: support confirms the administrator's own
--     access ('none', or the type's clinical role with the licence recorded)
--     and how it checked; the review revokes the restricted role, grants
--     org_admin and that role with support's licence attestation, and signs
--     the administrator out; it needs the new permission
--     platform.facility.unlock (platform_admin, platform_super_admin and
--     facility_review_admin hold it); support can later change the
--     administrator's access and end the first 30 days early;
--   * the first 30 days after review: at most 5 break-glass activations a
--     day per facility (a trigger on identity.consent_grants) and lower
--     invitation limits;
--   * staff invitations: the invitations, their sends, the licence
--     attestations and the attestation texts; the administrator's commands
--     (its own licence before review, list, invite, resend, revoke, remove a
--     member, change a member's role); the invitee's (open, prepare and
--     accept with a password; preview and accept for signed-in staff); and
--     support's (a facility's staff and licences, an invitation by its
--     reference);
--   * the release (R2) also revokes the pending invitations, ends the
--     memberships before it revokes their roles, revokes their consent
--     grants, expires their access requests and revokes the staff sessions
--     of accounts left with no active membership;
--   * the second control, staff_invitations_enabled, seeded OFF.
-- Governed and legacy organizations are unchanged: no self-service
-- application, so the gate allows their role rows, the staff context adds
-- nothing and no staff command serves them.
-- Section 6 (P4c, owner decisions of 2026-10-25, fifth and sixth sets:
-- cross-facility lab requests and prescriptions in this release, the doctor
-- sends, the doctor's word only; recorded in docs/MAIN_TO_NOVU_PORT.md) adds:
--   * the permissions ehr.order-route.send (doctor, clinician),
--     lab.order-route.receive (lab) and pharmacy.order-route.receive
--     (pharmacist), and the clinician's attestation texts (one per kind);
--   * the order route (ehr.order_routes) with its append-only events,
--     identification attempts, result and dispensing reports and support's
--     listing settings; a clinician at the ordering facility sends a lab
--     request or prescription to a reviewed or governed laboratory or
--     pharmacy, attesting that the patient agreed and naming it (no in-app
--     approval); the patient is told in the inbox at once and can stop it
--     until the receiving facility accepts; the receiving facility confirms
--     the patient's Health ID or date of birth to accept (5 wrong tries that
--     name the order, a Health ID or a date of birth with the order's
--     reference, or 20 in all, lock that order there), which creates the Lab
--     or Pharmacy work item there,
--     bound to the route; its members holding the receive permission then
--     work it for a limited time (30 days; 14 after the first result or
--     dispensing, at most 45) without a consent grant; results and dispensing
--     come back to the ordering facility as append-only reports;
--   * route-backed Lab and Pharmacy work items (a column, a facility rule,
--     keys by the ordering facility and strict policies), a route branch in
--     lab.context_allows and pharmacy.context_allows, the work-item and
--     dispensing validators, a mirror of order changes, the release of a
--     self-signed-up organization closing its routes both ways, and support's
--     find, close and listing commands;
--   * the controls cross_facility_orders_enabled (seeded OFF) and
--     cross_facility_route_access_enabled (seeded ON);
--   * the patient inbox's two functions granted to the Identity runtime
--     (main's grant; never made on this branch).
-- Same-facility hand-offs are unchanged except that they are refused while
-- the order has a live route.
-- The review of P4c changed (each recorded in docs/MAIN_TO_NOVU_PORT.md):
--   * the lock layout: platform.control_settings and identity.consent_grants
--     are taken in 6.7's one NOWAIT attempt with the nine clinical tables,
--     and P4b's probation trigger is created there, so the previous
--     Identity's emergency activation (a control read, then a consent-grant
--     insert) can no longer deadlock with this migration;
--   * the patient's list (C5): an order marked entered in error is listed
--     without its content, attestation text or attesting clinician; a
--     completed route closed so tells the patient;
--   * acceptance: an optional reference names the order with a date of
--     birth; a date of birth alone counts only towards the member's day and
--     the order's 20 in all, so honest wrong picks never lock another
--     patient's order at once nor tell that patient;
--   * section 5's administrator-role change no longer overwrites the
--     review's verification method, which the default listing reads.
-- main's 0061 interim review check and its re-add of the status check (same
-- values as 0046) are not ported, nor main's later migrations or staff MFA.
--
-- Locks, all taken inside the release's one transaction (and again in its
-- dry run of every pending migration): ACCESS EXCLUSIVE on
-- identity.organization_applications (new columns, the review check swap,
-- partial indexes) and on identity.organization_profile_completion_challenges
-- (three new columns), and SHARE ROW EXCLUSIVE on auth.accounts (the reviewer
-- and release foreign keys), all from the first statements. Replacing
-- platform.consume_qoreid_quota and
-- identity.begin_organization_profile_completion takes no table lock.
-- Section 5 takes, until commit, SHARE ROW EXCLUSIVE (blocks writes, not
-- reads) on auth.account_roles (its trigger, and the attestations' foreign
-- key), and auth.roles, identity.facilities, identity.staff and
-- identity.staff_facility_memberships (the new tables' foreign keys), and ROW
-- EXCLUSIVE on auth.roles, auth.permissions and auth.role_permissions (its
-- inserts). The request paths that write one of these (sign-in's legacy
-- password upgrade, recovery and patient enrollment write auth.accounts;
-- support's role and account commands write auth.account_roles) wait for the
-- rest of the file; none of them reads platform.control_settings first. The
-- new tables and functions lock nothing else that already exists.
-- Section 6 adds, until commit, only SHARE ROW EXCLUSIVE locks already held
-- (identity.facilities, auth.accounts, identity.staff_facility_memberships,
-- for the new tables' foreign keys), a trigger on
-- identity.organization_applications (already ACCESS EXCLUSIVE) and ROW
-- EXCLUSIVE on auth.permissions and auth.role_permissions, until its last
-- part (6.7), which takes ACCESS EXCLUSIVE on lab.work_items,
-- pharmacy.work_items, ehr.lab_requests, ehr.encounters, ehr.prescriptions,
-- lab.result_releases, lab.result_invalidations, pharmacy.dispensings,
-- pharmacy.dispensing_reversals and platform.control_settings (the hot-path
-- table every authenticated request reads), and SHARE ROW EXCLUSIVE on
-- identity.consent_grants (P4b's probation trigger, created right after),
-- all at once with a NOWAIT retry (it never waits while holding one of them;
-- 5 seconds of busy tables stop the release with nothing applied), and holds
-- them to commit. Nothing before 6.7 locks any of these eleven, and nothing
-- after it waits for a lock: the control section, still the last statements
-- of the file, works under 6.7's lock. The previous Identity's emergency
-- activation reads platform.control_settings and then inserts into
-- identity.consent_grants in one transaction; taking both tables in 6.7's one
-- NOWAIT attempt is what keeps it from deadlocking with this migration (it
-- only makes an attempt retry).
--
-- Applied migrations 0001 through 0085 are immutable.

-- 0. Preconditions. The release dry-runs every pending migration in one
-- transaction before applying any, so a refusal here stops the release with
-- nothing changed.
--
-- The 0046 review check passes a closed (approved or rejected) application
-- whose review_reason is NULL, because a NULL check result counts as a pass;
-- the replacement check below (main 0062) wraps review_reason in coalesce and
-- refuses it. Every other closed row the 0046 check admits (reviewer and
-- reviewed_at set, reason of 8 or more characters) also passes the new check.
-- Every command that closes an application writes a reason of 8 or more
-- characters, so such a row can only come from a direct write; refuse to run
-- rather than fail later inside ADD CONSTRAINT.
do $$
declare
  unreviewable bigint;
begin
  select count(*) into unreviewable
    from identity.organization_applications application
   where application.status in ('approved', 'rejected')
     and (application.review_reason is null
       or length(btrim(application.review_reason)) < 8
       or application.reviewed_at is null
       or application.reviewed_by_account_id is null);
  if unreviewable <> 0 then
    raise exception '0086: % closed organization application(s) have no review reason of 8 or more characters, reviewer or review time; the self-service review check would refuse them. Resolve them before this release',
      unreviewable;
  end if;
end
$$;

-- P4c (section 6): refuse rather than overwrite. The vocabulary and the route
-- tables must not exist yet; no trigger may already carry one of section 6's
-- names; the five functions section 6 replaces must still have the bodies it
-- was written against (md5 of pg_proc.prosrc, measured on 0001-0085 in both
-- build orders); and the constraints and policies it drops must be exactly
-- the ones it expects, by name and by definition. Reading the catalog takes
-- no lock on the clinical tables.
do $$
declare
  mismatch text;
begin
  if exists (select 1 from auth.permissions permission
              where permission.code in ('ehr.order-route.send', 'lab.order-route.receive', 'pharmacy.order-route.receive'))
     or to_regclass('ehr.order_routes') is not null
     or to_regclass('ehr.order_route_events') is not null then
    raise exception '0086: the cross-facility order vocabulary or route tables already exist; this release would overwrite them';
  end if;
  if exists (select 1 from pg_trigger trigger_row
              where not trigger_row.tgisinternal
                and trigger_row.tgname in ('order_routes_guard', 'order_routes_first_event',
                  'lab_requests_order_routes_sync', 'prescriptions_order_routes_sync',
                  'organization_applications_order_routes_release', 'result_releases_order_route_return',
                  'result_invalidations_order_route_return', 'dispensings_order_route_return',
                  'dispensing_reversals_order_route_return')) then
    raise exception '0086: a trigger with a cross-facility order name already exists';
  end if;
  select string_agg(format('%s md5 %s', expected.proc, md5(proc.prosrc)), '; ') into mismatch
    from (values ('lab.context_allows(uuid,uuid,text)'::regprocedure, 'ccf4522a10bad47d698161bfc41e841b'),
                 ('pharmacy.context_allows(uuid,uuid,text)'::regprocedure, '001c21c70dab5dc0538a6cec4e94f8e8'),
                 ('lab.validate_work_item()'::regprocedure, '8d3d104c486ff968ab1160ee1493e375'),
                 ('pharmacy.validate_work_item()'::regprocedure, '5240c48243ff831fb30a470b80cd6a57'),
                 ('pharmacy.validate_dispensing()'::regprocedure, '1a30589c96b4aa8176a5b5a77bc0629d'))
         expected(proc, digest)
    join pg_proc proc on proc.oid = expected.proc
   where md5(proc.prosrc) <> expected.digest;
  if mismatch is not null then
    raise exception '0086: a function section 6 replaces has another body than 0017, 0023 or 0077 gave it: %', mismatch;
  end if;
  select string_agg(format('%s.%s', expected.relation, expected.name), ', ') into mismatch
    from (values ('lab.work_items'::regclass, 'work_items_check', 'CHECK ((facility_id = ordering_facility_id))'),
                 ('lab.work_items'::regclass, 'work_items_source_ehr_order_id_patient_id_facility_id_fkey',
                  'FOREIGN KEY (source_ehr_order_id, patient_id, facility_id) REFERENCES ehr.lab_requests(id, patient_id, facility_id) ON DELETE RESTRICT'),
                 ('lab.work_items'::regclass, 'work_items_source_encounter_id_patient_id_facility_id_fkey',
                  'FOREIGN KEY (source_encounter_id, patient_id, facility_id) REFERENCES ehr.encounters(id, patient_id, facility_id) ON DELETE RESTRICT'))
         expected(relation, name, definition)
   where not exists (select 1 from pg_constraint constraint_row
                      where constraint_row.conrelid = expected.relation
                        and constraint_row.conname = expected.name
                        and pg_get_constraintdef(constraint_row.oid) = expected.definition);
  if mismatch is not null then
    raise exception '0086: lab.work_items does not have the constraints section 6 replaces, by name and definition: %', mismatch;
  end if;
  if (select count(*) from pg_constraint constraint_row
       where constraint_row.conrelid = 'pharmacy.work_items'::regclass and constraint_row.contype = 'c'
         and pg_get_constraintdef(constraint_row.oid) = 'CHECK ((facility_id = ordering_facility_id))') <> 1
     or exists (select 1 from pg_constraint constraint_row
                 where constraint_row.conrelid = 'pharmacy.work_items'::regclass and constraint_row.contype = 'f'
                   and constraint_row.confrelid in ('ehr.prescriptions'::regclass, 'ehr.encounters'::regclass)) then
    raise exception '0086: pharmacy.work_items must have exactly one CHECK ((facility_id = ordering_facility_id)) and no foreign key to an EHR table';
  end if;
  select string_agg(format('%s.%s', expected.relation, expected.name), ', ') into mismatch
    from (values ('lab.work_items'::regclass, 'lab_work_items_read', 'r',
                  'lab.context_allows(patient_id, facility_id, ''read_records''::text)', null::text),
                 ('lab.work_items'::regclass, 'lab_work_items_insert', 'a',
                  null, 'lab.context_allows(patient_id, facility_id, ''write_records''::text)'),
                 ('pharmacy.work_items'::regclass, 'pharmacy_work_items_read', 'r',
                  'pharmacy.context_allows(patient_id, facility_id, ''read_records''::text)', null),
                 ('pharmacy.work_items'::regclass, 'pharmacy_work_items_insert', 'a',
                  null, 'pharmacy.context_allows(patient_id, facility_id, ''write_records''::text)'))
         expected(relation, name, command, qual, with_check)
   where not exists (select 1 from pg_policy policy
                      where policy.polrelid = expected.relation and policy.polname = expected.name
                        and policy.polcmd = expected.command::"char" and policy.polpermissive
                        and policy.polroles = array[0::oid]
                        and pg_get_expr(policy.polqual, policy.polrelid) is not distinct from expected.qual
                        and pg_get_expr(policy.polwithcheck, policy.polrelid) is not distinct from expected.with_check);
  if mismatch is not null
     or (select count(*) from pg_policy policy
          where policy.polrelid in ('lab.work_items'::regclass, 'pharmacy.work_items'::regclass)) <> 4 then
    raise exception '0086: the work-item policies are not exactly the four of 0018 and 0023: %', coalesce(mismatch, 'another policy exists');
  end if;
end
$$;

-- 1. The application table. Every new column is nullable or has a constant
-- default, so adding it rewrites no row.
alter table identity.organization_applications
  add column approval_mode text not null default 'admin_review'
    constraint organization_applications_approval_mode_check
    check (approval_mode in ('admin_review', 'self_service')),
  add column self_service_reviewed_at timestamptz,
  add column self_service_reviewed_by_account_id uuid references auth.accounts(id) on delete restrict,
  add column self_service_review_note text,
  -- R2: support's release of a fraudulent self sign-up.
  add column self_service_released_at timestamptz,
  add column self_service_released_by_account_id uuid references auth.accounts(id) on delete restrict,
  add column self_service_release_reason text,
  -- R3: the keyed digest of the client network (IPv4 address or IPv6 /64)
  -- that opened a self-service application; never the address itself.
  add column submitter_network_digest char(64)
    constraint organization_applications_submitter_network_digest_check
    check (submitter_network_digest is null or submitter_network_digest ~ '^[a-f0-9]{64}$'),
  -- R3: opened by an email or network that already had a self-service
  -- application for this CAC and product closed in the last 7 days, so it
  -- holds nothing: anyone else's submit lapses it at once.
  add column self_service_without_hold boolean not null default false,
  -- R3: until then, the email and network of this application, which support
  -- closed, may not open a new self-service application for its CAC and
  -- product; NULL when nothing is refused (a lapse, a system closure, a
  -- closure that lets the applicant retry, or a refusal support waived).
  add column self_service_refusal_ends_at timestamptz,
  -- P4b: support's confirmation of the administrator's own access at its
  -- review, and how support checked (set with the review).
  add column self_service_granted_role text
    constraint organization_applications_self_service_granted_role_check
    check (self_service_granted_role is null
      or self_service_granted_role in ('none', 'doctor', 'nurse', 'lab', 'pharmacist')),
  add column self_service_verification_method text
    constraint organization_applications_self_service_verification_method_check
    check (self_service_verification_method is null or self_service_verification_method in
      ('cac_registered_contact', 'officer_match', 'regulator_register', 'in_person', 'other')),
  -- P4b: the administrator's own licence, entered in the portal before the
  -- review (support grants the clinical role with it).
  add column self_service_admin_licence_body text,
  add column self_service_admin_licence_number text,
  add column self_service_admin_licence_recorded_at timestamptz,
  -- P4b: support ended the first 30 days after the review early.
  add column self_service_probation_ended_at timestamptz,
  add column self_service_probation_ended_by_account_id uuid references auth.accounts(id) on delete restrict,
  add column self_service_probation_end_reason text;

-- R1 and R6: the completion challenge carries the activation attempts made
-- with its session and the administrator name and organization type sent
-- with the request that asked for its code.
alter table identity.organization_profile_completion_challenges
  add column activation_attempts integer not null default 0
    constraint organization_profile_completion_activation_attempts_check
    check (activation_attempts between 0 and 5),
  add column requested_administrator_name text
    constraint organization_profile_completion_requested_name_check
    check (requested_administrator_name is null or (
      requested_administrator_name = btrim(requested_administrator_name)
      and length(requested_administrator_name) between 2 and 200)),
  add column requested_organization_type text
    constraint organization_profile_completion_requested_type_check
    check (requested_organization_type is null
      or requested_organization_type in ('clinic', 'hospital', 'laboratory', 'pharmacy', 'other'));

-- main 0062 with db49a0d's loop variable, asserting the single 0046 check.
do $$
declare
  matching_constraint record;
  matched integer := 0;
begin
  for matching_constraint in
    select constraint_row.conname
      from pg_constraint constraint_row
     where constraint_row.conrelid = 'identity.organization_applications'::regclass
       and constraint_row.contype = 'c'
       and pg_get_constraintdef(constraint_row.oid) like '%reviewed_by_account_id%'
       and pg_get_constraintdef(constraint_row.oid) like '%reviewed_at%'
       and pg_get_constraintdef(constraint_row.oid) like '%review_reason%'
  loop
    matched := matched + 1;
    execute format('alter table identity.organization_applications drop constraint %I',
      matching_constraint.conname);
  end loop;
  if matched <> 1 then
    raise exception '0086 expected exactly one reviewer check on identity.organization_applications, found %', matched;
  end if;
end
$$;

alter table identity.organization_applications
  add constraint organization_applications_review_check_self_service check (
    status not in ('approved', 'rejected')
    or (
      reviewed_at is not null
      and length(btrim(coalesce(review_reason, ''))) >= 8
      and (
        approval_mode = 'self_service'
        or reviewed_by_account_id is not null
      )
    )
  ),
  -- Support's review of an activated self-service facility: all five set
  -- together (the time, the reviewer, the note, the administrator's access
  -- support confirmed and how it checked), only on an activated self-service
  -- application (approved, or approved and later released by support).
  add constraint organization_applications_self_service_review_ck check (
    (self_service_reviewed_at is null
      and self_service_reviewed_by_account_id is null
      and self_service_review_note is null
      and self_service_granted_role is null
      and self_service_verification_method is null)
    or (self_service_reviewed_at is not null
      and self_service_reviewed_by_account_id is not null
      and self_service_review_note is not null
      and self_service_granted_role is not null
      and self_service_verification_method is not null
      and length(btrim(self_service_review_note)) between 8 and 500
      and approval_mode = 'self_service'
      and organization_id is not null
      and (status = 'approved' or self_service_released_at is not null))
  ),
  -- R2: support's release, all three set together, only on an activated
  -- self-service application that the release closed.
  add constraint organization_applications_self_service_release_ck check (
    (self_service_released_at is null
      and self_service_released_by_account_id is null
      and self_service_release_reason is null)
    or (self_service_released_at is not null
      and self_service_released_by_account_id is not null
      and self_service_release_reason is not null
      and length(btrim(self_service_release_reason)) between 8 and 500
      and approval_mode = 'self_service'
      and status = 'rejected'
      and organization_id is not null)
  ),
  -- R3: a hold and a refusal concern self-service applications only, and a
  -- refusal only a closed one.
  add constraint organization_applications_self_service_hold_ck check (
    approval_mode = 'self_service'
    or (not self_service_without_hold and self_service_refusal_ends_at is null)
  ),
  add constraint organization_applications_self_service_refusal_ck check (
    self_service_refusal_ends_at is null or status = 'rejected'
  ),
  -- P4b: the administrator's own licence, all three set together, a known
  -- body and main 0098's number pattern, only on an activated self-service
  -- application.
  add constraint organization_applications_self_service_admin_licence_ck check (
    (self_service_admin_licence_body is null
      and self_service_admin_licence_number is null
      and self_service_admin_licence_recorded_at is null)
    or (self_service_admin_licence_body in ('MDCN', 'NMCN', 'MLSCN', 'PCN')
      and self_service_admin_licence_number ~ '^[A-Z0-9][A-Z0-9/. -]{1,98}[A-Z0-9]$'
      and self_service_admin_licence_number !~ '  '
      and self_service_admin_licence_recorded_at is not null
      and approval_mode = 'self_service'
      and organization_id is not null)
  ),
  -- P4b: the first 30 days ended early, all three set together, a reason of
  -- 8-500 characters, only on a reviewed application.
  add constraint organization_applications_self_service_probation_ck check (
    (self_service_probation_ended_at is null
      and self_service_probation_ended_by_account_id is null
      and self_service_probation_end_reason is null)
    or (self_service_probation_ended_at is not null
      and self_service_probation_ended_by_account_id is not null
      and self_service_probation_end_reason is not null
      and length(btrim(self_service_probation_end_reason)) between 8 and 500
      and self_service_reviewed_at is not null)
  );

create index organization_applications_self_service_idx
  on identity.organization_applications (cac_registration_number, product_code, administrator_email)
  where approval_mode = 'self_service' and status in ('pending_verification', 'ready_for_review');

-- The support list reads activated self-service applications (approved, or
-- released) by activation time: oldest first while unreviewed, else newest.
-- Only an activation sets organization_id on a self-service application.
create index organization_applications_self_service_activation_idx
  on identity.organization_applications (reviewed_at, id)
  where approval_mode = 'self_service' and organization_id is not null;

-- R3: support's list of open self-service applications (R16 ranks it); and
-- the closed ones a submit checks before it reopens their CAC and product
-- (R15: a refusal support set, and whether a new application gets a hold).
create index organization_applications_self_service_open_idx
  on identity.organization_applications (created_at, id)
  where approval_mode = 'self_service' and status in ('pending_verification', 'ready_for_review');
create index organization_applications_self_service_closed_idx
  on identity.organization_applications (cac_registration_number, product_code)
  where approval_mode = 'self_service' and status = 'rejected';

-- R5: the emailed codes sent to one administrator email.
create index organization_applications_self_service_email_idx
  on identity.organization_applications (administrator_email)
  where approval_mode = 'self_service';

-- R7: an organization that signed itself up and that support has not reviewed.
create index organization_applications_self_service_unreviewed_org_idx
  on identity.organization_applications (organization_id)
  where approval_mode = 'self_service' and status = 'approved' and self_service_reviewed_at is null;

-- P4b: an organization's self-service application in any state (pending,
-- reviewed or released), which the staff context, the review gate and every
-- staff command read per organization.
create index organization_applications_self_service_org_idx
  on identity.organization_applications (organization_id)
  where approval_mode = 'self_service' and organization_id is not null and reviewed_by_account_id is null;

-- 2. Self-service commands (main 0061 and 0062).
create function identity.public_get_organization_application(
  requested_cac_number text,
  requested_email text,
  requested_product text
) returns table (
  application_id uuid,
  application_status text,
  verification_result text,
  provider_verified_registration_number text,
  row_version bigint
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_cac_number !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or requested_email is null
     or requested_product not in ('ehr', 'migrate', 'laboratory', 'pharmacy') then
    raise exception using errcode = '42501', message = 'Public organization enrollment context is required';
  end if;

  return query
    select application.id, application.status, application.verification_result,
      application.provider_verified_registration_number, application.row_version
    from identity.organization_applications application
    where application.cac_registration_number = upper(btrim(requested_cac_number))
      and application.administrator_email = lower(btrim(requested_email))
      and application.product_code = requested_product
      and application.status <> 'rejected'
    order by application.created_at desc
    limit 1;
end;
$$;

create function identity.public_record_organization_cac_result(
  requested_application_id uuid,
  expected_version bigint,
  requested_result text,
  requested_provider_reference text,
  requested_registration_number text,
  requested_organization_name text,
  requested_entity_type text,
  requested_registration_date text,
  requested_address text,
  requested_registry_status text
) returns table (
  application_status text,
  row_version bigint
)
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  application identity.organization_applications%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_result not in ('verified', 'not_verified', 'incomplete', 'provider_error', 'disabled')
     or requested_application_id is null then
    raise exception using errcode = '42501', message = 'Public organization verification context is required';
  end if;

  select * into application
    from identity.organization_applications row
   where row.id = requested_application_id
     and row.approval_mode = 'self_service'
     and row.status in ('pending_verification', 'ready_for_review')
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Organization application not found';
  end if;

  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;

  if requested_result = 'verified' then
    if requested_registration_number is null
       or requested_registration_number <> application.cac_registration_number
       or length(btrim(coalesce(requested_organization_name, ''))) not between 2 and 200
       or length(btrim(coalesce(requested_entity_type, ''))) not between 2 and 120
       or requested_registration_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or length(btrim(coalesce(requested_address, ''))) not between 5 and 1000
       or lower(btrim(coalesce(requested_registry_status, ''))) <> 'active'
       or requested_provider_reference is null
       or requested_provider_reference !~ '^[0-9]+$' then
      raise exception using errcode = '22023', message = 'Invalid CAC verification evidence';
    end if;
  end if;

  update identity.organization_applications row
     set approval_mode = 'self_service',
         verification_result = requested_result,
         verification_failure_category = case
           when requested_result = 'verified' then null
           when requested_result = 'not_verified' then 'not_verified'
           when requested_result = 'incomplete' then 'incomplete'
           when requested_result = 'disabled' then 'disabled'
           else 'unexpected_response'
         end,
         provider_reference = requested_provider_reference,
         provider_verified_registration_number = requested_registration_number,
         qoreid_organization_name = case when requested_result = 'verified'
           then btrim(requested_organization_name) else null end,
         qoreid_entity_type = case when requested_result = 'verified'
           then btrim(requested_entity_type) else null end,
         qoreid_registration_date = case when requested_result = 'verified'
           then requested_registration_date::date else null end,
         qoreid_address = case when requested_result = 'verified'
           then btrim(requested_address) else null end,
         qoreid_registry_status = case when requested_result = 'verified'
           then lower(btrim(requested_registry_status)) else null end,
         verified_organization_name = case when requested_result = 'verified'
           then btrim(requested_organization_name) else row.verified_organization_name end,
         verified_entity_type = case when requested_result = 'verified'
           then btrim(requested_entity_type) else row.verified_entity_type end,
         verified_registration_date = case when requested_result = 'verified'
           then requested_registration_date::date else row.verified_registration_date end,
         verified_address = case when requested_result = 'verified'
           then btrim(requested_address) else row.verified_address end,
         verified_registry_status = case when requested_result = 'verified'
           then lower(btrim(requested_registry_status)) else row.verified_registry_status end,
         organization_name = case when requested_result = 'verified'
           then btrim(requested_organization_name) else row.organization_name end,
         organization_name_source = case when requested_result = 'verified'
           then 'qoreid' else row.organization_name_source end,
         entity_type_source = case when requested_result = 'verified'
           then 'qoreid' else row.entity_type_source end,
         registration_date_source = case when requested_result = 'verified'
           then 'qoreid' else row.registration_date_source end,
         address_source = case when requested_result = 'verified'
           then 'qoreid' else row.address_source end,
         registry_status_source = case when requested_result = 'verified'
           then 'qoreid' else row.registry_status_source end,
         profile_state = case when requested_result = 'verified' then 'complete' else row.profile_state end,
         status = case when requested_result = 'verified' then 'ready_for_review'
           else 'pending_verification' end,
         verified_at = case when requested_result = 'verified' then clock_timestamp() else null end,
         updated_at = clock_timestamp(),
         row_version = row.row_version + 1
   where row.id = application.id
   returning row.* into application;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.cac-verify',
    case when requested_result = 'verified' then 'success' else 'denied' end,
    'organization-application', application.id::text,
    'application', 'identity-api',
    jsonb_build_object('productCode', application.product_code, 'result', requested_result)
  );

  return query select application.status, application.row_version;
end;
$$;

-- main 0061's activation (owner-only), with A10 (email_verified_at and
-- password_changed_at), A11 (the governed approval's 'org-cac:' lock key) and
-- the administrator email check written against accounts_email_ci_uq and
-- staff_email_ci_uq. The exact message "Administrator email already belongs
-- to an account" is what Identity answers as 409
-- PROVIDER_EMAIL_ALREADY_REGISTERED (#81). R6: the account's display name,
-- the staff record's name and the application's administrator name and
-- organization type are the ones sent with the request whose emailed code
-- opened this session (stored on its challenge), not necessarily those of
-- whichever request opened the application.
create function identity.activate_self_service_organization_application(
  requested_session_hmac char(64),
  requested_password_hash text
) returns table (
  organization_id uuid,
  facility_id uuid,
  account_id uuid,
  row_version bigint,
  hid_subject text
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  challenge identity.organization_profile_completion_challenges%rowtype;
  application identity.organization_applications%rowtype;
  existing_registration identity.organization_cac_registrations%rowtype;
  new_organization_id uuid;
  new_facility_id uuid;
  new_account_id uuid;
  new_staff_id uuid;
  new_membership_id uuid;
  new_application identity.organization_applications%rowtype;
  administrator_name_value text;
  organization_type_value text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_session_hmac is null
     or requested_session_hmac !~ '^[a-f0-9]{64}$'
     or requested_password_hash is null
     or length(requested_password_hash) < 20 then
    raise exception using errcode = '42501', message = 'Self-service activation context is required';
  end if;

  select * into challenge
    from identity.organization_profile_completion_challenges row
   where row.session_hmac = requested_session_hmac
     and row.consumed_at is not null
     and row.invalidated_at is null
     and row.session_expires_at > clock_timestamp()
   for update;

  if not found then
    raise exception using errcode = '42501', message = 'Organization enrollment session is invalid';
  end if;

  select * into application
    from identity.organization_applications row
   where row.id = challenge.application_id
   for update;

  if not found
     or application.approval_mode <> 'self_service'
     or application.status <> 'ready_for_review'
     or application.verification_result <> 'verified'
     or application.verified_at is null
     or application.provider_verified_registration_number <> application.cac_registration_number
     or application.qoreid_registry_status <> 'active'
     or application.qoreid_organization_name is null
     or application.qoreid_entity_type is null
     or application.qoreid_registration_date is null
     or application.qoreid_address is null then
    raise exception using errcode = '23514', message = 'Verified CAC enrollment is not ready for activation';
  end if;

  administrator_name_value := coalesce(challenge.requested_administrator_name, application.administrator_name);
  organization_type_value := coalesce(challenge.requested_organization_type, application.organization_type);

  if exists (
    select 1 from auth.accounts account
    where lower(account.email) = lower(application.administrator_email)
      and account.email is not null and account.status <> 'deleted'
  ) or exists (
    select 1 from identity.staff staff
    where lower(staff.email) = lower(application.administrator_email)
  ) then
    raise exception using errcode = '23505', message = 'Administrator email already belongs to an account';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('org-cac:' || application.cac_registration_number, 0));

  select * into existing_registration
    from identity.organization_cac_registrations row
   where row.cac_registration_number = application.cac_registration_number
   for update;

  if found then
    raise exception using errcode = '23514', message = 'This CAC is already bound to an HID organization and requires manual resolution';
  end if;

  if exists (
    select 1 from identity.organizations row
    where lower(row.name) = lower(application.qoreid_organization_name)
  ) then
    raise exception using errcode = '23514', message = 'An organization with this verified name already exists and requires manual resolution';
  end if;

  new_organization_id := gen_random_uuid();
  new_facility_id := gen_random_uuid();
  new_account_id := gen_random_uuid();
  new_staff_id := gen_random_uuid();
  new_membership_id := gen_random_uuid();

  insert into identity.organizations (id, name, slug, active, source_system)
  values (
    new_organization_id, application.qoreid_organization_name,
    'org-' || replace(new_organization_id::text, '-', ''), true, 'hid'
  );

  insert into identity.facilities (
    id, organization_id, name, code, active, lifecycle_status, timezone, source_system
  ) values (
    new_facility_id, new_organization_id, application.qoreid_organization_name,
    'ORG-' || replace(new_facility_id::text, '-', ''), true, 'verified', 'Africa/Lagos', 'hid'
  );

  insert into identity.organization_cac_registrations (
    cac_registration_number, organization_id, primary_facility_id, source_application_id
  ) values (
    application.cac_registration_number, new_organization_id, new_facility_id, application.id
  );

  insert into identity.organization_products (
    organization_id, product_code, facility_id, source_application_id
  ) values (
    new_organization_id, application.product_code, new_facility_id, application.id
  );

  insert into auth.accounts (
    id, subject, email, display_name, password_hash, password_algorithm, password_changed_at,
    email_verified_at, status, source_system
  ) values (
    new_account_id, 'org-onboarding:' || new_account_id::text,
    lower(application.administrator_email), administrator_name_value,
    requested_password_hash, 'argon2id', clock_timestamp(), clock_timestamp(), 'active', 'hid'
  );

  insert into identity.staff (
    id, account_id, full_name, email, verification_status, default_role, active, source_system
  ) values (
    new_staff_id, new_account_id, administrator_name_value,
    lower(application.administrator_email), 'verified', 'org_admin', true, 'hid'
  );

  insert into identity.staff_facility_memberships (
    id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, source_system
  ) values (
    new_membership_id, new_staff_id, new_account_id, new_organization_id, new_facility_id,
    'org_admin', 'org_admin', true, true, 'hid'
  );

  -- P4b: the application is approved (the organization is then pending
  -- support's review) before the administrator's role row, which the review
  -- gate checks: the restricted org_admin_awaiting_review until support has
  -- reviewed the facility. The membership keeps org_admin as its role name.
  update identity.organization_applications row
     set status = 'approved',
         organization_id = new_organization_id,
         facility_id = new_facility_id,
         first_admin_account_id = new_account_id,
         administrator_name = administrator_name_value,
         organization_type = organization_type_value,
         reviewed_by_account_id = null,
         review_reason = 'Automated CAC and administrator-email verification',
         reviewed_at = clock_timestamp(),
         updated_at = clock_timestamp(),
         row_version = row.row_version + 1
   where row.id = application.id
   returning row.* into new_application;

  insert into auth.account_roles (
    id, account_id, role_code, scope_type, membership_id, facility_id,
    granted_by, grant_reason
  ) values (
    gen_random_uuid(), new_account_id, 'org_admin_awaiting_review', 'facility', new_membership_id,
    new_facility_id, null, 'Automated CAC and administrator-email self-service onboarding'
  );

  update identity.organization_profile_completion_challenges
     set invalidated_at = clock_timestamp()
   where id = challenge.id;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    organization_id, facility_id, purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.activate', 'success',
    'organization-application', application.id::text,
    new_organization_id, new_facility_id, 'healthcare-operations',
    'application', 'identity-api',
    jsonb_build_object(
      'productCode', application.product_code,
      'cacVerified', true,
      'emailVerified', true,
      'approvalMode', 'self_service'
    )
  );

  return query select new_organization_id, new_facility_id, new_account_id,
    new_application.row_version, 'org-onboarding:' || new_account_id::text;
end;
$$;

-- A8. Called by both submit commands while they hold the CAC and product's
-- 'org-application:' lock. An application lapses when it is self-service,
-- still open (pending_verification or ready_for_review) and was submitted more
-- than 24 hours ago: it becomes rejected with an explanatory reason and no
-- reviewer (the self-service review check admits that), its email challenges
-- and completion sessions are invalidated, and the lapse is audited. Returns
-- the lapsed application's id, or null. Owner-only: it runs inside the
-- definer submit commands and is granted to no role.
--
-- R3: a self-service submit by the stale application's own administrator
-- email (requested_email) resumes it instead: its created_at is not renewed,
-- so its holder cannot extend its hold by submitting again, and anyone
-- else's submit still lapses it. The governed submit passes no email and
-- always lapses it. An application opened without a hold
-- (self_service_without_hold) is stale from the start: anyone else's submit
-- lapses it at once, with its own reason.
--
-- Lock order: the completion sessions first, then the application row, then
-- the challenges without a session. Activation locks its session and then the
-- application; starting an email challenge locks the application and then the
-- challenges without a session; so neither can deadlock with a lapse.
create function identity.lapse_stale_self_service_organization_application(
  requested_cac_number text,
  requested_product text,
  requested_email text
) returns uuid
language plpgsql
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  candidate uuid;
  candidate_email text;
  stale identity.organization_applications%rowtype;
begin
  select application.id, application.administrator_email into candidate, candidate_email
    from identity.organization_applications application
   where application.cac_registration_number = requested_cac_number
     and application.product_code = requested_product
     and application.approval_mode = 'self_service'
     and application.status in ('pending_verification', 'ready_for_review')
     and (application.created_at < clock_timestamp() - interval '24 hours'
       or application.self_service_without_hold);
  if candidate is null or candidate_email = requested_email then return null; end if;

  perform 1 from identity.organization_profile_completion_challenges challenge
   where challenge.application_id = candidate
     and challenge.session_hmac is not null
     and challenge.invalidated_at is null
   order by challenge.id
   for update;

  select * into stale
    from identity.organization_applications application
   where application.id = candidate
     and application.approval_mode = 'self_service'
     and application.status in ('pending_verification', 'ready_for_review')
     and (application.created_at < clock_timestamp() - interval '24 hours'
       or application.self_service_without_hold)
   for update;
  if not found then return null; end if;

  update identity.organization_applications application
     set status = 'rejected',
         reviewed_at = clock_timestamp(),
         review_reason = case
           when stale.created_at < clock_timestamp() - interval '24 hours'
             then 'Self-service application lapsed: not activated within 24 hours of submission'
           else 'Self-service application lapsed: opened without a hold and replaced by another sign-up'
         end,
         updated_at = clock_timestamp(),
         row_version = application.row_version + 1
   where application.id = stale.id;

  update identity.organization_profile_completion_challenges challenge
     set invalidated_at = clock_timestamp()
   where challenge.application_id = stale.id
     and challenge.invalidated_at is null;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.lapse', 'success',
    'organization-application', stale.id::text,
    'application', 'identity-api',
    jsonb_build_object('productCode', stale.product_code, 'previousStatus', stale.status,
      'lapseAfterHours', 24, 'withoutHold', stale.self_service_without_hold)
  );

  return stale.id;
end;
$$;

-- main 0062's submit with A1 (the control, after the context check), A8 (the
-- lapse, under the lock), A11 (the governed submit's lock key) and explicit
-- NULL product and organization type refusals (22023, as 0052's governed
-- submit). Both 23514 messages are main's. R3: Identity passes the keyed
-- digest of the client network (stored on a new application), and the stale
-- application's own email resumes it rather than lapsing it. Then:
--   * a hold is not renewed: a new application whose administrator email or
--     network already had a self-service application for this CAC and
--     product closed in the last 7 days (lapsed, including the one this
--     submit has just lapsed, closed by the system, or closed by support) is
--     opened without a hold (self_service_without_hold), so anyone else's
--     submit lapses it at once. It can still be finished. A squatter that
--     resubmits from its own network with a new email therefore gains
--     nothing, while an applicant who mistyped the email, or whose email
--     already has an account, can start again from the same network;
--   * a refusal binds only where support set one: while a self-service
--     application for this CAC and product that support rejected or
--     released has self_service_refusal_ends_at in the future (7 days, unless
--     support let the applicant retry or later waived it), its email and its
--     network may not open a new one (23514, the same message as any other
--     open-application conflict). A lapse never refuses anyone.
create function identity.submit_self_service_organization_application(
  requested_product text,
  requested_organization_type text,
  requested_cac_number text,
  requested_administrator_name text,
  requested_administrator_email text,
  requested_network_digest char(64) default null
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  normalized_cac text := upper(regexp_replace(coalesce(requested_cac_number, ''), '[[:space:]]+', '', 'g'));
  normalized_email text := lower(btrim(coalesce(requested_administrator_email, '')));
  application identity.organization_applications%rowtype;
  without_hold boolean;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Organization enrollment context is required';
  end if;

  perform platform.require_control_enabled('provider_self_service_enabled');

  if requested_product is null
     or requested_product not in ('ehr', 'migrate', 'laboratory', 'pharmacy')
     or requested_organization_type is null
     or requested_organization_type not in ('clinic', 'hospital', 'laboratory', 'pharmacy', 'other')
     or normalized_cac !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or length(btrim(coalesce(requested_administrator_name, ''))) not between 2 and 200
     or length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or requested_network_digest !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid provider enrollment';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('org-application:' || normalized_cac || ':' || requested_product, 0)
  );

  perform identity.lapse_stale_self_service_organization_application(normalized_cac, requested_product,
    normalized_email);

  select * into application
    from identity.organization_applications row
   where row.cac_registration_number = normalized_cac
     and row.product_code = requested_product
     and row.status <> 'rejected'
   order by row.created_at desc
   limit 1
   for update;

  if found then
    if application.approval_mode <> 'self_service'
       or lower(application.administrator_email) <> normalized_email then
      raise exception using errcode = '23514',
        message = 'This organization application requires manual resolution';
    end if;
    if application.status = 'approved' then
      raise exception using errcode = '23514',
        message = 'This CAC is already registered with HID';
    end if;
    return application.id;
  end if;

  if exists (
    select 1 from identity.organization_applications closed
     where closed.cac_registration_number = normalized_cac
       and closed.product_code = requested_product
       and closed.approval_mode = 'self_service'
       and closed.status = 'rejected'
       and closed.self_service_refusal_ends_at > clock_timestamp()
       and (closed.administrator_email = normalized_email
         or closed.submitter_network_digest = requested_network_digest)
  ) then
    raise exception using errcode = '23514',
      message = 'This organization application requires manual resolution';
  end if;

  select exists (
    select 1 from identity.organization_applications closed
     where closed.cac_registration_number = normalized_cac
       and closed.product_code = requested_product
       and closed.approval_mode = 'self_service'
       and closed.status = 'rejected'
       and coalesce(closed.self_service_released_at, closed.reviewed_at) > clock_timestamp() - interval '7 days'
       and (closed.administrator_email = normalized_email
         or closed.submitter_network_digest = requested_network_digest)
  ) into without_hold;

  insert into identity.organization_applications (
    product_code, organization_name, organization_type, cac_registration_number,
    administrator_name, administrator_email, approval_mode, submitter_network_digest,
    self_service_without_hold
  ) values (
    requested_product, 'Pending CAC verification', requested_organization_type,
    normalized_cac, btrim(requested_administrator_name), normalized_email, 'self_service',
    requested_network_digest, without_hold
  ) returning * into application;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.submit', 'success',
    'organization-application', application.id::text,
    'application', 'identity-api',
    jsonb_build_object(
      'productCode', requested_product,
      'organizationType', requested_organization_type,
      'withoutHold', without_hold
    )
  );

  return application.id;
end;
$$;

-- The Identity runtime activates through this command rather than calling the
-- activation function directly. It returns the new login email from the same
-- transaction, so the API never reads application or challenge tables and can
-- never report a failure after the organization, facility, membership and
-- account have been committed (main 0062, 46a173f). A1: the control first.
create function identity.activate_self_service_provider_enrollment(
  requested_session_hmac char(64),
  requested_password_hash text
) returns table (
  organization_id uuid,
  facility_id uuid,
  account_id uuid,
  row_version bigint,
  hid_subject text,
  account_email text
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  activated record;
  activated_email text;
begin
  perform platform.require_control_enabled('provider_self_service_enabled');

  select * into activated
    from identity.activate_self_service_organization_application(
      requested_session_hmac, requested_password_hash);

  select account.email into activated_email
    from auth.accounts account
   where account.id = activated.account_id;

  if activated_email is null then
    raise exception using errcode = 'P0002', message = 'Activated provider account was not found';
  end if;

  return query select activated.organization_id, activated.facility_id, activated.account_id,
    activated.row_version, activated.hid_subject, activated_email;
end;
$$;

-- R5: 0056's begin_organization_profile_completion sends a code for any
-- open, verified application of the CAC number, product and email, whatever
-- its approval_mode. Before this migration only an administrator's CAC lookup
-- could verify an application; the public self-service lookup now verifies
-- applications whose email the submitter chose, so the governed completion
-- route (and a previous Identity's) could send their codes outside R5's 10 a
-- day per email and without R6's stored details. 0056's body becomes this
-- owner-only helper, which sends only for the approval mode its caller names;
-- the governed command keeps its signature, owner and grants and sends only
-- for governed (admin_review) applications, answering NULL for a self-service
-- one exactly as for no application; the self-service command calls the
-- helper for self-service applications. Refuse to run if the live body is
-- not 0056's, rather than overwrite a change this migration does not know
-- about.
do $$
begin
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = 'identity.begin_organization_profile_completion(text,text,text,uuid,char)'::regprocedure)
     is distinct from '6c94f9fca935f41a1bbcc313d9447d04' then
    raise exception '0086 expected identity.begin_organization_profile_completion to be 0056''s body';
  end if;
end
$$;

create function identity.issue_organization_profile_completion_code(
  requested_cac_number text, requested_email text, requested_product text,
  requested_challenge_id uuid, requested_code_hmac char(64), requested_approval_mode text
) returns text
language plpgsql
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  application identity.organization_applications%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_challenge_id is null
     or requested_code_hmac is null or requested_code_hmac !~ '^[a-f0-9]{64}$'
     or requested_cac_number !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or requested_email is null or requested_product not in
       ('ehr', 'migrate', 'laboratory', 'pharmacy')
     or requested_approval_mode is null
     or requested_approval_mode not in ('admin_review', 'self_service') then
    raise exception using errcode = '22023', message = 'Invalid completion request';
  end if;
  select * into application from identity.organization_applications row
    where row.cac_registration_number = requested_cac_number
      and row.product_code = requested_product
      and row.administrator_email = lower(btrim(requested_email))
      and row.approval_mode = requested_approval_mode
      and row.status in ('pending_verification', 'ready_for_review')
      and row.verification_result = 'verified'
      and row.provider_verified_registration_number = row.cac_registration_number
      and row.provider_reference ~ '^[0-9]+$'
    for update;
  if not found then return null; end if;
  delete from identity.organization_profile_completion_challenges old
   where old.id in (
     select stale.id from identity.organization_profile_completion_challenges stale
      where stale.expires_at < clock_timestamp() - interval '48 hours'
        and (stale.session_expires_at is null
          or stale.session_expires_at < clock_timestamp() - interval '48 hours')
      order by stale.expires_at limit 100
   );
  if exists (select 1 from identity.organization_profile_completion_challenges prior
      where prior.application_id = application.id
        and prior.created_at > clock_timestamp() - interval '60 seconds')
     or (select count(*) from identity.organization_profile_completion_challenges prior
       where prior.application_id = application.id
         and prior.created_at > clock_timestamp() - interval '1 hour') >= 5
     or (select count(*) from identity.organization_profile_completion_challenges prior
       where prior.application_id = application.id
         and prior.created_at > clock_timestamp() - interval '1 day') >= 15 then
    return null;
  end if;
  update identity.organization_profile_completion_challenges challenge
     set invalidated_at = clock_timestamp()
   where challenge.application_id = application.id and challenge.invalidated_at is null
     and challenge.session_hmac is null;
  insert into identity.organization_profile_completion_challenges
    (id, application_id, code_hmac, expires_at)
  values (requested_challenge_id, application.id, requested_code_hmac,
    clock_timestamp() + interval '10 minutes');
  return application.administrator_email;
end;
$$;

create or replace function identity.begin_organization_profile_completion(
  requested_cac_number text, requested_email text, requested_product text,
  requested_challenge_id uuid, requested_code_hmac char(64)
) returns text
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
begin
  return identity.issue_organization_profile_completion_code(requested_cac_number, requested_email,
    requested_product, requested_challenge_id, requested_code_hmac, 'admin_review');
end;
$$;

-- R5 and R6: the emailed code of facility self sign-up. It sends the code
-- through 0056's sending logic (identity.issue_organization_profile_completion_code
-- above, returning the stored administrator email when a code is to be sent,
-- else null), for an open self-service application only, with two additions:
--   * the administrator name and organization type sent with this request
--     are stored on the new challenge, and the activation takes them from the
--     challenge whose code opened its session (R6);
--   * at most 10 codes a day reach one administrator email across every
--     self-service application, on top of 0056's limits per application
--     (R5); past it no code is sent and null is returned, as for 0056's own
--     limits. Identity then reads identity.self_service_provider_code_state
--     in the same transaction (R14) and answers that no code was sent, with
--     the code still in force and the wait before a new one.
-- The recipient's advisory lock serializes the count with the insert.
create function identity.begin_self_service_provider_enrollment(
  requested_cac_number text,
  requested_email text,
  requested_product text,
  requested_challenge_id uuid,
  requested_code_hmac char(64),
  requested_administrator_name text,
  requested_organization_type text
) returns text
language plpgsql security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
declare
  normalized_email text := lower(btrim(coalesce(requested_email, '')));
  recent_codes bigint;
  recipient text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or length(btrim(coalesce(requested_administrator_name, ''))) not between 2 and 200
     or requested_organization_type is null
     or requested_organization_type not in ('clinic', 'hospital', 'laboratory', 'pharmacy', 'other') then
    raise exception using errcode = '22023', message = 'Invalid completion request';
  end if;
  if not exists (
    select 1 from identity.organization_applications application
     where application.cac_registration_number = requested_cac_number
       and application.product_code = requested_product
       and application.administrator_email = normalized_email
       and application.approval_mode = 'self_service'
       and application.status in ('pending_verification', 'ready_for_review')
  ) then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('org-completion-recipient:' || normalized_email, 0));
  select count(*) into recent_codes
    from identity.organization_applications application
    join identity.organization_profile_completion_challenges challenge
      on challenge.application_id = application.id
   where application.administrator_email = normalized_email
     and application.approval_mode = 'self_service'
     and challenge.created_at > clock_timestamp() - interval '1 day';
  if recent_codes >= 10 then return null; end if;

  recipient := identity.issue_organization_profile_completion_code(requested_cac_number, requested_email,
    requested_product, requested_challenge_id, requested_code_hmac, 'self_service');
  if recipient is not null then
    update identity.organization_profile_completion_challenges challenge
       set requested_administrator_name = btrim(begin_self_service_provider_enrollment.requested_administrator_name),
           requested_organization_type = begin_self_service_provider_enrollment.requested_organization_type
     where challenge.id = requested_challenge_id;
  end if;
  return recipient;
end;
$$;

-- R1: the activation's pre-check. Identity runs it in its own committed
-- transaction before it computes the 64 MiB argon2id hash, and hashes only
-- when it answers 'ready'. The answers:
--   'session_invalid'   no live completion session (nothing changes), or a
--                       session whose application is no longer open (it was
--                       activated, lapsed or rejected; the session is ended);
--   'attempts_exceeded' the session already made 5 activation attempts;
--   'not_ready'         its application is not a verified self-service
--                       application ready for activation (a governed
--                       application's session among them);
--   'email_registered'  the administrator email already belongs to an
--                       account or a staff record (#81);
--   'cac_bound'         the CAC is already bound to an HID organization;
--   'name_exists'       an organization already has the verified legal name;
--   'ready'             the attempt is charged to the session's budget.
-- Every answer but 'ready' and 'session_invalid' ends the session (its
-- challenge is invalidated), so an activation that can never succeed costs
-- at most one pre-check, and a session gets at most 5 hashes. The activation
-- command repeats every check under its locks. The control is read after the
-- session's row lock (A1), so a control closed while a request waits for
-- that lock refuses it.
-- R3: 'email_registered' also closes the application (rejected, with no
-- reviewer, an explanatory reason and no refusal; its other codes and
-- sessions are ended; audited identity.organization.self-service.close), since
-- that email can never activate it: the applicant can start again at once
-- with another email, from the same network, rather than wait for the
-- application to lapse. Other sessions of the application are ended only if
-- no other transaction holds them (SKIP LOCKED): a pre-check or activation
-- holding one finds the application closed and refuses, so this never waits
-- on a session out of the lapse's lock order.
create function identity.prepare_self_service_provider_activation(
  requested_session_hmac char(64)
) returns text
language plpgsql security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  challenge identity.organization_profile_completion_challenges%rowtype;
  application identity.organization_applications%rowtype;
  session_found boolean;
  refusal text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_session_hmac is null
     or requested_session_hmac !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'Self-service activation context is required';
  end if;

  select * into challenge
    from identity.organization_profile_completion_challenges row
   where row.session_hmac = requested_session_hmac
     and row.consumed_at is not null
     and row.invalidated_at is null
     and row.session_expires_at > clock_timestamp()
   for update;
  session_found := found;

  perform platform.require_control_enabled('provider_self_service_enabled');

  if not session_found then return 'session_invalid'; end if;

  if challenge.activation_attempts >= 5 then
    refusal := 'attempts_exceeded';
  else
    select * into application
      from identity.organization_applications row
     where row.id = challenge.application_id;
    if not found or application.status not in ('pending_verification', 'ready_for_review') then
      refusal := 'application_closed';
    elsif application.approval_mode is distinct from 'self_service'
       or application.status is distinct from 'ready_for_review'
       or application.verification_result is distinct from 'verified'
       or application.verified_at is null
       or application.provider_verified_registration_number is distinct from application.cac_registration_number
       or application.qoreid_registry_status is distinct from 'active'
       or application.qoreid_organization_name is null
       or application.qoreid_entity_type is null
       or application.qoreid_registration_date is null
       or application.qoreid_address is null then
      refusal := 'not_ready';
    elsif exists (
      select 1 from auth.accounts account
       where lower(account.email) = lower(application.administrator_email)
         and account.email is not null and account.status <> 'deleted'
    ) or exists (
      select 1 from identity.staff staff
       where lower(staff.email) = lower(application.administrator_email)
    ) then
      refusal := 'email_registered';
    elsif exists (
      select 1 from identity.organization_cac_registrations registration
       where registration.cac_registration_number = application.cac_registration_number
    ) then
      refusal := 'cac_bound';
    elsif exists (
      select 1 from identity.organizations organization
       where lower(organization.name) = lower(application.qoreid_organization_name)
    ) then
      refusal := 'name_exists';
    end if;
  end if;

  if refusal is null then
    update identity.organization_profile_completion_challenges row
       set activation_attempts = row.activation_attempts + 1
     where row.id = challenge.id;
    return 'ready';
  end if;
  update identity.organization_profile_completion_challenges row
     set invalidated_at = clock_timestamp()
   where row.id = challenge.id;
  if refusal = 'email_registered' then
    update identity.organization_applications row
       set status = 'rejected',
           reviewed_at = clock_timestamp(),
           review_reason = 'Self-service application closed: its administrator email already belongs to an account',
           updated_at = clock_timestamp(),
           row_version = row.row_version + 1
     where row.id = application.id
       and row.approval_mode = 'self_service'
       and row.status in ('pending_verification', 'ready_for_review')
    returning row.* into application;
    if found then
      update identity.organization_profile_completion_challenges row
         set invalidated_at = clock_timestamp()
       where row.id in (
         select other.id from identity.organization_profile_completion_challenges other
          where other.application_id = application.id
            and other.invalidated_at is null
          for update skip locked);
      insert into audit.events (
        correlation_id, actor_type, action, outcome, resource_type, resource_id,
        provenance, source_system, details
      ) values (
        platform.current_correlation_id(), 'system',
        'identity.organization.self-service.close', 'success',
        'organization-application', application.id::text,
        'application', 'identity-api',
        jsonb_build_object('productCode', application.product_code,
          'closeReason', 'administrator_email_registered')
      );
    end if;
  end if;
  if refusal = 'application_closed' then return 'session_invalid'; end if;
  return refusal;
end;
$$;

-- R13: the confirmation read. Before the password, Identity shows the
-- applicant what the activation will register, so a mistyped CAC number that
-- names another, real company can be caught before any account exists: the
-- verified legal name the organization and facility will take
-- (qoreid_organization_name), the CAC number as the applicant entered it (the
-- application's, which the activation also requires to equal QoreID's), the
-- product, and the organization type and administrator name the account will
-- keep (R6: those sent with the request whose code opened this session), with
-- the administrator email. It answers for a live completion session of a
-- verified self-service application ready for activation, and returns no row
-- for any other session (Identity answers 401). It reads only: it locks
-- nothing, charges no activation attempt and ends no session. Like the
-- commands, it needs the control on.
create function identity.current_self_service_provider_enrollment(
  requested_session_hmac char(64)
) returns table (
  organization_name text,
  cac_registration_number text,
  product_code text,
  organization_type text,
  administrator_name text,
  administrator_email text
)
language plpgsql security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_session_hmac is null
     or requested_session_hmac !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'Self-service enrollment context is required';
  end if;

  perform platform.require_control_enabled('provider_self_service_enabled');

  return query
    select application.qoreid_organization_name, application.cac_registration_number,
      application.product_code,
      coalesce(challenge.requested_organization_type, application.organization_type),
      coalesce(challenge.requested_administrator_name, application.administrator_name),
      application.administrator_email
    from identity.organization_profile_completion_challenges challenge
    join identity.organization_applications application on application.id = challenge.application_id
    where challenge.session_hmac = requested_session_hmac
      and challenge.consumed_at is not null
      and challenge.invalidated_at is null
      and challenge.session_expires_at > clock_timestamp()
      and application.approval_mode = 'self_service'
      and application.status = 'ready_for_review'
      and application.verification_result = 'verified'
      and application.verified_at is not null
      and application.provider_verified_registration_number = application.cac_registration_number
      and application.qoreid_registry_status = 'active'
      and application.qoreid_organization_name is not null;
end;
$$;

-- R18: "This isn't my organization". From the verified completion session
-- (the hid_provider_enrollment cookie), the applicant closes its own open
-- self-service application, for example after the confirmation read showed
-- that a mistyped CAC number names another company, so that number stops
-- being held. It answers:
--   'withdrawn'        the application is closed (rejected, no reviewer, the
--                      reason "withdrawn by its applicant", no refusal), every
--                      code and session of it is ended, and the withdrawal is
--                      audited identity.organization.self-service.withdraw;
--   'session_invalid'  no live completion session (nothing changes), or a
--                      session whose application is no longer open (the
--                      session is ended).
-- It sets no 7-day refusal for the email or network: like any closure, it
-- only means that a new application of that email or network for the same
-- CAC number and product within 7 days is opened without a hold (R15), so a
-- squatter cannot renew a hold by withdrawing. The control is read after the
-- session's row lock, as the pre-check does. Lock order as the activation:
-- the session, then the application, then the application's other codes and
-- sessions, taken only if no other transaction holds them (SKIP LOCKED: one
-- that does finds the application closed).
create function identity.withdraw_self_service_provider_enrollment(
  requested_session_hmac char(64)
) returns text
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  challenge identity.organization_profile_completion_challenges%rowtype;
  application identity.organization_applications%rowtype;
  session_found boolean;
  previous_status text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_session_hmac is null
     or requested_session_hmac !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'Self-service enrollment context is required';
  end if;

  select * into challenge
    from identity.organization_profile_completion_challenges row
   where row.session_hmac = requested_session_hmac
     and row.consumed_at is not null
     and row.invalidated_at is null
     and row.session_expires_at > clock_timestamp()
   for update;
  session_found := found;

  perform platform.require_control_enabled('provider_self_service_enabled');

  if not session_found then return 'session_invalid'; end if;

  select * into application
    from identity.organization_applications row
   where row.id = challenge.application_id
   for update;
  if not found
     or application.approval_mode is distinct from 'self_service'
     or application.status not in ('pending_verification', 'ready_for_review') then
    update identity.organization_profile_completion_challenges row
       set invalidated_at = clock_timestamp()
     where row.id = challenge.id;
    return 'session_invalid';
  end if;
  previous_status := application.status;

  update identity.organization_applications row
     set status = 'rejected',
         reviewed_at = clock_timestamp(),
         review_reason = 'Self-service application withdrawn by its applicant',
         updated_at = clock_timestamp(),
         row_version = row.row_version + 1
   where row.id = application.id
  returning row.* into application;
  update identity.organization_profile_completion_challenges row
     set invalidated_at = clock_timestamp()
   where row.id = challenge.id;
  update identity.organization_profile_completion_challenges row
     set invalidated_at = clock_timestamp()
   where row.id in (
     select other.id from identity.organization_profile_completion_challenges other
      where other.application_id = application.id
        and other.invalidated_at is null
        and other.id <> challenge.id
      for update skip locked);

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.withdraw', 'success',
    'organization-application', application.id::text,
    'application', 'identity-api',
    jsonb_build_object('productCode', application.product_code, 'previousStatus', previous_status)
  );
  return 'withdrawn';
end;
$$;

-- R14: the emailed code's state, for start's answer. Identity runs it in the
-- start's own transaction right after begin_self_service_provider_enrollment,
-- which returns null both when a limit stops the code (0056's 60 seconds, 5 an
-- hour and 15 a day per application; R5's 10 a day per administrator email)
-- and when the application is no longer open, so the answer can say that no
-- code was sent rather than answer as if one had been. For the open, verified
-- self-service application of this CAC number, product and administrator email
-- (the conditions 0056 sends a code for) it returns:
--   application_open      false when there is none (activated, lapsed or
--                         rejected meanwhile; the rest is then null);
--   challenge_id          the code in force: this application's newest code
--                         that can still be entered (not used, not
--                         invalidated, not expired, under 5 wrong tries),
--                         else null;
--   expires_in_seconds    how long that code can still be entered;
--   resend_after_seconds  how long until a start can send a new code: the
--                         latest of those limits' ends, each counted as
--                         0056 and R5 count it; 0 when one would be sent now.
-- It reads only; it locks and changes nothing.
create function identity.self_service_provider_code_state(
  requested_cac_number text,
  requested_email text,
  requested_product text
) returns table (
  application_open boolean,
  challenge_id uuid,
  expires_in_seconds integer,
  resend_after_seconds integer
)
language plpgsql security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
declare
  normalized_email text := lower(btrim(coalesce(requested_email, '')));
  observed_at timestamptz := clock_timestamp();
  open_application uuid;
  in_force_id uuid;
  in_force_expires_at timestamptz;
  resend_at timestamptz;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Self-service enrollment context is required';
  end if;

  select application.id into open_application
    from identity.organization_applications application
   where application.cac_registration_number = requested_cac_number
     and application.product_code = requested_product
     and application.administrator_email = normalized_email
     and application.approval_mode = 'self_service'
     and application.status in ('pending_verification', 'ready_for_review')
     and application.verification_result = 'verified'
     and application.provider_verified_registration_number = application.cac_registration_number
     and application.provider_reference ~ '^[0-9]+$'
   order by application.created_at desc
   limit 1;
  if open_application is null then
    return query select false, null::uuid, null::integer, null::integer;
    return;
  end if;

  select challenge.id, challenge.expires_at into in_force_id, in_force_expires_at
    from identity.organization_profile_completion_challenges challenge
   where challenge.application_id = open_application
     and challenge.consumed_at is null
     and challenge.invalidated_at is null
     and challenge.expires_at > observed_at
     and challenge.failed_attempts < 5
   order by challenge.created_at desc
   limit 1;

  -- Each limit ends when its window's oldest counted code leaves it: the
  -- 60 seconds after the newest code; the 5th newest code in the last hour
  -- plus an hour; the 15th newest in the last day plus a day; the email's
  -- 10th newest self-service code in the last day plus a day.
  resend_at := greatest(
    (select max(prior.created_at) + interval '60 seconds'
       from identity.organization_profile_completion_challenges prior
      where prior.application_id = open_application),
    (select prior.created_at + interval '1 hour'
       from identity.organization_profile_completion_challenges prior
      where prior.application_id = open_application
        and prior.created_at > observed_at - interval '1 hour'
      order by prior.created_at desc offset 4 limit 1),
    (select prior.created_at + interval '1 day'
       from identity.organization_profile_completion_challenges prior
      where prior.application_id = open_application
        and prior.created_at > observed_at - interval '1 day'
      order by prior.created_at desc offset 14 limit 1),
    (select prior.created_at + interval '1 day'
       from identity.organization_applications application
       join identity.organization_profile_completion_challenges prior on prior.application_id = application.id
      where application.administrator_email = normalized_email
        and application.approval_mode = 'self_service'
        and prior.created_at > observed_at - interval '1 day'
      order by prior.created_at desc offset 9 limit 1));

  return query select true, in_force_id,
    case when in_force_id is null then null::integer
      else greatest(0, floor(extract(epoch from in_force_expires_at - observed_at)))::integer end,
    case when resend_at is null or resend_at <= observed_at then 0
      else ceil(extract(epoch from resend_at - observed_at))::integer end;
end;
$$;

-- C9: the governed submit (0052) lapses a stale self-service application the
-- same way before it looks for an open application, so neither path stays
-- blocked by an abandoned self-service row. Otherwise 0052's body, signature,
-- owner and grants are unchanged.
create or replace function identity.submit_organization_application(
  requested_product text,
  requested_organization_type text,
  requested_cac_number text,
  requested_administrator_name text,
  requested_administrator_email text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  normalized_cac text := upper(regexp_replace(coalesce(requested_cac_number, ''), '[[:space:]]+', '', 'g'));
  normalized_email text := lower(btrim(coalesce(requested_administrator_email, '')));
  application_id_value uuid;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Organization application context is required';
  end if;
  if requested_product is null
     or requested_product not in ('ehr', 'migrate', 'laboratory', 'pharmacy')
     or requested_organization_type is null
     or requested_organization_type not in ('clinic', 'hospital', 'laboratory', 'pharmacy', 'other')
     or normalized_cac !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or length(btrim(coalesce(requested_administrator_name, ''))) not between 2 and 200
     or length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'Invalid organization application';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('org-application:' || normalized_cac || ':' || requested_product, 0));
  perform identity.lapse_stale_self_service_organization_application(normalized_cac, requested_product, null);
  select application.id into application_id_value
    from identity.organization_applications application
   where application.cac_registration_number = normalized_cac
     and application.product_code = requested_product
     and application.status <> 'rejected';
  if application_id_value is not null then return application_id_value; end if;

  insert into identity.organization_applications (
    product_code, organization_type, cac_registration_number,
    administrator_name, administrator_email
  ) values (
    requested_product, requested_organization_type, normalized_cac,
    btrim(requested_administrator_name), normalized_email
  ) returning id into application_id_value;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system', 'identity.organization.application.submit',
    'success', 'organization-application', application_id_value::text,
    'application', 'identity-api', jsonb_build_object(
      'productCode', requested_product, 'organizationType', requested_organization_type)
  );
  return application_id_value;
end;
$$;

revoke all on function identity.public_get_organization_application(text,text,text),
  identity.public_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text),
  identity.activate_self_service_organization_application(char,text),
  identity.lapse_stale_self_service_organization_application(text,text,text),
  identity.issue_organization_profile_completion_code(text,text,text,uuid,char,text),
  identity.submit_self_service_organization_application(text,text,text,text,text,char),
  identity.activate_self_service_provider_enrollment(char,text),
  identity.begin_self_service_provider_enrollment(text,text,text,uuid,char,text,text),
  identity.prepare_self_service_provider_activation(char),
  identity.current_self_service_provider_enrollment(char),
  identity.self_service_provider_code_state(text,text,text),
  identity.withdraw_self_service_provider_enrollment(char)
  from public;

-- 3. QoreID CAC lookup quota for accountless self-service (main 0063, 08c906f).
-- The lookup is charged to a keyed digest of the client network (5 an hour,
-- 15 a day), to the application's 0049 daily CAC counter shared with the
-- reviewed path (3 a day) and (A6) to a platform-wide daily counter whose
-- limit Identity passes (PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP, 1-100000).
-- Request fields cannot select or reset a scope. No CAC number, raw IP, email
-- or provider payload is stored. Every decision is audited, including denials.
create table platform.self_service_cac_quota_counters (
  network_digest char(64) not null check (network_digest ~ '^[a-f0-9]{64}$'),
  bucket_period text not null check (bucket_period in ('hour', 'day')),
  bucket_start timestamptz not null,
  attempt_count integer not null check (attempt_count between 1 and 1000000),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (network_digest, bucket_period, bucket_start)
);
create index self_service_cac_quota_expiry_idx on platform.self_service_cac_quota_counters(bucket_start);
alter table platform.self_service_cac_quota_counters enable row level security;
alter table platform.self_service_cac_quota_counters force row level security;
-- As in 0049, the security-definer command is the only runtime access path.
create policy self_service_cac_quota_command_read on platform.self_service_cac_quota_counters
  for select using (true);
create policy self_service_cac_quota_command_insert on platform.self_service_cac_quota_counters
  for insert with check (true);
create policy self_service_cac_quota_command_update on platform.self_service_cac_quota_counters
  for update using (true) with check (true);
create policy self_service_cac_quota_command_delete on platform.self_service_cac_quota_counters
  for delete using (true);
revoke all on platform.self_service_cac_quota_counters from public;

-- A6: one row per day across every self-service applicant. Its primary key
-- is the expiry index.
create table platform.self_service_cac_platform_quota_counters (
  bucket_start timestamptz primary key,
  attempt_count integer not null check (attempt_count between 1 and 1000000),
  updated_at timestamptz not null default clock_timestamp()
);
alter table platform.self_service_cac_platform_quota_counters enable row level security;
alter table platform.self_service_cac_platform_quota_counters force row level security;
create policy self_service_cac_platform_quota_command_read on platform.self_service_cac_platform_quota_counters
  for select using (true);
create policy self_service_cac_platform_quota_command_insert on platform.self_service_cac_platform_quota_counters
  for insert with check (true);
create policy self_service_cac_platform_quota_command_update on platform.self_service_cac_platform_quota_counters
  for update using (true) with check (true);
create policy self_service_cac_platform_quota_command_delete on platform.self_service_cac_platform_quota_counters
  for delete using (true);
revoke all on platform.self_service_cac_platform_quota_counters from public;

-- Returns true when the lookup may proceed. A denial returns false rather than
-- raising, so its audit event commits while every counter stays unchanged.
-- The platform day is charged last, so a network or application denial is
-- reported as such and never spends the platform's lookups.
create function platform.consume_self_service_cac_quota(
  requested_application uuid,
  requested_network_digest char(64),
  platform_daily_limit integer
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, platform, identity, audit, pg_temp
as $$
declare
  quota record;
  new_attempts integer;
  exhausted_limit text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or platform.current_account_id() is not null
     or requested_application is null
     or requested_network_digest is null
     or requested_network_digest !~ '^[a-f0-9]{64}$'
     or not exists (
       select 1 from identity.organization_applications application
        where application.id = requested_application
          and application.approval_mode = 'self_service'
          and application.status = 'pending_verification'
     ) then
    raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
  end if;
  if platform_daily_limit is null or platform_daily_limit not between 1 and 100000 then
    raise exception using errcode = '22023', message = 'QOREID_QUOTA_LIMIT_INVALID';
  end if;

  delete from platform.self_service_cac_quota_counters old
   where old.ctid in (select stale.ctid from platform.self_service_cac_quota_counters stale
     where stale.bucket_start < statement_timestamp() - interval '48 hours'
     order by stale.bucket_start limit 100);
  delete from platform.self_service_cac_platform_quota_counters old
   where old.bucket_start < statement_timestamp() - interval '48 hours';

  begin
    for quota in
      select * from (values
        ('network_hour'::text, 'hour'::text, date_trunc('hour', statement_timestamp()), 5),
        ('network_day'::text, 'day'::text, date_trunc('day', statement_timestamp()), 15)
      ) as limits(limit_name, bucket_period, bucket_start, max_attempts)
    loop
      insert into platform.self_service_cac_quota_counters as counter
        (network_digest, bucket_period, bucket_start, attempt_count)
      values (requested_network_digest, quota.bucket_period, quota.bucket_start, 1)
      on conflict (network_digest, bucket_period, bucket_start)
      do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
        where counter.attempt_count < quota.max_attempts
      returning attempt_count into new_attempts;
      if not found then
        exhausted_limit := quota.limit_name;
        raise exception using errcode = 'P4290', message = 'QOREID_QUOTA_EXCEEDED';
      end if;
    end loop;

    -- The same per-application row and limit 0049 uses for `application_cac`.
    insert into platform.qoreid_quota_counters as counter
      (operation, scope_type, scope_id, bucket_period, bucket_start, attempt_count)
    values ('application_cac', 'target', requested_application, 'day',
      date_trunc('day', statement_timestamp()), 1)
    on conflict (operation, scope_type, scope_id, bucket_period, bucket_start)
    do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
      where counter.attempt_count < 3
    returning attempt_count into new_attempts;
    if not found then
      exhausted_limit := 'application_day';
      raise exception using errcode = 'P4290', message = 'QOREID_QUOTA_EXCEEDED';
    end if;

    insert into platform.self_service_cac_platform_quota_counters as counter
      (bucket_start, attempt_count)
    values (date_trunc('day', statement_timestamp()), 1)
    on conflict (bucket_start)
    do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
      where counter.attempt_count < platform_daily_limit
    returning attempt_count into new_attempts;
    if not found then
      exhausted_limit := 'platform_day';
      raise exception using errcode = 'P4290', message = 'QOREID_QUOTA_EXCEEDED';
    end if;
  exception when sqlstate 'P4290' then
    -- Leaving the block rolls back any increment made before the exhausted scope.
    null;
  end;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.cac-quota',
    case when exhausted_limit is null then 'success' else 'denied' end,
    'organization-application', requested_application::text,
    'application', 'identity-api',
    jsonb_build_object('operation', 'self_service_cac', 'exhaustedLimit', exhausted_limit,
      'networkDigest', requested_network_digest, 'platformDailyLimit', platform_daily_limit)
  );

  return exhausted_limit is null;
end
$$;

revoke all on function platform.consume_self_service_cac_quota(uuid,char,integer) from public;

-- A4 (C11): the hourly prune keeps the body live at merge, 0049's, and also
-- drains this migration's two counter tables. Refuse to run if another
-- migration already changed which tables it prunes, rather than drop them.
do $$
declare
  pruned text[];
begin
  select array_agg(distinct match[1] order by match[1]) into pruned
    from pg_proc proc, regexp_matches(proc.prosrc, 'delete from platform\.([a-z_]+)', 'g') match
   where proc.oid = 'platform.prune_verification_quotas()'::regprocedure;
  if pruned is distinct from array['public_application_quota_counters', 'qoreid_quota_counters',
       'qoreid_test_quota_reservations']::text[] then
    raise exception '0086 expected platform.prune_verification_quotas to prune exactly the 0049 tables, found %', pruned;
  end if;
end
$$;

create or replace function platform.prune_verification_quotas() returns integer
language plpgsql security definer
set search_path = pg_catalog, platform, pg_temp
as $$
declare
  deleted_count integer := 0;
  batch_count integer;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
  end if;
  delete from platform.qoreid_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.qoreid_test_quota_reservations
    where reserved_at < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.public_application_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.self_service_cac_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.self_service_cac_platform_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  return deleted_count + batch_count;
end
$$;
revoke all on function platform.prune_verification_quotas() from public;

-- R7 (CRITIC C13): an activated administrator holds organization.manage
-- (0006) and could charge organization CAC lookups to 0049's account and
-- organization quotas (5 an hour, 15 a day, 10 a day per organization),
-- outside the platform's daily cap for self sign-up. Until support has
-- reviewed a self-signed-up organization, its existing_cac lookup is refused
-- (42501, which Identity answers 403 PERMISSION_DENIED before any QoreID
-- request). 0049's body otherwise, with its signature, owner and grants;
-- refuse to run if the live body is not 0049's, rather than overwrite a
-- change this migration does not know about. A later migration that replaces
-- this function must keep the check.
do $$
begin
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = 'platform.consume_qoreid_quota(text,uuid,uuid,char,char)'::regprocedure)
     is distinct from 'dca2fbb737f2c747148eacc7d6e66c5f' then
    raise exception '0086 expected platform.consume_qoreid_quota to be 0049''s body';
  end if;
end
$$;

create or replace function platform.consume_qoreid_quota(
  requested_operation text, requested_target uuid, requested_patient_session uuid,
  requested_idempotency_hash char(64), requested_request_sha256 char(64)
) returns void
language plpgsql security definer
set search_path = pg_catalog, platform, auth, identity, pg_temp
as $$
declare
  actor uuid := platform.current_account_id();
  actor_subject text := platform.current_actor_subject();
  hourly_max integer;
  daily_max integer;
  target_daily_max integer := 0;
  quota record;
  new_attempts integer;
begin
  if actor is null or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
  end if;

  if requested_operation <> 'connection_test'
     and (requested_idempotency_hash is not null or requested_request_sha256 is not null) then
    raise exception using errcode = '22023', message = 'QOREID_QUOTA_OPERATION_INVALID';
  end if;

  case requested_operation
    when 'patient_nin' then
      if requested_target is not null or requested_patient_session is null
         or identity.patient_self_session(actor_subject, requested_patient_session) is null then
        raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
      end if;
      hourly_max := 3; daily_max := 10;
    when 'existing_cac' then
      if requested_target is null or requested_patient_session is not null
         or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
         or not auth.membership_has_permission(
           actor_subject, platform.current_membership_id(), platform.current_facility_id(), 'organization.manage'
         )
         or not exists (
           select 1 from identity.facilities facility
           where facility.id = platform.current_facility_id()
             and facility.organization_id = requested_target and facility.active
         ) then
        raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
      end if;
      -- 0086 R7 (CRITIC C13): an organization that signed itself up makes no
      -- CAC lookup until support has reviewed it.
      if exists (
        select 1 from identity.organization_applications application
         where application.organization_id = requested_target
           and application.approval_mode = 'self_service'
           and application.status = 'approved'
           and application.reviewed_by_account_id is null
           and application.self_service_reviewed_at is null
      ) then
        raise exception using errcode = '42501', message = 'QOREID_QUOTA_SELF_SERVICE_REVIEW_REQUIRED';
      end if;
      hourly_max := 5; daily_max := 15; target_daily_max := 10;
    when 'application_cac' then
      if requested_target is null or requested_patient_session is not null
         or identity.organization_application_admin_account('platform.facility.manage') <> actor
         or not exists (select 1 from identity.organization_applications application
           where application.id = requested_target) then
        raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
      end if;
      hourly_max := 5; daily_max := 15; target_daily_max := 3;
    when 'connection_test' then
      if requested_target is not null or requested_patient_session is not null
         or requested_idempotency_hash is null or requested_idempotency_hash !~ '^[a-f0-9]{64}$'
         or requested_request_sha256 is null or requested_request_sha256 !~ '^[a-f0-9]{64}$'
         or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
         or not auth.account_has_platform_permission(actor, 'platform.integration.test') then
        raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
      end if;
      hourly_max := 3; daily_max := 10;
    else
      raise exception using errcode = '22023', message = 'QOREID_QUOTA_OPERATION_INVALID';
  end case;

  -- Incremental, indexed pruning keeps active deployments within 48 hours
  -- of historical counters. Each invocation deletes at most 100 old
  -- rows; the scheduled maintenance command below drains dormant rows.
  delete from platform.qoreid_quota_counters old
   where old.ctid in (select stale.ctid from platform.qoreid_quota_counters stale
     where stale.bucket_start < statement_timestamp() - interval '48 hours'
     order by stale.bucket_start limit 100);
  delete from platform.qoreid_test_quota_reservations old
   where old.ctid in (select stale.ctid from platform.qoreid_test_quota_reservations stale
     where stale.reserved_at < statement_timestamp() - interval '2 days'
     order by stale.reserved_at limit 100);

  if requested_operation = 'connection_test' then
    insert into platform.qoreid_test_quota_reservations
      (actor_account_id, idempotency_key_sha256, request_sha256)
    values (actor, requested_idempotency_hash, requested_request_sha256)
    on conflict do nothing;
    if not found then
      raise exception using errcode = 'P4090', message = 'QOREID_TEST_ALREADY_ATTEMPTED';
    end if;
  end if;

  -- INSERT ... ON CONFLICT is atomic across API replicas. If any scope is
  -- exhausted, the raised exception rolls back increments to earlier scopes.
  for quota in
    select * from (values
      ('account'::text, actor, 'hour'::text, date_trunc('hour', statement_timestamp()), hourly_max),
      ('account'::text, actor, 'day'::text, date_trunc('day', statement_timestamp()), daily_max),
      ('target'::text, requested_target, 'day'::text, date_trunc('day', statement_timestamp()), target_daily_max)
    ) as limits(scope_type, scope_id, bucket_period, bucket_start, max_attempts)
    where limits.scope_id is not null and limits.max_attempts > 0
  loop
    insert into platform.qoreid_quota_counters as counter
      (operation, scope_type, scope_id, bucket_period, bucket_start, attempt_count)
    values (requested_operation, quota.scope_type, quota.scope_id, quota.bucket_period, quota.bucket_start, 1)
    on conflict (operation, scope_type, scope_id, bucket_period, bucket_start)
    do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
      where counter.attempt_count < quota.max_attempts
    returning attempt_count into new_attempts;
    if not found then
      raise exception using errcode = 'P4290', message = 'QOREID_QUOTA_EXCEEDED';
    end if;
  end loop;
end
$$;

-- 4. Support's review of activated self-service facilities (owner decision of
-- 2026-10-24). An activated self-service application is a self-service
-- application the activation command approved, which it does with
-- reviewed_by_account_id null (an administrator's approval of a self-service
-- row always names the administrator); support may later release it (R2),
-- which closes it and keeps it listed as handled.
--
-- Permission and context are those of the governed application commands
-- (0046): a platform account (resolved from the actor subject), a correlation
-- ID, the healthcare-operations purpose of use, platform.identity-review.read
-- to list and platform.facility.manage to review, release or reject. Unlike
-- them, and like 0064's standalone administration commands, no facility
-- membership is required, because Identity's administrators sign in as staff
-- sessions without one. Refusals raise 42501 ADMIN_PERMISSION_DENIED.
--
-- The list: 'unreviewed' is every approved, unreviewed and unreleased one,
-- oldest activation first (R12: the most overdue against support's
-- one-business-day review come first, and none is hidden behind 200 newer
-- ones); 'reviewed' is every reviewed or released one and 'all' is both,
-- newest activation first. At most 200 rows.
create function identity.admin_list_self_service_facilities(requested_state text)
returns table (
  application_id uuid,
  row_version bigint,
  organization_id uuid,
  organization_name text,
  facility_id uuid,
  facility_name text,
  facility_lifecycle_status text,
  product_code text,
  organization_type text,
  cac_hint text,
  administrator_name text,
  administrator_email text,
  administrator_account_id uuid,
  administrator_account_status text,
  activated_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by_account_id uuid,
  review_note text,
  released_at timestamptz,
  released_by_account_id uuid,
  release_reason text,
  review_grants_role text,
  reviewable_roles text[],
  granted_role text,
  verification_method text,
  administrator_licence_body text,
  administrator_licence_number text,
  administrator_licence_recorded_at timestamptz,
  member_count integer,
  pending_invitation_count integer,
  probation_ends_at timestamptz,
  break_glass_last_7d integer,
  delivery_failures_last_day integer
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  observed timestamptz := clock_timestamp();
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(actor_account, 'platform.identity-review.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_state is null or requested_state not in ('unreviewed', 'reviewed', 'all') then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_FACILITY_STATE_INVALID';
  end if;
  return query
    select listed.application_id, listed.row_version, listed.organization_id, listed.organization_name,
      listed.facility_id, listed.facility_name, listed.facility_lifecycle_status, listed.product_code,
      listed.organization_type, listed.cac_hint, listed.administrator_name, listed.administrator_email,
      listed.administrator_account_id, listed.administrator_account_status, listed.activated_at,
      listed.reviewed_at, listed.reviewed_by_account_id, listed.review_note,
      listed.released_at, listed.released_by_account_id, listed.release_reason,
      identity.self_service_administrator_role(listed.organization_type, listed.product_code),
      identity.self_service_reviewable_roles(listed.organization_type, listed.product_code),
      listed.granted_role, listed.verification_method, listed.administrator_licence_body,
      listed.administrator_licence_number, listed.administrator_licence_recorded_at,
      (select count(*)::integer from identity.staff_facility_memberships membership
        where membership.organization_id = listed.organization_id and membership.active),
      (select count(*)::integer from identity.staff_invitations invitation
        where invitation.organization_id = listed.organization_id and invitation.status = 'pending'
          and invitation.expires_at > observed),
      case when listed.released_at is null and listed.reviewed_at is not null
             and listed.probation_ended_at is null
             and observed < listed.reviewed_at + interval '30 days'
        then listed.reviewed_at + interval '30 days' end,
      (select count(*)::integer from identity.consent_grants grant_row
        where grant_row.facility_id = listed.facility_id and grant_row.break_glass
          and grant_row.starts_at > observed - interval '7 days'),
      (select count(*)::integer from identity.staff_invitation_sends send
        where send.facility_id = listed.facility_id and send.outcome = 'definitive_failure'
          and send.sent_at > observed - interval '24 hours')
    from (
      select app.id as application_id, app.row_version, app.organization_id,
        app.verified_organization_name as organization_name,
        app.facility_id, facility.name as facility_name, facility.lifecycle_status as facility_lifecycle_status,
        app.product_code, app.organization_type,
        left(app.cac_registration_number, 2)
          || repeat('*', length(app.cac_registration_number) - 4)
          || right(app.cac_registration_number, 2) as cac_hint,
        app.administrator_name, app.administrator_email,
        app.first_admin_account_id as administrator_account_id, account.status as administrator_account_status,
        app.reviewed_at as activated_at, app.self_service_reviewed_at as reviewed_at,
        app.self_service_reviewed_by_account_id as reviewed_by_account_id,
        app.self_service_review_note as review_note,
        app.self_service_released_at as released_at,
        app.self_service_released_by_account_id as released_by_account_id,
        app.self_service_release_reason as release_reason,
        app.self_service_granted_role as granted_role,
        app.self_service_verification_method as verification_method,
        app.self_service_admin_licence_body as administrator_licence_body,
        app.self_service_admin_licence_number as administrator_licence_number,
        app.self_service_admin_licence_recorded_at as administrator_licence_recorded_at,
        app.self_service_probation_ended_at as probation_ended_at
      from identity.organization_applications app
      left join identity.facilities facility on facility.id = app.facility_id
      left join auth.accounts account on account.id = app.first_admin_account_id
      where app.approval_mode = 'self_service'
        and app.organization_id is not null
        and app.reviewed_by_account_id is null
        and (app.status = 'approved' or app.self_service_released_at is not null)
        and (requested_state = 'all'
          or (requested_state = 'unreviewed' and app.status = 'approved'
            and app.self_service_reviewed_at is null)
          or (requested_state = 'reviewed'
            and (app.self_service_reviewed_at is not null or app.self_service_released_at is not null)))
    ) listed
    order by case when requested_state = 'unreviewed' then listed.activated_at end asc,
      case when requested_state = 'unreviewed' then listed.application_id end asc,
      listed.activated_at desc, listed.application_id desc
    limit 200;
end;
$$;

-- Support's review, once, at the expected application version (§3.5). One
-- transaction; any refusal rolls back everything. Support confirms the
-- administrator's own access: 'none' (the facility and its staff only) or
-- one of the reviewable roles for the type and product (doctor or nurse for
-- a hospital, clinic or 'other' EHR/Migrate, lab for a laboratory,
-- pharmacist for a pharmacy; preselected by the console, nothing for
-- 'other'), a clinical role only with the administrator's licence recorded
-- (Q2), and how it checked (verification_method). Then: the application
-- records the review (before the role rows, so the review gate reads the
-- organization as reviewed); the restricted role is revoked; org_admin and
-- the clinical role are granted by the reviewer, the clinical one with
-- support's attestation; every session of the administrator is revoked, so
-- the next sign-in carries the new access (S6); two audit rows, the platform
-- one and a system one at the facility. A retry waits on the application's
-- lock, then answers 23505. Refusals, in this order: 42501
-- ADMIN_PERMISSION_DENIED (platform.admin.access, platform.facility.manage
-- and platform.facility.unlock); 22023 SELF_SERVICE_REVIEW_INVALID (note
-- 8-500, role, method); P0002 SELF_SERVICE_FACILITY_NOT_FOUND; 23505
-- SELF_SERVICE_FACILITY_ALREADY_REVIEWED; 40001 version conflict; 22023
-- SELF_SERVICE_REVIEW_ROLE_INVALID, SELF_SERVICE_REVIEW_LICENCE_REQUIRED,
-- SELF_SERVICE_REVIEW_LICENCE_INVALID; 23514
-- SELF_SERVICE_FACILITY_REVIEW_REQUIRES_ACTIVE (the facility suspended, the
-- account disabled, the membership missing or not holding the restricted
-- role), with nothing written.
create function identity.admin_review_self_service_facility(
  target_application_id uuid,
  expected_version bigint,
  review_note text,
  requested_role text,
  requested_method text,
  administrator_licence_body text,
  administrator_licence_number text
) returns table (
  application_id uuid,
  reviewed_at timestamptz,
  row_version bigint,
  granted_role text,
  sessions_revoked integer
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.self_service_unlock_actor();
  note text := btrim(coalesce(review_note, ''));
  current_row identity.organization_applications%rowtype;
  normalized_number text;
  member identity.staff_facility_memberships%rowtype;
  revoked_sessions integer;
  observed timestamptz;
begin
  if target_application_id is null or expected_version is null
     or length(note) not between 8 and 500
     or requested_role is null
     or requested_method is null
     or requested_method not in ('cac_registered_contact', 'officer_match', 'regulator_register', 'in_person', 'other') then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_REVIEW_INVALID';
  end if;

  select * into current_row
    from identity.organization_applications app
   where app.id = target_application_id
   for no key update;
  if not found
     or current_row.approval_mode <> 'self_service'
     or current_row.status <> 'approved'
     or current_row.reviewed_by_account_id is not null then
    raise exception using errcode = 'P0002', message = 'SELF_SERVICE_FACILITY_NOT_FOUND';
  end if;
  if current_row.self_service_reviewed_at is not null then
    raise exception using errcode = '23505', message = 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED';
  end if;
  if current_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;
  normalized_number := identity.self_service_review_licence(current_row, requested_role,
    administrator_licence_body, administrator_licence_number);
  member := identity.lock_self_service_administrator(current_row, 'org_admin_awaiting_review');

  observed := clock_timestamp();
  update identity.organization_applications app
     set self_service_reviewed_at = observed,
         self_service_reviewed_by_account_id = actor_account,
         self_service_review_note = note,
         self_service_granted_role = requested_role,
         self_service_verification_method = requested_method,
         updated_at = observed,
         row_version = app.row_version + 1
   where app.id = current_row.id
   returning app.* into current_row;
  update auth.account_roles assignment
     set revoked_at = observed, revoked_by = actor_account,
         revocation_reason = 'Facility reviewed by platform support',
         row_version = assignment.row_version + 1
   where assignment.membership_id = member.id
     and assignment.role_code = 'org_admin_awaiting_review'
     and assignment.revoked_at is null;
  insert into auth.account_roles (
    id, account_id, role_code, scope_type, membership_id, facility_id, granted_by, grant_reason
  ) values (
    gen_random_uuid(), member.account_id, 'org_admin', 'facility', member.id, member.facility_id,
    actor_account, 'Facility reviewed by platform support'
  );
  if requested_role <> 'none' then
    perform identity.grant_self_service_administrator_role(current_row, member, requested_role,
      administrator_licence_body, normalized_number, actor_account, 'Facility reviewed by platform support');
  end if;
  update identity.staff_facility_memberships membership
     set updated_at = observed, row_version = membership.row_version + 1
   where membership.id = member.id;
  update auth.sessions session_row
     set revoked_at = observed, revocation_reason = 'facility_reviewed',
         row_version = session_row.row_version + 1
   where session_row.account_id = member.account_id and session_row.revoked_at is null;
  get diagnostics revoked_sessions = row_count;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
    resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
    'admin.self-service-facility.review', 'success',
    'organization-application', current_row.id::text, 'healthcare-operations', note,
    'application', 'identity-api',
    jsonb_build_object('productCode', current_row.product_code,
      'organizationId', current_row.organization_id, 'facilityId', current_row.facility_id,
      'administratorAccountId', current_row.first_admin_account_id,
      'version', current_row.row_version, 'grantedRole', requested_role,
      'verificationMethod', requested_method, 'licenceBody', administrator_licence_body,
      'membershipId', member.id, 'sessionsRevoked', revoked_sessions)
  );
  insert into audit.events (
    correlation_id, actor_type, organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system', current_row.organization_id, current_row.facility_id,
    'identity.facility-access.unlock', 'success', 'organization-application', current_row.id::text,
    'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('applicationId', current_row.id,
      'grantedRoles', case when requested_role = 'none' then jsonb_build_array('org_admin')
        else jsonb_build_array('org_admin', requested_role) end)
  );

  return query select current_row.id, current_row.self_service_reviewed_at, current_row.row_version,
    requested_role, revoked_sessions;
end;
$$;

-- R2: support's release of a fraudulent self sign-up. Suspending the
-- facility and disabling the administrator (the existing commands) stop the
-- impostor but leave the CAC bound, its product registered, the application
-- approved and the organization holding the company's legal name, so the real
-- company could not sign up, nor be approved by review, without a database
-- fix. Once every facility of the organization is inactive and the
-- administrator's account is disabled (otherwise 23514
-- SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION), the release, in one
-- transaction:
--   * closes the application (rejected, with the release time, the
--     releasing administrator and the reason; activated_at is kept);
--   * removes its CAC binding and suspends the organization's products;
--   * deactivates the organization and renames it 'Released self sign-up
--     <id>', so the case-insensitive legal-name checks of activation and of
--     governed approval no longer match it (the application keeps the
--     verified legal name);
--   * revokes the facility roles held in the organization, ends its
--     memberships and deactivates the administrator's staff record;
--   * audits admin.self-service-facility.release as the platform administrator.
-- Refusals, in this order: 42501 ADMIN_PERMISSION_DENIED; 22023
-- SELF_SERVICE_RELEASE_INVALID (NULL id or version, reason not 8-500
-- characters); P0002 SELF_SERVICE_FACILITY_NOT_FOUND (not an activated
-- self-service application); 23505 SELF_SERVICE_FACILITY_ALREADY_RELEASED;
-- 40001 version conflict; 23514 SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION.
-- Unless support lets the applicant retry (allow_retry, for a sign-up that
-- named the right company with the wrong email), the released application's
-- email and network may not open a new application for its CAC and product
-- for 7 days (R3, self_service_refusal_ends_at; the waive command lifts it).
-- P4b (§3.11): the release also revokes the organization's pending
-- invitations (locked in id order right after the application, before the
-- CAC lock), ends the memberships before it revokes their roles (S14.4),
-- revokes every active consent grant of them (one system audit row each,
-- identity.consent-grant.close) and expires their pending access requests
-- (S7), and revokes the staff sessions of every account left with no active
-- membership; the audit gains the counts.
-- Lock order: the application, then the pending invitations, then the CAC's
-- 'org-cac:' lock, then the binding, products and organization, the
-- memberships, the role rows, the grants and requests, the sessions and the
-- staff record.
create function identity.admin_release_self_service_facility(
  target_application_id uuid,
  expected_version bigint,
  release_reason text,
  allow_retry boolean default false
) returns table (
  application_id uuid,
  released_at timestamptz,
  row_version bigint
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  reason text := btrim(coalesce(release_reason, ''));
  current_row identity.organization_applications%rowtype;
  released timestamptz;
  ended_memberships uuid[];
  revoked_invitations integer;
  revoked_grants integer := 0;
  expired_requests integer;
  revoked_sessions integer;
  closed record;
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or not auth.account_has_platform_permission(actor_account, 'platform.facility.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if target_application_id is null or expected_version is null or allow_retry is null
     or length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_RELEASE_INVALID';
  end if;

  select * into current_row
    from identity.organization_applications app
   where app.id = target_application_id
   for update;
  if not found
     or current_row.approval_mode <> 'self_service'
     or current_row.organization_id is null
     or current_row.reviewed_by_account_id is not null
     or (current_row.status <> 'approved' and current_row.self_service_released_at is null) then
    raise exception using errcode = 'P0002', message = 'SELF_SERVICE_FACILITY_NOT_FOUND';
  end if;
  if current_row.self_service_released_at is not null then
    raise exception using errcode = '23505', message = 'SELF_SERVICE_FACILITY_ALREADY_RELEASED';
  end if;
  if current_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;
  if exists (select 1 from identity.facilities facility
              where facility.organization_id = current_row.organization_id and facility.active)
     or not exists (select 1 from auth.accounts account
                     where account.id = current_row.first_admin_account_id
                       and account.status in ('disabled', 'deleted')) then
    raise exception using errcode = '23514', message = 'SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION';
  end if;
  released := clock_timestamp();

  -- P4b (FEA R1): the organization's pending invitations, locked in id order
  -- before the CAC lock, are revoked; their open sessions end.
  perform 1 from identity.staff_invitations invitation
   where invitation.organization_id = current_row.organization_id and invitation.status = 'pending'
   order by invitation.id
   for update;
  update identity.staff_invitations invitation
     set status = 'revoked', revoked_at = released, revoked_by_account_id = actor_account, revoke_kind = 'release',
         session_hmac = null, session_expires_at = null, session_account_case = null,
         session_account_id = null, session_account_row_version = null, session_account_token_version = null,
         updated_at = released, row_version = invitation.row_version + 1
   where invitation.organization_id = current_row.organization_id and invitation.status = 'pending';
  get diagnostics revoked_invitations = row_count;

  perform pg_advisory_xact_lock(hashtextextended('org-cac:' || current_row.cac_registration_number, 0));
  delete from identity.organization_cac_registrations binding
   where binding.cac_registration_number = current_row.cac_registration_number
     and binding.organization_id = current_row.organization_id;
  update identity.organization_products product
     set status = 'suspended', updated_at = clock_timestamp()
   where product.organization_id = current_row.organization_id
     and product.status <> 'suspended';
  update identity.organizations organization
     set name = 'Released self sign-up ' || replace(organization.id::text, '-', ''),
         active = false,
         updated_at = clock_timestamp(),
         row_version = organization.row_version + 1
   where organization.id = current_row.organization_id;
  -- P4b (S14.4): the memberships end first, then their roles are revoked.
  with ended as (
    update identity.staff_facility_memberships membership
       set active = false, updated_at = released, row_version = membership.row_version + 1
     where membership.organization_id = current_row.organization_id
       and membership.active
    returning membership.id
  )
  select coalesce(array_agg(ended.id order by ended.id), array[]::uuid[]) into ended_memberships from ended;
  update auth.account_roles assignment
     set revoked_at = clock_timestamp(),
         revoked_by = actor_account,
         revocation_reason = 'Self-service sign-up released by platform support',
         row_version = assignment.row_version + 1
   where assignment.revoked_at is null
     and assignment.scope_type = 'facility'
     and (assignment.facility_id in (select facility.id from identity.facilities facility
                                      where facility.organization_id = current_row.organization_id)
       or assignment.membership_id = any(ended_memberships));
  -- P4b (S7): every active consent grant of the organization's memberships is
  -- revoked, one system audit row each (V2), and every pending access request
  -- expires.
  for closed in
    update identity.consent_grants grant_row
       set status = 'revoked', revoked_at = released, revoked_by = actor_account,
           revoked_reason = 'Facility sign-up released by platform support',
           updated_at = released, row_version = grant_row.row_version + 1
     where grant_row.status = 'active'
       and grant_row.membership_id in (select membership.id from identity.staff_facility_memberships membership
                                        where membership.organization_id = current_row.organization_id)
    returning grant_row.id, grant_row.patient_id, grant_row.facility_id
  loop
    revoked_grants := revoked_grants + 1;
    insert into audit.events (
      correlation_id, actor_type, organization_id, facility_id, patient_id, action, outcome,
      resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details
    ) values (
      platform.current_correlation_id(), 'system', current_row.organization_id, closed.facility_id,
      closed.patient_id, 'identity.consent-grant.close', 'success', 'consent-grant', closed.id::text,
      'healthcare-operations', 'Facility sign-up released by platform support', 'application', 'identity-api',
      jsonb_build_object('existing_closure', false, 'applicationId', current_row.id)
    );
  end loop;
  update identity.access_requests request
     set status = 'expired', updated_at = released, row_version = request.row_version + 1
   where request.status = 'pending'
     and request.membership_id in (select membership.id from identity.staff_facility_memberships membership
                                    where membership.organization_id = current_row.organization_id);
  get diagnostics expired_requests = row_count;
  -- P4b: the staff sessions of every account left with no active membership.
  update auth.sessions session_row
     set revoked_at = released, revocation_reason = 'facility_sign_up_released',
         row_version = session_row.row_version + 1
   where session_row.revoked_at is null
     and session_row.session_kind = 'staff'
     and session_row.account_id in (
       select membership.account_id from identity.staff_facility_memberships membership
        where membership.id = any(ended_memberships))
     and not exists (select 1 from identity.staff_facility_memberships other
                      where other.account_id = session_row.account_id and other.active);
  get diagnostics revoked_sessions = row_count;
  update identity.staff staff
     set active = false, updated_at = clock_timestamp(), row_version = staff.row_version + 1
   where staff.account_id = current_row.first_admin_account_id
     and staff.active;

  update identity.organization_applications app
     set status = 'rejected',
         review_reason = 'Self-service sign-up released by platform support',
         self_service_released_at = released,
         self_service_released_by_account_id = actor_account,
         self_service_release_reason = reason,
         self_service_refusal_ends_at = case when allow_retry then null else released + interval '7 days' end,
         updated_at = released,
         row_version = app.row_version + 1
   where app.id = current_row.id
   returning app.* into current_row;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
    resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
    'admin.self-service-facility.release', 'success',
    'organization-application', current_row.id::text, 'healthcare-operations', reason,
    'application', 'identity-api',
    jsonb_build_object('productCode', current_row.product_code,
      'organizationId', current_row.organization_id, 'facilityId', current_row.facility_id,
      'administratorAccountId', current_row.first_admin_account_id,
      'allowRetry', allow_retry, 'version', current_row.row_version,
      'revokedInvitations', revoked_invitations, 'endedMemberships', cardinality(ended_memberships),
      'revokedGrants', revoked_grants, 'expiredRequests', expired_requests,
      'revokedSessions', revoked_sessions)
  );

  return query select current_row.id, current_row.self_service_released_at, current_row.row_version;
end;
$$;

-- R3: support's view of open self-service applications (submitted, not yet
-- activated or lapsed), at most 200. An application holds its CAC and product
-- for 24 hours (none when it was opened without a hold), and one opened by a
-- stranger blocks the real company until then, so support can see who holds
-- which CAC and close it. The rows that block someone now come first: those
-- still holding their CAC (holds_cac), then, within each group, verified ones
-- (a made-up CAC number never verifies), then the newest. A stale row holds
-- nothing (anyone else's submit lapses it) but may still be activated by its
-- holder, so it is listed after them. total_count is the number of open rows
-- that match, beyond the 200 shown. requested_cac_number (optional, spaces
-- removed, upper case; a malformed one raises 22023) lists only that CAC
-- number's open applications, for a company that says its sign-up is blocked.
-- email_verified says whether a code sent to the administrator email was ever
-- confirmed for it.
create function identity.admin_list_open_self_service_applications(requested_cac_number text default null)
returns table (
  application_id uuid,
  row_version bigint,
  product_code text,
  organization_type text,
  cac_hint text,
  organization_name text,
  administrator_name text,
  administrator_email text,
  application_status text,
  verification_result text,
  email_verified boolean,
  submitted_at timestamptz,
  lapses_at timestamptz,
  holds_cac boolean,
  total_count bigint
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  observed_at timestamptz := clock_timestamp();
  cac_filter text := case when requested_cac_number is null then null
    else upper(regexp_replace(requested_cac_number, '[[:space:]]+', '', 'g')) end;
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(actor_account, 'platform.identity-review.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if cac_filter is not null and cac_filter !~ '^(RC|BN|IT)[0-9]{4,20}$' then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_APPLICATION_FILTER_INVALID';
  end if;
  return query
    select listed.id, listed.row_version, listed.product_code, listed.organization_type,
      left(listed.cac_registration_number, 2)
        || repeat('*', length(listed.cac_registration_number) - 4)
        || right(listed.cac_registration_number, 2),
      listed.verified_organization_name, listed.administrator_name, listed.administrator_email,
      listed.status, listed.verification_result,
      exists (select 1 from identity.organization_profile_completion_challenges challenge
               where challenge.application_id = listed.id and challenge.consumed_at is not null),
      listed.created_at, listed.lapses_at, listed.lapses_at > observed_at,
      count(*) over ()
    from (
      select app.*, case when app.self_service_without_hold then app.created_at
          else app.created_at + interval '24 hours' end as lapses_at
        from identity.organization_applications app
       where app.approval_mode = 'self_service'
         and app.status in ('pending_verification', 'ready_for_review')
         and (cac_filter is null or app.cac_registration_number = cac_filter)
    ) listed
    order by listed.lapses_at > observed_at desc, listed.status = 'ready_for_review' desc,
      listed.created_at desc, listed.id desc
    limit 200;
end;
$$;

-- R3: support closes an open self-service application (rejected, with the
-- time, the reviewing administrator and the reason), ends its codes and
-- sessions and audits admin.self-service-application.reject as the platform
-- administrator. Unless support lets the applicant retry (allow_retry, for
-- the applicant's own mistake such as a mistyped email), its email and
-- network may then not open a new application for the CAC and product for 7
-- days (self_service_refusal_ends_at); identity.admin_waive_self_service_refusals
-- lifts that refusal later. Either way a new application from that email or
-- network within 7 days is opened without a hold. Refusals, in this order:
-- 42501 ADMIN_PERMISSION_DENIED; 22023 SELF_SERVICE_REJECT_INVALID; P0002
-- SELF_SERVICE_APPLICATION_NOT_FOUND (no such open self-service application);
-- 40001 version conflict. Lock order as the lapse: the sessions, then the
-- application, then the other challenges.
create function identity.admin_reject_self_service_application(
  target_application_id uuid,
  expected_version bigint,
  reject_reason text,
  allow_retry boolean default false
) returns table (
  application_id uuid,
  rejected_at timestamptz,
  row_version bigint
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  reason text := btrim(coalesce(reject_reason, ''));
  current_row identity.organization_applications%rowtype;
  previous_status text;
  closed_at timestamptz;
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or not auth.account_has_platform_permission(actor_account, 'platform.facility.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if target_application_id is null or expected_version is null or allow_retry is null
     or length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_REJECT_INVALID';
  end if;

  perform 1 from identity.organization_profile_completion_challenges challenge
   where challenge.application_id = target_application_id
     and challenge.session_hmac is not null
     and challenge.invalidated_at is null
   order by challenge.id
   for update;
  select * into current_row
    from identity.organization_applications app
   where app.id = target_application_id
   for update;
  if not found
     or current_row.approval_mode <> 'self_service'
     or current_row.status not in ('pending_verification', 'ready_for_review') then
    raise exception using errcode = 'P0002', message = 'SELF_SERVICE_APPLICATION_NOT_FOUND';
  end if;
  if current_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;
  previous_status := current_row.status;
  closed_at := clock_timestamp();

  update identity.organization_applications app
     set status = 'rejected',
         reviewed_at = closed_at,
         reviewed_by_account_id = actor_account,
         review_reason = reason,
         self_service_refusal_ends_at = case when allow_retry then null else closed_at + interval '7 days' end,
         updated_at = closed_at,
         row_version = app.row_version + 1
   where app.id = current_row.id
   returning app.* into current_row;
  update identity.organization_profile_completion_challenges challenge
     set invalidated_at = clock_timestamp()
   where challenge.application_id = current_row.id
     and challenge.invalidated_at is null;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
    resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
    'admin.self-service-application.reject', 'success',
    'organization-application', current_row.id::text, 'healthcare-operations', reason,
    'application', 'identity-api',
    jsonb_build_object('productCode', current_row.product_code, 'previousStatus', previous_status,
      'allowRetry', allow_retry, 'version', current_row.row_version)
  );

  return query select current_row.id, current_row.reviewed_at, current_row.row_version;
end;
$$;

-- R3: support lifts the 7-day refusal for a CAC number and product, for a
-- company whose own email or network a rejection or release refused (an
-- employee's sign-up, a mistake support rejected as abuse). Every closed
-- self-service application of that CAC number and product whose refusal is
-- still in force has it lifted (self_service_refusal_ends_at set to NULL, the
-- version bumped), each audited admin.self-service-application.refusal-waive
-- as the platform administrator with the reason. A new application from
-- their email or network within 7 days is still opened without a hold.
-- Permission and context as the rejection. Refusals, in this order: 42501
-- ADMIN_PERMISSION_DENIED; 22023 SELF_SERVICE_WAIVE_INVALID (a malformed CAC
-- number, an unknown product, a reason not 8-500 characters); P0002
-- SELF_SERVICE_REFUSAL_NOT_FOUND (no refusal in force for them). It takes the
-- CAC number and product's 'org-application:' lock, as the submits do.
create function identity.admin_waive_self_service_refusals(
  requested_cac_number text,
  requested_product text,
  waive_reason text
) returns table (
  application_id uuid,
  waived_at timestamptz,
  row_version bigint
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  normalized_cac text := upper(regexp_replace(coalesce(requested_cac_number, ''), '[[:space:]]+', '', 'g'));
  reason text := btrim(coalesce(waive_reason, ''));
  waived identity.organization_applications%rowtype;
  waived_count integer := 0;
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or not auth.account_has_platform_permission(actor_account, 'platform.facility.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if normalized_cac !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or requested_product is null
     or requested_product not in ('ehr', 'migrate', 'laboratory', 'pharmacy')
     or length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_WAIVE_INVALID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('org-application:' || normalized_cac || ':' || requested_product, 0)
  );

  for waived in
    update identity.organization_applications app
       set self_service_refusal_ends_at = null,
           updated_at = clock_timestamp(),
           row_version = app.row_version + 1
     where app.cac_registration_number = normalized_cac
       and app.product_code = requested_product
       and app.approval_mode = 'self_service'
       and app.status = 'rejected'
       and app.self_service_refusal_ends_at > clock_timestamp()
    returning app.*
  loop
    waived_count := waived_count + 1;
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
      resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details
    ) values (
      platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
      'admin.self-service-application.refusal-waive', 'success',
      'organization-application', waived.id::text, 'healthcare-operations', reason,
      'application', 'identity-api',
      jsonb_build_object('productCode', waived.product_code, 'version', waived.row_version)
    );
    application_id := waived.id;
    waived_at := waived.updated_at;
    row_version := waived.row_version;
    return next;
  end loop;
  if waived_count = 0 then
    raise exception using errcode = 'P0002', message = 'SELF_SERVICE_REFUSAL_NOT_FOUND';
  end if;
end;
$$;

revoke all on function identity.admin_list_self_service_facilities(text),
  identity.admin_review_self_service_facility(uuid,bigint,text,text,text,text,text),
  identity.admin_release_self_service_facility(uuid,bigint,text,boolean),
  identity.admin_list_open_self_service_applications(text),
  identity.admin_reject_self_service_application(uuid,bigint,text,boolean),
  identity.admin_waive_self_service_refusals(text,text,text)
  from public;

-- 5. Staff access after review and staff invitations (P4b; owner decisions
-- of 2026-10-24/25: "self sign-up should be able to do everything", full
-- access after support's review, the facility vouches for its clinicians'
-- licences, ship together in this one migration). The states of an
-- organization, from its self-service application (approval_mode
-- 'self_service', activated, no human approver):
--   pending   approved and not yet reviewed by support;
--   reviewed  self_service_reviewed_at set;
--   released  self_service_released_at set (support's release, R2);
--   none      every governed or legacy organization: P4b changes nothing for
--             them.
-- No runtime writer can give a facility role at a pending organization other
-- than org_admin_awaiting_review, or any facility role at a released one
-- (the trigger account_roles_review_gate); the restricted role holds no
-- permission that reaches patient data. Every command that writes P4b state,
-- and the trigger, locks the organization's self-service application row
-- first (lock order in docs/MAIN_TO_NOVU_PORT.md and below). Every new table
-- has uuid keys only, forced row-level security with four permissive
-- policies (so its no-mutation trigger fires for every role) and no runtime
-- table privilege: these commands are the only path.

-- 5.1 Attestation texts (append-only). The website fills {name} and
-- {facility}; the database stores the version, never the filled text.
create table identity.staff_attestation_texts (
  version text primary key check (version ~ '^[a-z0-9-]{3,64}$'),
  text text not null check (length(text) between 20 and 1000),
  created_at timestamptz not null default clock_timestamp()
);
alter table identity.staff_attestation_texts enable row level security;
alter table identity.staff_attestation_texts force row level security;
create policy staff_attestation_texts_command_read on identity.staff_attestation_texts
  for select using (true);
create policy staff_attestation_texts_command_insert on identity.staff_attestation_texts
  for insert with check (true);
create policy staff_attestation_texts_command_update on identity.staff_attestation_texts
  for update using (true) with check (true);
create policy staff_attestation_texts_command_delete on identity.staff_attestation_texts
  for delete using (true);
revoke all on identity.staff_attestation_texts from public;
insert into identity.staff_attestation_texts (version, text) values
  ('facility-staff-attestation-v1',
   'I confirm that {name} works at {facility} and, for a clinical role, that I have seen their current practising licence with the number entered above. Health ID records this confirmation with my name, and Health ID support may check it.'),
  ('platform-review-v1',
   'Health ID support recorded this licence when it reviewed the facility.');
create trigger staff_attestation_texts_no_mutation
  before update or delete on identity.staff_attestation_texts
  for each row execute function platform.reject_mutation();

-- 5.2 The restricted role and the review permission. Without ON CONFLICT: a
-- row that already exists stops the release (preflight PF1). The restricted
-- role's six permissions are all org_admin's; none reaches patient data.
insert into auth.roles (code, description) values
  ('org_admin_awaiting_review',
   'Facility-scoped administrator of a self-signed-up facility until platform support reviews it');
insert into auth.role_permissions (role_code, permission_code) values
  ('org_admin_awaiting_review', 'workforce.manage'),
  ('org_admin_awaiting_review', 'audit.read'),
  ('org_admin_awaiting_review', 'outreach.registration.read'),
  ('org_admin_awaiting_review', 'outreach.registration.write'),
  ('org_admin_awaiting_review', 'outreach.campaign.read'),
  ('org_admin_awaiting_review', 'outreach.campaign.write');
insert into auth.permissions (code, description) values
  ('platform.facility.unlock',
   'Give a reviewed self-signed-up facility clinical access and change its administrator''s clinical role');
insert into auth.role_permissions (role_code, permission_code) values
  ('platform_admin', 'platform.facility.unlock'),
  ('platform_super_admin', 'platform.facility.unlock'),
  ('facility_review_admin', 'platform.facility.unlock');

-- 5.3 Vocabulary (immutable, owner-only).
-- The administrator's reviewable clinical roles (besides 'none') and the
-- preselected one, by organization type and product.
create function identity.self_service_reviewable_roles(target_organization_type text, target_product_code text)
returns text[]
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case
    when target_organization_type in ('hospital', 'clinic') then array['doctor', 'nurse']
    when target_organization_type = 'laboratory' then array['lab']
    when target_organization_type = 'pharmacy' then array['pharmacist']
    when target_organization_type = 'other' and target_product_code in ('ehr', 'migrate') then array['doctor', 'nurse']
    when target_organization_type = 'other' and target_product_code = 'laboratory' then array['lab']
    when target_organization_type = 'other' and target_product_code = 'pharmacy' then array['pharmacist']
    else array[]::text[]
  end
$$;

create function identity.self_service_administrator_role(target_organization_type text, target_product_code text)
returns text
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case
    when target_organization_type in ('hospital', 'clinic') then 'doctor'
    when target_organization_type = 'laboratory' then 'lab'
    when target_organization_type = 'pharmacy' then 'pharmacist'
    else null
  end
$$;

-- The roles a reviewed facility may invite, by organization type and product:
-- never admin, org_admin, clinician or a platform role.
create function identity.staff_invitable_roles(target_organization_type text, target_product_code text)
returns text[]
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case
    when target_organization_type in ('hospital', 'clinic')
      or (target_organization_type = 'other' and target_product_code in ('ehr', 'migrate'))
      then array['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist']
    when target_organization_type = 'laboratory'
      or (target_organization_type = 'other' and target_product_code = 'laboratory')
      then array['lab', 'receptionist']
    when target_organization_type = 'pharmacy'
      or (target_organization_type = 'other' and target_product_code = 'pharmacy')
      then array['pharmacist', 'receptionist']
    else array[]::text[]
  end
$$;

-- The licence body each role needs; NULL for a receptionist (no licence).
create function identity.staff_role_licence_body(target_role text)
returns text
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case target_role
    when 'doctor' then 'MDCN'
    when 'nurse' then 'NMCN'
    when 'lab' then 'MLSCN'
    when 'pharmacist' then 'PCN'
    else null
  end
$$;

-- A licence number as stored: upper case, whitespace collapsed to single
-- spaces, trimmed. The stored pattern is main 0098's.
create function identity.normalize_licence_number(target_number text)
returns text
language sql immutable strict parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select btrim(regexp_replace(upper(target_number), '[[:space:]]+', ' ', 'g'))
$$;

create function identity.licence_number_valid(target_number text)
returns boolean
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(target_number ~ '^[A-Z0-9][A-Z0-9/. -]{1,98}[A-Z0-9]$' and target_number !~ '  ', false)
$$;

-- What a facility sees of a licence number: its last four letters or digits.
create function identity.licence_number_hint(target_number text)
returns text
language sql immutable strict parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select right(regexp_replace(upper(target_number), '[^A-Z0-9]', '', 'g'), 4)
$$;

-- main 0098's clinician_licence_key: the body, then the letters and digits of
-- the number without a leading copy of the body code. 'MDCN/12345',
-- 'mdcn 12345' and '12345' are all MDCN:12345.
create function identity.staff_licence_key(target_body text, target_number text)
returns text
language sql immutable strict parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select target_body || ':' || case
    when left(compact.value, length(target_body)) = target_body then substr(compact.value, length(target_body) + 1)
    else compact.value end
  from (select regexp_replace(upper(target_number), '[^A-Z0-9]', '', 'g') as value) compact
$$;

-- Invitation limits; the first 30 days after review lower the daily ones.
create function identity.staff_invitation_limits(on_probation boolean)
returns table (
  pending_limit integer,
  invitations_per_day integer,
  emails_per_day integer,
  recipient_invitations_per_30_days integer,
  recipient_emails_per_30_days integer,
  recipient_emails_per_day_all_facilities integer,
  delivery_failures_pause integer,
  sends_per_invitation integer,
  resend_cooldown_seconds integer,
  validity_days integer
)
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select 100, case when on_probation then 10 else 30 end, case when on_probation then 20 else 60 end,
    3, 8, 5, 10, 5, 60, 7
$$;

revoke all on function identity.self_service_reviewable_roles(text,text),
  identity.self_service_administrator_role(text,text),
  identity.staff_invitable_roles(text,text),
  identity.staff_role_licence_body(text),
  identity.normalize_licence_number(text),
  identity.licence_number_valid(text),
  identity.licence_number_hint(text),
  identity.staff_licence_key(text,text),
  identity.staff_invitation_limits(boolean)
  from public;

-- 5.4 State. The organization's self-service application (at most one row,
-- the newest activation): granted to the Identity runtime, whose staff
-- context reads it per membership (it cannot read the table). No row for a
-- governed or legacy organization.
create function identity.organization_self_service_state(target_organization_id uuid)
returns table (review_state text, organization_type text, product_code text)
language sql stable security definer
set search_path = pg_catalog, identity, pg_temp
as $$
  select case when application.self_service_released_at is not null then 'released'
              when application.self_service_reviewed_at is not null then 'reviewed'
              else 'pending' end,
    application.organization_type, application.product_code
    from identity.organization_applications application
   where application.organization_id = target_organization_id
     and application.approval_mode = 'self_service'
     and application.reviewed_by_account_id is null
     and (application.status = 'approved' or application.self_service_released_at is not null)
   order by application.reviewed_at desc, application.id desc
   limit 1
$$;

create function identity.facility_self_service_state(target_facility_id uuid)
returns text
language sql stable
set search_path = pg_catalog, identity, pg_temp
as $$
  select state.review_state
    from identity.facilities facility
    cross join lateral identity.organization_self_service_state(facility.organization_id) state
   where facility.id = target_facility_id
$$;

-- The same row, locked FOR SHARE (row locks need a volatile function). A
-- transaction that already holds it in any mode is not blocked; release's
-- FOR UPDATE and review's FOR NO KEY UPDATE block it, so every P4b writer
-- serializes behind them. Returns NULL fields when there is none.
create function identity.lock_self_service_application(target_organization_id uuid)
returns identity.organization_applications
language plpgsql volatile
set search_path = pg_catalog, identity, pg_temp
as $$
declare
  locked identity.organization_applications%rowtype;
begin
  select application.* into locked
    from identity.organization_applications application
   where application.organization_id = target_organization_id
     and application.approval_mode = 'self_service'
     and application.reviewed_by_account_id is null
     and (application.status = 'approved' or application.self_service_released_at is not null)
   order by application.reviewed_at desc, application.id desc
   limit 1
   for share;
  return locked;
end;
$$;

create function identity.self_service_review_state(application identity.organization_applications)
returns text
language sql immutable
set search_path = pg_catalog, pg_temp
as $$
  select case when application.id is null then null
              when application.self_service_released_at is not null then 'released'
              when application.self_service_reviewed_at is not null then 'reviewed'
              else 'pending' end
$$;

-- The first 30 days after review: reviewed, not released, less than 30 days
-- since the review, and support has not ended them early.
create function identity.self_service_on_probation(target_facility_id uuid)
returns boolean
language sql stable
set search_path = pg_catalog, identity, pg_temp
as $$
  select exists (
    select 1
      from identity.facilities facility
      join identity.organization_applications application
        on application.organization_id = facility.organization_id
     where facility.id = target_facility_id
       and application.approval_mode = 'self_service'
       and application.reviewed_by_account_id is null
       and application.status = 'approved'
       and application.self_service_released_at is null
       and application.self_service_reviewed_at is not null
       and application.self_service_probation_ended_at is null
       and clock_timestamp() < application.self_service_reviewed_at + interval '30 days'
  )
$$;

revoke all on function identity.organization_self_service_state(uuid),
  identity.facility_self_service_state(uuid),
  identity.lock_self_service_application(uuid),
  identity.self_service_review_state(identity.organization_applications),
  identity.self_service_on_probation(uuid)
  from public;

-- 5.5 The review gate (G2). At a pending organization only
-- org_admin_awaiting_review may be active; at a released one no facility
-- role; the restricted role only at a pending one. A revocation, and every
-- platform-scope row, passes at once. It reads the state under the
-- application's FOR SHARE lock, so a review or release in flight finishes
-- first. No runtime writer can bypass it; the database owner could disable
-- it, which preflight and the production proofs check (tgenabled 'O').
create function identity.enforce_review_before_facility_role()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, identity, auth, pg_temp
as $$
declare
  target_organization uuid;
  locked identity.organization_applications%rowtype;
  state text;
begin
  if new.scope_type is distinct from 'facility' or new.revoked_at is not null then
    return new;
  end if;
  select facility.organization_id into target_organization
    from identity.facilities facility
   where facility.id = new.facility_id;
  if target_organization is not null then
    locked := identity.lock_self_service_application(target_organization);
    state := identity.self_service_review_state(locked);
  end if;
  if state = 'released' then
    raise exception using errcode = 'P0001', message = 'FACILITY_RELEASED';
  end if;
  if state = 'pending' and new.role_code is distinct from 'org_admin_awaiting_review' then
    raise exception using errcode = 'P0001', message = 'FACILITY_REVIEW_PENDING';
  end if;
  if new.role_code = 'org_admin_awaiting_review' and state is distinct from 'pending' then
    raise exception using errcode = 'P0001', message = 'FACILITY_REVIEW_ROLE_INVALID';
  end if;
  return new;
end;
$$;
revoke all on function identity.enforce_review_before_facility_role() from public;
create trigger account_roles_review_gate
  before insert or update of role_code, scope_type, facility_id, membership_id, revoked_at
  on auth.account_roles
  for each row execute function identity.enforce_review_before_facility_role();

-- 5.6 The first 30 days (Q4): at most 5 break-glass grants per facility in a
-- rolling 24 hours. identity.activate_break_glass is unchanged; a replay
-- reuses its active grant and inserts nothing, so it is never refused. The
-- trigger serializes a facility's activations on a per-facility advisory
-- lock only; it reads the application without its row lock (a review,
-- release or early end racing an activation decides nothing it needs). The
-- trigger itself (consent_grants_self_service_probation) is created in 6.7,
-- after the lock block: creating it takes SHARE ROW EXCLUSIVE on
-- identity.consent_grants, which the previous Identity's break-glass
-- transaction writes after reading platform.control_settings, so it is taken
-- there, with NOWAIT, together with platform.control_settings (V1).
create function identity.enforce_self_service_break_glass_probation()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, identity, pg_temp
as $$
begin
  if new.facility_id is not null and identity.self_service_on_probation(new.facility_id) then
    perform pg_advisory_xact_lock(hashtextextended('break-glass-facility:' || new.facility_id::text, 0));
    if (select count(*) from identity.consent_grants recent
         where recent.facility_id = new.facility_id
           and recent.break_glass
           and recent.starts_at > clock_timestamp() - interval '24 hours') >= 5 then
      raise exception using errcode = 'P0001', message = 'EMERGENCY_PROBATION_LIMIT';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function identity.enforce_self_service_break_glass_probation() from public;

-- 5.7 Staff invitations. Secrets are stored only as keyed hashes computed by
-- Identity: the link token (link_token_hmac, 256 random bits the inviter
-- never sees), the typed code (email_code_hmac, bound to the email) and the
-- open session (session_hmac). Failed link tokens and typed codes are counted
-- separately (S4): 10 wrong link tokens lock an invitation for its lifetime;
-- 5 wrong typed codes stop typed mode until a resend. An open session is
-- bound to the account case and versions it was computed for (S8).
create table identity.staff_invitations (
  id uuid primary key,
  reference char(8) generated always as (upper(left(replace(id::text, '-', ''), 8))) stored,
  organization_id uuid not null,
  facility_id uuid not null,
  invited_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  invited_by_membership_id uuid not null,
  invitee_name text not null check (
    invitee_name = btrim(invitee_name)
    and length(invitee_name) between 2 and 80
    and invitee_name !~ '  '
    and invitee_name !~ '[[:cntrl:]0-9<>@:/\\"&;=?#%_+*(){}|^~`$!,.\[\]]'),
  invitee_email text not null check (
    invitee_email = lower(btrim(invitee_email))
    and length(invitee_email) between 3 and 254
    and invitee_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  role_code text not null references auth.roles(code) on delete restrict
    check (role_code in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist')),
  licence_body text,
  licence_number text,
  attestation_version text not null references identity.staff_attestation_texts(version) on delete restrict,
  attested_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  link_token_hmac char(64) not null check (link_token_hmac ~ '^[0-9a-f]{64}$'),
  email_code_hmac char(64) not null check (email_code_hmac ~ '^[0-9a-f]{64}$'),
  key_version text not null check (length(key_version) between 1 and 64),
  failed_link_attempts integer not null default 0 check (failed_link_attempts between 0 and 10),
  failed_typed_attempts integer not null default 0 check (failed_typed_attempts between 0 and 5),
  send_count integer not null default 1 check (send_count between 1 and 5),
  last_sent_at timestamptz not null,
  last_send_id uuid not null,
  expires_at timestamptz not null,
  delivery_outcome text not null default 'pending'
    check (delivery_outcome in ('pending', 'accepted', 'definitive_failure', 'unknown')),
  session_hmac char(64) unique check (session_hmac is null or session_hmac ~ '^[0-9a-f]{64}$'),
  session_expires_at timestamptz,
  session_account_case text check (session_account_case is null or session_account_case in ('new', 'dormant_staff')),
  session_account_id uuid references auth.accounts(id) on delete restrict,
  session_account_row_version bigint,
  session_account_token_version bigint,
  accept_attempts integer not null default 0 check (accept_attempts between 0 and 5),
  accepted_at timestamptz,
  accepted_account_id uuid references auth.accounts(id) on delete restrict,
  accepted_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  accepted_account_case text check (accepted_account_case is null
    or accepted_account_case in ('new', 'dormant_staff', 'existing_staff')),
  revoked_at timestamptz,
  revoked_by_account_id uuid references auth.accounts(id) on delete restrict,
  revoke_kind text check (revoke_kind is null or revoke_kind in ('facility', 'release')),
  expired_at timestamptz,
  idempotency_key text not null check (length(idempotency_key) between 16 and 128
    and idempotency_key ~ '^[A-Za-z0-9._:-]+$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  constraint staff_invitations_facility_fk foreign key (facility_id, organization_id)
    references identity.facilities(id, organization_id) on delete restrict,
  constraint staff_invitations_inviter_fk foreign key (invited_by_membership_id, facility_id, invited_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint staff_invitations_id_facility_uq unique (id, facility_id),
  constraint staff_invitations_idempotency_uq unique (invited_by_account_id, facility_id, idempotency_key),
  constraint staff_invitations_licence_ck check (
    (role_code = 'receptionist' and licence_body is null and licence_number is null)
    or (role_code <> 'receptionist'
      and licence_body = identity.staff_role_licence_body(role_code)
      and identity.licence_number_valid(licence_number))),
  constraint staff_invitations_session_ck check (
    (session_hmac is null and session_expires_at is null and session_account_case is null
      and session_account_id is null and session_account_row_version is null
      and session_account_token_version is null)
    or (session_hmac is not null and session_expires_at is not null and status = 'pending'
      and ((session_account_case = 'new' and session_account_id is null
            and session_account_row_version is null and session_account_token_version is null)
        or (session_account_case = 'dormant_staff' and session_account_id is not null
            and session_account_row_version is not null and session_account_token_version is not null)))),
  constraint staff_invitations_accepted_ck check (
    (status = 'accepted' and accepted_at is not null and accepted_account_id is not null
      and accepted_membership_id is not null and accepted_account_case is not null)
    or (status <> 'accepted' and accepted_at is null and accepted_account_id is null
      and accepted_membership_id is null and accepted_account_case is null)),
  constraint staff_invitations_revoked_ck check (
    (status = 'revoked' and revoked_at is not null and revoked_by_account_id is not null and revoke_kind is not null)
    or (status <> 'revoked' and revoked_at is null and revoked_by_account_id is null and revoke_kind is null)),
  constraint staff_invitations_expired_ck check ((status = 'expired') = (expired_at is not null))
);
create unique index staff_invitations_pending_email_uq
  on identity.staff_invitations (facility_id, invitee_email) where status = 'pending';
create index staff_invitations_facility_created_idx on identity.staff_invitations (facility_id, created_at);
create index staff_invitations_pending_email_idx on identity.staff_invitations (invitee_email) where status = 'pending';
create index staff_invitations_pending_organization_idx on identity.staff_invitations (organization_id) where status = 'pending';
create index staff_invitations_reference_idx on identity.staff_invitations (reference);
alter table identity.staff_invitations enable row level security;
alter table identity.staff_invitations force row level security;
create policy staff_invitations_command_read on identity.staff_invitations for select using (true);
create policy staff_invitations_command_insert on identity.staff_invitations for insert with check (true);
create policy staff_invitations_command_update on identity.staff_invitations
  for update using (true) with check (true);
create policy staff_invitations_command_delete on identity.staff_invitations for delete using (true);
revoke all on identity.staff_invitations from public;

-- What the inviter vouched for, who and to whom, never changes once written
-- (S15.3); an invitation is never deleted.
create function identity.guard_staff_invitation_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE'
     or new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.facility_id is distinct from old.facility_id
     or new.invited_by_account_id is distinct from old.invited_by_account_id
     or new.invited_by_membership_id is distinct from old.invited_by_membership_id
     or new.invitee_name is distinct from old.invitee_name
     or new.invitee_email is distinct from old.invitee_email
     or new.role_code is distinct from old.role_code
     or new.licence_body is distinct from old.licence_body
     or new.licence_number is distinct from old.licence_number
     or new.attestation_version is distinct from old.attestation_version
     or new.attested_at is distinct from old.attested_at
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_sha256 is distinct from old.request_sha256
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'STAFF_INVITATION_IMMUTABLE';
  end if;
  return new;
end;
$$;
revoke all on function identity.guard_staff_invitation_mutation() from public;
create trigger staff_invitations_immutable
  before update or delete on identity.staff_invitations
  for each row execute function identity.guard_staff_invitation_mutation();

-- Every email an invitation sent (append-only but for its outcome): the
-- facility, recipient and cross-facility counts read it, an earlier send's
-- hashes answer "superseded" (S4) and a send the cross-facility cap held
-- back is 'suppressed' (never dispatched).
create table identity.staff_invitation_sends (
  id uuid primary key,
  invitation_id uuid not null,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  invitee_email text not null check (invitee_email = lower(btrim(invitee_email))
    and length(invitee_email) between 3 and 254),
  sent_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  kind text not null check (kind in ('invite', 'resend')),
  link_token_hmac char(64) not null check (link_token_hmac ~ '^[0-9a-f]{64}$'),
  email_code_hmac char(64) not null check (email_code_hmac ~ '^[0-9a-f]{64}$'),
  dispatched boolean not null,
  outcome text not null default 'pending'
    check (outcome in ('pending', 'accepted', 'definitive_failure', 'unknown', 'suppressed')),
  sent_at timestamptz not null default clock_timestamp(),
  outcome_at timestamptz,
  constraint staff_invitation_sends_invitation_fk foreign key (invitation_id, facility_id)
    references identity.staff_invitations(id, facility_id) on delete restrict,
  constraint staff_invitation_sends_suppressed_ck check ((outcome = 'suppressed') = (not dispatched)),
  constraint staff_invitation_sends_outcome_ck check ((outcome = 'pending') = (outcome_at is null))
);
create index staff_invitation_sends_facility_idx on identity.staff_invitation_sends (facility_id, sent_at);
create index staff_invitation_sends_recipient_idx on identity.staff_invitation_sends (invitee_email, sent_at);
create index staff_invitation_sends_invitation_idx on identity.staff_invitation_sends (invitation_id, sent_at);
alter table identity.staff_invitation_sends enable row level security;
alter table identity.staff_invitation_sends force row level security;
create policy staff_invitation_sends_command_read on identity.staff_invitation_sends for select using (true);
create policy staff_invitation_sends_command_insert on identity.staff_invitation_sends for insert with check (true);
create policy staff_invitation_sends_command_update on identity.staff_invitation_sends
  for update using (true) with check (true);
create policy staff_invitation_sends_command_delete on identity.staff_invitation_sends for delete using (true);
revoke all on identity.staff_invitation_sends from public;

create function identity.guard_staff_invitation_send_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE'
     or old.outcome <> 'pending'
     or new.outcome not in ('accepted', 'definitive_failure', 'unknown')
     or new.outcome_at is null
     or (new.id, new.invitation_id, new.facility_id, new.invitee_email, new.sent_by_account_id, new.kind,
         new.link_token_hmac, new.email_code_hmac, new.dispatched, new.sent_at)
        is distinct from
        (old.id, old.invitation_id, old.facility_id, old.invitee_email, old.sent_by_account_id, old.kind,
         old.link_token_hmac, old.email_code_hmac, old.dispatched, old.sent_at) then
    raise exception using errcode = '55000', message = 'STAFF_INVITATION_SEND_IMMUTABLE';
  end if;
  return new;
end;
$$;
revoke all on function identity.guard_staff_invitation_send_mutation() from public;
create trigger staff_invitation_sends_outcome_only
  before update or delete on identity.staff_invitation_sends
  for each row execute function identity.guard_staff_invitation_send_mutation();

-- 5.8 Licence attestations (append-only): who vouched for which licence of
-- which person in which role, the facility administrator at an invitation or
-- a role change (facility_attestation) or support at the review
-- (platform_review). identity.staff.license_number is never written (S15.4).
create table identity.staff_licence_attestations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  facility_id uuid not null,
  account_id uuid not null,
  staff_id uuid not null,
  membership_id uuid not null,
  role_code text not null references auth.roles(code) on delete restrict
    check (role_code in ('doctor', 'nurse', 'lab', 'pharmacist')),
  role_grant_id uuid not null references auth.account_roles(id) on delete restrict,
  licence_body text not null,
  licence_number text not null,
  licence_key text generated always as (identity.staff_licence_key(licence_body, licence_number)) stored,
  attested_person_name text not null check (attested_person_name = btrim(attested_person_name)
    and length(attested_person_name) between 2 and 200),
  verification_method text not null check (verification_method in ('facility_attestation', 'platform_review')),
  attested_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  attested_by_membership_id uuid,
  attestation_version text not null references identity.staff_attestation_texts(version) on delete restrict,
  attested_at timestamptz not null,
  invitation_id uuid references identity.staff_invitations(id) on delete restrict,
  review_application_id uuid references identity.organization_applications(id) on delete restrict,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint staff_licence_attestations_facility_fk foreign key (facility_id, organization_id)
    references identity.facilities(id, organization_id) on delete restrict,
  constraint staff_licence_attestations_membership_fk foreign key (membership_id, facility_id, account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint staff_licence_attestations_staff_fk foreign key (staff_id, account_id)
    references identity.staff(id, account_id) on delete restrict,
  constraint staff_licence_attestations_attester_fk
    foreign key (attested_by_membership_id, facility_id, attested_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint staff_licence_attestations_licence_ck check (
    licence_body = identity.staff_role_licence_body(role_code) and identity.licence_number_valid(licence_number)),
  constraint staff_licence_attestations_method_ck check (
    (verification_method = 'facility_attestation' and attested_by_membership_id is not null
      and review_application_id is null)
    or (verification_method = 'platform_review' and attested_by_membership_id is null
      and review_application_id is not null and invitation_id is null))
);
create index staff_licence_attestations_key_idx on identity.staff_licence_attestations (licence_key);
create index staff_licence_attestations_facility_idx on identity.staff_licence_attestations (facility_id, recorded_at);
create index staff_licence_attestations_membership_idx on identity.staff_licence_attestations (membership_id, recorded_at);
alter table identity.staff_licence_attestations enable row level security;
alter table identity.staff_licence_attestations force row level security;
create policy staff_licence_attestations_command_read on identity.staff_licence_attestations
  for select using (true);
create policy staff_licence_attestations_command_insert on identity.staff_licence_attestations
  for insert with check (true);
create policy staff_licence_attestations_command_update on identity.staff_licence_attestations
  for update using (true) with check (true);
create policy staff_licence_attestations_command_delete on identity.staff_licence_attestations
  for delete using (true);
revoke all on identity.staff_licence_attestations from public;
create trigger staff_licence_attestations_no_mutation
  before update or delete on identity.staff_licence_attestations
  for each row execute function platform.reject_mutation();

-- 5.9 Helpers of the staff commands (owner-only).
-- The staff actor: a staff session at its selected facility, holding
-- workforce.manage there (only the administrator does), with a correlation ID
-- and the healthcare-operations purpose; else 42501
-- STAFF_MANAGEMENT_PERMISSION_DENIED. Only at a self-signed-up organization
-- that is pending or reviewed; a governed, legacy or released one answers
-- 42501 STAFF_MANAGEMENT_NOT_AVAILABLE. With lock_application, the
-- organization's application is locked FOR SHARE first (lock order).
create function identity.staff_management_actor(lock_application boolean)
returns table (
  account_id uuid,
  membership_id uuid,
  facility_id uuid,
  organization_id uuid,
  application_id uuid,
  review_state text,
  on_probation boolean,
  organization_type text,
  product_code text,
  facility_name text
)
language plpgsql volatile
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  facility_row identity.facilities%rowtype;
  application identity.organization_applications%rowtype;
  state text;
begin
  if actor_account is null
     or actor_membership is null
     or actor_facility is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'workforce.manage') then
    raise exception using errcode = '42501', message = 'STAFF_MANAGEMENT_PERMISSION_DENIED';
  end if;
  select facility.* into facility_row from identity.facilities facility where facility.id = actor_facility;
  if lock_application then
    application := identity.lock_self_service_application(facility_row.organization_id);
  else
    select candidate.* into application
      from identity.organization_applications candidate
     where candidate.organization_id = facility_row.organization_id
       and candidate.approval_mode = 'self_service'
       and candidate.reviewed_by_account_id is null
       and (candidate.status = 'approved' or candidate.self_service_released_at is not null)
     order by candidate.reviewed_at desc, candidate.id desc
     limit 1;
  end if;
  state := identity.self_service_review_state(application);
  if state is null or state = 'released' then
    raise exception using errcode = '42501', message = 'STAFF_MANAGEMENT_NOT_AVAILABLE';
  end if;
  return query select actor_account, actor_membership, actor_facility, facility_row.organization_id,
    application.id, state, identity.self_service_on_probation(actor_facility),
    application.organization_type, application.product_code, facility_row.name;
end;
$$;

-- The account case of an invited email (S8, FEA R6), one definition for open,
-- prepare and accept. A usable membership is what the staff context resolves:
-- active, not held, its facility and organization active, its staff row
-- active and verified. In order:
--   new             no live account and no staff row with the email;
--   unavailable     a staff row but no live account, or another account's
--                   staff row; the account disabled, locked or suspended;
--                   an account with neither a patient nor a staff row;
--   patient_account the account has a patient row (never converted);
--   unavailable     an active platform role; the staff row inactive or not
--                   verified;
--   already_member  an active membership at this facility;
--   existing_staff  a usable membership, the account active or pending_reset;
--   unavailable     no usable membership and a held one, or an active one at
--                   an inactive facility or organization;
--   dormant_staff   no active and no held membership, the account active or
--                   pending_reset;
--   unavailable     anything else.
create function identity.staff_invitation_account_case(target_email text, target_facility_id uuid)
returns table (
  account_case text,
  account_id uuid,
  account_row_version bigint,
  account_token_version bigint,
  staff_id uuid
)
language plpgsql stable
set search_path = pg_catalog, identity, auth, pg_temp
as $$
declare
  normalized text := lower(btrim(coalesce(target_email, '')));
  account_row auth.accounts%rowtype;
  staff_row identity.staff%rowtype;
  result_case text;
begin
  select account.* into account_row
    from auth.accounts account
   where lower(account.email) = normalized
     and account.email is not null
     and account.status <> 'deleted'
   limit 1;
  if account_row.id is null then
    result_case := case when exists (select 1 from identity.staff staff where lower(staff.email) = normalized)
      then 'unavailable' else 'new' end;
    return query select result_case, null::uuid, null::bigint, null::bigint, null::uuid;
    return;
  end if;
  select staff.* into staff_row from identity.staff staff where staff.account_id = account_row.id;

  if account_row.status in ('disabled', 'locked')
     or account_row.disabled_until > clock_timestamp()
     or exists (select 1 from identity.staff other
                 where lower(other.email) = normalized and other.account_id <> account_row.id)
     or (staff_row.id is null
       and not exists (select 1 from identity.patients patient where patient.account_id = account_row.id)) then
    result_case := 'unavailable';
  elsif exists (select 1 from identity.patients patient where patient.account_id = account_row.id) then
    result_case := 'patient_account';
  elsif exists (select 1 from auth.account_roles assignment
                 where assignment.account_id = account_row.id and assignment.scope_type = 'platform'
                   and assignment.revoked_at is null)
     or not staff_row.active
     or lower(staff_row.verification_status) not in ('verified', 'approved', 'active') then
    result_case := 'unavailable';
  elsif exists (select 1 from identity.staff_facility_memberships membership
                 where membership.staff_id = staff_row.id and membership.account_id = account_row.id
                   and membership.facility_id = target_facility_id and membership.active) then
    result_case := 'already_member';
  elsif account_row.status in ('active', 'pending_reset')
     and exists (select 1 from identity.staff_facility_memberships membership
                   join identity.facilities facility on facility.id = membership.facility_id
                   join identity.organizations organization on organization.id = membership.organization_id
                  where membership.staff_id = staff_row.id and membership.account_id = account_row.id
                    and membership.active and membership.migration_hold_reason is null
                    and facility.organization_id = membership.organization_id
                    and facility.active and organization.active) then
    result_case := 'existing_staff';
  elsif exists (select 1 from identity.staff_facility_memberships membership
                 where membership.staff_id = staff_row.id and membership.migration_hold_reason is not null)
     or exists (select 1 from identity.staff_facility_memberships membership
                  left join identity.facilities facility on facility.id = membership.facility_id
                  left join identity.organizations organization on organization.id = membership.organization_id
                 where membership.staff_id = staff_row.id and membership.active
                   and (facility.active is not true or organization.active is not true)) then
    result_case := 'unavailable';
  elsif account_row.status in ('active', 'pending_reset')
     and not exists (select 1 from identity.staff_facility_memberships membership
                      where membership.staff_id = staff_row.id and membership.active) then
    result_case := 'dormant_staff';
  else
    result_case := 'unavailable';
  end if;
  return query select result_case, account_row.id, account_row.row_version, account_row.token_version, staff_row.id;
end;
$$;

-- Whether a correctly identified invitation can still be accepted: NULL when
-- it can; 'accepted'; 'withdrawn' when revoked, its facility or organization
-- is inactive, the organization is no longer reviewed, or the inviter's
-- membership no longer holds workforce.manage there; 'expired' when expired.
create function identity.staff_invitation_still_valid(invitation identity.staff_invitations)
returns text
language plpgsql stable
set search_path = pg_catalog, identity, auth, pg_temp
as $$
declare
  inviter_subject text;
begin
  if invitation.status = 'accepted' then return 'accepted'; end if;
  if invitation.status = 'revoked' then return 'withdrawn'; end if;
  if invitation.status = 'expired' or invitation.expires_at <= clock_timestamp() then return 'expired'; end if;
  if not exists (select 1 from identity.facilities facility
                   join identity.organizations organization on organization.id = facility.organization_id
                  where facility.id = invitation.facility_id and facility.active and organization.active)
     or identity.facility_self_service_state(invitation.facility_id) is distinct from 'reviewed' then
    return 'withdrawn';
  end if;
  select account.subject into inviter_subject from auth.accounts account
   where account.id = invitation.invited_by_account_id;
  if inviter_subject is null
     or not auth.membership_has_permission(inviter_subject, invitation.invited_by_membership_id,
       invitation.facility_id, 'workforce.manage') then
    return 'withdrawn';
  end if;
  return null;
end;
$$;

-- An accepted invitation's membership, role row and attestation. A person
-- with an ended membership at this facility gets it back (the one whose role
-- is the invited role, else the most recent), its leftover role rows revoked,
-- so invited flows keep one membership row per staff member and facility and
-- staff_memberships_scoped_uq never collides. Returns the membership id.
create function identity.attach_invited_member(
  invitation identity.staff_invitations,
  target_account_id uuid,
  target_staff_id uuid,
  make_primary boolean
) returns uuid
language plpgsql volatile
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  reused identity.staff_facility_memberships%rowtype;
  attached uuid;
  grant_id uuid := gen_random_uuid();
begin
  select membership.* into reused
    from identity.staff_facility_memberships membership
   where membership.staff_id = target_staff_id
     and membership.account_id = target_account_id
     and membership.facility_id = invitation.facility_id
     and not membership.active
     and membership.migration_hold_reason is null
   order by (membership.membership_role = invitation.role_code) desc, membership.updated_at desc, membership.id desc
   limit 1
   for no key update;
  if reused.id is not null then
    attached := reused.id;
    update auth.account_roles assignment
       set revoked_at = clock_timestamp(),
           revoked_by = invitation.invited_by_account_id,
           revocation_reason = 'Membership reused for an accepted staff invitation',
           row_version = assignment.row_version + 1
     where assignment.membership_id = attached
       and assignment.revoked_at is null;
    update identity.staff_facility_memberships membership
       set active = true,
           membership_role = invitation.role_code,
           app_role = invitation.role_code,
           is_primary = make_primary,
           updated_at = clock_timestamp(),
           row_version = membership.row_version + 1
     where membership.id = attached;
  else
    attached := gen_random_uuid();
    insert into identity.staff_facility_memberships (
      id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active, source_system
    ) values (
      attached, target_staff_id, target_account_id, invitation.organization_id, invitation.facility_id,
      invitation.role_code, invitation.role_code, make_primary, true, 'hid'
    );
  end if;
  insert into auth.account_roles (
    id, account_id, role_code, scope_type, membership_id, facility_id, granted_by, grant_reason
  ) values (
    grant_id, target_account_id, invitation.role_code, 'facility', attached, invitation.facility_id,
    invitation.invited_by_account_id, 'Staff invitation accepted; licence vouched by the facility administrator'
  );
  if invitation.role_code <> 'receptionist' then
    insert into identity.staff_licence_attestations (
      organization_id, facility_id, account_id, staff_id, membership_id, role_code, role_grant_id,
      licence_body, licence_number, attested_person_name, verification_method,
      attested_by_account_id, attested_by_membership_id, attestation_version, attested_at,
      invitation_id, correlation_id
    ) values (
      invitation.organization_id, invitation.facility_id, target_account_id, target_staff_id, attached,
      invitation.role_code, grant_id, invitation.licence_body, invitation.licence_number,
      invitation.invitee_name, 'facility_attestation', invitation.invited_by_account_id,
      invitation.invited_by_membership_id, invitation.attestation_version, invitation.attested_at,
      invitation.id, platform.current_correlation_id()
    );
  end if;
  return attached;
end;
$$;

-- Whether an invitation request's fields have their stored shapes, after
-- Identity's normalization (the email trimmed and lower-cased, the licence
-- number normalized).
create function identity.staff_invitation_fields_valid(
  target_name text, target_email text, target_role text, target_body text, target_number text,
  target_attestation_version text
) returns boolean
language sql stable
set search_path = pg_catalog, identity, pg_temp
as $$
  select coalesce(
    target_name = btrim(target_name)
    and length(target_name) between 2 and 80
    and target_name !~ '  '
    and target_name !~ '[[:cntrl:]0-9<>@:/\\"&;=?#%_+*(){}|^~`$!,.\[\]]'
    and target_email = lower(btrim(target_email))
    and length(target_email) between 3 and 254
    and target_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    and target_role in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist')
    and ((target_role = 'receptionist' and target_body is null and target_number is null)
      or (target_role <> 'receptionist'
        and target_body is not distinct from identity.staff_role_licence_body(target_role)
        and identity.licence_number_valid(target_number)))
    and target_attestation_version like 'facility-staff-attestation-%'
    and exists (select 1 from identity.staff_attestation_texts attestation
                 where attestation.version = target_attestation_version),
    false)
$$;

revoke all on function identity.staff_management_actor(boolean),
  identity.staff_invitation_account_case(text,uuid),
  identity.staff_invitation_still_valid(identity.staff_invitations),
  identity.attach_invited_member(identity.staff_invitations,uuid,uuid,boolean),
  identity.staff_invitation_fields_valid(text,text,text,text,text,text)
  from public;

-- 5.10 Staff commands (the facility administrator; EXECUTE to the Identity
-- runtimes). Business refusals raise P0001 with the Identity code as the
-- message; 42501 is permission; P0002 not found; 40001 a version conflict;
-- 22023 invalid input (the message is the code); 55000 from
-- platform.require_control_enabled means closed. Before review every one but
-- the reads and the own licence answers P0001 FACILITY_REVIEW_PENDING (G3).

-- The administrator's own licence before review (S1, Q2): support sees it
-- and grants the clinical role with it. It may be replaced until the review.
create function identity.record_self_service_administrator_licence(
  requested_licence_body text,
  requested_licence_number text
) returns table (licence_body text, number_hint text, recorded_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor record;
  application identity.organization_applications%rowtype;
  normalized_number text := identity.normalize_licence_number(requested_licence_number);
  recorded timestamptz;
begin
  select * into actor from identity.staff_management_actor(false);
  select candidate.* into application
    from identity.organization_applications candidate
   where candidate.id = actor.application_id
   for no key update;
  if identity.self_service_review_state(application) is distinct from 'pending' then
    raise exception using errcode = 'P0001', message = 'FACILITY_ALREADY_REVIEWED';
  end if;
  if application.first_admin_account_id is distinct from actor.account_id then
    raise exception using errcode = 'P0001', message = 'STAFF_MANAGEMENT_NOT_ADMINISTRATOR';
  end if;
  if requested_licence_body is null
     or requested_licence_body not in (
       select identity.staff_role_licence_body(reviewable.role_code)
         from unnest(identity.self_service_reviewable_roles(application.organization_type,
           application.product_code)) as reviewable(role_code))
     or not identity.licence_number_valid(normalized_number) then
    raise exception using errcode = '22023', message = 'ADMINISTRATOR_LICENCE_INVALID';
  end if;
  recorded := clock_timestamp();
  update identity.organization_applications candidate
     set self_service_admin_licence_body = requested_licence_body,
         self_service_admin_licence_number = normalized_number,
         self_service_admin_licence_recorded_at = recorded,
         updated_at = recorded,
         row_version = candidate.row_version + 1
   where candidate.id = application.id;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.account_id,
    actor.membership_id, actor.organization_id, actor.facility_id,
    'identity.facility-administrator-licence.record', 'success', 'organization-application',
    application.id::text, 'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('licenceBody', requested_licence_body)
  );
  return query select requested_licence_body, identity.licence_number_hint(normalized_number), recorded;
end;
$$;

-- The facility's active members (the actor's facility only), with the
-- licence each holds on record: the newest attestation of an unrevoked role
-- row of the membership. Hints only, never full numbers.
create function identity.list_facility_staff()
returns table (
  membership_id uuid,
  row_version bigint,
  account_id uuid,
  display_name text,
  email text,
  roles text[],
  is_administrator boolean,
  is_self boolean,
  joined_at timestamptz,
  licence_body text,
  licence_number_hint text,
  vouched_by_name text,
  vouched_at timestamptz,
  verification_method text
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor record;
begin
  select * into actor from identity.staff_management_actor(false);
  return query
    select membership.id, membership.row_version, membership.account_id,
      coalesce(account.display_name, staff.full_name), coalesce(account.email, staff.email),
      coalesce((select array_agg(assignment.role_code order by assignment.role_code)
                  from auth.account_roles assignment
                 where assignment.membership_id = membership.id and assignment.scope_type = 'facility'
                   and assignment.revoked_at is null), array[]::text[]),
      exists (select 1 from auth.account_roles assignment
               where assignment.membership_id = membership.id and assignment.revoked_at is null
                 and assignment.role_code in ('org_admin', 'org_admin_awaiting_review')),
      membership.account_id = actor.account_id,
      membership.created_at,
      current_licence.licence_body, identity.licence_number_hint(current_licence.licence_number),
      coalesce(attester.display_name, attester.email), current_licence.attested_at,
      current_licence.verification_method
    from identity.staff_facility_memberships membership
    join identity.staff staff on staff.id = membership.staff_id
    join auth.accounts account on account.id = membership.account_id
    left join lateral (
      select attestation.licence_body, attestation.licence_number, attestation.attested_at,
        attestation.verification_method, attestation.attested_by_account_id
        from identity.staff_licence_attestations attestation
        join auth.account_roles grant_row on grant_row.id = attestation.role_grant_id
       where attestation.membership_id = membership.id and grant_row.revoked_at is null
       order by attestation.recorded_at desc, attestation.id desc
       limit 1
    ) current_licence on true
    left join auth.accounts attester on attester.id = current_licence.attested_by_account_id
    where membership.facility_id = actor.facility_id
      and membership.active
    order by membership.created_at, membership.id;
end;
$$;

-- The facility's invitations: pending ones, and the others of the last 30
-- days. A pending one past its expiry reads 'expired'. A send still pending
-- after 5 minutes, or held back by the cross-facility cap, reads 'unknown'.
create function identity.list_facility_staff_invitations()
returns table (
  invitation_id uuid,
  row_version bigint,
  reference text,
  invitee_name text,
  invitee_email text,
  role_code text,
  licence_body text,
  licence_number_hint text,
  status text,
  invited_by_name text,
  created_at timestamptz,
  last_sent_at timestamptz,
  expires_at timestamptz,
  send_count integer,
  delivery_outcome text,
  resend_available_at timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor record;
  observed timestamptz := clock_timestamp();
begin
  select * into actor from identity.staff_management_actor(false);
  return query
    select invitation.id, invitation.row_version, invitation.reference::text, invitation.invitee_name,
      invitation.invitee_email, invitation.role_code, invitation.licence_body,
      identity.licence_number_hint(invitation.licence_number),
      case when invitation.status = 'pending' and invitation.expires_at <= observed then 'expired'
        else invitation.status end,
      coalesce(inviter.display_name, inviter.email), invitation.created_at, invitation.last_sent_at,
      invitation.expires_at, invitation.send_count,
      case when invitation.delivery_outcome = 'pending'
             and invitation.last_sent_at < observed - interval '5 minutes' then 'unknown'
        else invitation.delivery_outcome end,
      invitation.last_sent_at + interval '60 seconds'
    from identity.staff_invitations invitation
    left join auth.accounts inviter on inviter.id = invitation.invited_by_account_id
    where invitation.facility_id = actor.facility_id
      and (invitation.status = 'pending' or invitation.updated_at > observed - interval '30 days')
    order by invitation.created_at desc, invitation.id desc;
end;
$$;

-- What the Staff page needs to know about the facility: its state, the first
-- 30 days, whether invitations are open (the control), the counts behind the
-- limits, the roles it may invite, the attestation text it must show, the
-- administrator's own licence and the licence bodies it may enter. The
-- invitation limits follow, as identity.staff_invitation_limits returns them.
create function identity.facility_staff_management_state()
returns table (
  facility_id uuid,
  facility_name text,
  organization_type text,
  product_code text,
  review_state text,
  on_probation boolean,
  probation_ends_at timestamptz,
  invitations_open boolean,
  pending_count integer,
  invitations_last_day integer,
  emails_last_day integer,
  delivery_paused boolean,
  invitable_roles text[],
  attestation_version text,
  attestation_text text,
  administrator_licence_body text,
  administrator_licence_hint text,
  administrator_licence_recorded_at timestamptz,
  reviewable_licence_bodies text[],
  pending_limit integer,
  invitations_per_day integer,
  emails_per_day integer,
  recipient_invitations_per_30_days integer,
  recipient_emails_per_30_days integer,
  recipient_emails_per_day_all_facilities integer,
  delivery_failures_pause integer,
  sends_per_invitation integer,
  resend_cooldown_seconds integer,
  validity_days integer
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor record;
  application identity.organization_applications%rowtype;
  limits record;
  control_open boolean;
  observed timestamptz := clock_timestamp();
begin
  select * into actor from identity.staff_management_actor(false);
  select candidate.* into application from identity.organization_applications candidate
   where candidate.id = actor.application_id;
  select * into limits from identity.staff_invitation_limits(actor.on_probation);
  begin
    control_open := platform.control_enabled('staff_invitations_enabled');
  exception when others then
    control_open := false;
  end;
  return query
    select actor.facility_id, actor.facility_name, actor.organization_type, actor.product_code,
      actor.review_state, actor.on_probation,
      case when actor.on_probation then application.self_service_reviewed_at + interval '30 days' end,
      control_open,
      (select count(*)::integer from identity.staff_invitations invitation
        where invitation.facility_id = actor.facility_id and invitation.status = 'pending'
          and invitation.expires_at > observed),
      (select count(*)::integer from identity.staff_invitations invitation
        where invitation.facility_id = actor.facility_id
          and invitation.created_at > observed - interval '24 hours'),
      (select count(*)::integer from identity.staff_invitation_sends send
        where send.facility_id = actor.facility_id and send.sent_at > observed - interval '24 hours'),
      (select count(*) from identity.staff_invitation_sends send
        where send.facility_id = actor.facility_id and send.outcome = 'definitive_failure'
          and send.sent_at > observed - interval '24 hours') >= limits.delivery_failures_pause,
      identity.staff_invitable_roles(actor.organization_type, actor.product_code),
      attestation.version, attestation.text,
      application.self_service_admin_licence_body,
      identity.licence_number_hint(application.self_service_admin_licence_number),
      application.self_service_admin_licence_recorded_at,
      (select coalesce(array_agg(identity.staff_role_licence_body(reviewable.role_code)
                         order by reviewable.n), array[]::text[])
         from unnest(identity.self_service_reviewable_roles(actor.organization_type, actor.product_code))
              with ordinality as reviewable(role_code, n)),
      limits.pending_limit, limits.invitations_per_day, limits.emails_per_day,
      limits.recipient_invitations_per_30_days, limits.recipient_emails_per_30_days,
      limits.recipient_emails_per_day_all_facilities, limits.delivery_failures_pause,
      limits.sends_per_invitation, limits.resend_cooldown_seconds, limits.validity_days
    from (select texts.version, texts.text from identity.staff_attestation_texts texts
           where texts.version like 'facility-staff-attestation-%'
           order by texts.created_at desc, texts.version desc limit 1) attestation;
end;
$$;

-- Invite (§4.4). Identity generates the ids, the token and code and their
-- keyed hashes, and the request digest; the database checks every field
-- again. The idempotency key is scoped to the inviter and the facility (S16):
-- the same digest answers the stored invitation (replayed, nothing to send),
-- another digest P0001 IDEMPOTENCY_KEY_REUSED. dispatch is false when the
-- recipient already received 5 invitation emails in 24 hours from any
-- facility (S10.2): the send is recorded 'suppressed' and the facility sees
-- "Delivery not confirmed". The command never reads whether the email has a
-- Health ID account (no patient-email oracle), only whether it is already a
-- member of this facility, which the facility can see anyway.
create function identity.create_staff_invitation(
  requested_invitation_id uuid,
  requested_send_id uuid,
  requested_invitee_name text,
  requested_invitee_email text,
  requested_role text,
  requested_licence_body text,
  requested_licence_number text,
  requested_attestation_version text,
  requested_idempotency_key text,
  requested_request_sha256 char(64),
  requested_link_token_hmac char(64),
  requested_email_code_hmac char(64),
  requested_key_version text
) returns table (
  invitation_id uuid,
  row_version bigint,
  send_id uuid,
  expires_at timestamptz,
  replayed boolean,
  dispatch boolean,
  facility_name text,
  role_code text,
  invitee_email text
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor record;
  limits record;
  normalized_email text := lower(btrim(coalesce(requested_invitee_email, '')));
  normalized_number text := case when requested_licence_number is null then null
    else identity.normalize_licence_number(requested_licence_number) end;
  stored identity.staff_invitations%rowtype;
  actor_email text;
  observed timestamptz;
  will_dispatch boolean;
begin
  select * into actor from identity.staff_management_actor(true);
  perform platform.require_control_enabled('staff_invitations_enabled');
  if actor.review_state <> 'reviewed' then
    raise exception using errcode = 'P0001', message = 'FACILITY_REVIEW_PENDING';
  end if;
  if requested_invitation_id is null or requested_send_id is null
     or not identity.staff_invitation_fields_valid(requested_invitee_name, normalized_email, requested_role,
       requested_licence_body, normalized_number, requested_attestation_version)
     or requested_idempotency_key is null or length(requested_idempotency_key) not between 16 and 128
     or requested_idempotency_key !~ '^[A-Za-z0-9._:-]+$'
     or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$'
     or requested_link_token_hmac is null or requested_link_token_hmac !~ '^[0-9a-f]{64}$'
     or requested_email_code_hmac is null or requested_email_code_hmac !~ '^[0-9a-f]{64}$'
     or requested_key_version is null or length(requested_key_version) not between 1 and 64 then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';
  end if;
  if not (requested_role = any(identity.staff_invitable_roles(actor.organization_type, actor.product_code))) then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_ROLE_NOT_ALLOWED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('staff-invitations:' || actor.facility_id::text, 0));
  select invitation.* into stored from identity.staff_invitations invitation
   where invitation.invited_by_account_id = actor.account_id
     and invitation.facility_id = actor.facility_id
     and invitation.idempotency_key = requested_idempotency_key;
  if stored.id is not null then
    if stored.request_sha256 <> requested_request_sha256 then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query select stored.id, stored.row_version, stored.last_send_id, stored.expires_at, true, false,
      actor.facility_name, stored.role_code, stored.invitee_email;
    return;
  end if;

  select lower(account.email) into actor_email from auth.accounts account where account.id = actor.account_id;
  if actor_email = normalized_email then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_SELF';
  end if;
  if exists (select 1 from identity.staff_facility_memberships membership
               join auth.accounts account on account.id = membership.account_id
              where membership.facility_id = actor.facility_id and membership.active
                and lower(account.email) = normalized_email) then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_ALREADY_MEMBER';
  end if;

  observed := clock_timestamp();
  update identity.staff_invitations invitation
     set status = 'expired', expired_at = observed, session_hmac = null, session_expires_at = null,
         session_account_case = null, session_account_id = null, session_account_row_version = null,
         session_account_token_version = null, updated_at = observed,
         row_version = invitation.row_version + 1
   where invitation.facility_id = actor.facility_id
     and invitation.status = 'pending'
     and invitation.expires_at <= observed;

  select * into limits from identity.staff_invitation_limits(actor.on_probation);
  if exists (select 1 from identity.staff_invitations invitation
              where invitation.facility_id = actor.facility_id and invitation.status = 'pending'
                and invitation.invitee_email = normalized_email) then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_ALREADY_PENDING';
  end if;
  if (select count(*) from identity.staff_invitations invitation
       where invitation.facility_id = actor.facility_id and invitation.status = 'pending') >= limits.pending_limit then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_PENDING_LIMIT';
  end if;
  if (select count(*) from identity.staff_invitations invitation
       where invitation.facility_id = actor.facility_id
         and invitation.created_at > observed - interval '24 hours') >= limits.invitations_per_day
     or (select count(*) from identity.staff_invitation_sends send
          where send.facility_id = actor.facility_id
            and send.sent_at > observed - interval '24 hours') >= limits.emails_per_day then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_DAILY_LIMIT';
  end if;
  if (select count(*) from identity.staff_invitations invitation
       where invitation.facility_id = actor.facility_id and invitation.invitee_email = normalized_email
         and invitation.created_at > observed - interval '30 days') >= limits.recipient_invitations_per_30_days
     or (select count(*) from identity.staff_invitation_sends send
          where send.facility_id = actor.facility_id and send.invitee_email = normalized_email
            and send.sent_at > observed - interval '30 days') >= limits.recipient_emails_per_30_days then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_RECIPIENT_LIMIT';
  end if;
  if (select count(*) from identity.staff_invitation_sends send
       where send.facility_id = actor.facility_id and send.outcome = 'definitive_failure'
         and send.sent_at > observed - interval '24 hours') >= limits.delivery_failures_pause then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_DELIVERY_PAUSED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('staff-invitation-recipient:' || normalized_email, 0));
  will_dispatch := (select count(*) from identity.staff_invitation_sends send
                     where send.invitee_email = normalized_email and send.dispatched
                       and send.sent_at > observed - interval '24 hours')
                   < limits.recipient_emails_per_day_all_facilities;

  insert into identity.staff_invitations as invitation (
    id, organization_id, facility_id, invited_by_account_id, invited_by_membership_id,
    invitee_name, invitee_email, role_code, licence_body, licence_number,
    attestation_version, attested_at, link_token_hmac, email_code_hmac, key_version,
    last_sent_at, last_send_id, expires_at, delivery_outcome,
    idempotency_key, request_sha256, correlation_id
  ) values (
    requested_invitation_id, actor.organization_id, actor.facility_id, actor.account_id, actor.membership_id,
    requested_invitee_name, normalized_email, requested_role, requested_licence_body, normalized_number,
    requested_attestation_version, observed, requested_link_token_hmac, requested_email_code_hmac,
    requested_key_version, observed, requested_send_id, observed + make_interval(days => limits.validity_days),
    case when will_dispatch then 'pending' else 'unknown' end,
    requested_idempotency_key, requested_request_sha256, platform.current_correlation_id()
  ) returning invitation.* into stored;
  insert into identity.staff_invitation_sends (
    id, invitation_id, facility_id, invitee_email, sent_by_account_id, kind,
    link_token_hmac, email_code_hmac, dispatched, outcome, sent_at, outcome_at
  ) values (
    requested_send_id, stored.id, stored.facility_id, stored.invitee_email, actor.account_id, 'invite',
    requested_link_token_hmac, requested_email_code_hmac, will_dispatch,
    case when will_dispatch then 'pending' else 'suppressed' end, observed,
    case when will_dispatch then null else observed end
  );
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.account_id,
    actor.membership_id, actor.organization_id, actor.facility_id,
    'identity.staff-invitation.create', 'success', 'staff-invitation', stored.id::text,
    'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('invitationId', stored.id, 'roleCode', stored.role_code,
      'licenceBody', stored.licence_body)
  );
  return query select stored.id, stored.row_version, requested_send_id, stored.expires_at, false, will_dispatch,
    actor.facility_name, stored.role_code, stored.invitee_email;
end;
$$;

-- The send's outcome, from Identity after the synchronous delivery. A stale
-- outcome (the send no longer pending) changes nothing; the invitation's
-- outcome follows its newest send only. The invitation's row_version is not
-- bumped, so the administrator's version stays current.
create function identity.record_staff_invitation_delivery(
  requested_send_id uuid,
  requested_outcome text
) returns void
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor record;
  send_row identity.staff_invitation_sends%rowtype;
  changed boolean := false;
begin
  select * into actor from identity.staff_management_actor(true);
  if actor.review_state <> 'reviewed' then
    raise exception using errcode = 'P0001', message = 'FACILITY_REVIEW_PENDING';
  end if;
  if requested_send_id is null or requested_outcome is null
     or requested_outcome not in ('accepted', 'definitive_failure', 'unknown') then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';
  end if;
  select candidate.* into send_row from identity.staff_invitation_sends candidate
   where candidate.id = requested_send_id and candidate.facility_id = actor.facility_id
   for update;
  if send_row.id is null then
    raise exception using errcode = 'P0002', message = 'STAFF_INVITATION_NOT_FOUND';
  end if;
  if send_row.outcome = 'pending' then
    update identity.staff_invitation_sends candidate
       set outcome = requested_outcome, outcome_at = clock_timestamp()
     where candidate.id = send_row.id;
    update identity.staff_invitations invitation
       set delivery_outcome = requested_outcome, updated_at = clock_timestamp()
     where invitation.id = send_row.invitation_id and invitation.last_send_id = send_row.id;
    changed := true;
  end if;
  if changed then
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.account_id,
      actor.membership_id, actor.organization_id, actor.facility_id,
      'identity.staff-invitation.delivery', 'success', 'staff-invitation', send_row.invitation_id::text,
      'healthcare-operations', 'application', 'identity-api',
      jsonb_build_object('invitationId', send_row.invitation_id, 'deliveryOutcome', requested_outcome)
    );
  end if;
end;
$$;

-- Resend a pending (also past expiry) or expired invitation: new token and
-- code (the old ones then answer superseded), 7 more days, the typed-code
-- counter reset (the link counter is kept), any open session ended.
create function identity.resend_staff_invitation(
  requested_invitation_id uuid,
  expected_version bigint,
  requested_send_id uuid,
  requested_link_token_hmac char(64),
  requested_email_code_hmac char(64),
  requested_key_version text
) returns table (
  row_version bigint,
  expires_at timestamptz,
  send_id uuid,
  dispatch boolean,
  facility_name text,
  role_code text,
  invitee_email text
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor record;
  limits record;
  current_row identity.staff_invitations%rowtype;
  observed timestamptz;
  will_dispatch boolean;
begin
  select * into actor from identity.staff_management_actor(true);
  perform platform.require_control_enabled('staff_invitations_enabled');
  if actor.review_state <> 'reviewed' then
    raise exception using errcode = 'P0001', message = 'FACILITY_REVIEW_PENDING';
  end if;
  if requested_invitation_id is null or expected_version is null or requested_send_id is null
     or requested_link_token_hmac is null or requested_link_token_hmac !~ '^[0-9a-f]{64}$'
     or requested_email_code_hmac is null or requested_email_code_hmac !~ '^[0-9a-f]{64}$'
     or requested_key_version is null or length(requested_key_version) not between 1 and 64 then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('staff-invitations:' || actor.facility_id::text, 0));
  select invitation.* into current_row from identity.staff_invitations invitation
   where invitation.id = requested_invitation_id and invitation.facility_id = actor.facility_id
   for update;
  if current_row.id is null then
    raise exception using errcode = 'P0002', message = 'STAFF_INVITATION_NOT_FOUND';
  end if;
  if current_row.status not in ('pending', 'expired') then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_NOT_PENDING';
  end if;
  if current_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Staff invitation version conflict';
  end if;
  observed := clock_timestamp();
  select * into limits from identity.staff_invitation_limits(actor.on_probation);
  if current_row.last_sent_at + make_interval(secs => limits.resend_cooldown_seconds) > observed then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_RESEND_TOO_SOON';
  end if;
  if current_row.send_count >= limits.sends_per_invitation then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_SEND_LIMIT';
  end if;
  if (select count(*) from identity.staff_invitation_sends send
       where send.facility_id = actor.facility_id
         and send.sent_at > observed - interval '24 hours') >= limits.emails_per_day then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_DAILY_LIMIT';
  end if;
  if (select count(*) from identity.staff_invitation_sends send
       where send.facility_id = actor.facility_id and send.invitee_email = current_row.invitee_email
         and send.sent_at > observed - interval '30 days') >= limits.recipient_emails_per_30_days then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_RECIPIENT_LIMIT';
  end if;
  if (select count(*) from identity.staff_invitation_sends send
       where send.facility_id = actor.facility_id and send.outcome = 'definitive_failure'
         and send.sent_at > observed - interval '24 hours') >= limits.delivery_failures_pause then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_DELIVERY_PAUSED';
  end if;
  update identity.staff_invitations other
     set status = 'expired', expired_at = observed, session_hmac = null, session_expires_at = null,
         session_account_case = null, session_account_id = null, session_account_row_version = null,
         session_account_token_version = null, updated_at = observed, row_version = other.row_version + 1
   where other.facility_id = actor.facility_id and other.status = 'pending'
     and other.expires_at <= observed and other.id <> current_row.id;
  if exists (select 1 from identity.staff_invitations other
              where other.facility_id = actor.facility_id and other.invitee_email = current_row.invitee_email
                and other.status = 'pending' and other.id <> current_row.id) then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_ALREADY_PENDING';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('staff-invitation-recipient:' || current_row.invitee_email, 0));
  will_dispatch := (select count(*) from identity.staff_invitation_sends send
                     where send.invitee_email = current_row.invitee_email and send.dispatched
                       and send.sent_at > observed - interval '24 hours')
                   < limits.recipient_emails_per_day_all_facilities;

  update identity.staff_invitations invitation
     set status = 'pending', expired_at = null,
         link_token_hmac = requested_link_token_hmac, email_code_hmac = requested_email_code_hmac,
         key_version = requested_key_version, failed_typed_attempts = 0,
         session_hmac = null, session_expires_at = null, session_account_case = null,
         session_account_id = null, session_account_row_version = null, session_account_token_version = null,
         accept_attempts = 0, send_count = invitation.send_count + 1, last_sent_at = observed,
         last_send_id = requested_send_id,
         expires_at = observed + make_interval(days => limits.validity_days),
         delivery_outcome = case when will_dispatch then 'pending' else 'unknown' end,
         updated_at = observed, row_version = invitation.row_version + 1
   where invitation.id = current_row.id
   returning invitation.* into current_row;
  insert into identity.staff_invitation_sends (
    id, invitation_id, facility_id, invitee_email, sent_by_account_id, kind,
    link_token_hmac, email_code_hmac, dispatched, outcome, sent_at, outcome_at
  ) values (
    requested_send_id, current_row.id, current_row.facility_id, current_row.invitee_email, actor.account_id,
    'resend', requested_link_token_hmac, requested_email_code_hmac, will_dispatch,
    case when will_dispatch then 'pending' else 'suppressed' end, observed,
    case when will_dispatch then null else observed end
  );
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.account_id,
    actor.membership_id, actor.organization_id, actor.facility_id,
    'identity.staff-invitation.resend', 'success', 'staff-invitation', current_row.id::text,
    'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('invitationId', current_row.id, 'sendCount', current_row.send_count)
  );
  return query select current_row.row_version, current_row.expires_at, requested_send_id, will_dispatch,
    actor.facility_name, current_row.role_code, current_row.invitee_email;
end;
$$;

-- Revoke a pending or expired invitation; any open session ends.
create function identity.revoke_staff_invitation(
  requested_invitation_id uuid,
  expected_version bigint
) returns table (row_version bigint, revoked_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor record;
  current_row identity.staff_invitations%rowtype;
  observed timestamptz := clock_timestamp();
begin
  select * into actor from identity.staff_management_actor(true);
  if actor.review_state <> 'reviewed' then
    raise exception using errcode = 'P0001', message = 'FACILITY_REVIEW_PENDING';
  end if;
  select invitation.* into current_row from identity.staff_invitations invitation
   where invitation.id = requested_invitation_id and invitation.facility_id = actor.facility_id
   for update;
  if current_row.id is null then
    raise exception using errcode = 'P0002', message = 'STAFF_INVITATION_NOT_FOUND';
  end if;
  if current_row.status not in ('pending', 'expired') then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_NOT_PENDING';
  end if;
  if expected_version is null or current_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Staff invitation version conflict';
  end if;
  update identity.staff_invitations invitation
     set status = 'revoked', expired_at = null, revoked_at = observed,
         revoked_by_account_id = actor.account_id, revoke_kind = 'facility',
         session_hmac = null, session_expires_at = null, session_account_case = null,
         session_account_id = null, session_account_row_version = null, session_account_token_version = null,
         updated_at = observed, row_version = invitation.row_version + 1
   where invitation.id = current_row.id
   returning invitation.* into current_row;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.account_id,
    actor.membership_id, actor.organization_id, actor.facility_id,
    'identity.staff-invitation.revoke', 'success', 'staff-invitation', current_row.id::text,
    'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('invitationId', current_row.id)
  );
  return query select current_row.row_version, current_row.revoked_at;
end;
$$;

-- Remove a member (not the caller, not an administrator): the membership
-- ends, its facility roles are revoked, its pending access requests expire
-- and its active consent grants are revoked, each with one
-- identity.consent-grant.close row (FEA A6). Sessions are not revoked:
-- authorization stops at the next request. Lab and Pharmacy work the person
-- accepted stays bound to their membership (A3).
create function identity.end_facility_staff_membership(
  requested_membership_id uuid,
  expected_version bigint,
  requested_reason text
) returns table (
  row_version bigint,
  ended_at timestamptz,
  roles_revoked integer,
  grants_revoked integer,
  requests_expired integer
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor record;
  reason text := btrim(coalesce(requested_reason, ''));
  member identity.staff_facility_memberships%rowtype;
  observed timestamptz;
  revoked_roles integer;
  revoked_grants integer := 0;
  expired_requests integer;
  closed record;
begin
  select * into actor from identity.staff_management_actor(true);
  if actor.review_state <> 'reviewed' then
    raise exception using errcode = 'P0001', message = 'FACILITY_REVIEW_PENDING';
  end if;
  if length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'FACILITY_STAFF_REASON_INVALID';
  end if;
  select membership.* into member from identity.staff_facility_memberships membership
   where membership.id = requested_membership_id and membership.facility_id = actor.facility_id
   for no key update;
  if member.id is null then
    raise exception using errcode = 'P0002', message = 'FACILITY_STAFF_NOT_FOUND';
  end if;
  if member.id = actor.membership_id or member.account_id = actor.account_id then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_SELF';
  end if;
  if exists (select 1 from auth.account_roles assignment
              where assignment.membership_id = member.id and assignment.revoked_at is null
                and assignment.role_code in ('org_admin', 'org_admin_awaiting_review')) then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ADMINISTRATOR';
  end if;
  if not member.active then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ALREADY_ENDED';
  end if;
  if expected_version is null or member.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Facility staff membership version conflict';
  end if;
  observed := clock_timestamp();
  update identity.staff_facility_memberships membership
     set active = false, updated_at = observed, row_version = membership.row_version + 1
   where membership.id = member.id
   returning membership.* into member;
  update auth.account_roles assignment
     set revoked_at = observed, revoked_by = actor.account_id,
         revocation_reason = 'Staff member removed from the facility',
         row_version = assignment.row_version + 1
   where assignment.membership_id = member.id and assignment.revoked_at is null;
  get diagnostics revoked_roles = row_count;
  update identity.access_requests request
     set status = 'expired', updated_at = observed, row_version = request.row_version + 1
   where request.membership_id = member.id and request.status = 'pending';
  get diagnostics expired_requests = row_count;
  for closed in
    update identity.consent_grants grant_row
       set status = 'revoked', revoked_at = observed, revoked_by = actor.account_id,
           revoked_reason = 'Staff member removed from the facility',
           updated_at = observed, row_version = grant_row.row_version + 1
     where grant_row.membership_id = member.id and grant_row.status = 'active'
    returning grant_row.id, grant_row.patient_id
  loop
    revoked_grants := revoked_grants + 1;
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, reason, provenance, source_system, details
    ) values (
      platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.account_id,
      actor.membership_id, actor.organization_id, actor.facility_id, closed.patient_id,
      'identity.consent-grant.close', 'success', 'consent-grant', closed.id::text,
      'healthcare-operations', 'Staff member removed from the facility', 'application', 'identity-api',
      jsonb_build_object('existing_closure', false, 'membershipId', member.id)
    );
  end loop;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.account_id,
    actor.membership_id, actor.organization_id, actor.facility_id,
    'identity.facility-staff.end', 'success', 'staff-membership', member.id::text,
    'healthcare-operations', reason, 'application', 'identity-api',
    jsonb_build_object('membershipId', member.id, 'rolesRevoked', revoked_roles,
      'grantsRevoked', revoked_grants, 'requestsExpired', expired_requests)
  );
  return query select member.row_version, observed, revoked_roles, revoked_grants, expired_requests;
end;
$$;

-- Change a member's role, vouching for the licence again. The same role with
-- another licence writes a new attestation only (S15.5); the same role and
-- licence key answers FACILITY_STAFF_ROLE_UNCHANGED. Otherwise the member's
-- current role rows are revoked and the new role granted with an
-- attestation; membership_role and app_role follow, or app_role alone when
-- the membership_role would collide with another membership row of the same
-- person at this facility (staff_memberships_scoped_uq).
create function identity.change_facility_staff_role(
  requested_membership_id uuid,
  expected_version bigint,
  requested_role text,
  requested_licence_body text,
  requested_licence_number text,
  requested_attestation_version text,
  requested_reason text
) returns table (row_version bigint, role_code text)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor record;
  reason text := btrim(coalesce(requested_reason, ''));
  normalized_number text := case when requested_licence_number is null then null
    else identity.normalize_licence_number(requested_licence_number) end;
  member identity.staff_facility_memberships%rowtype;
  member_name text;
  current_roles text[];
  current_grant uuid;
  current_key text;
  requested_key text;
  grant_id uuid;
  observed timestamptz;
  role_collides boolean;
begin
  select * into actor from identity.staff_management_actor(true);
  perform platform.require_control_enabled('staff_invitations_enabled');
  if actor.review_state <> 'reviewed' then
    raise exception using errcode = 'P0001', message = 'FACILITY_REVIEW_PENDING';
  end if;
  if length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'FACILITY_STAFF_REASON_INVALID';
  end if;
  if requested_role is null
     or requested_role not in ('doctor', 'nurse', 'lab', 'pharmacist', 'receptionist')
     or not ((requested_role = 'receptionist' and requested_licence_body is null and normalized_number is null)
       or (requested_role <> 'receptionist'
         and requested_licence_body is not distinct from identity.staff_role_licence_body(requested_role)
         and identity.licence_number_valid(normalized_number)))
     or requested_attestation_version is null
     or requested_attestation_version not like 'facility-staff-attestation-%'
     or not exists (select 1 from identity.staff_attestation_texts attestation
                     where attestation.version = requested_attestation_version) then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';
  end if;
  if not (requested_role = any(identity.staff_invitable_roles(actor.organization_type, actor.product_code))) then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_ROLE_NOT_ALLOWED';
  end if;
  select membership.* into member from identity.staff_facility_memberships membership
   where membership.id = requested_membership_id and membership.facility_id = actor.facility_id
   for no key update;
  if member.id is null then
    raise exception using errcode = 'P0002', message = 'FACILITY_STAFF_NOT_FOUND';
  end if;
  if member.id = actor.membership_id or member.account_id = actor.account_id then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_SELF';
  end if;
  if exists (select 1 from auth.account_roles assignment
              where assignment.membership_id = member.id and assignment.revoked_at is null
                and assignment.role_code in ('org_admin', 'org_admin_awaiting_review')) then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ADMINISTRATOR';
  end if;
  if not member.active then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ALREADY_ENDED';
  end if;
  if exists (select 1 from auth.account_roles assignment
              where assignment.account_id = member.account_id and assignment.scope_type = 'platform'
                and assignment.revoked_at is null) then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_PLATFORM_ACCOUNT';
  end if;
  if expected_version is null or member.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Facility staff membership version conflict';
  end if;

  perform 1 from auth.account_roles assignment
   where assignment.membership_id = member.id and assignment.revoked_at is null
   order by assignment.id
   for update;
  select coalesce(array_agg(assignment.role_code order by assignment.role_code), array[]::text[]),
    min(assignment.id::text)::uuid
    into current_roles, current_grant
    from auth.account_roles assignment
   where assignment.membership_id = member.id and assignment.scope_type = 'facility'
     and assignment.revoked_at is null;
  select attestation.licence_key into current_key
    from identity.staff_licence_attestations attestation
   where attestation.role_grant_id = current_grant
   order by attestation.recorded_at desc, attestation.id desc
   limit 1;
  requested_key := case when requested_role = 'receptionist' then null
    else identity.staff_licence_key(requested_licence_body, normalized_number) end;
  if current_roles = array[requested_role] and current_key is not distinct from requested_key then
    raise exception using errcode = 'P0001', message = 'FACILITY_STAFF_ROLE_UNCHANGED';
  end if;

  observed := clock_timestamp();
  select coalesce(account.display_name, staff.full_name) into member_name
    from identity.staff staff join auth.accounts account on account.id = staff.account_id
   where staff.id = member.staff_id;
  if current_roles = array[requested_role] then
    grant_id := current_grant;
  else
    update auth.account_roles assignment
       set revoked_at = observed, revoked_by = actor.account_id,
           revocation_reason = 'Role changed by the facility administrator',
           row_version = assignment.row_version + 1
     where assignment.membership_id = member.id and assignment.revoked_at is null;
    grant_id := gen_random_uuid();
    insert into auth.account_roles (
      id, account_id, role_code, scope_type, membership_id, facility_id, granted_by, grant_reason
    ) values (
      grant_id, member.account_id, requested_role, 'facility', member.id, member.facility_id, actor.account_id,
      'Role changed by the facility administrator; licence vouched by the facility administrator'
    );
  end if;
  if requested_role <> 'receptionist' then
    insert into identity.staff_licence_attestations (
      organization_id, facility_id, account_id, staff_id, membership_id, role_code, role_grant_id,
      licence_body, licence_number, attested_person_name, verification_method,
      attested_by_account_id, attested_by_membership_id, attestation_version, attested_at, correlation_id
    ) values (
      member.organization_id, member.facility_id, member.account_id, member.staff_id, member.id,
      requested_role, grant_id, requested_licence_body, normalized_number, left(member_name, 200),
      'facility_attestation', actor.account_id, actor.membership_id, requested_attestation_version,
      observed, platform.current_correlation_id()
    );
  end if;
  role_collides := exists (select 1 from identity.staff_facility_memberships other
                            where other.staff_id = member.staff_id and other.organization_id = member.organization_id
                              and other.facility_id = member.facility_id and other.id <> member.id
                              and other.membership_role = requested_role);
  update identity.staff_facility_memberships membership
     set membership_role = case when role_collides then membership.membership_role else requested_role end,
         app_role = requested_role,
         updated_at = observed, row_version = membership.row_version + 1
   where membership.id = member.id
   returning membership.* into member;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor.account_id,
    actor.membership_id, actor.organization_id, actor.facility_id,
    'identity.facility-staff.role-change', 'success', 'staff-membership', member.id::text,
    'healthcare-operations', reason, 'application', 'identity-api',
    jsonb_build_object('membershipId', member.id, 'roleCode', requested_role,
      'previousRoles', to_jsonb(current_roles), 'licenceBody', requested_licence_body,
      'licenceOnly', current_roles = array[requested_role])
  );
  return query select member.row_version, requested_role;
end;
$$;

-- 5.11 Opening and accepting an invitation.
-- Finds the invitation a link (id and token) or a typed code (email and code)
-- names, counting a wrong token or code, then locks it in the lock order: its
-- organization's application FOR SHARE, then the invitation FOR UPDATE.
--   matched    the token or code is the invitation's current one;
--   locked     link mode: 10 wrong tokens reached (for its lifetime);
--   superseded the token or code of an earlier send (counts nothing);
--   invalid    anything else: link mode counts one wrong token on the named
--              invitation; typed mode counts one wrong code on every pending
--              invitation for the email, in one statement whether or not any
--              exists, capped at 5, and never touches link mode.
create function identity.match_staff_invitation(
  requested_invitation_id uuid,
  requested_link_token_hmac char(64),
  requested_email text,
  requested_email_code_hmac char(64)
) returns table (outcome text, matched_invitation_id uuid)
language plpgsql volatile
set search_path = pg_catalog, identity, pg_temp
as $$
declare
  link_mode boolean := requested_invitation_id is not null;
  normalized_email text := lower(btrim(coalesce(requested_email, '')));
  candidate uuid;
  current_row identity.staff_invitations%rowtype;
begin
  if link_mode then
    select invitation.id into candidate from identity.staff_invitations invitation
     where invitation.id = requested_invitation_id;
  else
    select invitation.id into candidate from identity.staff_invitations invitation
     where invitation.invitee_email = normalized_email and invitation.status = 'pending'
       and invitation.email_code_hmac = requested_email_code_hmac and invitation.failed_typed_attempts < 5
     order by invitation.created_at desc, invitation.id desc
     limit 1;
    if candidate is null then
      if exists (select 1 from identity.staff_invitation_sends send
                   join identity.staff_invitations invitation on invitation.id = send.invitation_id
                  where invitation.invitee_email = normalized_email and invitation.status = 'pending'
                    and send.email_code_hmac = requested_email_code_hmac
                    and invitation.email_code_hmac <> requested_email_code_hmac) then
        return query select 'superseded'::text, null::uuid;
        return;
      end if;
      update identity.staff_invitations invitation
         set failed_typed_attempts = least(invitation.failed_typed_attempts + 1, 5)
       where invitation.id in (select pending.id from identity.staff_invitations pending
                                where pending.invitee_email = normalized_email and pending.status = 'pending'
                                order by pending.id
                                for update);
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
  end if;
  if candidate is null then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  perform identity.lock_self_service_application(
    (select invitation.organization_id from identity.staff_invitations invitation where invitation.id = candidate));
  select invitation.* into current_row from identity.staff_invitations invitation
   where invitation.id = candidate
   for update;
  if link_mode then
    if current_row.failed_link_attempts >= 10 then
      return query select 'locked'::text, current_row.id;
      return;
    end if;
    if current_row.link_token_hmac is distinct from requested_link_token_hmac then
      if exists (select 1 from identity.staff_invitation_sends send
                  where send.invitation_id = current_row.id
                    and send.link_token_hmac = requested_link_token_hmac) then
        return query select 'superseded'::text, current_row.id;
        return;
      end if;
      update identity.staff_invitations invitation
         set failed_link_attempts = invitation.failed_link_attempts + 1
       where invitation.id = current_row.id;
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
  elsif current_row.status <> 'pending'
     or current_row.email_code_hmac is distinct from requested_email_code_hmac
     or current_row.failed_typed_attempts >= 5 then
    -- Resent, revoked or accepted while this request waited for the lock.
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  return query select 'matched'::text, current_row.id;
end;
$$;

-- Ends an invitation's open session; with expire, also marks a pending
-- invitation past its expiry expired.
create function identity.end_staff_invitation_session(target_invitation_id uuid, expire boolean)
returns void
language plpgsql volatile
set search_path = pg_catalog, identity, pg_temp
as $$
begin
  update identity.staff_invitations invitation
     set session_hmac = null, session_expires_at = null, session_account_case = null,
         session_account_id = null, session_account_row_version = null, session_account_token_version = null,
         status = case when expire and invitation.status = 'pending' then 'expired' else invitation.status end,
         expired_at = case when expire and invitation.status = 'pending' then clock_timestamp()
           else invitation.expired_at end,
         row_version = case when expire and invitation.status = 'pending' then invitation.row_version + 1
           else invitation.row_version end,
         updated_at = clock_timestamp()
   where invitation.id = target_invitation_id;
end;
$$;

-- The locks taken once an invitation is matched and still valid, in the lock
-- order: its facility and organization and the inviter's membership FOR
-- SHARE, then the email's advisory lock, before any account row is read.
create function identity.lock_staff_invitation_acceptance(invitation identity.staff_invitations)
returns void
language plpgsql volatile
set search_path = pg_catalog, identity, pg_temp
as $$
begin
  perform 1 from identity.facilities facility where facility.id = invitation.facility_id for share;
  perform 1 from identity.organizations organization where organization.id = invitation.organization_id for share;
  perform 1 from identity.staff_facility_memberships membership
   where membership.id = invitation.invited_by_membership_id for share;
  perform pg_advisory_xact_lock(hashtextextended('account-email:' || invitation.invitee_email, 0));
end;
$$;

revoke all on function identity.match_staff_invitation(uuid,char,text,char),
  identity.end_staff_invitation_session(uuid,boolean),
  identity.lock_staff_invitation_acceptance(identity.staff_invitations)
  from public;

-- Open (public, accountless, system:auth). Answers a result instead of
-- raising, so counters commit. On 'ready' it computes the account case and,
-- for 'new', and for 'dormant_staff' in link mode only (S17), opens a
-- one-hour session bound to that case and the account's versions (S8.3).
-- A typed-mode dormant_staff answers link_required. Audited
-- identity.staff-invitation.open (system, the facility, details
-- {invitationId} only).
create function identity.open_staff_invitation(
  requested_invitation_id uuid,
  requested_link_token_hmac char(64),
  requested_email text,
  requested_email_code_hmac char(64),
  requested_session_hmac char(64)
) returns table (
  result text,
  invitation_id uuid,
  facility_name text,
  role_code text,
  inviter_name text,
  invitee_name text,
  invitee_email text,
  expires_at timestamptz,
  account_case text,
  link_required boolean,
  session_expires_at timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  link_mode boolean := requested_invitation_id is not null or requested_link_token_hmac is not null;
  typed_mode boolean := requested_email is not null or requested_email_code_hmac is not null;
  matched record;
  current_row identity.staff_invitations%rowtype;
  validity text;
  case_row record;
  name_of_facility text;
  name_of_inviter text;
  opened_until timestamptz;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Staff invitation context is required';
  end if;
  perform platform.require_control_enabled('staff_invitations_enabled');
  if link_mode = typed_mode
     or (link_mode and (requested_invitation_id is null or requested_link_token_hmac is null
       or requested_link_token_hmac !~ '^[0-9a-f]{64}$'))
     or (typed_mode and (requested_email is null or length(btrim(requested_email)) not between 3 and 254
       or requested_email_code_hmac is null or requested_email_code_hmac !~ '^[0-9a-f]{64}$'))
     or requested_session_hmac is null or requested_session_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';
  end if;

  select * into matched from identity.match_staff_invitation(
    case when link_mode then requested_invitation_id end, requested_link_token_hmac,
    requested_email, requested_email_code_hmac);
  if matched.matched_invitation_id is not null then
    select invitation.* into current_row from identity.staff_invitations invitation
     where invitation.id = matched.matched_invitation_id;
    select facility.name into name_of_facility from identity.facilities facility
     where facility.id = current_row.facility_id;
  end if;
  if matched.outcome <> 'matched' then
    return query select matched.outcome, current_row.id, name_of_facility, null::text, null::text, null::text,
      null::text, null::timestamptz, null::text, null::boolean, null::timestamptz;
    return;
  end if;

  validity := identity.staff_invitation_still_valid(current_row);
  if validity is not null then
    if validity = 'expired' then
      perform identity.end_staff_invitation_session(current_row.id, true);
    end if;
    return query select validity, current_row.id, name_of_facility, current_row.role_code, null::text,
      null::text, null::text, current_row.expires_at, null::text, null::boolean, null::timestamptz;
    return;
  end if;

  perform identity.lock_staff_invitation_acceptance(current_row);
  select * into case_row from identity.staff_invitation_account_case(current_row.invitee_email, current_row.facility_id);
  if case_row.account_case = 'new' or (case_row.account_case = 'dormant_staff' and link_mode) then
    opened_until := clock_timestamp() + interval '1 hour';
    update identity.staff_invitations invitation
       set session_hmac = requested_session_hmac, session_expires_at = opened_until,
           session_account_case = case_row.account_case,
           session_account_id = case when case_row.account_case = 'new' then null else case_row.account_id end,
           session_account_row_version = case when case_row.account_case = 'new' then null
             else case_row.account_row_version end,
           session_account_token_version = case when case_row.account_case = 'new' then null
             else case_row.account_token_version end,
           accept_attempts = 0, updated_at = clock_timestamp()
     where invitation.id = current_row.id;
  end if;
  select account.display_name into name_of_inviter from auth.accounts account
   where account.id = current_row.invited_by_account_id;
  insert into audit.events (
    correlation_id, actor_type, organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system', current_row.organization_id, current_row.facility_id,
    'identity.staff-invitation.open', 'success', 'staff-invitation', current_row.id::text,
    'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('invitationId', current_row.id)
  );
  return query select 'ready'::text, current_row.id, name_of_facility, current_row.role_code, name_of_inviter,
    current_row.invitee_name, current_row.invitee_email, current_row.expires_at, case_row.account_case,
    (case_row.account_case = 'dormant_staff' and not link_mode), opened_until;
end;
$$;

-- The acceptance pre-check (public, with the open session), in its own
-- committed transaction before Identity computes the 64 MiB argon2id hash.
-- It charges one of the session's 5 attempts and re-derives the account case
-- under the email's lock; every answer but 'ready' ends the session.
create function identity.prepare_staff_invitation_acceptance(requested_session_hmac char(64))
returns table (result text, account_case text)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  candidate uuid;
  current_row identity.staff_invitations%rowtype;
  validity text;
  case_row record;
  answer text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Staff invitation context is required';
  end if;
  perform platform.require_control_enabled('staff_invitations_enabled');
  if requested_session_hmac is null or requested_session_hmac !~ '^[0-9a-f]{64}$' then
    return query select 'invalid'::text, null::text;
    return;
  end if;
  select invitation.id into candidate from identity.staff_invitations invitation
   where invitation.session_hmac = requested_session_hmac;
  if candidate is null then
    return query select 'invalid'::text, null::text;
    return;
  end if;
  perform identity.lock_self_service_application(
    (select invitation.organization_id from identity.staff_invitations invitation where invitation.id = candidate));
  select invitation.* into current_row from identity.staff_invitations invitation
   where invitation.id = candidate
   for update;
  if current_row.session_hmac is distinct from requested_session_hmac then
    return query select 'invalid'::text, null::text;
    return;
  end if;
  validity := identity.staff_invitation_still_valid(current_row);
  if current_row.session_expires_at <= clock_timestamp() or current_row.accept_attempts >= 5
     or validity = 'accepted' then
    answer := 'invalid';
  elsif validity is not null then
    answer := validity;
  else
    perform identity.lock_staff_invitation_acceptance(current_row);
    select * into case_row from identity.staff_invitation_account_case(current_row.invitee_email,
      current_row.facility_id);
    if case_row.account_case in ('patient_account', 'unavailable') then
      answer := case_row.account_case;
    elsif current_row.session_account_case = 'new' and case_row.account_case <> 'new' then
      answer := 'account_exists';
    elsif current_row.session_account_case = 'dormant_staff'
       and (case_row.account_case <> 'dormant_staff'
         or case_row.account_id is distinct from current_row.session_account_id
         or case_row.account_row_version is distinct from current_row.session_account_row_version
         or case_row.account_token_version is distinct from current_row.session_account_token_version) then
      answer := 'account_changed';
    end if;
  end if;
  if answer is not null then
    perform identity.end_staff_invitation_session(current_row.id, answer = 'expired');
    return query select answer, null::text;
    return;
  end if;
  update identity.staff_invitations invitation
     set accept_attempts = invitation.accept_attempts + 1, updated_at = clock_timestamp()
   where invitation.id = current_row.id;
  return query select 'ready'::text, current_row.session_account_case;
end;
$$;

-- Accept with a new password (public, with the open session): 'new' creates
-- the account (subject 'staff-invitation:<id>', email verified, active), its
-- staff record (license_number never written, S15.4) and membership;
-- 'dormant_staff' sets the account's password, bumps its token version and
-- revokes every session (FEA A2), and attaches the membership. Both write the
-- role row and the attestation, accept the invitation and audit
-- identity.staff-invitation.accept (system). Every check is repeated under
-- the lock order; a case or account change since the open refuses.
create function identity.accept_staff_invitation_with_password(
  requested_session_hmac char(64),
  requested_password_hash text
) returns table (
  account_id uuid,
  membership_id uuid,
  organization_id uuid,
  facility_id uuid,
  facility_name text,
  role_code text,
  account_case text
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  candidate uuid;
  current_row identity.staff_invitations%rowtype;
  validity text;
  case_row record;
  target_account uuid;
  target_staff uuid;
  attached uuid;
  observed timestamptz;
  name_of_facility text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Staff invitation context is required';
  end if;
  perform platform.require_control_enabled('staff_invitations_enabled');
  if length(coalesce(requested_password_hash, '')) not between 64 and 512
     or requested_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$' then
    raise exception using errcode = '22023', message = 'Invalid Argon2id password hash policy';
  end if;
  if requested_session_hmac is not null and requested_session_hmac ~ '^[0-9a-f]{64}$' then
    select invitation.id into candidate from identity.staff_invitations invitation
     where invitation.session_hmac = requested_session_hmac;
  end if;
  if candidate is null then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_SESSION_INVALID';
  end if;
  perform identity.lock_self_service_application(
    (select invitation.organization_id from identity.staff_invitations invitation where invitation.id = candidate));
  select invitation.* into current_row from identity.staff_invitations invitation
   where invitation.id = candidate
   for update;
  validity := identity.staff_invitation_still_valid(current_row);
  if current_row.session_hmac is distinct from requested_session_hmac
     or current_row.session_expires_at <= clock_timestamp()
     or validity = 'accepted' then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_SESSION_INVALID';
  end if;
  if validity = 'expired' then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_EXPIRED';
  end if;
  if validity = 'withdrawn' then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_WITHDRAWN';
  end if;
  perform identity.lock_staff_invitation_acceptance(current_row);
  select * into case_row from identity.staff_invitation_account_case(current_row.invitee_email,
    current_row.facility_id);
  if case_row.account_case = 'patient_account' then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_PATIENT_ACCOUNT';
  end if;
  if case_row.account_case = 'unavailable' then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_ACCOUNT_UNAVAILABLE';
  end if;
  if current_row.session_account_case = 'new' and case_row.account_case <> 'new' then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_ACCOUNT_EXISTS';
  end if;
  if current_row.session_account_case = 'dormant_staff'
     and (case_row.account_case <> 'dormant_staff'
       or case_row.account_id is distinct from current_row.session_account_id
       or case_row.account_row_version is distinct from current_row.session_account_row_version
       or case_row.account_token_version is distinct from current_row.session_account_token_version) then
    raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_ACCOUNT_CHANGED';
  end if;

  observed := clock_timestamp();
  if current_row.session_account_case = 'new' then
    target_account := gen_random_uuid();
    target_staff := gen_random_uuid();
    begin
      insert into auth.accounts (
        id, subject, email, display_name, password_hash, password_algorithm, password_changed_at,
        email_verified_at, status, source_system
      ) values (
        target_account, 'staff-invitation:' || target_account::text, current_row.invitee_email,
        current_row.invitee_name, requested_password_hash, 'argon2id', observed, observed, 'active', 'hid'
      );
      insert into identity.staff (
        id, account_id, full_name, email, verification_status, default_role, active, source_system
      ) values (
        target_staff, target_account, current_row.invitee_name, current_row.invitee_email, 'verified',
        current_row.role_code, true, 'hid'
      );
    exception when unique_violation then
      raise exception using errcode = 'P0001', message = 'STAFF_INVITATION_ACCOUNT_EXISTS';
    end;
  else
    target_account := case_row.account_id;
    target_staff := case_row.staff_id;
    update auth.accounts account
       set password_hash = requested_password_hash, password_algorithm = 'argon2id',
           password_changed_at = observed, email_verified_at = coalesce(account.email_verified_at, observed),
           status = 'active', token_version = account.token_version + 1,
           row_version = account.row_version + 1, updated_at = observed
     where account.id = target_account;
    update auth.sessions session_row
       set revoked_at = observed, revocation_reason = 'password_set_by_staff_invitation',
           row_version = session_row.row_version + 1
     where session_row.account_id = target_account and session_row.revoked_at is null;
  end if;
  attached := identity.attach_invited_member(current_row, target_account, target_staff, true);
  update identity.staff_invitations invitation
     set status = 'accepted', accepted_at = observed, accepted_account_id = target_account,
         accepted_membership_id = attached, accepted_account_case = current_row.session_account_case,
         session_hmac = null, session_expires_at = null, session_account_case = null,
         session_account_id = null, session_account_row_version = null, session_account_token_version = null,
         updated_at = observed, row_version = invitation.row_version + 1
   where invitation.id = current_row.id;
  insert into audit.events (
    correlation_id, actor_type, organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system', current_row.organization_id, current_row.facility_id,
    'identity.staff-invitation.accept', 'success', 'staff-invitation', current_row.id::text,
    'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('invitationId', current_row.id, 'roleCode', current_row.role_code,
      'licenceBody', current_row.licence_body)
  );
  select facility.name into name_of_facility from identity.facilities facility where facility.id = current_row.facility_id;
  return query select target_account, attached, current_row.organization_id, current_row.facility_id,
    name_of_facility, current_row.role_code, current_row.session_account_case;
end;
$$;

-- Existing staff, signed in on their own host (S5): the account from the
-- session's subject, no facility, no permission. Link mode (id and token) or
-- typed mode (the code, matched with the account's own email). Results as
-- open, plus email_mismatch (link mode, the invitation is for another
-- email), already_member and unavailable (a platform role, an inactive or
-- unverified staff record, an account that cannot sign in). Neither writes a
-- facility audit row on a refusal; the accept writes one success row, actor
-- staff with the new membership at the inviting facility.
create function identity.staff_invitation_account_actor()
returns table (account_id uuid, account_email text)
language plpgsql stable
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not exists (select 1 from identity.staff staff where staff.account_id = actor_account) then
    raise exception using errcode = '42501', message = 'Staff invitation account context is required';
  end if;
  return query select account.id, lower(account.email) from auth.accounts account where account.id = actor_account;
end;
$$;
revoke all on function identity.staff_invitation_account_actor() from public;

create function identity.preview_staff_invitation_for_account(
  requested_invitation_id uuid,
  requested_link_token_hmac char(64),
  requested_email_code_hmac char(64)
) returns table (
  result text,
  invitation_id uuid,
  facility_id uuid,
  facility_name text,
  role_code text,
  inviter_name text,
  expires_at timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor record;
  answer record;
begin
  select * into actor from identity.staff_invitation_account_actor();
  perform platform.require_control_enabled('staff_invitations_enabled');
  select * into answer from identity.signed_in_staff_invitation(actor.account_id, actor.account_email,
    requested_invitation_id, requested_link_token_hmac, requested_email_code_hmac, false);
  return query select answer.result, answer.invitation_id, answer.facility_id, answer.facility_name,
    answer.role_code, answer.inviter_name, answer.expires_at;
end;
$$;

create function identity.accept_staff_invitation_for_account(
  requested_invitation_id uuid,
  requested_link_token_hmac char(64),
  requested_email_code_hmac char(64)
) returns table (
  result text,
  membership_id uuid,
  facility_id uuid,
  facility_name text,
  role_code text
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor record;
  answer record;
begin
  select * into actor from identity.staff_invitation_account_actor();
  perform platform.require_control_enabled('staff_invitations_enabled');
  select * into answer from identity.signed_in_staff_invitation(actor.account_id, actor.account_email,
    requested_invitation_id, requested_link_token_hmac, requested_email_code_hmac, true);
  return query select answer.result, answer.membership_id, answer.facility_id, answer.facility_name,
    answer.role_code;
end;
$$;

-- The shared body of the two signed-in commands (owner-only).
create function identity.signed_in_staff_invitation(
  actor_account_id uuid,
  actor_email text,
  requested_invitation_id uuid,
  requested_link_token_hmac char(64),
  requested_email_code_hmac char(64),
  accept boolean
) returns table (
  result text,
  invitation_id uuid,
  membership_id uuid,
  facility_id uuid,
  facility_name text,
  role_code text,
  inviter_name text,
  expires_at timestamptz
)
language plpgsql volatile
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  link_mode boolean := requested_invitation_id is not null or requested_link_token_hmac is not null;
  typed_mode boolean := requested_email_code_hmac is not null;
  matched record;
  current_row identity.staff_invitations%rowtype;
  validity text;
  case_row record;
  name_of_facility text;
  name_of_inviter text;
  attached uuid;
  observed timestamptz;
begin
  if link_mode = typed_mode
     or (link_mode and (requested_invitation_id is null or requested_link_token_hmac is null
       or requested_link_token_hmac !~ '^[0-9a-f]{64}$'))
     or (typed_mode and requested_email_code_hmac !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_INVALID';
  end if;
  select * into matched from identity.match_staff_invitation(
    case when link_mode then requested_invitation_id end, requested_link_token_hmac,
    actor_email, requested_email_code_hmac);
  if matched.matched_invitation_id is not null then
    select invitation.* into current_row from identity.staff_invitations invitation
     where invitation.id = matched.matched_invitation_id;
    select facility.name into name_of_facility from identity.facilities facility
     where facility.id = current_row.facility_id;
  end if;
  if matched.outcome <> 'matched' then
    return query select matched.outcome, current_row.id, null::uuid, current_row.facility_id, name_of_facility,
      null::text, null::text, null::timestamptz;
    return;
  end if;
  if current_row.invitee_email is distinct from actor_email then
    return query select 'email_mismatch'::text, current_row.id, null::uuid, null::uuid, null::text,
      null::text, null::text, null::timestamptz;
    return;
  end if;
  validity := identity.staff_invitation_still_valid(current_row);
  if validity is not null then
    if validity = 'expired' then
      perform identity.end_staff_invitation_session(current_row.id, true);
    end if;
    return query select validity, current_row.id, null::uuid, current_row.facility_id, name_of_facility,
      current_row.role_code, null::text, current_row.expires_at;
    return;
  end if;
  perform identity.lock_staff_invitation_acceptance(current_row);
  select * into case_row from identity.staff_invitation_account_case(current_row.invitee_email,
    current_row.facility_id);
  if case_row.account_case = 'already_member' then
    return query select 'already_member'::text, current_row.id, null::uuid, current_row.facility_id,
      name_of_facility, current_row.role_code, null::text, current_row.expires_at;
    return;
  end if;
  if case_row.account_case is distinct from 'existing_staff' or case_row.account_id is distinct from actor_account_id then
    return query select 'unavailable'::text, current_row.id, null::uuid, current_row.facility_id,
      name_of_facility, current_row.role_code, null::text, current_row.expires_at;
    return;
  end if;
  select account.display_name into name_of_inviter from auth.accounts account
   where account.id = current_row.invited_by_account_id;
  if not accept then
    return query select 'ready'::text, current_row.id, null::uuid, current_row.facility_id, name_of_facility,
      current_row.role_code, name_of_inviter, current_row.expires_at;
    return;
  end if;

  observed := clock_timestamp();
  attached := identity.attach_invited_member(current_row, actor_account_id, case_row.staff_id,
    not exists (select 1 from identity.staff_facility_memberships membership
                 where membership.account_id = actor_account_id and membership.active));
  update identity.staff_invitations invitation
     set status = 'accepted', accepted_at = observed, accepted_account_id = actor_account_id,
         accepted_membership_id = attached, accepted_account_case = 'existing_staff',
         session_hmac = null, session_expires_at = null, session_account_case = null,
         session_account_id = null, session_account_row_version = null, session_account_token_version = null,
         updated_at = observed, row_version = invitation.row_version + 1
   where invitation.id = current_row.id;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'staff', platform.current_actor_subject(), actor_account_id, attached,
    current_row.organization_id, current_row.facility_id,
    'identity.staff-invitation.accept', 'success', 'staff-invitation', current_row.id::text,
    'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('invitationId', current_row.id, 'roleCode', current_row.role_code,
      'licenceBody', current_row.licence_body)
  );
  return query select 'ready'::text, current_row.id, attached, current_row.facility_id, name_of_facility,
    current_row.role_code, name_of_inviter, current_row.expires_at;
end;
$$;
revoke all on function identity.signed_in_staff_invitation(uuid,text,uuid,char,char,boolean) from public;

-- 5.12 Support's commands after review (platform administration, EXECUTE to
-- the Identity runtime only). Permission and context as P4's review: a
-- platform account (no facility membership needed), a correlation ID, the
-- healthcare-operations purpose of use, and platform.admin.access (the
-- platform audit row needs it) with, for the writes, platform.facility.manage
-- and platform.facility.unlock (S13), else 42501 ADMIN_PERMISSION_DENIED.
create function identity.self_service_unlock_actor()
returns uuid
language plpgsql stable
set search_path = pg_catalog, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or not auth.account_has_platform_permission(actor_account, 'platform.facility.manage')
     or not auth.account_has_platform_permission(actor_account, 'platform.facility.unlock') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  return actor_account;
end;
$$;

-- The administrator's role and licence as support chose them (review steps 4
-- and 5): 'none' or one of the reviewable roles for the application's type
-- and product (22023 SELF_SERVICE_REVIEW_ROLE_INVALID); a clinical role
-- needs both licence fields (22023 SELF_SERVICE_REVIEW_LICENCE_REQUIRED),
-- its own body and a valid number, and 'none' neither field (22023
-- SELF_SERVICE_REVIEW_LICENCE_INVALID). Returns the normalized number.
create function identity.self_service_review_licence(
  application identity.organization_applications,
  granted_role text,
  licence_body text,
  licence_number text
) returns text
language plpgsql stable
set search_path = pg_catalog, identity, pg_temp
as $$
declare
  normalized text := case when licence_number is null then null
    else identity.normalize_licence_number(licence_number) end;
begin
  if granted_role <> 'none'
     and not (granted_role = any(identity.self_service_reviewable_roles(application.organization_type,
       application.product_code))) then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_REVIEW_ROLE_INVALID';
  end if;
  if granted_role = 'none' then
    if licence_body is not null or licence_number is not null then
      raise exception using errcode = '22023', message = 'SELF_SERVICE_REVIEW_LICENCE_INVALID';
    end if;
    return null;
  end if;
  if licence_body is null or licence_number is null or btrim(licence_number) = '' then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED';
  end if;
  if licence_body is distinct from identity.staff_role_licence_body(granted_role)
     or not identity.licence_number_valid(normalized) then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_REVIEW_LICENCE_INVALID';
  end if;
  return normalized;
end;
$$;

-- Review step 6 (and the administrator-role command's): the facility, the
-- organization, the administrator's account and staff record FOR SHARE, and
-- the administrator's membership FOR NO KEY UPDATE, then: the facility
-- active and verified, the organization active, the account active and not
-- suspended, the staff record active and verified, exactly one active,
-- unheld membership of the administrator at the facility, holding an
-- unrevoked required_role row; else 23514
-- SELF_SERVICE_FACILITY_REVIEW_REQUIRES_ACTIVE. Returns the membership.
create function identity.lock_self_service_administrator(
  application identity.organization_applications,
  required_role text
) returns identity.staff_facility_memberships
language plpgsql volatile
set search_path = pg_catalog, identity, auth, pg_temp
as $$
declare
  facility_row identity.facilities%rowtype;
  organization_row identity.organizations%rowtype;
  account_row auth.accounts%rowtype;
  staff_row identity.staff%rowtype;
  member identity.staff_facility_memberships%rowtype;
  memberships integer;
begin
  select facility.* into facility_row from identity.facilities facility
   where facility.id = application.facility_id for share;
  select organization.* into organization_row from identity.organizations organization
   where organization.id = application.organization_id for share;
  select account.* into account_row from auth.accounts account
   where account.id = application.first_admin_account_id for share;
  select staff.* into staff_row from identity.staff staff
   where staff.account_id = application.first_admin_account_id for share;
  select count(*) into memberships from identity.staff_facility_memberships membership
   where membership.account_id = application.first_admin_account_id
     and membership.facility_id = application.facility_id
     and membership.active and membership.migration_hold_reason is null;
  select membership.* into member from identity.staff_facility_memberships membership
   where membership.account_id = application.first_admin_account_id
     and membership.facility_id = application.facility_id
     and membership.active and membership.migration_hold_reason is null
   order by membership.id
   limit 1
   for no key update;
  if facility_row.id is null or not facility_row.active or facility_row.lifecycle_status <> 'verified'
     or organization_row.id is null or not organization_row.active
     or account_row.id is null or account_row.status <> 'active'
     or account_row.disabled_until > clock_timestamp()
     or staff_row.id is null or not staff_row.active
     or lower(staff_row.verification_status) not in ('verified', 'approved', 'active')
     or memberships <> 1 or member.id is null
     or member.staff_id is distinct from staff_row.id
     or not exists (select 1 from auth.account_roles assignment
                     where assignment.membership_id = member.id and assignment.revoked_at is null
                       and assignment.role_code = required_role) then
    raise exception using errcode = '23514', message = 'SELF_SERVICE_FACILITY_REVIEW_REQUIRES_ACTIVE';
  end if;
  return member;
end;
$$;

-- Grants the administrator's clinical role on the membership, with support's
-- platform_review attestation (verification by support at review, the
-- account's name as the person named). Returns the role row's id.
create function identity.grant_self_service_administrator_role(
  application identity.organization_applications,
  member identity.staff_facility_memberships,
  granted_role text,
  licence_body text,
  licence_number text,
  actor_account uuid,
  role_grant_reason text
) returns uuid
language plpgsql volatile
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  grant_id uuid := gen_random_uuid();
  person_name text;
begin
  insert into auth.account_roles (
    id, account_id, role_code, scope_type, membership_id, facility_id, granted_by, grant_reason
  ) values (
    grant_id, member.account_id, granted_role, 'facility', member.id, member.facility_id, actor_account,
    role_grant_reason
  );
  select btrim(left(coalesce(account.display_name, staff.full_name), 200)) into person_name
    from auth.accounts account
    left join identity.staff staff on staff.account_id = account.id
   where account.id = member.account_id;
  insert into identity.staff_licence_attestations (
    organization_id, facility_id, account_id, staff_id, membership_id, role_code, role_grant_id,
    licence_body, licence_number, attested_person_name, verification_method,
    attested_by_account_id, attestation_version, attested_at, review_application_id, correlation_id
  ) values (
    member.organization_id, member.facility_id, member.account_id, member.staff_id, member.id,
    granted_role, grant_id, licence_body, licence_number, person_name, 'platform_review',
    actor_account, 'platform-review-v1', clock_timestamp(), application.id, platform.current_correlation_id()
  );
  return grant_id;
end;
$$;

revoke all on function identity.self_service_unlock_actor(),
  identity.self_service_review_licence(identity.organization_applications,text,text,text),
  identity.lock_self_service_administrator(identity.organization_applications,text),
  identity.grant_self_service_administrator_role(identity.organization_applications,
    identity.staff_facility_memberships,text,text,text,uuid,text)
  from public;

-- Support changes the administrator's clinical access after review (S12):
-- every role row of the membership other than org_admin is revoked and the
-- new one granted (unless 'none') with support's attestation; a grant signs
-- the administrator out (S6). The same role and licence key, or 'none' to
-- 'none', answers 23505 SELF_SERVICE_ADMINISTRATOR_ROLE_UNCHANGED.
create function identity.admin_set_self_service_administrator_role(
  target_application_id uuid,
  expected_version bigint,
  requested_role text,
  administrator_licence_body text,
  administrator_licence_number text,
  requested_method text,
  change_reason text
) returns table (
  application_id uuid,
  row_version bigint,
  granted_role text,
  sessions_revoked integer
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.self_service_unlock_actor();
  reason text := btrim(coalesce(change_reason, ''));
  current_row identity.organization_applications%rowtype;
  normalized_number text;
  member identity.staff_facility_memberships%rowtype;
  previous_role text;
  previous_grant uuid;
  previous_key text;
  revoked_sessions integer := 0;
  observed timestamptz;
begin
  if target_application_id is null or expected_version is null or requested_role is null
     or requested_method is null
     or requested_method not in ('cac_registered_contact', 'officer_match', 'regulator_register', 'in_person', 'other')
     or length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_REVIEW_INVALID';
  end if;
  select app.* into current_row from identity.organization_applications app
   where app.id = target_application_id
   for no key update;
  if current_row.id is null or current_row.approval_mode <> 'self_service' or current_row.status <> 'approved'
     or current_row.reviewed_by_account_id is not null or current_row.self_service_reviewed_at is null
     or current_row.self_service_released_at is not null then
    raise exception using errcode = 'P0002', message = 'SELF_SERVICE_FACILITY_NOT_FOUND';
  end if;
  if current_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;
  normalized_number := identity.self_service_review_licence(current_row, requested_role,
    administrator_licence_body, administrator_licence_number);
  member := identity.lock_self_service_administrator(current_row, 'org_admin');
  perform 1 from auth.account_roles assignment
   where assignment.membership_id = member.id and assignment.revoked_at is null
   order by assignment.id
   for update;
  select assignment.role_code, assignment.id into previous_role, previous_grant
    from auth.account_roles assignment
   where assignment.membership_id = member.id and assignment.revoked_at is null
     and assignment.role_code <> 'org_admin'
   order by assignment.granted_at desc, assignment.id desc
   limit 1;
  select attestation.licence_key into previous_key from identity.staff_licence_attestations attestation
   where attestation.role_grant_id = previous_grant
   order by attestation.recorded_at desc, attestation.id desc
   limit 1;
  if coalesce(previous_role, 'none') = requested_role
     and (requested_role = 'none'
       or previous_key is not distinct from identity.staff_licence_key(administrator_licence_body, normalized_number)) then
    raise exception using errcode = '23505', message = 'SELF_SERVICE_ADMINISTRATOR_ROLE_UNCHANGED';
  end if;

  observed := clock_timestamp();
  update auth.account_roles assignment
     set revoked_at = observed, revoked_by = actor_account,
         revocation_reason = 'Administrator access changed by platform support',
         row_version = assignment.row_version + 1
   where assignment.membership_id = member.id and assignment.revoked_at is null
     and assignment.role_code <> 'org_admin';
  if requested_role <> 'none' then
    perform identity.grant_self_service_administrator_role(current_row, member, requested_role,
      administrator_licence_body, normalized_number, actor_account, 'Administrator access changed by platform support');
  end if;
  -- The method support used for this change is kept in the change's audit
  -- row only: self_service_verification_method stays the review's, which
  -- P4c's default listing for orders between facilities reads (H3), so a
  -- change of the administrator's own access never lists or unlists the
  -- facility.
  update identity.organization_applications app
     set self_service_granted_role = requested_role,
         updated_at = observed, row_version = app.row_version + 1
   where app.id = current_row.id
   returning app.* into current_row;
  update identity.staff_facility_memberships membership
     set updated_at = observed, row_version = membership.row_version + 1
   where membership.id = member.id;
  if requested_role <> 'none' then
    update auth.sessions session_row
       set revoked_at = observed, revocation_reason = 'facility_access_changed',
           row_version = session_row.row_version + 1
     where session_row.account_id = member.account_id and session_row.revoked_at is null;
    get diagnostics revoked_sessions = row_count;
  end if;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
    resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
    'admin.self-service-facility.administrator-role', 'success',
    'organization-application', current_row.id::text, 'healthcare-operations', reason,
    'application', 'identity-api',
    jsonb_build_object('grantedRole', requested_role, 'previousRole', coalesce(previous_role, 'none'),
      'licenceBody', administrator_licence_body, 'verificationMethod', requested_method,
      'organizationId', current_row.organization_id, 'facilityId', current_row.facility_id,
      'membershipId', member.id, 'sessionsRevoked', revoked_sessions, 'version', current_row.row_version)
  );
  insert into audit.events (
    correlation_id, actor_type, organization_id, facility_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system', current_row.organization_id, current_row.facility_id,
    'identity.facility-access.change', 'success', 'organization-application', current_row.id::text,
    'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('applicationId', current_row.id,
      'grantedRoles', case when requested_role = 'none' then jsonb_build_array('org_admin')
        else jsonb_build_array('org_admin', requested_role) end)
  );
  return query select current_row.id, current_row.row_version, requested_role, revoked_sessions;
end;
$$;

-- Support ends the first 30 days early (S2). 23505
-- SELF_SERVICE_PROBATION_ALREADY_ENDED when they have ended (early or after
-- 30 days).
create function identity.admin_end_self_service_probation(
  target_application_id uuid,
  expected_version bigint,
  end_reason text
) returns table (
  application_id uuid,
  row_version bigint,
  probation_ended_at timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.self_service_unlock_actor();
  reason text := btrim(coalesce(end_reason, ''));
  current_row identity.organization_applications%rowtype;
  observed timestamptz;
begin
  if target_application_id is null or expected_version is null or length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_REVIEW_INVALID';
  end if;
  select app.* into current_row from identity.organization_applications app
   where app.id = target_application_id
   for no key update;
  if current_row.id is null or current_row.approval_mode <> 'self_service' or current_row.status <> 'approved'
     or current_row.reviewed_by_account_id is not null or current_row.self_service_reviewed_at is null
     or current_row.self_service_released_at is not null then
    raise exception using errcode = 'P0002', message = 'SELF_SERVICE_FACILITY_NOT_FOUND';
  end if;
  if current_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;
  observed := clock_timestamp();
  if current_row.self_service_probation_ended_at is not null
     or observed >= current_row.self_service_reviewed_at + interval '30 days' then
    raise exception using errcode = '23505', message = 'SELF_SERVICE_PROBATION_ALREADY_ENDED';
  end if;
  update identity.organization_applications app
     set self_service_probation_ended_at = observed, self_service_probation_ended_by_account_id = actor_account,
         self_service_probation_end_reason = reason, updated_at = observed, row_version = app.row_version + 1
   where app.id = current_row.id
   returning app.* into current_row;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
    resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
    'admin.self-service-facility.probation-end', 'success',
    'organization-application', current_row.id::text, 'healthcare-operations', reason,
    'application', 'identity-api',
    jsonb_build_object('organizationId', current_row.organization_id, 'facilityId', current_row.facility_id,
      'version', current_row.row_version)
  );
  return query select current_row.id, current_row.row_version, current_row.self_service_probation_ended_at;
end;
$$;

-- Support's staff and licences panel for one facility: its memberships
-- (active or ended) and its invitations, with full licence numbers, the
-- licence key, how many other accounts were vouched for under the same key,
-- and whether the vouched person's name differs from the account's name
-- (S15.1). At most 500 rows, newest first. Needs platform.admin.access and
-- platform.principal.read (0027); Identity audits the read.
create function identity.admin_list_facility_staff(target_facility_id uuid)
returns table (
  kind text,
  membership_id uuid,
  invitation_id uuid,
  reference text,
  account_id uuid,
  name text,
  email text,
  roles text[],
  status text,
  licence_body text,
  licence_number text,
  licence_key text,
  same_licence_elsewhere integer,
  name_mismatch boolean,
  attested_by_account_id uuid,
  attested_by_name text,
  verification_method text,
  attested_at timestamptz,
  created_at timestamptz
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or not auth.account_has_platform_permission(actor_account, 'platform.principal.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  return query
    select listed.kind, listed.membership_id, listed.invitation_id, listed.reference, listed.account_id,
      listed.name, listed.email, listed.roles, listed.status, listed.licence_body, listed.licence_number,
      listed.licence_key,
      (select count(distinct other.account_id)::integer from identity.staff_licence_attestations other
        where other.licence_key = listed.licence_key
          and other.account_id is distinct from listed.account_id),
      listed.name_mismatch, listed.attested_by_account_id, listed.attested_by_name,
      listed.verification_method, listed.attested_at, listed.created_at
    from (
      select 'member'::text as kind, membership.id as membership_id, null::uuid as invitation_id,
        null::text as reference, membership.account_id,
        coalesce(account.display_name, staff.full_name) as name, coalesce(account.email, staff.email) as email,
        coalesce((select array_agg(assignment.role_code order by assignment.role_code)
                    from auth.account_roles assignment
                   where assignment.membership_id = membership.id and assignment.revoked_at is null),
          array[]::text[]) as roles,
        case when membership.active then 'active' else 'ended' end as status,
        latest.licence_body, latest.licence_number, latest.licence_key,
        (latest.attested_person_name is not null
          and lower(latest.attested_person_name) <> lower(coalesce(account.display_name, staff.full_name)))
          as name_mismatch,
        latest.attested_by_account_id, coalesce(attester.display_name, attester.email) as attested_by_name,
        latest.verification_method, latest.attested_at, membership.created_at
      from identity.staff_facility_memberships membership
      join identity.staff staff on staff.id = membership.staff_id
      join auth.accounts account on account.id = membership.account_id
      left join lateral (
        select attestation.* from identity.staff_licence_attestations attestation
         where attestation.membership_id = membership.id
         order by attestation.recorded_at desc, attestation.id desc
         limit 1
      ) latest on true
      left join auth.accounts attester on attester.id = latest.attested_by_account_id
      where membership.facility_id = target_facility_id
      union all
      select 'invitation'::text, null::uuid, invitation.id, invitation.reference::text,
        invitation.accepted_account_id, invitation.invitee_name, invitation.invitee_email,
        array[invitation.role_code],
        case when invitation.status = 'pending' and invitation.expires_at <= clock_timestamp() then 'expired'
          else invitation.status end,
        invitation.licence_body, invitation.licence_number,
        case when invitation.licence_body is null then null
          else identity.staff_licence_key(invitation.licence_body, invitation.licence_number) end,
        false, invitation.invited_by_account_id, coalesce(inviter.display_name, inviter.email),
        case when invitation.licence_body is null then null else 'facility_attestation' end,
        invitation.attested_at, invitation.created_at
      from identity.staff_invitations invitation
      left join auth.accounts inviter on inviter.id = invitation.invited_by_account_id
      where invitation.facility_id = target_facility_id
    ) listed
    order by listed.created_at desc, listed.kind, coalesce(listed.membership_id, listed.invitation_id)
    limit 500;
end;
$$;

-- Support finds an invitation by the reference quoted in its email (the
-- first 8 hex characters of its id, S10.4). At most 5 rows.
create function identity.admin_find_staff_invitations(requested_reference text)
returns table (
  invitation_id uuid,
  reference text,
  facility_id uuid,
  facility_name text,
  organization_id uuid,
  status text,
  role_code text,
  created_at timestamptz,
  expires_at timestamptz
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or not auth.account_has_platform_permission(actor_account, 'platform.principal.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_reference is null or requested_reference !~ '^[0-9A-Fa-f]{8}$' then
    raise exception using errcode = '22023', message = 'STAFF_INVITATION_REFERENCE_INVALID';
  end if;
  return query
    select invitation.id, invitation.reference::text, invitation.facility_id, facility.name,
      invitation.organization_id,
      case when invitation.status = 'pending' and invitation.expires_at <= clock_timestamp() then 'expired'
        else invitation.status end,
      invitation.role_code, invitation.created_at, invitation.expires_at
      from identity.staff_invitations invitation
      join identity.facilities facility on facility.id = invitation.facility_id
     where invitation.reference = upper(requested_reference)
     order by invitation.created_at desc, invitation.id desc
     limit 5;
end;
$$;

revoke all on function identity.record_self_service_administrator_licence(text,text),
  identity.list_facility_staff(),
  identity.list_facility_staff_invitations(),
  identity.facility_staff_management_state(),
  identity.create_staff_invitation(uuid,uuid,text,text,text,text,text,text,text,char,char,char,text),
  identity.record_staff_invitation_delivery(uuid,text),
  identity.resend_staff_invitation(uuid,bigint,uuid,char,char,text),
  identity.revoke_staff_invitation(uuid,bigint),
  identity.end_facility_staff_membership(uuid,bigint,text),
  identity.change_facility_staff_role(uuid,bigint,text,text,text,text,text),
  identity.open_staff_invitation(uuid,char,text,char,char),
  identity.prepare_staff_invitation_acceptance(char),
  identity.accept_staff_invitation_with_password(char,text),
  identity.preview_staff_invitation_for_account(uuid,char,char),
  identity.accept_staff_invitation_for_account(uuid,char,char),
  identity.admin_list_facility_staff(uuid),
  identity.admin_set_self_service_administrator_role(uuid,bigint,text,text,text,text,text),
  identity.admin_end_self_service_probation(uuid,bigint,text),
  identity.admin_find_staff_invitations(text)
  from public;

-- 6. Cross-facility orders (P4c; owner decisions of 2026-10-25, fifth and
-- sixth sets: "build cross-facility orders now", the doctor sends, the
-- doctor's word only). A clinician at the ordering facility (A) sends a lab
-- request or a prescription to a reviewed or governed laboratory or pharmacy
-- at another facility (B), attesting that the patient agreed, naming B; the
-- patient is told in the inbox at once and may stop it until B accepts; B
-- confirms the patient's Health ID or date of birth to accept, which creates
-- the Lab or Pharmacy work item at B bound to the route; B's members holding
-- the receive permission then work it without a consent grant, for a limited
-- time; results and dispensing come back to A as append-only reports.
-- Route states (ehr.order_routes.state; the effective state of every read
-- also turns a sent route past respond_by, and an accepted route past its
-- work window, into expired):
--   sent       sent with the attestation; B sees a preview; 7 days to accept;
--   accepted   B accepted; 30 days to work (writes_end_at = access_ends_at);
--   completed  the first released result or dispensing came back; both
--              windows become least(completed + 14 days, accepted + 45 days);
--   declined, withdrawn, expired   ended before acceptance (ended_kind);
--   cancelled  ended after acceptance: writes end now, reads 7 more days.
-- Live = sent, accepted, completed; at most one live route per order, at
-- most 5 routes per order, none after a route was ever accepted. Windows are
-- absolute hours (7 days = 168 hours), so no session time zone moves them.
-- Lock order at run time: at A, the order row FOR NO KEY UPDATE, then the
-- ordering and the receiving organization's self-service application FOR
-- SHARE (identity.lock_self_service_application), then the order's routes FOR
-- UPDATE in id order; at B, its own application FOR SHARE, then the route FOR
-- UPDATE, then the work-item and report inserts; the patient's Stop and
-- support's close take the route only; the release holds its application FOR
-- UPDATE, then the routes; a Lab release or a dispensing takes the route
-- after its own rows, never an application. No path takes a route before an
-- application or an order row, and none takes FOR UPDATE on an
-- ehr.lab_requests or ehr.encounters row while it holds a route.
-- Until 6.7 nothing here locks lab.work_items, pharmacy.work_items,
-- ehr.lab_requests, ehr.encounters, ehr.prescriptions, lab.result_releases,
-- lab.result_invalidations, pharmacy.dispensings or
-- pharmacy.dispensing_reversals: the new tables have no foreign key to them
-- until 6.7, every function that reads them is PL/pgSQL (not analysed at
-- creation), and replacing a function locks no table. 6.7 takes all nine at
-- once with a NOWAIT retry, together with platform.control_settings and
-- identity.consent_grants (which nothing before it locks either), and holds
-- them to commit.

-- 6.0 Section 5's objects this section builds on (they are created above in
-- this file; the check guards a later edit of section 5).
do $$
begin
  if to_regprocedure('identity.organization_self_service_state(uuid)') is null
     or to_regprocedure('identity.lock_self_service_application(uuid)') is null
     or to_regprocedure('identity.self_service_on_probation(uuid)') is null
     or to_regclass('identity.staff_licence_attestations') is null then
    raise exception '0086 section 6 needs section 5''s state, lock and probation functions and its licence attestations';
  end if;
end
$$;

-- 6.1 Vocabulary. Without ON CONFLICT: an existing row stops the release
-- (the preconditions in section 0 refuse it first). The restricted
-- administrator (org_admin_awaiting_review) gets none of them.
insert into auth.permissions (code, description) values
  ('ehr.order-route.send', 'Send a lab request or prescription to a laboratory or pharmacy at another facility'),
  ('lab.order-route.receive', 'Receive, accept and work lab requests other facilities send'),
  ('pharmacy.order-route.receive', 'Receive, accept and work prescriptions other facilities send');
insert into auth.role_permissions (role_code, permission_code) values
  ('doctor', 'ehr.order-route.send'),
  ('clinician', 'ehr.order-route.send'),
  ('lab', 'lab.order-route.receive'),
  ('pharmacist', 'pharmacy.order-route.receive');

-- The limits (owner-only, immutable).
create function ehr.order_route_limits()
returns table (
  sends_per_member_per_day integer,
  sends_per_pair_per_day integer,
  open_per_destination integer,
  routes_per_order integer,
  searches_per_member_per_hour integer,
  respond_days integer,
  work_days integer,
  after_completion_days integer,
  access_cap_days integer,
  read_after_cancel_days integer,
  mismatches_per_route integer,
  mismatches_per_member_per_day integer,
  mismatches_per_route_any integer
)
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select 100, 200, 500, 5, 60, 7, 30, 14, 45, 7, 5, 20, 20
$$;

-- The receive permission, the destination's organization type and the
-- kind's EHR write permission, by route kind (NULL for anything else).
create function ehr.order_route_receive_permission(requested_kind text)
returns text
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case requested_kind when 'lab_request' then 'lab.order-route.receive'
                             when 'prescription' then 'pharmacy.order-route.receive' end
$$;

create function ehr.order_route_destination_type(requested_kind text)
returns text
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case requested_kind when 'lab_request' then 'laboratory' when 'prescription' then 'pharmacy' end
$$;

create function ehr.order_route_write_permission(requested_kind text)
returns text
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case requested_kind when 'lab_request' then 'ehr.lab-request.write'
                             when 'prescription' then 'ehr.prescription.write' end
$$;

revoke all on function ehr.order_route_limits(), ehr.order_route_receive_permission(text),
  ehr.order_route_destination_type(text), ehr.order_route_write_permission(text) from public;

-- The clinician's attestation texts (T4, append-only; owner decision Q2 of
-- the sixth set: the doctor's word only). The website fills {patient},
-- {orderingFacility} and {receivingFacility}; the route stores the version
-- the clinician confirmed. The current text of a kind is its newest row.
-- The wording is the DPO's to approve before the switch-on.
create table ehr.order_route_attestation_texts (
  version text primary key check (version ~ '^order-route-(lab|prescription)-attestation-v[0-9]+$'),
  kind text not null check (kind in ('lab_request', 'prescription')),
  text text not null check (length(text) between 20 and 1000
    and position('{patient}' in text) > 0 and position('{receivingFacility}' in text) > 0),
  created_at timestamptz not null default clock_timestamp(),
  constraint order_route_attestation_texts_kind_ck check (
    (kind = 'lab_request') = (version like 'order-route-lab-%')),
  constraint order_route_attestation_texts_version_kind_uq unique (version, kind)
);
alter table ehr.order_route_attestation_texts enable row level security;
alter table ehr.order_route_attestation_texts force row level security;
create policy order_route_attestation_texts_command_read on ehr.order_route_attestation_texts
  for select using (true);
create policy order_route_attestation_texts_command_insert on ehr.order_route_attestation_texts
  for insert with check (true);
create policy order_route_attestation_texts_command_update on ehr.order_route_attestation_texts
  for update using (true) with check (true);
create policy order_route_attestation_texts_command_delete on ehr.order_route_attestation_texts
  for delete using (true);
revoke all on ehr.order_route_attestation_texts from public;
insert into ehr.order_route_attestation_texts (version, kind, text) values
  ('order-route-lab-attestation-v1', 'lab_request',
   'I confirm that {patient} agreed that {orderingFacility} sends this test request to {receivingFacility}. I told them that once {receivingFacility} accepts it, it sees their name, sex, date of birth and Health ID, the test and what I wrote about it, and sends the result back to {orderingFacility}; and that the Health ID app shows them where it went and lets them stop it until {receivingFacility} accepts it.'),
  ('order-route-prescription-attestation-v1', 'prescription',
   'I confirm that {patient} agreed that {orderingFacility} sends this prescription to {receivingFacility}. I told them that once {receivingFacility} accepts it, it sees their name, sex, date of birth and Health ID, the medicine, how to take it and my instructions, and tells {orderingFacility} what it dispensed; and that the Health ID app shows them where it went and lets them stop it until {receivingFacility} accepts it.');
create trigger order_route_attestation_texts_no_mutation
  before update or delete on ehr.order_route_attestation_texts
  for each row execute function platform.reject_mutation();

-- 6.2 The route tables. uuid keys only; forced row-level security with four
-- permissive policies (so the guard and no-mutation triggers fire for every
-- role, including an owner that does not bypass row-level security); no
-- runtime table privilege: the commands below are the only path. Foreign keys
-- to the nine clinical tables are added in 6.7.

-- T1. The route: a stable header, its snapshot of the order as sent, the
-- clinician's attestation, and the transition columns, each set once. Only
-- ehr.write_order_route_change updates it, an event first (T2).
create table ehr.order_routes (
  id uuid primary key,
  reference char(8) generated always as (upper(left(replace(id::text, '-', ''), 8))) stored,
  kind text not null check (kind in ('lab_request', 'prescription')),
  patient_id uuid not null,
  ordering_organization_id uuid not null,
  ordering_facility_id uuid not null,
  source_lab_request_id uuid,
  source_prescription_id uuid,
  source_encounter_id uuid not null,
  source_order_version bigint not null check (source_order_version > 0),
  receiving_organization_id uuid not null,
  receiving_facility_id uuid not null,
  state text not null check (state in ('sent', 'accepted', 'completed', 'declined', 'withdrawn', 'expired', 'cancelled')),
  sent_by_account_id uuid not null,
  sent_by_membership_id uuid not null,
  created_at timestamptz not null,
  respond_by timestamptz not null,
  patient_agreement text not null check (patient_agreement = 'clinician_attested'),
  attestation_text_version text not null,
  attested_by_name text not null check (attested_by_name = btrim(attested_by_name)
    and length(attested_by_name) between 2 and 200),
  attested_receiving_facility_name text not null check (
    attested_receiving_facility_name = btrim(attested_receiving_facility_name)
    and length(attested_receiving_facility_name) between 1 and 200),
  orderer_account_id uuid not null references auth.accounts(id) on delete restrict,
  orderer_membership_id uuid not null,
  orderer_name text not null check (orderer_name = btrim(orderer_name) and length(orderer_name) between 2 and 200),
  orderer_licence_body text check (orderer_licence_body is null or orderer_licence_body = 'MDCN'),
  orderer_licence_number text check (orderer_licence_number is null
    or (orderer_licence_number ~ '^[A-Z0-9][A-Z0-9/. -]{1,98}[A-Z0-9]$' and orderer_licence_number !~ '  ')),
  test_code_system text check (test_code_system is null or length(test_code_system) between 1 and 255),
  test_code text check (test_code is null or length(test_code) between 1 and 100),
  test_display text check (test_display is null or length(test_display) between 1 and 500),
  priority text check (priority is null or priority in ('routine', 'urgent', 'asap', 'stat')),
  specimen_type_code text check (specimen_type_code is null or length(specimen_type_code) <= 100),
  clinical_information text check (clinical_information is null or char_length(clinical_information) <= 4000),
  requested_at timestamptz,
  medication_code_system text check (medication_code_system is null or length(medication_code_system) <= 255),
  medication_code text check (medication_code is null or length(medication_code) <= 100),
  medication_display text check (medication_display is null or length(medication_display) between 1 and 500),
  dose_quantity numeric(12,4) check (dose_quantity is null or dose_quantity > 0),
  dose_unit text check (dose_unit is null or length(dose_unit) <= 80),
  route_code text check (route_code is null or length(route_code) <= 100),
  frequency text check (frequency is null or length(frequency) between 1 and 240),
  instructions text check (instructions is null or length(instructions) between 1 and 4000),
  starts_on date,
  ends_on date,
  prescribed_at timestamptz,
  accepted_at timestamptz,
  accepted_by_account_id uuid references auth.accounts(id) on delete restrict,
  accepted_by_membership_id uuid,
  accept_idempotency_key text check (accept_idempotency_key is null
    or accept_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  accept_request_sha256 char(64) check (accept_request_sha256 is null or accept_request_sha256 ~ '^[0-9a-f]{64}$'),
  accept_locked_at timestamptz,
  lab_work_item_id uuid,
  pharmacy_work_item_id uuid,
  declined_at timestamptz,
  declined_by_account_id uuid references auth.accounts(id) on delete restrict,
  declined_by_membership_id uuid,
  decline_reason text check (decline_reason is null or decline_reason in
    ('test_not_offered', 'medicine_unavailable', 'cannot_meet_priority', 'patient_not_seen', 'other')),
  ended_at timestamptz,
  ended_kind text check (ended_kind is null or ended_kind in ('orderer', 'patient', 'order_changed',
    'entered_in_error', 'receiving_released', 'ordering_released', 'support', 'order_in_work', 'not_accepted')),
  ended_by_account_id uuid references auth.accounts(id) on delete restrict,
  completed_at timestamptz,
  writes_end_at timestamptz,
  access_ends_at timestamptz,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  constraint order_routes_ordering_facility_fk foreign key (ordering_facility_id, ordering_organization_id)
    references identity.facilities(id, organization_id) on delete restrict,
  constraint order_routes_receiving_facility_fk foreign key (receiving_facility_id, receiving_organization_id)
    references identity.facilities(id, organization_id) on delete restrict,
  constraint order_routes_distinct_facilities_ck check (receiving_facility_id <> ordering_facility_id),
  constraint order_routes_sender_fk foreign key (sent_by_membership_id, ordering_facility_id, sent_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint order_routes_orderer_fk foreign key (orderer_membership_id, ordering_facility_id, orderer_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint order_routes_acceptor_fk foreign key (accepted_by_membership_id, receiving_facility_id, accepted_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint order_routes_decliner_fk foreign key (declined_by_membership_id, receiving_facility_id, declined_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint order_routes_attestation_text_fk foreign key (attestation_text_version, kind)
    references ehr.order_route_attestation_texts(version, kind) on delete restrict,
  constraint order_routes_idempotency_uq unique (sent_by_account_id, ordering_facility_id, idempotency_key),
  constraint order_routes_respond_by_ck check (respond_by = created_at + interval '168 hours'),
  constraint order_routes_kind_ck check (
    (kind = 'lab_request' and source_lab_request_id is not null and source_prescription_id is null
      and test_code_system is not null and test_code is not null and test_display is not null
      and priority is not null and requested_at is not null
      and medication_code_system is null and medication_code is null and medication_display is null
      and dose_quantity is null and dose_unit is null and route_code is null and frequency is null
      and instructions is null and starts_on is null and ends_on is null and prescribed_at is null
      and pharmacy_work_item_id is null)
    or (kind = 'prescription' and source_prescription_id is not null and source_lab_request_id is null
      and medication_display is not null and frequency is not null and instructions is not null
      and prescribed_at is not null
      and test_code_system is null and test_code is null and test_display is null and priority is null
      and specimen_type_code is null and clinical_information is null and requested_at is null
      and lab_work_item_id is null)),
  constraint order_routes_licence_ck check ((orderer_licence_body is null) = (orderer_licence_number is null)),
  constraint order_routes_dose_ck check ((dose_quantity is null) = (dose_unit is null)),
  constraint order_routes_dates_ck check (ends_on is null or starts_on is null or ends_on >= starts_on),
  constraint order_routes_acceptance_ck check (
    (accepted_at is null and accepted_by_account_id is null and accepted_by_membership_id is null
      and accept_idempotency_key is null and accept_request_sha256 is null
      and lab_work_item_id is null and pharmacy_work_item_id is null
      and writes_end_at is null and access_ends_at is null
      and state in ('sent', 'declined', 'withdrawn', 'expired'))
    or (accepted_at is not null and accepted_by_account_id is not null and accepted_by_membership_id is not null
      and accept_idempotency_key is not null and accept_request_sha256 is not null
      and ((kind = 'lab_request' and lab_work_item_id is not null)
        or (kind = 'prescription' and pharmacy_work_item_id is not null))
      and writes_end_at is not null and access_ends_at is not null
      and writes_end_at <= access_ends_at and access_ends_at <= accepted_at + interval '1080 hours'
      and state in ('accepted', 'completed', 'cancelled'))),
  constraint order_routes_decline_ck check (
    ((state = 'declined') = (declined_at is not null))
    and ((declined_at is null and declined_by_account_id is null and declined_by_membership_id is null
          and decline_reason is null)
      or (declined_at is not null and declined_by_account_id is not null and declined_by_membership_id is not null
          and decline_reason is not null))),
  constraint order_routes_completion_ck check ((state = 'completed') = (completed_at is not null)),
  constraint order_routes_end_ck check (
    (ended_at is null) = (ended_kind is null)
    and (ended_by_account_id is null or ended_at is not null)
    and coalesce(case state
      when 'withdrawn' then ended_kind in ('orderer', 'patient', 'order_changed', 'entered_in_error',
        'receiving_released', 'ordering_released', 'support', 'order_in_work')
      when 'expired' then ended_kind = 'not_accepted'
      when 'cancelled' then ended_kind in ('order_changed', 'entered_in_error', 'receiving_released',
        'ordering_released', 'support')
      when 'completed' then ended_kind is null or ended_kind in ('entered_in_error', 'receiving_released',
        'ordering_released', 'support')
      else ended_kind is null end, false)),
  constraint order_routes_accept_lock_ck check (accept_locked_at is null or accepted_at is null)
);
create unique index order_routes_live_lab_request_uq on ehr.order_routes (source_lab_request_id)
  where state in ('sent', 'accepted', 'completed') and source_lab_request_id is not null;
create unique index order_routes_live_prescription_uq on ehr.order_routes (source_prescription_id)
  where state in ('sent', 'accepted', 'completed') and source_prescription_id is not null;
create index order_routes_lab_request_idx on ehr.order_routes (source_lab_request_id)
  where source_lab_request_id is not null;
create index order_routes_prescription_idx on ehr.order_routes (source_prescription_id)
  where source_prescription_id is not null;
create index order_routes_receiving_idx on ehr.order_routes (receiving_facility_id, state, created_at);
create index order_routes_access_idx on ehr.order_routes (receiving_facility_id, patient_id, kind)
  where state in ('accepted', 'completed', 'cancelled');
create index order_routes_ordering_idx on ehr.order_routes (ordering_facility_id, created_at);
create index order_routes_patient_idx on ehr.order_routes (patient_id, created_at desc);
create index order_routes_sender_idx on ehr.order_routes (sent_by_membership_id, created_at);
create index order_routes_pair_idx on ehr.order_routes (ordering_facility_id, receiving_facility_id, created_at);
create index order_routes_reference_idx on ehr.order_routes (reference);
create index order_routes_lab_work_item_idx on ehr.order_routes (lab_work_item_id) where lab_work_item_id is not null;
create index order_routes_pharmacy_work_item_idx on ehr.order_routes (pharmacy_work_item_id)
  where pharmacy_work_item_id is not null;
create index order_routes_ordering_organization_idx on ehr.order_routes (ordering_organization_id);
create index order_routes_receiving_organization_idx on ehr.order_routes (receiving_organization_id);
alter table ehr.order_routes enable row level security;
alter table ehr.order_routes force row level security;
create policy order_routes_command_read on ehr.order_routes for select using (true);
create policy order_routes_command_insert on ehr.order_routes for insert with check (true);
create policy order_routes_command_update on ehr.order_routes for update using (true) with check (true);
create policy order_routes_command_delete on ehr.order_routes for delete using (true);
revoke all on ehr.order_routes from public;

-- T2. The route's events (append-only): one per version of the route, with
-- the state and windows after it. Actor ids are stored and never returned
-- across facilities.
create table ehr.order_route_events (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references ehr.order_routes(id) on delete restrict,
  event_version bigint not null check (event_version > 0),
  event_type text not null check (event_type in ('created', 'withdrawn', 'expired', 'accept_locked', 'accepted',
    'declined', 'cancelled', 'completed', 'result_returned', 'result_marked_in_error', 'dispensing_returned',
    'dispensing_reversed', 'order_changed_after_acceptance', 'order_changed_after_completion', 'access_ended')),
  side text not null check (side in ('ordering', 'receiving', 'patient', 'platform', 'system')),
  actor_account_id uuid references auth.accounts(id) on delete restrict,
  actor_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  reason_code text check (reason_code is null or reason_code ~ '^[a-z][a-z_]{1,39}$'),
  state_after text not null check (state_after in ('sent', 'accepted', 'completed', 'declined', 'withdrawn',
    'expired', 'cancelled')),
  writes_end_at_after timestamptz,
  access_ends_at_after timestamptz,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  occurred_at timestamptz not null default clock_timestamp(),
  constraint order_route_events_version_uq unique (route_id, event_version)
);
alter table ehr.order_route_events enable row level security;
alter table ehr.order_route_events force row level security;
create policy order_route_events_command_read on ehr.order_route_events for select using (true);
create policy order_route_events_command_insert on ehr.order_route_events for insert with check (true);
create policy order_route_events_command_update on ehr.order_route_events for update using (true) with check (true);
create policy order_route_events_command_delete on ehr.order_route_events for delete using (true);
revoke all on ehr.order_route_events from public;
create trigger order_route_events_no_mutation
  before update or delete on ehr.order_route_events
  for each row execute function platform.reject_mutation();

-- T3. Identification attempts at acceptance (append-only). The identifier
-- itself is never stored.
create table ehr.order_route_accept_attempts (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references ehr.order_routes(id) on delete restrict,
  receiving_facility_id uuid not null references identity.facilities(id) on delete restrict,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  identifier_kind text not null check (identifier_kind in ('health_id', 'date_of_birth')),
  outcome text not null check (outcome in ('match', 'mismatch')),
  -- Whether the attempt named this route: a Health ID (the counter finds the
  -- patient's orders by it), or a date of birth given with this route's
  -- reference (which the patient sees in the app). A date of birth alone
  -- names no route: the counter may have picked another patient's order.
  identifies_route boolean not null,
  attempted_at timestamptz not null default clock_timestamp(),
  constraint order_route_accept_attempts_identifies_ck
    check (identifies_route or identifier_kind = 'date_of_birth')
);
create index order_route_accept_attempts_route_idx on ehr.order_route_accept_attempts (route_id, outcome);
create index order_route_accept_attempts_member_idx on ehr.order_route_accept_attempts (membership_id, attempted_at);
alter table ehr.order_route_accept_attempts enable row level security;
alter table ehr.order_route_accept_attempts force row level security;
create policy order_route_accept_attempts_command_read on ehr.order_route_accept_attempts for select using (true);
create policy order_route_accept_attempts_command_insert on ehr.order_route_accept_attempts
  for insert with check (true);
create policy order_route_accept_attempts_command_update on ehr.order_route_accept_attempts
  for update using (true) with check (true);
create policy order_route_accept_attempts_command_delete on ehr.order_route_accept_attempts for delete using (true);
revoke all on ehr.order_route_accept_attempts from public;
create trigger order_route_accept_attempts_no_mutation
  before update or delete on ehr.order_route_accept_attempts
  for each row execute function platform.reject_mutation();

-- How many more wrong identifications a route takes before its acceptance
-- locks here (P2, owner Q3): 5 that named it (a Health ID, or a date of birth
-- with its reference), and at most 20 in all, counting dates of birth given
-- without the reference (an honest counter picking the wrong row of several
-- must not lock another patient's order at once, nor tell that patient it
-- could not confirm them; 20 still bounds guessing on one route).
create function ehr.order_route_attempts_left(target_route_id uuid)
returns integer
language sql stable
set search_path = pg_catalog, ehr, pg_temp
as $$
  select greatest(0, least(
      limits.mismatches_per_route - count(*) filter (where attempt.identifies_route),
      limits.mismatches_per_route_any - count(*)))::integer
    from ehr.order_route_limits() limits
    left join ehr.order_route_accept_attempts attempt
      on attempt.route_id = target_route_id and attempt.outcome = 'mismatch'
   group by limits.mismatches_per_route, limits.mismatches_per_route_any
$$;
revoke all on function ehr.order_route_attempts_left(uuid) from public;

-- T5. Results that came back to A (append-only), copied in B's transaction.
create table lab.order_route_result_reports (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references ehr.order_routes(id) on delete restrict,
  work_item_id uuid not null,
  result_id uuid not null,
  result_version bigint not null check (result_version > 0),
  kind text not null check (kind in ('released', 'entered_in_error')),
  test_code_system text not null,
  test_code text not null,
  test_name text not null,
  result_type text check (result_type is null or result_type in ('numeric', 'text')),
  numeric_value numeric,
  text_value text,
  unit text,
  reference_range text,
  abnormal_flag text,
  revision_kind text,
  correction_reason text,
  occurred_at timestamptz not null,
  performing_facility_id uuid not null references identity.facilities(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint order_route_result_reports_uq unique (result_id, result_version, kind),
  constraint order_route_result_reports_kind_ck check (
    (kind = 'released' and result_type is not null and revision_kind is not null)
    or (kind = 'entered_in_error' and result_type is null and numeric_value is null and text_value is null))
);
create index order_route_result_reports_route_idx on lab.order_route_result_reports (route_id, recorded_at);
alter table lab.order_route_result_reports enable row level security;
alter table lab.order_route_result_reports force row level security;
create policy order_route_result_reports_command_read on lab.order_route_result_reports for select using (true);
create policy order_route_result_reports_command_insert on lab.order_route_result_reports
  for insert with check (true);
create policy order_route_result_reports_command_update on lab.order_route_result_reports
  for update using (true) with check (true);
create policy order_route_result_reports_command_delete on lab.order_route_result_reports for delete using (true);
revoke all on lab.order_route_result_reports from public;
create trigger order_route_result_reports_no_mutation
  before update or delete on lab.order_route_result_reports
  for each row execute function platform.reject_mutation();

-- T6. Dispensing that came back to A (append-only).
create table pharmacy.order_route_dispensing_reports (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references ehr.order_routes(id) on delete restrict,
  work_item_id uuid not null,
  dispensing_id uuid not null,
  reversal_id uuid,
  kind text not null check (kind in ('dispensed', 'reversed')),
  medication_code_system text,
  medication_code text,
  medication_display text not null,
  quantity_dispensed numeric(12,4) not null check (quantity_dispensed > 0),
  quantity_unit text not null,
  occurred_at timestamptz not null,
  performing_facility_id uuid not null references identity.facilities(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint order_route_dispensing_reports_uq unique (dispensing_id, kind),
  constraint order_route_dispensing_reports_reversal_ck check ((kind = 'reversed') = (reversal_id is not null))
);
create index order_route_dispensing_reports_route_idx on pharmacy.order_route_dispensing_reports (route_id, recorded_at);
alter table pharmacy.order_route_dispensing_reports enable row level security;
alter table pharmacy.order_route_dispensing_reports force row level security;
create policy order_route_dispensing_reports_command_read on pharmacy.order_route_dispensing_reports
  for select using (true);
create policy order_route_dispensing_reports_command_insert on pharmacy.order_route_dispensing_reports
  for insert with check (true);
create policy order_route_dispensing_reports_command_update on pharmacy.order_route_dispensing_reports
  for update using (true) with check (true);
create policy order_route_dispensing_reports_command_delete on pharmacy.order_route_dispensing_reports
  for delete using (true);
revoke all on pharmacy.order_route_dispensing_reports from public;
create trigger order_route_dispensing_reports_no_mutation
  before update or delete on pharmacy.order_route_dispensing_reports
  for each row execute function platform.reject_mutation();

-- T7. Support's listing lever (append-only; the newest row of a facility
-- decides; without one, the default of identity.order_route_destination_listed).
create table identity.order_route_destination_settings (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null,
  organization_id uuid not null,
  listed boolean not null,
  reason text not null check (reason = btrim(reason) and length(reason) between 8 and 500),
  set_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  set_at timestamptz not null default clock_timestamp(),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  constraint order_route_destination_settings_facility_fk foreign key (facility_id, organization_id)
    references identity.facilities(id, organization_id) on delete restrict
);
create index order_route_destination_settings_facility_idx
  on identity.order_route_destination_settings (facility_id, set_at desc);
alter table identity.order_route_destination_settings enable row level security;
alter table identity.order_route_destination_settings force row level security;
create policy order_route_destination_settings_command_read on identity.order_route_destination_settings
  for select using (true);
create policy order_route_destination_settings_command_insert on identity.order_route_destination_settings
  for insert with check (true);
create policy order_route_destination_settings_command_update on identity.order_route_destination_settings
  for update using (true) with check (true);
create policy order_route_destination_settings_command_delete on identity.order_route_destination_settings
  for delete using (true);
revoke all on identity.order_route_destination_settings from public;
create trigger order_route_destination_settings_no_mutation
  before update or delete on identity.order_route_destination_settings
  for each row execute function platform.reject_mutation();

-- 6.3 Helpers (owner-only; only lab.work_item_allows and
-- pharmacy.work_item_allows, which the strict work-item policies call, are
-- granted, in section 7).

-- The staff actor of a route command: a staff session (subject, account,
-- membership and facility resolve to an active membership) with a
-- correlation ID, and, for every command that touches patient data, the
-- direct-care purpose (P10: no route command serves break-glass or another
-- purpose); else 42501.
create function ehr.order_route_staff_actor(require_direct_care boolean)
returns table (
  actor_subject text,
  actor_account_id uuid,
  actor_membership_id uuid,
  actor_facility_id uuid,
  actor_organization_id uuid
)
language plpgsql stable
set search_path = pg_catalog, ehr, identity, auth, platform, pg_temp
as $$
declare
  claimed_subject text := platform.current_actor_subject();
  claimed_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
  claimed_membership uuid := platform.current_membership_id();
  claimed_facility uuid := platform.current_facility_id();
  facility_organization uuid;
begin
  if claimed_subject is null or claimed_account is null or claimed_membership is null or claimed_facility is null
     or platform.current_correlation_id() is null
     or (require_direct_care and platform.current_purpose_of_use() is distinct from 'direct-care')
     or not identity.has_active_membership(claimed_subject, claimed_membership, claimed_facility) then
    raise exception using errcode = '42501', message = 'Order route staff context is required';
  end if;
  select facility.organization_id into facility_organization
    from identity.facilities facility where facility.id = claimed_facility;
  return query select claimed_subject, claimed_account, claimed_membership, claimed_facility, facility_organization;
end;
$$;

-- The platform actor of support's commands (as section 5's admin commands): a
-- platform administrator's subject with no facility, a correlation ID and the
-- healthcare-operations purpose, holding platform.admin.access and the named
-- permissions; else 42501 ADMIN_PERMISSION_DENIED.
create function identity.order_route_platform_actor(required_permissions text[])
returns uuid
language plpgsql stable
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  claimed_account uuid := platform.current_account_id();
  required text;
begin
  if claimed_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(claimed_account, 'platform.admin.access') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  foreach required in array required_permissions loop
    if not auth.account_has_platform_permission(claimed_account, required) then
      raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
    end if;
  end loop;
  return claimed_account;
end;
$$;

-- H3. Whether support lists a facility for orders from other facilities: the
-- newest setting (T7) if any; else a governed facility (no self-service
-- application) is listed, and a self-signed-up one only when support's
-- review recorded a real check (P6; 'other' is not listed by default).
create function identity.order_route_destination_listed(target_facility_id uuid)
returns boolean
language sql stable
set search_path = pg_catalog, identity, pg_temp
as $$
  select coalesce(
    (select setting.listed
       from identity.order_route_destination_settings setting
      where setting.facility_id = target_facility_id
      order by setting.set_at desc, setting.id desc
      limit 1),
    (select coalesce(application.id is null
          or application.self_service_verification_method in
            ('cac_registered_contact', 'officer_match', 'regulator_register', 'in_person'), false)
       from identity.facilities facility
       left join lateral (
         select candidate.id, candidate.self_service_verification_method
           from identity.organization_applications candidate
          where candidate.organization_id = facility.organization_id
            and candidate.approval_mode = 'self_service'
            and candidate.reviewed_by_account_id is null
            and (candidate.status = 'approved' or candidate.self_service_released_at is not null)
          order by candidate.reviewed_at desc, candidate.id desc
          limit 1) application on true
      where facility.id = target_facility_id),
    false)
$$;

-- H4. Whether a facility may receive a route of this kind now: active and
-- verified with an active organization; reviewed (self-service) or governed
-- (an approved admin_review application and no self-service one; pending,
-- released and legacy organizations are refused); an active product at this
-- facility whose source application is approved as a laboratory (lab
-- requests) or pharmacy (prescriptions); listed (H3); and at least one active
-- member holding the kind's receive permission. That it is not the ordering
-- facility is the caller's check (and T1's). Callers lock the receiving
-- organization's application FOR SHARE first.
create function identity.order_route_destination_eligible(target_facility_id uuid, requested_kind text)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, ehr, pg_temp
as $$
declare
  destination_type text := ehr.order_route_destination_type(requested_kind);
  receive_permission text := ehr.order_route_receive_permission(requested_kind);
  facility_row identity.facilities%rowtype;
  found_state text;
begin
  if target_facility_id is null or destination_type is null then
    return false;
  end if;
  select facility.* into facility_row from identity.facilities facility where facility.id = target_facility_id;
  if facility_row.id is null or not facility_row.active or facility_row.lifecycle_status <> 'verified'
     or not exists (select 1 from identity.organizations organization
                     where organization.id = facility_row.organization_id and organization.active) then
    return false;
  end if;
  select state_row.review_state into found_state
    from identity.organization_self_service_state(facility_row.organization_id) state_row;
  if found_state is not null then
    if found_state <> 'reviewed' then
      return false;
    end if;
  elsif not exists (select 1 from identity.organization_applications governed
                     where governed.organization_id = facility_row.organization_id
                       and governed.approval_mode = 'admin_review'
                       and governed.status = 'approved') then
    return false;
  end if;
  if not exists (select 1 from identity.organization_products product
                   join identity.organization_applications source_application
                     on source_application.id = product.source_application_id
                  where product.facility_id = target_facility_id
                    and product.organization_id = facility_row.organization_id
                    and product.status = 'active'
                    and source_application.status = 'approved'
                    and source_application.organization_type = destination_type) then
    return false;
  end if;
  if not identity.order_route_destination_listed(target_facility_id) then
    return false;
  end if;
  return exists (
    select 1
      from identity.staff_facility_memberships membership
      join auth.accounts account on account.id = membership.account_id
     where membership.facility_id = target_facility_id
       and membership.active
       and auth.membership_has_permission(account.subject, membership.id, target_facility_id, receive_permission));
end;
$$;

-- H5. An active deny directive of the patient that names the facility, its
-- organization or everyone, for read_records under direct-care (the clause of
-- identity.has_active_consent_grant, 0012). Checked at send and acceptance.
create function identity.patient_denies_order_route(target_patient_id uuid, target_facility_id uuid)
returns boolean
language sql stable
set search_path = pg_catalog, identity, pg_temp
as $$
  select exists (
    select 1
      from identity.consent_directives directive
      join identity.consent_directive_versions directive_version
        on directive_version.directive_id = directive.id
       and directive_version.version_no = directive.current_version
      join identity.facilities facility on facility.id = target_facility_id
     where directive.patient_id = target_patient_id
       and directive_version.status = 'active'
       and directive_version.provision_type = 'deny'
       and directive_version.starts_at <= clock_timestamp()
       and (directive_version.expires_at is null or directive_version.expires_at > clock_timestamp())
       and (directive_version.facility_id is null or directive_version.facility_id = target_facility_id)
       and (cardinality(directive_version.actions) = 0 or 'read_records' = any(directive_version.actions))
       and (cardinality(directive_version.purposes) = 0 or 'direct-care' = any(directive_version.purposes))
       and (directive_version.grantee_type = 'all'
         or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = target_facility_id)
         or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = facility.organization_id)))
$$;

-- H9. The effective state of a route: a sent route past respond_by, or an
-- accepted route past its work window with nothing returned, is expired.
create function ehr.order_route_effective_state(route ehr.order_routes)
returns text
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when route.state = 'sent' and clock_timestamp() >= route.respond_by then 'expired'
    when route.state = 'accepted' and clock_timestamp() >= route.writes_end_at then 'expired'
    else route.state end
$$;

-- The route-access control, read so that an unreadable control fails closed
-- (an owner that cannot read platform.control_settings, or a missing row).
create function ehr.order_route_access_open()
returns boolean
language plpgsql stable
set search_path = pg_catalog, platform, pg_temp
as $$
begin
  return coalesce(platform.control_enabled('cross_facility_route_access_enabled'), false);
exception when object_not_in_prerequisite_state or invalid_parameter_value then
  return false;
end;
$$;

-- H6. Route access to a patient's rows at a receiving facility, for the Lab
-- and Pharmacy chain tables (lab.context_allows and pharmacy.context_allows):
-- direct-care; a route of that kind for this patient at this facility that
-- allows the action now (write: accepted or completed, before writes_end_at;
-- read: also cancelled, before access_ends_at); the route-access control on;
-- the member holding the kind's receive permission. In this order (FEAS A2):
-- the indexed route lookup first, the control and permission only when a
-- route exists.
create function ehr.order_route_access_allows(requested_kind text, row_patient_id uuid, row_facility_id uuid,
  requested_action text)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, ehr, auth, platform, pg_temp
as $$
begin
  if platform.current_purpose_of_use() is distinct from 'direct-care'
     or not coalesce(requested_action in ('read_records', 'write_records'), false)
     or row_patient_id is null or row_facility_id is null then
    return false;
  end if;
  if not exists (
    select 1 from ehr.order_routes route
     where route.receiving_facility_id = row_facility_id
       and route.patient_id = row_patient_id
       and route.kind = requested_kind
       and route.state in ('accepted', 'completed', 'cancelled')
       and ((requested_action = 'write_records' and route.state in ('accepted', 'completed')
             and clock_timestamp() < route.writes_end_at)
         or (requested_action = 'read_records' and clock_timestamp() < route.access_ends_at))) then
    return false;
  end if;
  if not ehr.order_route_access_open() then
    return false;
  end if;
  return auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
    row_facility_id, ehr.order_route_receive_permission(requested_kind));
end;
$$;

-- H7. The same for one route (the work-item policies, the cards and the
-- resource check): the route at this facility, which is the session's.
create function ehr.order_route_allows(requested_route_id uuid, row_facility_id uuid, requested_action text)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, ehr, auth, platform, pg_temp
as $$
declare
  route_kind text;
begin
  if platform.current_purpose_of_use() is distinct from 'direct-care'
     or not coalesce(requested_action in ('read_records', 'write_records'), false)
     or requested_route_id is null or row_facility_id is null
     or row_facility_id is distinct from platform.current_facility_id() then
    return false;
  end if;
  select route.kind into route_kind
    from ehr.order_routes route
   where route.id = requested_route_id
     and route.receiving_facility_id = row_facility_id
     and route.state in ('accepted', 'completed', 'cancelled')
     and ((requested_action = 'write_records' and route.state in ('accepted', 'completed')
           and clock_timestamp() < route.writes_end_at)
       or (requested_action = 'read_records' and clock_timestamp() < route.access_ends_at));
  if route_kind is null or not ehr.order_route_access_open() then
    return false;
  end if;
  return auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
    row_facility_id, ehr.order_route_receive_permission(route_kind));
end;
$$;

-- H8. The strict work-item policies: the session's facility and either the
-- member's own consent grant or, for a route-backed item, its route (H7).
-- Granted to the Lab and Pharmacy runtimes and the schema test runtime, whose
-- queries evaluate the policies.
create function lab.work_item_allows(row_patient_id uuid, row_facility_id uuid, row_route_id uuid,
  requested_action text)
returns boolean
language sql stable security definer
set search_path = lab, identity, platform, pg_temp
as $$
  select row_facility_id = platform.current_facility_id()
    and (identity.has_active_consent_grant(row_patient_id, platform.current_actor_subject(),
          platform.current_membership_id(), row_facility_id, requested_action, platform.current_purpose_of_use())
      or (row_route_id is not null and ehr.order_route_allows(row_route_id, row_facility_id, requested_action)))
$$;

create function pharmacy.work_item_allows(row_patient_id uuid, row_facility_id uuid, row_route_id uuid,
  requested_action text)
returns boolean
language sql stable security definer
set search_path = pharmacy, identity, platform, pg_temp
as $$
  select row_facility_id = platform.current_facility_id()
    and (identity.has_active_consent_grant(row_patient_id, platform.current_actor_subject(),
          platform.current_membership_id(), row_facility_id, requested_action, platform.current_purpose_of_use())
      or (row_route_id is not null and ehr.order_route_allows(row_route_id, row_facility_id, requested_action)))
$$;

-- H10. The only writer of a route after its insert: the event first (its
-- version, the state and windows after it, the session's actor), then the
-- route itself, which the guard (order_routes_guard) checks against that
-- event. The caller holds the route FOR UPDATE and passes the row as read and
-- the row as it should become.
create function ehr.write_order_route_change(current_route ehr.order_routes, changed_route ehr.order_routes,
  change_event text, change_side text, change_reason_code text)
returns ehr.order_routes
language plpgsql volatile
set search_path = pg_catalog, ehr, platform, pg_temp
as $$
declare
  written ehr.order_routes%rowtype;
begin
  insert into ehr.order_route_events (route_id, event_version, event_type, side, actor_account_id,
    actor_membership_id, reason_code, state_after, writes_end_at_after, access_ends_at_after, correlation_id)
  values (current_route.id, current_route.row_version + 1, change_event, change_side, platform.current_account_id(),
    platform.current_membership_id(), change_reason_code, changed_route.state, changed_route.writes_end_at,
    changed_route.access_ends_at, platform.current_correlation_id());
  update ehr.order_routes route
     set state = changed_route.state,
         accepted_at = changed_route.accepted_at,
         accepted_by_account_id = changed_route.accepted_by_account_id,
         accepted_by_membership_id = changed_route.accepted_by_membership_id,
         accept_idempotency_key = changed_route.accept_idempotency_key,
         accept_request_sha256 = changed_route.accept_request_sha256,
         accept_locked_at = changed_route.accept_locked_at,
         lab_work_item_id = changed_route.lab_work_item_id,
         pharmacy_work_item_id = changed_route.pharmacy_work_item_id,
         declined_at = changed_route.declined_at,
         declined_by_account_id = changed_route.declined_by_account_id,
         declined_by_membership_id = changed_route.declined_by_membership_id,
         decline_reason = changed_route.decline_reason,
         ended_at = changed_route.ended_at,
         ended_kind = changed_route.ended_kind,
         ended_by_account_id = changed_route.ended_by_account_id,
         completed_at = changed_route.completed_at,
         writes_end_at = changed_route.writes_end_at,
         access_ends_at = changed_route.access_ends_at,
         updated_at = clock_timestamp(),
         row_version = route.row_version + 1
   where route.id = current_route.id
     and route.row_version = current_route.row_version
  returning route.* into written;
  if written.id is null then
    raise exception using errcode = '40001', message = 'Order route changed concurrently';
  end if;
  return written;
end;
$$;

-- H11. A system audit row at one side's facility (ordering or receiving),
-- about the route; patient_id only when with_patient (P4.1: never on a row at
-- B about a route B has not accepted); details carry ids and codes only.
create function ehr.order_route_system_audit(route ehr.order_routes, audit_side text, audit_action text,
  with_patient boolean, audit_details jsonb)
returns void
language plpgsql volatile
set search_path = pg_catalog, ehr, audit, platform, pg_temp
as $$
begin
  insert into audit.events (correlation_id, actor_type, organization_id, facility_id, patient_id, action, outcome,
    resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'system',
    case audit_side when 'ordering' then route.ordering_organization_id else route.receiving_organization_id end,
    case audit_side when 'ordering' then route.ordering_facility_id else route.receiving_facility_id end,
    case when with_patient then route.patient_id end,
    audit_action, 'success', 'order-route', route.id::text, platform.current_purpose_of_use(),
    'application', 'ehr-api',
    jsonb_build_object('routeId', route.id, 'kind', route.kind, 'state', route.state)
      || coalesce(audit_details, '{}'::jsonb));
end;
$$;

-- H12. The patient's inbox notice: codes and facility names only (0037).
create function ehr.order_route_notify_patient(route ehr.order_routes, notification_code text)
returns uuid
language plpgsql volatile
set search_path = pg_catalog, ehr, identity, notification, pg_temp
as $$
begin
  return notification.enqueue_patient_inbox_item(route.patient_id, notification_code, 'order-route', route.id,
    jsonb_build_object('routeId', route.id, 'kind', route.kind,
      'orderingFacilityName', (select facility.name from identity.facilities facility
                                where facility.id = route.ordering_facility_id),
      'receivingFacilityName', (select facility.name from identity.facilities facility
                                 where facility.id = route.receiving_facility_id)));
end;
$$;

-- H13. What B sees of the patient after acceptance: name, sex, date of birth
-- and the last 4 characters of the Health ID.
create function ehr.order_route_patient_card(target_patient_id uuid)
returns table (full_name text, sex text, date_of_birth date, health_id_last4 text)
language sql stable
set search_path = pg_catalog, identity, pg_temp
as $$
  select patient.full_name, patient.gender, patient.dob, right(patient.hid_code, 4)
    from identity.patients patient
   where patient.id = target_patient_id
$$;

-- H14. Closing a route (the release, support, and the mirror for an
-- entered-in-error order): locks it, then sent -> withdrawn (or expired when
-- past respond_by), accepted -> cancelled (writes end now; reads end now, or
-- in 7 days unless end_access_now), completed -> its windows end now
-- (access_ended, only with end_access_now). Answers what happened:
-- withdrawn, expired, cancelled, access_ended or unchanged.
create function ehr.close_order_route(target_route_id uuid, close_kind text, close_side text, end_access_now boolean)
returns table (outcome text, closed ehr.order_routes)
language plpgsql volatile
set search_path = pg_catalog, ehr, platform, pg_temp
as $$
declare
  current_route ehr.order_routes%rowtype;
  changed_route ehr.order_routes%rowtype;
  closed_at timestamptz := clock_timestamp();
begin
  select route.* into current_route from ehr.order_routes route where route.id = target_route_id for update;
  if current_route.id is null then
    return query select 'unchanged'::text, current_route;
    return;
  end if;
  changed_route := current_route;
  if current_route.state = 'sent' then
    changed_route.ended_at := closed_at;
    changed_route.ended_by_account_id := platform.current_account_id();
    if closed_at >= current_route.respond_by then
      changed_route.state := 'expired';
      changed_route.ended_kind := 'not_accepted';
      changed_route.ended_by_account_id := null;
      return query select 'expired'::text,
        ehr.write_order_route_change(current_route, changed_route, 'expired', 'system', 'not_accepted');
      return;
    end if;
    changed_route.state := 'withdrawn';
    changed_route.ended_kind := close_kind;
    return query select 'withdrawn'::text,
      ehr.write_order_route_change(current_route, changed_route, 'withdrawn', close_side, close_kind);
    return;
  end if;
  if current_route.state = 'accepted' then
    changed_route.state := 'cancelled';
    changed_route.ended_at := closed_at;
    changed_route.ended_kind := close_kind;
    changed_route.ended_by_account_id := platform.current_account_id();
    changed_route.writes_end_at := least(current_route.writes_end_at, closed_at);
    changed_route.access_ends_at := case when end_access_now then least(current_route.access_ends_at, closed_at)
      else least(current_route.access_ends_at, closed_at + interval '168 hours') end;
    changed_route.writes_end_at := least(changed_route.writes_end_at, changed_route.access_ends_at);
    return query select 'cancelled'::text,
      ehr.write_order_route_change(current_route, changed_route, 'cancelled', close_side, close_kind);
    return;
  end if;
  if current_route.state = 'completed' and end_access_now and current_route.ended_at is null then
    changed_route.ended_at := closed_at;
    changed_route.ended_kind := close_kind;
    changed_route.ended_by_account_id := platform.current_account_id();
    changed_route.writes_end_at := least(current_route.writes_end_at, closed_at);
    changed_route.access_ends_at := least(current_route.access_ends_at, closed_at);
    return query select 'access_ended'::text,
      ehr.write_order_route_change(current_route, changed_route, 'access_ended', close_side, close_kind);
    return;
  end if;
  return query select 'unchanged'::text, current_route;
end;
$$;

-- H15. A route's events for the ordering facility: type, side, time, reason
-- and state after; never an actor.
create function ehr.order_route_events_view(target_route_id uuid)
returns jsonb
language sql stable
set search_path = pg_catalog, ehr, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('type', event.event_type, 'side', event.side,
           'occurredAt', event.occurred_at, 'reasonCode', event.reason_code, 'stateAfter', event.state_after)
           order by event.event_version), '[]'::jsonb)
    from ehr.order_route_events event
   where event.route_id = target_route_id
$$;

-- Whether the order may be sent again: no live route (effective), none ever
-- accepted, no same-facility work item, fewer than 5 routes.
create function ehr.order_route_resend_allowed(requested_kind text, requested_order_id uuid)
returns boolean
language plpgsql stable
set search_path = pg_catalog, ehr, lab, pharmacy, pg_temp
as $$
declare
  route_count integer;
  blocked boolean;
begin
  select count(*), coalesce(bool_or(route.accepted_at is not null
           or ehr.order_route_effective_state(route) in ('sent', 'accepted', 'completed')), false)
    into route_count, blocked
    from ehr.order_routes route
   where (requested_kind = 'lab_request' and route.source_lab_request_id = requested_order_id)
      or (requested_kind = 'prescription' and route.source_prescription_id = requested_order_id);
  if blocked or route_count >= (select limits.routes_per_order from ehr.order_route_limits() limits) then
    return false;
  end if;
  if requested_kind = 'lab_request' then
    return not exists (select 1 from lab.work_items item where item.source_ehr_order_id = requested_order_id);
  end if;
  return not exists (select 1 from pharmacy.work_items item where item.source_ehr_prescription_id = requested_order_id);
end;
$$;

-- The ordering facility's summary of one route (OrderRouteSummary, camelCase).
create function ehr.order_route_summary(route ehr.order_routes, resend_allowed boolean)
returns jsonb
language sql stable
set search_path = pg_catalog, ehr, identity, pg_temp
as $$
  select jsonb_build_object('id', route.id, 'reference', route.reference, 'kind', route.kind,
    'version', route.row_version, 'effectiveState', ehr.order_route_effective_state(route),
    'receivingFacility', jsonb_build_object('id', route.receiving_facility_id,
      'name', (select facility.name from identity.facilities facility where facility.id = route.receiving_facility_id),
      'available', identity.order_route_destination_eligible(route.receiving_facility_id, route.kind)),
    'createdAt', route.created_at, 'respondBy', route.respond_by, 'acceptedAt', route.accepted_at,
    'completedAt', route.completed_at, 'endedAt', route.ended_at, 'endedKind', route.ended_kind,
    'declineReason', route.decline_reason, 'acceptLocked', route.accept_locked_at is not null,
    'resendAllowed', resend_allowed)
$$;

-- The receiving facility's registered office (the CAC registered address of
-- its organization, owner decision Q8), or NULL.
create function identity.order_route_registered_address(target_facility_id uuid)
returns text
language sql stable
set search_path = pg_catalog, identity, pg_temp
as $$
  select registration.verified_address
    from identity.facilities facility
    join identity.organization_cac_registrations registration
      on registration.organization_id = facility.organization_id
   where facility.id = target_facility_id
   order by (registration.primary_facility_id = facility.id) desc, registration.created_at, registration.cac_registration_number
   limit 1
$$;

revoke all on function ehr.order_route_staff_actor(boolean),
  identity.order_route_platform_actor(text[]),
  identity.order_route_destination_listed(uuid),
  identity.order_route_destination_eligible(uuid,text),
  identity.patient_denies_order_route(uuid,uuid),
  ehr.order_route_effective_state(ehr.order_routes),
  ehr.order_route_access_open(),
  ehr.order_route_access_allows(text,uuid,uuid,text),
  ehr.order_route_allows(uuid,uuid,text),
  lab.work_item_allows(uuid,uuid,uuid,text),
  pharmacy.work_item_allows(uuid,uuid,uuid,text),
  ehr.write_order_route_change(ehr.order_routes,ehr.order_routes,text,text,text),
  ehr.order_route_system_audit(ehr.order_routes,text,text,boolean,jsonb),
  ehr.order_route_notify_patient(ehr.order_routes,text),
  ehr.order_route_patient_card(uuid),
  ehr.close_order_route(uuid,text,text,boolean),
  ehr.order_route_events_view(uuid),
  ehr.order_route_resend_allowed(text,uuid),
  ehr.order_route_summary(ehr.order_routes,boolean),
  identity.order_route_registered_address(uuid)
  from public;

-- 6.4 Commands. Conventions as section 5: business refusals raise P0001 with
-- the API code as the message; 42501 for permission or context; P0002 for
-- not found (also "not addressed to your facility"); 22023 for invalid input;
-- 55000 PLATFORM_CONTROL_DISABLED:<key> from platform.require_control_enabled;
-- a stale route version is P0001 ORDER_ROUTE_VERSION_CONFLICT (staff and
-- patient routes) or 40001 (support's close, section 5's admin convention).
-- Refusals that must keep a counter or a state (an identification mismatch,
-- the acceptance lock, order_in_work) answer a result instead of raising.
-- A refusal raises, so it stores nothing: a route that lapsed is shown
-- expired by every read and stored expired by the next command that
-- succeeds on it or its order.

-- 6.4.1 EHR (the ordering facility; EXECUTE to the EHR runtime).

-- C24. The current attestation text of a kind, for the send screen.
create function ehr.order_route_sender_check(requested_kind text)
returns void
language plpgsql stable
set search_path = pg_catalog, ehr, auth, platform, pg_temp
as $$
declare
  actor record;
  write_permission text := ehr.order_route_write_permission(requested_kind);
begin
  select * into actor from ehr.order_route_staff_actor(true);
  if not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id, actor.actor_facility_id,
           'ehr.order-route.send')
     or (write_permission is not null
       and not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id, actor.actor_facility_id,
             write_permission)) then
    raise exception using errcode = '42501', message = 'ORDER_ROUTE_PERMISSION_DENIED';
  end if;
  if write_permission is null then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
end;
$$;

create function ehr.order_route_attestation_text(requested_kind text)
returns table (version text, text text)
language sql volatile security definer
set search_path = pg_catalog, ehr, platform, pg_temp
as $$
  select ehr.order_route_sender_check(requested_kind);
  select platform.require_control_enabled('cross_facility_orders_enabled');
  select text_row.version, text_row.text
    from ehr.order_route_attestation_texts text_row
   where text_row.kind = requested_kind
   order by text_row.created_at desc, text_row.version desc
   limit 1;
$$;

-- C1. Send an order: refusals in the order listed; then a draft is activated,
-- the route is inserted sent with the order's snapshot and the clinician's
-- attestation, event 1 is written, B gets a system row without the patient,
-- and the patient's inbox gets ORDER_ROUTE_SENT.
create function ehr.send_order_route(
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
     or not identity.order_route_destination_eligible(receiving_facility.id, requested_kind) then
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

-- The ordering side's lookup of one route of an order at the session
-- facility (C2), locked FOR UPDATE.
create function ehr.lock_ordering_route(requested_route_id uuid, requested_kind text, requested_order_id uuid,
  ordering_facility uuid)
returns ehr.order_routes
language plpgsql volatile
set search_path = pg_catalog, ehr, pg_temp
as $$
declare
  locked ehr.order_routes%rowtype;
begin
  select route.* into locked
    from ehr.order_routes route
   where route.id = requested_route_id
     and route.kind = requested_kind
     and route.ordering_facility_id = ordering_facility
     and ((requested_kind = 'lab_request' and route.source_lab_request_id = requested_order_id)
       or (requested_kind = 'prescription' and route.source_prescription_id = requested_order_id))
   for update;
  if locked.id is null then
    raise exception using errcode = 'P0002', message = 'ORDER_ROUTE_NOT_FOUND';
  end if;
  return locked;
end;
$$;

-- C2. The orderer withdraws a sent route: any member at A holding
-- ehr.order-route.send, no consent needed (it discloses nothing, P7.1). It
-- answers the route's patient too: the EHR reads nothing under consent here,
-- so it checks the path's patient against this one before its audit row
-- names a patient (a mismatch rolls the withdrawal back).
create function ehr.withdraw_order_route(
  requested_route_id uuid,
  requested_kind text,
  requested_order_id uuid,
  expected_version bigint,
  requested_reason text
) returns table (row_version bigint, state text, ended_at timestamptz, patient_id uuid)
language plpgsql security definer
set search_path = pg_catalog, ehr, identity, auth, notification, platform, pg_temp
as $$
declare
  actor record;
  current_route ehr.order_routes%rowtype;
  changed ehr.order_routes%rowtype;
  written ehr.order_routes%rowtype;
begin
  select * into actor from ehr.order_route_staff_actor(true);
  if not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id, actor.actor_facility_id,
           'ehr.order-route.send') then
    raise exception using errcode = '42501', message = 'ORDER_ROUTE_PERMISSION_DENIED';
  end if;
  if not coalesce(requested_kind in ('lab_request', 'prescription'), false)
     or not coalesce(requested_reason in ('sent_in_error', 'patient_request', 'other'), false)
     or requested_route_id is null or requested_order_id is null or expected_version is null then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  current_route := ehr.lock_ordering_route(requested_route_id, requested_kind, requested_order_id,
    actor.actor_facility_id);
  if current_route.row_version <> expected_version then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_VERSION_CONFLICT';
  end if;
  if current_route.state <> 'sent' or clock_timestamp() >= current_route.respond_by then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_NOT_PENDING';
  end if;
  changed := current_route;
  changed.state := 'withdrawn';
  changed.ended_at := clock_timestamp();
  changed.ended_kind := 'orderer';
  changed.ended_by_account_id := actor.actor_account_id;
  written := ehr.write_order_route_change(current_route, changed, 'withdrawn', 'ordering', requested_reason);
  perform ehr.order_route_system_audit(written, 'receiving', 'ehr.order-route.withdrawn', false, null);
  perform ehr.order_route_notify_patient(written, 'ORDER_ROUTE_WITHDRAWN');
  return query select written.row_version, written.state, written.ended_at, written.patient_id;
end;
$$;

-- The ordering side's read check (C3, C4): direct-care, the order the
-- patient's at the session facility, and the member's read consent there.
create function ehr.order_route_reader(requested_kind text, requested_patient_id uuid)
returns uuid
language plpgsql stable
set search_path = pg_catalog, ehr, platform, pg_temp
as $$
declare
  actor record;
begin
  select * into actor from ehr.order_route_staff_actor(true);
  if not coalesce(requested_kind in ('lab_request', 'prescription'), false) or requested_patient_id is null then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  if not ehr.context_allows(requested_patient_id, actor.actor_facility_id, 'read_records') then
    raise exception using errcode = 'P0002', message = 'ORDER_NOT_FOUND';
  end if;
  return actor.actor_facility_id;
end;
$$;

create function ehr.order_belongs_to(requested_kind text, requested_patient_id uuid, requested_order_id uuid,
  ordering_facility uuid)
returns boolean
language plpgsql stable
set search_path = pg_catalog, ehr, pg_temp
as $$
begin
  if requested_kind = 'lab_request' then
    return exists (select 1 from ehr.lab_requests source_order
                    where source_order.id = requested_order_id and source_order.patient_id = requested_patient_id
                      and source_order.facility_id = ordering_facility);
  end if;
  return exists (select 1 from ehr.prescriptions source_order
                  where source_order.id = requested_order_id and source_order.patient_id = requested_patient_id
                    and source_order.facility_id = ordering_facility);
end;
$$;

-- C3. The routes of one order for its row (newest first, at most 10): the
-- summary, the attestation, whether the receiving facility is available
-- now, the events (no actors) and what came back.
create function ehr.list_order_routes_for_order(requested_kind text, requested_patient_id uuid,
  requested_order_id uuid)
returns table (
  route_id uuid,
  summary jsonb,
  attestation jsonb,
  receiving_available boolean,
  events jsonb,
  reports jsonb
)
language plpgsql stable security definer
set search_path = pg_catalog, ehr, identity, lab, pharmacy, platform, pg_temp
as $$
declare
  ordering_facility uuid := ehr.order_route_reader(requested_kind, requested_patient_id);
  resend boolean;
begin
  if not ehr.order_belongs_to(requested_kind, requested_patient_id, requested_order_id, ordering_facility) then
    raise exception using errcode = 'P0002', message = 'ORDER_NOT_FOUND';
  end if;
  resend := ehr.order_route_resend_allowed(requested_kind, requested_order_id);
  return query
    select route.id, ehr.order_route_summary(route, resend),
      jsonb_build_object('textVersion', route.attestation_text_version, 'attestedByName', route.attested_by_name,
        'attestedAt', route.created_at, 'receivingFacilityName', route.attested_receiving_facility_name),
      identity.order_route_destination_eligible(route.receiving_facility_id, route.kind),
      ehr.order_route_events_view(route.id),
      case when route.kind = 'lab_request' then
        (select coalesce(jsonb_agg(jsonb_build_object('resultId', report.result_id,
            'resultVersion', report.result_version, 'kind', report.kind,
            'test', jsonb_build_object('codeSystem', report.test_code_system, 'code', report.test_code,
              'name', report.test_name),
            'resultType', report.result_type, 'numericValue', report.numeric_value, 'textValue', report.text_value,
            'unit', report.unit, 'referenceRange', report.reference_range, 'abnormalFlag', report.abnormal_flag,
            'revisionKind', report.revision_kind, 'correctionReason', report.correction_reason,
            'occurredAt', report.occurred_at) order by report.recorded_at, report.id), '[]'::jsonb)
           from lab.order_route_result_reports report where report.route_id = route.id)
      else
        (select coalesce(jsonb_agg(jsonb_build_object('dispensingId', report.dispensing_id, 'kind', report.kind,
            'medication', jsonb_build_object('codeSystem', report.medication_code_system,
              'code', report.medication_code, 'display', report.medication_display),
            'quantityDispensed', report.quantity_dispensed, 'quantityUnit', report.quantity_unit,
            'occurredAt', report.occurred_at) order by report.recorded_at, report.id), '[]'::jsonb)
           from pharmacy.order_route_dispensing_reports report where report.route_id = route.id)
      end
      from ehr.order_routes route
     where route.ordering_facility_id = ordering_facility
       and ((requested_kind = 'lab_request' and route.source_lab_request_id = requested_order_id)
         or (requested_kind = 'prescription' and route.source_prescription_id = requested_order_id))
     order by route.created_at desc, route.id desc
     limit 10;
end;
$$;

-- C4. The latest route's summary for each order of a list (at most 200
-- orders, all the patient's at the session facility): one row per requested
-- order, summary NULL when it has none.
create function ehr.order_route_summaries(requested_kind text, requested_patient_id uuid,
  requested_order_ids uuid[])
returns table (order_id uuid, summary jsonb)
language plpgsql stable security definer
set search_path = pg_catalog, ehr, identity, lab, pharmacy, platform, pg_temp
as $$
declare
  ordering_facility uuid := ehr.order_route_reader(requested_kind, requested_patient_id);
  requested uuid;
begin
  if requested_order_ids is null or cardinality(requested_order_ids) > 200
     or array_position(requested_order_ids, null) is not null then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  foreach requested in array requested_order_ids loop
    if not ehr.order_belongs_to(requested_kind, requested_patient_id, requested, ordering_facility) then
      raise exception using errcode = 'P0002', message = 'ORDER_NOT_FOUND';
    end if;
  end loop;
  return query
    select requested_order.id,
      (select ehr.order_route_summary(route, ehr.order_route_resend_allowed(requested_kind, requested_order.id))
         from ehr.order_routes route
        where route.ordering_facility_id = ordering_facility
          and ((requested_kind = 'lab_request' and route.source_lab_request_id = requested_order.id)
            or (requested_kind = 'prescription' and route.source_prescription_id = requested_order.id))
        order by route.created_at desc, route.id desc
        limit 1)
      from (select distinct unnest(requested_order_ids) as id) requested_order;
end;
$$;

-- The patient of a patient-self session (C5, C6), else 42501.
create function ehr.order_route_patient()
returns uuid
language plpgsql stable
set search_path = pg_catalog, ehr, pg_temp
as $$
declare
  claimed text := nullif(current_setting('app.patient_id', true), '');
begin
  if claimed is null
     or claimed !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or not ehr.patient_self_context(claimed::uuid) then
    raise exception using errcode = '42501', message = 'PATIENT_SESSION_REQUIRED';
  end if;
  return claimed::uuid;
end;
$$;

-- C5. The patient's orders sent to other facilities (newest first, at most
-- 100): what was sent and to whom, the clinician's attestation, and Stop
-- while it can still be stopped. A route whose order was marked entered in
-- error (ended so, or its lab request or prescription now entered_in_error)
-- keeps its record of the disclosure (reference, kind, state, dates, both
-- facilities) but answers no content beyond the reference, no attestation
-- text and no attesting clinician, and entered_in_error true: such an order
-- may have been written in another patient's chart, and the record view
-- already hides it (0067's patient-self policies, which this definer, as an
-- owner that does not bypass row-level security, reads under: the source
-- order is visible to the session's patient only when it is neither a draft
-- nor entered in error, so an invisible source is treated as entered in
-- error, failing closed).
create function ehr.patient_list_order_routes()
returns table (
  route_id uuid,
  reference text,
  kind text,
  row_version bigint,
  effective_state text,
  created_at timestamptz,
  respond_by timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz,
  ended_at timestamptz,
  ended_kind text,
  decline_reason text,
  ordering_facility_name text,
  receiving_facility_id uuid,
  receiving_facility_name text,
  receiving_registered_address text,
  content jsonb,
  attestation_text_version text,
  attestation_text text,
  attested_by_name text,
  actions text[],
  entered_in_error boolean
)
language plpgsql stable security definer
set search_path = pg_catalog, ehr, identity, platform, pg_temp
as $$
declare
  session_patient uuid := ehr.order_route_patient();
begin
  return query
    with listed as (
      select route.id as listed_id,
             coalesce(route.ended_kind = 'entered_in_error', false)
             or (route.kind = 'lab_request'
               and not exists (select 1 from ehr.lab_requests source
                                where source.id = route.source_lab_request_id
                                  and source.status not in ('draft', 'entered_in_error')))
             or (route.kind = 'prescription'
               and not exists (select 1 from ehr.prescriptions source
                                where source.id = route.source_prescription_id
                                  and source.status not in ('draft', 'entered_in_error'))) as in_error
        from ehr.order_routes route
       where route.patient_id = session_patient
    )
    select route.id, route.reference::text, route.kind, route.row_version, ehr.order_route_effective_state(route),
      route.created_at, route.respond_by, route.accepted_at, route.completed_at, route.ended_at, route.ended_kind,
      route.decline_reason,
      (select facility.name from identity.facilities facility where facility.id = route.ordering_facility_id),
      route.receiving_facility_id,
      (select facility.name from identity.facilities facility where facility.id = route.receiving_facility_id),
      identity.order_route_registered_address(route.receiving_facility_id),
      case when listed.in_error then
        jsonb_build_object('reference', route.reference)
      when route.kind = 'lab_request' then
        jsonb_build_object('reference', route.reference, 'ordererName', route.orderer_name,
          'ordererLicenceBody', route.orderer_licence_body, 'ordererLicenceNumber', route.orderer_licence_number,
          'testCodeSystem', route.test_code_system, 'testCode', route.test_code, 'testDisplay', route.test_display,
          'priority', route.priority, 'specimenTypeCode', route.specimen_type_code,
          'clinicalInformation', route.clinical_information, 'requestedAt', route.requested_at)
      else
        jsonb_build_object('reference', route.reference, 'ordererName', route.orderer_name,
          'ordererLicenceBody', route.orderer_licence_body, 'ordererLicenceNumber', route.orderer_licence_number,
          'medicationCodeSystem', route.medication_code_system, 'medicationCode', route.medication_code,
          'medicationDisplay', route.medication_display, 'doseQuantity', route.dose_quantity,
          'doseUnit', route.dose_unit, 'routeCode', route.route_code, 'frequency', route.frequency,
          'instructions', route.instructions, 'startsOn', route.starts_on, 'endsOn', route.ends_on,
          'prescribedAt', route.prescribed_at)
      end,
      route.attestation_text_version,
      case when not listed.in_error then
        (select text_row.text from ehr.order_route_attestation_texts text_row
          where text_row.version = route.attestation_text_version) end,
      case when not listed.in_error then route.attested_by_name end,
      case when route.state = 'sent' and clock_timestamp() < route.respond_by and not listed.in_error
           then array['withdraw'] else array[]::text[] end,
      listed.in_error
      from ehr.order_routes route
      join listed on listed.listed_id = route.id
     order by route.created_at desc, route.id desc
     limit 100;
end;
$$;

-- C6. The patient's Stop of a sent route (the patient's only write): the
-- route lock only (it checks no eligibility, so it takes no application).
create function ehr.patient_stop_order_route(requested_route_id uuid, expected_version bigint)
returns table (row_version bigint, state text, effective_state text)
language plpgsql security definer
set search_path = pg_catalog, ehr, identity, notification, audit, platform, pg_temp
as $$
declare
  session_patient uuid := ehr.order_route_patient();
  current_route ehr.order_routes%rowtype;
  changed ehr.order_routes%rowtype;
  written ehr.order_routes%rowtype;
begin
  if requested_route_id is null or expected_version is null then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  if not exists (select 1 from ehr.order_routes route
                  where route.id = requested_route_id and route.patient_id = session_patient) then
    raise exception using errcode = 'P0002', message = 'ORDER_ROUTE_NOT_FOUND';
  end if;
  select route.* into current_route from ehr.order_routes route where route.id = requested_route_id for update;
  if current_route.row_version <> expected_version then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_VERSION_CONFLICT';
  end if;
  if current_route.state <> 'sent' or clock_timestamp() >= current_route.respond_by then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_NOT_PENDING';
  end if;
  changed := current_route;
  changed.state := 'withdrawn';
  changed.ended_at := clock_timestamp();
  changed.ended_kind := 'patient';
  changed.ended_by_account_id := platform.current_account_id();
  written := ehr.write_order_route_change(current_route, changed, 'withdrawn', 'patient', 'patient');
  perform ehr.order_route_system_audit(written, 'ordering', 'ehr.order-route.patient-withdrawn', true, null);
  perform ehr.order_route_system_audit(written, 'receiving', 'ehr.order-route.withdrawn', false, null);
  perform ehr.order_route_notify_patient(written, 'ORDER_ROUTE_WITHDRAWN');
  return query select written.row_version, written.state, ehr.order_route_effective_state(written);
end;
$$;

revoke all on function ehr.order_route_sender_check(text),
  ehr.order_route_attestation_text(text),
  ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,char),
  ehr.lock_ordering_route(uuid,text,uuid,uuid),
  ehr.withdraw_order_route(uuid,text,uuid,bigint,text),
  ehr.order_route_reader(text,uuid),
  ehr.order_belongs_to(text,uuid,uuid,uuid),
  ehr.list_order_routes_for_order(text,uuid,uuid),
  ehr.order_route_summaries(text,uuid,uuid[]),
  ehr.order_route_patient(),
  ehr.patient_list_order_routes(),
  ehr.patient_stop_order_route(uuid,bigint)
  from public;

-- 6.4.2 The receiving facility (Lab: EXECUTE to the Lab runtime; Pharmacy:
-- the same commands under pharmacy.*, EXECUTE to the Pharmacy runtime). The
-- shared bodies are owner-only helpers taking the route kind.

-- The receiving actor: a staff session under direct-care holding the kind's
-- receive permission at the session facility; else 42501.
create function ehr.order_route_receiver(requested_kind text)
returns table (
  actor_subject text,
  actor_account_id uuid,
  actor_membership_id uuid,
  actor_facility_id uuid,
  actor_organization_id uuid
)
language plpgsql stable
set search_path = pg_catalog, ehr, auth, platform, pg_temp
as $$
declare
  actor record;
begin
  select * into actor from ehr.order_route_staff_actor(true);
  if not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id, actor.actor_facility_id,
           ehr.order_route_receive_permission(requested_kind)) then
    raise exception using errcode = '42501', message = 'ORDER_ROUTE_PERMISSION_DENIED';
  end if;
  return query select actor.actor_subject, actor.actor_account_id, actor.actor_membership_id,
    actor.actor_facility_id, actor.actor_organization_id;
end;
$$;

-- A Health ID as typed at the counter: upper case, trimmed, the canonical
-- pattern (0002), else NULL.
create function ehr.order_route_health_id(requested_health_id text)
returns text
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case when upper(btrim(requested_health_id)) ~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'
              then upper(btrim(requested_health_id)) end
$$;

-- What the receiving facility may see of a route (P11, P2, P4; SPEC 4.1):
--   preview   sent, before respond_by: the order without its free text and
--             without the patient;
--   full      accepted, completed or cancelled while the route allows a read
--             now (H7): also the free text, the licence number and the patient;
--   metadata  anything else: reference, kind, ordering facility, state, dates.
-- With cross_facility_orders_enabled off, a preview is metadata only (P9.4).
create function ehr.order_route_receiving_view(route ehr.order_routes)
returns text
language plpgsql stable
set search_path = pg_catalog, ehr, platform, pg_temp
as $$
declare
  orders_open boolean;
begin
  if route.state in ('accepted', 'completed', 'cancelled')
     and ehr.order_route_allows(route.id, route.receiving_facility_id, 'read_records') then
    return 'full';
  end if;
  if route.state = 'sent' and clock_timestamp() < route.respond_by then
    begin
      orders_open := coalesce(platform.control_enabled('cross_facility_orders_enabled'), false);
    exception when object_not_in_prerequisite_state or invalid_parameter_value then
      orders_open := false;
    end;
    if orders_open then
      return 'preview';
    end if;
  end if;
  return 'metadata';
end;
$$;

-- C7 / C13. Incoming (sent, before respond_by, addressed here, oldest first,
-- at most 200, optionally one patient's by Health ID) or recent (the last 30
-- days, any state, metadata only, plus the work item and test or medicine for
-- accepted ones).
create function ehr.list_receiving_order_routes(requested_kind text, requested_view text, requested_health_id text)
returns table (
  route_id uuid,
  reference text,
  row_version bigint,
  effective_state text,
  view_level text,
  ordering_facility_name text,
  orderer_name text,
  orderer_licence_body text,
  test_code_system text,
  test_code text,
  test_name text,
  priority text,
  specimen_type_code text,
  medication_code_system text,
  medication_code text,
  medication_display text,
  dose_quantity numeric,
  dose_unit text,
  route_code text,
  frequency text,
  starts_on date,
  ends_on date,
  prescribed_at timestamptz,
  sent_at timestamptz,
  respond_by timestamptz,
  accept_locked boolean,
  attempts_left integer,
  accepted_at timestamptz,
  ended_at timestamptz,
  work_item_id uuid
)
language plpgsql stable
set search_path = pg_catalog, ehr, identity, platform, pg_temp
as $$
declare
  actor record;
  wanted_patient uuid;
begin
  select * into actor from ehr.order_route_receiver(requested_kind);
  if not coalesce(requested_view in ('incoming', 'recent'), false)
     or (requested_health_id is not null and ehr.order_route_health_id(requested_health_id) is null) then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  perform platform.require_control_enabled('cross_facility_route_access_enabled');
  if requested_health_id is not null then
    select patient.id into wanted_patient
      from identity.patients patient where patient.hid_code = ehr.order_route_health_id(requested_health_id);
    if wanted_patient is null then
      return;
    end if;
  end if;
  if requested_view = 'incoming' then
    return query
      select route.id, route.reference::text, route.row_version, ehr.order_route_effective_state(route),
        visible.level,
        (select facility.name from identity.facilities facility where facility.id = route.ordering_facility_id),
        case when visible.level = 'preview' then route.orderer_name end,
        case when visible.level = 'preview' then route.orderer_licence_body end,
        case when visible.level = 'preview' then route.test_code_system end,
        case when visible.level = 'preview' then route.test_code end,
        case when visible.level = 'preview' then route.test_display end,
        case when visible.level = 'preview' then route.priority end,
        case when visible.level = 'preview' then route.specimen_type_code end,
        case when visible.level = 'preview' then route.medication_code_system end,
        case when visible.level = 'preview' then route.medication_code end,
        case when visible.level = 'preview' then route.medication_display end,
        case when visible.level = 'preview' then route.dose_quantity end,
        case when visible.level = 'preview' then route.dose_unit end,
        case when visible.level = 'preview' then route.route_code end,
        case when visible.level = 'preview' then route.frequency end,
        case when visible.level = 'preview' then route.starts_on end,
        case when visible.level = 'preview' then route.ends_on end,
        case when visible.level = 'preview' then route.prescribed_at end,
        route.created_at, route.respond_by, route.accept_locked_at is not null,
        ehr.order_route_attempts_left(route.id),
        null::timestamptz, null::timestamptz, null::uuid
        from ehr.order_routes route
        cross join lateral (select ehr.order_route_receiving_view(route) as level) visible
       where route.receiving_facility_id = actor.actor_facility_id
         and route.kind = requested_kind
         and route.state = 'sent'
         and route.respond_by > clock_timestamp()
         and (wanted_patient is null or route.patient_id = wanted_patient)
       order by route.created_at, route.id
       limit 200;
    return;
  end if;
  return query
    select route.id, route.reference::text, route.row_version, ehr.order_route_effective_state(route),
      'metadata'::text,
      (select facility.name from identity.facilities facility where facility.id = route.ordering_facility_id),
      null::text, null::text, null::text, null::text,
      case when route.accepted_at is not null then route.test_display end,
      null::text, null::text, null::text, null::text,
      case when route.accepted_at is not null then route.medication_display end,
      null::numeric, null::text, null::text, null::text, null::date, null::date, null::timestamptz,
      route.created_at, route.respond_by, route.accept_locked_at is not null, null::integer,
      route.accepted_at, route.ended_at, coalesce(route.lab_work_item_id, route.pharmacy_work_item_id)
      from ehr.order_routes route
     where route.receiving_facility_id = actor.actor_facility_id
       and route.kind = requested_kind
       and route.created_at > clock_timestamp() - interval '720 hours'
       and (wanted_patient is null or route.patient_id = wanted_patient)
     order by route.created_at desc, route.id desc
     limit 200;
end;
$$;

-- C8 / C14. One route addressed here, by what the facility may see of it.
create function ehr.get_receiving_order_route(requested_kind text, requested_route_id uuid)
returns table (
  route_id uuid,
  reference text,
  row_version bigint,
  effective_state text,
  view_level text,
  ordering_facility_name text,
  orderer_name text,
  orderer_licence_body text,
  orderer_licence_number text,
  test_code_system text,
  test_code text,
  test_name text,
  priority text,
  specimen_type_code text,
  clinical_information text,
  medication_code_system text,
  medication_code text,
  medication_display text,
  dose_quantity numeric,
  dose_unit text,
  route_code text,
  frequency text,
  instructions text,
  starts_on date,
  ends_on date,
  prescribed_at timestamptz,
  sent_at timestamptz,
  respond_by timestamptz,
  accept_locked boolean,
  attempts_left integer,
  accepted_at timestamptz,
  completed_at timestamptz,
  ended_at timestamptz,
  work_item_id uuid,
  patient_full_name text,
  patient_sex text,
  patient_date_of_birth date,
  patient_health_id_last4 text
)
language plpgsql stable
set search_path = pg_catalog, ehr, identity, platform, pg_temp
as $$
declare
  actor record;
  route ehr.order_routes%rowtype;
  level text;
  card record;
begin
  select * into actor from ehr.order_route_receiver(requested_kind);
  perform platform.require_control_enabled('cross_facility_route_access_enabled');
  select candidate.* into route from ehr.order_routes candidate
   where candidate.id = requested_route_id and candidate.kind = requested_kind
     and candidate.receiving_facility_id = actor.actor_facility_id;
  if route.id is null then
    raise exception using errcode = 'P0002', message = 'ORDER_ROUTE_NOT_FOUND';
  end if;
  level := ehr.order_route_receiving_view(route);
  select null::text as full_name, null::text as sex, null::date as date_of_birth, null::text as health_id_last4
    into card;
  if level = 'full' then
    select * into card from ehr.order_route_patient_card(route.patient_id);
  end if;
  return query select route.id, route.reference::text, route.row_version, ehr.order_route_effective_state(route),
    level,
    (select facility.name from identity.facilities facility where facility.id = route.ordering_facility_id),
    case when level <> 'metadata' then route.orderer_name end,
    case when level <> 'metadata' then route.orderer_licence_body end,
    case when level = 'full' then route.orderer_licence_number end,
    case when level <> 'metadata' then route.test_code_system end,
    case when level <> 'metadata' then route.test_code end,
    case when level <> 'metadata' then route.test_display end,
    case when level <> 'metadata' then route.priority end,
    case when level <> 'metadata' then route.specimen_type_code end,
    case when level = 'full' then route.clinical_information end,
    case when level <> 'metadata' then route.medication_code_system end,
    case when level <> 'metadata' then route.medication_code end,
    case when level <> 'metadata' then route.medication_display end,
    case when level <> 'metadata' then route.dose_quantity end,
    case when level <> 'metadata' then route.dose_unit end,
    case when level <> 'metadata' then route.route_code end,
    case when level <> 'metadata' then route.frequency end,
    case when level = 'full' then route.instructions end,
    case when level <> 'metadata' then route.starts_on end,
    case when level <> 'metadata' then route.ends_on end,
    case when level <> 'metadata' then route.prescribed_at end,
    route.created_at, route.respond_by, route.accept_locked_at is not null,
    ehr.order_route_attempts_left(route.id),
    route.accepted_at, route.completed_at, route.ended_at,
    case when level = 'full' then coalesce(route.lab_work_item_id, route.pharmacy_work_item_id) end,
    card.full_name, card.sex, card.date_of_birth, card.health_id_last4;
end;
$$;

-- The receiving side's route, locked after its own application (C9, C10,
-- C15, C16): addressed here and of this kind, else P0002.
create function ehr.lock_receiving_route(requested_kind text, requested_route_id uuid, receiving_facility uuid,
  receiving_organization uuid)
returns ehr.order_routes
language plpgsql volatile
set search_path = pg_catalog, ehr, identity, pg_temp
as $$
declare
  locked ehr.order_routes%rowtype;
begin
  if not exists (select 1 from ehr.order_routes route
                  where route.id = requested_route_id and route.kind = requested_kind
                    and route.receiving_facility_id = receiving_facility) then
    raise exception using errcode = 'P0002', message = 'ORDER_ROUTE_NOT_FOUND';
  end if;
  perform identity.lock_self_service_application(receiving_organization);
  select route.* into locked from ehr.order_routes route where route.id = requested_route_id for update;
  return locked;
end;
$$;

-- C9 / C15. Acceptance at the counter, with the patient's Health ID or date
-- of birth (P2), and optionally the route's reference (which the patient
-- sees in the app). A reference that is not this route's is refused at once
-- and recorded nowhere (the counter picked another row; it learns nothing it
-- does not already see). A mismatch is recorded and answered: 5 that named
-- this route (a Health ID, or a date of birth with its reference), or 20 in
-- all, lock the route here (ehr.order_route_attempts_left), and 20 a day
-- stop the member; a match accepts the route and creates the work
-- item bound to it, in one savepoint: if a same-facility hand-off won the
-- order first (unique violation), the route is withdrawn (order_in_work) and
-- that is the answer (R10). Identity and free text are answered only while
-- the route allows a read (a replay re-checks it, P10.4).
create function ehr.accept_receiving_order_route(
  requested_kind text,
  requested_route_id uuid,
  expected_version bigint,
  requested_identifier_kind text,
  requested_identifier text,
  requested_acceptance_reason text,
  requested_idempotency_key text,
  requested_request_sha256 char(64),
  requested_reference text default null
) returns table (
  result text,
  attempts_left integer,
  route_row_version bigint,
  work_item_id uuid,
  patient_full_name text,
  patient_sex text,
  patient_date_of_birth date,
  patient_health_id_last4 text,
  clinical_information text,
  instructions text,
  orderer_licence_body text,
  orderer_licence_number text,
  replayed boolean
)
language plpgsql volatile
set search_path = pg_catalog, ehr, identity, auth, lab, pharmacy, notification, platform, pg_temp
as $$
declare
  actor record;
  limits record;
  prior ehr.order_routes%rowtype;
  current_route ehr.order_routes%rowtype;
  changed ehr.order_routes%rowtype;
  written ehr.order_routes%rowtype;
  patient_row identity.patients%rowtype;
  ordering_facility identity.facilities%rowtype;
  card record;
  normalized_identifier text;
  identifier_date date;
  wanted_reference text := upper(btrim(requested_reference));
  identifies boolean;
  matched boolean;
  left_after integer;
  new_work_item uuid := gen_random_uuid();
  accepted_now timestamptz;
  readable boolean;
begin
  select * into actor from ehr.order_route_receiver(requested_kind);
  if requested_route_id is null or expected_version is null or expected_version < 1
     or not coalesce(requested_identifier_kind in ('health_id', 'date_of_birth'), false)
     or not coalesce(requested_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$', false)
     or not coalesce(requested_request_sha256 ~ '^[0-9a-f]{64}$', false)
     or (requested_kind = 'prescription'
       and not coalesce(length(btrim(requested_acceptance_reason)) between 8 and 500, false))
     or (requested_reference is not null and not coalesce(wanted_reference ~ '^[0-9A-F]{8}$', false)) then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  identifies := requested_identifier_kind = 'health_id' or requested_reference is not null;
  if requested_identifier_kind = 'health_id' then
    normalized_identifier := ehr.order_route_health_id(requested_identifier);
    if normalized_identifier is null then
      raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
    end if;
  else
    if not coalesce(btrim(requested_identifier) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', false) then
      raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
    end if;
    begin
      identifier_date := btrim(requested_identifier)::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
    end;
    if to_char(identifier_date, 'YYYY-MM-DD') <> btrim(requested_identifier) then
      raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
    end if;
  end if;
  perform platform.require_control_enabled('cross_facility_orders_enabled');
  perform platform.require_control_enabled('cross_facility_route_access_enabled');

  -- Replay by the acceptor's key at this facility.
  select route.* into prior from ehr.order_routes route
   where route.accepted_by_account_id = actor.actor_account_id
     and route.receiving_facility_id = actor.actor_facility_id
     and route.accept_idempotency_key = requested_idempotency_key;
  if prior.id is not null then
    if prior.accept_request_sha256 is distinct from requested_request_sha256 or prior.kind <> requested_kind
       or prior.id <> requested_route_id then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    readable := ehr.order_route_allows(prior.id, prior.receiving_facility_id, 'read_records');
    select null::text as full_name, null::text as sex, null::date as date_of_birth, null::text as health_id_last4
      into card;
    if readable then
      select * into card from ehr.order_route_patient_card(prior.patient_id);
    end if;
    return query select 'accepted'::text, null::integer, prior.row_version,
      coalesce(prior.lab_work_item_id, prior.pharmacy_work_item_id),
      card.full_name, card.sex, card.date_of_birth, card.health_id_last4,
      case when readable then prior.clinical_information end,
      case when readable then prior.instructions end,
      case when readable then prior.orderer_licence_body end,
      case when readable then prior.orderer_licence_number end, true;
    return;
  end if;

  if not exists (select 1 from ehr.order_routes route
                  where route.id = requested_route_id and route.kind = requested_kind
                    and route.receiving_facility_id = actor.actor_facility_id) then
    raise exception using errcode = 'P0002', message = 'ORDER_ROUTE_NOT_FOUND';
  end if;
  perform identity.lock_self_service_application(actor.actor_organization_id);
  if not identity.order_route_destination_eligible(actor.actor_facility_id, requested_kind) then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_DESTINATION_INELIGIBLE';
  end if;
  select route.* into current_route from ehr.order_routes route where route.id = requested_route_id for update;
  if current_route.row_version <> expected_version then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_VERSION_CONFLICT';
  end if;
  if current_route.state <> 'sent' then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_NOT_PENDING';
  end if;
  if clock_timestamp() >= current_route.respond_by then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_EXPIRED';
  end if;
  if current_route.accept_locked_at is not null then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ACCEPT_LOCKED';
  end if;
  if requested_reference is not null and wanted_reference <> current_route.reference then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_REFERENCE_MISMATCH';
  end if;
  select facility.* into ordering_facility from identity.facilities facility
   where facility.id = current_route.ordering_facility_id;
  if not ordering_facility.active or ordering_facility.lifecycle_status <> 'verified'
     or not exists (select 1 from identity.organizations organization
                     where organization.id = ordering_facility.organization_id and organization.active) then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ORDERING_FACILITY_UNAVAILABLE';
  end if;
  if identity.patient_denies_order_route(current_route.patient_id, actor.actor_facility_id) then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_PATIENT_DENIED';
  end if;
  select * into limits from ehr.order_route_limits();
  if (select count(*) from ehr.order_route_accept_attempts attempt
       where attempt.membership_id = actor.actor_membership_id and attempt.outcome = 'mismatch'
         and attempt.attempted_at > clock_timestamp() - interval '24 hours') >= limits.mismatches_per_member_per_day then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ACCEPT_LIMITED';
  end if;
  select patient.* into patient_row from identity.patients patient where patient.id = current_route.patient_id;
  if requested_identifier_kind = 'date_of_birth' and patient_row.dob is null then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_HEALTH_ID_REQUIRED';
  end if;
  matched := case requested_identifier_kind
    when 'health_id' then patient_row.hid_code = normalized_identifier
    else patient_row.dob = identifier_date end;
  insert into ehr.order_route_accept_attempts (route_id, receiving_facility_id, account_id, membership_id,
    identifier_kind, outcome, identifies_route)
  values (current_route.id, actor.actor_facility_id, actor.actor_account_id, actor.actor_membership_id,
    requested_identifier_kind, case when matched then 'match' else 'mismatch' end, identifies);

  if not matched then
    left_after := ehr.order_route_attempts_left(current_route.id);
    if left_after = 0 then
      changed := current_route;
      changed.accept_locked_at := clock_timestamp();
      written := ehr.write_order_route_change(current_route, changed, 'accept_locked', 'receiving', 'patient_mismatch');
      perform ehr.order_route_system_audit(written, 'ordering', 'ehr.order-route.accept-locked', true, null);
      perform ehr.order_route_notify_patient(written, 'ORDER_ROUTE_ACCEPT_LOCKED');
      return query select 'accept_locked'::text, 0, written.row_version, null::uuid, null::text, null::text,
        null::date, null::text, null::text, null::text, null::text, null::text, false;
      return;
    end if;
    return query select 'patient_mismatch'::text, left_after, current_route.row_version,
      null::uuid, null::text, null::text, null::date, null::text, null::text, null::text, null::text, null::text, false;
    return;
  end if;

  begin
    accepted_now := clock_timestamp();
    changed := current_route;
    changed.state := 'accepted';
    changed.accepted_at := accepted_now;
    changed.accepted_by_account_id := actor.actor_account_id;
    changed.accepted_by_membership_id := actor.actor_membership_id;
    changed.accept_idempotency_key := requested_idempotency_key;
    changed.accept_request_sha256 := requested_request_sha256;
    changed.writes_end_at := accepted_now + make_interval(hours => limits.work_days * 24);
    changed.access_ends_at := changed.writes_end_at;
    if requested_kind = 'lab_request' then
      changed.lab_work_item_id := new_work_item;
    else
      changed.pharmacy_work_item_id := new_work_item;
    end if;
    written := ehr.write_order_route_change(current_route, changed, 'accepted', 'receiving', null);
    if requested_kind = 'lab_request' then
      insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
        source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
        clinical_indication, requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key,
        request_sha256, correlation_id, order_route_id)
      values (new_work_item, written.patient_id, written.receiving_facility_id, written.ordering_facility_id,
        written.source_lab_request_id, written.source_order_version, written.source_encounter_id, 'accepted',
        written.priority, written.test_code_system, written.test_code, written.test_display,
        written.clinical_information, written.orderer_account_id, written.requested_at, actor.actor_account_id,
        actor.actor_membership_id, 'order-route:' || written.id::text, requested_request_sha256,
        platform.current_correlation_id(), written.id);
      insert into lab.work_item_requested_tests (work_item_id, facility_id, patient_id, "ordinal", code_system, code,
        name)
      values (new_work_item, written.receiving_facility_id, written.patient_id, 1, written.test_code_system,
        written.test_code, written.test_display);
      insert into lab.work_item_events (work_item_id, facility_id, patient_id, event_version, event_type, actor_id,
        actor_membership_id, reason, correlation_id)
      values (new_work_item, written.receiving_facility_id, written.patient_id, 1, 'accepted', actor.actor_account_id,
        actor.actor_membership_id, 'Accepted from another facility through an order route',
        platform.current_correlation_id());
      insert into lab.outbox_events (event_type, aggregate_id, aggregate_version, facility_id, patient_id,
        correlation_id, payload)
      values ('LabWorkItemCreated', new_work_item, 1, written.receiving_facility_id, written.patient_id,
        platform.current_correlation_id(),
        jsonb_build_object('workItemId', new_work_item, 'sourceEhrOrderId', written.source_lab_request_id,
          'sourceEhrOrderVersion', written.source_order_version, 'status', 'accepted'));
    else
      insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
        source_ehr_prescription_version, source_encounter_id, source_status, status, medication_code_system,
        medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency, instructions, starts_on,
        ends_on, prescribed_by, prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason,
        idempotency_key, request_sha256, correlation_id, order_route_id)
      values (new_work_item, written.patient_id, written.receiving_facility_id, written.ordering_facility_id,
        written.source_prescription_id, written.source_order_version, written.source_encounter_id, 'active',
        'accepted', written.medication_code_system, written.medication_code, written.medication_display,
        written.dose_quantity, written.dose_unit, written.route_code, written.frequency, written.instructions,
        written.starts_on, written.ends_on, written.orderer_account_id, written.prescribed_at,
        actor.actor_account_id, actor.actor_membership_id, btrim(requested_acceptance_reason),
        'order-route:' || written.id::text, requested_request_sha256, platform.current_correlation_id(), written.id);
      insert into pharmacy.work_item_events (work_item_id, patient_id, facility_id, event_version, event_type,
        actor_id, actor_membership_id, reason, correlation_id)
      values (new_work_item, written.patient_id, written.receiving_facility_id, 1, 'prescription_accepted',
        actor.actor_account_id, actor.actor_membership_id, btrim(requested_acceptance_reason),
        platform.current_correlation_id());
      insert into pharmacy.outbox_events (event_type, aggregate_type, aggregate_id, aggregate_version, facility_id,
        patient_id, correlation_id, payload)
      values ('PharmacyWorkItemCreated', 'pharmacy-work-item', new_work_item, 1, written.receiving_facility_id,
        written.patient_id, platform.current_correlation_id(),
        jsonb_build_object('workItemId', new_work_item, 'sourceEhrPrescriptionId', written.source_prescription_id,
          'sourceEhrPrescriptionVersion', written.source_order_version, 'status', 'accepted'));
    end if;
  exception when unique_violation then
    -- A same-facility hand-off at the ordering facility won the order (R10):
    -- the savepoint undid the acceptance; the route is withdrawn.
    select route.* into current_route from ehr.order_routes route where route.id = requested_route_id;
    changed := current_route;
    changed.state := 'withdrawn';
    changed.ended_at := clock_timestamp();
    changed.ended_kind := 'order_in_work';
    written := ehr.write_order_route_change(current_route, changed, 'withdrawn', 'system', 'order_in_work');
    perform ehr.order_route_system_audit(written, 'ordering', 'ehr.order-route.withdrawn', true, null);
    perform ehr.order_route_notify_patient(written, 'ORDER_ROUTE_WITHDRAWN');
    return query select 'order_in_work'::text, null::integer, written.row_version, null::uuid, null::text,
      null::text, null::date, null::text, null::text, null::text, null::text, null::text, false;
    return;
  end;
  perform ehr.order_route_system_audit(written, 'ordering', 'ehr.order-route.accepted', true, null);
  perform ehr.order_route_notify_patient(written, 'ORDER_ROUTE_ACCEPTED');
  select * into card from ehr.order_route_patient_card(written.patient_id);
  return query select 'accepted'::text, null::integer, written.row_version, new_work_item, card.full_name, card.sex,
    card.date_of_birth, card.health_id_last4, written.clinical_information, written.instructions,
    written.orderer_licence_body, written.orderer_licence_number, false;
end;
$$;

-- C10 / C16. Decline before acceptance, with a reason code (no control: B
-- may always decline).
create function ehr.decline_receiving_order_route(requested_kind text, requested_route_id uuid,
  expected_version bigint, requested_reason text)
returns table (row_version bigint, state text)
language plpgsql volatile
set search_path = pg_catalog, ehr, identity, auth, notification, platform, pg_temp
as $$
declare
  actor record;
  current_route ehr.order_routes%rowtype;
  changed ehr.order_routes%rowtype;
  written ehr.order_routes%rowtype;
begin
  select * into actor from ehr.order_route_receiver(requested_kind);
  if requested_route_id is null or expected_version is null
     or not coalesce(requested_reason in ('test_not_offered', 'medicine_unavailable', 'cannot_meet_priority',
       'patient_not_seen', 'other'), false) then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  current_route := ehr.lock_receiving_route(requested_kind, requested_route_id, actor.actor_facility_id,
    actor.actor_organization_id);
  if current_route.row_version <> expected_version then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_VERSION_CONFLICT';
  end if;
  if current_route.state <> 'sent' then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_NOT_PENDING';
  end if;
  if clock_timestamp() >= current_route.respond_by then
    raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_EXPIRED';
  end if;
  changed := current_route;
  changed.state := 'declined';
  changed.declined_at := clock_timestamp();
  changed.declined_by_account_id := actor.actor_account_id;
  changed.declined_by_membership_id := actor.actor_membership_id;
  changed.decline_reason := requested_reason;
  written := ehr.write_order_route_change(current_route, changed, 'declined', 'receiving', requested_reason);
  perform ehr.order_route_system_audit(written, 'ordering', 'ehr.order-route.declined', true,
    jsonb_build_object('reason', requested_reason));
  perform ehr.order_route_notify_patient(written, 'ORDER_ROUTE_DECLINED');
  return query select written.row_version, written.state;
end;
$$;

-- C11 / C17's decision for one work item (route-backed or not).
create function ehr.order_route_item_access(requested_kind text, item_route_id uuid, requested_action text)
returns text
language plpgsql stable
set search_path = pg_catalog, ehr, platform, pg_temp
as $$
declare
  route ehr.order_routes%rowtype;
begin
  if item_route_id is null then
    return 'none';
  end if;
  select candidate.* into route from ehr.order_routes candidate
   where candidate.id = item_route_id and candidate.kind = requested_kind
     and candidate.receiving_facility_id = platform.current_facility_id();
  if route.id is null then
    return 'none';
  end if;
  if not ehr.order_route_access_open() then
    return 'paused';
  end if;
  if ehr.order_route_allows(route.id, route.receiving_facility_id, requested_action) then
    return 'allowed';
  end if;
  if requested_action = 'write_records'
     and (route.state = 'cancelled' or (route.state = 'accepted' and clock_timestamp() >= route.writes_end_at)) then
    return 'closed';
  end if;
  return 'none';
end;
$$;

-- C11. Route access for the resource a Lab command acts on (P12): the
-- database derives the work item from the resource. A resource the session
-- cannot read (its own row-level security) or a work item without a route
-- answers none (Identity's consent check, as today); route-backed: paused
-- (route-access control off), allowed (the route allows the action now),
-- closed (a write on a cancelled route, or on an accepted one past its
-- window) or none (a read the route does not allow, or a write on a completed
-- route past its window: the patient's consent decides, P3).
create function lab.order_route_access_for(requested_resource_type text, requested_resource_id uuid,
  requested_action text)
returns table (outcome text, route_id uuid, work_item_id uuid)
language plpgsql stable security definer
set search_path = pg_catalog, lab, ehr, platform, pg_temp
as $$
declare
  actor record;
  item_id uuid;
  item_route uuid;
  item_facility uuid;
  decision text;
begin
  select * into actor from ehr.order_route_staff_actor(false);
  if not coalesce(requested_resource_type in ('work_item', 'accession', 'specimen', 'execution', 'result'), false)
     or not coalesce(requested_action in ('read_records', 'write_records'), false)
     or requested_resource_id is null then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  -- A work item is found through its route (readable whatever the Lab
  -- policies say, so a paused route answers paused); a chain row through the
  -- rows the session can read.
  if requested_resource_type = 'work_item' then
    select route.lab_work_item_id, route.id, route.receiving_facility_id into item_id, item_route, item_facility
      from ehr.order_routes route
     where route.lab_work_item_id = requested_resource_id
       and route.receiving_facility_id = actor.actor_facility_id;
  elsif requested_resource_type = 'accession' then
    select candidate.id, candidate.order_route_id, candidate.facility_id into item_id, item_route, item_facility
      from lab.accessions accession
      join lab.work_items candidate on candidate.id = accession.work_item_id
     where accession.id = requested_resource_id
       and lab.context_allows(accession.patient_id, accession.facility_id, 'read_records');
  elsif requested_resource_type = 'specimen' then
    select candidate.id, candidate.order_route_id, candidate.facility_id into item_id, item_route, item_facility
      from lab.specimens specimen
      join lab.accessions accession on accession.id = specimen.accession_id
      join lab.work_items candidate on candidate.id = accession.work_item_id
     where specimen.id = requested_resource_id
       and lab.context_allows(specimen.patient_id, specimen.facility_id, 'read_records');
  elsif requested_resource_type = 'execution' then
    select candidate.id, candidate.order_route_id, candidate.facility_id into item_id, item_route, item_facility
      from lab.test_executions execution
      join lab.accessions accession on accession.id = execution.accession_id
      join lab.work_items candidate on candidate.id = accession.work_item_id
     where execution.id = requested_resource_id
       and lab.context_allows(execution.patient_id, execution.facility_id, 'read_records');
  else
    select candidate.id, candidate.order_route_id, candidate.facility_id into item_id, item_route, item_facility
      from lab.results result_row
      join lab.test_executions execution on execution.id = result_row.execution_id
      join lab.accessions accession on accession.id = execution.accession_id
      join lab.work_items candidate on candidate.id = accession.work_item_id
     where result_row.id = requested_resource_id
       and lab.context_allows(result_row.patient_id, result_row.facility_id, 'read_records');
  end if;
  if item_id is null or item_facility is distinct from actor.actor_facility_id or item_route is null then
    return query select 'none'::text, null::uuid, null::uuid;
    return;
  end if;
  decision := ehr.order_route_item_access('lab_request', item_route, requested_action);
  if decision = 'none' then
    return query select 'none'::text, null::uuid, null::uuid;
    return;
  end if;
  return query select decision, item_route, item_id;
end;
$$;

-- C17. The same for a Pharmacy resource (a work item or a dispensing).
create function pharmacy.order_route_access_for(requested_resource_type text, requested_resource_id uuid,
  requested_action text)
returns table (outcome text, route_id uuid, work_item_id uuid)
language plpgsql stable security definer
set search_path = pg_catalog, pharmacy, ehr, platform, pg_temp
as $$
declare
  actor record;
  item_id uuid;
  item_route uuid;
  item_facility uuid;
  decision text;
begin
  select * into actor from ehr.order_route_staff_actor(false);
  if not coalesce(requested_resource_type in ('work_item', 'dispensing'), false)
     or not coalesce(requested_action in ('read_records', 'write_records'), false)
     or requested_resource_id is null then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  if requested_resource_type = 'work_item' then
    select route.pharmacy_work_item_id, route.id, route.receiving_facility_id into item_id, item_route, item_facility
      from ehr.order_routes route
     where route.pharmacy_work_item_id = requested_resource_id
       and route.receiving_facility_id = actor.actor_facility_id;
  else
    select candidate.id, candidate.order_route_id, candidate.facility_id into item_id, item_route, item_facility
      from pharmacy.dispensings dispensing
      join pharmacy.work_items candidate on candidate.id = dispensing.work_item_id
     where dispensing.id = requested_resource_id
       and pharmacy.context_allows(dispensing.patient_id, dispensing.facility_id, 'read_records');
  end if;
  if item_id is null or item_facility is distinct from actor.actor_facility_id or item_route is null then
    return query select 'none'::text, null::uuid, null::uuid;
    return;
  end if;
  decision := ehr.order_route_item_access('prescription', item_route, requested_action);
  if decision = 'none' then
    return query select 'none'::text, null::uuid, null::uuid;
    return;
  end if;
  return query select decision, item_route, item_id;
end;
$$;

-- C12 / C18. The route cards of route-backed work items the session can read
-- (at most 200 ids): access work (the route allows writes now), read, or
-- none; the licence number and the patient only while the route allows a read.
create function ehr.receiving_order_route_cards(requested_kind text, requested_work_item_ids uuid[])
returns table (
  work_item_id uuid,
  route_id uuid,
  reference text,
  effective_state text,
  access text,
  ordering_facility_name text,
  orderer_name text,
  orderer_licence_body text,
  orderer_licence_number text,
  patient_full_name text,
  patient_sex text,
  patient_date_of_birth date,
  patient_health_id_last4 text
)
language plpgsql stable
set search_path = pg_catalog, ehr, identity, lab, pharmacy, platform, pg_temp
as $$
declare
  actor record;
begin
  select * into actor from ehr.order_route_staff_actor(false);
  if requested_work_item_ids is null or cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  return query
    select item.item_id, route.id, route.reference::text, ehr.order_route_effective_state(route),
      case when ehr.order_route_allows(route.id, route.receiving_facility_id, 'write_records') then 'work'
           when ehr.order_route_allows(route.id, route.receiving_facility_id, 'read_records') then 'read'
           else 'none' end,
      (select facility.name from identity.facilities facility where facility.id = route.ordering_facility_id),
      route.orderer_name, route.orderer_licence_body,
      case when readable.allowed then route.orderer_licence_number end,
      case when readable.allowed then card.full_name end,
      case when readable.allowed then card.sex end,
      case when readable.allowed then card.date_of_birth end,
      case when readable.allowed then card.health_id_last4 end
      from (
        select candidate.id as item_id, candidate.order_route_id as item_route
          from lab.work_items candidate
         where requested_kind = 'lab_request' and candidate.id = any(requested_work_item_ids)
           and candidate.order_route_id is not null and candidate.facility_id = actor.actor_facility_id
           and lab.work_item_allows(candidate.patient_id, candidate.facility_id, candidate.order_route_id,
             'read_records')
        union all
        select candidate.id, candidate.order_route_id
          from pharmacy.work_items candidate
         where requested_kind = 'prescription' and candidate.id = any(requested_work_item_ids)
           and candidate.order_route_id is not null and candidate.facility_id = actor.actor_facility_id
           and pharmacy.work_item_allows(candidate.patient_id, candidate.facility_id, candidate.order_route_id,
             'read_records')
      ) item
      join ehr.order_routes route on route.id = item.item_route
      cross join lateral (select ehr.order_route_allows(route.id, route.receiving_facility_id, 'read_records')
                            as allowed) readable
      left join lateral ehr.order_route_patient_card(route.patient_id) card on readable.allowed
     order by item.item_id;
end;
$$;

-- The Lab commands (C7-C12).
create function lab.list_order_routes(requested_view text, requested_health_id text)
returns table (
  route_id uuid, reference text, row_version bigint, effective_state text, view_level text,
  ordering_facility_name text, orderer_name text, orderer_licence_body text, test_code_system text, test_code text,
  test_name text, priority text, specimen_type_code text, sent_at timestamptz, respond_by timestamptz,
  accept_locked boolean, attempts_left integer, accepted_at timestamptz, ended_at timestamptz, work_item_id uuid
)
language sql stable security definer
set search_path = pg_catalog, lab, ehr, pg_temp
as $$
  select listed.route_id, listed.reference, listed.row_version, listed.effective_state, listed.view_level,
    listed.ordering_facility_name, listed.orderer_name, listed.orderer_licence_body, listed.test_code_system,
    listed.test_code, listed.test_name, listed.priority, listed.specimen_type_code, listed.sent_at,
    listed.respond_by, listed.accept_locked, listed.attempts_left, listed.accepted_at, listed.ended_at,
    listed.work_item_id
    from ehr.list_receiving_order_routes('lab_request', requested_view, requested_health_id) listed
$$;

create function lab.get_order_route(requested_route_id uuid)
returns table (
  route_id uuid, reference text, row_version bigint, effective_state text, view_level text,
  ordering_facility_name text, orderer_name text, orderer_licence_body text, orderer_licence_number text,
  test_code_system text, test_code text, test_name text, priority text, specimen_type_code text,
  clinical_information text, sent_at timestamptz, respond_by timestamptz, accept_locked boolean,
  attempts_left integer, accepted_at timestamptz, completed_at timestamptz, ended_at timestamptz,
  work_item_id uuid, patient_full_name text, patient_sex text, patient_date_of_birth date,
  patient_health_id_last4 text
)
language sql stable security definer
set search_path = pg_catalog, lab, ehr, pg_temp
as $$
  select got.route_id, got.reference, got.row_version, got.effective_state, got.view_level,
    got.ordering_facility_name, got.orderer_name, got.orderer_licence_body, got.orderer_licence_number,
    got.test_code_system, got.test_code, got.test_name, got.priority, got.specimen_type_code,
    got.clinical_information, got.sent_at, got.respond_by, got.accept_locked, got.attempts_left, got.accepted_at,
    got.completed_at, got.ended_at, got.work_item_id, got.patient_full_name, got.patient_sex,
    got.patient_date_of_birth, got.patient_health_id_last4
    from ehr.get_receiving_order_route('lab_request', requested_route_id) got
$$;

create function lab.accept_order_route(requested_route_id uuid, expected_version bigint,
  requested_identifier_kind text, requested_identifier text, requested_idempotency_key text,
  requested_request_sha256 char(64), requested_reference text default null)
returns table (
  result text, attempts_left integer, route_row_version bigint, work_item_id uuid, patient_full_name text,
  patient_sex text, patient_date_of_birth date, patient_health_id_last4 text, clinical_information text,
  orderer_licence_body text, orderer_licence_number text, replayed boolean
)
language sql volatile security definer
set search_path = pg_catalog, lab, ehr, pg_temp
as $$
  select accepted.result, accepted.attempts_left, accepted.route_row_version, accepted.work_item_id,
    accepted.patient_full_name, accepted.patient_sex, accepted.patient_date_of_birth,
    accepted.patient_health_id_last4, accepted.clinical_information, accepted.orderer_licence_body,
    accepted.orderer_licence_number, accepted.replayed
    from ehr.accept_receiving_order_route('lab_request', requested_route_id, expected_version,
      requested_identifier_kind, requested_identifier, null, requested_idempotency_key,
      requested_request_sha256, requested_reference) accepted
$$;

create function lab.decline_order_route(requested_route_id uuid, expected_version bigint, requested_reason text)
returns table (row_version bigint, state text)
language sql volatile security definer
set search_path = pg_catalog, lab, ehr, pg_temp
as $$
  select declined.row_version, declined.state
    from ehr.decline_receiving_order_route('lab_request', requested_route_id, expected_version, requested_reason)
      declined
$$;

create function lab.order_route_cards(requested_work_item_ids uuid[])
returns table (
  work_item_id uuid, route_id uuid, reference text, effective_state text, access text,
  ordering_facility_name text, orderer_name text, orderer_licence_body text, orderer_licence_number text,
  patient_full_name text, patient_sex text, patient_date_of_birth date, patient_health_id_last4 text
)
language sql stable security definer
set search_path = pg_catalog, lab, ehr, pg_temp
as $$
  select card.work_item_id, card.route_id, card.reference, card.effective_state, card.access,
    card.ordering_facility_name, card.orderer_name, card.orderer_licence_body, card.orderer_licence_number,
    card.patient_full_name, card.patient_sex, card.patient_date_of_birth, card.patient_health_id_last4
    from ehr.receiving_order_route_cards('lab_request', requested_work_item_ids) card
$$;

-- The Pharmacy commands (C13-C18).
create function pharmacy.list_order_routes(requested_view text, requested_health_id text)
returns table (
  route_id uuid, reference text, row_version bigint, effective_state text, view_level text,
  ordering_facility_name text, orderer_name text, orderer_licence_body text, medication_code_system text,
  medication_code text, medication_display text, dose_quantity numeric, dose_unit text, route_code text,
  frequency text, starts_on date, ends_on date, prescribed_at timestamptz, sent_at timestamptz,
  respond_by timestamptz, accept_locked boolean, attempts_left integer, accepted_at timestamptz,
  ended_at timestamptz, work_item_id uuid
)
language sql stable security definer
set search_path = pg_catalog, pharmacy, ehr, pg_temp
as $$
  select listed.route_id, listed.reference, listed.row_version, listed.effective_state, listed.view_level,
    listed.ordering_facility_name, listed.orderer_name, listed.orderer_licence_body, listed.medication_code_system,
    listed.medication_code, listed.medication_display, listed.dose_quantity, listed.dose_unit, listed.route_code,
    listed.frequency, listed.starts_on, listed.ends_on, listed.prescribed_at, listed.sent_at, listed.respond_by,
    listed.accept_locked, listed.attempts_left, listed.accepted_at, listed.ended_at, listed.work_item_id
    from ehr.list_receiving_order_routes('prescription', requested_view, requested_health_id) listed
$$;

create function pharmacy.get_order_route(requested_route_id uuid)
returns table (
  route_id uuid, reference text, row_version bigint, effective_state text, view_level text,
  ordering_facility_name text, orderer_name text, orderer_licence_body text, orderer_licence_number text,
  medication_code_system text, medication_code text, medication_display text, dose_quantity numeric,
  dose_unit text, route_code text, frequency text, instructions text, starts_on date, ends_on date,
  prescribed_at timestamptz, sent_at timestamptz, respond_by timestamptz, accept_locked boolean,
  attempts_left integer, accepted_at timestamptz, completed_at timestamptz, ended_at timestamptz,
  work_item_id uuid, patient_full_name text, patient_sex text, patient_date_of_birth date,
  patient_health_id_last4 text
)
language sql stable security definer
set search_path = pg_catalog, pharmacy, ehr, pg_temp
as $$
  select got.route_id, got.reference, got.row_version, got.effective_state, got.view_level,
    got.ordering_facility_name, got.orderer_name, got.orderer_licence_body, got.orderer_licence_number,
    got.medication_code_system, got.medication_code, got.medication_display, got.dose_quantity, got.dose_unit,
    got.route_code, got.frequency, got.instructions, got.starts_on, got.ends_on, got.prescribed_at, got.sent_at,
    got.respond_by, got.accept_locked, got.attempts_left, got.accepted_at, got.completed_at, got.ended_at,
    got.work_item_id, got.patient_full_name, got.patient_sex, got.patient_date_of_birth,
    got.patient_health_id_last4
    from ehr.get_receiving_order_route('prescription', requested_route_id) got
$$;

create function pharmacy.accept_order_route(requested_route_id uuid, expected_version bigint,
  requested_identifier_kind text, requested_identifier text, requested_acceptance_reason text,
  requested_idempotency_key text, requested_request_sha256 char(64), requested_reference text default null)
returns table (
  result text, attempts_left integer, route_row_version bigint, work_item_id uuid, patient_full_name text,
  patient_sex text, patient_date_of_birth date, patient_health_id_last4 text, instructions text,
  orderer_licence_body text, orderer_licence_number text, replayed boolean
)
language sql volatile security definer
set search_path = pg_catalog, pharmacy, ehr, pg_temp
as $$
  select accepted.result, accepted.attempts_left, accepted.route_row_version, accepted.work_item_id,
    accepted.patient_full_name, accepted.patient_sex, accepted.patient_date_of_birth,
    accepted.patient_health_id_last4, accepted.instructions, accepted.orderer_licence_body,
    accepted.orderer_licence_number, accepted.replayed
    from ehr.accept_receiving_order_route('prescription', requested_route_id, expected_version,
      requested_identifier_kind, requested_identifier, requested_acceptance_reason, requested_idempotency_key,
      requested_request_sha256, requested_reference) accepted
$$;

create function pharmacy.decline_order_route(requested_route_id uuid, expected_version bigint, requested_reason text)
returns table (row_version bigint, state text)
language sql volatile security definer
set search_path = pg_catalog, pharmacy, ehr, pg_temp
as $$
  select declined.row_version, declined.state
    from ehr.decline_receiving_order_route('prescription', requested_route_id, expected_version, requested_reason)
      declined
$$;

create function pharmacy.order_route_cards(requested_work_item_ids uuid[])
returns table (
  work_item_id uuid, route_id uuid, reference text, effective_state text, access text,
  ordering_facility_name text, orderer_name text, orderer_licence_body text, orderer_licence_number text,
  patient_full_name text, patient_sex text, patient_date_of_birth date, patient_health_id_last4 text
)
language sql stable security definer
set search_path = pg_catalog, pharmacy, ehr, pg_temp
as $$
  select card.work_item_id, card.route_id, card.reference, card.effective_state, card.access,
    card.ordering_facility_name, card.orderer_name, card.orderer_licence_body, card.orderer_licence_number,
    card.patient_full_name, card.patient_sex, card.patient_date_of_birth, card.patient_health_id_last4
    from ehr.receiving_order_route_cards('prescription', requested_work_item_ids) card
$$;

revoke all on function ehr.order_route_receiver(text),
  ehr.order_route_health_id(text),
  ehr.order_route_receiving_view(ehr.order_routes),
  ehr.list_receiving_order_routes(text,text,text),
  ehr.get_receiving_order_route(text,uuid),
  ehr.lock_receiving_route(text,uuid,uuid,uuid),
  ehr.accept_receiving_order_route(text,uuid,bigint,text,text,text,text,char,text),
  ehr.decline_receiving_order_route(text,uuid,bigint,text),
  ehr.order_route_item_access(text,uuid,text),
  ehr.receiving_order_route_cards(text,uuid[]),
  lab.order_route_access_for(text,uuid,text),
  pharmacy.order_route_access_for(text,uuid,text),
  lab.list_order_routes(text,text),
  lab.get_order_route(uuid),
  lab.accept_order_route(uuid,bigint,text,text,text,char,text),
  lab.decline_order_route(uuid,bigint,text),
  lab.order_route_cards(uuid[]),
  pharmacy.list_order_routes(text,text),
  pharmacy.get_order_route(uuid),
  pharmacy.accept_order_route(uuid,bigint,text,text,text,text,char,text),
  pharmacy.decline_order_route(uuid,bigint,text),
  pharmacy.order_route_cards(uuid[])
  from public;

-- 6.4.3 Identity (the directory and support's tools; EXECUTE to the Identity
-- runtime).

-- C19. The directory: eligible facilities whose facility or organization
-- name contains the query (3-80 characters; %, _ and \ match themselves),
-- at most 10, by facility name. Each candidate's organization application is
-- locked FOR SHARE before its eligibility is read, so a review or release in
-- flight finishes first. The kind is the route kind or the destination type
-- (lab_request or laboratory, prescription or pharmacy).
create function identity.search_order_destinations(requested_kind text, requested_query text)
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

-- C20. Support's summary of a facility's orders with other facilities: its
-- listing (value, by default or by support, reason, when), the routes it
-- accepted and their patients over its lifetime, and per counterpart the last
-- 30 days by effective state. No patient and no order content.
create function identity.admin_order_route_summary(target_facility_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, identity, ehr, auth, platform, pg_temp
as $$
declare
  latest identity.order_route_destination_settings%rowtype;
  summary jsonb;
begin
  perform identity.order_route_platform_actor(array['platform.facility.read']);
  if target_facility_id is null
     or not exists (select 1 from identity.facilities facility where facility.id = target_facility_id) then
    raise exception using errcode = 'P0002', message = 'ADMIN_FACILITY_NOT_FOUND';
  end if;
  select setting.* into latest from identity.order_route_destination_settings setting
   where setting.facility_id = target_facility_id
   order by setting.set_at desc, setting.id desc limit 1;
  select jsonb_build_object(
    'listed', jsonb_build_object('value', identity.order_route_destination_listed(target_facility_id),
      'byDefault', latest.id is null, 'reason', latest.reason, 'setAt', latest.set_at),
    'receivedAcceptedLifetime', (select count(*) from ehr.order_routes route
      where route.receiving_facility_id = target_facility_id and route.accepted_at is not null),
    'receivedPatientsLifetime', (select count(distinct route.patient_id) from ehr.order_routes route
      where route.receiving_facility_id = target_facility_id and route.accepted_at is not null),
    'counterparts', coalesce((
      select jsonb_agg(jsonb_build_object('direction', counterpart.direction, 'facilityId', counterpart.facility_id,
               'facilityName', counterpart.facility_name, 'last30Days', counterpart.states)
             order by counterpart.direction, counterpart.facility_name, counterpart.facility_id)
        from (
          select grouped.direction, grouped.facility_id,
            (select facility.name from identity.facilities facility where facility.id = grouped.facility_id)
              as facility_name,
            jsonb_object_agg(grouped.effective_state, grouped.route_count) as states
            from (
              select case when route.ordering_facility_id = target_facility_id then 'sent' else 'received' end
                       as direction,
                     case when route.ordering_facility_id = target_facility_id then route.receiving_facility_id
                          else route.ordering_facility_id end as facility_id,
                     ehr.order_route_effective_state(route) as effective_state,
                     count(*) as route_count
                from ehr.order_routes route
               where (route.ordering_facility_id = target_facility_id
                   or route.receiving_facility_id = target_facility_id)
                 and route.created_at > clock_timestamp() - interval '720 hours'
               group by 1, 2, 3) grouped
           group by grouped.direction, grouped.facility_id) counterpart), '[]'::jsonb))
    into summary;
  return summary;
end;
$$;

-- C21. Support finds routes by reference (8 hex, at most 5) or a patient's
-- Health ID (at most 20), newest first.
create function identity.admin_find_order_routes(requested_reference text, requested_health_id text)
returns table (
  route_id uuid,
  reference text,
  kind text,
  row_version bigint,
  effective_state text,
  ordering_facility_id uuid,
  ordering_facility_name text,
  receiving_facility_id uuid,
  receiving_facility_name text,
  created_at timestamptz,
  accepted_at timestamptz,
  ended_at timestamptz,
  ended_kind text
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, ehr, auth, platform, pg_temp
as $$
declare
  wanted_reference text := upper(btrim(requested_reference));
  wanted_patient uuid;
begin
  perform identity.order_route_platform_actor(array['platform.principal.read']);
  if (requested_reference is null) = (requested_health_id is null)
     or (requested_reference is not null and not coalesce(wanted_reference ~ '^[0-9A-F]{8}$', false))
     or (requested_health_id is not null and ehr.order_route_health_id(requested_health_id) is null) then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_LOOKUP_INVALID';
  end if;
  if requested_health_id is not null then
    select patient.id into wanted_patient from identity.patients patient
     where patient.hid_code = ehr.order_route_health_id(requested_health_id);
    if wanted_patient is null then
      return;
    end if;
  end if;
  return query
    select route.id, route.reference::text, route.kind, route.row_version, ehr.order_route_effective_state(route),
      route.ordering_facility_id,
      (select facility.name from identity.facilities facility where facility.id = route.ordering_facility_id),
      route.receiving_facility_id,
      (select facility.name from identity.facilities facility where facility.id = route.receiving_facility_id),
      route.created_at, route.accepted_at, route.ended_at, route.ended_kind
      from ehr.order_routes route
     where (requested_reference is not null and route.reference = wanted_reference)
        or (wanted_patient is not null and route.patient_id = wanted_patient)
     order by route.created_at desc, route.id desc
     limit case when requested_reference is not null then 5 else 20 end;
end;
$$;

-- C22. Support closes a live route: sent -> withdrawn, accepted ->
-- cancelled, completed -> access ends; access ends now in every case.
create function identity.admin_close_order_route(target_route_id uuid, expected_version bigint, close_reason text)
returns table (route_id uuid, row_version bigint, state text)
language plpgsql volatile security definer
set search_path = pg_catalog, identity, ehr, auth, audit, notification, platform, pg_temp
as $$
declare
  actor_account uuid := identity.order_route_platform_actor(array['platform.facility.manage']);
  reason text := btrim(coalesce(close_reason, ''));
  current_route ehr.order_routes%rowtype;
  closed record;
begin
  if target_route_id is null or expected_version is null or length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_CLOSE_INVALID';
  end if;
  select route.* into current_route from ehr.order_routes route where route.id = target_route_id for update;
  if current_route.id is null then
    raise exception using errcode = 'P0002', message = 'ORDER_ROUTE_NOT_FOUND';
  end if;
  if current_route.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Order route version conflict';
  end if;
  if ehr.order_route_effective_state(current_route) not in ('sent', 'accepted', 'completed')
     or (current_route.state = 'completed'
       and (current_route.ended_at is not null or clock_timestamp() >= current_route.access_ends_at)) then
    raise exception using errcode = '23505', message = 'ORDER_ROUTE_ALREADY_CLOSED';
  end if;
  select * into closed from ehr.close_order_route(current_route.id, 'support', 'platform', true);
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
    resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details)
  values (platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
    'admin.order-route.close', 'success', 'order-route', current_route.id::text, 'healthcare-operations', reason,
    'application', 'identity-api',
    jsonb_build_object('routeId', current_route.id, 'kind', current_route.kind,
      'stateBefore', current_route.state, 'stateAfter', (closed.closed).state, 'outcome', closed.outcome,
      'version', (closed.closed).row_version));
  perform ehr.order_route_system_audit(closed.closed, 'ordering', 'ehr.order-route.closed', true,
    jsonb_build_object('closedBy', 'support'));
  if closed.outcome = 'withdrawn' then
    perform ehr.order_route_system_audit(closed.closed, 'receiving', 'ehr.order-route.withdrawn', false,
      jsonb_build_object('closedBy', 'support'));
  else
    perform ehr.order_route_system_audit(closed.closed, 'receiving', 'ehr.order-route.closed', true,
      jsonb_build_object('closedBy', 'support'));
  end if;
  perform ehr.order_route_notify_patient(closed.closed, 'ORDER_ROUTE_CANCELLED');
  return query select (closed.closed).id, (closed.closed).row_version, (closed.closed).state;
end;
$$;

-- C23. Support lists or unlists a laboratory or pharmacy for orders from
-- other facilities (P6). Accepted work is not affected.
create function identity.admin_set_order_route_destination(target_facility_id uuid, requested_listed boolean,
  set_reason text)
returns table (facility_id uuid, listed boolean, set_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := identity.order_route_platform_actor(array['platform.facility.manage',
    'platform.facility.unlock']);
  reason text := btrim(coalesce(set_reason, ''));
  facility_row identity.facilities%rowtype;
  inserted identity.order_route_destination_settings%rowtype;
begin
  if target_facility_id is null or requested_listed is null or length(reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_DESTINATION_INVALID';
  end if;
  select facility.* into facility_row from identity.facilities facility where facility.id = target_facility_id;
  if facility_row.id is null
     or not exists (select 1 from identity.organization_applications application
                     where application.organization_id = facility_row.organization_id
                       and application.organization_type in ('laboratory', 'pharmacy')) then
    raise exception using errcode = 'P0002', message = 'ORDER_ROUTE_DESTINATION_NOT_FOUND';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('order-route-destination-setting:' || target_facility_id::text, 0));
  if identity.order_route_destination_listed(target_facility_id) = requested_listed then
    raise exception using errcode = '23505', message = 'ORDER_ROUTE_DESTINATION_UNCHANGED';
  end if;
  insert into identity.order_route_destination_settings as setting (facility_id, organization_id, listed, reason,
    set_by_account_id, correlation_id)
  values (facility_row.id, facility_row.organization_id, requested_listed, reason, actor_account,
    platform.current_correlation_id())
  returning setting.* into inserted;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
    resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details)
  values (platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
    'admin.order-route-destination.set', 'success', 'facility', facility_row.id::text, 'healthcare-operations',
    reason, 'application', 'identity-api',
    jsonb_build_object('facilityId', facility_row.id, 'listed', requested_listed, 'settingId', inserted.id));
  insert into audit.events (correlation_id, actor_type, organization_id, facility_id, action, outcome,
    resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'system', facility_row.organization_id, facility_row.id,
    'identity.order-route-destination.set', 'success', 'facility', facility_row.id::text, 'healthcare-operations',
    'application', 'identity-api', jsonb_build_object('listed', requested_listed, 'settingId', inserted.id));
  return query select inserted.facility_id, inserted.listed, inserted.set_at;
end;
$$;

revoke all on function identity.search_order_destinations(text,text),
  identity.admin_order_route_summary(uuid),
  identity.admin_find_order_routes(text,text),
  identity.admin_close_order_route(uuid,bigint,text),
  identity.admin_set_order_route_destination(uuid,boolean,text)
  from public;

-- 6.5 Changed functions (CREATE OR REPLACE keeps each one's owner, grants,
-- language, volatility, security and search path; ehr.order_routes is
-- schema-qualified wherever a search path lacks ehr). No table lock.

-- The Lab and Pharmacy chain tables' policies gain one branch: route access
-- (H6) when the member's own consent does not allow the action.
create or replace function lab.context_allows(row_patient_id uuid,row_facility_id uuid,requested_action text)
returns boolean language sql stable security definer
set search_path = lab,identity,platform,pg_temp as $$
  select row_facility_id=platform.current_facility_id()
    and (identity.has_active_consent_grant(row_patient_id,platform.current_actor_subject(),
      platform.current_membership_id(),row_facility_id,requested_action,platform.current_purpose_of_use())
      or ehr.order_route_access_allows('lab_request',row_patient_id,row_facility_id,requested_action))
$$;

create or replace function pharmacy.context_allows(
  row_patient_id uuid,
  row_facility_id uuid,
  requested_action text
) returns boolean language sql stable security definer
set search_path = pharmacy, identity, platform, pg_temp as $$
  select row_facility_id = platform.current_facility_id()
    and (identity.has_active_consent_grant(
      row_patient_id,
      platform.current_actor_subject(),
      platform.current_membership_id(),
      row_facility_id,
      requested_action,
      platform.current_purpose_of_use()
    )
      or ehr.order_route_access_allows('prescription', row_patient_id, row_facility_id, requested_action))
$$;

-- A route-backed Lab work item must be exactly its accepted route's (C9
-- inserts it after accepting the route, which it holds FOR UPDATE); a
-- same-facility one keeps 0077's checks and is refused while the order has a
-- live route (LAB_REQUEST_ROUTED; the unique work-item key stays the final
-- arbiter, R10).
create or replace function lab.validate_work_item()
returns trigger language plpgsql security definer
set search_path = lab, ehr, identity, auth, platform, pg_temp as $$
declare source_row ehr.lab_requests%rowtype;
  route_row ehr.order_routes%rowtype;
  session_facility uuid := platform.current_facility_id();
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
begin
  if new.order_route_id is not null then
    select route.* into route_row from ehr.order_routes route where route.id = new.order_route_id for update;
    if route_row.id is null or session_facility is null
       or actor_account is null or actor_membership is null
       or route_row.kind is distinct from 'lab_request'
       or route_row.state is distinct from 'accepted'
       or route_row.lab_work_item_id is distinct from new.id
       or route_row.patient_id is distinct from new.patient_id
       or route_row.receiving_facility_id is distinct from new.facility_id
       or route_row.ordering_facility_id is distinct from new.ordering_facility_id
       or route_row.source_lab_request_id is distinct from new.source_ehr_order_id
       or route_row.source_order_version is distinct from new.source_ehr_order_version
       or route_row.source_encounter_id is distinct from new.source_encounter_id
       or route_row.test_code_system is distinct from new.test_code_system
       or route_row.test_code is distinct from new.test_code
       or route_row.test_display is distinct from new.test_name
       or route_row.priority is distinct from new.priority
       or route_row.clinical_information is distinct from new.clinical_indication
       or route_row.orderer_account_id is distinct from new.requested_by
       or route_row.requested_at is distinct from new.requested_at
       or route_row.accepted_by_account_id is distinct from new.accepted_by
       or route_row.accepted_by_membership_id is distinct from new.accepted_by_membership_id
       or new.facility_id is distinct from session_facility
       or new.accepted_by is distinct from actor_account
       or new.accepted_by_membership_id is distinct from actor_membership then
      raise exception using errcode='23514',message='Lab work item does not match its accepted order route and actor context';
    end if;
    return new;
  end if;
  select * into source_row from ehr.lab_requests where id=new.source_ehr_order_id;
  if source_row.id is null or session_facility is null
     or actor_account is null or actor_membership is null
     or source_row.patient_id is distinct from new.patient_id
     or source_row.facility_id is distinct from new.facility_id
     or source_row.encounter_id is distinct from new.source_encounter_id
     or source_row.row_version is distinct from new.source_ehr_order_version
     or source_row.status is distinct from 'active'
     or source_row.test_code_system is distinct from new.test_code_system
     or source_row.test_code is distinct from new.test_code
     or source_row.test_display is distinct from new.test_name
     or source_row.priority is distinct from new.priority
     or source_row.clinical_information is distinct from new.clinical_indication
     or source_row.created_by is distinct from new.requested_by
     or source_row.created_at is distinct from new.requested_at
     or new.facility_id is distinct from session_facility
     or new.accepted_by is distinct from actor_account
     or new.accepted_by_membership_id is distinct from actor_membership then
    raise exception using errcode='23514',message='Lab work item does not match the exact active EHR order version and actor context';
  end if;
  perform 1 from ehr.order_routes route
   where route.source_lab_request_id = new.source_ehr_order_id
     and (route.state in ('accepted', 'completed') or (route.state = 'sent' and clock_timestamp() < route.respond_by))
   for share;
  if found then
    raise exception using errcode='23514',message='LAB_REQUEST_ROUTED';
  end if;
  return new;
end
$$;

-- The Pharmacy twin: a route-backed work item is exactly its accepted
-- route's prescription snapshot; a same-facility one keeps 0077's checks and
-- is refused while the prescription has a live route (PRESCRIPTION_ROUTED).
create or replace function pharmacy.validate_work_item()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
  route_row ehr.order_routes%rowtype;
begin
  if new.order_route_id is not null then
    select route.* into route_row from ehr.order_routes route where route.id = new.order_route_id for update;
    if route_row.id is null
       or session_facility_id is null
       or session_account_id is null
       or session_membership_id is null
       or route_row.kind is distinct from 'prescription'
       or route_row.state is distinct from 'accepted'
       or route_row.pharmacy_work_item_id is distinct from new.id
       or route_row.patient_id is distinct from new.patient_id
       or route_row.receiving_facility_id is distinct from new.facility_id
       or route_row.ordering_facility_id is distinct from new.ordering_facility_id
       or route_row.source_prescription_id is distinct from new.source_ehr_prescription_id
       or route_row.source_order_version is distinct from new.source_ehr_prescription_version
       or route_row.source_encounter_id is distinct from new.source_encounter_id
       or route_row.medication_code_system is distinct from new.medication_code_system
       or route_row.medication_code is distinct from new.medication_code
       or route_row.medication_display is distinct from new.medication_display
       or route_row.dose_quantity is distinct from new.dose_quantity
       or route_row.dose_unit is distinct from new.dose_unit
       or route_row.route_code is distinct from new.route_code
       or route_row.frequency is distinct from new.frequency
       or route_row.instructions is distinct from new.instructions
       or route_row.starts_on is distinct from new.starts_on
       or route_row.ends_on is distinct from new.ends_on
       or route_row.orderer_account_id is distinct from new.prescribed_by
       or route_row.prescribed_at is distinct from new.prescribed_at
       or route_row.accepted_by_account_id is distinct from new.accepted_by
       or route_row.accepted_by_membership_id is distinct from new.accepted_by_membership_id
       or new.facility_id is distinct from session_facility_id
       or new.accepted_by is distinct from session_account_id
       or new.accepted_by_membership_id is distinct from session_membership_id
       or new.source_status is distinct from 'active' then
      raise exception using errcode = '23514',
        message = 'Pharmacy work item does not match its accepted order route and actor context';
    end if;
    return new;
  end if;
  if session_facility_id is null
     or session_account_id is null
     or session_membership_id is null
     or new.facility_id is distinct from new.ordering_facility_id
     or new.facility_id is distinct from session_facility_id
     or new.accepted_by is distinct from session_account_id
     or new.accepted_by_membership_id is distinct from session_membership_id
     or new.source_status is distinct from 'active' then
    raise exception using errcode = '23514',
      message = 'Pharmacy acceptance patient, facility, prescription status, or actor context is invalid';
  end if;
  perform 1 from ehr.order_routes route
   where route.source_prescription_id = new.source_ehr_prescription_id
     and (route.state in ('accepted', 'completed') or (route.state = 'sent' and clock_timestamp() < route.respond_by))
   for share;
  if found then
    raise exception using errcode = '23514', message = 'PRESCRIPTION_ROUTED';
  end if;
  return new;
end
$$;

-- A dispensing of a route-backed work item locks its route FOR UPDATE (V9: a
-- concurrent cancellation makes the SERIALIZABLE dispensing fail and its
-- retry be refused) and needs it accepted and inside its work window
-- (ORDER_ROUTE_CLOSED); a same-facility dispensing is unchanged.
create or replace function pharmacy.validate_dispensing()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  parent_row pharmacy.work_items%rowtype;
  route_row ehr.order_routes%rowtype;
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
begin
  select * into parent_row from pharmacy.work_items where id = new.work_item_id;
  if parent_row.order_route_id is not null then
    select route.* into route_row from ehr.order_routes route where route.id = parent_row.order_route_id for update;
    if route_row.id is null or route_row.state is distinct from 'accepted'
       or not coalesce(clock_timestamp() < route_row.writes_end_at, false) then
      raise exception using errcode = '23514', message = 'ORDER_ROUTE_CLOSED';
    end if;
  end if;
  if parent_row.id is null
     or session_facility_id is null
     or session_account_id is null
     or session_membership_id is null
     or parent_row.patient_id is distinct from new.patient_id
     or parent_row.facility_id is distinct from new.facility_id
     or parent_row.row_version is distinct from new.work_item_version
     or parent_row.medication_code_system is distinct from new.medication_code_system
     or parent_row.medication_code is distinct from new.medication_code
     or parent_row.medication_display is distinct from new.medication_display
     or new.facility_id is distinct from session_facility_id
     or new.dispensed_by is distinct from session_account_id
     or new.dispensed_by_membership_id is distinct from session_membership_id then
    raise exception using errcode = '23514',
      message = 'Dispensing does not match its eligible Pharmacy work item and actor context';
  end if;
  return new;
end
$$;

-- 6.6 Trigger functions (owner-only).

-- The route guard (P5): no delete; immutable header, snapshot and
-- attestation; each transition column set once; only the transitions of the
-- state table; the windows only as section 4.2 allows (set at acceptance,
-- set at completion, never longer afterwards); the version exactly one
-- more; and an event of that version with the same state and windows.
create function ehr.guard_order_route_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, ehr, pg_temp
as $$
declare
  allowed boolean := true;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'ORDER_ROUTE_IMMUTABLE';
  end if;
  if (new.id, new.kind, new.patient_id, new.ordering_organization_id, new.ordering_facility_id,
      new.source_lab_request_id, new.source_prescription_id, new.source_encounter_id, new.source_order_version,
      new.receiving_organization_id, new.receiving_facility_id, new.sent_by_account_id, new.sent_by_membership_id,
      new.created_at, new.respond_by, new.patient_agreement, new.attestation_text_version, new.attested_by_name,
      new.attested_receiving_facility_name, new.orderer_account_id, new.orderer_membership_id, new.orderer_name,
      new.orderer_licence_body, new.orderer_licence_number, new.test_code_system, new.test_code, new.test_display,
      new.priority, new.specimen_type_code, new.clinical_information, new.requested_at, new.medication_code_system,
      new.medication_code, new.medication_display, new.dose_quantity, new.dose_unit, new.route_code, new.frequency,
      new.instructions, new.starts_on, new.ends_on, new.prescribed_at, new.idempotency_key, new.request_sha256,
      new.correlation_id)
     is distinct from
     (old.id, old.kind, old.patient_id, old.ordering_organization_id, old.ordering_facility_id,
      old.source_lab_request_id, old.source_prescription_id, old.source_encounter_id, old.source_order_version,
      old.receiving_organization_id, old.receiving_facility_id, old.sent_by_account_id, old.sent_by_membership_id,
      old.created_at, old.respond_by, old.patient_agreement, old.attestation_text_version, old.attested_by_name,
      old.attested_receiving_facility_name, old.orderer_account_id, old.orderer_membership_id, old.orderer_name,
      old.orderer_licence_body, old.orderer_licence_number, old.test_code_system, old.test_code, old.test_display,
      old.priority, old.specimen_type_code, old.clinical_information, old.requested_at, old.medication_code_system,
      old.medication_code, old.medication_display, old.dose_quantity, old.dose_unit, old.route_code, old.frequency,
      old.instructions, old.starts_on, old.ends_on, old.prescribed_at, old.idempotency_key, old.request_sha256,
      old.correlation_id) then
    allowed := false;
  end if;
  -- Set once.
  if (old.accepted_at is not null and new.accepted_at is distinct from old.accepted_at)
     or (old.accepted_by_account_id is not null and new.accepted_by_account_id is distinct from old.accepted_by_account_id)
     or (old.accepted_by_membership_id is not null
       and new.accepted_by_membership_id is distinct from old.accepted_by_membership_id)
     or (old.accept_idempotency_key is not null and new.accept_idempotency_key is distinct from old.accept_idempotency_key)
     or (old.accept_request_sha256 is not null and new.accept_request_sha256 is distinct from old.accept_request_sha256)
     or (old.accept_locked_at is not null and new.accept_locked_at is distinct from old.accept_locked_at)
     or (old.lab_work_item_id is not null and new.lab_work_item_id is distinct from old.lab_work_item_id)
     or (old.pharmacy_work_item_id is not null and new.pharmacy_work_item_id is distinct from old.pharmacy_work_item_id)
     or (old.declined_at is not null and new.declined_at is distinct from old.declined_at)
     or (old.declined_by_account_id is not null and new.declined_by_account_id is distinct from old.declined_by_account_id)
     or (old.declined_by_membership_id is not null
       and new.declined_by_membership_id is distinct from old.declined_by_membership_id)
     or (old.decline_reason is not null and new.decline_reason is distinct from old.decline_reason)
     or (old.ended_at is not null and new.ended_at is distinct from old.ended_at)
     or (old.ended_kind is not null and new.ended_kind is distinct from old.ended_kind)
     or (old.ended_by_account_id is not null and new.ended_by_account_id is distinct from old.ended_by_account_id)
     or (old.completed_at is not null and new.completed_at is distinct from old.completed_at) then
    allowed := false;
  end if;
  -- A set-once column changes only with its own transition.
  if (old.accepted_at is null and new.accepted_at is not null and not (old.state = 'sent' and new.state = 'accepted'))
     or (old.accept_locked_at is null and new.accept_locked_at is not null
       and not (old.state = 'sent' and new.state = 'sent'))
     or (old.declined_at is null and new.declined_at is not null and new.state <> 'declined')
     or (old.completed_at is null and new.completed_at is not null and new.state <> 'completed') then
    allowed := false;
  end if;
  if new.row_version is distinct from old.row_version + 1 then
    allowed := false;
  end if;
  if (old.state, new.state) not in (('sent', 'sent'), ('sent', 'accepted'), ('sent', 'declined'),
       ('sent', 'withdrawn'), ('sent', 'expired'), ('accepted', 'accepted'), ('accepted', 'completed'),
       ('accepted', 'cancelled'), ('completed', 'completed')) then
    allowed := false;
  end if;
  -- The windows (section 4.2, absolute hours).
  if old.state = 'sent' and new.state = 'accepted' then
    if new.writes_end_at is distinct from new.accepted_at + interval '720 hours'
       or new.access_ends_at is distinct from new.writes_end_at then
      allowed := false;
    end if;
  elsif old.state = 'accepted' and new.state = 'completed' then
    if new.writes_end_at is distinct from least(new.completed_at + interval '336 hours',
                                                new.accepted_at + interval '1080 hours')
       or new.access_ends_at is distinct from new.writes_end_at then
      allowed := false;
    end if;
  elsif old.state in ('accepted', 'completed') and new.state in ('cancelled', 'completed') then
    if new.writes_end_at > old.writes_end_at or new.access_ends_at > old.access_ends_at then
      allowed := false;
    end if;
  elsif (new.writes_end_at, new.access_ends_at) is distinct from (old.writes_end_at, old.access_ends_at) then
    allowed := false;
  end if;
  if not exists (select 1 from ehr.order_route_events event
                  where event.route_id = new.id
                    and event.event_version = new.row_version
                    and event.state_after = new.state
                    and event.writes_end_at_after is not distinct from new.writes_end_at
                    and event.access_ends_at_after is not distinct from new.access_ends_at) then
    allowed := false;
  end if;
  if not allowed then
    raise exception using errcode = '55000', message = 'ORDER_ROUTE_IMMUTABLE';
  end if;
  return new;
end;
$$;

-- Event 1 must exist when the inserting transaction commits (P5), and a
-- route is inserted sent at version 1. The check is deferred to commit, where
-- it runs as the role that commits (the EHR runtime, which reads no route
-- table), so it runs as the owner.
create function ehr.require_order_route_first_event()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, ehr, pg_temp
as $$
begin
  if new.state <> 'sent' or new.row_version <> 1
     or not exists (select 1 from ehr.order_route_events event
                     where event.route_id = new.id and event.event_version = 1
                       and event.event_type = 'created' and event.state_after = 'sent') then
    raise exception using errcode = '55000', message = 'ORDER_ROUTE_IMMUTABLE';
  end if;
  return null;
end;
$$;

create trigger order_routes_guard
  before update or delete on ehr.order_routes
  for each row execute function ehr.guard_order_route_mutation();
create constraint trigger order_routes_first_event
  after insert on ehr.order_routes
  deferrable initially deferred
  for each row execute function ehr.require_order_route_first_event();

-- The mirror (7.2), in the ordering facility's transaction, after any update
-- of a routed lab request or prescription (the EHR holds the order's row
-- lock; every update bumps row_version): a sent route is withdrawn (expired
-- when past respond_by); an accepted lab request leaving active, or any
-- change of an accepted prescription, cancels it (entered in error ends
-- access now); an edit of an active accepted lab request, or any change after
-- completion, is an event (entered in error ends access now, and the patient
-- is told ORDER_ROUTE_CANCELLED).
create function ehr.sync_order_routes_on_order_change()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, ehr, identity, audit, notification, platform, pg_temp
as $$
declare
  route_row ehr.order_routes%rowtype;
  changed ehr.order_routes%rowtype;
  written ehr.order_routes%rowtype;
  closed record;
  order_kind text := case tg_table_name when 'lab_requests' then 'lab_request' else 'prescription' end;
  in_error boolean := new.status = 'entered_in_error';
  change_kind text := case when new.status = 'entered_in_error' then 'entered_in_error' else 'order_changed' end;
begin
  if not exists (select 1 from ehr.order_routes route
                  where ((order_kind = 'lab_request' and route.source_lab_request_id = new.id)
                      or (order_kind = 'prescription' and route.source_prescription_id = new.id))
                    and route.state in ('sent', 'accepted', 'completed')) then
    return null;
  end if;
  for route_row in
    select route.* from ehr.order_routes route
     where ((order_kind = 'lab_request' and route.source_lab_request_id = new.id)
         or (order_kind = 'prescription' and route.source_prescription_id = new.id))
       and route.state in ('sent', 'accepted', 'completed')
     order by route.id
     for update
  loop
    if route_row.state = 'sent' then
      select * into closed from ehr.close_order_route(route_row.id, change_kind, 'ordering', true);
      if closed.outcome = 'withdrawn' then
        perform ehr.order_route_system_audit(closed.closed, 'receiving', 'ehr.order-route.withdrawn', false, null);
        perform ehr.order_route_notify_patient(closed.closed, 'ORDER_ROUTE_WITHDRAWN');
      end if;
    elsif route_row.state = 'accepted'
          and (order_kind = 'prescription' or new.status <> 'active' or in_error) then
      select * into closed from ehr.close_order_route(route_row.id, change_kind, 'ordering', in_error);
      perform ehr.order_route_system_audit(closed.closed, 'receiving', 'ehr.order-route.cancelled', true,
        jsonb_build_object('orderVersion', new.row_version));
      perform ehr.order_route_notify_patient(closed.closed, 'ORDER_ROUTE_CANCELLED');
    elsif route_row.state = 'completed' and in_error and route_row.ended_at is null then
      select * into closed from ehr.close_order_route(route_row.id, 'entered_in_error', 'ordering', true);
      perform ehr.order_route_system_audit(closed.closed, 'receiving', 'ehr.order-route.order-changed', true,
        jsonb_build_object('orderVersion', new.row_version));
      -- The patient is told, as for a sent or accepted route closed so; C5
      -- then shows the route without its content.
      if closed.outcome = 'access_ended' then
        perform ehr.order_route_notify_patient(closed.closed, 'ORDER_ROUTE_CANCELLED');
      end if;
    else
      changed := route_row;
      written := ehr.write_order_route_change(route_row, changed,
        case when route_row.state = 'accepted' then 'order_changed_after_acceptance'
             else 'order_changed_after_completion' end, 'ordering', change_kind);
      perform ehr.order_route_system_audit(written, 'receiving', 'ehr.order-route.order-changed', true,
        jsonb_build_object('orderVersion', new.row_version));
    end if;
  end loop;
  return null;
end;
$$;

-- The release (7.3): when support releases a self-signed-up organization
-- (identity.admin_release_self_service_facility sets self_service_released_at
-- last, after the facilities are suspended and the administrator disabled),
-- every live route of its facilities is closed, both ways, access ending now;
-- each affected patient is told and each counterpart facility gets a system
-- row; one platform row records the counts. Nothing is written for an
-- organization that never had a route.
create function ehr.close_order_routes_on_release()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, ehr, identity, audit, notification, platform, pg_temp
as $$
declare
  route_row ehr.order_routes%rowtype;
  closed record;
  released_kind text;
  withdrawn_count integer := 0;
  cancelled_count integer := 0;
  ended_count integer := 0;
  accepted_lifetime integer;
  patients_lifetime integer;
begin
  if new.organization_id is null
     or not exists (select 1 from ehr.order_routes route
                     where route.ordering_organization_id = new.organization_id
                        or route.receiving_organization_id = new.organization_id) then
    return null;
  end if;
  select count(*), count(distinct route.patient_id) into accepted_lifetime, patients_lifetime
    from ehr.order_routes route
   where route.receiving_organization_id = new.organization_id and route.accepted_at is not null;
  for route_row in
    select route.* from ehr.order_routes route
     where (route.ordering_organization_id = new.organization_id
         or route.receiving_organization_id = new.organization_id)
       and (route.state in ('sent', 'accepted') or (route.state = 'completed' and route.ended_at is null))
     order by route.id
  loop
    released_kind := case when route_row.receiving_organization_id = new.organization_id
                          then 'receiving_released' else 'ordering_released' end;
    select * into closed from ehr.close_order_route(route_row.id, released_kind, 'platform', true);
    if closed.outcome in ('withdrawn', 'cancelled', 'access_ended') then
      if closed.outcome = 'withdrawn' then
        withdrawn_count := withdrawn_count + 1;
      elsif closed.outcome = 'cancelled' then
        cancelled_count := cancelled_count + 1;
      else
        ended_count := ended_count + 1;
      end if;
      if released_kind = 'receiving_released' then
        perform ehr.order_route_system_audit(closed.closed, 'ordering', 'ehr.order-route.closed', true,
          jsonb_build_object('closedBy', released_kind));
      elsif closed.outcome = 'withdrawn' then
        perform ehr.order_route_system_audit(closed.closed, 'receiving', 'ehr.order-route.withdrawn', false,
          jsonb_build_object('closedBy', released_kind));
      else
        perform ehr.order_route_system_audit(closed.closed, 'receiving', 'ehr.order-route.closed', true,
          jsonb_build_object('closedBy', released_kind));
      end if;
      perform ehr.order_route_notify_patient(closed.closed, 'ORDER_ROUTE_CANCELLED');
    end if;
  end loop;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
    resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'platform', platform.current_actor_subject(),
    platform.current_account_id(), 'admin.self-service-facility.release-order-routes', 'success',
    'organization-application', new.id::text, 'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('applicationId', new.id, 'withdrawn', withdrawn_count, 'cancelled', cancelled_count,
      'accessEnded', ended_count, 'acceptedLifetime', accepted_lifetime, 'patientsLifetime', patients_lifetime));
  return null;
end;
$$;

create trigger organization_applications_order_routes_release
  after update of self_service_released_at on identity.organization_applications
  for each row
  when (old.self_service_released_at is null and new.self_service_released_at is not null)
  execute function ehr.close_order_routes_on_release();

-- Results back to the ordering facility (6), in B's transaction. A release
-- on a cancelled route, or on an accepted route past its work window, is
-- refused (23514 ORDER_ROUTE_CLOSED) whatever consent the writer holds (P3);
-- the first release completes the route and sets both windows; later ones
-- (corrections) are reports and events that move nothing. A completed route
-- past its window still files a release made under the patient's consent.
create function lab.return_order_route_result()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, lab, ehr, platform, pg_temp
as $$
declare
  item_route uuid;
  item_id uuid;
  test_system text;
  test_code_value text;
  test_name_value text;
  revision lab.result_revisions%rowtype;
  route_row ehr.order_routes%rowtype;
  changed ehr.order_routes%rowtype;
  written ehr.order_routes%rowtype;
begin
  select item.order_route_id, item.id, test.code_system, test.code, test.name
    into item_route, item_id, test_system, test_code_value, test_name_value
    from lab.test_executions execution
    join lab.work_item_requested_tests test on test.id = execution.requested_test_id
    join lab.work_items item on item.id = test.work_item_id
   where execution.id = new.execution_id;
  if item_route is null then
    return null;
  end if;
  select route.* into route_row from ehr.order_routes route where route.id = item_route for update;
  if route_row.state = 'cancelled'
     or (route_row.state = 'accepted' and clock_timestamp() >= route_row.writes_end_at) then
    raise exception using errcode = '23514', message = 'ORDER_ROUTE_CLOSED';
  end if;
  select candidate.* into revision from lab.result_revisions candidate
   where candidate.result_id = new.result_id and candidate.version = new.result_version;
  insert into lab.order_route_result_reports (route_id, work_item_id, result_id, result_version, kind,
    test_code_system, test_code, test_name, result_type, numeric_value, text_value, unit, reference_range,
    abnormal_flag, revision_kind, correction_reason, occurred_at, performing_facility_id)
  values (route_row.id, item_id, new.result_id, new.result_version, 'released', test_system,
    test_code_value, test_name_value, revision.result_type, revision.numeric_value, revision.text_value,
    revision.unit, revision.reference_range, revision.abnormal_flag, revision.revision_kind,
    revision.correction_reason, new.released_at, new.facility_id);
  changed := route_row;
  if route_row.state = 'accepted' then
    changed.state := 'completed';
    changed.completed_at := clock_timestamp();
    changed.writes_end_at := least(changed.completed_at + interval '336 hours',
                                   route_row.accepted_at + interval '1080 hours');
    changed.access_ends_at := changed.writes_end_at;
    written := ehr.write_order_route_change(route_row, changed, 'completed', 'receiving', null);
  else
    written := ehr.write_order_route_change(route_row, changed, 'result_returned', 'receiving', null);
  end if;
  perform ehr.order_route_system_audit(written, 'ordering', 'ehr.order-route.result-returned', true,
    jsonb_build_object('resultId', new.result_id, 'version', new.result_version));
  return null;
end;
$$;

-- An invalidation of a result version that came back is reported too (never
-- refused: clinical safety); one that never came back crosses nothing.
create function lab.return_order_route_invalidation()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, lab, ehr, platform, pg_temp
as $$
declare
  released lab.order_route_result_reports%rowtype;
  route_row ehr.order_routes%rowtype;
  written ehr.order_routes%rowtype;
begin
  select report.* into released from lab.order_route_result_reports report
   where report.result_id = new.result_id and report.result_version = new.result_version
     and report.kind = 'released';
  if released.id is null then
    return null;
  end if;
  select route.* into route_row from ehr.order_routes route where route.id = released.route_id for update;
  insert into lab.order_route_result_reports (route_id, work_item_id, result_id, result_version, kind,
    test_code_system, test_code, test_name, occurred_at, performing_facility_id)
  values (released.route_id, released.work_item_id, new.result_id, new.result_version, 'entered_in_error',
    released.test_code_system, released.test_code, released.test_name, new.occurred_at, new.facility_id);
  written := ehr.write_order_route_change(route_row, route_row, 'result_marked_in_error', 'receiving', null);
  perform ehr.order_route_system_audit(written, 'ordering', 'ehr.order-route.result-marked-in-error', true,
    jsonb_build_object('resultId', new.result_id, 'version', new.result_version));
  return null;
end;
$$;

-- Dispensing back to the ordering facility; the dispensing validator has
-- already locked the route and refused a closed one.
create function pharmacy.return_order_route_dispensing()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pharmacy, ehr, platform, pg_temp
as $$
declare
  item_route uuid;
  route_row ehr.order_routes%rowtype;
  changed ehr.order_routes%rowtype;
  written ehr.order_routes%rowtype;
begin
  select item.order_route_id into item_route from pharmacy.work_items item where item.id = new.work_item_id;
  if item_route is null then
    return null;
  end if;
  select route.* into route_row from ehr.order_routes route where route.id = item_route for update;
  insert into pharmacy.order_route_dispensing_reports (route_id, work_item_id, dispensing_id, kind,
    medication_code_system, medication_code, medication_display, quantity_dispensed, quantity_unit, occurred_at,
    performing_facility_id)
  values (route_row.id, new.work_item_id, new.id, 'dispensed', new.medication_code_system, new.medication_code,
    new.medication_display, new.quantity_dispensed, new.quantity_unit, new.dispensed_at, new.facility_id);
  changed := route_row;
  if route_row.state = 'accepted' then
    changed.state := 'completed';
    changed.completed_at := clock_timestamp();
    changed.writes_end_at := least(changed.completed_at + interval '336 hours',
                                   route_row.accepted_at + interval '1080 hours');
    changed.access_ends_at := changed.writes_end_at;
    written := ehr.write_order_route_change(route_row, changed, 'completed', 'receiving', null);
  else
    written := ehr.write_order_route_change(route_row, changed, 'dispensing_returned', 'receiving', null);
  end if;
  perform ehr.order_route_system_audit(written, 'ordering', 'ehr.order-route.dispensing-returned', true,
    jsonb_build_object('dispensingId', new.id, 'version', new.row_version));
  return null;
end;
$$;

-- A reversal is reported and never refused.
create function pharmacy.return_order_route_reversal()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pharmacy, ehr, platform, pg_temp
as $$
declare
  dispensed pharmacy.order_route_dispensing_reports%rowtype;
  route_row ehr.order_routes%rowtype;
  written ehr.order_routes%rowtype;
begin
  select report.* into dispensed from pharmacy.order_route_dispensing_reports report
   where report.dispensing_id = new.dispensing_id and report.kind = 'dispensed';
  if dispensed.id is null then
    return null;
  end if;
  select route.* into route_row from ehr.order_routes route where route.id = dispensed.route_id for update;
  insert into pharmacy.order_route_dispensing_reports (route_id, work_item_id, dispensing_id, reversal_id, kind,
    medication_code_system, medication_code, medication_display, quantity_dispensed, quantity_unit, occurred_at,
    performing_facility_id)
  values (dispensed.route_id, dispensed.work_item_id, new.dispensing_id, new.id, 'reversed',
    dispensed.medication_code_system, dispensed.medication_code, dispensed.medication_display,
    dispensed.quantity_dispensed, dispensed.quantity_unit, new.reversed_at, new.facility_id);
  written := ehr.write_order_route_change(route_row, route_row, 'dispensing_reversed', 'receiving', null);
  perform ehr.order_route_system_audit(written, 'ordering', 'ehr.order-route.dispensing-reversed', true,
    jsonb_build_object('dispensingId', new.dispensing_id, 'reversalId', new.id));
  return null;
end;
$$;

revoke all on function ehr.guard_order_route_mutation(), ehr.require_order_route_first_event(),
  ehr.sync_order_routes_on_order_change(), ehr.close_order_routes_on_release(),
  lab.return_order_route_result(), lab.return_order_route_invalidation(),
  pharmacy.return_order_route_dispensing(), pharmacy.return_order_route_reversal()
  from public;

-- 6.7 The clinical tables, the controls and the consent grants. From here to
-- commit this migration holds ACCESS EXCLUSIVE on the nine tables and on
-- platform.control_settings, and SHARE ROW EXCLUSIVE on
-- identity.consent_grants, all taken at once and never waited for: a busy
-- table makes the attempt fail at once (NOWAIT), the failed attempt's
-- subtransaction releases whatever it took, and the loop tries again 100 ms
-- later, so the migration never waits while holding one of them and no
-- reader queues behind a waiting lock of it (V1, V2). After 50 attempts (5
-- seconds) it stops the release with nothing applied (this is one file, one
-- transaction); the same approved release can be run again. Every reader of
-- clinical pages, Lab and Pharmacy, and every authenticated request's
-- control read, waits for the rest of this file only.
--
-- platform.control_settings and identity.consent_grants are taken here, not
-- later, because the previous Identity's emergency activation reads
-- platform.control_settings (platform.require_control_enabled, ACCESS SHARE
-- to commit) and then inserts into identity.consent_grants in one
-- transaction. Before this layout, section 5 created the probation trigger
-- (SHARE ROW EXCLUSIVE on identity.consent_grants) and the control section
-- below waited for ACCESS EXCLUSIVE on platform.control_settings while
-- holding it and the nine: such an activation started in between deadlocked
-- with the migration (40P01), and every control read queued behind the
-- waiting lock until the deadlock was detected. Now nothing before this block
-- locks either table, and nothing after it waits for a lock an activation can
-- hold: an activation in flight only makes an attempt fail and retry. No other
-- running service reads a control inside a transaction (checked against
-- 57a94db: the guards and the EHR's checks read with a pool statement).
do $$
declare
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table lab.work_items, pharmacy.work_items, ehr.lab_requests, ehr.encounters, ehr.prescriptions,
        lab.result_releases, lab.result_invalidations, pharmacy.dispensings, pharmacy.dispensing_reversals,
        platform.control_settings
        in access exclusive mode nowait;
      lock table identity.consent_grants in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0086: the clinical order tables stayed busy for 5 seconds; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$$;

-- P4b's probation trigger (5.6), under the lock the block above holds.
create trigger consent_grants_self_service_probation
  before insert on identity.consent_grants
  for each row when (new.break_glass)
  execute function identity.enforce_self_service_break_glass_probation();

-- Lab work items bound to a route: the route column and its unique index;
-- the facility rule (a route-backed item is at another facility than the
-- ordering one, any other at the same); the EHR keys by the ordering
-- facility (equal to the old ones for every existing row, whose facility is
-- the ordering facility); the strict policies; and, last, the old check and
-- keys. The new keys are validated (every existing row has facility_id =
-- ordering_facility_id).
alter table lab.work_items
  add column order_route_id uuid references ehr.order_routes(id) on delete restrict;
create unique index work_items_order_route_uq on lab.work_items (order_route_id) where order_route_id is not null;
alter table lab.work_items
  add constraint work_items_route_facility_ck check (
    (order_route_id is null and facility_id = ordering_facility_id)
    or (order_route_id is not null and facility_id <> ordering_facility_id)),
  add constraint work_items_source_order_fk foreign key (source_ehr_order_id, patient_id, ordering_facility_id)
    references ehr.lab_requests(id, patient_id, facility_id) on delete restrict,
  add constraint work_items_source_encounter_fk foreign key (source_encounter_id, patient_id, ordering_facility_id)
    references ehr.encounters(id, patient_id, facility_id) on delete restrict;
drop policy lab_work_items_read on lab.work_items;
drop policy lab_work_items_insert on lab.work_items;
create policy lab_work_items_read on lab.work_items for select
  using (lab.work_item_allows(patient_id, facility_id, order_route_id, 'read_records'));
create policy lab_work_items_insert on lab.work_items for insert
  with check (lab.work_item_allows(patient_id, facility_id, order_route_id, 'write_records'));
alter table lab.work_items
  drop constraint work_items_source_ehr_order_id_patient_id_facility_id_fkey,
  drop constraint work_items_source_encounter_id_patient_id_facility_id_fkey,
  drop constraint work_items_check;

-- Pharmacy work items likewise (no EHR key exists, 0023).
alter table pharmacy.work_items
  add column order_route_id uuid references ehr.order_routes(id) on delete restrict;
create unique index work_items_order_route_uq on pharmacy.work_items (order_route_id)
  where order_route_id is not null;
alter table pharmacy.work_items
  add constraint work_items_route_facility_ck check (
    (order_route_id is null and facility_id = ordering_facility_id)
    or (order_route_id is not null and facility_id <> ordering_facility_id));
drop policy pharmacy_work_items_read on pharmacy.work_items;
drop policy pharmacy_work_items_insert on pharmacy.work_items;
create policy pharmacy_work_items_read on pharmacy.work_items for select
  using (pharmacy.work_item_allows(patient_id, facility_id, order_route_id, 'read_records'));
create policy pharmacy_work_items_insert on pharmacy.work_items for insert
  with check (pharmacy.work_item_allows(patient_id, facility_id, order_route_id, 'write_records'));
do $$
declare
  old_check name;
begin
  select constraint_row.conname into strict old_check
    from pg_constraint constraint_row
   where constraint_row.conrelid = 'pharmacy.work_items'::regclass and constraint_row.contype = 'c'
     and pg_get_constraintdef(constraint_row.oid) = 'CHECK ((facility_id = ordering_facility_id))';
  execute format('alter table pharmacy.work_items drop constraint %I', old_check);
end
$$;

-- The route's keys to the orders, the encounter and the work items (the
-- work-item keys deferred: acceptance records the work item's id on the route
-- before it inserts the work item), and the reports' keys to the work items.
alter table ehr.order_routes
  add constraint order_routes_source_lab_request_fk foreign key (source_lab_request_id, patient_id, ordering_facility_id)
    references ehr.lab_requests(id, patient_id, facility_id) on delete restrict,
  add constraint order_routes_source_prescription_fk
    foreign key (source_prescription_id, patient_id, ordering_facility_id)
    references ehr.prescriptions(id, patient_id, facility_id) on delete restrict,
  add constraint order_routes_source_encounter_fk foreign key (source_encounter_id, patient_id, ordering_facility_id)
    references ehr.encounters(id, patient_id, facility_id) on delete restrict,
  add constraint order_routes_lab_work_item_fk foreign key (lab_work_item_id)
    references lab.work_items(id) on delete restrict deferrable initially deferred,
  add constraint order_routes_pharmacy_work_item_fk foreign key (pharmacy_work_item_id)
    references pharmacy.work_items(id) on delete restrict deferrable initially deferred;
alter table lab.order_route_result_reports
  add constraint order_route_result_reports_work_item_fk foreign key (work_item_id)
    references lab.work_items(id) on delete restrict;
alter table pharmacy.order_route_dispensing_reports
  add constraint order_route_dispensing_reports_work_item_fk foreign key (work_item_id)
    references pharmacy.work_items(id) on delete restrict;

-- The mirror and the return triggers.
create trigger lab_requests_order_routes_sync
  after update on ehr.lab_requests
  for each row execute function ehr.sync_order_routes_on_order_change();
create trigger prescriptions_order_routes_sync
  after update on ehr.prescriptions
  for each row execute function ehr.sync_order_routes_on_order_change();
create trigger result_releases_order_route_return
  after insert on lab.result_releases
  for each row execute function lab.return_order_route_result();
create trigger result_invalidations_order_route_return
  after insert on lab.result_invalidations
  for each row execute function lab.return_order_route_invalidation();
create trigger dispensings_order_route_return
  after insert on pharmacy.dispensings
  for each row execute function pharmacy.return_order_route_dispensing();
create trigger dispensing_reversals_order_route_return
  after insert on pharmacy.dispensing_reversals
  for each row execute function pharmacy.return_order_route_reversal();

-- 7. Runtime grants (A5). runtime-grants.sql carries the same grants for a
-- later role bootstrap; this grants them to the roles that already exist,
-- since a release applies only migrations. The owner-only activation and the
-- lapse helper are granted to no role, and no role receives a privilege on
-- the counter tables. hid_identity_api_runtime inherits hid_identity_runtime.
-- platform.consume_qoreid_quota keeps 0049's grants (CREATE OR REPLACE).
-- Section 5's commands go to the Identity runtime (the staff context's state
-- read and support's commands to it alone), its staff, invitee and
-- signed-in commands also to the schema test runtime; its helpers, trigger
-- functions and tables to no role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.submit_self_service_organization_application(text,text,text,text,text,char),
      identity.public_get_organization_application(text,text,text),
      identity.public_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text),
      identity.begin_self_service_provider_enrollment(text,text,text,uuid,char,text,text),
      identity.prepare_self_service_provider_activation(char),
      identity.current_self_service_provider_enrollment(char),
      identity.self_service_provider_code_state(text,text,text),
      identity.activate_self_service_provider_enrollment(char,text),
      platform.consume_self_service_cac_quota(uuid,char,integer),
      identity.withdraw_self_service_provider_enrollment(char),
      identity.organization_self_service_state(uuid),
      identity.record_self_service_administrator_licence(text,text),
      identity.list_facility_staff(),
      identity.list_facility_staff_invitations(),
      identity.facility_staff_management_state(),
      identity.create_staff_invitation(uuid,uuid,text,text,text,text,text,text,text,char,char,char,text),
      identity.record_staff_invitation_delivery(uuid,text),
      identity.resend_staff_invitation(uuid,bigint,uuid,char,char,text),
      identity.revoke_staff_invitation(uuid,bigint),
      identity.end_facility_staff_membership(uuid,bigint,text),
      identity.change_facility_staff_role(uuid,bigint,text,text,text,text,text),
      identity.open_staff_invitation(uuid,char,text,char,char),
      identity.prepare_staff_invitation_acceptance(char),
      identity.accept_staff_invitation_with_password(char,text),
      identity.preview_staff_invitation_for_account(uuid,char,char),
      identity.accept_staff_invitation_for_account(uuid,char,char),
      identity.admin_list_facility_staff(uuid),
      identity.admin_set_self_service_administrator_role(uuid,bigint,text,text,text,text,text),
      identity.admin_end_self_service_probation(uuid,bigint,text),
      identity.admin_find_staff_invitations(text),
      identity.admin_list_self_service_facilities(text),
      identity.admin_review_self_service_facility(uuid,bigint,text,text,text,text,text),
      identity.admin_release_self_service_facility(uuid,bigint,text,boolean),
      identity.admin_list_open_self_service_applications(text),
      identity.admin_reject_self_service_application(uuid,bigint,text,boolean),
      identity.admin_waive_self_service_refusals(text,text,text)
      to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function identity.submit_self_service_organization_application(text,text,text,text,text,char),
      identity.public_get_organization_application(text,text,text),
      identity.public_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text),
      identity.begin_self_service_provider_enrollment(text,text,text,uuid,char,text,text),
      identity.prepare_self_service_provider_activation(char),
      identity.current_self_service_provider_enrollment(char),
      identity.self_service_provider_code_state(text,text,text),
      identity.activate_self_service_provider_enrollment(char,text),
      identity.withdraw_self_service_provider_enrollment(char),
      identity.record_self_service_administrator_licence(text,text),
      identity.list_facility_staff(),
      identity.list_facility_staff_invitations(),
      identity.facility_staff_management_state(),
      identity.create_staff_invitation(uuid,uuid,text,text,text,text,text,text,text,char,char,char,text),
      identity.record_staff_invitation_delivery(uuid,text),
      identity.resend_staff_invitation(uuid,bigint,uuid,char,char,text),
      identity.revoke_staff_invitation(uuid,bigint),
      identity.end_facility_staff_membership(uuid,bigint,text),
      identity.change_facility_staff_role(uuid,bigint,text,text,text,text,text),
      identity.open_staff_invitation(uuid,char,text,char,char),
      identity.prepare_staff_invitation_acceptance(char),
      identity.accept_staff_invitation_with_password(char,text),
      identity.preview_staff_invitation_for_account(uuid,char,char),
      identity.accept_staff_invitation_for_account(uuid,char,char),
      platform.consume_self_service_cac_quota(uuid,char,integer)
      to hid_schema_test_runtime;
  end if;
end
$$;

-- Section 6's commands (P4c): the EHR's to the EHR runtime, the Lab's and
-- the Pharmacy's (and the strict work-item policies' functions, which those
-- runtimes' queries evaluate) to theirs, the directory and support's to the
-- Identity runtime; all but support's (and the Identity runtime's copy of
-- the directory) also to the schema test runtime, whose rollback-only suite
-- inserts work items under the new policies (FEAS R1). The helpers, trigger
-- functions and tables go to no role. The patient inbox (0037) was never
-- granted to the Identity runtime on this branch, so its patient inbox
-- routes failed; main grants both functions in its runtime-grants.sql
-- (eb9b1ca:services/ehr-api/database/runtime-grants.sql:1664-1665), and the
-- order-route notices reach patients only through this inbox.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,char),
      ehr.withdraw_order_route(uuid,text,uuid,bigint,text),
      ehr.list_order_routes_for_order(text,uuid,uuid),
      ehr.order_route_summaries(text,uuid,uuid[]),
      ehr.patient_list_order_routes(),
      ehr.patient_stop_order_route(uuid,bigint),
      ehr.order_route_attestation_text(text)
      to hid_ehr_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_lab_runtime') then
    grant execute on function lab.list_order_routes(text,text),
      lab.get_order_route(uuid),
      lab.accept_order_route(uuid,bigint,text,text,text,char,text),
      lab.decline_order_route(uuid,bigint,text),
      lab.order_route_access_for(text,uuid,text),
      lab.order_route_cards(uuid[]),
      lab.work_item_allows(uuid,uuid,uuid,text)
      to hid_lab_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_pharmacy_runtime') then
    grant execute on function pharmacy.list_order_routes(text,text),
      pharmacy.get_order_route(uuid),
      pharmacy.accept_order_route(uuid,bigint,text,text,text,text,char,text),
      pharmacy.decline_order_route(uuid,bigint,text),
      pharmacy.order_route_access_for(text,uuid,text),
      pharmacy.order_route_cards(uuid[]),
      pharmacy.work_item_allows(uuid,uuid,uuid,text)
      to hid_pharmacy_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.search_order_destinations(text,text),
      identity.admin_order_route_summary(uuid),
      identity.admin_find_order_routes(text,text),
      identity.admin_close_order_route(uuid,bigint,text),
      identity.admin_set_order_route_destination(uuid,boolean,text),
      identity.list_my_notification_inbox(integer),
      identity.mark_my_notification_read(uuid)
      to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,char),
      ehr.withdraw_order_route(uuid,text,uuid,bigint,text),
      ehr.list_order_routes_for_order(text,uuid,uuid),
      ehr.order_route_summaries(text,uuid,uuid[]),
      ehr.patient_list_order_routes(),
      ehr.patient_stop_order_route(uuid,bigint),
      ehr.order_route_attestation_text(text),
      lab.list_order_routes(text,text),
      lab.get_order_route(uuid),
      lab.accept_order_route(uuid,bigint,text,text,text,char,text),
      lab.decline_order_route(uuid,bigint,text),
      lab.order_route_access_for(text,uuid,text),
      lab.order_route_cards(uuid[]),
      pharmacy.list_order_routes(text,text),
      pharmacy.get_order_route(uuid),
      pharmacy.accept_order_route(uuid,bigint,text,text,text,text,char,text),
      pharmacy.decline_order_route(uuid,bigint,text),
      pharmacy.order_route_access_for(text,uuid,text),
      pharmacy.order_route_cards(uuid[]),
      identity.search_order_destinations(text,text),
      lab.work_item_allows(uuid,uuid,uuid,text),
      pharmacy.work_item_allows(uuid,uuid,uuid,text)
      to hid_schema_test_runtime;
  end if;
end
$$;

-- 8. The controls (last). These statements need ACCESS EXCLUSIVE on
-- platform.control_settings, which every non-admin authenticated request
-- reads through platform.control_enabled; 6.7 already holds it (taken with
-- the nine clinical tables, NOWAIT), so none of them waits for a lock, and it
-- is held until commit; nothing follows them. The live key list is asserted
-- first (C10): the CHECK constraint and platform.control_enabled must name
-- exactly the six keys of 0039 and 0040, as this branch has them, so a
-- migration that changed either first makes this one stop instead of dropping
-- its keys. This migration's keys, provider_self_service_enabled (P4),
-- staff_invitations_enabled (P4b), cross_facility_orders_enabled and
-- cross_facility_route_access_enabled (P4c), are added at the end of the
-- three lists below (the CHECK, the seed and control_enabled). Every later control migration must carry all four
-- keys in its CHECK and in control_enabled. Section 6's commands and route
-- predicates read controls inside clinical transactions (V11), and the
-- Identity's emergency activation reads one and then writes
-- identity.consent_grants: a later migration that locks
-- platform.control_settings while it holds clinical locks or a lock on
-- identity.consent_grants must take it in the same NOWAIT attempt, as 6.7
-- does.
do $$
declare
  live_keys constant text[] := array['break_glass_enabled', 'maintenance_mode', 'outreach_portal_enabled',
    'patient_portal_enabled', 'provider_portal_enabled', 'uploads_enabled'];
  matching record;
  matched integer := 0;
  constraint_name name;
  check_keys text[];
  function_keys text[];
begin
  for matching in
    select constraint_row.conname, pg_get_constraintdef(constraint_row.oid) as definition
      from pg_constraint constraint_row
     where constraint_row.conrelid = 'platform.control_settings'::regclass
       and constraint_row.contype = 'c'
       and pg_get_constraintdef(constraint_row.oid) like '%control_key%'
  loop
    matched := matched + 1;
    constraint_name := matching.conname;
    select array_agg(distinct match[1] order by match[1]) into check_keys
      from regexp_matches(matching.definition, '''([a-z_]+)''', 'g') match;
  end loop;
  if matched <> 1 or check_keys is distinct from live_keys then
    raise exception '0086 expected one control_key check on platform.control_settings with the six live keys, found % with %',
      matched, check_keys;
  end if;
  select array_agg(distinct match[1] order by match[1]) into function_keys
    from pg_proc proc, regexp_matches(proc.prosrc, '''([a-z_]+)''', 'g') match
   where proc.oid = 'platform.control_enabled(text)'::regprocedure;
  if function_keys is distinct from live_keys then
    raise exception '0086 expected platform.control_enabled to accept the six live keys, found %', function_keys;
  end if;
  execute format('alter table platform.control_settings drop constraint %I', constraint_name);
end
$$;

alter table platform.control_settings add constraint control_settings_control_key_check check (control_key in (
  'patient_portal_enabled', 'provider_portal_enabled', 'outreach_portal_enabled',
  'maintenance_mode', 'uploads_enabled', 'break_glass_enabled',
  'provider_self_service_enabled', 'staff_invitations_enabled',
  'cross_facility_orders_enabled', 'cross_facility_route_access_enabled'
));

-- The seed (C2, R8). platform.control_settings has no INSERT policy, so an
-- owner that does not bypass row-level security cannot insert while the
-- table forces it. 0039 forces it; whether production's table still does is
-- not known here (an operator may have lifted it so that the definer
-- platform.control_enabled can read it). So the seed reads the table's
-- current state and, only if FORCE is on, lifts it for this one insert and
-- restores it at once, as main 0098 does; a table without FORCE is left
-- without it. Turning FORCE on where it was off would make every accountless
-- control read raise PLATFORM_CONTROL_UNAVAILABLE under such an owner (every
-- portal's guard, 503). Off: an administrator opens facility self sign-up
-- with the audited admin command, and staff invitations and orders between
-- facilities likewise. Work on accepted orders between facilities is seeded
-- on (no route can exist while orders are off); switching it off stops all
-- route-backed work at once.
do $$
declare
  was_forced boolean;
begin
  select relation.relforcerowsecurity into was_forced
    from pg_class relation
   where relation.oid = 'platform.control_settings'::regclass;
  if was_forced then
    execute 'alter table platform.control_settings no force row level security';
  end if;
  insert into platform.control_settings (control_key, enabled, reason, updated_by)
  values
    ('provider_self_service_enabled', false,
      'Facility self sign-up ships closed (P4); enable by audited admin command', null),
    ('staff_invitations_enabled', false,
      'Facility staff invitations ship closed (P4b); enable by audited admin command', null),
    ('cross_facility_orders_enabled', false,
      'Cross-facility orders ship closed (P4c); enable by audited admin command', null),
    ('cross_facility_route_access_enabled', true,
      'Work on accepted cross-facility orders; switch off only to stop it everywhere (P4c)', null)
  on conflict do nothing;
  if was_forced then
    execute 'alter table platform.control_settings force row level security';
  end if;
end
$$;

-- 0040's body, language, volatility, security and search path, with the new
-- keys added. CREATE OR REPLACE keeps the owner and the ACL (EXECUTE to PUBLIC).
-- platform.require_control_enabled and platform.admin_set_control (0078, which
-- validates the key by its row) need no change.
create or replace function platform.control_enabled(requested_key text)
returns boolean
language plpgsql
stable
security definer
set search_path=platform,pg_catalog,pg_temp
as $$
declare enabled_state boolean;
begin
  if requested_key not in (
    'patient_portal_enabled','provider_portal_enabled','outreach_portal_enabled',
    'maintenance_mode','uploads_enabled','break_glass_enabled',
    'provider_self_service_enabled','staff_invitations_enabled',
    'cross_facility_orders_enabled','cross_facility_route_access_enabled'
  ) then
    raise exception using errcode='22023', message='PLATFORM_CONTROL_INVALID';
  end if;

  select enabled into enabled_state
  from platform.control_settings
  where control_key = requested_key;

  if enabled_state is null then
    raise exception using errcode='55000', message='PLATFORM_CONTROL_UNAVAILABLE';
  end if;

  return enabled_state;
end
$$;
