\set ON_ERROR_STOP on
-- The patient's revocation of a grant they gave, the access history's labels,
-- and no new inbox item for a deleted login (0087; main 0066 items 2-4, whose
-- suite eb9b1ca:services/ehr-api/database/tests/patient-access-safety.integration.sql
-- this follows, adapted: grants come from this branch's producers, 0072
-- approval, 0075 PIN verification and 0031 break-glass, and the cases main
-- leaves out are added: a PIN-derived grant, an expired grant, a short reason,
-- a replay after another revoker, a legacy row whose scope is break_glass,
-- the deleted-login rule through a real caller, the history's limit keeping
-- every revocable grant (3b), the facility-visible audit reason (6), and the
-- advisory key taken by the revocation itself, on a patient whose key nothing
-- else in this transaction takes (8)).
-- Rollback-only. Synthetic values only; uuid prefix 87.
set plpgsql.variable_conflict = error;
begin;

-- 1. Security properties and privileges.
do $$
declare
  extra text;
  role_name text;
begin
  if not exists (select 1 from pg_proc where oid = 'identity.revoke_my_consent_grant(text,uuid,uuid,text)'::regprocedure
                  and prosecdef and provolatile = 'v'
                  and proconfig = '{"search_path=pg_catalog, identity, auth, audit, platform, pg_temp"}'::text[]) then
    raise exception 'identity.revoke_my_consent_grant lost SECURITY DEFINER, VOLATILE or its search_path';
  end if;
  if not exists (select 1 from pg_proc where oid = 'identity.patient_self_access_history(text,uuid)'::regprocedure
                  and prosecdef and provolatile = 's' and proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[])
     or not exists (select 1 from pg_proc where oid = 'notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)'::regprocedure
                  and prosecdef and provolatile = 'v'
                  and proconfig = '{"search_path=pg_catalog, notification, identity, auth, pg_temp"}'::text[]) then
    raise exception 'A replaced function changed its security properties';
  end if;
  select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', '
      order by privilege.grantee::regrole::text) into extra
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
   where p.oid = 'identity.revoke_my_consent_grant(text,uuid,uuid,text)'::regprocedure
     and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner;
  if extra is distinct from 'hid_identity_runtime, hid_schema_test_runtime' then
    raise exception 'identity.revoke_my_consent_grant is executable by %', coalesce(extra, 'its owner only');
  end if;
  if not has_function_privilege('hid_identity_api_runtime', 'identity.revoke_my_consent_grant(text,uuid,uuid,text)', 'EXECUTE') then
    raise exception 'The Identity API runtime cannot revoke';
  end if;
  foreach role_name in array array['hid_ehr_api_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_api_runtime',
      'hid_outreach_api_runtime', 'hid_notification_worker', 'hid_event_dispatcher'] loop
    if has_function_privilege(role_name, 'identity.revoke_my_consent_grant(text,uuid,uuid,text)', 'EXECUTE')
       or has_function_privilege(role_name, 'notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', 'EXECUTE') then
      raise exception 'Unrelated service % can revoke a grant or enqueue an inbox item', role_name;
    end if;
  end loop;
  if has_function_privilege('hid_identity_api_runtime', 'notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', 'EXECUTE') then
    raise exception 'The inbox enqueue must stay owner-only';
  end if;
end $$;

