-- 0123 Sealed QA tenant (owner decision Q60 of 2026-11-12, "build the QA
-- tenant / use the mails we used for demo"; the coordinator's answers of the
-- same day; the declaration signed separately, reviewed_by empty until the
-- owner signs). Provisional number: it gets the next free number at merge.
--
-- A third tenant beside the real one and 0098's sealed demo: QA Hospital, QA
-- Laboratory, QA Pharmacy (and the QA Outreach group its organiser starts),
-- for the owner's own end-to-end testing by hand and with a browser agent.
-- Unlike the demo it is not a showcase: every QA login does every real action.
-- Like the demo it is sealed in the database, where access is: nothing QA ever
-- reaches, shares with, orders to or finds a real or a demo facility, patient
-- or person, and nothing real or demo ever reaches QA.
--
-- Decisions:
-- D1 One new owner-only table, identity.sealed_qa_members (kind, id), marks
--    the QA organizations, facilities, accounts and patients. No live table
--    gains a column. A member is never both demo and QA (two triggers).
-- D2 Three sides: real, demo, QA. 0098's rule ("both demo or neither") stays
--    exactly as it is; this file adds the same rule for QA ("both QA or
--    neither") at every place 0098 enforces its own. Together they give three
--    sealed sides, because no member is both: a QA facility and a demo
--    patient fail 0098's rule, a QA facility and a real patient fail this
--    one. 0098's triggers and functions keep their bodies; this file adds
--    its own triggers beside them (G1q-G7q) and adds one QA clause, next to
--    0098's demo clause, to each body 0098 replaced (R1-R8) and to the
--    emergency-contact check (C).
-- D3 The QA side keeps four of the demo's limits and lifts the rest
--    (coordinator, 2026-11-12):
--    - no QoreID call (G6q): a QA account consumes no QoreID quota;
--    - no patient phone, so no SMS (G5q), a QA-only rule that a small
--      migration can lift later;
--    - no platform role (G3q), and the platform overview counts no QA row
--      (R8);
--    - email is limited to the owner's domain instead of the demo's three
--      exact mailboxes: a QA patient invites, adds as an emergency contact or
--      changes their email to an address @healthidentitydirectory.com only,
--      plus-addresses allowed (identity.sealed_qa_recipient), and a QA
--      outreach group invites such an address only; any other domain is
--      refused as the demo refuses a non-demo address.
--    Everything else a real tenant does, a QA login does: it is not
--    demo-restricted (0114's and 0115's demo-only refusals name demo
--    members only, so they never apply to QA).
-- D4 This file always installs the table, helpers and seal. It seeds the QA
--    tenant only on Amazon RDS (rds_superuser exists), as 0098 D3: CI,
--    acceptance, the staging upgrade rehearsal and throwaway clusters get
--    the seal only, and the suite sealed-qa-tenant calls the seed itself.
-- D5 Seven staff logins and two patient logins, all at the owner's mailboxes
--    with plus-addresses (Identity accepts them: class-validator isEmail, the
--    SQL and TypeScript address checks allow '+', and uniqueness is
--    lower(email), so each alias is its own login), seeded pending_reset,
--    without a password, the email verified. The owner sets each password
--    through the normal forgot-password flow. No password or password hash
--    is in this file.
-- D6 QA Patient One shares with the QA clinician at QA Hospital (a consent
--    grant and share row written as identity.write_patient_share writes them,
--    with the migration's own audit row, as 0098 D6). QA Patient Two has no
--    seeded share: the owner tests the real share flow with it.
-- D7 QA Health IDs have 8 characters and start ZQA (HID-ZQAAAAA2,
--    HID-ZQAAAAA3). Identity's generator issues 6 (and 16 before 2026-10-27),
--    so it can never issue one of them; it also never issues a 6-character
--    code starting ZQA (Identity, this change), so no real Health ID looks
--    like a QA one. The install refuses any Health ID that is taken.
-- D8 QA Outreach is an outreach group (0115), which must hold its
--    organiser's contact phone encrypted with Identity's key: the database
--    cannot write that truthfully. So the seed creates the organiser login
--    (a verified staff record, no membership) and the owner starts the group
--    with it through "Start an outreach group" (with the control
--    outreach_organiser_signup_enabled on), giving a name that starts with
--    "QA ". G8q seals the group as it is made: when the organiser is a QA
--    account the new group's organization and facility become QA members
--    before the organiser's membership is written; a QA organiser's group
--    name must start with "QA " (any case), and no QA account can join a
--    group that is not QA (G2q).
-- D9 Known limits, as in the demo: a QA facility admin cannot invite a new
--    login (the new account is real, and G2q refuses it at a QA facility),
--    and no new patient is created inside QA (facility registration needs a
--    QoreID NIN check, refused for QA, and app. sign-ups are platform-wide,
--    so they are real). The QA logins and patients are the seeded ones.
--
-- 0. Preconditions (catalog reads only; 55000 or 42501, nothing applied):
--    0001-0116 applied (0098's members table and seal, 0115's outreach
--    organisations); not applied yet; the nine bodies replaced in section 5
--    are byte for byte 0098's (md5 of pg_proc.prosrc); identity.patients has
--    six policies and patients_registration_read reads as 0098 wrote it; the
--    applier owns, or is a member of the owner of, each replaced function,
--    identity.patients and the ten tables that get a trigger. Each
--    replaced function's attributes but its body are recorded and compared
--    after the replacement (section 7).
-- 1. SHARE ROW EXCLUSIVE on the ten tables that get a trigger, up front,
--    NOWAIT every 10 ms for at most 5 seconds (else 55P03).
-- 2. identity.sealed_qa_members, as 0098's table: (member_kind, member_id,
--    recorded_at), primary key (kind, id), no foreign key, row-level
--    security enabled (not forced) with one owner policy, no grant, no
--    update, delete or TRUNCATE; and a member is never both demo and QA
--    (sealed_qa_members_not_demo, demo_members_never_qa).
-- 3. Helpers (search_path pg_catalog, pg_temp; revoked from PUBLIC):
--    identity.sealed_qa_ids(kind) and identity.sealed_qa_facility(id) (SQL,
--    SECURITY DEFINER; EXECUTE for hid_identity_runtime and
--    hid_schema_test_runtime, which identity.patients' policy calls them
--    as); identity.sealed_qa_patient(id) and identity.sealed_qa_account(id),
--    the owner's; identity.sealed_qa_recipient(address), immutable SQL:
--    true exactly for an address whose domain is healthidentitydirectory.com
--    (any case, outer blanks trimmed, plus-addresses allowed, no subdomain);
--    identity.sealed_qa_install(), the seed (section 10), the owner's.
-- 4. Nine triggers, each BEFORE, FOR EACH ROW, the function SECURITY
--    DEFINER and the owner's, beside 0098's:
--    G1q consent_grants_sealed_qa: the grant's facility (or its membership's)
--       and its patient both QA or neither; else 42501 SEALED_QA_BOUNDARY.
--    G2q staff_memberships_sealed_qa: the account and the facility both QA
--       or neither; else 42501 SEALED_QA_MEMBERSHIP_REFUSED.
--    G3q account_roles_sealed_qa: a QA account holds no platform role; else
--       42501 SEALED_QA_PLATFORM_ROLE_REFUSED.
--    G4q patient_share_invitations_sealed_qa: a QA patient invites an
--       address of the owner's domain only (22023
--       SHARE_INVITATION_EMAIL_INVALID); an invitation is accepted only on
--       the patient's side (42501 SEALED_QA_BOUNDARY).
--    G5q patient_contact_changes_sealed_qa: a QA patient never holds a phone
--       (22023 PATIENT_CONTACT_CHANGE_INVALID).
--    G6q qoreid_quota_counters_sealed_qa: a QA account consumes no QoreID
--       quota (42501 QOREID_QUOTA_PERMISSION_DENIED).
--    G7q patient_emergency_contacts_sealed_qa: for a QA patient, an SMS
--       contact, or an email contact whose HMAC the check (C) did not record
--       in this transaction in hid.sealed_qa_contact_hmac, is refused (42501
--       EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED); deactivation never is.
--       The same documented limit as 0098 G7: the database holds only the
--       HMAC, and any session can set the setting itself, so that the
--       destination is an address of the owner's domain rests on Identity
--       (EmergencyContactService.add computes the HMAC from the address it
--       checks).
--    G8q outreach_organisations_sealed_qa (insert): D8.
--    G9q outreach_invitations_sealed_qa (insert, or update of invitee_email):
--       a QA outreach group invites an address of the owner's domain only
--       (22023 OUTREACH_INVITATION_INVALID, which Identity answers 400), so no
--       QA invitation email reaches anyone outside it.
-- 5. Nine bodies replaced (CREATE OR REPLACE), each 0098's byte for byte plus
--    one QA clause beside its demo clause, always true for real and demo
--    rows: R1 identity.create_access_request, R2 identity.activate_break_glass
--    and R3 identity.access_patient_with_pin (the Health ID lookup also
--    requires the actor's facility and the patient both QA or neither;
--    across it, an unknown Health ID's answer), R4 ehr.send_order_route (a
--    receiving facility across it is ORDER_ROUTE_DESTINATION_INELIGIBLE), R5
--    identity.search_order_destinations and R6 identity.search_share_providers
--    (candidates on the same side only), R7 identity.start_my_email_change (a
--    QA patient changes to an address of the owner's domain only; else
--    'unavailable', nothing recorded or sent), R8
--    identity.admin_platform_overview (no QA row counted), and C
--    identity.sealed_demo_contact_allowed (a QA patient's contact is an email
--    to the owner's domain, its HMAC recorded for G7q; the demo branch is
--    unchanged).
-- 6. Grants, here and in runtime-grants.sql: EXECUTE on
--    identity.sealed_qa_ids and identity.sealed_qa_facility to
--    hid_identity_runtime and hid_schema_test_runtime; every other new
--    function the owner's alone; nothing on the table. Replaced functions
--    keep their ACLs.
-- 7. Post-checks: the table, its policy and ACL; each new function's owner,
--    SECURITY DEFINER, search_path, volatility and exact ACL; the readers of
--    identity.patients may run the two helpers its policy calls; the QA
--    triggers' definitions, enabled 'O'; the replaced functions keep every
--    attribute but the body.
-- 8. Comments.
-- 9. Section 0's temporary table dropped.
-- 10. The seed, on Amazon RDS only (D4): identity.sealed_qa_install(), which
--    refuses (55000, nothing written, the release stops) when a QA address
--    belongs to another account (not deleted) or staff record, is the first
--    administrator of an open organization application or the invitee of a
--    pending staff invitation (SEALED_QA_ADDRESS_TAKEN); when a fixed id is
--    held by a row that is not the QA tenant's (SEALED_QA_ID_TAKEN); when a
--    slug, facility code, Health ID or CAC is held by another row
--    (SEALED_QA_KEY_TAKEN); when a QA account has a membership outside QA, a
--    platform role or (a staff login) a patient record
--    (SEALED_QA_ACCOUNT_NOT_SEALED); or when the share would go to a
--    membership the patient could not choose (SEALED_QA_SHARE_INELIGIBLE).
--    Rows ON CONFLICT DO NOTHING, nothing existing updated; the share written
--    once (as 0098 D6); one audit row per share and one for the install,
--    counts only, no address or Health ID; a second call inserts nothing.
-- 11. Last, identity.patients' policy patients_registration_read: 0098's
--    expression and the same rule for QA, so a QA facility reads QA patients
--    only and nobody else reads a QA patient (a Health ID or name across the
--    boundary is not found).
--
-- The seeded tenant (source_system hid-sealed-qa on every row that has the
-- column, except the consent grant, which keeps the default hid as every
-- patient share does). Ids start c0a0.
--   Organizations and facilities, verified and active, Africa/Lagos: QA
--     Hospital (QA-HOSPITAL), QA Laboratory (QA-LABORATORY), QA Pharmacy
--     (QA-PHARMACY). QA Laboratory and QA Pharmacy have an approved
--     admin_review application and their product (an order's receiving
--     facility needs it). QA Outreach: D8.
--   Staff logins (each its own verified staff record):
--     operations+qa-clinician@healthidentitydirectory.com "QA Clinician":
--       doctor at QA Hospital (EHR, Migrate through doctor, shares, orders);
--     operations+qa-migrate@... "QA Migrate User": clinician at QA Hospital
--       (Migrate's document upload and imports);
--     operations+qa-lab1@... "QA Lab Scientist" and operations+qa-lab2@...
--       "QA Lab Checker": lab at QA Laboratory (a result's second check needs
--       a second person);
--     operations+qa-pharmacy@... "QA Pharmacist": pharmacist at QA Pharmacy;
--     operations+qa-admin@... "QA Facility Admin": org_admin at QA Hospital,
--       QA Laboratory and QA Pharmacy;
--     operations+qa-outreach@... "QA Outreach Organiser": no membership; it
--       starts the QA Outreach group (D8).
--   Patient logins: patient1+qa@healthidentitydirectory.com (HID-ZQAAAAA2, QA
--     Patient One) and patient2+qa@healthidentitydirectory.com (HID-ZQAAAAA3,
--     QA Patient Two).
--   Before testing, the owner sets each password with Forgot password; the
--     live recovery hold (24 hours before patient approvals, new shares, the
--     PIN, emergency contacts or invitations) applies as for any login.
--
-- Before signing, the owner may run this read-only query on production;
-- every count must be 0 and rds must be 1:
--   with addresses(email) as (values
--     ('operations+qa-clinician@healthidentitydirectory.com'), ('operations+qa-migrate@healthidentitydirectory.com'),
--     ('operations+qa-lab1@healthidentitydirectory.com'), ('operations+qa-lab2@healthidentitydirectory.com'),
--     ('operations+qa-pharmacy@healthidentitydirectory.com'), ('operations+qa-admin@healthidentitydirectory.com'),
--     ('operations+qa-outreach@healthidentitydirectory.com'), ('patient1+qa@healthidentitydirectory.com'),
--     ('patient2+qa@healthidentitydirectory.com'))
--   select (select count(*) from auth.accounts a join addresses x on lower(a.email) = x.email
--            where a.status <> 'deleted') as accounts,
--          (select count(*) from identity.staff s join addresses x on lower(s.email) = x.email) as staff,
--          (select count(*) from identity.patients p
--            where upper(p.hid_code) in ('HID-ZQAAAAA2', 'HID-ZQAAAAA3')) as health_ids,
--          (select count(*) from identity.facilities f
--            where upper(f.code) in ('QA-HOSPITAL', 'QA-LABORATORY', 'QA-PHARMACY')) as facility_codes,
--          (select count(*) from pg_roles where rolname = 'rds_superuser') as rds;

-- 0. Preconditions.
do $$
declare
  missing text;
  owner_problem text;
begin
  if to_regclass('identity.sealed_qa_members') is not null
     or to_regprocedure('identity.sealed_qa_install()') is not null then
    raise exception using errcode = '55000', message = '0123: already applied';
  end if;
  if to_regclass('identity.sealed_demo_members') is null
     or to_regprocedure('identity.sealed_demo_install()') is null
     or to_regprocedure('identity.sealed_demo_facility(uuid)') is null
     or to_regprocedure('identity.sealed_demo_patient(uuid)') is null
     or to_regprocedure('identity.sealed_demo_contact_allowed(text,uuid,text,text,character)') is null
     or to_regprocedure('identity.consent_grants_sealed_demo()') is null
     or to_regclass('identity.outreach_organisations') is null
     or to_regclass('identity.outreach_invitations') is null
     or to_regprocedure('identity.create_outreach_group(uuid,uuid,text,text,text,character,bytea,text,text,text,uuid,boolean)') is null
     or to_regprocedure('platform.reject_mutation()') is null
     or to_regprocedure('identity.patient_self_session(text,uuid)') is null
     or not exists (select 1 from auth.roles where code = 'outreach_organiser') then
    raise exception using errcode = '55000', message = '0123: 0001-0116 must be applied first';
  end if;
  -- The nine bodies section 5 replaces are 0098's, byte for byte.
  select string_agg(pin.signature, ', ' order by pin.signature) into missing
    from (values
      ('identity.create_access_request(text,text,text,integer)', 'f88923a49a180c2180fdedb29bf2eccf'),
      ('identity.activate_break_glass(text,text,integer)', '6b888391ef7f0e4f264918baf00a6fe7'),
      ('identity.access_patient_with_pin(text,text,integer)', '830c1baa4bca3df57cc02b7b002a8831'),
      ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', '4202ba3bbf02abd7db34606d42adca9c'),
      ('identity.search_order_destinations(text,text)', '7890a21333d012621a36302fd7ad24cc'),
      ('identity.search_share_providers(text,uuid,text)', '2cc1107289f6ff4d55266c6ee4842932'),
      ('identity.start_my_email_change(text,uuid,uuid,text,character,bytea,text,character,text,integer,integer,integer)',
       'b253ba70b4532a62b15eae6ae50465c1'),
      ('identity.admin_platform_overview()', '3b1b2ca005647190ea623c40afb4f96f'),
      ('identity.sealed_demo_contact_allowed(text,uuid,text,text,character)', '12f0000f8c5e77643304e84fd359ca58')
    ) pin(signature, digest)
   where to_regprocedure(pin.signature) is null
      or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(pin.signature)) <> pin.digest;
  if missing is not null then
    raise exception using errcode = '55000', message = '0123: these bodies are not 0098''s: ' || missing;
  end if;
  if (select count(*) from pg_policy policy_row where policy_row.polrelid = 'identity.patients'::regclass) <> 6
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'identity.patients'::regclass
                       and policy_row.polname = 'patients_registration_read'
                       and policy_row.polcmd = 'r' and policy_row.polpermissive
                       and policy_row.polroles = '{0}'::oid[] and policy_row.polwithcheck is null
                       and pg_get_expr(policy_row.polqual, policy_row.polrelid) = '((auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(), platform.current_facility_id(), ''identity.registration.write''::text) OR auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(), platform.current_facility_id(), ''identity.registration.approve''::text)) AND ((id = ANY (( SELECT identity.sealed_demo_ids(''patient''::text) AS sealed_demo_ids)::uuid[])) = ( SELECT identity.sealed_demo_facility(platform.current_facility_id()) AS sealed_demo_facility)))') then
    raise exception using errcode = '55000', message = '0123: identity.patients'' registration read is not 0098''s';
  end if;
  -- The applier may replace each body and alter each table (owner or a member of the owner).
  select string_agg(object_name, ', ' order by object_name) into owner_problem
    from (select proc.oid::regprocedure::text as object_name, proc.proowner as owner_oid
            from pg_proc proc
           where proc.oid in ('identity.create_access_request(text,text,text,integer)'::regprocedure,
                   'identity.activate_break_glass(text,text,integer)'::regprocedure,
                   'identity.access_patient_with_pin(text,text,integer)'::regprocedure,
                   'ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)'::regprocedure,
                   'identity.search_order_destinations(text,text)'::regprocedure,
                   'identity.search_share_providers(text,uuid,text)'::regprocedure,
                   'identity.start_my_email_change(text,uuid,uuid,text,character,bytea,text,character,text,integer,integer,integer)'::regprocedure,
                   'identity.admin_platform_overview()'::regprocedure,
                   'identity.sealed_demo_contact_allowed(text,uuid,text,text,character)'::regprocedure)
          union all
          select rel.oid::regclass::text, rel.relowner
            from pg_class rel
           where rel.oid in ('identity.patients'::regclass, 'identity.consent_grants'::regclass,
                   'identity.staff_facility_memberships'::regclass, 'auth.account_roles'::regclass,
                   'identity.patient_share_invitations'::regclass, 'identity.patient_contact_changes'::regclass,
                   'platform.qoreid_quota_counters'::regclass, 'identity.patient_emergency_contacts'::regclass,
                   'identity.outreach_organisations'::regclass, 'identity.outreach_invitations'::regclass,
                   'identity.sealed_demo_members'::regclass)) owned
   where not pg_has_role(current_user, owned.owner_oid, 'USAGE');
  if owner_problem is not null then
    raise exception using errcode = '42501', message = '0123: the applier does not own ' || owner_problem;
  end if;
