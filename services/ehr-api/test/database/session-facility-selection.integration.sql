\set ON_ERROR_STOP on
-- A staff member's chosen facility, kept per sign-in (0129, port of main 0089
-- / hid-system#73; design note on hid-system#258). Rollback-only.
--
-- The Identity API keeps the facility a staff member chose with POST
-- /auth/facility in auth.session_facility_selection, one row per sign-in
-- (session family, keyed by the family's first session), so a reload, a new
-- tab or a refresh opens at the chosen facility instead of silently moving
-- back to the primary one. The row is only the default GET /auth/session and
-- POST /auth/refresh report: every facility-scoped request still carries
-- X-Facility-ID, which the Identity guard checks, and the Identity API
-- re-checks the stored facility against the actor's current facilities on
-- every read. The cases, through the Identity API's runtime role where the
-- API acts:
--   1. structure: the table's columns, primary key, four foreign keys (all
--      ON DELETE RESTRICT: the sign-in, the account, the facility, and the
--      membership by (id, facility_id, account_id)), no row-level security;
--      the guard is plpgsql, SECURITY INVOKER, search_path pg_catalog,
--      pg_temp, with 0129's body (md5), executable by its owner only, and
--      fires before every row insert, update and delete;
--   2. privileges: the Identity runtime and its API login read, insert and
--      update, never delete or truncate; PUBLIC and every other hid_ role
--      (the schema test runtime included) hold nothing;
--   3. as the Identity API runtime: the API's write (the presented session
--      locked FOR SHARE, then the upsert keyed by family) records a choice
--      and replaces it; the guard refuses (23514) every row that is not an
--      active membership of a live staff sign-in of an active account: a
--      patient sign-in, a session that is not the family's first, another
--      account's sign-in or membership, a membership of another facility, a
--      signed-out or lapsed sign-in, an ended or held membership, an
--      inactive or unverified staff record, a suspended facility, a
--      deactivated organisation, a locked or disabled account, a sign-in at
--      an older token version, no sign-in at all; it admits a verification
--      status written with spaces and capitals (as the staff context
--      compares it), and either of two roles held at one facility; an update
--      to an ended membership is refused, a move to another sign-in or
--      account is refused (55000), and the runtime cannot delete (42501);
--   4. the owner cannot delete a choice either (55000);
--   5. rotation keeps the choice (read through the rotated session only, as
--      TokenService reads it), a rotated sign-in can still change it, and
--      after sign-out nothing reads it, the row stays, and it cannot be
--      changed again;
--   6. workforce and account changes still work while a row refers to them:
--      a platform administrator suspends a facility
--      (identity.admin_transition_facility) and disables an account
--      (auth.admin_transition_account, which also ends its sign-ins); a
--      membership is ended (the UPDATE identity.end_facility_staff_membership
--      makes) and one is held (as the migration tooling holds one); each
--      succeeds, the row stays, and the same choice is then refused; the
--      referenced sign-in and membership cannot be deleted, and a referenced
--      membership cannot be moved to another facility (23503 on 0129's keys;
--      nothing on staging does either);
--   7. the seals (0098 demo, 0123 QA): no membership crosses between real,
--      demo and QA, so a choice cannot either; a demo or QA staff member's
--      own choice is admitted;
--   8. the sign-in, as the family's first session (Rahman's review on
--      hid-system#258): the first session must be a staff session of the
--      account, so a family whose first session is a patient session, or
--      another account's, is refused even with a live staff session of the
--      account in it (forged families: the API never writes one; only that
--      clause refuses them), and a family whose only live session is a
--      patient one, or another account's, is refused too; an account-only
--      outreach session (Q88-2:
--      a staff session of a verified staff login with no active membership;
--      staging has no other staff kind) is refused, through the API's write
--      and directly, with its own ended membership or another account's; and
--      a rotated sign-in whose first session is revoked, with a later session
--      live, is admitted on its first choice (an INSERT): the row is keyed to
--      the revoked first session, which the foreign key pins, while the
--      liveness check uses the live one;
--   9. single sign-on (0127): a staff sign-in a product issued after single
--      sign-on is a root staff session with its provenance row (written by
--      the Identity runtime, as TokenService.issue writes it), so it keeps a
--      choice exactly as a password sign-in does, through a refresh too; a
--      back-channel logout of its provider session (revocation_reason
--      'sso_logout', SsoService's own UPDATE, as the Identity runtime) ends
--      it as sign-out does: nothing reads the choice, the API's write finds
--      no live session, the row cannot be changed (23514) and stays, and the
--      provenance row stays; a password sign-in of the same account outside
--      that provider session keeps reading its own choice until product
--      sign-out ends every staff sign-in of the account ('sso_logout' too),
--      after which it is answered the same way; the sign-in's first session
--      cannot be deleted while either row refers to it (23503).
-- Synthetic values only; uuid prefix f129; .invalid addresses.
set plpgsql.variable_conflict = error;
begin;

-- Organisations: OA active; OC deactivated; OQ the QA side; OD the demo side.
insert into identity.organizations (id, name, slug, active) values
  ('f1290000-0000-4000-8000-0000000000a1', 'Selection Port Org', 'selection-port-org-f129', true),
  ('f1290000-0000-4000-8000-0000000000a2', 'Selection Port Closed Org', 'selection-port-closed-org-f129', false),
  ('f1290000-0000-4000-8000-0000000000a3', 'Selection Port QA Org', 'selection-port-qa-org-f129', true),
  ('f1290000-0000-4000-8000-0000000000a4', 'Selection Port Demo Org', 'selection-port-demo-org-f129', true);
-- Facilities: F1, F2, F3 and F6 active at OA; F4 suspended at OA; F5 active
-- under the deactivated OC; F7 at OQ (QA); F8 at OD (demo).
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('f1291000-0000-4000-8000-0000000000f1', 'f1290000-0000-4000-8000-0000000000a1', 'Selection Port Alpha', 'SPF-F1', 'Africa/Lagos', true, 'verified'),
  ('f1291000-0000-4000-8000-0000000000f2', 'f1290000-0000-4000-8000-0000000000a1', 'Selection Port Beta', 'SPF-F2', 'Africa/Lagos', true, 'verified'),
  ('f1291000-0000-4000-8000-0000000000f3', 'f1290000-0000-4000-8000-0000000000a1', 'Selection Port Gamma', 'SPF-F3', 'Africa/Lagos', true, 'verified'),
  ('f1291000-0000-4000-8000-0000000000f4', 'f1290000-0000-4000-8000-0000000000a1', 'Selection Port Suspended', 'SPF-F4', 'Africa/Lagos', false, 'suspended'),
  ('f1291000-0000-4000-8000-0000000000f5', 'f1290000-0000-4000-8000-0000000000a2', 'Selection Port Closed', 'SPF-F5', 'Africa/Lagos', true, 'verified'),
  ('f1291000-0000-4000-8000-0000000000f6', 'f1290000-0000-4000-8000-0000000000a1', 'Selection Port Delta', 'SPF-F6', 'Africa/Lagos', true, 'verified'),
  ('f1291000-0000-4000-8000-0000000000f7', 'f1290000-0000-4000-8000-0000000000a3', 'Selection Port QA Ward', 'SPF-F7', 'Africa/Lagos', true, 'verified'),
  ('f1291000-0000-4000-8000-0000000000f8', 'f1290000-0000-4000-8000-0000000000a4', 'Selection Port Demo Ward', 'SPF-F8', 'Africa/Lagos', true, 'verified');

-- Accounts. A, B, C, D: staff (C's record inactive, D's not verified; A is
-- also a patient, so A's patient sign-in differs from A's staff sign-ins only
-- in its kind). E: locked. H: disabled until tomorrow. T: at token version 2.
-- P: a patient. Q: QA staff. G: demo staff. S: a platform super administrator.
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm, token_version, disabled_until) values
  ('f1292000-0000-4000-8000-00000000000a', 'synthetic:selection-0129:a', 'a@selection-0129.invalid', 'active', 'synthetic-hash', 'argon2id', 1, null),
  ('f1292000-0000-4000-8000-00000000000b', 'synthetic:selection-0129:b', 'b@selection-0129.invalid', 'active', 'synthetic-hash', 'argon2id', 1, null),
  ('f1292000-0000-4000-8000-00000000000c', 'synthetic:selection-0129:c', 'c@selection-0129.invalid', 'active', 'synthetic-hash', 'argon2id', 1, null),
  ('f1292000-0000-4000-8000-00000000000d', 'synthetic:selection-0129:d', 'd@selection-0129.invalid', 'active', 'synthetic-hash', 'argon2id', 1, null),
  ('f1292000-0000-4000-8000-00000000000e', 'synthetic:selection-0129:e', 'e@selection-0129.invalid', 'locked', 'synthetic-hash', 'argon2id', 1, null),
  ('f1292000-0000-4000-8000-0000000000d1', 'synthetic:selection-0129:h', 'h@selection-0129.invalid', 'active', 'synthetic-hash', 'argon2id', 1,
   now() + interval '1 day'),
  ('f1292000-0000-4000-8000-0000000000b2', 'synthetic:selection-0129:t', 't@selection-0129.invalid', 'active', 'synthetic-hash', 'argon2id', 2, null),
  ('f1292000-0000-4000-8000-0000000000e0', 'synthetic:selection-0129:p', 'p@selection-0129.invalid', 'active', 'synthetic-hash', 'argon2id', 1, null),
  ('f1292000-0000-4000-8000-0000000000aa', 'synthetic:selection-0129:q', 'q@selection-0129.invalid', 'active', 'synthetic-hash', 'argon2id', 1, null),
  ('f1292000-0000-4000-8000-0000000000dd', 'synthetic:selection-0129:g', 'g@selection-0129.invalid', 'active', 'synthetic-hash', 'argon2id', 1, null),
  ('f1292000-0000-4000-8000-0000000000ff', 'synthetic:selection-0129:super', 'super@selection-0129.invalid', 'active', null, null, 1, null);
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('f1292100-0000-4000-8000-0000000000ff', 'f1292000-0000-4000-8000-0000000000ff', 'platform_super_admin', 'platform',
   'Facility selection suite super admin');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('f1293000-0000-4000-8000-00000000000a', 'f1292000-0000-4000-8000-00000000000a', 'HID-SELXAAAA', 'Ada', 'Selection', 'Ada Selection', 'active'),
  ('f1293000-0000-4000-8000-0000000000e0', 'f1292000-0000-4000-8000-0000000000e0', 'HID-SELXPPPP', 'Pat', 'Selection', 'Pat Selection', 'active');