-- 2. Fixtures: a doctor, three patients with a live patient session each (P3
-- is used only by case 8).
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'revocation-test'), ('emergency', 'Emergency treatment', 'revocation-test')
  on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status) values
  ('87100000-0000-4000-8000-000000000001', 'staff:revocation-doctor', 'revocation-doctor@example.invalid', 'Revocation Doctor', 'active'),
  ('87100000-0000-4000-8000-000000000002', 'synthetic:revocation:p1', 'revocation-p1@example.invalid', 'Revocation P1', 'active'),
  ('87100000-0000-4000-8000-000000000003', 'synthetic:revocation:p2', 'revocation-p2@example.invalid', 'Revocation P2', 'active'),
  ('87100000-0000-4000-8000-000000000004', 'synthetic:revocation:p3', 'revocation-p3@example.invalid', 'Revocation P3', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('87200000-0000-4000-8000-000000000001', '87100000-0000-4000-8000-000000000002', 'HID-RVKPAAA', 'Ada', 'Revoke', 'Ada Revoke', 'active'),
  ('87200000-0000-4000-8000-000000000002', '87100000-0000-4000-8000-000000000003', 'HID-RVKPBBB', 'Bola', 'Revoke', 'Bola Revoke', 'active'),
  ('87200000-0000-4000-8000-000000000003', '87100000-0000-4000-8000-000000000004', 'HID-RVKPCCC', 'Chidi', 'Revoke', 'Chidi Revoke', 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('87300000-0000-4000-8000-00000000000' || n)::uuid, ('87100000-0000-4000-8000-00000000000' || (n + 1))::uuid,
  ('87300000-0000-4000-8000-00000000000' || n)::uuid, md5('revocation' || n) || md5('revocation' || n), gen_random_uuid(), 1,
  'password', clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
  'patient', ('87200000-0000-4000-8000-00000000000' || n)::uuid
from generate_series(1, 3) n;
-- A third session of P1, revoked.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id, revoked_at, revocation_reason)
values ('87300000-0000-4000-8000-000000000009', '87100000-0000-4000-8000-000000000002', '87300000-0000-4000-8000-000000000009',
  md5('revocation9') || md5('revocation9'), gen_random_uuid(), 1, 'password', clock_timestamp(),
  clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
  '87200000-0000-4000-8000-000000000001', clock_timestamp(), 'synthetic-test');
insert into identity.organizations (id, name, slug) values
  ('87400000-0000-4000-8000-000000000001', 'Revocation Test Org', 'revocation-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('87400000-0000-4000-8000-000000000002', '87400000-0000-4000-8000-000000000001', 'Revocation Test Hospital', 'RVK-A',
   'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('87500000-0000-4000-8000-000000000001', '87100000-0000-4000-8000-000000000001', 'Revocation Doctor',
   'revocation-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('87600000-0000-4000-8000-000000000001', '87500000-0000-4000-8000-000000000001', '87100000-0000-4000-8000-000000000001',
   '87400000-0000-4000-8000-000000000001', '87400000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('87700000-0000-4000-8000-000000000001', '87100000-0000-4000-8000-000000000001', 'doctor', 'facility',
   '87600000-0000-4000-8000-000000000001', '87400000-0000-4000-8000-000000000002', 'Revocation test doctor');

-- Transaction contexts as Identity sets them.
create function pg_temp.as_staff(purpose text, correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'staff:revocation-doctor', true),
    set_config('app.facility_id', '87400000-0000-4000-8000-000000000002', true),
    set_config('app.membership_id', '87600000-0000-4000-8000-000000000001', true),
    set_config('app.purpose_of_use', purpose, true), set_config('app.correlation_id', correlation, true);
$$;
-- withSystemTransaction, then set_config('app.actor_subject', subject).
create function pg_temp.as_patient(n integer, correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:revocation:p' || n, true),
    set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.try_revoke(subject text, session text, grant_id text, reason text) returns text
language plpgsql as $$
declare
  outcome record;
begin
  select * into outcome from identity.revoke_my_consent_grant(subject, session::uuid, grant_id::uuid, reason);
  return format('ok %s replayed=%s', outcome.grant_status, outcome.replayed);
exception when others then
  return format('%s %s', sqlstate, sqlerrm);
end $$;
create function pg_temp.history(n integer) returns jsonb language sql as $$
  select identity.patient_self_access_history('synthetic:revocation:p' || n, ('87300000-0000-4000-8000-00000000000' || n)::uuid);
$$;
create function pg_temp.label(n integer, grant_id text) returns text language sql as $$
  select format('%s/%s/%s', item->>'status', item->'breakGlass', item->'revocableByPatient')
    from jsonb_array_elements(pg_temp.history(n)->'items') item where item->>'consentGrantId' = grant_id;
$$;
grant execute on function pg_temp.as_staff(text, text), pg_temp.as_patient(integer, text),
  pg_temp.try_revoke(text, text, text, text), pg_temp.history(integer), pg_temp.label(integer, text) to public;

-- Grants from this branch's producers, as the Identity API runtime.
set local role hid_identity_api_runtime;
select pg_temp.as_staff('direct-care', 'revocation-request-01');
select set_config('hid.request_write', (select access_request_id::text
  from identity.create_access_request('HID-RVKPAAA', 'write_records', 'Follow-up visit for review', 60)), true);
select set_config('hid.request_read', (select access_request_id::text
  from identity.create_access_request('HID-RVKPAAA', 'read_records', 'Second opinion for review', 60)), true);
select pg_temp.as_patient(1, 'revocation-approve-01');
select set_config('hid.approved', (select consent_grant_id::text
  from identity.approve_access_request(current_setting('hid.request_write')::uuid)), true);
select set_config('hid.approved_closed', (select consent_grant_id::text
  from identity.approve_access_request(current_setting('hid.request_read')::uuid)), true);
select pg_temp.as_patient(1, 'revocation-pin-01');
select identity.set_my_patient_access_pin('synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', '2468');
select pg_temp.as_staff('direct-care', 'revocation-pin-02');
select set_config('hid.pin', (select consent_grant_id::text from identity.access_patient_with_pin('HID-RVKPAAA', '2468', 15)), true);
select pg_temp.as_staff('emergency', 'revocation-break-glass-01');
select set_config('hid.break_glass', (select consent_grant_id::text
  from identity.activate_break_glass('HID-RVKPAAA', 'Unconscious patient in the emergency room', 30)), true);
reset role;

-- A workforce grant (no grantor, no PIN), an expired patient-approved grant,
-- and a legacy-imported row whose scope is break_glass but whose flag is
-- false (allowed for source_system <> 'hid'): direct inserts as the owner.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, granted_by_patient_id,
  source_system, migration_hold_reason) values
  ('87800000-0000-4000-8000-00000000000d', '87200000-0000-4000-8000-000000000001', '87500000-0000-4000-8000-000000000001',
   '87100000-0000-4000-8000-000000000001', '87600000-0000-4000-8000-000000000001', '87400000-0000-4000-8000-000000000002',
   'read_records', 'direct-care', 'active', 'Workforce grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'revocation-workforce-01', null, 'hid', null),
  ('87800000-0000-4000-8000-00000000000e', '87200000-0000-4000-8000-000000000001', '87500000-0000-4000-8000-000000000001',
   '87100000-0000-4000-8000-000000000001', '87600000-0000-4000-8000-000000000001', '87400000-0000-4000-8000-000000000002',
   'read_records', 'direct-care', 'active', 'Expired approval', clock_timestamp() - interval '2 hours',
   clock_timestamp() - interval '1 hour', false, 'revocation-expired-01', '87200000-0000-4000-8000-000000000001', 'hid', null),
  ('87800000-0000-4000-8000-00000000000f', '87200000-0000-4000-8000-000000000001', '87500000-0000-4000-8000-000000000001',
   '87100000-0000-4000-8000-000000000001', '87600000-0000-4000-8000-000000000001', '87400000-0000-4000-8000-000000000002',
   'break_glass', null, 'active', 'Legacy emergency row', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, null, '87200000-0000-4000-8000-000000000001', 'legacy_identity',
   'legacy_grant_purpose_unmapped');

-- 3. Labels: each item has exactly 0030's eight keys plus breakGlass and
-- revocableByPatient; only the patient-approved and PIN-derived grants are
-- revocable, never with breakGlass.
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'revocation-history-01');
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s=%s', expected.grant_id, pg_temp.label(1, expected.grant_id)), '; ') into mismatch
    from (values (current_setting('hid.approved'), 'active/false/true'),
                 (current_setting('hid.approved_closed'), 'active/false/true'),
                 (current_setting('hid.pin'), 'active/false/true'),
                 (current_setting('hid.break_glass'), 'active/true/false'),
                 ('87800000-0000-4000-8000-00000000000d', 'active/false/false'),
                 ('87800000-0000-4000-8000-00000000000e', 'expired/false/false'),
                 ('87800000-0000-4000-8000-00000000000f', 'active/true/false')) expected(grant_id, label)
   where pg_temp.label(1, expected.grant_id) is distinct from expected.label;
  if mismatch is not null then raise exception 'Access-history labels differ: %', mismatch; end if;
  if exists (select 1 from jsonb_array_elements(pg_temp.history(1)->'items') item
              where (select array_agg(key order by key) from jsonb_object_keys(item) key)
                    <> array['breakGlass','consentGrantId','expiresAt','facilityName','purpose','reason',
                             'revocableByPatient','scope','startsAt','status']
                 or ((item->>'breakGlass')::boolean and (item->>'revocableByPatient')::boolean)) then
    raise exception 'An access-history item has other keys, or is both break-glass and revocable';
  end if;
end $$;
select pg_temp.as_patient(2, 'revocation-history-02');
do $$
begin
  if pg_temp.history(2) is distinct from '{"items": []}'::jsonb then
    raise exception 'An empty history must stay {"items": []}: %', pg_temp.history(2);
  end if;
  if identity.patient_self_access_history('synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001') is not null then
    raise exception 'The history must answer NULL to another patient''s bound subject';
  end if;
end $$;

-- 3b. The limit of 50 keeps every revocable grant. 55 newer workforce grants
-- (not revocable) would push the three revocable grants out of 0030's
-- newest-50 window; 0087 keeps them, fills the rest with the newest, and
-- lists all 50 newest first. The filler is removed again before case 4.
reset role;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, source_system)
select ('87900000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, '87200000-0000-4000-8000-000000000001',
  '87500000-0000-4000-8000-000000000001', '87100000-0000-4000-8000-000000000001', '87600000-0000-4000-8000-000000000001',
  '87400000-0000-4000-8000-000000000002', 'read_records', 'direct-care', 'active', 'Workforce filler grant',
  clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour', false, null, 'hid'
from generate_series(1, 55) n;
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'revocation-history-03');
select set_config('hid.capped', pg_temp.history(1)::text, true);
reset role;
do $$
declare
  listed uuid[];
  revocable uuid[] := array[current_setting('hid.approved')::uuid, current_setting('hid.approved_closed')::uuid,
                            current_setting('hid.pin')::uuid];