end
$$;

-- Each replaced function's attributes but its body, compared in section 7.
create temporary table sealed_qa_0123_replaced as
select proc.oid as function_oid, proc.proowner, proc.prosecdef, proc.provolatile, proc.proconfig, proc.proacl,
       proc.prorettype, proc.proretset, proc.proargtypes, proc.proargnames, proc.prolang
  from pg_proc proc
 where proc.oid in ('identity.create_access_request(text,text,text,integer)'::regprocedure,
         'identity.activate_break_glass(text,text,integer)'::regprocedure,
         'identity.access_patient_with_pin(text,text,integer)'::regprocedure,
         'ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)'::regprocedure,
         'identity.search_order_destinations(text,text)'::regprocedure,
         'identity.search_share_providers(text,uuid,text)'::regprocedure,
         'identity.start_my_email_change(text,uuid,uuid,text,character,bytea,text,character,text,integer,integer,integer)'::regprocedure,
         'identity.admin_platform_overview()'::regprocedure,
         'identity.sealed_demo_contact_allowed(text,uuid,text,text,character)'::regprocedure);

-- 1. The locks the QA triggers take, up front and bounded.
do $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table identity.consent_grants, identity.staff_facility_memberships, auth.account_roles,
        identity.patient_share_invitations, identity.patient_contact_changes, platform.qoreid_quota_counters,
        identity.patient_emergency_contacts, identity.outreach_organisations, identity.outreach_invitations,
        identity.sealed_demo_members
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0123: a table that gets a sealed QA trigger stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 2. The QA tenant's members, as 0098's table.
create table identity.sealed_qa_members (
  member_kind text not null check (member_kind in ('organization', 'facility', 'account', 'patient')),
  member_id uuid not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (member_kind, member_id)
);
create trigger sealed_qa_members_immutable
  before update or delete on identity.sealed_qa_members
  for each row execute function platform.reject_mutation();