-- The demo and QA sides (0098, 0123), recorded as their installs record them.
insert into identity.sealed_qa_members (member_kind, member_id) values
  ('organization', 'f1290000-0000-4000-8000-0000000000a3'),
  ('facility', 'f1291000-0000-4000-8000-0000000000f7'),
  ('account', 'f1292000-0000-4000-8000-0000000000aa');
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('organization', 'f1290000-0000-4000-8000-0000000000a4'),
  ('facility', 'f1291000-0000-4000-8000-0000000000f8'),
  ('account', 'f1292000-0000-4000-8000-0000000000dd');

insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active) values
  ('f1294000-0000-4000-8000-00000000000a', 'f1292000-0000-4000-8000-00000000000a', 'Staff A Selection', 'a@selection-0129.invalid', 'verified', 'doctor', true),
  ('f1294000-0000-4000-8000-00000000000b', 'f1292000-0000-4000-8000-00000000000b', 'Staff B Selection', 'b@selection-0129.invalid', ' Verified ', 'doctor', true),
  ('f1294000-0000-4000-8000-00000000000c', 'f1292000-0000-4000-8000-00000000000c', 'Staff C Selection', 'c@selection-0129.invalid', 'verified', 'doctor', false),
  ('f1294000-0000-4000-8000-00000000000d', 'f1292000-0000-4000-8000-00000000000d', 'Staff D Selection', 'd@selection-0129.invalid', 'pending', 'doctor', true),
  ('f1294000-0000-4000-8000-00000000000e', 'f1292000-0000-4000-8000-00000000000e', 'Staff E Selection', 'e@selection-0129.invalid', 'verified', 'doctor', true),
  ('f1294000-0000-4000-8000-0000000000d1', 'f1292000-0000-4000-8000-0000000000d1', 'Staff H Selection', 'h@selection-0129.invalid', 'verified', 'doctor', true),
  ('f1294000-0000-4000-8000-0000000000b2', 'f1292000-0000-4000-8000-0000000000b2', 'Staff T Selection', 't@selection-0129.invalid', 'verified', 'doctor', true),
  ('f1294000-0000-4000-8000-0000000000aa', 'f1292000-0000-4000-8000-0000000000aa', 'Staff Q Selection', 'q@selection-0129.invalid', 'verified', 'doctor', true),
  ('f1294000-0000-4000-8000-0000000000dd', 'f1292000-0000-4000-8000-0000000000dd', 'Staff G Selection', 'g@selection-0129.invalid', 'verified', 'doctor', true);