begin
  select array_agg((entry.item->>'consentGrantId')::uuid order by entry.position) into listed
    from jsonb_array_elements(current_setting('hid.capped')::jsonb->'items') with ordinality entry(item, position);
  if cardinality(listed) <> 50 then
    raise exception 'The history must stay limited to 50 items: %', cardinality(listed);
  end if;
  if not listed @> revocable
     or exists (select 1 from jsonb_array_elements(current_setting('hid.capped')::jsonb->'items') item
                 where (item->>'consentGrantId')::uuid = any(revocable)
                   and (item->>'revocableByPatient')::boolean is not true) then
    raise exception 'A revocable grant fell outside the history''s limit';
  end if;
  if listed is distinct from (select array_agg(grant_row.id order by grant_row.created_at desc, grant_row.id desc)
                                from identity.consent_grants grant_row where grant_row.id = any(listed))
     or (select array_agg(listed_id order by listed_id) from unnest(listed) listed_id where listed_id <> all(revocable))
        is distinct from (select array_agg(newest.id order by newest.id) from (
          select grant_row.id from identity.consent_grants grant_row
           where grant_row.patient_id = '87200000-0000-4000-8000-000000000001' and grant_row.id <> all(revocable)
           order by grant_row.created_at desc, grant_row.id desc limit 47) newest) then
    raise exception 'The history''s 50 items are not the revocable grants plus the newest, newest first';
  end if;