create trigger sealed_qa_members_no_truncate
  before truncate on identity.sealed_qa_members
  for each statement execute function platform.reject_mutation();
alter table identity.sealed_qa_members enable row level security;
do $$
begin
  execute format('create policy sealed_qa_members_owner on identity.sealed_qa_members '
    || 'for all using (current_user = %L) with check (current_user = %L)', current_user, current_user);
end
$$;
revoke all on identity.sealed_qa_members from public;

-- A member is never both demo and QA, whichever table it reaches first.
create function identity.sealed_qa_members_not_demo()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if exists (select 1 from identity.sealed_demo_members member
              where member.member_kind = new.member_kind and member.member_id = new.member_id) then
    raise exception using errcode = '42501', message = 'SEALED_QA_DEMO_OVERLAP';
  end if;
  return new;
end
$$;
create trigger sealed_qa_members_not_demo
  before insert on identity.sealed_qa_members
  for each row execute function identity.sealed_qa_members_not_demo();

create function identity.demo_members_never_qa()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if exists (select 1 from identity.sealed_qa_members member
              where member.member_kind = new.member_kind and member.member_id = new.member_id) then
    raise exception using errcode = '42501', message = 'SEALED_QA_DEMO_OVERLAP';
  end if;
  return new;
end
$$;
create trigger demo_members_never_qa
  before insert on identity.sealed_demo_members
  for each row execute function identity.demo_members_never_qa();

-- 3. Helpers.
create function identity.sealed_qa_ids(requested_kind text)
returns uuid[]
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(array_agg(member.member_id order by member.member_id), '{}'::uuid[])
    from identity.sealed_qa_members member
   where member.member_kind = requested_kind
$$;

create function identity.sealed_qa_facility(requested_facility_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from identity.sealed_qa_members member
                  where member.member_kind = 'facility' and member.member_id = requested_facility_id)
$$;

create function identity.sealed_qa_patient(requested_patient_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from identity.sealed_qa_members member
                  where member.member_kind = 'patient' and member.member_id = requested_patient_id)
$$;

create function identity.sealed_qa_account(requested_account_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from identity.sealed_qa_members member
                  where member.member_kind = 'account' and member.member_id = requested_account_id)
$$;

-- The owner's domain: an address @healthidentitydirectory.com, plus-addresses
-- allowed, no subdomain, any case, outer blanks trimmed. The local part is
-- the characters Identity's address checks accept that a mailbox name uses.
create function identity.sealed_qa_recipient(requested_address text)
returns boolean
language sql immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(lower(btrim(requested_address)) ~ '^[a-z0-9][a-z0-9._%+-]{0,63}@healthidentitydirectory\.com$', false)
$$;

-- 4. The QA seal's triggers, beside 0098's.
-- G1q: a grant links a facility and a patient both QA or neither.
create function identity.consent_grants_sealed_qa()
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
  if identity.sealed_qa_facility(grant_facility) <> identity.sealed_qa_patient(new.patient_id) then
    raise exception using errcode = '42501', message = 'SEALED_QA_BOUNDARY';
  end if;
  return new;
end
$$;
create trigger consent_grants_sealed_qa
  before insert or update of patient_id, membership_id, facility_id on identity.consent_grants
  for each row execute function identity.consent_grants_sealed_qa();

-- G2q: a membership links an account and a facility both QA or neither.
create function identity.staff_memberships_sealed_qa()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if identity.sealed_qa_account(new.account_id) <> identity.sealed_qa_facility(new.facility_id) then
    raise exception using errcode = '42501', message = 'SEALED_QA_MEMBERSHIP_REFUSED';
  end if;
  return new;
end
$$;
create trigger staff_memberships_sealed_qa
  before insert or update of account_id, facility_id on identity.staff_facility_memberships
  for each row execute function identity.staff_memberships_sealed_qa();

-- G3q: a QA account holds no platform role.
create function identity.account_roles_sealed_qa()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if identity.sealed_qa_account(new.account_id) then
    raise exception using errcode = '42501', message = 'SEALED_QA_PLATFORM_ROLE_REFUSED';
  end if;
  return new;
end
$$;
create trigger account_roles_sealed_qa
  before insert or update of account_id, scope_type, revoked_at on auth.account_roles
  for each row when (new.scope_type = 'platform' and new.revoked_at is null)
  execute function identity.account_roles_sealed_qa();