-- Memberships of A: a1 at F1 (primary) and a2 at F2 active; a3 at F3 ended;
-- a4 at the suspended F4; a5 at F5 under the deactivated OC; a6 at F3 held
-- for migration; a7 at F2 too, a second role there (two memberships at one
-- facility: no index forbids it here); a8 at F6. One each for B, C, D, E, H
-- and T at F1; Q at the QA F7; G at the demo F8.
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, migration_hold_reason) values
  ('f1295000-0000-4000-8000-0000000000a1', 'f1294000-0000-4000-8000-00000000000a', 'f1292000-0000-4000-8000-00000000000a',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true, null),
  ('f1295000-0000-4000-8000-0000000000a2', 'f1294000-0000-4000-8000-00000000000a', 'f1292000-0000-4000-8000-00000000000a',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f2', 'nurse', 'nurse', false, true, null),
  ('f1295000-0000-4000-8000-0000000000a3', 'f1294000-0000-4000-8000-00000000000a', 'f1292000-0000-4000-8000-00000000000a',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f3', 'doctor', 'doctor', false, false, null),
  ('f1295000-0000-4000-8000-0000000000a4', 'f1294000-0000-4000-8000-00000000000a', 'f1292000-0000-4000-8000-00000000000a',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f4', 'doctor', 'doctor', false, true, null),
  ('f1295000-0000-4000-8000-0000000000a5', 'f1294000-0000-4000-8000-00000000000a', 'f1292000-0000-4000-8000-00000000000a',
   'f1290000-0000-4000-8000-0000000000a2', 'f1291000-0000-4000-8000-0000000000f5', 'doctor', 'doctor', false, true, null),
  ('f1295000-0000-4000-8000-0000000000a6', 'f1294000-0000-4000-8000-00000000000a', 'f1292000-0000-4000-8000-00000000000a',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f3', 'nurse', 'nurse', false, true,
   'Synthetic migration hold'),
  ('f1295000-0000-4000-8000-0000000000a7', 'f1294000-0000-4000-8000-00000000000a', 'f1292000-0000-4000-8000-00000000000a',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f2', 'doctor', 'doctor', false, true, null),
  ('f1295000-0000-4000-8000-0000000000a8', 'f1294000-0000-4000-8000-00000000000a', 'f1292000-0000-4000-8000-00000000000a',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f6', 'doctor', 'doctor', false, true, null),
  ('f1295000-0000-4000-8000-0000000000b1', 'f1294000-0000-4000-8000-00000000000b', 'f1292000-0000-4000-8000-00000000000b',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true, null),
  ('f1295000-0000-4000-8000-0000000000c1', 'f1294000-0000-4000-8000-00000000000c', 'f1292000-0000-4000-8000-00000000000c',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true, null),
  ('f1295000-0000-4000-8000-0000000000d1', 'f1294000-0000-4000-8000-00000000000d', 'f1292000-0000-4000-8000-00000000000d',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true, null),
  ('f1295000-0000-4000-8000-0000000000e1', 'f1294000-0000-4000-8000-00000000000e', 'f1292000-0000-4000-8000-00000000000e',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true, null),
  ('f1295000-0000-4000-8000-0000000000d2', 'f1294000-0000-4000-8000-0000000000d1', 'f1292000-0000-4000-8000-0000000000d1',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true, null),
  ('f1295000-0000-4000-8000-0000000000b2', 'f1294000-0000-4000-8000-0000000000b2', 'f1292000-0000-4000-8000-0000000000b2',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true, null),
  ('f1295000-0000-4000-8000-0000000000aa', 'f1294000-0000-4000-8000-0000000000aa', 'f1292000-0000-4000-8000-0000000000aa',
   'f1290000-0000-4000-8000-0000000000a3', 'f1291000-0000-4000-8000-0000000000f7', 'doctor', 'doctor', true, true, null),
  ('f1295000-0000-4000-8000-0000000000dd', 'f1294000-0000-4000-8000-0000000000dd', 'f1292000-0000-4000-8000-0000000000dd',
   'f1290000-0000-4000-8000-0000000000a4', 'f1291000-0000-4000-8000-0000000000f8', 'doctor', 'doctor', true, true, null);

-- Sign-ins. Each family's first session has id = family_id. A1, A2 and A4:
-- live staff sign-ins of A (A4 never chooses); A8 signed out; A9 lapsed; AC: A's patient
-- sign-in; E0: P's patient sign-in. B1, C1, D1, E1, H1: live staff sign-ins.
-- T1: T's sign-in from before T's token version moved to 2; T2: after.
-- Q1, G1: live staff sign-ins of the QA and the demo staff member.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, revoked_at, revocation_reason,
    session_kind, patient_id)
select fixture.session_id::uuid, fixture.account_id::uuid, fixture.session_id::uuid,
  md5(fixture.session_id) || md5(fixture.session_id || 'refresh'), gen_random_uuid(), fixture.token_version, 'password',
  fixture.issued_at, fixture.expires_at, fixture.issued_at + interval '24 hours', fixture.revoked_at,
  case when fixture.revoked_at is not null then 'logout' end, fixture.kind, fixture.patient_id::uuid
from (values
  ('f1296000-0000-4000-8000-0000000000a1', 'f1292000-0000-4000-8000-00000000000a', 1, now(), now() + interval '8 hours', null::timestamptz, 'staff', null),
  ('f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a', 1, now(), now() + interval '8 hours', null, 'staff', null),
  ('f1296000-0000-4000-8000-0000000000a4', 'f1292000-0000-4000-8000-00000000000a', 1, now(), now() + interval '8 hours', null, 'staff', null),
  ('f1296000-0000-4000-8000-0000000000a8', 'f1292000-0000-4000-8000-00000000000a', 1, now(), now() + interval '8 hours', now(), 'staff', null),
  ('f1296000-0000-4000-8000-0000000000a9', 'f1292000-0000-4000-8000-00000000000a', 1, now() - interval '9 hours', now() - interval '1 hour', null, 'staff', null),
  ('f1296000-0000-4000-8000-0000000000ac', 'f1292000-0000-4000-8000-00000000000a', 1, now(), now() + interval '8 hours', null, 'patient',
   'f1293000-0000-4000-8000-00000000000a'),
  ('f1296000-0000-4000-8000-0000000000e0', 'f1292000-0000-4000-8000-0000000000e0', 1, now(), now() + interval '8 hours', null, 'patient',
   'f1293000-0000-4000-8000-0000000000e0'),
  ('f1296000-0000-4000-8000-0000000000b1', 'f1292000-0000-4000-8000-00000000000b', 1, now(), now() + interval '8 hours', null, 'staff', null),
  ('f1296000-0000-4000-8000-0000000000c1', 'f1292000-0000-4000-8000-00000000000c', 1, now(), now() + interval '8 hours', null, 'staff', null),
  ('f1296000-0000-4000-8000-0000000000d1', 'f1292000-0000-4000-8000-00000000000d', 1, now(), now() + interval '8 hours', null, 'staff', null),
  ('f1296000-0000-4000-8000-0000000000e1', 'f1292000-0000-4000-8000-00000000000e', 1, now(), now() + interval '8 hours', null, 'staff', null),
  ('f1296000-0000-4000-8000-0000000000d2', 'f1292000-0000-4000-8000-0000000000d1', 1, now(), now() + interval '8 hours', null, 'staff', null),
  ('f1296000-0000-4000-8000-0000000000b3', 'f1292000-0000-4000-8000-0000000000b2', 1, now(), now() + interval '8 hours', null, 'staff', null),
  ('f1296000-0000-4000-8000-0000000000b4', 'f1292000-0000-4000-8000-0000000000b2', 2, now(), now() + interval '8 hours', null, 'staff', null),
  ('f1296000-0000-4000-8000-0000000000aa', 'f1292000-0000-4000-8000-0000000000aa', 1, now(), now() + interval '8 hours', null, 'staff', null),
  ('f1296000-0000-4000-8000-0000000000dd', 'f1292000-0000-4000-8000-0000000000dd', 1, now(), now() + interval '8 hours', null, 'staff', null)
) as fixture(session_id, account_id, token_version, issued_at, expires_at, revoked_at, kind, patient_id);
-- A live session of A2's family that is not its first (as after a rotation).
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
values ('f1296000-0000-4000-8000-0000000000a7', 'f1292000-0000-4000-8000-00000000000a',
  'f1296000-0000-4000-8000-0000000000a2', md5('f129-a7') || md5('f129-a7-refresh'), gen_random_uuid(), 1, 'password',
  now(), now() + interval '8 hours', now() + interval '24 hours', 'staff');
-- A live session naming a7 as its family although a7 is not a family's first
-- session (the API never writes this): a family is known by its first session.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
values ('f1296000-0000-4000-8000-0000000000a6', 'f1292000-0000-4000-8000-00000000000a',
  'f1296000-0000-4000-8000-0000000000a7', md5('f129-a6') || md5('f129-a6-refresh'), gen_random_uuid(), 1, 'password',
  now(), now() + interval '8 hours', now() + interval '24 hours', 'staff');

-- The Identity API's write (TokenService.recordFacilitySelection): lock the
-- presented session FOR SHARE where it is a live staff session of the
-- account, then upsert the choice keyed by its family. Answers the family
-- recorded, or null when the presented session is not live (session_ended).
create function pg_temp.select_facility(presented uuid, account uuid, chosen_facility uuid, chosen_membership uuid)
returns uuid language plpgsql as $f$
declare
  locked_family uuid;
  recorded uuid;
begin
  select session_row.family_id into locked_family
    from auth.sessions session_row
   where session_row.id = presented and session_row.account_id = account and session_row.session_kind = 'staff'
     and session_row.revoked_at is null and session_row.expires_at > clock_timestamp()
     and session_row.absolute_expires_at > clock_timestamp()
     for share;
  if locked_family is null then
    return null;
  end if;
  insert into auth.session_facility_selection (family_id, account_id, facility_id, membership_id)
  values (locked_family, account, chosen_facility, chosen_membership)
  on conflict (family_id) do update
     set facility_id = excluded.facility_id, membership_id = excluded.membership_id,
         selected_at = clock_timestamp(), row_version = auth.session_facility_selection.row_version + 1
  returning auth.session_facility_selection.family_id into recorded;
  return recorded;
end
$f$;
-- The Identity API's read (TokenService.selectedFacilityId): the facility
-- only, through the presented session while it is a live staff session.
create function pg_temp.selected_facility(presented uuid, account uuid)
returns uuid language sql stable as $f$
  select selection.facility_id
    from auth.sessions session_row
    join auth.session_facility_selection selection
      on selection.family_id = session_row.family_id and selection.account_id = session_row.account_id
   where session_row.id = presented and session_row.account_id = account and session_row.session_kind = 'staff'
     and session_row.revoked_at is null and session_row.expires_at > clock_timestamp()
     and session_row.absolute_expires_at > clock_timestamp()
$f$;
-- A platform administrator's session settings (as the Identity API sets them).
create function pg_temp.as_platform_admin(correlation text)
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:selection-0129:super', true),
    set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
    set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true), set_config('app.patient_id', '', true);
$f$;
grant execute on function pg_temp.select_facility(uuid, uuid, uuid, uuid), pg_temp.selected_facility(uuid, uuid),
  pg_temp.as_platform_admin(text) to hid_identity_api_runtime;

-- 1. Structure.
do $$
declare
  guard regprocedure;
  table_owner oid;
begin
  if to_regclass('auth.session_facility_selection') is null then
    raise exception 'auth.session_facility_selection does not exist (0129 not applied)';
  end if;
  guard := to_regprocedure('auth.guard_session_facility_selection_change()');
  if guard is null then
    raise exception 'auth.guard_session_facility_selection_change() does not exist (0129 not applied)';
  end if;
  table_owner := (select relation.relowner from pg_class relation
                   where relation.oid = 'auth.session_facility_selection'::regclass);
  if (select array_agg(attribute.attname::text || ':' || format_type(attribute.atttypid, attribute.atttypmod)
          || ':' || attribute.attnotnull::text || ':' || coalesce(pg_get_expr(column_default.adbin, column_default.adrelid), '-')
          order by attribute.attnum)
        from pg_attribute attribute
        left join pg_attrdef column_default
          on column_default.adrelid = attribute.attrelid and column_default.adnum = attribute.attnum
       where attribute.attrelid = 'auth.session_facility_selection'::regclass and attribute.attnum > 0
         and not attribute.attisdropped)
     is distinct from array['family_id:uuid:true:-', 'account_id:uuid:true:-', 'facility_id:uuid:true:-',
       'membership_id:uuid:true:-', 'selected_at:timestamp with time zone:true:clock_timestamp()',
       'row_version:bigint:true:1'] then
    raise exception 'auth.session_facility_selection columns are not 0129''s';
  end if;
  if (select array_agg(constraint_row.contype::text || ' ' || pg_get_constraintdef(constraint_row.oid)
          order by constraint_row.contype, pg_get_constraintdef(constraint_row.oid))
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'auth.session_facility_selection'::regclass)
     is distinct from array[
       'c CHECK ((row_version > 0))',
       'f FOREIGN KEY (account_id) REFERENCES auth.accounts(id) ON DELETE RESTRICT',
       'f FOREIGN KEY (facility_id) REFERENCES identity.facilities(id) ON DELETE RESTRICT',
       'f FOREIGN KEY (family_id) REFERENCES auth.sessions(id) ON DELETE RESTRICT',
       'f FOREIGN KEY (membership_id, facility_id, account_id) REFERENCES identity.staff_facility_memberships(id, facility_id, account_id) ON DELETE RESTRICT',
       'p PRIMARY KEY (family_id)'] then
    raise exception 'auth.session_facility_selection keys are not 0129''s: %', (select array_agg(pg_get_constraintdef(constraint_row.oid))
      from pg_constraint constraint_row where constraint_row.conrelid = 'auth.session_facility_selection'::regclass);
  end if;
  if (select relation.relrowsecurity or relation.relforcerowsecurity or relation.relkind <> 'r'
        from pg_class relation where relation.oid = 'auth.session_facility_selection'::regclass)
     or obj_description('auth.session_facility_selection'::regclass, 'pg_class') is null then
    raise exception 'auth.session_facility_selection must be a plain table without row-level security, with its comment';
  end if;
  if not exists (
    select 1 from pg_proc function_row join pg_language language_row on language_row.oid = function_row.prolang
     where function_row.oid = guard and language_row.lanname = 'plpgsql' and not function_row.prosecdef
       and function_row.provolatile = 'v' and function_row.prorettype = 'trigger'::regtype
       and function_row.proowner = table_owner
       and function_row.proconfig = array['search_path=pg_catalog, pg_temp']
       and md5(function_row.prosrc) = 'f77032f5b5082fed66f7b01a3ee34f5a'
  ) then
    raise exception 'the selection guard must be 0129''s body, plpgsql, SECURITY INVOKER, search_path pg_catalog, pg_temp, owned by the table''s owner';
  end if;
  -- Revoked from PUBLIC: an ACL that names only the owner.
  if (select function_row.proacl from pg_proc function_row where function_row.oid = guard) is null
     or exists (select 1 from pg_proc function_row, aclexplode(function_row.proacl) privilege
                 where function_row.oid = guard and privilege.grantee <> function_row.proowner) then
    raise exception 'a role other than its owner can execute the selection guard';
  end if;
  -- tgtype 31 = ROW | BEFORE | INSERT | DELETE | UPDATE.
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'auth.session_facility_selection'::regclass and not trigger_row.tgisinternal) <> 1
     or not exists (
    select 1 from pg_trigger trigger_row
     where trigger_row.tgrelid = 'auth.session_facility_selection'::regclass and trigger_row.tgfoid = guard
       and trigger_row.tgname = 'session_facility_selection_guard'
       and not trigger_row.tgisinternal and trigger_row.tgenabled = 'O' and trigger_row.tgtype = 31) then
    raise exception 'the selection guard must be the one trigger, before every row insert, update and delete';
  end if;
end $$;

-- 2. Privileges.
do $$
declare
  role_name text;
  privilege_name text;
begin
  foreach role_name in array array['hid_identity_runtime', 'hid_identity_api_runtime'] loop
    foreach privilege_name in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if not has_table_privilege(role_name, 'auth.session_facility_selection', privilege_name) then
        raise exception '% lacks % on auth.session_facility_selection', role_name, privilege_name;
      end if;
    end loop;
    foreach privilege_name in array array['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(role_name, 'auth.session_facility_selection', privilege_name) then
        raise exception '% has % on auth.session_facility_selection', role_name, privilege_name;
      end if;
    end loop;
  end loop;
  -- The table's ACL names its owner and the Identity runtime (SELECT, INSERT,
  -- UPDATE, not grantable) and no one else, PUBLIC included.
  if exists (select 1 from pg_class relation, aclexplode(relation.relacl) privilege
              where relation.oid = 'auth.session_facility_selection'::regclass
                and privilege.grantee <> relation.relowner
                and not (privilege.grantee = 'hid_identity_runtime'::regrole
                         and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE') and not privilege.is_grantable))
     or (select count(*) from pg_class relation, aclexplode(relation.relacl) privilege
          where relation.oid = 'auth.session_facility_selection'::regclass
            and privilege.grantee = 'hid_identity_runtime'::regrole) <> 3 then
    raise exception 'the ACL of auth.session_facility_selection is not 0129''s: %',
      (select relation.relacl from pg_class relation where relation.oid = 'auth.session_facility_selection'::regclass);
  end if;
  -- Every other platform role: only the Identity runtime, its members and the
  -- table owner hold a privilege. A list of privileges is true when any of
  -- them is held.
  for role_name in
    select role_row.rolname from pg_roles role_row
     where role_row.rolname like 'hid\_%' and not role_row.rolsuper
       and not pg_has_role(role_row.oid, 'hid_identity_runtime', 'USAGE')
       and not pg_has_role(role_row.oid, (select relation.relowner from pg_class relation
         where relation.oid = 'auth.session_facility_selection'::regclass), 'USAGE')
  loop
    if has_table_privilege(role_name, 'auth.session_facility_selection',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception '% has a privilege on auth.session_facility_selection', role_name;
    end if;
  end loop;
  if not exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime')
     or has_table_privilege('hid_schema_test_runtime', 'auth.session_facility_selection',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
    raise exception 'hid_schema_test_runtime must exist and hold no privilege on auth.session_facility_selection';
  end if;
  if has_function_privilege('public', 'auth.guard_session_facility_selection_change()', 'EXECUTE')
     or has_function_privilege('hid_identity_api_runtime', 'auth.guard_session_facility_selection_change()', 'EXECUTE') then
    raise exception 'PUBLIC or the Identity API can execute the selection guard directly';
  end if;
end $$;

-- 3. As the Identity API runtime.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
       set_config('app.correlation_id', 'facility-selection-0129-suite-0001', true);

do $$
declare
  recorded uuid;
  rejected record;
begin
  -- The API's write records A1's choice of F2 (A's nurse membership there)...
  recorded := pg_temp.select_facility('f1296000-0000-4000-8000-0000000000a1', 'f1292000-0000-4000-8000-00000000000a',
    'f1291000-0000-4000-8000-0000000000f2', 'f1295000-0000-4000-8000-0000000000a2');
  if recorded is distinct from 'f1296000-0000-4000-8000-0000000000a1' then
    raise exception 'the runtime could not record a valid choice (answered %)', recorded;
  end if;
  -- ... and a later choice replaces it.
  recorded := pg_temp.select_facility('f1296000-0000-4000-8000-0000000000a1', 'f1292000-0000-4000-8000-00000000000a',
    'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1');
  if (select selection.facility_id::text || '/' || selection.membership_id::text || '/' || selection.row_version::text
        from auth.session_facility_selection selection
       where selection.family_id = 'f1296000-0000-4000-8000-0000000000a1')
     is distinct from 'f1291000-0000-4000-8000-0000000000f1/f1295000-0000-4000-8000-0000000000a1/2' then
    raise exception 'a new choice did not replace the sign-in''s previous one';
  end if;
  -- The write finds no live session for a signed-out, a lapsed or a patient
  -- sign-in, nor for another account's session: nothing is written (the
  -- count is read in its own statement below).
  if pg_temp.select_facility('f1296000-0000-4000-8000-0000000000a8', 'f1292000-0000-4000-8000-00000000000a',
       'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1') is not null
     or pg_temp.select_facility('f1296000-0000-4000-8000-0000000000a9', 'f1292000-0000-4000-8000-00000000000a',
       'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1') is not null
     or pg_temp.select_facility('f1296000-0000-4000-8000-0000000000ac', 'f1292000-0000-4000-8000-00000000000a',
       'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1') is not null
     or pg_temp.select_facility('f1296000-0000-4000-8000-0000000000b1', 'f1292000-0000-4000-8000-00000000000a',
       'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1') is not null then
    raise exception 'the API''s write found a live session where there is none';
  end if;
  if (select count(*) from auth.session_facility_selection) <> 1 then
    raise exception 'the API''s write recorded a choice for a session that is not a live staff session of the account';
  end if;

  -- The guard refuses every row that is not an active membership of a live
  -- staff sign-in of an active account, written directly (as a bug or a
  -- forged request would write it).
  for rejected in select * from (values
    -- Another account named on A's sign-in, with that account's own membership.
    ('wrong account', 'f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000b',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000b1'),
    ('an ended membership', 'f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f3', 'f1295000-0000-4000-8000-0000000000a3'),
    ('a membership held for migration', 'f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f3', 'f1295000-0000-4000-8000-0000000000a6'),
    ('a suspended facility', 'f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f4', 'f1295000-0000-4000-8000-0000000000a4'),
    ('a deactivated organisation', 'f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f5', 'f1295000-0000-4000-8000-0000000000a5'),
    -- A's sign-in with B's membership (and facility).
    ('another account''s membership', 'f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000b1'),
    -- A's membership at F1 named for F2.
    ('a membership of another facility', 'f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f2', 'f1295000-0000-4000-8000-0000000000a1'),
    -- B's sign-in claimed by A with A's own membership.
    ('another account''s sign-in', 'f1296000-0000-4000-8000-0000000000b1', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    -- A's own patient sign-in: only the kind is wrong.
    ('a patient sign-in', 'f1296000-0000-4000-8000-0000000000ac', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    ('another patient''s sign-in', 'f1296000-0000-4000-8000-0000000000e0', 'f1292000-0000-4000-8000-0000000000e0',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    ('a signed-out sign-in', 'f1296000-0000-4000-8000-0000000000a8', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    ('a lapsed sign-in', 'f1296000-0000-4000-8000-0000000000a9', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    ('an inactive staff record', 'f1296000-0000-4000-8000-0000000000c1', 'f1292000-0000-4000-8000-00000000000c',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000c1'),
    ('an unverified staff record', 'f1296000-0000-4000-8000-0000000000d1', 'f1292000-0000-4000-8000-00000000000d',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000d1'),
    ('a locked account', 'f1296000-0000-4000-8000-0000000000e1', 'f1292000-0000-4000-8000-00000000000e',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000e1'),
    ('a disabled account', 'f1296000-0000-4000-8000-0000000000d2', 'f1292000-0000-4000-8000-0000000000d1',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000d2'),
    ('a sign-in at an older token version', 'f1296000-0000-4000-8000-0000000000b3', 'f1292000-0000-4000-8000-0000000000b2',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000b2'),
    ('a session that is not its family''s first', 'f1296000-0000-4000-8000-0000000000a7', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    ('no session at all', 'f1296000-0000-4000-8000-0000000000ff', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1')
  ) as candidate(label, family_id, account_id, facility_id, membership_id) loop
    begin
      insert into auth.session_facility_selection (family_id, account_id, facility_id, membership_id)
      values (rejected.family_id::uuid, rejected.account_id::uuid, rejected.facility_id::uuid, rejected.membership_id::uuid);
      raise exception 'the guard admitted a choice with %', rejected.label;
    exception when check_violation then
      if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
    end;
  end loop;

  -- Verification status is compared trimmed and case-insensitively, as the
  -- staff context compares it (B's is ' Verified ').
  if pg_temp.select_facility('f1296000-0000-4000-8000-0000000000b1', 'f1292000-0000-4000-8000-00000000000b',
       'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000b1') is null then
    raise exception 'a verified staff member written '' Verified '' could not choose';
  end if;
  -- T's sign-in at T's current token version may choose.
  if pg_temp.select_facility('f1296000-0000-4000-8000-0000000000b4', 'f1292000-0000-4000-8000-0000000000b2',
       'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000b2') is null then
    raise exception 'a sign-in at the account''s token version could not choose';
  end if;
  -- Two roles at one facility: either membership there is admitted (the API
  -- compares the stored choice by facility id only, as the guard compares
  -- X-Facility-ID).
  -- (Each write is its own statement: a query does not see what a function
  -- it calls writes.)
  recorded := pg_temp.select_facility('f1296000-0000-4000-8000-0000000000a7', 'f1292000-0000-4000-8000-00000000000a',
    'f1291000-0000-4000-8000-0000000000f2', 'f1295000-0000-4000-8000-0000000000a7');
  if recorded is distinct from 'f1296000-0000-4000-8000-0000000000a2'
     or (select selection.membership_id from auth.session_facility_selection selection
          where selection.family_id = 'f1296000-0000-4000-8000-0000000000a2')
       is distinct from 'f1295000-0000-4000-8000-0000000000a7' then
    raise exception 'two roles at one facility: the doctor membership was refused, or the choice is not keyed by the family';
  end if;
  recorded := pg_temp.select_facility('f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a',
    'f1291000-0000-4000-8000-0000000000f2', 'f1295000-0000-4000-8000-0000000000a2');
  if recorded is distinct from 'f1296000-0000-4000-8000-0000000000a2'
     or (select selection.membership_id::text || '/' || selection.row_version::text from auth.session_facility_selection selection
          where selection.family_id = 'f1296000-0000-4000-8000-0000000000a2')
       is distinct from 'f1295000-0000-4000-8000-0000000000a2/2' then
    raise exception 'two roles at one facility: a membership there was refused, or the choice is not keyed by the family';
  end if;
  -- A choice made through the non-first session a7 belongs to its family A2.
  if pg_temp.selected_facility('f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a')
       is distinct from 'f1291000-0000-4000-8000-0000000000f2'
     or pg_temp.selected_facility('f1296000-0000-4000-8000-0000000000a7', 'f1292000-0000-4000-8000-00000000000a')
       is distinct from 'f1291000-0000-4000-8000-0000000000f2' then
    raise exception 'a family''s sessions do not read the family''s choice';
  end if;

  -- An update is checked as an insert is, and cannot move the row to another
  -- sign-in or account.
  begin
    update auth.session_facility_selection
       set facility_id = 'f1291000-0000-4000-8000-0000000000f3', membership_id = 'f1295000-0000-4000-8000-0000000000a3',
           row_version = row_version + 1
     where family_id = 'f1296000-0000-4000-8000-0000000000a1';
    raise exception 'an update to an ended membership was accepted';
  exception when check_violation then
    if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
  end;
  -- A4 is a live sign-in of A without a choice, so only the move is wrong.
  begin
    update auth.session_facility_selection set family_id = 'f1296000-0000-4000-8000-0000000000a4'
     where family_id = 'f1296000-0000-4000-8000-0000000000a1';
    raise exception 'a choice was moved to another sign-in';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'SESSION_FACILITY_SELECTION_IMMUTABLE' then raise; end if;
  end;
  begin
    update auth.session_facility_selection set account_id = 'f1292000-0000-4000-8000-00000000000b'
     where family_id = 'f1296000-0000-4000-8000-0000000000a1';
    raise exception 'a choice was moved to another account';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'SESSION_FACILITY_SELECTION_IMMUTABLE' then raise; end if;
  end;

  -- The runtime cannot delete or truncate a choice.
  begin
    delete from auth.session_facility_selection where family_id = 'f1296000-0000-4000-8000-0000000000a1';
    raise exception 'the runtime deleted a choice';
  exception when insufficient_privilege then null;
  end;
  begin
    truncate auth.session_facility_selection;
    raise exception 'the runtime truncated the choices';
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from auth.session_facility_selection) <> 4 then
    raise exception 'section 3 should leave four choices (A1, A2, B1, T2), found %',
      (select count(*) from auth.session_facility_selection);
  end if;
end $$;
reset role;

-- 4. Nobody deletes a choice, the owner included: sign-out and revocation
-- leave it in place.
do $$ begin
  delete from auth.session_facility_selection where family_id = 'f1296000-0000-4000-8000-0000000000a1';
  raise exception 'a choice was deleted';
exception when object_not_in_prerequisite_state then
  if sqlerrm <> 'SESSION_FACILITY_SELECTION_IMMUTABLE' then raise; end if;
end $$;

-- 5. Rotation keeps the choice: the API reads it through the family of the
-- session presented, so the rotated session finds it and A's other sign-in
-- does not. A rotated sign-in can still change it. Once the sign-in is
-- signed out, no session of it reads it again, the row stays, and nobody can
-- change it.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
values ('f1296000-0000-4000-8000-0000000000a3', 'f1292000-0000-4000-8000-00000000000a',
  'f1296000-0000-4000-8000-0000000000a1', md5('f129-a3') || md5('f129-a3-refresh'), gen_random_uuid(), 1, 'password',
  now(), now() + interval '8 hours', now() + interval '24 hours', 'staff');
update auth.sessions set revoked_at = clock_timestamp(), revocation_reason = 'rotated',
    replaced_by_session_id = 'f1296000-0000-4000-8000-0000000000a3', row_version = row_version + 1
 where id = 'f1296000-0000-4000-8000-0000000000a1';

set local role hid_identity_api_runtime;
do $$
declare
  reads text[];
begin
  select array_agg(presented_session.label || '=' || coalesce(pg_temp.selected_facility(presented_session.presented::uuid,
      'f1292000-0000-4000-8000-00000000000a')::text, 'none') order by presented_session.label)
    into reads
    from (values ('rotated', 'f1296000-0000-4000-8000-0000000000a3'),
                 ('replaced', 'f1296000-0000-4000-8000-0000000000a1'),
                 ('patient sign-in', 'f1296000-0000-4000-8000-0000000000ac')) as presented_session(label, presented);
  if reads is distinct from array['patient sign-in=none', 'replaced=none', 'rotated=f1291000-0000-4000-8000-0000000000f1'] then
    raise exception 'the choice did not follow the rotated session only: %', reads;
  end if;
  -- The rotated sign-in changes its choice through its new session.
  if pg_temp.select_facility('f1296000-0000-4000-8000-0000000000a3', 'f1292000-0000-4000-8000-00000000000a',
       'f1291000-0000-4000-8000-0000000000f2', 'f1295000-0000-4000-8000-0000000000a2')
       is distinct from 'f1296000-0000-4000-8000-0000000000a1' then
    raise exception 'a rotated sign-in could not change its choice';
  end if;
  if pg_temp.selected_facility('f1296000-0000-4000-8000-0000000000a3', 'f1292000-0000-4000-8000-00000000000a')
       is distinct from 'f1291000-0000-4000-8000-0000000000f2' then
    raise exception 'the rotated sign-in does not read its new choice';
  end if;
end $$;
reset role;

-- Signed out: every session of the family revoked.
update auth.sessions set revoked_at = clock_timestamp(), revocation_reason = 'logout', row_version = row_version + 1
 where family_id = 'f1296000-0000-4000-8000-0000000000a1' and revoked_at is null;
set local role hid_identity_api_runtime;
do $$ begin
  if pg_temp.selected_facility('f1296000-0000-4000-8000-0000000000a3', 'f1292000-0000-4000-8000-00000000000a') is not null
     or pg_temp.selected_facility('f1296000-0000-4000-8000-0000000000a1', 'f1292000-0000-4000-8000-00000000000a') is not null then
    raise exception 'a signed-out sign-in still reads its choice';
  end if;
  if pg_temp.select_facility('f1296000-0000-4000-8000-0000000000a3', 'f1292000-0000-4000-8000-00000000000a',
       'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1') is not null then
    raise exception 'the API''s write found a signed-out sign-in';
  end if;
  begin
    update auth.session_facility_selection set facility_id = 'f1291000-0000-4000-8000-0000000000f1',
        membership_id = 'f1295000-0000-4000-8000-0000000000a1', row_version = row_version + 1
     where family_id = 'f1296000-0000-4000-8000-0000000000a1';
    raise exception 'a signed-out sign-in''s choice was changed';
  exception when check_violation then
    if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from auth.session_facility_selection
                  where family_id = 'f1296000-0000-4000-8000-0000000000a1'
                    and facility_id = 'f1291000-0000-4000-8000-0000000000f2') then
    raise exception 'sign-out removed or changed the choice';
  end if;
  -- Not the owner either.
  update auth.session_facility_selection set facility_id = 'f1291000-0000-4000-8000-0000000000f1',
      membership_id = 'f1295000-0000-4000-8000-0000000000a1', row_version = row_version + 1
   where family_id = 'f1296000-0000-4000-8000-0000000000a1';
  raise exception 'the owner changed a signed-out sign-in''s choice';
exception when check_violation then
  if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
end $$;

-- 6. Workforce and account changes with a row present. A2's sign-in chooses
-- F6 (a8); B1 keeps F1 (b1); T2 keeps F1 (t's membership).
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
       set_config('app.correlation_id', 'facility-selection-0129-suite-0006', true);
do $$ begin
  if pg_temp.select_facility('f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a',
       'f1291000-0000-4000-8000-0000000000f6', 'f1295000-0000-4000-8000-0000000000a8') is null then
    raise exception 'A2 could not choose F6';
  end if;
end $$;
-- A platform administrator suspends F6 and disables T, through the Identity
-- API's own commands.
select pg_temp.as_platform_admin('facility-selection-0129-suite-0006a');
select facility_id, lifecycle_status from identity.admin_transition_facility('f1291000-0000-4000-8000-0000000000f6',
  (select facility.row_version from identity.facilities facility where facility.id = 'f1291000-0000-4000-8000-0000000000f6'),
  'suspended', 'Suspended for the facility selection suite', 'f129-suite-suspend-f6-0000001', repeat('c', 64));
select account_id, account_status from auth.admin_transition_account('f1292000-0000-4000-8000-0000000000b2',
  (select account_row.row_version from auth.accounts account_row where account_row.id = 'f1292000-0000-4000-8000-0000000000b2'),
  'disabled', 'Disabled for the facility selection suite', 'f129-suite-disable-t-00000001', repeat('d', 64));
reset role;
-- B's membership at F1 is ended (the UPDATE end_facility_staff_membership
-- makes) and A's a7 at F2 is held (as the migration tooling holds one; no
-- command of the service sets a hold).
update identity.staff_facility_memberships membership
   set active = false, updated_at = clock_timestamp(), row_version = membership.row_version + 1
 where membership.id = 'f1295000-0000-4000-8000-0000000000b1';
update identity.staff_facility_memberships membership
   set migration_hold_reason = 'Synthetic hold for the facility selection suite', updated_at = clock_timestamp(),
       row_version = membership.row_version + 1
 where membership.id = 'f1295000-0000-4000-8000-0000000000a7';
do $$
begin
  if (select facility.active::text || '/' || facility.lifecycle_status from identity.facilities facility
       where facility.id = 'f1291000-0000-4000-8000-0000000000f6') is distinct from 'false/suspended'
     or (select account_row.status from auth.accounts account_row
          where account_row.id = 'f1292000-0000-4000-8000-0000000000b2') is distinct from 'disabled'
     or exists (select 1 from auth.sessions session_row
                 where session_row.account_id = 'f1292000-0000-4000-8000-0000000000b2' and session_row.revoked_at is null) then
    raise exception 'the platform commands did not suspend F6 or disable T and end T''s sign-ins';
  end if;
  -- The rows are kept as they were.
  if (select array_agg(selection.family_id::text || '=' || selection.facility_id::text order by selection.family_id)
        from auth.session_facility_selection selection)
     is distinct from array['f1296000-0000-4000-8000-0000000000a1=f1291000-0000-4000-8000-0000000000f2',
       'f1296000-0000-4000-8000-0000000000a2=f1291000-0000-4000-8000-0000000000f6',
       'f1296000-0000-4000-8000-0000000000b1=f1291000-0000-4000-8000-0000000000f1',
       'f1296000-0000-4000-8000-0000000000b4=f1291000-0000-4000-8000-0000000000f1'] then
    raise exception 'a workforce or account change removed or changed a choice: %',
      (select array_agg(selection.family_id::text || '=' || selection.facility_id::text order by selection.family_id)
         from auth.session_facility_selection selection);
  end if;
end $$;
-- The same choices are now refused.
set local role hid_identity_api_runtime;
do $$
declare
  refused record;
begin
  for refused in select * from (values
    ('the suspended F6', 'f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f6', 'f1295000-0000-4000-8000-0000000000a8'),
    ('the held a7', 'f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a',
     'f1291000-0000-4000-8000-0000000000f2', 'f1295000-0000-4000-8000-0000000000a7'),
    ('B''s ended membership', 'f1296000-0000-4000-8000-0000000000b1', 'f1292000-0000-4000-8000-00000000000b',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000b1'),
    ('the disabled T', 'f1296000-0000-4000-8000-0000000000b4', 'f1292000-0000-4000-8000-0000000000b2',
     'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000b2')
  ) as candidate(label, family_id, account_id, facility_id, membership_id) loop
    begin
      update auth.session_facility_selection
         set facility_id = refused.facility_id::uuid, membership_id = refused.membership_id::uuid,
             selected_at = clock_timestamp(), row_version = row_version + 1
       where family_id = refused.family_id::uuid and account_id = refused.account_id::uuid;
      raise exception 'the guard admitted % again', refused.label;
    exception when check_violation then
      if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
    end;
  end loop;
  -- A2 can still choose an active membership.
  if pg_temp.select_facility('f1296000-0000-4000-8000-0000000000a2', 'f1292000-0000-4000-8000-00000000000a',
       'f1291000-0000-4000-8000-0000000000f2', 'f1295000-0000-4000-8000-0000000000a2') is null then
    raise exception 'A2 could not choose its active membership at F2';
  end if;
end $$;
reset role;
-- The referenced sign-in and membership cannot be deleted, and a referenced
-- membership cannot be moved to another facility.
do $$
declare
  attempt record;
  failed_constraint text;
  failed_state text;
begin
  for attempt in select * from (values
    ('the sign-in', 'delete from auth.sessions where id = ''f1296000-0000-4000-8000-0000000000b1''',
     '23503', 'session_facility_selection_family_id_fkey'),
    ('the membership', 'delete from identity.staff_facility_memberships where id = ''f1295000-0000-4000-8000-0000000000b1''',
     '23503', 'session_facility_selection_membership_id_facility_id_accou_fkey'),
    ('the membership''s facility', 'update identity.staff_facility_memberships set facility_id = ''f1291000-0000-4000-8000-0000000000f3'' where id = ''f1295000-0000-4000-8000-0000000000b1''',
     '23503', 'session_facility_selection_membership_id_facility_id_accou_fkey')
  ) as candidate(label, statement, expected_state, expected_constraint) loop
    failed_state := null;
    failed_constraint := null;
    begin
      -- B1 and b1 have no other reference, so 0129's key answers. (An
      -- account or a facility always has others, which answer first; their
      -- keys' ON DELETE RESTRICT is checked in section 1.)
      execute attempt.statement;
    exception when others then
      get stacked diagnostics failed_state = returned_sqlstate, failed_constraint = constraint_name;
    end;
    if failed_state is distinct from attempt.expected_state or failed_constraint is distinct from attempt.expected_constraint then
      raise exception 'changing % with a choice referring to it answered % %, expected % %', attempt.label,
        coalesce(failed_state, 'success'), coalesce(failed_constraint, '-'), attempt.expected_state, attempt.expected_constraint;
    end if;
  end loop;
end $$;

-- 7. The seals. No membership crosses between real, demo and QA (0098,
-- 0123), so a choice cannot cross either; the demo and QA staff choose
-- their own facilities.
do $$
declare
  crossing record;
begin
  for crossing in select * from (values
    ('real staff at the QA facility', 'f1292000-0000-4000-8000-00000000000a', 'f1294000-0000-4000-8000-00000000000a',
     'f1290000-0000-4000-8000-0000000000a3', 'f1291000-0000-4000-8000-0000000000f7', 'SEALED_QA_MEMBERSHIP_REFUSED'),
    ('QA staff at a real facility', 'f1292000-0000-4000-8000-0000000000aa', 'f1294000-0000-4000-8000-0000000000aa',
     'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f1', 'SEALED_QA_MEMBERSHIP_REFUSED'),
    ('real staff at the demo facility', 'f1292000-0000-4000-8000-00000000000a', 'f1294000-0000-4000-8000-00000000000a',
     'f1290000-0000-4000-8000-0000000000a4', 'f1291000-0000-4000-8000-0000000000f8', 'SEALED_DEMO_MEMBERSHIP_REFUSED'),
    ('demo staff at a real facility', 'f1292000-0000-4000-8000-0000000000dd', 'f1294000-0000-4000-8000-0000000000dd',
     'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f1', 'SEALED_DEMO_MEMBERSHIP_REFUSED')
  ) as candidate(label, account_id, staff_id, organization_id, facility_id, expected) loop
    begin
      insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
          membership_role, app_role, is_primary, active)
      values (gen_random_uuid(), crossing.staff_id::uuid, crossing.account_id::uuid, crossing.organization_id::uuid,
              crossing.facility_id::uuid, 'nurse', 'nurse', false, true);
      raise exception 'a membership crossed the seal: %', crossing.label;
    exception when insufficient_privilege then
      if sqlerrm <> crossing.expected then raise; end if;
    end;
  end loop;
end $$;
set local role hid_identity_api_runtime;
do $$
declare
  crossing record;
begin
  for crossing in select * from (values
    ('A''s sign-in at the QA facility with the QA membership', 'f1296000-0000-4000-8000-0000000000a2',
     'f1292000-0000-4000-8000-00000000000a', 'f1291000-0000-4000-8000-0000000000f7', 'f1295000-0000-4000-8000-0000000000aa'),
    ('A''s sign-in at the demo facility with the demo membership', 'f1296000-0000-4000-8000-0000000000a2',
     'f1292000-0000-4000-8000-00000000000a', 'f1291000-0000-4000-8000-0000000000f8', 'f1295000-0000-4000-8000-0000000000dd'),
    ('the QA sign-in at a real facility with A''s membership', 'f1296000-0000-4000-8000-0000000000aa',
     'f1292000-0000-4000-8000-0000000000aa', 'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    ('the demo sign-in at the QA facility with the QA membership', 'f1296000-0000-4000-8000-0000000000dd',
     'f1292000-0000-4000-8000-0000000000dd', 'f1291000-0000-4000-8000-0000000000f7', 'f1295000-0000-4000-8000-0000000000aa')
  ) as candidate(label, family_id, account_id, facility_id, membership_id) loop
    begin
      insert into auth.session_facility_selection (family_id, account_id, facility_id, membership_id)
      values (crossing.family_id::uuid, crossing.account_id::uuid, crossing.facility_id::uuid, crossing.membership_id::uuid)
      on conflict (family_id) do update
         set facility_id = excluded.facility_id, membership_id = excluded.membership_id,
             selected_at = clock_timestamp(), row_version = auth.session_facility_selection.row_version + 1;
      raise exception 'a choice crossed the seal: %', crossing.label;
    exception when check_violation then
      if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
    end;
  end loop;
  if pg_temp.select_facility('f1296000-0000-4000-8000-0000000000aa', 'f1292000-0000-4000-8000-0000000000aa',
       'f1291000-0000-4000-8000-0000000000f7', 'f1295000-0000-4000-8000-0000000000aa') is null
     or pg_temp.select_facility('f1296000-0000-4000-8000-0000000000dd', 'f1292000-0000-4000-8000-0000000000dd',
       'f1291000-0000-4000-8000-0000000000f8', 'f1295000-0000-4000-8000-0000000000dd') is null then
    raise exception 'a QA or demo staff member could not choose their own facility';
  end if;
end $$;
reset role;

-- 8. The sign-in, as the family's first session (Rahman, hid-system#258).
-- O: a verified staff login whose only membership (o1 at F1) has ended, so
-- on outreach. it signs in account-only (Q88-2); its session O1 is a staff
-- session (staging's only staff kind). Forged families (the API never
-- writes them; rotation copies the kind and the account): K, first session
-- K1 A's patient session (rotated), with K2 A's live staff session; L, first
-- session L1 A's staff session (rotated), whose only live session L2 is A's
-- patient session; M, first session M1 B's staff session (rotated), with M2
-- A's live staff session; N, first session N1 A's staff session (rotated),
-- whose only live session N2 is B's. R: A's sign-in rotated twice, first
-- session R1 and R2 revoked as rotated, R3 live, with no choice yet.
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm, token_version, disabled_until) values
  ('f1292000-0000-4000-8000-0000000000c0', 'synthetic:selection-0129:o', 'o@selection-0129.invalid', 'active', 'synthetic-hash',
   'argon2id', 1, null);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active) values
  ('f1294000-0000-4000-8000-0000000000c0', 'f1292000-0000-4000-8000-0000000000c0', 'Staff O Selection',
   'o@selection-0129.invalid', 'verified', 'nurse', true);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, migration_hold_reason) values
  ('f1295000-0000-4000-8000-0000000000c0', 'f1294000-0000-4000-8000-0000000000c0', 'f1292000-0000-4000-8000-0000000000c0',
   'f1290000-0000-4000-8000-0000000000a1', 'f1291000-0000-4000-8000-0000000000f1', 'nurse', 'nurse', true, false, null);
-- Live sessions first (the revoked ones name them as replaced_by_session_id).
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select fixture.session_id::uuid, fixture.account_id::uuid, fixture.family_id::uuid,
  md5(fixture.session_id) || md5(fixture.session_id || 'refresh'), gen_random_uuid(), 1, 'password',
  now(), now() + interval '8 hours', now() + interval '24 hours', fixture.kind, fixture.patient_id::uuid
from (values
  ('f1296000-0000-4000-8000-000000000800', 'f1292000-0000-4000-8000-0000000000c0', 'f1296000-0000-4000-8000-000000000800', 'staff', null),
  ('f1296000-0000-4000-8000-000000000802', 'f1292000-0000-4000-8000-00000000000a', 'f1296000-0000-4000-8000-000000000801', 'staff', null),
  ('f1296000-0000-4000-8000-000000000804', 'f1292000-0000-4000-8000-00000000000a', 'f1296000-0000-4000-8000-000000000803', 'patient',
   'f1293000-0000-4000-8000-00000000000a'),
  ('f1296000-0000-4000-8000-000000000806', 'f1292000-0000-4000-8000-00000000000a', 'f1296000-0000-4000-8000-000000000805', 'staff', null),
  ('f1296000-0000-4000-8000-000000000811', 'f1292000-0000-4000-8000-00000000000b', 'f1296000-0000-4000-8000-000000000810', 'staff', null),
  ('f1296000-0000-4000-8000-000000000809', 'f1292000-0000-4000-8000-00000000000a', 'f1296000-0000-4000-8000-000000000807', 'staff', null)
) as fixture(session_id, account_id, family_id, kind, patient_id);
-- Then the revoked ones, each family's first session (R2, R's middle one, last).
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, revoked_at, revocation_reason,
    replaced_by_session_id, session_kind, patient_id)
select fixture.session_id::uuid, fixture.account_id::uuid, fixture.family_id::uuid,
  md5(fixture.session_id) || md5(fixture.session_id || 'refresh'), gen_random_uuid(), 1, 'password',
  now() - interval '20 minutes', now() + interval '8 hours', now() + interval '24 hours', now() - interval '5 minutes',
  'rotated', fixture.replaced_by::uuid, fixture.kind, fixture.patient_id::uuid
from (values
  ('f1296000-0000-4000-8000-000000000801', 'f1292000-0000-4000-8000-00000000000a', 'f1296000-0000-4000-8000-000000000801',
   'f1296000-0000-4000-8000-000000000802', 'patient', 'f1293000-0000-4000-8000-00000000000a'),
  ('f1296000-0000-4000-8000-000000000803', 'f1292000-0000-4000-8000-00000000000a', 'f1296000-0000-4000-8000-000000000803',
   'f1296000-0000-4000-8000-000000000804', 'staff', null),
  ('f1296000-0000-4000-8000-000000000805', 'f1292000-0000-4000-8000-00000000000b', 'f1296000-0000-4000-8000-000000000805',
   'f1296000-0000-4000-8000-000000000806', 'staff', null),
  ('f1296000-0000-4000-8000-000000000810', 'f1292000-0000-4000-8000-00000000000a', 'f1296000-0000-4000-8000-000000000810',
   'f1296000-0000-4000-8000-000000000811', 'staff', null),
  ('f1296000-0000-4000-8000-000000000808', 'f1292000-0000-4000-8000-00000000000a', 'f1296000-0000-4000-8000-000000000807',
   'f1296000-0000-4000-8000-000000000809', 'staff', null),
  ('f1296000-0000-4000-8000-000000000807', 'f1292000-0000-4000-8000-00000000000a', 'f1296000-0000-4000-8000-000000000807',
   'f1296000-0000-4000-8000-000000000808', 'staff', null)
) as fixture(session_id, account_id, family_id, replaced_by, kind, patient_id);

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
       set_config('app.correlation_id', 'facility-selection-0129-suite-0008', true);
do $$
declare
  rejected record;
  recorded uuid;
begin
  -- (1) The first session must be a staff session of the account. Each row
  -- below has a live staff session of A at A's current token version and A's
  -- active membership a1 at F1, so only the first session's kind or account
  -- is wrong (K, M); in L the only live session is a patient one, and in N
  -- another account's. O1 is a live staff session of O, an account with no
  -- active membership.
  for rejected in select * from (values
    ('a family whose first session is a patient session (K1, live staff K2)', 'f1296000-0000-4000-8000-000000000801',
     'f1292000-0000-4000-8000-00000000000a', 'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    ('a family whose first session is another account''s (M1 B''s, live staff M2 A''s)', 'f1296000-0000-4000-8000-000000000805',
     'f1292000-0000-4000-8000-00000000000a', 'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    ('a family whose only live session is a patient session (L1, live patient L2)', 'f1296000-0000-4000-8000-000000000803',
     'f1292000-0000-4000-8000-00000000000a', 'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    ('a family whose only live session is another account''s (N1 A''s, live staff N2 B''s)', 'f1296000-0000-4000-8000-000000000810',
     'f1292000-0000-4000-8000-00000000000a', 'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    ('an account-only outreach session with its own ended membership', 'f1296000-0000-4000-8000-000000000800',
     'f1292000-0000-4000-8000-0000000000c0', 'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000c0'),
    ('an account-only outreach session with another account''s membership', 'f1296000-0000-4000-8000-000000000800',
     'f1292000-0000-4000-8000-0000000000c0', 'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1')
  ) as candidate(label, family_id, account_id, facility_id, membership_id) loop
    begin
      insert into auth.session_facility_selection (family_id, account_id, facility_id, membership_id)
      values (rejected.family_id::uuid, rejected.account_id::uuid, rejected.facility_id::uuid, rejected.membership_id::uuid);
      raise exception 'the guard admitted a choice with %', rejected.label;
    exception when check_violation then
      if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
    end;
  end loop;
  -- The same through the API's write: it finds K2, M2 and O1 live staff
  -- sessions of their accounts and locks them, and the guard refuses.
  for rejected in select * from (values
    ('the patient-first family K through its live staff session K2', 'f1296000-0000-4000-8000-000000000802',
     'f1292000-0000-4000-8000-00000000000a', 'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    ('the other-account-first family M through A''s live staff session M2', 'f1296000-0000-4000-8000-000000000806',
     'f1292000-0000-4000-8000-00000000000a', 'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1'),
    ('the account-only outreach session O1 with its own ended membership', 'f1296000-0000-4000-8000-000000000800',
     'f1292000-0000-4000-8000-0000000000c0', 'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000c0')
  ) as candidate(label, presented, account_id, facility_id, membership_id) loop
    begin
      recorded := pg_temp.select_facility(rejected.presented::uuid, rejected.account_id::uuid, rejected.facility_id::uuid,
        rejected.membership_id::uuid);
      raise exception 'the API''s write recorded a choice for % (answered %)', rejected.label, recorded;
    exception when check_violation then
      if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
    end;
  end loop;
  -- L2 is a patient session, so the API's write finds no live staff session.
  if pg_temp.select_facility('f1296000-0000-4000-8000-000000000804', 'f1292000-0000-4000-8000-00000000000a',
       'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1') is not null then
    raise exception 'the API''s write found a live staff session in a family whose live session is a patient one';
  end if;

  -- (2) R's first choice, made through its live session R3, is admitted. It
  -- is an INSERT (no row yet), keyed to the revoked first session R1.
  if exists (select 1 from auth.session_facility_selection where family_id = 'f1296000-0000-4000-8000-000000000807') then
    raise exception 'R already has a choice';
  end if;
  begin
    recorded := pg_temp.select_facility('f1296000-0000-4000-8000-000000000809', 'f1292000-0000-4000-8000-00000000000a',
      'f1291000-0000-4000-8000-0000000000f2', 'f1295000-0000-4000-8000-0000000000a2');
  exception when check_violation then
    raise exception 'the guard refused the first choice of a rotated sign-in whose first session R1 is revoked, made through its live session R3: %',
      sqlerrm;
  end;
  if recorded is distinct from 'f1296000-0000-4000-8000-000000000807' then
    raise exception 'a rotated sign-in whose first session is revoked could not make its first choice (answered %)', recorded;
  end if;
end $$;
reset role;
do $$
declare
  reads text[];
begin
  if (select selection.facility_id::text || '/' || selection.membership_id::text || '/' || selection.row_version::text
        from auth.session_facility_selection selection
       where selection.family_id = 'f1296000-0000-4000-8000-000000000807'
         and selection.account_id = 'f1292000-0000-4000-8000-00000000000a')
     is distinct from 'f1291000-0000-4000-8000-0000000000f2/f1295000-0000-4000-8000-0000000000a2/1' then
    raise exception 'R''s first choice was not stored as one new row keyed to R1';
  end if;
  -- The key pins the revoked first session; the live session is a later one.
  if (select session_row.revoked_at is not null and session_row.revocation_reason = 'rotated'
        from auth.sessions session_row where session_row.id = 'f1296000-0000-4000-8000-000000000807') is not true
     or (select session_row.revoked_at is null and session_row.family_id = 'f1296000-0000-4000-8000-000000000807'
        from auth.sessions session_row where session_row.id = 'f1296000-0000-4000-8000-000000000809') is not true then
    raise exception 'R1 must be revoked as rotated and R3 a live session of its family';
  end if;
  select array_agg(presented_session.label || '=' || coalesce(pg_temp.selected_facility(presented_session.presented::uuid,
      'f1292000-0000-4000-8000-00000000000a')::text, 'none') order by presented_session.label)
    into reads
    from (values ('R1', 'f1296000-0000-4000-8000-000000000807'), ('R2', 'f1296000-0000-4000-8000-000000000808'),
                 ('R3', 'f1296000-0000-4000-8000-000000000809')) as presented_session(label, presented);
  if reads is distinct from array['R1=none', 'R2=none', 'R3=f1291000-0000-4000-8000-0000000000f2'] then
    raise exception 'R''s choice must be read through its live session only: %', reads;
  end if;
  -- Nothing was stored for K, L, M, N or O.
  if exists (select 1 from auth.session_facility_selection selection
              where selection.family_id in ('f1296000-0000-4000-8000-000000000800', 'f1296000-0000-4000-8000-000000000801',
                'f1296000-0000-4000-8000-000000000803', 'f1296000-0000-4000-8000-000000000805',
                'f1296000-0000-4000-8000-000000000810')
                 or selection.account_id = 'f1292000-0000-4000-8000-0000000000c0') then
    raise exception 'a refused sign-in has a stored choice';
  end if;
end $$;

-- 9. Single sign-on (0127). SS: A's sign-in issued on ehr. after single
-- sign-on (provider session sid 'synthetic-provider-sid-0129'), first
-- session SS1; PW: A's password sign-in on ehr., first session PW1, outside
-- that provider session. Both are root staff sessions, as TokenService.issue
-- writes every sign-in, single sign-on or not.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
select fixture.session_id::uuid, 'f1292000-0000-4000-8000-00000000000a', fixture.session_id::uuid,
  md5(fixture.session_id) || md5(fixture.session_id || 'refresh'), gen_random_uuid(), 1, 'password',
  now(), now() + interval '15 minutes', now() + interval '24 hours', 'staff'
from (values ('f1296000-0000-4000-8000-000000000901'), ('f1296000-0000-4000-8000-000000000911'))
  as fixture(session_id);

set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
       set_config('app.correlation_id', 'facility-selection-0129-suite-0009', true);
do $$
declare
  recorded uuid;
begin
  -- SS's provenance, written by the Identity runtime with the sign-in
  -- (TokenService.recordSingleSignOn); 0127's guard admits it for the root
  -- staff session of a staff client.
  insert into auth.session_single_sign_on (family_id, account_id, client_id, provider_sid, authenticated_at)
  values ('f1296000-0000-4000-8000-000000000901', 'f1292000-0000-4000-8000-00000000000a', 'ehr',
    'synthetic-provider-sid-0129', clock_timestamp() - interval '1 minute');
  -- Each sign-in chooses through the API's write, as a password sign-in does.
  recorded := pg_temp.select_facility('f1296000-0000-4000-8000-000000000901', 'f1292000-0000-4000-8000-00000000000a',
    'f1291000-0000-4000-8000-0000000000f2', 'f1295000-0000-4000-8000-0000000000a2');
  if recorded is distinct from 'f1296000-0000-4000-8000-000000000901' then
    raise exception 'a single sign-on sign-in could not keep a choice (answered %)', recorded;
  end if;
  recorded := pg_temp.select_facility('f1296000-0000-4000-8000-000000000911', 'f1292000-0000-4000-8000-00000000000a',
    'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1');
  if recorded is distinct from 'f1296000-0000-4000-8000-000000000911' then
    raise exception 'a password sign-in could not keep a choice (answered %)', recorded;
  end if;
end $$;
reset role;

-- SS refreshes: SS2 joins the family and SS1 is revoked as rotated (as
-- TokenService.refresh rotates a single sign-on sign-in like any other).
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
values ('f1296000-0000-4000-8000-000000000902', 'f1292000-0000-4000-8000-00000000000a',
  'f1296000-0000-4000-8000-000000000901', md5('f129-902') || md5('f129-902-refresh'), gen_random_uuid(), 1, 'password',
  now(), now() + interval '15 minutes', now() + interval '24 hours', 'staff');
update auth.sessions set revoked_at = clock_timestamp(), revocation_reason = 'rotated',
    replaced_by_session_id = 'f1296000-0000-4000-8000-000000000902', row_version = row_version + 1
 where id = 'f1296000-0000-4000-8000-000000000901';

set local role hid_identity_api_runtime;
do $$
declare
  reads text[];
  ended integer;
begin
  select array_agg(presented_session.label || '=' || coalesce(pg_temp.selected_facility(presented_session.presented::uuid,
      'f1292000-0000-4000-8000-00000000000a')::text, 'none') order by presented_session.label)
    into reads
    from (values ('PW1', 'f1296000-0000-4000-8000-000000000911'), ('SS1', 'f1296000-0000-4000-8000-000000000901'),
                 ('SS2', 'f1296000-0000-4000-8000-000000000902')) as presented_session(label, presented);
  if reads is distinct from array['PW1=f1291000-0000-4000-8000-0000000000f1', 'SS1=none',
                                  'SS2=f1291000-0000-4000-8000-0000000000f2'] then
    raise exception 'a single sign-on sign-in must read its choice through its live session, as a password one: %', reads;
  end if;

  -- The provider's back-channel logout of that provider session, exactly as
  -- SsoService.backchannelLogout ends its sign-ins (by sid, any account).
  with logged_out as (
    update auth.sessions session
       set revoked_at = clock_timestamp(), revocation_reason = 'sso_logout', row_version = session.row_version + 1
      from auth.session_single_sign_on single_sign_on
     where single_sign_on.family_id = session.family_id
       and single_sign_on.provider_sid = 'synthetic-provider-sid-0129'
       and (null::uuid is null or single_sign_on.account_id = null::uuid)
       and session.revoked_at is null
    returning session.id)
  select count(*) into ended from logged_out;
  if ended <> 1 then
    raise exception 'the back-channel logout should end SS2 alone, it ended %', ended;
  end if;

  -- Ended as a sign-out ends one (section 5): no session of it reads the
  -- choice, the API's write finds no live session, and the row cannot be
  -- changed.
  if pg_temp.selected_facility('f1296000-0000-4000-8000-000000000902', 'f1292000-0000-4000-8000-00000000000a') is not null
     or pg_temp.selected_facility('f1296000-0000-4000-8000-000000000901', 'f1292000-0000-4000-8000-00000000000a') is not null then
    raise exception 'a sign-in ended by back-channel logout still reads its choice';
  end if;
  if pg_temp.select_facility('f1296000-0000-4000-8000-000000000902', 'f1292000-0000-4000-8000-00000000000a',
       'f1291000-0000-4000-8000-0000000000f1', 'f1295000-0000-4000-8000-0000000000a1') is not null then
    raise exception 'the API''s write found a sign-in ended by back-channel logout';
  end if;
  begin
    update auth.session_facility_selection set facility_id = 'f1291000-0000-4000-8000-0000000000f1',
        membership_id = 'f1295000-0000-4000-8000-0000000000a1', row_version = row_version + 1
     where family_id = 'f1296000-0000-4000-8000-000000000901';
    raise exception 'the choice of a sign-in ended by back-channel logout was changed';
  exception when check_violation then
    if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
  end;
  -- The password sign-in was not in that provider session: it still reads
  -- its own choice.
  if pg_temp.selected_facility('f1296000-0000-4000-8000-000000000911', 'f1292000-0000-4000-8000-00000000000a')
       is distinct from 'f1291000-0000-4000-8000-0000000000f1' then
    raise exception 'the back-channel logout ended a sign-in outside its provider session';
  end if;

  -- Product sign-out signs out everywhere (SsoService.endAccountSignIns):
  -- every live staff sign-in of the account ends with 'sso_logout', the
  -- password sign-in included, and is then answered the same way.
  update auth.sessions
     set revoked_at = clock_timestamp(), revocation_reason = 'sso_logout', row_version = row_version + 1
   where account_id = 'f1292000-0000-4000-8000-00000000000a' and session_kind = 'staff' and revoked_at is null;
  if pg_temp.selected_facility('f1296000-0000-4000-8000-000000000911', 'f1292000-0000-4000-8000-00000000000a') is not null then
    raise exception 'a sign-in ended by product sign-out still reads its choice';
  end if;
  if pg_temp.select_facility('f1296000-0000-4000-8000-000000000911', 'f1292000-0000-4000-8000-00000000000a',
       'f1291000-0000-4000-8000-0000000000f2', 'f1295000-0000-4000-8000-0000000000a2') is not null then
    raise exception 'the API''s write found a sign-in ended by product sign-out';
  end if;
  begin
    update auth.session_facility_selection set facility_id = 'f1291000-0000-4000-8000-0000000000f2',
        membership_id = 'f1295000-0000-4000-8000-0000000000a2', row_version = row_version + 1
     where family_id = 'f1296000-0000-4000-8000-000000000911';
    raise exception 'the choice of a sign-in ended by product sign-out was changed';
  exception when check_violation then
    if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  -- Both rows and the provenance stay; sign-out of any kind deletes nothing.
  if (select string_agg(selection.family_id::text || '=' || selection.facility_id::text, ',' order by selection.family_id)
        from auth.session_facility_selection selection
       where selection.family_id in ('f1296000-0000-4000-8000-000000000901', 'f1296000-0000-4000-8000-000000000911'))
     is distinct from 'f1296000-0000-4000-8000-000000000901=f1291000-0000-4000-8000-0000000000f2,'
                   || 'f1296000-0000-4000-8000-000000000911=f1291000-0000-4000-8000-0000000000f1' then
    raise exception 'a choice was removed or changed when its sign-in ended';
  end if;
  if not exists (select 1 from auth.session_single_sign_on
                  where family_id = 'f1296000-0000-4000-8000-000000000901' and provider_sid = 'synthetic-provider-sid-0129') then
    raise exception 'the single sign-on provenance was removed';
  end if;
  if (select revocation_reason from auth.sessions where id = 'f1296000-0000-4000-8000-000000000902') is distinct from 'sso_logout'
     or (select revocation_reason from auth.sessions where id = 'f1296000-0000-4000-8000-000000000911') is distinct from 'sso_logout' then
    raise exception 'the sign-ins were not ended as single sign-on ends them';
  end if;
  -- The first session cannot be deleted while either row refers to it.
  delete from auth.sessions where id = 'f1296000-0000-4000-8000-000000000901';
  raise exception 'a sign-in''s first session with a choice and a provenance was deleted';
exception when foreign_key_violation then
  null;
end $$;

rollback;