end $$;
delete from identity.consent_grants where id::text like '87900000-%';
set local role hid_identity_api_runtime;

-- 4. Refusals write nothing.
select pg_temp.as_patient(1, 'revocation-refusal-01');
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: %s', expected.label, pg_temp.try_revoke(expected.subject, expected.session, expected.grant_id, expected.reason)), '; ')
    into mismatch
    from (values
      ('break-glass', 'synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', current_setting('hid.break_glass'), 'Not needed',
       '55000 CONSENT_GRANT_NOT_PATIENT_REVOCABLE'),
      ('workforce', 'synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', '87800000-0000-4000-8000-00000000000d', 'Not needed',
       '55000 CONSENT_GRANT_NOT_PATIENT_REVOCABLE'),
      ('legacy break_glass scope', 'synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', '87800000-0000-4000-8000-00000000000f',
       'Not needed', '55000 CONSENT_GRANT_NOT_PATIENT_REVOCABLE'),
      ('expired', 'synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', '87800000-0000-4000-8000-00000000000e', 'Not needed',
       '55000 The access grant is no longer active'),
      ('reason under 3 once trimmed', 'synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', current_setting('hid.approved'),
       '  a  ', '22023 A revocation reason is required'),
      ('reason over 500', 'synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', current_setting('hid.approved'),
       repeat('x', 501), '22023 A revocation reason is required'),
      ('another patient''s session', 'synthetic:revocation:p1', '87300000-0000-4000-8000-000000000002', current_setting('hid.approved'),
       'Not needed', '42501 Patient self session is required'),
      ('a revoked session', 'synthetic:revocation:p1', '87300000-0000-4000-8000-000000000009', current_setting('hid.approved'),
       'Not needed', '42501 Patient self session is required'),
      ('another subject than the bound one', 'synthetic:revocation:p2', '87300000-0000-4000-8000-000000000002',
       current_setting('hid.approved'), 'Not needed', '42501 Patient self session is required'),
      ('an unknown grant', 'synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', '87800000-0000-4000-8000-0000000000ff',
       'Not needed', 'P0002 The access grant is unavailable'))
      expected(label, subject, session, grant_id, reason, outcome)
   where pg_temp.try_revoke(expected.subject, expected.session, expected.grant_id, expected.reason) is distinct from expected.outcome;
  if mismatch is not null then raise exception 'Refusals differ: %', mismatch; end if;