-- G4q: a QA patient invites an address of the owner's domain only; an
-- invitation is accepted on the patient's side only.
create function identity.patient_share_invitations_sealed_qa()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  qa_patient boolean := identity.sealed_qa_patient(new.patient_id);
  accepting_facility uuid;
begin
  if qa_patient and not identity.sealed_qa_recipient(new.invitee_email) then
    raise exception using errcode = '22023', message = 'SHARE_INVITATION_EMAIL_INVALID';
  end if;
  if new.accepted_membership_id is not null then
    select membership.facility_id into accepting_facility
      from identity.staff_facility_memberships membership where membership.id = new.accepted_membership_id;
    if identity.sealed_qa_facility(accepting_facility) <> qa_patient then
      raise exception using errcode = '42501', message = 'SEALED_QA_BOUNDARY';
    end if;
  end if;
  return new;
end
$$;
create trigger patient_share_invitations_sealed_qa
  before insert or update of invitee_email, accepted_membership_id on identity.patient_share_invitations
  for each row execute function identity.patient_share_invitations_sealed_qa();

-- G5q: a QA patient never holds a phone (no SMS); a later migration may lift it.
create function identity.patient_contact_changes_sealed_qa()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if identity.sealed_qa_patient(new.patient_id) then
    raise exception using errcode = '22023', message = 'PATIENT_CONTACT_CHANGE_INVALID';
  end if;
  return new;
end
$$;
create trigger patient_contact_changes_sealed_qa
  before insert on identity.patient_contact_changes
  for each row when (new.channel = 'phone')
  execute function identity.patient_contact_changes_sealed_qa();

-- G6q: a QA account consumes no QoreID quota, so it causes no QoreID call.
create function identity.qoreid_quota_counters_sealed_qa()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if identity.sealed_qa_account(new.scope_id) then
    raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
  end if;
  return new;
end
$$;
create trigger qoreid_quota_counters_sealed_qa
  before insert on platform.qoreid_quota_counters
  for each row when (new.scope_type = 'account')
  execute function identity.qoreid_quota_counters_sealed_qa();

-- G7q: for a QA patient, an SMS contact, or an email contact whose HMAC the
-- check did not record in this transaction, is refused. Deactivation never is.
create function identity.patient_emergency_contacts_sealed_qa()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.status <> 'deactivated'
     and (tg_op = 'INSERT' or new.channel is distinct from old.channel
          or new.destination_hmac is distinct from old.destination_hmac)
     and identity.sealed_qa_patient(new.patient_id)
     and (new.channel is distinct from 'email'
          or current_setting('hid.sealed_qa_contact_hmac', true) is distinct from new.destination_hmac::text) then
    raise exception using errcode = '42501', message = 'EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED';
  end if;
  return new;
end
$$;
create trigger patient_emergency_contacts_sealed_qa
  before insert or update of channel, destination_hmac on identity.patient_emergency_contacts
  for each row execute function identity.patient_emergency_contacts_sealed_qa();

-- G8q: an outreach group whose organiser is a QA account is a QA group, its
-- name starting "QA " (D8). Its organization and facility become QA members
-- before 0115's create_outreach_group writes the organiser's membership (G2q).
create function identity.outreach_organisations_sealed_qa()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if identity.sealed_qa_account(new.organiser_account_id) then
    if new.display_name !~* '^QA ' then
      raise exception using errcode = '22023', message = 'OUTREACH_ORGANISER_SIGNUP_INVALID';
    end if;
    insert into identity.sealed_qa_members (member_kind, member_id)
    values ('organization', new.organization_id), ('facility', new.facility_id)
    on conflict (member_kind, member_id) do nothing;
  end if;
  return new;
end
$$;
create trigger outreach_organisations_sealed_qa
  before insert on identity.outreach_organisations
  for each row execute function identity.outreach_organisations_sealed_qa();

-- G9q: a QA outreach group invites an address of the owner's domain only.
create function identity.outreach_invitations_sealed_qa()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if identity.sealed_qa_facility(new.facility_id) and not identity.sealed_qa_recipient(new.invitee_email) then
    raise exception using errcode = '22023', message = 'OUTREACH_INVITATION_INVALID';
  end if;
  return new;
end
$$;
create trigger outreach_invitations_sealed_qa
  before insert or update of invitee_email on identity.outreach_invitations
  for each row execute function identity.outreach_invitations_sealed_qa();

-- 5. Nine bodies replaced: each 0098's byte for byte plus one QA clause beside
-- its demo clause.
-- R1
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
    and identity.sealed_qa_facility(actor_facility_id) = identity.sealed_qa_patient(patient_row.id)
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

-- R2
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
    and identity.sealed_qa_facility(actor_facility_id) = identity.sealed_qa_patient(patient_row.id)
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

-- R3
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
     and identity.sealed_qa_facility(actor_facility_id) = identity.sealed_qa_patient(patient_row.id)
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

-- R4
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
     or identity.sealed_demo_facility(receiving_facility.id) <> identity.sealed_demo_facility(actor.actor_facility_id)
     or identity.sealed_qa_facility(receiving_facility.id) <> identity.sealed_qa_facility(actor.actor_facility_id) then
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

-- R5
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
       and identity.sealed_qa_facility(facility.id) = identity.sealed_qa_facility(actor.actor_facility_id)
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

-- R6
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
       and identity.sealed_qa_facility(facility.id) = identity.sealed_qa_patient(patient_id_value)
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

-- R7
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
  if identity.sealed_qa_patient(patient_id_value) and not identity.sealed_qa_recipient(normalized_email) then
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

-- R8
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
      and (patient.id = any ((select identity.sealed_demo_ids('patient'))::uuid[])) is not true
        and (patient.id = any ((select identity.sealed_qa_ids('patient'))::uuid[])) is not true),
    (select count(*) from identity.facilities facility
      where (facility.id = any ((select identity.sealed_demo_ids('facility'))::uuid[])) is not true
        and (facility.id = any ((select identity.sealed_qa_ids('facility'))::uuid[])) is not true),
    (select count(*) from identity.facilities facility where facility.lifecycle_status = 'verified'
      and (facility.id = any ((select identity.sealed_demo_ids('facility'))::uuid[])) is not true
        and (facility.id = any ((select identity.sealed_qa_ids('facility'))::uuid[])) is not true),
    (select count(*) from identity.facilities facility where facility.lifecycle_status = 'suspended'
      and (facility.id = any ((select identity.sealed_demo_ids('facility'))::uuid[])) is not true
        and (facility.id = any ((select identity.sealed_qa_ids('facility'))::uuid[])) is not true),
    (select count(*) from identity.staff_facility_memberships membership
      where membership.active and membership.migration_hold_reason is null
        and (membership.facility_id = any ((select identity.sealed_demo_ids('facility'))::uuid[])) is not true
        and (membership.facility_id = any ((select identity.sealed_qa_ids('facility'))::uuid[])) is not true),
    (select count(*) from identity.registration_cases registration
      where registration.status in ('pending_new_identity_approval', 'review_required')
        and (registration.facility_id = any ((select identity.sealed_demo_ids('facility'))::uuid[])) is not true
        and (registration.facility_id = any ((select identity.sealed_qa_ids('facility'))::uuid[])) is not true);
end
$$;

