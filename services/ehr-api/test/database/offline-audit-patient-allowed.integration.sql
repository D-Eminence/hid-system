\set ON_ERROR_STOP on
-- Offline audit patient check (0099; OFFLINE-CONTRACT.md amendment A10 item
-- 1, after the review of D-Eminence/hid-system#131). Rollback-only.
--
-- ehr.offline_audit_patient_allowed(patient) answers, for the request context
-- the EHR API sets (app.actor_subject, app.membership_id, app.facility_id),
-- whether that account, membership and facility ever held a started read or
-- write grant for the patient that is neither break-glass (D5) nor held by
-- the cutover. Status, revocation and expiry are ignored on purpose, so a
-- late-synced offline read is still accepted. The cases, through the exact
-- EHR runtime role:
--   1. the function's security properties: SQL, STABLE, SECURITY DEFINER,
--      not STRICT, search_path pg_catalog, pg_temp, one uuid argument, a
--      boolean result, owned by ehr.context_allows's owner;
--   2. EXECUTE for hid_ehr_runtime (and the ehr-api login through it) and
--      nobody else: not hid_identity_runtime, not PUBLIC, no other runtime;
--      the ACL holds only the owner and hid_ehr_runtime;
--   3. true for an open read grant and an open write grant of this account,
--      membership and facility, and for an expired, a lapsed (still
--      'active' past expiry), a patient-revoked and a clinician-closed one;
--   4. false for a grant of another membership of the same account at the
--      same facility, of the same account at another facility, of another
--      account, for a break-glass grant (and for legacy rows that carry only
--      the break-glass scope or only the break-glass flag), a migration-held
--      grant, a grant that has not started, a patient without any grant, a
--      patient that does not exist, and null; those other memberships and
--      accounts get true for their own grants;
--   5. false when the context names this grant's membership but another
--      account, or this grant's account and membership but another
--      facility, or no context at all, or when the account is disabled;
--   6. hid_identity_runtime and a role holding only USAGE on schema ehr (what
--      PUBLIC would have) cannot call it (42501).
begin;

-- 1. Security properties.
do $$
declare
  mismatch text;
begin
  select format('owner=%s context_allows owner=%s definer=%s volatile=%s language=%s strict=%s config=%s result=%s arguments=%s',
           pg_get_userbyid(proc.proowner), pg_get_userbyid(gate.proowner), proc.prosecdef, proc.provolatile,
           language_row.lanname, proc.proisstrict, proc.proconfig, proc.prorettype::regtype,
           proc.proargtypes::regtype[])
    into mismatch
    from pg_proc proc
    join pg_language language_row on language_row.oid = proc.prolang
    join pg_proc gate on gate.oid = 'ehr.context_allows(uuid,uuid,text)'::regprocedure
   where proc.oid = 'ehr.offline_audit_patient_allowed(uuid)'::regprocedure
     and (proc.proowner <> gate.proowner or not proc.prosecdef or proc.provolatile <> 's'
       or language_row.lanname <> 'sql' or proc.proisstrict
       or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]
       or proc.prorettype <> 'boolean'::regtype or proc.pronargs <> 1 or proc.proargtypes[0] <> 'uuid'::regtype);
  if mismatch is not null then
    raise exception 'ehr.offline_audit_patient_allowed(uuid) security properties differ: %', mismatch;
  end if;
  if (select count(*) from pg_proc proc
       where proc.pronamespace = 'ehr'::regnamespace and proc.proname = 'offline_audit_patient_allowed') <> 1 then
    raise exception 'ehr.offline_audit_patient_allowed has another overload';
  end if;
end
$$;

-- 2. Privileges.
do $$
declare
  mismatch text;