end $$;
select pg_temp.as_patient(2, 'revocation-refusal-02');
do $$
begin
  if pg_temp.try_revoke('synthetic:revocation:p2', '87300000-0000-4000-8000-000000000002', current_setting('hid.approved'), 'Not needed')
     is distinct from 'P0002 The access grant is unavailable' then
    raise exception 'Another patient''s grant must be unavailable, not forbidden';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from identity.consent_grants where patient_id = '87200000-0000-4000-8000-000000000001'
              and (status <> 'active' or row_version <> 1))
     or exists (select 1 from audit.events where action = 'identity.consent-grant.patient-revoke') then
    raise exception 'A refused revocation wrote a grant or an audit row';
  end if;
end $$;

-- 5. Revocation, replay, PIN, and the decision afterwards.
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'revocation-command-01');
do $$
begin
  if pg_temp.try_revoke('synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', current_setting('hid.approved'),
       '  No longer needed  ') is distinct from 'ok revoked replayed=f'
     or pg_temp.try_revoke('synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', current_setting('hid.approved'),
       'Again') is distinct from 'ok revoked replayed=t'
     or pg_temp.try_revoke('synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', current_setting('hid.pin'),
       'Stop PIN access') is distinct from 'ok revoked replayed=f' then
    raise exception 'Revocation or its replay differs';
  end if;
  -- P1's PIN advisory key is already held here by the PIN set and verify
  -- above, so the revocation's own key is asserted on P3 in case 8.
  if pg_temp.label(1, current_setting('hid.approved')) is distinct from 'revoked/false/false'
     or pg_temp.label(1, current_setting('hid.pin')) is distinct from 'revoked/false/false'
     or pg_temp.label(1, current_setting('hid.break_glass')) is distinct from 'active/true/false' then
    raise exception 'The history after revocation differs';
  end if;