-- C
create or replace function identity.sealed_demo_contact_allowed(requested_subject text, requested_session uuid,
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
  if identity.sealed_qa_patient(patient_id_value) then
    if coalesce(requested_channel = 'email', false) and identity.sealed_qa_recipient(requested_destination)
       and coalesce(requested_destination_hmac::text ~ '^[0-9a-f]{64}$', false) then
      perform set_config('hid.sealed_qa_contact_hmac', requested_destination_hmac::text, true);
      return true;
    end if;
    return false;
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

-- 10's seed function (installed always, called on Amazon RDS only). Every read
-- before any write; refusals raise 55000 with a message that names no address,
-- Health ID or person.
create function identity.sealed_qa_install()
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  install_reason constant text := 'Sealed QA tenant installed by migration 0123';
  role_reason constant text := 'Sealed QA tenant (0123, owner decision Q60)';
  share_correlation constant text := '0123-sealed-qa-install';
  qa_organizations constant jsonb := '[
    {"id": "c0a00001-0000-4000-8000-000000000001", "name": "QA Hospital", "slug": "sealed-qa-hospital"},
    {"id": "c0a00001-0000-4000-8000-000000000002", "name": "QA Laboratory", "slug": "sealed-qa-laboratory"},
    {"id": "c0a00001-0000-4000-8000-000000000003", "name": "QA Pharmacy", "slug": "sealed-qa-pharmacy"}]';
  qa_facilities constant jsonb := '[
    {"id": "c0a00002-0000-4000-8000-000000000001", "organization_id": "c0a00001-0000-4000-8000-000000000001",
     "name": "QA Hospital", "code": "QA-HOSPITAL"},
    {"id": "c0a00002-0000-4000-8000-000000000002", "organization_id": "c0a00001-0000-4000-8000-000000000002",
     "name": "QA Laboratory", "code": "QA-LABORATORY"},
    {"id": "c0a00002-0000-4000-8000-000000000003", "organization_id": "c0a00001-0000-4000-8000-000000000003",
     "name": "QA Pharmacy", "code": "QA-PHARMACY"}]';
  -- Staff logins (each with its own staff record, staff_id) and patient logins (no staff_id).
  qa_accounts constant jsonb := '[
    {"id": "c0a00003-0000-4000-8000-000000000001", "staff_id": "c0a00004-0000-4000-8000-000000000001",
     "subject": "sealed-qa:c0a00003-0000-4000-8000-000000000001",
     "email": "operations+qa-clinician@healthidentitydirectory.com", "display_name": "QA Clinician",
     "default_role": "doctor"},
    {"id": "c0a00003-0000-4000-8000-000000000002", "staff_id": "c0a00004-0000-4000-8000-000000000002",
     "subject": "sealed-qa:c0a00003-0000-4000-8000-000000000002",
     "email": "operations+qa-migrate@healthidentitydirectory.com", "display_name": "QA Migrate User",
     "default_role": "clinician"},
    {"id": "c0a00003-0000-4000-8000-000000000003", "staff_id": "c0a00004-0000-4000-8000-000000000003",
     "subject": "sealed-qa:c0a00003-0000-4000-8000-000000000003",
     "email": "operations+qa-lab1@healthidentitydirectory.com", "display_name": "QA Lab Scientist",
     "default_role": "lab"},
    {"id": "c0a00003-0000-4000-8000-000000000004", "staff_id": "c0a00004-0000-4000-8000-000000000004",
     "subject": "sealed-qa:c0a00003-0000-4000-8000-000000000004",
     "email": "operations+qa-lab2@healthidentitydirectory.com", "display_name": "QA Lab Checker",
     "default_role": "lab"},
    {"id": "c0a00003-0000-4000-8000-000000000005", "staff_id": "c0a00004-0000-4000-8000-000000000005",
     "subject": "sealed-qa:c0a00003-0000-4000-8000-000000000005",
     "email": "operations+qa-pharmacy@healthidentitydirectory.com", "display_name": "QA Pharmacist",
     "default_role": "pharmacist"},
    {"id": "c0a00003-0000-4000-8000-000000000006", "staff_id": "c0a00004-0000-4000-8000-000000000006",
     "subject": "sealed-qa:c0a00003-0000-4000-8000-000000000006",
     "email": "operations+qa-admin@healthidentitydirectory.com", "display_name": "QA Facility Admin",
     "default_role": "org_admin"},
    {"id": "c0a00003-0000-4000-8000-000000000007", "staff_id": "c0a00004-0000-4000-8000-000000000007",
     "subject": "sealed-qa:c0a00003-0000-4000-8000-000000000007",
     "email": "operations+qa-outreach@healthidentitydirectory.com", "display_name": "QA Outreach Organiser",
     "default_role": "outreach_organiser"},
    {"id": "c0a00008-0000-4000-8000-000000000001", "staff_id": null,
     "subject": "patient:c0a00008-0000-4000-8000-000000000001",
     "email": "patient1+qa@healthidentitydirectory.com", "display_name": "QA Patient One", "default_role": null},
    {"id": "c0a00008-0000-4000-8000-000000000002", "staff_id": null,
     "subject": "patient:c0a00008-0000-4000-8000-000000000002",
     "email": "patient2+qa@healthidentitydirectory.com", "display_name": "QA Patient Two", "default_role": null}]';
  qa_memberships constant jsonb := '[
    {"id": "c0a00005-0000-4000-8000-000000000011", "account_id": "c0a00003-0000-4000-8000-000000000001",
     "staff_id": "c0a00004-0000-4000-8000-000000000001", "organization_id": "c0a00001-0000-4000-8000-000000000001",
     "facility_id": "c0a00002-0000-4000-8000-000000000001", "role": "doctor", "is_primary": true},
    {"id": "c0a00005-0000-4000-8000-000000000021", "account_id": "c0a00003-0000-4000-8000-000000000002",
     "staff_id": "c0a00004-0000-4000-8000-000000000002", "organization_id": "c0a00001-0000-4000-8000-000000000001",
     "facility_id": "c0a00002-0000-4000-8000-000000000001", "role": "clinician", "is_primary": true},
    {"id": "c0a00005-0000-4000-8000-000000000031", "account_id": "c0a00003-0000-4000-8000-000000000003",
     "staff_id": "c0a00004-0000-4000-8000-000000000003", "organization_id": "c0a00001-0000-4000-8000-000000000002",
     "facility_id": "c0a00002-0000-4000-8000-000000000002", "role": "lab", "is_primary": true},
    {"id": "c0a00005-0000-4000-8000-000000000041", "account_id": "c0a00003-0000-4000-8000-000000000004",
     "staff_id": "c0a00004-0000-4000-8000-000000000004", "organization_id": "c0a00001-0000-4000-8000-000000000002",
     "facility_id": "c0a00002-0000-4000-8000-000000000002", "role": "lab", "is_primary": true},
    {"id": "c0a00005-0000-4000-8000-000000000051", "account_id": "c0a00003-0000-4000-8000-000000000005",
     "staff_id": "c0a00004-0000-4000-8000-000000000005", "organization_id": "c0a00001-0000-4000-8000-000000000003",
     "facility_id": "c0a00002-0000-4000-8000-000000000003", "role": "pharmacist", "is_primary": true},
    {"id": "c0a00005-0000-4000-8000-000000000061", "account_id": "c0a00003-0000-4000-8000-000000000006",
     "staff_id": "c0a00004-0000-4000-8000-000000000006", "organization_id": "c0a00001-0000-4000-8000-000000000001",
     "facility_id": "c0a00002-0000-4000-8000-000000000001", "role": "org_admin", "is_primary": true},
    {"id": "c0a00005-0000-4000-8000-000000000062", "account_id": "c0a00003-0000-4000-8000-000000000006",
     "staff_id": "c0a00004-0000-4000-8000-000000000006", "organization_id": "c0a00001-0000-4000-8000-000000000002",
     "facility_id": "c0a00002-0000-4000-8000-000000000002", "role": "org_admin", "is_primary": false},
    {"id": "c0a00005-0000-4000-8000-000000000063", "account_id": "c0a00003-0000-4000-8000-000000000006",
     "staff_id": "c0a00004-0000-4000-8000-000000000006", "organization_id": "c0a00001-0000-4000-8000-000000000003",
     "facility_id": "c0a00002-0000-4000-8000-000000000003", "role": "org_admin", "is_primary": false}]';
  qa_applications constant jsonb := '[
    {"id": "c0a00007-0000-4000-8000-000000000002", "organization_id": "c0a00001-0000-4000-8000-000000000002",
     "facility_id": "c0a00002-0000-4000-8000-000000000002", "product": "laboratory", "kind": "laboratory",
     "cac": "RC00000000000000123002", "name": "QA Laboratory"},
    {"id": "c0a00007-0000-4000-8000-000000000003", "organization_id": "c0a00001-0000-4000-8000-000000000003",
     "facility_id": "c0a00002-0000-4000-8000-000000000003", "product": "pharmacy", "kind": "pharmacy",
     "cac": "RC00000000000000123003", "name": "QA Pharmacy"}]';
  qa_patients constant jsonb := '[
    {"id": "c0a00009-0000-4000-8000-000000000001", "identifier_id": "c0a0000a-0000-4000-8000-000000000001",
     "account_id": "c0a00008-0000-4000-8000-000000000001", "hid": "HID-ZQAAAAA2", "last": "Patient One",
     "gender": "female", "dob": "1988-04-12"},
    {"id": "c0a00009-0000-4000-8000-000000000002", "identifier_id": "c0a0000a-0000-4000-8000-000000000002",
     "account_id": "c0a00008-0000-4000-8000-000000000002", "hid": "HID-ZQAAAAA3", "last": "Patient Two",
     "gender": "male", "dob": "1993-09-27"}]';
  -- D6: QA Patient One shares with the QA clinician (doctor) at QA Hospital.
  qa_shares constant jsonb := '[
    {"patient_id": "c0a00009-0000-4000-8000-000000000001", "membership_id": "c0a00005-0000-4000-8000-000000000011"}]';
  admin_account constant uuid := 'c0a00003-0000-4000-8000-000000000006';
  qa_share record;
  share_membership record;
  share_grant uuid;
  share_start timestamptz;
  step bigint;
  inserted bigint := 0;
