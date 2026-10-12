\set ON_ERROR_STOP on
-- Staff working facility per sign-in (0080, ADR-046). The Identity API keeps a
-- staff member's explicitly selected facility in
-- auth.session_facility_selection, one row per sign-in family, so a reload
-- does not silently move them back to their primary facility. The row is only
-- the default GET /auth/session reports: every facility-scoped request still
-- carries X-Facility-ID, checked against active memberships. Its guard admits a
-- row only for the root session of a live staff sign-in of the same account and
-- an active membership of that account at an active facility, and refuses
-- DELETE. Rollback-only; synthetic fixtures.
begin;

-- Organizations and facilities: F1, F2, F3 active; F4 suspended; F5 belongs to
-- a deactivated organization.
insert into identity.organizations (id, name, slug, active) values
  ('c7900000-0000-4000-8000-0000000000a1', 'Selection Org', 'selection-org-c79', true),
  ('c7900000-0000-4000-8000-0000000000a2', 'Selection Closed Org', 'selection-closed-org-c79', false);
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('c7910000-0000-4000-8000-0000000000f1', 'c7900000-0000-4000-8000-0000000000a1', 'Selection Alpha', 'SEL-F1', 'Africa/Lagos', true, 'verified'),
  ('c7910000-0000-4000-8000-0000000000f2', 'c7900000-0000-4000-8000-0000000000a1', 'Selection Beta', 'SEL-F2', 'Africa/Lagos', true, 'verified'),
  ('c7910000-0000-4000-8000-0000000000f3', 'c7900000-0000-4000-8000-0000000000a1', 'Selection Gamma', 'SEL-F3', 'Africa/Lagos', true, 'verified'),
  ('c7910000-0000-4000-8000-0000000000f4', 'c7900000-0000-4000-8000-0000000000a1', 'Selection Suspended', 'SEL-F4', 'Africa/Lagos', false, 'suspended'),
  ('c7910000-0000-4000-8000-0000000000f5', 'c7900000-0000-4000-8000-0000000000a2', 'Selection Closed', 'SEL-F5', 'Africa/Lagos', true, 'verified');