end $$;
select pg_temp.as_staff('direct-care', 'revocation-decision-01');
do $$
begin
  if identity.has_active_consent_grant('87200000-0000-4000-8000-000000000001', 'staff:revocation-doctor',
       '87600000-0000-4000-8000-000000000001', '87400000-0000-4000-8000-000000000002', 'write_records', 'direct-care',
       clock_timestamp()) then
    raise exception 'A revoked write grant still authorizes';
  end if;
end $$;
-- A PIN still in force lets the clinician verify again: a new grant, not the revoked one.
select set_config('hid.pin_again', (select consent_grant_id::text from identity.access_patient_with_pin('HID-RVKPAAA', '2468', 15)), true);
-- Replay after another revoker: the clinician closes one approved grant
-- (0010), PIN removal (0033) ends the new PIN grant; the patient's revocation
-- of each then answers replayed with that revocation.
select identity.close_own_consent_grant(current_setting('hid.approved_closed')::uuid, 'Clinician finished this episode');
select pg_temp.as_patient(1, 'revocation-command-02');
select identity.revoke_my_patient_access_pin('synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001');
do $$
begin
  if current_setting('hid.pin_again') = current_setting('hid.pin')
     or pg_temp.try_revoke('synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', current_setting('hid.approved_closed'),
          'Not needed') is distinct from 'ok revoked replayed=t'
     or pg_temp.try_revoke('synthetic:revocation:p1', '87300000-0000-4000-8000-000000000001', current_setting('hid.pin_again'),
          'Not needed') is distinct from 'ok revoked replayed=t' then
    raise exception 'A grant another party revoked must replay';
  end if;
end $$;
reset role;