begin
  -- One install at a time.
  perform pg_advisory_xact_lock(hashtextextended('hid-sealed-qa-install', 0));

  -- 1. An address of the QA tenant belongs to another account (not deleted) or
  -- staff record, or is named by an open organization application or a pending
  -- staff invitation.
  if exists (select 1 from auth.accounts account
               join jsonb_to_recordset(qa_accounts) qa(id uuid, email text) on lower(account.email) = qa.email
              where account.status <> 'deleted' and account.id <> qa.id)
     or exists (select 1 from identity.staff staff_row
                  join jsonb_to_recordset(qa_accounts) qa(staff_id uuid, email text) on lower(staff_row.email) = qa.email
                 where staff_row.id is distinct from qa.staff_id)
     or exists (select 1 from identity.organization_applications application
                  join jsonb_to_recordset(qa_accounts) qa(email text) on lower(application.administrator_email) = qa.email
                 where application.status in ('pending_verification', 'ready_for_review'))
     or exists (select 1 from identity.staff_invitations invitation
                  join jsonb_to_recordset(qa_accounts) qa(email text) on lower(invitation.invitee_email) = qa.email
                 where invitation.status = 'pending' and invitation.expires_at > clock_timestamp()) then
    raise exception using errcode = '55000', message = '0123: SEALED_QA_ADDRESS_TAKEN';
  end if;

  -- 2. A fixed id is held by a row that is not the QA tenant's.
  if exists (select 1 from identity.organizations organization
               join jsonb_to_recordset(qa_organizations) qa(id uuid, slug text) on qa.id = organization.id
              where lower(organization.slug) <> qa.slug
                 or not exists (select 1 from identity.sealed_qa_members member
                                 where member.member_kind = 'organization' and member.member_id = organization.id))
     or exists (select 1 from identity.facilities facility
                  join jsonb_to_recordset(qa_facilities) qa(id uuid, organization_id uuid, code text) on qa.id = facility.id
                 where facility.organization_id <> qa.organization_id or upper(facility.code) <> qa.code
                    or not identity.sealed_qa_facility(facility.id))
     or exists (select 1 from auth.accounts account
                  join jsonb_to_recordset(qa_accounts) qa(id uuid, subject text, email text) on qa.id = account.id
                 where account.subject <> qa.subject or account.status = 'deleted'
                    or not identity.sealed_qa_account(account.id))
     or exists (select 1 from identity.staff staff_row
                  join jsonb_to_recordset(qa_accounts) qa(id uuid, staff_id uuid, email text)
                    on qa.staff_id = staff_row.id or (qa.staff_id is not null and staff_row.account_id = qa.id)
                 where staff_row.id is distinct from qa.staff_id or staff_row.account_id <> qa.id
                    or not identity.sealed_qa_account(staff_row.account_id))
     or exists (select 1 from identity.staff_facility_memberships membership
                  join jsonb_to_recordset(qa_memberships) qa(id uuid, account_id uuid, staff_id uuid,
                    organization_id uuid, facility_id uuid) on qa.id = membership.id
                 where membership.account_id <> qa.account_id or membership.staff_id <> qa.staff_id
                    or membership.organization_id <> qa.organization_id
                    or membership.facility_id is distinct from qa.facility_id)
     or exists (select 1 from auth.account_roles assignment
                  join jsonb_to_recordset(qa_memberships) qa(id uuid, account_id uuid, role text)
                    on assignment.id = qa.id
                 where assignment.account_id <> qa.account_id or assignment.scope_type <> 'facility'
                    or assignment.membership_id is distinct from qa.id or assignment.role_code <> qa.role)
     or exists (select 1 from identity.organization_applications application
                  join jsonb_to_recordset(qa_applications) qa(id uuid, organization_id uuid, facility_id uuid,
                    product text, cac text) on qa.id = application.id
                 where application.organization_id is distinct from qa.organization_id
                    or application.facility_id is distinct from qa.facility_id
                    or application.product_code <> qa.product or application.cac_registration_number <> qa.cac
                    or application.approval_mode <> 'admin_review')
     or exists (select 1 from identity.organization_products product
                  join jsonb_to_recordset(qa_applications) qa(id uuid, organization_id uuid, facility_id uuid,
                    product text) on qa.organization_id = product.organization_id and qa.product = product.product_code
                 where product.facility_id <> qa.facility_id or product.source_application_id <> qa.id)
     or exists (select 1 from identity.patients patient
                  join jsonb_to_recordset(qa_patients) qa(id uuid, account_id uuid, hid text) on qa.id = patient.id
                 where upper(patient.hid_code) <> qa.hid or patient.account_id is distinct from qa.account_id
                    or not identity.sealed_qa_patient(patient.id))
     or exists (select 1 from identity.patient_identifiers identifier
                  join jsonb_to_recordset(qa_patients) qa(id uuid, identifier_id uuid, hid text)
                    on qa.identifier_id = identifier.id
                 where identifier.patient_id <> qa.id or identifier.identifier_type <> 'hid_code'
                    or upper(identifier.public_value) is distinct from qa.hid)
     or exists (select 1 from identity.patient_assurance_states assurance
                  join jsonb_to_recordset(qa_patients) qa(id uuid, account_id uuid) on qa.id = assurance.patient_id
                 where assurance.account_id is distinct from qa.account_id) then
    raise exception using errcode = '55000', message = '0123: SEALED_QA_ID_TAKEN';
  end if;

  -- 3. A slug, facility code, Health ID or CAC of the QA tenant is held by another row.
  if exists (select 1 from identity.organizations organization
               join jsonb_to_recordset(qa_organizations) qa(id uuid, slug text)
                 on lower(organization.slug) = qa.slug and organization.id <> qa.id)
     or exists (select 1 from identity.facilities facility
                  join jsonb_to_recordset(qa_facilities) qa(id uuid, code text)
                    on upper(facility.code) = qa.code and facility.id <> qa.id)
     or exists (select 1 from identity.patients patient
                  join jsonb_to_recordset(qa_patients) qa(id uuid, hid text)
                    on upper(patient.hid_code) = qa.hid and patient.id <> qa.id)
     or exists (select 1 from identity.patient_identifiers identifier
                  join jsonb_to_recordset(qa_patients) qa(identifier_id uuid, hid text)
                    on identifier.identifier_type = 'hid_code' and upper(identifier.public_value) = qa.hid
                   and identifier.id <> qa.identifier_id)
     or exists (select 1 from identity.organization_applications application
                  join jsonb_to_recordset(qa_applications) qa(id uuid, product text, cac text)
                    on application.cac_registration_number = qa.cac and application.product_code = qa.product
                   and application.status <> 'rejected' and application.id <> qa.id) then
    raise exception using errcode = '55000', message = '0123: SEALED_QA_KEY_TAKEN';
  end if;

  -- 4. A QA account holds a membership outside QA, a platform role, or (a staff
  -- login) a patient record, or a patient login another patient record.
  if exists (select 1 from identity.staff_facility_memberships membership
               join jsonb_to_recordset(qa_accounts) qa(id uuid) on qa.id = membership.account_id
              where not identity.sealed_qa_facility(membership.facility_id))
     or exists (select 1 from auth.account_roles assignment
                  join jsonb_to_recordset(qa_accounts) qa(id uuid) on qa.id = assignment.account_id
                 where assignment.scope_type = 'platform' and assignment.revoked_at is null)
     or exists (select 1 from identity.patients patient
                  join jsonb_to_recordset(qa_accounts) qa(id uuid, staff_id uuid) on qa.id = patient.account_id
                 where qa.staff_id is not null)
     or exists (select 1 from identity.patients patient
                  join jsonb_to_recordset(qa_patients) qa(id uuid, account_id uuid)
                    on qa.account_id = patient.account_id and patient.id <> qa.id) then
    raise exception using errcode = '55000', message = '0123: SEALED_QA_ACCOUNT_NOT_SEALED';
  end if;

  -- Members first, so that the triggers see them; then the rows. Nothing
  -- existing is updated.
  insert into identity.sealed_qa_members (member_kind, member_id)
  select 'organization', qa.id from jsonb_to_recordset(qa_organizations) qa(id uuid)
  union all select 'facility', qa.id from jsonb_to_recordset(qa_facilities) qa(id uuid)
  union all select 'account', qa.id from jsonb_to_recordset(qa_accounts) qa(id uuid)
  union all select 'patient', qa.id from jsonb_to_recordset(qa_patients) qa(id uuid)
  on conflict (member_kind, member_id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.organizations (id, name, slug, active, source_system)
  select qa.id, qa.name, qa.slug, true, 'hid-sealed-qa'
    from jsonb_to_recordset(qa_organizations) qa(id uuid, name text, slug text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.facilities (id, organization_id, name, code, active, timezone, lifecycle_status,
    status_reason, source_system)
  select qa.id, qa.organization_id, qa.name, qa.code, true, 'Africa/Lagos', 'verified', install_reason, 'hid-sealed-qa'
    from jsonb_to_recordset(qa_facilities) qa(id uuid, organization_id uuid, name text, code text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system)
  select qa.id, qa.subject, qa.email, qa.display_name, 'pending_reset', clock_timestamp(), 'hid-sealed-qa'
    from jsonb_to_recordset(qa_accounts) qa(id uuid, subject text, email text, display_name text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active,
    source_system)
  select qa.staff_id, qa.id, qa.display_name, qa.email, 'verified', qa.default_role, true, 'hid-sealed-qa'
    from jsonb_to_recordset(qa_accounts) qa(id uuid, staff_id uuid, email text, display_name text, default_role text)
   where qa.staff_id is not null
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, source_system)
  select qa.id, qa.staff_id, qa.account_id, qa.organization_id, qa.facility_id, qa.role, qa.role, qa.is_primary, true,
         'hid-sealed-qa'
    from jsonb_to_recordset(qa_memberships) qa(id uuid, staff_id uuid, account_id uuid, organization_id uuid,
      facility_id uuid, role text, is_primary boolean)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  -- One facility role per membership, with the membership's id.
  insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
  select qa.id, qa.account_id, qa.role, 'facility', qa.id, qa.facility_id, role_reason
    from jsonb_to_recordset(qa_memberships) qa(id uuid, account_id uuid, facility_id uuid, role text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  -- QA Laboratory and QA Pharmacy: an approved governed application and their
  -- product, which an order's receiving facility needs (as 0098 D4).
  insert into identity.organization_applications (id, product_code, organization_name, organization_type,
    cac_registration_number, administrator_name, administrator_email, status, verification_result, verified_at,
    organization_id, facility_id, first_admin_account_id, reviewed_by_account_id, review_reason, reviewed_at,
    verified_organization_name, approval_mode)
  select qa.id, qa.product, qa.name, qa.kind, qa.cac, 'QA Facility Admin',
         'operations+qa-admin@healthidentitydirectory.com', 'approved', 'verified', clock_timestamp(),
         qa.organization_id, qa.facility_id, admin_account, admin_account, install_reason, clock_timestamp(), qa.name,
         'admin_review'
    from jsonb_to_recordset(qa_applications) qa(id uuid, organization_id uuid, facility_id uuid, product text,
      kind text, cac text, name text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.organization_products (organization_id, product_code, facility_id, status,
    source_application_id)
  select qa.organization_id, qa.product, qa.facility_id, 'active', qa.id
    from jsonb_to_recordset(qa_applications) qa(id uuid, organization_id uuid, facility_id uuid, product text)
  on conflict (organization_id, product_code) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status,
    source_system)
  select qa.id, qa.account_id, qa.hid, 'QA', qa.last, 'QA ' || qa.last, qa.gender, qa.dob, 'active', 'hid-sealed-qa'
    from jsonb_to_recordset(qa_patients) qa(id uuid, account_id uuid, hid text, last text, gender text, dob date)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.patient_identifiers (id, patient_id, identifier_type, public_value, verified, source_system)
  select qa.identifier_id, qa.id, 'hid_code', qa.hid, true, 'hid-sealed-qa'
    from jsonb_to_recordset(qa_patients) qa(id uuid, identifier_id uuid, hid text)
  on conflict (id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  insert into identity.patient_assurance_states (patient_id, account_id, state, source_system, contact_verified_at)
  select qa.id, qa.account_id, 'CONTACT_VERIFIED', 'hid-sealed-qa', clock_timestamp()
    from jsonb_to_recordset(qa_patients) qa(id uuid, account_id uuid)
  on conflict (patient_id) do nothing;
  get diagnostics step = row_count; inserted := inserted + step;

  -- D6: the share, written as 0098 D6 writes the demo's (the grant and share row
  -- identity.write_patient_share writes, column for column; one audit row of
  -- the migration's own; under the patient's advisory lock; only to a
  -- membership the patient could choose; once only).
  for qa_share in select * from jsonb_to_recordset(qa_shares) qa(patient_id uuid, membership_id uuid)
  loop
    perform pg_advisory_xact_lock(hashtextextended('patient-access-pin:' || qa_share.patient_id::text, 0));
    continue when exists (select 1 from identity.consent_grants grant_row
                           where grant_row.patient_id = qa_share.patient_id
                             and grant_row.membership_id = qa_share.membership_id
                             and grant_row.correlation_id = share_correlation)
               or exists (select 1 from identity.patient_consent_shares share
                            join identity.consent_grants grant_row on grant_row.id = share.consent_grant_id
                           where share.patient_id = qa_share.patient_id
                             and share.membership_id = qa_share.membership_id
                             and grant_row.status = 'active' and grant_row.expires_at > clock_timestamp());
    select membership.id, membership.staff_id, membership.account_id, membership.facility_id
      into share_membership
      from identity.staff_facility_memberships membership
      join identity.staff staff_row on staff_row.id = membership.staff_id
      join identity.facilities facility on facility.id = membership.facility_id
      join identity.organizations organization on organization.id = membership.organization_id
     where membership.id = qa_share.membership_id
       and identity.sealed_qa_account(membership.account_id)
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
      raise exception using errcode = '55000', message = '0123: SEALED_QA_SHARE_INELIGIBLE';
    end if;
    share_grant := gen_random_uuid();
    share_start := clock_timestamp();
    insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
      scope, status, granted_by_patient_id, reason, starts_at, expires_at, break_glass, correlation_id,
      purpose_of_use, authorization_method)
    values (share_grant, null, qa_share.patient_id, share_membership.staff_id, share_membership.account_id,
      share_membership.id, share_membership.facility_id, 'write_records', 'active', qa_share.patient_id,
      'Shared by the patient', share_start, share_start + interval '365 days', false, share_correlation,
      'direct-care', null);
    insert into identity.patient_consent_shares (consent_grant_id, patient_id, membership_id, level, duration_preset,
      created_via, invitation_id, replaced_consent_grant_id, idempotency_key, request_sha256)
    values (share_grant, qa_share.patient_id, qa_share.membership_id, 'clinical_collaboration', 'until_revoked',
      'search', null, null,
      'sealed-qa-share-' || qa_share.patient_id::text || '-' || qa_share.membership_id::text,
      encode(sha256(convert_to('sealed-qa-share:' || qa_share.patient_id::text || ':'
        || qa_share.membership_id::text, 'UTF8')), 'hex'));
    insert into audit.events (correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type,
      resource_id, provenance, source_system, details)
    values (share_correlation, 'system', share_membership.facility_id, qa_share.patient_id,
      'identity.sealed-qa.seed-share', 'success', 'consent-grant', share_grant::text, 'migration',
      'hid-sealed-qa', jsonb_build_object('scope', 'write_records', 'purpose', 'direct-care',
        'level', 'clinical_collaboration', 'duration', 'until_revoked', 'via', 'search'));
    inserted := inserted + 2;
  end loop;

  if inserted > 0 then
    insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, provenance,
      source_system, details)
    values (share_correlation, 'system', 'identity.sealed-qa.install', 'success', 'sealed-qa-tenant',
      'migration', 'hid-sealed-qa', jsonb_build_object('rowsInserted', inserted, 'facilities', 3,
        'staffLogins', 7, 'patientLogins', 2, 'patients', 2, 'shares', 1));
  end if;

  return jsonb_build_object(
    'inserted', inserted,
    'organizations', (select count(*) from identity.sealed_qa_members member where member.member_kind = 'organization'),
    'facilities', (select count(*) from identity.sealed_qa_members member where member.member_kind = 'facility'),
    'accounts', (select count(*) from identity.sealed_qa_members member where member.member_kind = 'account'),
    'patients', (select count(*) from identity.sealed_qa_members member where member.member_kind = 'patient'),
    'memberships', (select count(*) from identity.staff_facility_memberships membership
                     where identity.sealed_qa_account(membership.account_id) and membership.active),
    'shares', (select count(*) from identity.consent_grants grant_row
                where grant_row.correlation_id = share_correlation
                  and identity.sealed_qa_patient(grant_row.patient_id)));