-- Accounts: A and B are verified staff, C's staff record is inactive, D's is
-- not verified, P is a patient. A is also a patient, so a patient sign-in of A
-- differs from A's staff sign-ins only in its kind.
insert into auth.accounts (id, subject, email, status, password_hash, password_algorithm) values
  ('c7920000-0000-4000-8000-00000000000a', 'synthetic:selection:a', 'a@selection.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c7920000-0000-4000-8000-00000000000b', 'synthetic:selection:b', 'b@selection.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c7920000-0000-4000-8000-00000000000c', 'synthetic:selection:c', 'c@selection.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c7920000-0000-4000-8000-00000000000d', 'synthetic:selection:d', 'd@selection.invalid', 'active', 'synthetic-hash', 'argon2id'),
  ('c7920000-0000-4000-8000-0000000000e0', 'synthetic:selection:p', 'p@selection.invalid', 'active', 'synthetic-hash', 'argon2id');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('c7930000-0000-4000-8000-00000000000a', 'c7920000-0000-4000-8000-00000000000a', 'HID-SELCAAAA', 'Ada', 'Selection', 'Ada Selection', 'active'),
  ('c7930000-0000-4000-8000-0000000000e0', 'c7920000-0000-4000-8000-0000000000e0', 'HID-SELCPPPP', 'Pat', 'Selection', 'Pat Selection', 'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active) values
  ('c7940000-0000-4000-8000-00000000000a', 'c7920000-0000-4000-8000-00000000000a', 'Staff A', 'a@selection.invalid', 'verified', 'doctor', true),
  ('c7940000-0000-4000-8000-00000000000b', 'c7920000-0000-4000-8000-00000000000b', 'Staff B', 'b@selection.invalid', ' Verified ', 'doctor', true),
  ('c7940000-0000-4000-8000-00000000000c', 'c7920000-0000-4000-8000-00000000000c', 'Staff C', 'c@selection.invalid', 'verified', 'doctor', false),
  ('c7940000-0000-4000-8000-00000000000d', 'c7920000-0000-4000-8000-00000000000d', 'Staff D', 'd@selection.invalid', 'pending', 'doctor', true);

-- Memberships of A: M1 at F1 (primary) and M2 at F2 active; M3 at F3 ended; M4
-- at the suspended F4; M5 at F5 under the deactivated organization; M6 at F3
-- held for migration. B: MB at F1. C and D: at F1.
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, migration_hold_reason) values
  ('c7950000-0000-4000-8000-0000000000a1', 'c7940000-0000-4000-8000-00000000000a', 'c7920000-0000-4000-8000-00000000000a',
   'c7900000-0000-4000-8000-0000000000a1', 'c7910000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true, null),
  ('c7950000-0000-4000-8000-0000000000a2', 'c7940000-0000-4000-8000-00000000000a', 'c7920000-0000-4000-8000-00000000000a',
   'c7900000-0000-4000-8000-0000000000a1', 'c7910000-0000-4000-8000-0000000000f2', 'nurse', 'nurse', false, true, null),
  ('c7950000-0000-4000-8000-0000000000a3', 'c7940000-0000-4000-8000-00000000000a', 'c7920000-0000-4000-8000-00000000000a',
   'c7900000-0000-4000-8000-0000000000a1', 'c7910000-0000-4000-8000-0000000000f3', 'doctor', 'doctor', false, false, null),
  ('c7950000-0000-4000-8000-0000000000a4', 'c7940000-0000-4000-8000-00000000000a', 'c7920000-0000-4000-8000-00000000000a',
   'c7900000-0000-4000-8000-0000000000a1', 'c7910000-0000-4000-8000-0000000000f4', 'doctor', 'doctor', false, true, null),
  ('c7950000-0000-4000-8000-0000000000a5', 'c7940000-0000-4000-8000-00000000000a', 'c7920000-0000-4000-8000-00000000000a',
   'c7900000-0000-4000-8000-0000000000a2', 'c7910000-0000-4000-8000-0000000000f5', 'doctor', 'doctor', false, true, null),
  ('c7950000-0000-4000-8000-0000000000a6', 'c7940000-0000-4000-8000-00000000000a', 'c7920000-0000-4000-8000-00000000000a',
   'c7900000-0000-4000-8000-0000000000a1', 'c7910000-0000-4000-8000-0000000000f3', 'nurse', 'nurse', false, true,
   'Synthetic migration hold'),
  ('c7950000-0000-4000-8000-0000000000b1', 'c7940000-0000-4000-8000-00000000000b', 'c7920000-0000-4000-8000-00000000000b',
   'c7900000-0000-4000-8000-0000000000a1', 'c7910000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true, null),
  ('c7950000-0000-4000-8000-0000000000c1', 'c7940000-0000-4000-8000-00000000000c', 'c7920000-0000-4000-8000-00000000000c',
   'c7900000-0000-4000-8000-0000000000a1', 'c7910000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true, null),
  ('c7950000-0000-4000-8000-0000000000d1', 'c7940000-0000-4000-8000-00000000000d', 'c7920000-0000-4000-8000-00000000000d',
   'c7900000-0000-4000-8000-0000000000a1', 'c7910000-0000-4000-8000-0000000000f1', 'doctor', 'doctor', true, true, null);

-- Sign-ins. Each family's root session has id = family_id. A1 and A2 are two
-- live staff sign-ins of A, AR was signed out, AX lapsed, AP is A's patient
-- sign-in, PP the patient P's; B1, C1 and D1 are live staff sign-ins.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, revoked_at, revocation_reason,
    session_kind, patient_id)
select session_id::uuid, account_id::uuid, session_id::uuid, md5(session_id) || md5(session_id || 'refresh'),
  gen_random_uuid(), 1, 'password', issued_at, expires_at, issued_at + interval '24 hours', revoked_at,
  case when revoked_at is not null then 'logout' end, kind, patient_id::uuid
from (values
  ('c7960000-0000-4000-8000-0000000000a1', 'c7920000-0000-4000-8000-00000000000a', now(), now() + interval '8 hours', null::timestamptz, 'staff', null),
  ('c7960000-0000-4000-8000-0000000000a2', 'c7920000-0000-4000-8000-00000000000a', now(), now() + interval '8 hours', null, 'staff', null),
  ('c7960000-0000-4000-8000-0000000000a8', 'c7920000-0000-4000-8000-00000000000a', now(), now() + interval '8 hours', now(), 'staff', null),
  ('c7960000-0000-4000-8000-0000000000a9', 'c7920000-0000-4000-8000-00000000000a', now() - interval '9 hours', now() - interval '1 hour', null, 'staff', null),
  ('c7960000-0000-4000-8000-0000000000ac', 'c7920000-0000-4000-8000-00000000000a', now(), now() + interval '8 hours', null, 'patient', 'c7930000-0000-4000-8000-00000000000a'),
  ('c7960000-0000-4000-8000-0000000000e0', 'c7920000-0000-4000-8000-0000000000e0', now(), now() + interval '8 hours', null, 'patient', 'c7930000-0000-4000-8000-0000000000e0'),
  ('c7960000-0000-4000-8000-0000000000b1', 'c7920000-0000-4000-8000-00000000000b', now(), now() + interval '8 hours', null, 'staff', null),
  ('c7960000-0000-4000-8000-0000000000c1', 'c7920000-0000-4000-8000-00000000000c', now(), now() + interval '8 hours', null, 'staff', null),
  ('c7960000-0000-4000-8000-0000000000d1', 'c7920000-0000-4000-8000-00000000000d', now(), now() + interval '8 hours', null, 'staff', null)
) as fixture(session_id, account_id, issued_at, expires_at, revoked_at, kind, patient_id);
-- A live session of A2's family that is not its root (as after a rotation).
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
values ('c7960000-0000-4000-8000-0000000000a7', 'c7920000-0000-4000-8000-00000000000a',
  'c7960000-0000-4000-8000-0000000000a2', md5('a7') || md5('a7-refresh'), gen_random_uuid(), 1, 'password',
  now(), now() + interval '8 hours', now() + interval '24 hours', 'staff');
-- A live session that names a7 as its family although a7 is not a family root
-- (the API never writes this): a family is identified by its root session.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
values ('c7960000-0000-4000-8000-0000000000a6', 'c7920000-0000-4000-8000-00000000000a',
  'c7960000-0000-4000-8000-0000000000a7', md5('a6') || md5('a6-refresh'), gen_random_uuid(), 1, 'password',
  now(), now() + interval '8 hours', now() + interval '24 hours', 'staff');

-- 1. Catalog contract: the table's columns and keys, a guard that is a plain
-- invoker trigger with a fixed search_path and no PUBLIC execute, firing
-- before every insert, update and delete.
do $$
declare
  guard constant regprocedure := 'auth.guard_session_facility_selection_change()'::regprocedure;
begin
  if (select array_agg(attribute.attname::text || ':' || format_type(attribute.atttypid, attribute.atttypmod)
          || ':' || attribute.attnotnull::text order by attribute.attnum)
        from pg_attribute attribute
       where attribute.attrelid = 'auth.session_facility_selection'::regclass and attribute.attnum > 0
         and not attribute.attisdropped)
     <> array['family_id:uuid:true', 'account_id:uuid:true', 'facility_id:uuid:true', 'membership_id:uuid:true',
       'selected_at:timestamp with time zone:true', 'row_version:bigint:true'] then
    raise exception 'auth.session_facility_selection columns are not the 0080 contract';
  end if;
  if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
       where constraint_row.conrelid = 'auth.session_facility_selection'::regclass and constraint_row.contype = 'p')
     <> 'PRIMARY KEY (family_id)' then
    raise exception 'auth.session_facility_selection must be keyed by the sign-in family';
  end if;
  if (select array_agg(pg_get_constraintdef(constraint_row.oid) order by pg_get_constraintdef(constraint_row.oid))
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'auth.session_facility_selection'::regclass and constraint_row.contype = 'f')
     <> array[
       'FOREIGN KEY (account_id) REFERENCES auth.accounts(id) ON DELETE RESTRICT',
       'FOREIGN KEY (facility_id) REFERENCES identity.facilities(id) ON DELETE RESTRICT',
       'FOREIGN KEY (family_id) REFERENCES auth.sessions(id) ON DELETE RESTRICT',
       'FOREIGN KEY (membership_id, facility_id, account_id) REFERENCES identity.staff_facility_memberships(id, facility_id, account_id) ON DELETE RESTRICT'
     ] then
    raise exception 'auth.session_facility_selection foreign keys are not the 0080 contract';
  end if;
  if not exists (
    select 1 from pg_proc function_row
     where function_row.oid = guard and not function_row.prosecdef
       and function_row.proconfig @> array['search_path=auth, identity, pg_temp']
  ) then
    raise exception 'the selection guard must be an invoker function with a fixed search_path';
  end if;
  if (select function_row.proacl from pg_proc function_row where function_row.oid = guard) is null
     or exists (select 1 from pg_proc function_row, aclexplode(function_row.proacl) privilege
                 where function_row.oid = guard and privilege.grantee = 0) then
    raise exception 'PUBLIC can execute the selection guard';
  end if;
  -- tgtype 31 = ROW | BEFORE | INSERT | DELETE | UPDATE.
  if not exists (
    select 1 from pg_trigger trigger_row
     where trigger_row.tgrelid = 'auth.session_facility_selection'::regclass and trigger_row.tgfoid = guard
       and not trigger_row.tgisinternal and trigger_row.tgenabled = 'O' and trigger_row.tgtype = 31
  ) then
    raise exception 'the selection guard must fire before every row insert, update and delete';
  end if;
end $$;

-- 2. Runtime privileges: the Identity runtime reads, inserts and updates; no
-- runtime deletes or truncates; no other service and not PUBLIC has any access.
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
  for role_name in
    select rolname from pg_roles where rolname = any (array['hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_api_runtime',
      'hid_lab_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_runtime', 'hid_pharmacy_api_runtime', 'hid_ocr_runtime',
      'hid_ocr_api_runtime', 'hid_ocr_worker', 'hid_outreach_runtime', 'hid_outreach_api_runtime',
      'hid_notification_runtime', 'hid_notification_api_runtime', 'hid_notification_worker', 'hid_event_dispatcher',
      'hid_event_delivery_commands', 'hid_audit_writer', 'hid_document_scanner', 'hid_ocr_queue_metrics'])
  loop
    -- A list of privileges is true when any of them is held.
    if has_table_privilege(role_name, 'auth.session_facility_selection',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception '% has a privilege on auth.session_facility_selection', role_name;
    end if;
  end loop;
  if exists (select 1 from pg_class relation, aclexplode(relation.relacl) privilege
              where relation.oid = 'auth.session_facility_selection'::regclass and privilege.grantee = 0) then
    raise exception 'PUBLIC has a privilege on auth.session_facility_selection';
  end if;
end $$;

-- 3. As the Identity API runtime: the API's own upsert (TokenService) records
-- A1's selection, replaces it, and refuses every row the guard must refuse.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
       set_config('app.correlation_id', 'facility-selection-suite-0001', true);

do $$
declare
  recorded text;
  rejected record;
begin
  -- The API upsert: only for the live staff session of the account.
  insert into auth.session_facility_selection (family_id, account_id, facility_id, membership_id)
  select session.family_id, session.account_id, 'c7910000-0000-4000-8000-0000000000f2'::uuid,
         'c7950000-0000-4000-8000-0000000000a2'::uuid
    from auth.sessions session
   where session.id = 'c7960000-0000-4000-8000-0000000000a1' and session.account_id = 'c7920000-0000-4000-8000-00000000000a'
     and session.session_kind = 'staff' and session.revoked_at is null and session.expires_at > clock_timestamp()
     and session.absolute_expires_at > clock_timestamp()
  on conflict (family_id) do update
     set facility_id = excluded.facility_id, membership_id = excluded.membership_id,
         selected_at = clock_timestamp(), row_version = auth.session_facility_selection.row_version + 1
  returning family_id::text into recorded;
  if recorded is distinct from 'c7960000-0000-4000-8000-0000000000a1' then
    raise exception 'the runtime could not record a valid selection';
  end if;
  insert into auth.session_facility_selection (family_id, account_id, facility_id, membership_id)
  values ('c7960000-0000-4000-8000-0000000000a1', 'c7920000-0000-4000-8000-00000000000a',
          'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000a1')
  on conflict (family_id) do update
     set facility_id = excluded.facility_id, membership_id = excluded.membership_id,
         selected_at = clock_timestamp(), row_version = auth.session_facility_selection.row_version + 1;
  if (select facility_id::text || '/' || row_version::text from auth.session_facility_selection
       where family_id = 'c7960000-0000-4000-8000-0000000000a1')
     <> 'c7910000-0000-4000-8000-0000000000f1/2' then
    raise exception 'a new selection did not replace the sign-in''s previous one';
  end if;

  for rejected in select * from (values
    -- Another account named on A's sign-in, with that account's own membership.
    ('wrong account', 'c7960000-0000-4000-8000-0000000000a2', 'c7920000-0000-4000-8000-00000000000b',
     'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000b1'),
    -- A's ended membership.
    ('inactive membership', 'c7960000-0000-4000-8000-0000000000a2', 'c7920000-0000-4000-8000-00000000000a',
     'c7910000-0000-4000-8000-0000000000f3', 'c7950000-0000-4000-8000-0000000000a3'),
    ('membership held for migration', 'c7960000-0000-4000-8000-0000000000a2', 'c7920000-0000-4000-8000-00000000000a',
     'c7910000-0000-4000-8000-0000000000f3', 'c7950000-0000-4000-8000-0000000000a6'),
    ('suspended facility', 'c7960000-0000-4000-8000-0000000000a2', 'c7920000-0000-4000-8000-00000000000a',
     'c7910000-0000-4000-8000-0000000000f4', 'c7950000-0000-4000-8000-0000000000a4'),
    ('deactivated organization', 'c7960000-0000-4000-8000-0000000000a2', 'c7920000-0000-4000-8000-00000000000a',
     'c7910000-0000-4000-8000-0000000000f5', 'c7950000-0000-4000-8000-0000000000a5'),
    -- A's sign-in with B's membership (and facility).
    ('another account''s membership', 'c7960000-0000-4000-8000-0000000000a2', 'c7920000-0000-4000-8000-00000000000a',
     'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000b1'),
    -- A's membership at F1 named for F2.
    ('membership of another facility', 'c7960000-0000-4000-8000-0000000000a2', 'c7920000-0000-4000-8000-00000000000a',
     'c7910000-0000-4000-8000-0000000000f2', 'c7950000-0000-4000-8000-0000000000a1'),
    -- B's sign-in claimed by A with A's own membership.
    ('another account''s family', 'c7960000-0000-4000-8000-0000000000b1', 'c7920000-0000-4000-8000-00000000000a',
     'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000a1'),
    -- A's own patient sign-in: only the kind is wrong.
    ('a patient family', 'c7960000-0000-4000-8000-0000000000ac', 'c7920000-0000-4000-8000-00000000000a',
     'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000a1'),
    ('another patient''s family', 'c7960000-0000-4000-8000-0000000000e0', 'c7920000-0000-4000-8000-0000000000e0',
     'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000a1'),
    ('a signed-out family', 'c7960000-0000-4000-8000-0000000000a8', 'c7920000-0000-4000-8000-00000000000a',
     'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000a1'),
    ('a lapsed family', 'c7960000-0000-4000-8000-0000000000a9', 'c7920000-0000-4000-8000-00000000000a',
     'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000a1'),
    ('an inactive staff record', 'c7960000-0000-4000-8000-0000000000c1', 'c7920000-0000-4000-8000-00000000000c',
     'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000c1'),
    ('an unverified staff record', 'c7960000-0000-4000-8000-0000000000d1', 'c7920000-0000-4000-8000-00000000000d',
     'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000d1'),
    ('a session that is not its family''s root', 'c7960000-0000-4000-8000-0000000000a7', 'c7920000-0000-4000-8000-00000000000a',
     'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000a1'),
    ('no session at all', 'c7960000-0000-4000-8000-0000000000ff', 'c7920000-0000-4000-8000-00000000000a',
     'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000a1')
  ) as candidate(label, family_id, account_id, facility_id, membership_id) loop
    begin
      insert into auth.session_facility_selection (family_id, account_id, facility_id, membership_id)
      values (rejected.family_id::uuid, rejected.account_id::uuid, rejected.facility_id::uuid, rejected.membership_id::uuid);
      raise exception 'the guard accepted a selection with %', rejected.label;
    exception when check_violation then
      if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
    end;
  end loop;

  -- Verification status is compared trimmed and case-insensitively, as
  -- CurrentStaffContextService compares it (B's is ' Verified ').
  insert into auth.session_facility_selection (family_id, account_id, facility_id, membership_id)
  values ('c7960000-0000-4000-8000-0000000000b1', 'c7920000-0000-4000-8000-00000000000b',
          'c7910000-0000-4000-8000-0000000000f1', 'c7950000-0000-4000-8000-0000000000b1');

  -- An update is checked as an insert is, and cannot move the row to another
  -- sign-in or account.
  begin
    update auth.session_facility_selection
       set facility_id = 'c7910000-0000-4000-8000-0000000000f3', membership_id = 'c7950000-0000-4000-8000-0000000000a3',
           row_version = row_version + 1
     where family_id = 'c7960000-0000-4000-8000-0000000000a1';
    raise exception 'an update to an ended membership was accepted';
  exception when check_violation then
    if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
  end;
  begin
    update auth.session_facility_selection set family_id = 'c7960000-0000-4000-8000-0000000000a2'
     where family_id = 'c7960000-0000-4000-8000-0000000000a1';
    raise exception 'a selection was moved to another sign-in';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'SESSION_FACILITY_SELECTION_IMMUTABLE' then raise; end if;
  end;
  begin
    update auth.session_facility_selection set account_id = 'c7920000-0000-4000-8000-00000000000b'
     where family_id = 'c7960000-0000-4000-8000-0000000000a1';
    raise exception 'a selection was moved to another account';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'SESSION_FACILITY_SELECTION_IMMUTABLE' then raise; end if;
  end;

  -- The runtime cannot delete a selection.
  begin
    delete from auth.session_facility_selection where family_id = 'c7960000-0000-4000-8000-0000000000a1';
    raise exception 'the runtime deleted a selection';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- 4. Nobody deletes a selection, the owner included: sign-out and revocation
-- leave it in place, as they leave auth.session_assurance.
do $$ begin
  delete from auth.session_facility_selection where family_id = 'c7960000-0000-4000-8000-0000000000a1';
  raise exception 'a selection was deleted';
exception when object_not_in_prerequisite_state then
  if sqlerrm <> 'SESSION_FACILITY_SELECTION_IMMUTABLE' then raise; end if;
end $$;

-- 5. Rotation keeps the selection: the API reads it through the family of the
-- session presented, so the rotated session finds it and A's other sign-in
-- does not. Once the sign-in is signed out, no session of it reads it again,
-- and the row stays.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
    authentication_method, issued_at, expires_at, absolute_expires_at, session_kind)
values ('c7960000-0000-4000-8000-0000000000a3', 'c7920000-0000-4000-8000-00000000000a',
  'c7960000-0000-4000-8000-0000000000a1', md5('a3') || md5('a3-refresh'), gen_random_uuid(), 1, 'password',
  now(), now() + interval '8 hours', now() + interval '24 hours', 'staff');
update auth.sessions set revoked_at = clock_timestamp(), revocation_reason = 'rotated',
    replaced_by_session_id = 'c7960000-0000-4000-8000-0000000000a3', row_version = row_version + 1
 where id = 'c7960000-0000-4000-8000-0000000000a1';

set local role hid_identity_api_runtime;
do $$
declare
  reads text[];
begin
  -- TokenService.selectedFacilityId, for each session presented.
  select array_agg(presented_session.label || '=' || coalesce((
      select selection.facility_id::text
        from auth.sessions session
        join auth.session_facility_selection selection
          on selection.family_id = session.family_id and selection.account_id = session.account_id
       where session.id = presented_session.presented::uuid and session.account_id = 'c7920000-0000-4000-8000-00000000000a'
         and session.session_kind = 'staff' and session.revoked_at is null and session.expires_at > clock_timestamp()
         and session.absolute_expires_at > clock_timestamp()), 'none') order by presented_session.label)
    into reads
    from (values ('rotated', 'c7960000-0000-4000-8000-0000000000a3'),
                 ('replaced', 'c7960000-0000-4000-8000-0000000000a1'),
                 ('other sign-in', 'c7960000-0000-4000-8000-0000000000a2')) as presented_session(label, presented);
  if reads <> array['other sign-in=none', 'replaced=none', 'rotated=c7910000-0000-4000-8000-0000000000f1'] then
    raise exception 'the selection did not follow the rotated session only: %', reads;
  end if;
end $$;
reset role;

-- Signed out: every session of the family revoked.
update auth.sessions set revoked_at = clock_timestamp(), revocation_reason = 'logout', row_version = row_version + 1
 where family_id = 'c7960000-0000-4000-8000-0000000000a1' and revoked_at is null;
do $$ begin
  if exists (
    select 1 from auth.sessions session
      join auth.session_facility_selection selection
        on selection.family_id = session.family_id and selection.account_id = session.account_id
     where session.family_id = 'c7960000-0000-4000-8000-0000000000a1'
       and session.session_kind = 'staff' and session.revoked_at is null and session.expires_at > clock_timestamp()
       and session.absolute_expires_at > clock_timestamp()
  ) then
    raise exception 'a signed-out sign-in still reads its selection';
  end if;
  if not exists (select 1 from auth.session_facility_selection where family_id = 'c7960000-0000-4000-8000-0000000000a1') then
    raise exception 'sign-out removed the selection row';
  end if;
end $$;

-- A signed-out sign-in can never be given a selection again, by the runtime or the owner.
do $$ begin
  update auth.session_facility_selection set facility_id = 'c7910000-0000-4000-8000-0000000000f2',
      membership_id = 'c7950000-0000-4000-8000-0000000000a2', row_version = row_version + 1
   where family_id = 'c7960000-0000-4000-8000-0000000000a1';
  raise exception 'a signed-out sign-in''s selection was changed';
exception when check_violation then
  if sqlerrm <> 'SESSION_FACILITY_SELECTION_INVALID' then raise; end if;
end $$;

rollback;