begin
  select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public') || ' ' || privilege.privilege_type, ', ')
    into mismatch
    from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
   where proc.oid = 'ehr.offline_audit_patient_allowed(uuid)'::regprocedure
     and privilege.grantee <> proc.proowner
     and (privilege.grantee = 0 or privilege.grantee::regrole::text <> 'hid_ehr_runtime'
          or privilege.privilege_type <> 'EXECUTE');
  if mismatch is not null then
    raise exception 'ehr.offline_audit_patient_allowed(uuid) is granted to more than hid_ehr_runtime: %', mismatch;
  end if;
  if not has_function_privilege('hid_ehr_runtime', 'ehr.offline_audit_patient_allowed(uuid)', 'EXECUTE')
     or not has_function_privilege('hid_ehr_api_runtime', 'ehr.offline_audit_patient_allowed(uuid)', 'EXECUTE') then
    raise exception 'The EHR runtime (or the ehr-api login through it) cannot execute ehr.offline_audit_patient_allowed';
  end if;
  select string_agg(role_name, ', ') into mismatch
    from unnest(array['public', 'hid_identity_runtime', 'hid_identity_api_runtime', 'hid_api_runtime',
                      'hid_lab_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_runtime', 'hid_pharmacy_api_runtime',
                      'hid_ocr_runtime', 'hid_ocr_api_runtime', 'hid_ocr_worker', 'hid_outreach_runtime',
                      'hid_outreach_api_runtime', 'hid_notification_api_runtime', 'hid_notification_worker',
                      'hid_schema_test_runtime', 'hid_audit_writer', 'hid_document_scanner']) role_name
   where (role_name = 'public' or exists (select 1 from pg_roles where rolname = role_name))
     and has_function_privilege(role_name, 'ehr.offline_audit_patient_allowed(uuid)', 'EXECUTE');
  if mismatch is not null then
    raise exception 'ehr.offline_audit_patient_allowed(uuid) is executable by %', mismatch;
  end if;
  -- The EHR runtime gains no Identity table privilege for it.
  if has_table_privilege('hid_ehr_runtime', 'identity.consent_grants', 'SELECT') then
    raise exception 'hid_ehr_runtime may read identity.consent_grants directly';
  end if;
end
$$;

-- Fixtures: staff A with three memberships (doctor and nurse at clinic one,
-- doctor at clinic two), staff B (doctor at clinic one), and one patient per
-- case. The grants are inserted directly, under every CHECK, foreign key and
-- trigger on identity.consent_grants (the sealed-demo pair rule included:
-- both clinics and every patient are real); the revoked and closed ones have
-- the shape identity.revoke_my_consent_grant and
-- identity.close_own_consent_grant leave.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('99a10000-0000-4000-8000-000000000001', 'staff:offline-audit-a', 'offline-audit-a@example.invalid', 'Offline Audit A', 'active'),
  ('99a10000-0000-4000-8000-000000000002', 'staff:offline-audit-b', 'offline-audit-b@example.invalid', 'Offline Audit B', 'active'),
  ('99a10000-0000-4000-8000-000000000005', 'synthetic:offline-audit:patient-5', 'offline-audit-p5@example.invalid',
   'Offline Audit Patient Five', 'active');