-- 6. Rows written: two grants revoked by the patient's account, carrying the
-- patient's trimmed words; two audit rows, none for a replay, whose reason
-- (which the facility's audit readers see) is the fixed text, never the
-- patient's words.
do $$
declare
  mismatch text;
begin
  if (select count(*) from identity.consent_grants
       where id in (current_setting('hid.approved')::uuid, current_setting('hid.pin')::uuid)
         and status = 'revoked' and revoked_by = '87100000-0000-4000-8000-000000000002'
         and revoked_at is not null and row_version = 2) <> 2
     or (select revoked_reason from identity.consent_grants where id = current_setting('hid.approved')::uuid) <> 'No longer needed'
     or (select revoked_reason from identity.consent_grants where id = current_setting('hid.pin')::uuid) <> 'Stop PIN access'
     or (select revoked_by from identity.consent_grants where id = current_setting('hid.approved_closed')::uuid)
        <> '87100000-0000-4000-8000-000000000001' then
    raise exception 'The revoked grants differ';
  end if;
  select string_agg(format('%s %s', event.resource_id, event.details), '; ') into mismatch
    from audit.events event
   where event.action = 'identity.consent-grant.patient-revoke'
     and not (event.actor_type = 'patient' and event.actor_subject = 'synthetic:revocation:p1'
       and event.actor_account_id = '87100000-0000-4000-8000-000000000002'
       and event.patient_id = '87200000-0000-4000-8000-000000000001'
       and event.facility_id = '87400000-0000-4000-8000-000000000002'
       and event.outcome = 'success' and event.resource_type = 'consent-grant'
       and event.purpose_of_use = 'patient-self' and event.provenance = 'application'
       and event.source_system = 'identity-api'
       and event.correlation_id = 'revocation-command-01'
       and event.reason = 'Revoked by the patient'
       and ((event.resource_id = current_setting('hid.approved')
             and event.details = '{"scope": "write_records", "authorizationMethod": "patient_approval"}')
         or (event.resource_id = current_setting('hid.pin')
             and event.details = '{"scope": "read_records", "authorizationMethod": "patient_access_pin"}')));
  if mismatch is not null
     or (select count(*) from audit.events where action = 'identity.consent-grant.patient-revoke') <> 2 then
    raise exception 'The revocation audit rows differ: %', coalesce(mismatch, 'count');
  end if;
  if (select status from identity.consent_grants where id = current_setting('hid.break_glass')::uuid) <> 'active' then
    raise exception 'The break-glass grant must be untouched';
  end if;
end $$;

-- 7. No new inbox item for a deleted login (item 4), directly and through a
-- real caller (0037's access-request trigger).
update auth.accounts set status = 'deleted', row_version = row_version + 1
 where id = '87100000-0000-4000-8000-000000000003';
do $$
begin
  if notification.enqueue_patient_inbox_item('87200000-0000-4000-8000-000000000002', 'REVOCATION_TEST', 'consent-grant', null, '{}')
       is not null
     or notification.enqueue_patient_inbox_item('87200000-0000-4000-8000-000000000001', 'REVOCATION_TEST', 'consent-grant', null, '{}')
       is null then
    raise exception 'The inbox must skip a deleted login and keep an active one';
  end if;
end $$;
set local role hid_identity_api_runtime;
select pg_temp.as_staff('direct-care', 'revocation-request-02');
select identity.create_access_request('HID-RVKPBBB', 'read_records', 'Follow-up visit for review', 60);
reset role;
do $$
begin
  -- P1: its two access requests and the two PIN verifications' synthetic
  -- requests (0037 notifies every non-break-glass request); P2: none.
  if exists (select 1 from notification.inbox_items where patient_id = '87200000-0000-4000-8000-000000000002')
     or not exists (select 1 from identity.access_requests where patient_id = '87200000-0000-4000-8000-000000000002')
     or (select count(*) from notification.inbox_items
          where patient_id = '87200000-0000-4000-8000-000000000001' and notification_code = 'ACCESS_REQUEST_RECEIVED') <> 4 then
    raise exception 'A deleted login received an inbox item, or an active one lost one';
  end if;
end $$;

-- 8. The revocation itself takes the patient's PIN advisory key and keeps it
-- to commit (serializing with 0033's PIN set and removal and 0075's PIN
-- verification). P3 has no PIN, and neither the access request (0010) nor
-- the approval (0072) takes the key, so before the revocation it is not held.
create function pg_temp.holds_pin_key(patient text) returns boolean language sql as $$
  select exists (select 1 from pg_locks lock_row
                  where lock_row.pid = pg_backend_pid() and lock_row.locktype = 'advisory' and lock_row.objsubid = 1
                    and ((lock_row.classid::bigint << 32) | lock_row.objid::bigint)
                        = hashtextextended('patient-access-pin:' || patient, 0));
$$;
grant execute on function pg_temp.holds_pin_key(text) to public;
set local role hid_identity_api_runtime;
select pg_temp.as_staff('direct-care', 'revocation-request-03');
select set_config('hid.request_p3', (select access_request_id::text
  from identity.create_access_request('HID-RVKPCCC', 'read_records', 'Follow-up visit for review', 60)), true);
select pg_temp.as_patient(3, 'revocation-approve-03');
select set_config('hid.approved_p3', (select consent_grant_id::text
  from identity.approve_access_request(current_setting('hid.request_p3')::uuid)), true);
do $$
begin
  if pg_temp.holds_pin_key('87200000-0000-4000-8000-000000000003') then
    raise exception 'P3''s PIN advisory key is held before the revocation, so case 8 would prove nothing';
  end if;
end $$;
select pg_temp.as_patient(3, 'revocation-command-03');
do $$
begin
  if pg_temp.try_revoke('synthetic:revocation:p3', '87300000-0000-4000-8000-000000000003', current_setting('hid.approved_p3'),
       'Not needed now') is distinct from 'ok revoked replayed=f' then
    raise exception 'P3''s revocation differs';
  end if;
  if not pg_temp.holds_pin_key('87200000-0000-4000-8000-000000000003') then
    raise exception 'The revocation did not take the patient''s PIN advisory key, or released it before commit';
  end if;
end $$;
reset role;

rollback;
