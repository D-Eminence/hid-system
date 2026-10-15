\set ON_ERROR_STOP on
-- Break-glass at launch, with limits (0095; owner decision of 2026-10-14,
-- decision D9, ADR-058 addendum). This suite inserts no purpose code and
-- grants no permission: it requires what the migrations leave, then runs
-- activation as the exact Identity API runtime role and the emergency read as
-- the exact EHR API runtime role. Rollback-only.
--
-- 1. identity.break-glass.write is held by exactly doctor, clinician and
--    nurse, the roles 0010 granted it to before 0091 withdrew it. They keep
--    identity.consent.write (the activation route needs it too),
--    identity.patient.read (the lookup that opens the record) and the
--    encounter and note reads (the emergency summary route), and no role
--    holds any other permission 0084 or 0091 withdrew.
-- 2. An active 'emergency' purpose of use exists: 0095's row, or a row an
--    operator inserted earlier, which 0095 keeps as it is (the rehearsal's
--    fresh builds check 0095's exact row). No healthcare-operations row
--    exists, from any source (N3; P11).
-- 3. The control, whatever this database holds: inside this transaction a
--    platform administrator sets break_glass_enabled off and then on through
--    platform.admin_set_control, the command behind POST /admin/controls. Off,
--    the control check Identity runs before the command refuses; on, it
--    passes.
-- 4. A doctor, a clinician and a nurse each activate break-glass once (a
--    second call replays the grant); each grant authorizes the emergency read
--    of that patient at that facility only: no write, no direct-care read, no
--    other facility. The EHR runtime reads that facility's encounter, note and
--    document only (B1; document reads under emergency are unchanged pending
--    N3), and the write predicate of every EHR insert and update policy stays
--    false. The activation is audited, notified and placed in the patient's
--    inbox. A lab member, a pharmacist, a receptionist, an admin and an org
--    admin of the same facility are refused, and nothing is written for them.
-- 5. Deactivating the emergency code, the operator's switch, refuses
--    activation (22023, which Identity answers 423 BREAK_GLASS_DISABLED) and
--    the emergency read of a grant already made.
begin;
set constraints all deferred;

do $$
declare
  found text;
begin
  select string_agg(role_code, ',' order by role_code) into found
    from auth.role_permissions
   where permission_code = 'identity.break-glass.write';
  if found is distinct from 'clinician,doctor,nurse' then
    raise exception 'identity.break-glass.write is not held by exactly clinician, doctor and nurse (0010, 0095): %',
      coalesce(found, 'no role');
  end if;
  if not exists (select 1 from auth.permissions where code = 'identity.break-glass.write' and active) then
    raise exception 'identity.break-glass.write is not an active permission';
  end if;
  select string_agg(format('%s holds %s', role_code, permission_code), ', ' order by role_code, permission_code)
    into found
    from auth.role_permissions
   where permission_code ~ '^(lab|pharmacy|ocr|outreach)\.'
      or permission_code in ('ehr.lab-request.write', 'ehr.document.write');
  if found is not null then
    raise exception 'a permission the launch module set withdrew is held again: %', found;
  end if;
  select string_agg(format('%s lacks %s', expected.role_code, expected.permission_code), ', '
                    order by expected.role_code, expected.permission_code)
    into found
    from unnest(array['doctor', 'clinician', 'nurse']) expected_role(role_code)
   cross join lateral (
     select expected_role.role_code, permission_code
       from unnest(array['identity.consent.write', 'identity.patient.read', 'ehr.encounter.read',
                         'ehr.note.read']) permission_code
   ) expected
   where not exists (select 1 from auth.role_permissions held
                      where held.role_code = expected.role_code
                        and held.permission_code = expected.permission_code);
  if found is not null then
    raise exception 'a break-glass role lacks a permission activation or the emergency summary needs: %', found;
  end if;

  select format('%s|%s|%s', display, active::text, source_system) into found
    from identity.purpose_of_use_codes
   where code = 'emergency';
  if found is null or found not like '%|true|%' then
    raise exception 'no active emergency purpose of use exists (0095 seeds it and keeps an operator''s row): %',
      coalesce(found, 'missing');
  end if;
  select format('%s|%s|%s', display, active::text, source_system) into found
    from identity.purpose_of_use_codes
   where code = 'healthcare-operations';
  if found is not null then
    raise exception 'a healthcare-operations purpose of use exists, which waits on decision N3 (P11): %', found;
  end if;
end $$;

-- One organization with facilities A and B. Doctor, clinician, nurse, lab,
-- pharmacist, receptionist, admin and org admin each have one membership at A
-- (accounts and memberships numbered 1 to 8); the doctor also works at B
-- (membership 9). The patient has an account, so the inbox can be checked.
insert into identity.organizations (id, name, slug) values
  ('b6a00000-0000-4000-8000-000000000001', 'Break-glass Launch Organization', 'break-glass-launch-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('b6a00000-0000-4000-8000-000000000002', 'b6a00000-0000-4000-8000-000000000001',
   'Break-glass Launch Emergency Room', 'BG-LAUNCH-A', 'Africa/Lagos', true, 'verified'),
  ('b6a00000-0000-4000-8000-000000000003', 'b6a00000-0000-4000-8000-000000000001',
   'Break-glass Launch Clinic', 'BG-LAUNCH-B', 'Africa/Lagos', true, 'verified');
create temporary table break_glass_staff (n integer primary key, role_code text not null) on commit drop;
insert into break_glass_staff values
  (1, 'doctor'), (2, 'clinician'), (3, 'nurse'), (4, 'lab'), (5, 'pharmacist'), (6, 'receptionist'),
  (7, 'admin'), (8, 'org_admin');
insert into auth.accounts (id, subject, email, display_name, status)
select ('b6b00000-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:break-glass-launch:' || role_code,
       'break-glass-launch-' || replace(role_code, '_', '-') || '@example.invalid',
       'Break-glass Launch ' || role_code, 'active'
  from break_glass_staff;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('b6c00000-0000-4000-8000-00000000000' || n)::uuid, ('b6b00000-0000-4000-8000-00000000000' || n)::uuid,
       'Break-glass Launch ' || role_code,
       'break-glass-launch-' || replace(role_code, '_', '-') || '@example.invalid', 'verified', role_code
  from break_glass_staff;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('b6d00000-0000-4000-8000-00000000000' || n)::uuid, ('b6c00000-0000-4000-8000-00000000000' || n)::uuid,
       ('b6b00000-0000-4000-8000-00000000000' || n)::uuid, 'b6a00000-0000-4000-8000-000000000001',
       'b6a00000-0000-4000-8000-000000000002', role_code, role_code, true, true
  from break_glass_staff;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('b6d00000-0000-4000-8000-000000000009', 'b6c00000-0000-4000-8000-000000000001',
   'b6b00000-0000-4000-8000-000000000001', 'b6a00000-0000-4000-8000-000000000001',
   'b6a00000-0000-4000-8000-000000000003', 'doctor', 'doctor', false, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('b6e00000-0000-4000-8000-00000000000' || n)::uuid, ('b6b00000-0000-4000-8000-00000000000' || n)::uuid,
       role_code, 'facility', ('b6d00000-0000-4000-8000-00000000000' || n)::uuid,
       'b6a00000-0000-4000-8000-000000000002', 'Break-glass launch suite role'
  from break_glass_staff;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('b6e00000-0000-4000-8000-000000000009', 'b6b00000-0000-4000-8000-000000000001', 'doctor', 'facility',
   'b6d00000-0000-4000-8000-000000000009', 'b6a00000-0000-4000-8000-000000000003', 'Break-glass launch suite role');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('b6b00000-0000-4000-8000-000000000010', 'synthetic:break-glass-launch:patient',
   'break-glass-launch-patient@example.invalid', 'Break-glass Launch Patient', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('b6f00000-0000-4000-8000-000000000001', 'b6b00000-0000-4000-8000-000000000010', 'HID-BGLAUNCH',
   'Launch', 'Patient', 'Launch Patient', 'active');
-- The platform administrator who sets the control (step 3).
insert into auth.accounts (id, subject, email, display_name, status) values
  ('b6b00000-0000-4000-8000-000000000011', 'synthetic:break-glass-launch:platform-admin',
   'break-glass-launch-platform-admin@example.invalid', 'Break-glass Launch Platform Admin', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('b6e00000-0000-4000-8000-000000000011', 'b6b00000-0000-4000-8000-000000000011', 'platform_super_admin',
   'platform', 'Break-glass launch suite platform administrator');
-- One completed encounter at each facility, inserted without triggers (no
-- version actor is needed for a fixture; CHECK constraints still apply).
set local session_replication_role = replica;
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
  status, started_at, ended_at) values
  ('b6900000-0000-4000-8000-000000000001', 'b6f00000-0000-4000-8000-000000000001',
   'b6a00000-0000-4000-8000-000000000002', 'b6b00000-0000-4000-8000-000000000001',
   'b6d00000-0000-4000-8000-000000000001', 'ambulatory', 'completed',
   clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour'),
  ('b6900000-0000-4000-8000-000000000002', 'b6f00000-0000-4000-8000-000000000001',
   'b6a00000-0000-4000-8000-000000000003', 'b6b00000-0000-4000-8000-000000000001',
   'b6d00000-0000-4000-8000-000000000009', 'ambulatory', 'completed',
   clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour');
-- A signed note and an uploaded document at each facility.
insert into ehr.clinical_notes (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  note_type, title, status, signed_at, signed_by) values
  ('b6910000-0000-4000-8000-000000000001', 'b6900000-0000-4000-8000-000000000001',
   'b6f00000-0000-4000-8000-000000000001', 'b6a00000-0000-4000-8000-000000000002',
   'b6b00000-0000-4000-8000-000000000001', 'b6d00000-0000-4000-8000-000000000001', 'progress',
   'Emergency room note', 'signed', clock_timestamp() - interval '1 hour', 'b6b00000-0000-4000-8000-000000000001'),
  ('b6910000-0000-4000-8000-000000000002', 'b6900000-0000-4000-8000-000000000002',
   'b6f00000-0000-4000-8000-000000000001', 'b6a00000-0000-4000-8000-000000000003',
   'b6b00000-0000-4000-8000-000000000001', 'b6d00000-0000-4000-8000-000000000009', 'progress',
   'Clinic note', 'signed', clock_timestamp() - interval '1 hour', 'b6b00000-0000-4000-8000-000000000001');
insert into ehr.documents (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  original_file_name, storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex,
  retention_class, status) values
  ('b6920000-0000-4000-8000-000000000001', 'b6900000-0000-4000-8000-000000000001',
   'b6f00000-0000-4000-8000-000000000001', 'b6a00000-0000-4000-8000-000000000002',
   'b6b00000-0000-4000-8000-000000000001', 'b6d00000-0000-4000-8000-000000000001', 'referral.pdf',
   'synthetic-bucket', 'synthetic/break-glass-launch/a', 'v1', 'application/pdf', 1024, repeat('a', 64),
   'clinical-record', 'uploaded'),
  ('b6920000-0000-4000-8000-000000000002', 'b6900000-0000-4000-8000-000000000002',
   'b6f00000-0000-4000-8000-000000000001', 'b6a00000-0000-4000-8000-000000000003',
   'b6b00000-0000-4000-8000-000000000001', 'b6d00000-0000-4000-8000-000000000009', 'clinic-letter.pdf',
   'synthetic-bucket', 'synthetic/break-glass-launch/b', 'v1', 'application/pdf', 1024, repeat('b', 64),
   'clinical-record', 'uploaded');
set local session_replication_role = origin;

-- 3. The control. Whatever this database holds (0091 left it off where 0039's
-- seed was untouched; an operator may have changed it since), a platform
-- administrator sets it off and then on inside this transaction through
-- platform.admin_set_control, the command behind the audited
-- POST /admin/controls. Identity runs platform.require_control_enabled
-- before the command in the same transaction (consent.service.ts) and
-- answers its refusal 423 BREAK_GLASS_DISABLED.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:break-glass-launch:platform-admin', true),
       set_config('app.correlation_id', 'break-glass-launch-control-0001', true),
       set_config('app.purpose_of_use', 'healthcare-operations', true),
       set_config('app.facility_id', '', true),
       set_config('app.membership_id', '', true),
       set_config('app.access_scope', 'platform', true);
do $$
declare
  current_version bigint;
  changed record;
begin
  select listed.row_version into current_version
    from platform.admin_list_controls() listed where listed.control_key = 'break_glass_enabled';
  select * into changed from platform.admin_set_control('break_glass_enabled', false, current_version,
    'Break-glass launch suite sets the control off');
  if changed.enabled then
    raise exception 'the platform administrator could not set break_glass_enabled off: %', row_to_json(changed);
  end if;
  begin
    perform platform.require_control_enabled('break_glass_enabled');
    raise exception 'the break_glass_enabled check passed with the control off';
  exception when sqlstate '55000' then
    if sqlerrm is distinct from 'PLATFORM_CONTROL_DISABLED:break_glass_enabled' then
      raise;
    end if;
  end;
  select * into changed from platform.admin_set_control('break_glass_enabled', true, changed.row_version,
    'Break-glass launch suite turns the control on (P11 operator step)');
  if not changed.enabled or changed.replayed then
    raise exception 'the platform administrator could not turn break_glass_enabled on: %', row_to_json(changed);
  end if;
end $$;
select platform.require_control_enabled('break_glass_enabled');
select set_config('app.access_scope', '', true);
reset role;
do $$
begin
  if (select format('%s|%s', event.enabled::text, account.subject)
        from platform.control_events event
        join auth.accounts account on account.id = event.actor_account_id
       where event.control_key = 'break_glass_enabled'
       order by event.sequence_id desc limit 1)
     is distinct from 'true|synthetic:break-glass-launch:platform-admin' then
    raise exception 'turning break_glass_enabled on left no control event naming the platform administrator';
  end if;
end $$;
set local role hid_identity_api_runtime;

-- 4. Activation by each role that holds the permission, and the refusal of
-- every other facility role.
do $$
declare
  actor record;
  activated record;
  replay record;
  facility_a constant uuid := 'b6a00000-0000-4000-8000-000000000002';
  facility_b constant uuid := 'b6a00000-0000-4000-8000-000000000003';
  patient constant uuid := 'b6f00000-0000-4000-8000-000000000001';
  subject text;
  membership uuid;
begin
  for actor in select * from (values (1, 'doctor'), (2, 'clinician'), (3, 'nurse'), (4, 'lab'),
                                      (5, 'pharmacist'), (6, 'receptionist'), (7, 'admin'), (8, 'org_admin'))
                      staff_role(n, role_code) order by n loop
    subject := 'synthetic:break-glass-launch:' || actor.role_code;
    membership := ('b6d00000-0000-4000-8000-00000000000' || actor.n)::uuid;
    perform set_config('app.actor_subject', subject, true),
            set_config('app.membership_id', membership::text, true),
            set_config('app.facility_id', facility_a::text, true),
            set_config('app.correlation_id', 'break-glass-launch-' || actor.role_code, true),
            set_config('app.purpose_of_use', 'emergency', true);
    if actor.role_code in ('doctor', 'clinician', 'nurse') then
      select * into activated
        from identity.activate_break_glass(' hid-bglaunch ', 'Unconscious patient in the emergency room', 15);
      if activated.grant_status is distinct from 'active' or activated.existing_grant
         or activated.subject_patient_id is distinct from patient
         or activated.expires_at not between clock_timestamp() + interval '14 minutes'
                                         and clock_timestamp() + interval '15 minutes' then
        raise exception 'a % could not activate break-glass: %', actor.role_code, row_to_json(activated);
      end if;
      select * into replay
        from identity.activate_break_glass('HID-BGLAUNCH', 'Repeated emergency activation request', 240);
      if replay.consent_grant_id is distinct from activated.consent_grant_id or not replay.existing_grant
         or replay.expires_at is distinct from activated.expires_at then
        raise exception 'a %''s second activation did not replay the grant unchanged', actor.role_code;
      end if;
      if not identity.has_active_consent_grant(patient, subject, membership, facility_a,
                                               'read_records', 'emergency', clock_timestamp()) then
        raise exception 'a %''s break-glass grant does not authorize the emergency read', actor.role_code;
      end if;
      if identity.has_active_consent_grant(patient, subject, membership, facility_a,
                                           'write_records', 'emergency', clock_timestamp()) then
        raise exception 'a %''s break-glass grant authorizes a write', actor.role_code;
      end if;
      if identity.has_active_consent_grant(patient, subject, membership, facility_a,
                                           'read_records', 'direct-care', clock_timestamp()) then
        raise exception 'a %''s break-glass grant authorizes a direct-care read', actor.role_code;
      end if;
    else
      begin
        perform identity.activate_break_glass('HID-BGLAUNCH', 'Unconscious patient in the emergency room', 15);
        raise exception 'a % activated break-glass without identity.break-glass.write', actor.role_code;
      exception when sqlstate '42501' then
        if sqlerrm is distinct from 'Authorized break-glass context is required' then
          raise;
        end if;
      end;
    end if;
  end loop;
  -- The doctor's grant at A does not reach the doctor's membership at B.
  if identity.has_active_consent_grant(patient, 'synthetic:break-glass-launch:doctor',
       'b6d00000-0000-4000-8000-000000000009', facility_b, 'read_records', 'emergency', clock_timestamp()) then
    raise exception 'a break-glass grant at one facility authorized the emergency read at another';
  end if;
end $$;
reset role;

do $$
begin
  if (select string_agg(account.subject, ',' order by account.subject)
        from identity.consent_grants grant_row
        join auth.accounts account on account.id = grant_row.account_id
       where grant_row.patient_id = 'b6f00000-0000-4000-8000-000000000001'
         and grant_row.break_glass and grant_row.scope = 'break_glass' and grant_row.status = 'active'
         and grant_row.purpose_of_use = 'emergency'
         and grant_row.facility_id = 'b6a00000-0000-4000-8000-000000000002')
     is distinct from 'synthetic:break-glass-launch:clinician,synthetic:break-glass-launch:doctor,'
                      || 'synthetic:break-glass-launch:nurse'
     or (select count(*) from identity.consent_grants
          where patient_id = 'b6f00000-0000-4000-8000-000000000001') <> 3 then
    raise exception 'break-glass did not leave exactly one emergency grant for each of the three roles';
  end if;
  if (select count(*) from audit.events
       where patient_id = 'b6f00000-0000-4000-8000-000000000001'
         and action = 'identity.break-glass.activate' and outcome = 'success'
         and purpose_of_use = 'emergency' and details->>'review_required' = 'true') <> 3
     or (select count(*) from audit.events
          where patient_id = 'b6f00000-0000-4000-8000-000000000001'
            and action = 'identity.break-glass.replay') <> 3 then
    raise exception 'break-glass activations and replays were not audited exactly once each';
  end if;
  if exists (select 1 from audit.events
              where action like 'identity.break-glass.%'
                and actor_account_id in (select ('b6b00000-0000-4000-8000-00000000000' || n)::uuid
                                           from break_glass_staff where n >= 4)) then
    raise exception 'a refused activation left an audit row';
  end if;
  if (select count(*) from identity.outbox_events
       where patient_id = 'b6f00000-0000-4000-8000-000000000001'
         and event_type = 'EmergencyAccessActivated') <> 3 then
    raise exception 'break-glass did not record exactly one notification intent per new grant';
  end if;
  if (select count(*) from notification.inbox_items
       where patient_id = 'b6f00000-0000-4000-8000-000000000001'
         and notification_code = 'EMERGENCY_ACCESS_ACTIVATED') <> 3 then
    raise exception 'the patient''s inbox was not told of each emergency access';
  end if;
end $$;

-- The emergency read (B1): the EHR runtime reads the facility of the grant
-- only, and only under the emergency purpose. Row-level security decides at
-- the transaction's start time (current_timestamp), and the grants above were
-- made later in this same transaction, so their start is moved back to it
-- first, without triggers (a fixture adjustment; CHECK constraints apply).
set local session_replication_role = replica;
update identity.consent_grants set starts_at = current_timestamp - interval '1 second'
 where patient_id = 'b6f00000-0000-4000-8000-000000000001';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select set_config('app.actor_subject', 'synthetic:break-glass-launch:nurse', true),
       set_config('app.membership_id', 'b6d00000-0000-4000-8000-000000000003', true),
       set_config('app.facility_id', 'b6a00000-0000-4000-8000-000000000002', true),
       set_config('app.correlation_id', 'break-glass-launch-read-0001', true),
       set_config('app.purpose_of_use', 'emergency', true);
do $$
declare
  patient constant uuid := 'b6f00000-0000-4000-8000-000000000001';
begin
  if (select array_agg(id order by id) from ehr.encounters where patient_id = patient)
     is distinct from array['b6900000-0000-4000-8000-000000000001']::uuid[] then
    raise exception 'the nurse''s emergency read did not return exactly the encounter of the grant''s facility';
  end if;
  if (select array_agg(id order by id) from ehr.clinical_notes where patient_id = patient)
     is distinct from array['b6910000-0000-4000-8000-000000000001']::uuid[] then
    raise exception 'the nurse''s emergency read did not return exactly the note of the grant''s facility';
  end if;
  -- Document reads under emergency are unchanged (N3 pending; D9 row): the
  -- grant's facility's documents only, as the emergency summary lists them and
  -- as GET /ehr/documents and its download authorize them.
  if (select array_agg(id order by id) from ehr.documents where patient_id = patient)
     is distinct from array['b6920000-0000-4000-8000-000000000001']::uuid[] then
    raise exception 'the nurse''s emergency read did not return exactly the document of the grant''s facility';
  end if;
  -- Every EHR insert and update policy (0005) checks this predicate.
  if ehr.context_allows(patient, 'b6a00000-0000-4000-8000-000000000002', 'write_records') then
    raise exception 'a break-glass grant passed the EHR write policies';
  end if;
  perform set_config('app.purpose_of_use', 'direct-care', true);
  if exists (select 1 from ehr.encounters where patient_id = patient)
     or exists (select 1 from ehr.clinical_notes where patient_id = patient)
     or exists (select 1 from ehr.documents where patient_id = patient) then
    raise exception 'a break-glass grant authorized a direct-care read';
  end if;
  perform set_config('app.actor_subject', 'synthetic:break-glass-launch:doctor', true),
          set_config('app.membership_id', 'b6d00000-0000-4000-8000-000000000009', true),
          set_config('app.facility_id', 'b6a00000-0000-4000-8000-000000000003', true),
          set_config('app.purpose_of_use', 'emergency', true);
  if exists (select 1 from ehr.encounters where patient_id = patient)
     or exists (select 1 from ehr.clinical_notes where patient_id = patient)
     or exists (select 1 from ehr.documents where patient_id = patient) then
    raise exception 'the doctor''s break-glass grant at A authorized an emergency read at B';
  end if;
end $$;
reset role;

-- 5. The operator retires the emergency purpose: activation and the read of
-- an existing grant are refused at once.
update identity.purpose_of_use_codes set active = false where code = 'emergency';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:break-glass-launch:nurse', true),
       set_config('app.membership_id', 'b6d00000-0000-4000-8000-000000000003', true),
       set_config('app.facility_id', 'b6a00000-0000-4000-8000-000000000002', true),
       set_config('app.correlation_id', 'break-glass-launch-retired-0001', true),
       set_config('app.purpose_of_use', 'emergency', true);
do $$
begin
  begin
    perform identity.activate_break_glass('HID-BGLAUNCH', 'Unconscious patient in the emergency room', 15);
    raise exception 'break-glass was activated with the emergency purpose of use deactivated';
  exception when sqlstate '22023' then
    if sqlerrm is distinct from 'Break-glass requires the emergency purpose of use' then
      raise;
    end if;
  end;
  if identity.has_active_consent_grant('b6f00000-0000-4000-8000-000000000001',
       'synthetic:break-glass-launch:nurse', 'b6d00000-0000-4000-8000-000000000003',
       'b6a00000-0000-4000-8000-000000000002', 'read_records', 'emergency', clock_timestamp()) then
    raise exception 'a break-glass grant was honoured after the emergency purpose of use was deactivated';
  end if;
end $$;
reset role;
rollback;