insert into identity.organizations (id, name, slug) values
  ('99a30000-0000-4000-8000-000000000001', 'Offline Audit Organization', 'offline-audit-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('99a30000-0000-4000-8000-000000000002', '99a30000-0000-4000-8000-000000000001', 'Offline Audit Clinic One',
   'OFA-F1', 'Africa/Lagos', true, 'verified'),
  ('99a30000-0000-4000-8000-000000000003', '99a30000-0000-4000-8000-000000000001', 'Offline Audit Clinic Two',
   'OFA-F2', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('99a40000-0000-4000-8000-000000000001', '99a10000-0000-4000-8000-000000000001', 'Offline Audit A',
   'offline-audit-a@example.invalid', 'verified', 'doctor'),
  ('99a40000-0000-4000-8000-000000000002', '99a10000-0000-4000-8000-000000000002', 'Offline Audit B',
   'offline-audit-b@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('99a50000-0000-4000-8000-000000000001', '99a40000-0000-4000-8000-000000000001', '99a10000-0000-4000-8000-000000000001',
   '99a30000-0000-4000-8000-000000000001', '99a30000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true),
  ('99a50000-0000-4000-8000-000000000002', '99a40000-0000-4000-8000-000000000001', '99a10000-0000-4000-8000-000000000001',
   '99a30000-0000-4000-8000-000000000001', '99a30000-0000-4000-8000-000000000002', 'nurse', 'nurse', false, true),
  ('99a50000-0000-4000-8000-000000000003', '99a40000-0000-4000-8000-000000000001', '99a10000-0000-4000-8000-000000000001',
   '99a30000-0000-4000-8000-000000000001', '99a30000-0000-4000-8000-000000000003', 'doctor', 'doctor', false, true),
  ('99a50000-0000-4000-8000-000000000004', '99a40000-0000-4000-8000-000000000002', '99a10000-0000-4000-8000-000000000002',
   '99a30000-0000-4000-8000-000000000001', '99a30000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status)
select ('99a20000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       case when n = 5 then '99a10000-0000-4000-8000-000000000005'::uuid end,
       'HID-QFAUD' || (array['AA','AB','AC','AD','AE','AF','AG','AH','AJ','AK','AL','AM','AN','AP','AQ'])[n],
       'Offline', 'Patient ' || n, 'Offline Patient ' || n, 'active'
  from generate_series(1, 15) n;

-- The grants: (patient, membership, scope, status, starts, expires, revoked
-- at, revoked by, break_glass, purpose, hold, source system). Membership 1 is
-- A's doctor membership at clinic one, 2 A's nurse membership there, 3 A's at
-- clinic two, 4 B's at clinic one.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  reason, starts_at, expires_at, revoked_at, revoked_by, revoked_reason, break_glass, purpose_of_use,
  migration_hold_reason, source_system)
select ('99a60000-0000-4000-8000-0000000000' || lpad(g.n::text, 2, '0'))::uuid,
       ('99a20000-0000-4000-8000-0000000000' || lpad(g.patient::text, 2, '0'))::uuid,
       membership.staff_id, membership.account_id, membership.id, membership.facility_id,
       g.scope, g.status, 'Offline audit fixture grant', g.starts_at, g.expires_at, g.revoked_at,
       g.revoked_by, case when g.revoked_at is not null then 'Offline audit fixture revocation' end,
       g.break_glass, g.purpose, g.hold, g.source_system
  from (values
    -- 1, 2: open read and open write grants of A at clinic one.
    (1, 1, 1, 'read_records', 'active', now() - interval '1 hour', now() + interval '7 hours',
     null::timestamptz, null::uuid, false, 'direct-care', null::text, 'hid'),
    (2, 2, 1, 'write_records', 'active', now() - interval '1 hour', now() + interval '365 days',
     null, null, false, 'direct-care', null, 'hid'),
    -- 3: expired by the sweeper; 4: past its expiry, not yet swept.
    (3, 3, 1, 'read_records', 'expired', now() - interval '10 days', now() - interval '9 days',
     null, null, false, 'direct-care', null, 'hid'),
    (4, 4, 1, 'read_records', 'active', now() - interval '2 days', now() - interval '1 day',
     null, null, false, 'direct-care', null, 'hid'),
    -- 5: revoked by the patient (identity.revoke_my_consent_grant's shape);
    -- 6: closed by the clinician (identity.close_own_consent_grant's shape).
    (5, 5, 1, 'write_records', 'revoked', now() - interval '3 days', now() + interval '362 days',
     now() - interval '1 day', '99a10000-0000-4000-8000-000000000005'::uuid, false, 'direct-care', null, 'hid'),
    (6, 6, 1, 'read_records', 'revoked', now() - interval '3 hours', now() + interval '5 hours',
     now() - interval '2 hours', '99a10000-0000-4000-8000-000000000001'::uuid, false, 'direct-care', null, 'hid'),
    -- 7: A's other membership at clinic one; 8: A at clinic two; 9: B at
    -- clinic one.
    (7, 7, 2, 'read_records', 'active', now() - interval '1 hour', now() + interval '7 hours',
     null, null, false, 'direct-care', null, 'hid'),
    (8, 8, 3, 'read_records', 'active', now() - interval '1 hour', now() + interval '7 hours',
     null, null, false, 'direct-care', null, 'hid'),
    (9, 9, 4, 'read_records', 'active', now() - interval '1 hour', now() + interval '7 hours',
     null, null, false, 'direct-care', null, 'hid'),
    -- 10: break-glass (D5); 11: a legacy row with a read scope but the
    -- break-glass flag; 12: a legacy row with the break-glass scope but no
    -- flag (consent_grants_check3 binds the two only for source_system hid).
    (10, 10, 1, 'break_glass', 'active', now() - interval '1 hour', now() + interval '3 hours',
     null, null, true, 'emergency', null, 'hid'),
    (11, 11, 1, 'read_records', 'active', now() - interval '1 hour', now() + interval '3 hours',
     null, null, true, 'emergency', null, 'legacy-offline-audit'),
    (12, 12, 1, 'break_glass', 'active', now() - interval '1 hour', now() + interval '3 hours',
     null, null, false, 'emergency', null, 'legacy-offline-audit'),
    -- 13: held by the cutover; 14: not started yet. Patient 15 has no grant.
    (13, 13, 1, 'read_records', 'active', now() - interval '1 hour', now() + interval '7 hours',
     null, null, false, null, 'Awaiting offline audit cutover review', 'hid'),
    (14, 14, 1, 'read_records', 'active', now() + interval '1 hour', now() + interval '9 hours',
     null, null, false, 'direct-care', null, 'hid'))
         g(n, patient, membership_no, scope, status, starts_at, expires_at, revoked_at, revoked_by, break_glass,
           purpose, hold, source_system)
  join identity.staff_facility_memberships membership
    on membership.id = ('99a50000-0000-4000-8000-00000000000' || g.membership_no)::uuid;

do $$
begin
  if (select count(*) from identity.consent_grants where id::text like '99a60000-%') <> 14 then
    raise exception 'Fixture: the fourteen grants were not written';
  end if;
end
$$;

-- 3, 4 and 5. Every case through the EHR runtime role, the context set as the
-- EHR API sets it.
set local role hid_ehr_runtime;
do $$
declare
  test_case record;
  actual boolean;
  failures text[] := array[]::text[];
begin
  for test_case in
    select *
      from (values
        -- 3. True: this account, membership and facility once held the grant.
        ('open read grant', 'a', 1, 1, 1, true),
        ('open write grant', 'a', 1, 1, 2, true),
        ('expired grant', 'a', 1, 1, 3, true),
        ('lapsed grant (active, past expiry)', 'a', 1, 1, 4, true),
        ('grant revoked by the patient', 'a', 1, 1, 5, true),
        ('grant closed by the clinician', 'a', 1, 1, 6, true),
        -- 4. False: another membership, facility or account, break-glass,
        -- held, not started, no grant, no patient, null.
        ('another membership of the same account at the same facility', 'a', 1, 1, 7, false),
        ('the same account at another facility', 'a', 1, 1, 8, false),
        ('another account at the same facility', 'a', 1, 1, 9, false),
        ('break-glass only', 'a', 1, 1, 10, false),
        ('legacy break-glass flag on a read scope', 'a', 1, 1, 11, false),
        ('legacy break-glass scope without the flag', 'a', 1, 1, 12, false),
        ('migration-held grant', 'a', 1, 1, 13, false),
        ('grant that has not started', 'a', 1, 1, 14, false),
        ('patient without any grant', 'a', 1, 1, 15, false),
        ('patient that does not exist', 'a', 1, 1, 99, false),
        ('null patient', 'a', 1, 1, null, false),
        -- ... while those memberships and that account get their own.
        ('the other membership''s own grant', 'a', 2, 1, 7, true),
        ('the other facility''s own grant', 'a', 3, 2, 8, true),
        ('the other account''s own grant', 'b', 4, 1, 9, true),
        ('the other membership does not get the first one''s grant', 'a', 2, 1, 1, false),
        ('the other account does not get A''s grant', 'b', 4, 1, 1, false),
        -- 5. False when the context does not match the grant.
        ('another account presenting the grant''s membership', 'b', 1, 1, 1, false),
        ('the grant''s account and membership at another facility', 'a', 1, 2, 1, false),
        ('no request context', null, null, null, 1, false))
        cases(label, actor, membership_no, facility_no, patient_no, expected)
  loop
    perform set_config('app.actor_subject', coalesce('staff:offline-audit-' || test_case.actor, ''), true),
            set_config('app.membership_id',
              coalesce('99a50000-0000-4000-8000-00000000000' || test_case.membership_no, ''), true),
            set_config('app.facility_id',
              coalesce('99a30000-0000-4000-8000-00000000000' || (test_case.facility_no + 1), ''), true);
    actual := ehr.offline_audit_patient_allowed(
      ('99a20000-0000-4000-8000-0000000000' || lpad(test_case.patient_no::text, 2, '0'))::uuid);
    if actual is distinct from test_case.expected then
      failures := failures || format('%s: expected %s, got %s', test_case.label, test_case.expected,
        coalesce(actual::text, 'null'));
    end if;
  end loop;
  if cardinality(failures) > 0 then
    raise exception 'ehr.offline_audit_patient_allowed: %', array_to_string(failures, '; ');
  end if;
end
$$;
reset role;

-- 5. A disabled account no longer resolves (auth.account_id_for_subject), so
-- even its open grant answers false.
update auth.accounts set status = 'disabled' where id = '99a10000-0000-4000-8000-000000000001';
set local role hid_ehr_runtime;
do $$
begin
  perform set_config('app.actor_subject', 'staff:offline-audit-a', true),
          set_config('app.membership_id', '99a50000-0000-4000-8000-000000000001', true),
          set_config('app.facility_id', '99a30000-0000-4000-8000-000000000002', true);
  if ehr.offline_audit_patient_allowed('99a20000-0000-4000-8000-000000000001') then
    raise exception 'A disabled account''s grant still answered true';
  end if;
end
$$;
reset role;

-- 6. Not callable by the Identity runtime, nor by a role with only what PUBLIC
-- would have (USAGE on schema ehr).
create role offline_audit_0099_probe nologin noinherit;
grant usage on schema ehr to offline_audit_0099_probe;
do $$
declare
  probe text;
begin
  foreach probe in array array['hid_identity_runtime', 'offline_audit_0099_probe'] loop
    execute format('set local role %I', probe);
    begin
      perform ehr.offline_audit_patient_allowed('99a20000-0000-4000-8000-000000000001');
      raise exception 'ehr.offline_audit_patient_allowed was callable by %', probe;
    exception when insufficient_privilege then
      null;
    end;
    reset role;
  end loop;
end
$$;

rollback;