end
$$;

-- 6. Grants (here and in runtime-grants.sql).
revoke all on function identity.sealed_qa_ids(text), identity.sealed_qa_facility(uuid),
  identity.sealed_qa_patient(uuid), identity.sealed_qa_account(uuid), identity.sealed_qa_recipient(text),
  identity.sealed_qa_install(), identity.sealed_qa_members_not_demo(), identity.demo_members_never_qa(),
  identity.consent_grants_sealed_qa(), identity.staff_memberships_sealed_qa(), identity.account_roles_sealed_qa(),
  identity.patient_share_invitations_sealed_qa(), identity.patient_contact_changes_sealed_qa(),
  identity.qoreid_quota_counters_sealed_qa(), identity.patient_emergency_contacts_sealed_qa(),
  identity.outreach_organisations_sealed_qa(), identity.outreach_invitations_sealed_qa() from public;
do $$
declare role_name text;
begin
  foreach role_name in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('grant execute on function identity.sealed_qa_ids(text), '
        || 'identity.sealed_qa_facility(uuid) to %I', role_name);
    end if;
  end loop;
end
$$;

-- 7. Post-checks (after the grants, so the ACLs are the final ones).
do $$
declare problem text;
begin
  -- The table: row-level security enabled, not forced, one owner policy, no grant.
  if not exists (select 1 from pg_class rel where rel.oid = 'identity.sealed_qa_members'::regclass
                  and rel.relrowsecurity and not rel.relforcerowsecurity
                  and (rel.relacl is null or not exists (select 1 from aclexplode(rel.relacl) acl
                                                          where acl.grantee <> rel.relowner)))
     or (select count(*) from pg_policy where polrelid = 'identity.sealed_qa_members'::regclass) <> 1 then
    raise exception using errcode = '55000', message = '0123: identity.sealed_qa_members is not as section 2 made it';
  end if;
  -- Every new function: owned by the applier, search_path pinned, EXECUTE as section 6 grants it.
  select string_agg(proc.oid::regprocedure::text, ', ') into problem
    from pg_proc proc
   where proc.pronamespace = 'identity'::regnamespace
     and proc.proname in ('sealed_qa_ids', 'sealed_qa_facility', 'sealed_qa_patient', 'sealed_qa_account',
       'sealed_qa_recipient', 'sealed_qa_install', 'sealed_qa_members_not_demo', 'demo_members_never_qa',
       'consent_grants_sealed_qa', 'staff_memberships_sealed_qa', 'account_roles_sealed_qa',
       'patient_share_invitations_sealed_qa', 'patient_contact_changes_sealed_qa', 'qoreid_quota_counters_sealed_qa',
       'patient_emergency_contacts_sealed_qa', 'outreach_organisations_sealed_qa', 'outreach_invitations_sealed_qa')
     and (proc.proowner <> (select oid from pg_roles where rolname = current_user)
       or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']
       or (proc.proname <> 'sealed_qa_recipient') <> proc.prosecdef
       or exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                   where acl.grantee <> proc.proowner
                     and not (proc.proname in ('sealed_qa_ids', 'sealed_qa_facility')
                              and acl.grantee in (select oid from pg_roles
                                                   where rolname in ('hid_identity_runtime', 'hid_schema_test_runtime'))
                              and acl.privilege_type = 'EXECUTE')));
  if problem is not null
     or (select count(*) from pg_proc proc where proc.pronamespace = 'identity'::regnamespace
           and proc.proname in ('sealed_qa_ids', 'sealed_qa_facility', 'sealed_qa_patient', 'sealed_qa_account',
             'sealed_qa_recipient', 'sealed_qa_install', 'sealed_qa_members_not_demo', 'demo_members_never_qa',
             'consent_grants_sealed_qa', 'staff_memberships_sealed_qa', 'account_roles_sealed_qa',
             'patient_share_invitations_sealed_qa', 'patient_contact_changes_sealed_qa',
             'qoreid_quota_counters_sealed_qa', 'patient_emergency_contacts_sealed_qa',
             'outreach_organisations_sealed_qa', 'outreach_invitations_sealed_qa')) <> 17 then
    raise exception using errcode = '55000', message = '0123: these functions are not as written: '
      || coalesce(problem, 'a function is missing');
  end if;
  -- Whoever reads identity.patients under its policies may run the two helpers the policy calls.
  if exists (select 1 from pg_roles role_row
              where role_row.rolname in ('hid_identity_runtime', 'hid_schema_test_runtime')
                and (not has_function_privilege(role_row.oid, 'identity.sealed_qa_ids(text)', 'EXECUTE')
                  or not has_function_privilege(role_row.oid, 'identity.sealed_qa_facility(uuid)', 'EXECUTE'))) then
    raise exception using errcode = '55000', message = '0123: a reader of identity.patients cannot run the QA helpers';
  end if;
  -- The QA triggers, enabled 'O', as written.
  select string_agg(expected.name, ', ') into problem
    from (values
      ('identity.sealed_qa_members', 'sealed_qa_members_immutable'),
      ('identity.sealed_qa_members', 'sealed_qa_members_no_truncate'),
      ('identity.sealed_qa_members', 'sealed_qa_members_not_demo'),
      ('identity.sealed_demo_members', 'demo_members_never_qa'),
      ('identity.consent_grants', 'consent_grants_sealed_qa'),
      ('identity.staff_facility_memberships', 'staff_memberships_sealed_qa'),
      ('auth.account_roles', 'account_roles_sealed_qa'),
      ('identity.patient_share_invitations', 'patient_share_invitations_sealed_qa'),
      ('identity.patient_contact_changes', 'patient_contact_changes_sealed_qa'),
      ('platform.qoreid_quota_counters', 'qoreid_quota_counters_sealed_qa'),
      ('identity.patient_emergency_contacts', 'patient_emergency_contacts_sealed_qa'),
      ('identity.outreach_organisations', 'outreach_organisations_sealed_qa'),
      ('identity.outreach_invitations', 'outreach_invitations_sealed_qa')
    ) expected(table_name, name)
   where not exists (select 1 from pg_trigger trigger_row
                      where trigger_row.tgrelid = expected.table_name::regclass
                        and trigger_row.tgname = expected.name and trigger_row.tgenabled = 'O'
                        and not trigger_row.tgisinternal);
  if problem is not null then
    raise exception using errcode = '55000', message = '0123: these triggers are missing or not enabled: ' || problem;
  end if;
  -- The replaced functions keep every attribute but the body.
  select string_agg(recorded.function_oid::regprocedure::text, ', ') into problem
    from sealed_qa_0123_replaced recorded
    join pg_proc proc on proc.oid = recorded.function_oid
   where proc.proowner <> recorded.proowner or proc.prosecdef <> recorded.prosecdef
      or proc.provolatile <> recorded.provolatile or proc.proconfig is distinct from recorded.proconfig
      or proc.proacl is distinct from recorded.proacl or proc.prorettype <> recorded.prorettype
      or proc.proretset <> recorded.proretset or proc.proargtypes <> recorded.proargtypes
      or proc.proargnames is distinct from recorded.proargnames or proc.prolang <> recorded.prolang
      or position('sealed_qa_' in proc.prosrc) = 0;
  if problem is not null or (select count(*) from sealed_qa_0123_replaced) <> 9 then
    raise exception using errcode = '55000', message = '0123: a replaced function changed beyond its body: '
      || coalesce(problem, 'one is missing');
  end if;
end
$$;

-- 8. Comments.
comment on table identity.sealed_qa_members is
  'The sealed QA tenant (0123, owner decision Q60): its organizations, facilities, accounts and patients. Owner-only; never updated or deleted; never a demo member too.';
comment on function identity.sealed_qa_ids(text) is
  'The sealed QA tenant''s member ids of one kind (0123), for identity.patients'' registration read and the platform overview.';
comment on function identity.sealed_qa_facility(uuid) is 'Whether a facility is in the sealed QA tenant (0123).';
comment on function identity.sealed_qa_patient(uuid) is 'Whether a patient is in the sealed QA tenant (0123).';
comment on function identity.sealed_qa_account(uuid) is 'Whether an account is in the sealed QA tenant (0123).';
comment on function identity.sealed_qa_recipient(text) is
  'Whether an address is the owner''s domain (@healthidentitydirectory.com, plus-addresses allowed): the only addresses a QA patient invites, adds as an emergency contact or changes their email to (0123).';
comment on function identity.sealed_qa_install() is
  'Seeds the sealed QA tenant (0123): on Amazon RDS at release, elsewhere only by its suite. Idempotent; refuses any row it would take from someone else.';

-- 9. Section 0's temporary table.
drop table sealed_qa_0123_replaced;

-- 10. The seed, on Amazon RDS only (D4). A refusal raises 55000 and the release
-- stops with nothing applied.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'rds_superuser') then
    perform identity.sealed_qa_install();
  end if;
end
$$;

-- 11. identity.patients' registration read: 0098's expression and the same
-- rule for QA. Last, so that the ACCESS EXCLUSIVE lock is held for the
-- shortest time; bounded like section 1's.
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
          message = '0123: identity.patients stayed busy for 5 seconds; run the release again later';
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
              = (select identity.sealed_demo_facility(platform.current_facility_id())))
         and ((id = any ((select identity.sealed_qa_ids('patient'))::uuid[]))
              = (select identity.sealed_qa_facility(platform.current_facility_id()))));
do $$
begin
  if (select count(*) from pg_policy policy_row where policy_row.polrelid = 'identity.patients'::regclass) <> 6
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'identity.patients'::regclass
                       and policy_row.polname = 'patients_registration_read'
                       and policy_row.polcmd = 'r' and policy_row.polpermissive
                       and policy_row.polroles = '{0}'::oid[] and policy_row.polwithcheck is null
                       and pg_get_expr(policy_row.polqual, policy_row.polrelid) like '%sealed_demo_ids%sealed_demo_facility%sealed_qa_ids%sealed_qa_facility%') then
    raise exception using errcode = '55000', message = '0123: identity.patients'' registration read is not section 11''s';
  end if;
end
$$;
