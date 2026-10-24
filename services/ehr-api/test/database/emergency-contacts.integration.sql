\set ON_ERROR_STOP on
-- Synthetic rollback-only coverage for verified patient emergency contacts and
-- minimum-necessary emergency-contact notification intents (0084; main 0065
-- with e1757ba, D-Eminence/hid-system). Ported from main's
-- database/tests/emergency-contacts.integration.sql and extended for this
-- branch: erase on removal, Health ID support's opt-out, an alert leased at
-- either, the facility alert phone, the claim's masked Health ID, left joins
-- and limit, the trigger's WHEN clause, an emergency-contact audit outage
-- during break-glass, and the functions' security properties.
begin;
set constraints all deferred;

insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1100000-0000-4000-8000-000000000001', 'synthetic:contact:1', 'contact-1@example.invalid', 'Contact Patient One', 'active'),
  ('e1100000-0000-4000-8000-000000000002', 'synthetic:contact:2', 'contact-2@example.invalid', 'Contact Patient Two', 'active'),
  ('e1100000-0000-4000-8000-000000000003', 'staff:contact-clinician', 'contact-clinician@example.invalid', 'Contact Clinician', 'active'),
  ('e1100000-0000-4000-8000-000000000004', 'synthetic:contact:support', 'contact-support@example.invalid', 'Contact Support', 'active'),
  ('e1100000-0000-4000-8000-000000000005', 'synthetic:contact:auditor', 'contact-auditor@example.invalid', 'Contact Auditor', 'active'),
  ('e1100000-0000-4000-8000-000000000006', 'synthetic:contact:platform', 'contact-platform@example.invalid', 'Contact Platform', 'active');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status,
  emergency_contact_ciphertext, emergency_contact_key_version) values
  ('e1200000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000001', 'HID-CNTCTA', 'Ada', 'Contact', 'Ada Contact', 'active',
   '\x0102030405'::bytea, 'legacy-v1'),
  ('e1200000-0000-4000-8000-000000000002', 'e1100000-0000-4000-8000-000000000002', 'HID-CNTCTB', 'Bola', 'Contact', 'Bola Contact', 'active',
   null, null);
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('e1300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('e1100000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('e1300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  md5('contact' || n) || md5('session' || n), gen_random_uuid(), 1, 'password', clock_timestamp(),
  clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours', 'patient',
  ('e1200000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
from generate_series(1, 2) n;
insert into identity.organizations (id, name, slug) values
  ('e1400000-0000-4000-8000-000000000001', 'Contact Test Organization', 'contact-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1400000-0000-4000-8000-000000000002', 'e1400000-0000-4000-8000-000000000001', 'Contact Test Hospital',
   'CNT-A', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('e1500000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000003', 'Contact Clinician',
   'contact-clinician@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('e1600000-0000-4000-8000-000000000001', 'e1500000-0000-4000-8000-000000000001',
   'e1100000-0000-4000-8000-000000000003', 'e1400000-0000-4000-8000-000000000001',
   'e1400000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true);
-- Novu keeps 0010's identity.break-glass.write grant to the doctor role (main's
-- 0091 withdrawal is not ported); this suite relies on it.
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('e1700000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000003', 'doctor', 'facility',
   'e1600000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000002', 'Contact fixture role');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('e1700000-0000-4000-8000-000000000002', 'e1100000-0000-4000-8000-000000000004', 'support_admin', 'platform',
   'Contact suite support administrator'),
  ('e1700000-0000-4000-8000-000000000003', 'e1100000-0000-4000-8000-000000000005', 'security_auditor', 'platform',
   'Contact suite security auditor'),
  ('e1700000-0000-4000-8000-000000000004', 'e1100000-0000-4000-8000-000000000006', 'platform_admin', 'platform',
   'Contact suite platform administrator');
-- Novu seeds direct-care (0071) but not the emergency purpose break-glass needs.
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct care', 'contact-test'), ('emergency', 'Emergency', 'contact-test')
on conflict (code) do nothing;
-- An ordinary (not break-glass) grant for the trigger and claim edge cases.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id) values
  ('e1b00000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000001',
   'e1500000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000003',
   'e1600000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000002',
   'read_records', 'direct-care', 'active', 'Synthetic ordinary grant', clock_timestamp(),
   clock_timestamp() + interval '1 hour', false, 'emergency-contact-plain-grant');

do $$
begin
  if has_table_privilege('hid_identity_api_runtime', 'identity.patient_emergency_contacts', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'identity.emergency_contact_notifications', 'UPDATE')
     or has_table_privilege('hid_notification_worker', 'identity.patient_emergency_contacts', 'SELECT')
     or has_function_privilege('hid_identity_api_runtime',
       'identity.audit_emergency_contact_event(text,text,uuid,text,uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('hid_ehr_api_runtime', 'identity.list_my_emergency_contacts(text,uuid)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime', 'identity.add_my_emergency_contact(text,uuid,uuid,text,text,bytea,text,text,boolean)', 'EXECUTE') then
    raise exception 'Emergency-contact privileges exceed or miss the governed command boundary';
  end if;
end
$$;

-- Security properties: every function is SECURITY DEFINER with its exact
-- search_path and volatility; the commands are executable by the Identity
-- runtime (and the schema-test role) only, the audit helper and trigger
-- function by nobody but their owner; no runtime reads or writes the contact
-- tables, and only Identity reads the facility alert phones.
do $$
declare
  expected record;
  mismatch text;
  role_name text;
  privilege_name text;
begin
  for expected in select * from (values
    ('identity.audit_emergency_contact_event(text,text,uuid,text,uuid,jsonb)', 'v', 'pg_catalog, audit, platform, pg_temp', false),
    ('identity.on_emergency_access_contact_notification()', 'v', 'pg_catalog, identity, audit, platform, pg_temp', false),
    ('identity.list_my_emergency_contacts(text,uuid)', 's', 'pg_catalog, identity, pg_temp', true),
    ('identity.add_my_emergency_contact(text,uuid,uuid,text,text,bytea,text,text,boolean)', 'v', 'pg_catalog, identity, auth, audit, platform, pg_temp', true),
    ('identity.update_my_emergency_contact(text,uuid,uuid,bigint,text,bytea,text,text,boolean)', 'v', 'pg_catalog, identity, auth, audit, platform, pg_temp', true),
    ('identity.deactivate_my_emergency_contact(text,uuid,uuid)', 'v', 'pg_catalog, identity, auth, audit, platform, pg_temp', true),
    ('identity.start_my_emergency_contact_verification(text,uuid,uuid,uuid,text,text,integer,integer)', 'v', 'pg_catalog, identity, auth, audit, platform, pg_temp', true),
    ('identity.record_my_emergency_contact_verification_delivery(text,uuid,uuid,text,text)', 'v', 'pg_catalog, identity, auth, audit, platform, pg_temp', true),
    ('identity.complete_my_emergency_contact_verification(text,uuid,uuid,uuid,text)', 'v', 'pg_catalog, identity, auth, audit, platform, pg_temp', true),
    ('identity.claim_emergency_contact_notifications(text,integer,integer)', 'v', 'pg_catalog, identity, audit, platform, pg_temp', true),
    ('identity.record_emergency_contact_notification_outcome(uuid,text,text,text,text)', 'v', 'pg_catalog, identity, audit, platform, pg_temp', true),
    ('identity.admin_set_facility_alert_phone(uuid,bigint,text,text,text,character)', 'v', 'identity, auth, platform, pg_temp', true),
    ('identity.admin_opt_out_emergency_contact(text,text,text,text,character)', 'v', 'identity, auth, platform, pg_temp', true)
  ) as item(signature, volatility, search_path, granted) loop
    select format('%s definer=%s volatility=%s config=%s', expected.signature, p.prosecdef, p.provolatile, p.proconfig)
      into mismatch
      from pg_proc p
     where p.oid = expected.signature::regprocedure
       and (not p.prosecdef or p.provolatile <> expected.volatility
         or p.proconfig is distinct from array['search_path=' || expected.search_path]);
    if mismatch is not null then raise exception 'Security properties differ: %', mismatch; end if;
    select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', '
        order by privilege.grantee::regrole::text)
      into mismatch
      from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
     where p.oid = expected.signature::regprocedure
       and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner;
    if mismatch is distinct from (case when expected.granted
        then 'hid_identity_runtime, hid_schema_test_runtime' end) then
      raise exception '% is executable by %', expected.signature, coalesce(mismatch, 'its owner only');
    end if;
    foreach role_name in array array['hid_ehr_api_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_api_runtime',
        'hid_outreach_api_runtime', 'hid_notification_worker', 'hid_event_dispatcher'] loop
      if has_function_privilege(role_name, expected.signature, 'EXECUTE') then
        raise exception 'Unrelated service % can execute %', role_name, expected.signature;
      end if;
    end loop;
  end loop;
  foreach role_name in array array['hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_lab_api_runtime',
      'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_notification_worker', 'hid_event_dispatcher'] loop
    foreach privilege_name in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(role_name, 'identity.patient_emergency_contacts', privilege_name)
         or has_table_privilege(role_name, 'identity.emergency_contact_verifications', privilege_name)
         or has_table_privilege(role_name, 'identity.emergency_contact_notifications', privilege_name)
         or (privilege_name <> 'SELECT' or role_name <> 'hid_identity_api_runtime')
            and has_table_privilege(role_name, 'identity.facility_alert_phones', privilege_name) then
        raise exception '% has % on an emergency-contact table', role_name, privilege_name;
      end if;
    end loop;
  end loop;
  if not has_table_privilege('hid_identity_api_runtime', 'identity.facility_alert_phones', 'SELECT') then
    raise exception 'The Identity runtime cannot read facility alert phones for the admin facility view';
  end if;
  -- Update, deactivate and verification start never block break-glass's
  -- FOR KEY SHARE on the contact.
  if exists (select 1 from pg_proc p
              where p.oid in ('identity.update_my_emergency_contact(text,uuid,uuid,bigint,text,bytea,text,text,boolean)'::regprocedure,
                'identity.deactivate_my_emergency_contact(text,uuid,uuid)'::regprocedure,
                'identity.start_my_emergency_contact_verification(text,uuid,uuid,uuid,text,text,integer,integer)'::regprocedure)
                and (p.prosrc !~* 'for no key update' or p.prosrc ~* 'for update;')) then
    raise exception 'A patient contact command locks the contact FOR UPDATE';
  end if;
  -- The trigger is enabled, fires only for EmergencyAccessActivated, and is
  -- the only one calling the function.
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgfoid = 'identity.on_emergency_access_contact_notification()'::regprocedure) <> 1
     or not exists (select 1 from pg_trigger trigger_row
       where trigger_row.tgrelid = 'identity.outbox_events'::regclass
         and trigger_row.tgname = 'emergency_contact_notification_intent'
         and trigger_row.tgenabled = 'O' and trigger_row.tgqual is not null
         and pg_get_triggerdef(trigger_row.oid) like
           '%AFTER INSERT ON identity.outbox_events FOR EACH ROW WHEN ((new.event_type = ''EmergencyAccessActivated''::text)) EXECUTE FUNCTION identity.on_emergency_access_contact_notification()') then
    raise exception 'The emergency-contact intent trigger is missing, disabled or unconditional';
  end if;
  -- The support permission belongs to support_admin and every role holding
  -- platform.principal.manage, and to no other role.
  if (select array_agg(role_permission.role_code::text order by role_permission.role_code)
        from auth.role_permissions role_permission
       where role_permission.permission_code = 'platform.emergency-contact.manage')
     is distinct from (select array_agg(distinct role_code::text order by role_code::text) from (
        select 'support_admin' as role_code
        union select role_code from auth.role_permissions where permission_code = 'platform.principal.manage') holder)
     or not exists (select 1 from auth.permissions where code = 'platform.emergency-contact.manage' and active)
     or not auth.account_has_platform_permission('e1100000-0000-4000-8000-000000000004', 'platform.emergency-contact.manage')
     or not auth.account_has_platform_permission('e1100000-0000-4000-8000-000000000006', 'platform.emergency-contact.manage')
     or auth.account_has_platform_permission('e1100000-0000-4000-8000-000000000005', 'platform.emergency-contact.manage') then
    raise exception 'platform.emergency-contact.manage is not held exactly by support and principal managers';
  end if;
end
$$;

-- Patient one adds two contacts; patient two cannot see or change them.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:contact:1', true),
  set_config('app.correlation_id', 'emergency-contact-integration-01', true);
do $$
begin
  perform identity.add_my_emergency_contact('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001',
    'e1800000-0000-4000-8000-000000000001', 'sibling', 'sms', '\x01'::bytea || decode(repeat('ab', 40), 'hex'), 'local-v1',
    encode(sha256('destination-one'::bytea), 'hex'), true);
  perform identity.add_my_emergency_contact('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001',
    'e1800000-0000-4000-8000-000000000002', 'friend', 'email', '\x01'::bytea || decode(repeat('ab', 40), 'hex'), 'local-v1',
    encode(sha256('destination-two'::bytea), 'hex'), true);
  begin
    perform identity.add_my_emergency_contact('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001',
      'e1800000-0000-4000-8000-000000000003', 'friend', 'email', '\x01'::bytea || decode(repeat('ab', 40), 'hex'), 'local-v1',
      encode(sha256('destination-two'::bytea), 'hex'), true);
    raise exception 'A duplicate active destination was accepted';
  exception when unique_violation then null;
  end;
  -- A contact is never stored without its encrypted name and destination.
  begin
    perform identity.add_my_emergency_contact('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001',
      gen_random_uuid(), 'friend', 'email', null, 'local-v1', encode(sha256('destination-null'::bytea), 'hex'), true);
    raise exception 'A contact without ciphertext was accepted';
  exception when check_violation then null;
  end;
  if (select count(*) from identity.list_my_emergency_contacts('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001')) <> 2
     or exists (select 1 from identity.list_my_emergency_contacts('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001')
                 where status <> 'unverified') then
    raise exception 'New contacts were not listed as unverified';
  end if;
end
$$;
select set_config('app.actor_subject', 'synthetic:contact:2', true);
do $$
begin
  if exists (select 1 from identity.list_my_emergency_contacts('synthetic:contact:2', 'e1300000-0000-4000-8000-000000000002')) then
    raise exception 'Another patient saw foreign emergency contacts';
  end if;
  begin
    perform identity.update_my_emergency_contact('synthetic:contact:2', 'e1300000-0000-4000-8000-000000000002',
      'e1800000-0000-4000-8000-000000000001', 1, 'parent', '\x01'::bytea || decode(repeat('ab', 40), 'hex'), 'local-v1',
      encode(sha256('destination-one'::bytea), 'hex'), true);
    raise exception 'Another patient edited a foreign contact';
  exception when no_data_found then null;
  end;
  begin
    perform identity.deactivate_my_emergency_contact('synthetic:contact:2', 'e1300000-0000-4000-8000-000000000002',
      'e1800000-0000-4000-8000-000000000001');
    raise exception 'Another patient deactivated a foreign contact';
  exception when no_data_found then null;
  end;
  begin
    perform identity.start_my_emergency_contact_verification('synthetic:contact:2', 'e1300000-0000-4000-8000-000000000002',
      'e1800000-0000-4000-8000-000000000001', gen_random_uuid(), repeat('a', 64), 'local-v1', 300, 5);
    raise exception 'Another patient started verification of a foreign contact';
  exception when no_data_found then null;
  end;
  begin
    perform identity.add_my_emergency_contact('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001',
      gen_random_uuid(), 'friend', 'email', '\x01'::bytea || decode(repeat('ab', 40), 'hex'), 'local-v1',
      encode(sha256('destination-x'::bytea), 'hex'), true);
    raise exception 'A contact was added under a substituted subject';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

-- An unverified contact is never a recipient.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:contact-clinician', true),
  set_config('app.membership_id', 'e1600000-0000-4000-8000-000000000001', true),
  set_config('app.facility_id', 'e1400000-0000-4000-8000-000000000002', true),
  set_config('app.purpose_of_use', 'emergency', true),
  set_config('app.correlation_id', 'emergency-contact-breakglass-01', true);
select set_config('hid.test.grant_unverified',
  (select consent_grant_id::text from identity.activate_break_glass('HID-CNTCTA', 'Unconscious patient in emergency room', 15)), true);
reset role;
do $$
begin
  if exists (select 1 from identity.emergency_contact_notifications where patient_id = 'e1200000-0000-4000-8000-000000000001')
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.no-eligible-contact'
                      and resource_id = current_setting('hid.test.grant_unverified')) then
    raise exception 'Unverified contact received an intent or no-eligible-contact was not audited';
  end if;
end
$$;
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp(), revoked_reason = 'Synthetic close'
 where id = current_setting('hid.test.grant_unverified')::uuid;

-- Verification: wrong code, expiry, rate limiting, success, and replay.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:contact:1', true),
  set_config('app.correlation_id', 'emergency-contact-verify-0001', true);
do $$
declare started record; outcome text;
begin
  select * into started from identity.start_my_emergency_contact_verification('synthetic:contact:1',
    'e1300000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000001',
    'e1900000-0000-4000-8000-000000000001', encode(sha256('verifier-good'::bytea), 'hex'), 'local-v1', 300, 3);
  if started.channel <> 'sms' or started.contact_ciphertext is null
     or started.expires_at > clock_timestamp() + interval '301 seconds' then
    raise exception 'Verification start returned an unexpected challenge';
  end if;
  perform identity.record_my_emergency_contact_verification_delivery('synthetic:contact:1',
    'e1300000-0000-4000-8000-000000000001', started.challenge_id, 'accepted', 'termii');
  begin
    perform identity.start_my_emergency_contact_verification('synthetic:contact:1',
      'e1300000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000001',
      gen_random_uuid(), encode(sha256('verifier-other'::bytea), 'hex'), 'local-v1', 300, 3);
    raise exception 'Verification resend cooldown was not enforced';
  exception when sqlstate 'P0001' then null;
  end;
  outcome := identity.complete_my_emergency_contact_verification('synthetic:contact:1',
    'e1300000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000001',
    started.challenge_id, encode(sha256('verifier-wrong'::bytea), 'hex'));
  if outcome <> 'invalid' then raise exception 'Wrong verification code was accepted'; end if;
end
$$;
select set_config('app.actor_subject', 'synthetic:contact:2', true);
do $$
begin
  if identity.complete_my_emergency_contact_verification('synthetic:contact:2',
       'e1300000-0000-4000-8000-000000000002', 'e1800000-0000-4000-8000-000000000001',
       'e1900000-0000-4000-8000-000000000001', encode(sha256('verifier-good'::bytea), 'hex')) <> 'invalid' then
    raise exception 'Another patient completed a foreign verification';
  end if;
end
$$;
reset role;
-- Expiry: force the active challenge into the past.
update identity.emergency_contact_verifications set expires_at = created_at + interval '1 millisecond'
 where id = 'e1900000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:contact:1', true);
do $$
begin
  if identity.complete_my_emergency_contact_verification('synthetic:contact:1',
       'e1300000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000001',
       'e1900000-0000-4000-8000-000000000001', encode(sha256('verifier-good'::bytea), 'hex')) <> 'expired' then
    raise exception 'Expired verification code was accepted';
  end if;
end
$$;
reset role;
-- Clear the resend cooldown in the fixture, then verify with a fresh challenge.
update identity.emergency_contact_verifications set created_at = created_at - interval '2 minutes',
  expires_at = expires_at - interval '2 minutes'
 where contact_id = 'e1800000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
do $$
declare started record;
begin
  select * into started from identity.start_my_emergency_contact_verification('synthetic:contact:1',
    'e1300000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000001',
    'e1900000-0000-4000-8000-000000000002', encode(sha256('verifier-good-2'::bytea), 'hex'), 'local-v1', 300, 3);
  if identity.complete_my_emergency_contact_verification('synthetic:contact:1',
       'e1300000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000001',
       started.challenge_id, encode(sha256('verifier-good-2'::bytea), 'hex')) <> 'verified' then
    raise exception 'Correct verification code was rejected';
  end if;
  if identity.complete_my_emergency_contact_verification('synthetic:contact:1',
       'e1300000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000001',
       started.challenge_id, encode(sha256('verifier-good-2'::bytea), 'hex')) <> 'invalid' then
    raise exception 'Verification code replay was accepted';
  end if;
  if (select status from identity.list_my_emergency_contacts('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001')
       where contact_id = 'e1800000-0000-4000-8000-000000000001') <> 'verified' then
    raise exception 'Verified contact state was not recorded';
  end if;
  -- The destination is immutable through edit.
  begin
    perform identity.update_my_emergency_contact('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001',
      'e1800000-0000-4000-8000-000000000001',
      (select row_version from identity.list_my_emergency_contacts('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001')
        where contact_id = 'e1800000-0000-4000-8000-000000000001'),
      'sibling', '\x01'::bytea || decode(repeat('ab', 40), 'hex'), 'local-v1', encode(sha256('destination-new'::bytea), 'hex'), true);
    raise exception 'An edit changed a verified destination';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform identity.update_my_emergency_contact('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001',
      'e1800000-0000-4000-8000-000000000001', 1, 'sibling', '\x01'::bytea || decode(repeat('ab', 40), 'hex'), 'local-v1',
      encode(sha256('destination-one'::bytea), 'hex'), true);
    raise exception 'A stale contact version was accepted';
  exception when serialization_failure then null;
  end;
end
$$;
-- A third contact is verified, then the patient turns its alerts off: it stays
-- verified but is not a recipient.
select set_config('app.correlation_id', 'emergency-contact-verify-0003', true);
do $$
declare started record; new_version bigint;
begin
  perform identity.add_my_emergency_contact('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001',
    'e1800000-0000-4000-8000-000000000004', 'parent', 'email', '\x01'::bytea || decode(repeat('cd', 40), 'hex'), 'local-v1',
    encode(sha256('destination-three'::bytea), 'hex'), true);
  select * into started from identity.start_my_emergency_contact_verification('synthetic:contact:1',
    'e1300000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000004',
    'e1900000-0000-4000-8000-000000000003', encode(sha256('verifier-three'::bytea), 'hex'), 'local-v1', 300, 3);
  if identity.complete_my_emergency_contact_verification('synthetic:contact:1',
       'e1300000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000004',
       started.challenge_id, encode(sha256('verifier-three'::bytea), 'hex')) <> 'verified' then
    raise exception 'The third contact was not verified';
  end if;
  new_version := identity.update_my_emergency_contact('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001',
    'e1800000-0000-4000-8000-000000000004', 2, 'parent', '\x01'::bytea || decode(repeat('cd', 40), 'hex'), 'local-v1',
    encode(sha256('destination-three'::bytea), 'hex'), false);
  if new_version <> 3 or (select status <> 'verified' or notify_on_emergency_access
       from identity.list_my_emergency_contacts('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001')
      where contact_id = 'e1800000-0000-4000-8000-000000000004') then
    raise exception 'Turning alerts off changed the verified state or was not stored';
  end if;
end
$$;
reset role;

-- A verified, consenting contact receives exactly one intent per break-glass
-- grant; an unverified contact and a verified one with alerts off receive none.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:contact-clinician', true),
  set_config('app.correlation_id', 'emergency-contact-breakglass-02', true);
do $$
declare first_grant record; replay record;
begin
  select * into first_grant from identity.activate_break_glass('HID-CNTCTA', 'Severe trauma requires immediate access', 30);
  select * into replay from identity.activate_break_glass('HID-CNTCTA', 'Retry of the same emergency access', 30);
  if not replay.existing_grant then raise exception 'Break-glass replay created a second grant'; end if;
  perform set_config('hid.test.grant_verified', first_grant.consent_grant_id::text, true);
end
$$;
reset role;
do $$
begin
  if (select count(*) from identity.emergency_contact_notifications
       where consent_grant_id = current_setting('hid.test.grant_verified')::uuid) <> 1
     or not exists (select 1 from identity.emergency_contact_notifications
       where consent_grant_id = current_setting('hid.test.grant_verified')::uuid
         and contact_id = 'e1800000-0000-4000-8000-000000000001' and status = 'pending' and channel = 'sms')
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.intent-created'
                      and patient_id = 'e1200000-0000-4000-8000-000000000001'
                      and facility_id is null and details = jsonb_build_object(
                        'consentGrantId', current_setting('hid.test.grant_verified'), 'channel', 'sms')) then
    raise exception 'Verified contact did not receive exactly one audited intent';
  end if;
  begin
    insert into identity.emergency_contact_notifications (consent_grant_id, contact_id, patient_id, facility_id,
      channel, occurred_at, deliver_before, correlation_id)
    select consent_grant_id, contact_id, patient_id, facility_id, channel, occurred_at, deliver_before, 'duplicate-intent'
      from identity.emergency_contact_notifications
     where consent_grant_id = current_setting('hid.test.grant_verified')::uuid;
    raise exception 'A duplicate emergency-contact intent was stored';
  exception when unique_violation then null;
  end;
  -- Break-glass authorization itself is unchanged and active.
  if not exists (select 1 from identity.consent_grants where id = current_setting('hid.test.grant_verified')::uuid
                   and status = 'active' and break_glass) then
    raise exception 'Emergency-contact processing changed the break-glass grant';
  end if;
end
$$;

-- Delivery runs only in the system context and exposes no clinical content.
-- The claim names the patient, the last four characters of the Health ID and
-- the clinician; this facility has no alert phone yet.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:contact:1', true);
do $$
begin
  perform identity.claim_emergency_contact_notifications('identity-api-test', 10, 60);
  raise exception 'A patient context claimed emergency-contact deliveries';
exception when insufficient_privilege then null;
end
$$;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'emergency-contact-delivery-01', true);
do $$
declare claimed record; result text; column_names text[];
begin
  select array_agg(attribute.attname::text order by attribute.attnum) into column_names
    from pg_attribute attribute
   where attribute.attrelid = 'identity.emergency_contact_notifications'::regclass and attribute.attnum > 0
     and not attribute.attisdropped;
  if column_names && array['message', 'body', 'recipient', 'destination', 'diagnosis', 'payload'] then
    raise exception 'Notification intent stores message or recipient content: %', column_names;
  end if;
  select * into claimed from identity.claim_emergency_contact_notifications('identity-api-test', 10, 120);
  if claimed.notification_id is null or claimed.contact_id <> 'e1800000-0000-4000-8000-000000000001'
     or claimed.channel <> 'sms' or claimed.contact_ciphertext is null or claimed.contact_key_version <> 'local-v1'
     or claimed.patient_full_name <> 'Ada Contact' or claimed.patient_hid_suffix <> 'TCTA'
     or claimed.clinician_name <> 'Contact Clinician' or claimed.facility_name <> 'Contact Test Hospital'
     or claimed.facility_phone_e164 is not null or claimed.attempt_count <> 1
     or pg_typeof(claimed.attempt_count) <> 'integer'::regtype then
    raise exception 'Claim did not return the minimum-necessary delivery fields: %', claimed;
  end if;
  -- Never the whole HID, never the clinician's free-text reason.
  if row_to_json(claimed)::text ~* 'HID-|severe trauma|immediate access'
     or pg_get_function_result('identity.claim_emergency_contact_notifications(text,integer,integer)'::regprocedure)
        <> 'TABLE(notification_id uuid, contact_id uuid, channel text, contact_ciphertext bytea, contact_key_version text, patient_full_name text, patient_hid_suffix text, clinician_name text, facility_name text, facility_phone_e164 text, occurred_at timestamp with time zone, attempt_count integer)' then
    raise exception 'Claim exposes the full HID, the grant reason or an unexpected column: %', claimed;
  end if;
  perform set_config('hid.test.notification', claimed.notification_id::text, true);
  if exists (select 1 from identity.claim_emergency_contact_notifications('identity-api-test', 10, 60)) then
    raise exception 'A leased intent was claimed twice';
  end if;
  if identity.record_emergency_contact_notification_outcome(claimed.notification_id, 'other-worker', 'accepted', 'termii', null)
     <> 'stale_lease' then
    raise exception 'A non-owning worker recorded a delivery outcome';
  end if;
  result := identity.record_emergency_contact_notification_outcome(claimed.notification_id, 'identity-api-test',
    'unknown', 'termii', 'http_503');
  if result <> 'pending' then raise exception 'Unknown delivery outcome was not retried'; end if;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from identity.emergency_contact_notifications
                  where id = current_setting('hid.test.notification')::uuid and status = 'pending'
                    and next_attempt_at > clock_timestamp() and lease_owner is null)
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.retry-scheduled'
                      and resource_id = current_setting('hid.test.notification')) then
    raise exception 'Retry backoff or retry audit is missing';
  end if;
end
$$;
update identity.emergency_contact_notifications set next_attempt_at = clock_timestamp() - interval '1 second'
 where id = current_setting('hid.test.notification')::uuid;
set local role hid_identity_api_runtime;
do $$
declare claimed record;
begin
  select * into claimed from identity.claim_emergency_contact_notifications('identity-api-test', 10, 60);
  if claimed.attempt_count <> 2 then raise exception 'Retry did not advance the attempt count'; end if;
  if identity.record_emergency_contact_notification_outcome(claimed.notification_id, 'identity-api-test',
       'accepted', 'termii', null) <> 'delivered' then
    raise exception 'Accepted delivery was not recorded';
  end if;
  if exists (select 1 from identity.claim_emergency_contact_notifications('identity-api-test', 10, 60)) then
    raise exception 'A delivered intent was claimed again';
  end if;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.delivered'
                   and resource_id = current_setting('hid.test.notification'))
     or exists (select 1 from audit.events where action like 'identity.emergency-contact.%'
                  and patient_id = 'e1200000-0000-4000-8000-000000000001'
                  and (details ? 'diagnosis' or details ? 'medication' or details ? 'message')) then
    raise exception 'Delivery audit is missing or carries clinical/message content';
  end if;
end
$$;

-- Definitive failure, exhausted retries, and expired windows close the intent.
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp(), revoked_reason = 'Synthetic close'
 where id = current_setting('hid.test.grant_verified')::uuid;
insert into identity.emergency_contact_notifications (id, consent_grant_id, contact_id, patient_id, facility_id, channel,
  occurred_at, deliver_before, correlation_id, attempt_count) values
  ('e1a00000-0000-4000-8000-000000000001', current_setting('hid.test.grant_unverified')::uuid,
   'e1800000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000002',
   'sms', clock_timestamp(), clock_timestamp() + interval '1 day', 'definitive-failure-fixture', 0);
set local role hid_identity_api_runtime;
do $$
declare claimed record;
begin
  select * into claimed from identity.claim_emergency_contact_notifications('identity-api-test', 10, 60);
  if identity.record_emergency_contact_notification_outcome(claimed.notification_id, 'identity-api-test',
       'definitive_failure', 'termii', 'http_400') <> 'failed' then
    raise exception 'Definitive failure was not terminal';
  end if;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.failed'
                   and resource_id = 'e1a00000-0000-4000-8000-000000000001') then
    raise exception 'Delivery failure audit is missing';
  end if;
end
$$;

-- A final attempt whose outcome was never recorded is closed on its next claim
-- and does not block other deliveries in the same batch.
update identity.emergency_contact_notifications
   set status = 'pending', closed_reason = null, last_outcome = null, attempt_count = 8,
       lease_owner = 'identity-api-crashed', lease_expires_at = clock_timestamp() - interval '1 second',
       next_attempt_at = clock_timestamp() - interval '2 minutes'
 where id = 'e1a00000-0000-4000-8000-000000000001';
update identity.emergency_contact_notifications
   set status = 'pending', closed_reason = null, delivered_at = null, attempt_count = 2,
       next_attempt_at = clock_timestamp() - interval '1 minute'
 where id = current_setting('hid.test.notification')::uuid;
set local role hid_identity_api_runtime;
do $$
declare claimed_ids uuid[]; claimed_attempts integer[];
begin
  select array_agg(claimed.notification_id), array_agg(claimed.attempt_count)
    into claimed_ids, claimed_attempts
    from identity.claim_emergency_contact_notifications('identity-api-test', 10, 60) claimed;
  if claimed_ids is distinct from array[current_setting('hid.test.notification')::uuid]
     or claimed_attempts is distinct from array[3] then
    raise exception 'An exhausted intent blocked or joined the claim batch: % %', claimed_ids, claimed_attempts;
  end if;
  if identity.record_emergency_contact_notification_outcome(claimed_ids[1], 'identity-api-test',
       'accepted', 'termii', null) <> 'delivered' then
    raise exception 'The unblocked delivery was not recorded';
  end if;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from identity.emergency_contact_notifications
                  where id = 'e1a00000-0000-4000-8000-000000000001' and status = 'failed'
                    and closed_reason = 'attempts_exhausted' and attempt_count = 8 and lease_owner is null)
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.failed'
                      and resource_id = 'e1a00000-0000-4000-8000-000000000001'
                      and details ->> 'reason' = 'attempts_exhausted') then
    raise exception 'Exhausted intent was not closed and audited';
  end if;
end
$$;

-- An intent past its 24-hour delivery window expires instead of being sent.
update identity.emergency_contact_notifications
   set status = 'pending', closed_reason = null, last_outcome = null, attempt_count = 3,
       lease_owner = null, lease_expires_at = null, next_attempt_at = clock_timestamp() - interval '1 minute',
       occurred_at = clock_timestamp() - interval '25 hours', deliver_before = clock_timestamp() - interval '1 hour'
 where id = 'e1a00000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
do $$
begin
  if exists (select 1 from identity.claim_emergency_contact_notifications('identity-api-test', 10, 60)) then
    raise exception 'An intent past its delivery window was claimed for delivery';
  end if;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from identity.emergency_contact_notifications
                  where id = 'e1a00000-0000-4000-8000-000000000001' and status = 'expired'
                    and closed_reason = 'delivery_window_elapsed')
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.failed'
                      and resource_id = 'e1a00000-0000-4000-8000-000000000001'
                      and details ->> 'reason' = 'delivery_window_elapsed') then
    raise exception 'Expired intent was not closed and audited';
  end if;
end
$$;

-- Notification failure inside the trigger never invalidates break-glass.
create function pg_temp.reject_contact_intent() returns trigger language plpgsql as $$
begin
  raise exception using errcode = 'P0994', message = 'Synthetic intent outage';
end
$$;
create trigger contact_intent_failure before insert on identity.emergency_contact_notifications
  for each row execute function pg_temp.reject_contact_intent();
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:contact-clinician', true),
  set_config('app.correlation_id', 'emergency-contact-breakglass-03', true);
select set_config('hid.test.grant_failed_intent',
  (select consent_grant_id::text from identity.activate_break_glass('HID-CNTCTA', 'Cardiac arrest emergency access', 15)), true);
reset role;
drop trigger contact_intent_failure on identity.emergency_contact_notifications;
do $$
begin
  if not exists (select 1 from identity.consent_grants where id = current_setting('hid.test.grant_failed_intent')::uuid
                   and status = 'active' and break_glass)
     or not exists (select 1 from audit.events where action = 'identity.break-glass.activate'
                      and correlation_id = 'emergency-contact-breakglass-03')
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.intent-failed'
                      and resource_id = current_setting('hid.test.grant_failed_intent')
                      and details = '{"sqlstate": "P0994"}'::jsonb and facility_id is null) then
    raise exception 'Intent failure invalidated break-glass or was not audited';
  end if;
end
$$;
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp(), revoked_reason = 'Synthetic close'
 where id = current_setting('hid.test.grant_failed_intent')::uuid;

-- An outage of the feature's own audit inserts (every emergency-contact
-- notification row refused) still leaves break-glass committed: the intent and
-- its audit roll back together, and the failure audit's own failure is only a
-- warning.
create function pg_temp.reject_contact_audit() returns trigger language plpgsql as $$
begin
  if new.action like 'identity.emergency-contact.notification.%' then
    raise exception using errcode = 'P0993', message = 'Synthetic contact audit outage';
  end if;
  return new;
end
$$;
create trigger contact_audit_failure before insert on audit.events
  for each row execute function pg_temp.reject_contact_audit();
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'staff:contact-clinician', true),
  set_config('app.correlation_id', 'emergency-contact-breakglass-05', true);
select set_config('hid.test.grant_audit_outage',
  (select consent_grant_id::text from identity.activate_break_glass('HID-CNTCTA', 'Anaphylaxis emergency access', 15)), true);
reset role;
drop trigger contact_audit_failure on audit.events;
do $$
begin
  if not exists (select 1 from identity.consent_grants where id = current_setting('hid.test.grant_audit_outage')::uuid
                   and status = 'active' and break_glass)
     or not exists (select 1 from audit.events where action = 'identity.break-glass.activate'
                      and correlation_id = 'emergency-contact-breakglass-05')
     or not exists (select 1 from identity.outbox_events where aggregate_id = current_setting('hid.test.grant_audit_outage')::uuid
                      and event_type = 'EmergencyAccessActivated')
     or exists (select 1 from identity.emergency_contact_notifications
                 where consent_grant_id = current_setting('hid.test.grant_audit_outage')::uuid)
     or exists (select 1 from audit.events where correlation_id = 'emergency-contact-breakglass-05'
                 and action like 'identity.emergency-contact.%') then
    raise exception 'An emergency-contact audit outage changed the break-glass outcome';
  end if;
end
$$;
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp(), revoked_reason = 'Synthetic close'
 where id = current_setting('hid.test.grant_audit_outage')::uuid;

-- The trigger's WHEN clause: another outbox event never calls the function. An
-- EmergencyAccessActivated row whose grant is not a break-glass grant (or is not
-- visible) is audited as grant_unavailable, without a facility.
set local track_functions = 'pl';
insert into identity.outbox_events (event_type, aggregate_id, aggregate_version, facility_id, patient_id,
  correlation_id, payload) values
  ('PatientAccessPinVerified', 'e1b00000-0000-4000-8000-000000000001', 1, 'e1400000-0000-4000-8000-000000000002',
   'e1200000-0000-4000-8000-000000000001', 'emergency-contact-when-01',
   jsonb_build_object('consentGrantId', 'e1b00000-0000-4000-8000-000000000001'::uuid, 'reviewRequired', true));
do $$
begin
  if coalesce(pg_stat_get_xact_function_calls('identity.on_emergency_access_contact_notification()'::regprocedure), 0) <> 0
     or exists (select 1 from audit.events where correlation_id = 'emergency-contact-when-01') then
    raise exception 'A non-emergency outbox event called the emergency-contact trigger function';
  end if;
end
$$;
select set_config('app.correlation_id', 'emergency-contact-when-02', true);
insert into identity.outbox_events (event_type, aggregate_id, aggregate_version, facility_id, patient_id,
  correlation_id, payload) values
  ('EmergencyAccessActivated', 'e1b00000-0000-4000-8000-000000000001', 1, 'e1400000-0000-4000-8000-000000000002',
   'e1200000-0000-4000-8000-000000000001', 'emergency-contact-when-02',
   jsonb_build_object('consentGrantId', 'e1b00000-0000-4000-8000-000000000001'::uuid, 'reviewRequired', true));
do $$
begin
  if pg_stat_get_xact_function_calls('identity.on_emergency_access_contact_notification()'::regprocedure) <> 1
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.intent-failed'
                      and correlation_id = 'emergency-contact-when-02' and outcome = 'failure'
                      and resource_id = 'e1b00000-0000-4000-8000-000000000001' and facility_id is null
                      and details = '{"reason": "grant_unavailable"}'::jsonb)
     or exists (select 1 from identity.emergency_contact_notifications
                 where consent_grant_id = 'e1b00000-0000-4000-8000-000000000001') then
    raise exception 'An unavailable grant was not audited as grant_unavailable';
  end if;
end
$$;
reset track_functions;

-- Facility alert phone: platform.facility.manage, E.164 or null, reason,
-- If-Match version, idempotency, no-op refusal, clearing, and no deletes.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:contact:auditor', true),
  set_config('app.correlation_id', 'emergency-contact-phone-01', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
do $$
begin
  perform identity.admin_set_facility_alert_phone('e1400000-0000-4000-8000-000000000002', 1, '+2348030000000',
    'Contact suite sets the phone', 'phone-key-0001', encode(sha256('phone-request-1'::bytea), 'hex'));
  raise exception 'A security auditor set a facility alert phone';
exception when insufficient_privilege then
  if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
end
$$;
select set_config('app.actor_subject', 'synthetic:contact:platform', true);
do $$
declare result record; failure_state text; failure_message text;
begin
  for result in select * from (values
    ('08030000000', 'Contact suite uses a national number', 1::bigint, '22023', 'ADMIN_INVALID_FACILITY_PHONE'),
    ('+0123456789', 'Contact suite uses a bad country code', 1::bigint, '22023', 'ADMIN_INVALID_FACILITY_PHONE'),
    ('+2348030000000', 'short', 1::bigint, '22023', 'ADMIN_INVALID_REASON'),
    ('+2348030000000', 'Contact suite uses a stale version', 7::bigint, '40001', 'ADMIN_VERSION_CONFLICT')
  ) as item(phone, reason, version, state, message) loop
    begin
      perform identity.admin_set_facility_alert_phone('e1400000-0000-4000-8000-000000000002', result.version,
        result.phone, result.reason, 'phone-key-bad-' || result.state, encode(sha256(result.reason::bytea), 'hex'));
      raise exception 'An invalid facility phone command was accepted: %', result;
    exception when others then
      get stacked diagnostics failure_state = returned_sqlstate, failure_message = message_text;
      if failure_state <> result.state or failure_message <> result.message then
        raise exception 'Facility phone refusal % % instead of % %', failure_state, failure_message, result.state, result.message;
      end if;
    end;
  end loop;
  begin
    perform identity.admin_set_facility_alert_phone('e1400000-0000-4000-8000-0000000000ff', 1, '+2348030000000',
      'Contact suite names no facility', 'phone-key-missing', encode(sha256('phone-missing'::bytea), 'hex'));
    raise exception 'A missing facility was accepted';
  exception when no_data_found then
    if sqlerrm <> 'ADMIN_FACILITY_NOT_FOUND' then raise; end if;
  end;

  select * into result from identity.admin_set_facility_alert_phone('e1400000-0000-4000-8000-000000000002', 1,
    '+2348030000000', '  Contact suite sets the phone  ', 'phone-key-0001', encode(sha256('phone-request-1'::bytea), 'hex'));
  if result.facility_id <> 'e1400000-0000-4000-8000-000000000002' or result.phone_e164 <> '+2348030000000'
     or result.facility_version <> 2 or result.replayed then
    raise exception 'Setting the facility phone returned %', result;
  end if;
  select * into result from identity.admin_set_facility_alert_phone('e1400000-0000-4000-8000-000000000002', 1,
    '+2348030000000', '  Contact suite sets the phone  ', 'phone-key-0001', encode(sha256('phone-request-1'::bytea), 'hex'));
  if result.phone_e164 <> '+2348030000000' or result.facility_version <> 2 or not result.replayed then
    raise exception 'A replayed facility phone command returned %', result;
  end if;
  begin
    perform identity.admin_set_facility_alert_phone('e1400000-0000-4000-8000-000000000002', 2, '+2348030000001',
      'Contact suite reuses the key', 'phone-key-0001', encode(sha256('phone-request-other'::bytea), 'hex'));
    raise exception 'A reused idempotency key with a different request was accepted';
  exception when unique_violation then
    if sqlerrm <> 'ADMIN_IDEMPOTENCY_CONFLICT' then raise; end if;
  end;
  begin
    perform identity.admin_set_facility_alert_phone('e1400000-0000-4000-8000-000000000002', 2, '+2348030000000',
      'Contact suite repeats the phone', 'phone-key-0002', encode(sha256('phone-request-2'::bytea), 'hex'));
    raise exception 'An unchanged facility phone was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'ADMIN_NO_STATE_CHANGE' then raise; end if;
  end;
  select * into result from identity.admin_set_facility_alert_phone('e1400000-0000-4000-8000-000000000002', 2,
    null, 'Contact suite clears the phone', 'phone-key-0003', encode(sha256('phone-request-3'::bytea), 'hex'));
  if result.phone_e164 is not null or result.facility_version <> 3 or result.replayed then
    raise exception 'Clearing the facility phone returned %', result;
  end if;
  if (select phone_e164 from identity.facility_alert_phones
       where facility_id = 'e1400000-0000-4000-8000-000000000002') is not null then
    raise exception 'A cleared facility phone is still readable';
  end if;
  select * into result from identity.admin_set_facility_alert_phone('e1400000-0000-4000-8000-000000000002', 3,
    '+2348030000000', 'Contact suite sets the phone again', 'phone-key-0004', encode(sha256('phone-request-4'::bytea), 'hex'));
  if result.facility_version <> 4 then raise exception 'Setting the phone again returned %', result; end if;
  -- The runtime reads the phone for the admin facility view, and writes it
  -- only through the command.
  begin
    update identity.facility_alert_phones set phone_e164 = '+2348030000009';
    raise exception 'The Identity runtime updated a facility phone directly';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from identity.facility_alert_phones phone
                   join identity.facilities facility on facility.id = phone.facility_id
                  where phone.facility_id = 'e1400000-0000-4000-8000-000000000002'
                    and phone.phone_e164 = '+2348030000000' and phone.reason = 'Contact suite sets the phone again'
                    and phone.row_version = 3 and phone.updated_by_account_id = 'e1100000-0000-4000-8000-000000000006'
                    and facility.row_version = 4)
     or (select count(*) from auth.admin_command_idempotency
          where operation = 'facility.alert-phone.set'
            and actor_account_id = 'e1100000-0000-4000-8000-000000000006') <> 3 then
    raise exception 'The facility phone, its version or its idempotency records are wrong';
  end if;
  begin
    delete from identity.facility_alert_phones where facility_id = 'e1400000-0000-4000-8000-000000000002';
    raise exception 'A facility alert phone was deleted';
  exception when object_not_in_prerequisite_state then null;
  end;
end
$$;

-- The claim's left joins: a grant whose staff row is not there (made here with
-- foreign keys suspended) still alerts, without a clinician name, and gives the
-- facility's alert phone. A notice whose patient is not there is closed and
-- audited, never leased.
set local session_replication_role = replica;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id) values
  ('e1b00000-0000-4000-8000-000000000002', 'e1200000-0000-4000-8000-000000000001',
   'e1500000-0000-4000-8000-0000000000ff', 'e1100000-0000-4000-8000-000000000003',
   'e1600000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000002',
   'read_records', 'direct-care', 'active', 'Synthetic grant without its staff row', clock_timestamp(),
   clock_timestamp() + interval '1 hour', false, 'emergency-contact-staffless-grant');
set local session_replication_role = origin;
insert into identity.emergency_contact_notifications (id, consent_grant_id, contact_id, patient_id, facility_id, channel,
  occurred_at, deliver_before, correlation_id) values
  ('e1a00000-0000-4000-8000-000000000005', 'e1b00000-0000-4000-8000-000000000002',
   'e1800000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000002',
   'sms', clock_timestamp(), clock_timestamp() + interval '1 day', 'staffless-grant-fixture');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'emergency-contact-delivery-05', true);
do $$
declare claimed record;
begin
  select * into claimed from identity.claim_emergency_contact_notifications('identity-api-test', 5, 120);
  if claimed.notification_id is distinct from 'e1a00000-0000-4000-8000-000000000005'
     or claimed.clinician_name is not null or claimed.patient_full_name <> 'Ada Contact'
     or claimed.patient_hid_suffix <> 'TCTA' or claimed.facility_name <> 'Contact Test Hospital'
     or claimed.facility_phone_e164 <> '+2348030000000' or claimed.attempt_count <> 1 then
    raise exception 'A grant without its staff row was not claimed through the left joins: %', claimed;
  end if;
  if identity.record_emergency_contact_notification_outcome(claimed.notification_id, 'identity-api-test',
       'accepted', 'email-brevo', null) <> 'delivered' then
    raise exception 'The staffless alert was not recorded';
  end if;
end
$$;
reset role;
set local session_replication_role = replica;
insert into identity.emergency_contact_notifications (id, consent_grant_id, contact_id, patient_id, facility_id, channel,
  occurred_at, deliver_before, correlation_id) values
  ('e1a00000-0000-4000-8000-000000000006', 'e1b00000-0000-4000-8000-000000000001',
   'e1800000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-0000000000ff', 'e1400000-0000-4000-8000-000000000002',
   'sms', clock_timestamp(), clock_timestamp() + interval '1 day', 'missing-patient-fixture');
-- The audit row names the notice's patient id, which no patient row has here.
set local role hid_identity_api_runtime;
select set_config('app.correlation_id', 'emergency-contact-delivery-06', true);
do $$
begin
  if exists (select 1 from identity.claim_emergency_contact_notifications('identity-api-test', 5, 120)) then
    raise exception 'A notice without its patient was claimed for delivery';
  end if;
end
$$;
reset role;
set local session_replication_role = origin;
do $$
begin
  if not exists (select 1 from identity.emergency_contact_notifications
                  where id = 'e1a00000-0000-4000-8000-000000000006' and status = 'failed'
                    and closed_reason = 'patient_unavailable' and attempt_count = 0 and lease_owner is null)
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.failed'
                      and resource_id = 'e1a00000-0000-4000-8000-000000000006' and facility_id is null
                      and details = '{"reason": "patient_unavailable"}'::jsonb) then
    raise exception 'A notice without its patient was not closed and audited';
  end if;
end
$$;

-- A claim's limit counts the notices it leases. Notices it closes on the way
-- (four past their delivery window and two whose contact turned alerts off,
-- all due first) take no slot: one claim(worker, 5, 120) closes them and
-- returns the five oldest live alerts, and the next claim the sixth.
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, revoked_at, revoked_reason, break_glass, correlation_id)
select ('e1b00000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid, 'e1200000-0000-4000-8000-000000000001',
  'e1500000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000003',
  'e1600000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000002',
  'read_records', 'direct-care', 'revoked', 'Synthetic batch grant', clock_timestamp() - interval '2 days',
  clock_timestamp() + interval '1 hour', clock_timestamp(), 'Synthetic close', false, 'emergency-contact-batch-grant-' || n
from generate_series(1, 12) n;
insert into identity.emergency_contact_notifications (id, consent_grant_id, contact_id, patient_id, facility_id, channel,
  occurred_at, deliver_before, next_attempt_at, correlation_id)
select ('e1a00000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
  ('e1b00000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
  case when n > 10 then 'e1800000-0000-4000-8000-000000000004' else 'e1800000-0000-4000-8000-000000000001' end::uuid,
  'e1200000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000002',
  case when n > 10 then 'email' else 'sms' end,
  case when n between 7 and 10 then clock_timestamp() - interval '25 hours' else clock_timestamp() end,
  case when n between 7 and 10 then clock_timestamp() - interval '1 hour' else clock_timestamp() + interval '1 day' end,
  case when n > 6 then clock_timestamp() - interval '10 minutes'
    else clock_timestamp() - interval '1 minute' + n * interval '1 second' end,
  'batch-fixture-' || n
from generate_series(1, 12) n;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'emergency-contact-delivery-08', true);
do $$
declare claimed_ids uuid[]; claimed_id uuid;
begin
  select array_agg(claimed.notification_id order by claimed.notification_id) into claimed_ids
    from identity.claim_emergency_contact_notifications('identity-api-test', 5, 120) claimed;
  if claimed_ids is distinct from array(select ('e1a00000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid
                                          from generate_series(1, 5) n) then
    raise exception 'Notices the claim closed took slots in its batch: %', claimed_ids;
  end if;
  foreach claimed_id in array claimed_ids loop
    if identity.record_emergency_contact_notification_outcome(claimed_id, 'identity-api-test',
         'accepted', 'termii', null) <> 'delivered' then
      raise exception 'A batch alert was not recorded';
    end if;
  end loop;
  select array_agg(claimed.notification_id) into claimed_ids
    from identity.claim_emergency_contact_notifications('identity-api-test', 5, 120) claimed;
  if claimed_ids is distinct from array['e1a00000-0000-4000-8000-000000000106']::uuid[] then
    raise exception 'The sixth live alert was not claimed next: %', claimed_ids;
  end if;
  if identity.record_emergency_contact_notification_outcome(claimed_ids[1], 'identity-api-test',
       'accepted', 'termii', null) <> 'delivered' then
    raise exception 'The sixth batch alert was not recorded';
  end if;
end
$$;
reset role;
do $$
begin
  if (select count(*) from identity.emergency_contact_notifications
       where correlation_id like 'batch-fixture-%' and status = 'delivered' and attempt_count = 1) <> 6
     or (select count(*) from identity.emergency_contact_notifications
          where correlation_id like 'batch-fixture-%' and attempt_count = 0 and lease_owner is null
            and ((status = 'expired' and closed_reason = 'delivery_window_elapsed')
              or (status = 'suppressed' and closed_reason = 'contact_ineligible'))) <> 6
     or (select count(*) from audit.events where correlation_id = 'emergency-contact-delivery-08'
          and action in ('identity.emergency-contact.notification.failed', 'identity.emergency-contact.notification.suppressed')
          and details ->> 'reason' in ('delivery_window_elapsed', 'contact_ineligible')) <> 6 then
    raise exception 'The batch''s due notices were not all closed or delivered and audited';
  end if;
end
$$;

-- Health ID support's opt-out. Both patients list the same email destination:
-- patient two's contact is verified and has a pending alert, patient one's is
-- unverified with an open challenge.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:contact:2', true),
  set_config('app.correlation_id', 'emergency-contact-opt-out-01', true);
do $$
declare started record;
begin
  perform identity.add_my_emergency_contact('synthetic:contact:2', 'e1300000-0000-4000-8000-000000000002',
    'e1800000-0000-4000-8000-000000000006', 'spouse', 'email', '\x01'::bytea || decode(repeat('ef', 40), 'hex'), 'local-v1',
    encode(sha256('shared-destination'::bytea), 'hex'), true);
  select * into started from identity.start_my_emergency_contact_verification('synthetic:contact:2',
    'e1300000-0000-4000-8000-000000000002', 'e1800000-0000-4000-8000-000000000006',
    'e1900000-0000-4000-8000-000000000005', encode(sha256('verifier-shared'::bytea), 'hex'), 'local-v1', 300, 3);
  if identity.complete_my_emergency_contact_verification('synthetic:contact:2',
       'e1300000-0000-4000-8000-000000000002', 'e1800000-0000-4000-8000-000000000006',
       started.challenge_id, encode(sha256('verifier-shared'::bytea), 'hex')) <> 'verified' then
    raise exception 'Patient two''s contact was not verified';
  end if;
end
$$;
select set_config('app.actor_subject', 'synthetic:contact:1', true);
do $$
begin
  perform identity.add_my_emergency_contact('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001',
    'e1800000-0000-4000-8000-000000000005', 'guardian', 'email', '\x01'::bytea || decode(repeat('ef', 40), 'hex'), 'local-v1',
    encode(sha256('shared-destination'::bytea), 'hex'), true);
  perform identity.start_my_emergency_contact_verification('synthetic:contact:1',
    'e1300000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000005',
    'e1900000-0000-4000-8000-000000000004', encode(sha256('verifier-shared-1'::bytea), 'hex'), 'local-v1', 300, 3);
end
$$;
select set_config('app.actor_subject', 'staff:contact-clinician', true),
  set_config('app.membership_id', 'e1600000-0000-4000-8000-000000000001', true),
  set_config('app.facility_id', 'e1400000-0000-4000-8000-000000000002', true),
  set_config('app.purpose_of_use', 'emergency', true),
  set_config('app.correlation_id', 'emergency-contact-breakglass-06', true);
select set_config('hid.test.grant_patient_two',
  (select consent_grant_id::text from identity.activate_break_glass('HID-CNTCTB', 'Road traffic collision emergency', 15)), true);
reset role;
do $$
begin
  if (select count(*) from identity.emergency_contact_notifications
       where consent_grant_id = current_setting('hid.test.grant_patient_two')::uuid
         and contact_id = 'e1800000-0000-4000-8000-000000000006' and status = 'pending') <> 1 then
    raise exception 'Patient two''s verified contact did not get its pending alert';
  end if;
end
$$;
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp(), revoked_reason = 'Synthetic close'
 where id = current_setting('hid.test.grant_patient_two')::uuid;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:contact:auditor', true),
  set_config('app.correlation_id', 'emergency-contact-opt-out-02', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
do $$
begin
  perform identity.admin_opt_out_emergency_contact('email', encode(sha256('shared-destination'::bytea), 'hex'),
    'Recipient asked support to stop alerts', 'opt-out-key-0001', encode(sha256('opt-out-request-1'::bytea), 'hex'));
  raise exception 'A security auditor opted a contact out';
exception when insufficient_privilege then
  if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
end
$$;
select set_config('app.actor_subject', 'synthetic:contact:support', true);
do $$
declare result record; failure_state text; failure_message text;
begin
  for result in select * from (values
    ('email', encode(sha256('shared-destination'::bytea), 'hex'), 'short', '22023', 'ADMIN_INVALID_REASON'),
    ('fax', encode(sha256('shared-destination'::bytea), 'hex'), 'Recipient asked support to stop alerts', '22023',
     'ADMIN_INVALID_EMERGENCY_CONTACT'),
    ('email', 'not-an-hmac', 'Recipient asked support to stop alerts', '22023', 'ADMIN_INVALID_EMERGENCY_CONTACT')
  ) as item(channel, destination_hmac, reason, state, message) loop
    begin
      perform identity.admin_opt_out_emergency_contact(result.channel, result.destination_hmac, result.reason,
        'opt-out-key-bad', encode(sha256('opt-out-bad'::bytea), 'hex'));
      raise exception 'An invalid opt-out was accepted: %', result;
    exception when others then
      get stacked diagnostics failure_state = returned_sqlstate, failure_message = message_text;
      if failure_state <> result.state or failure_message <> result.message then
        raise exception 'Opt-out refusal % % instead of % %', failure_state, failure_message, result.state, result.message;
      end if;
    end;
  end loop;
  -- The same destination on another channel is a different contact.
  select * into result from identity.admin_opt_out_emergency_contact('sms', encode(sha256('shared-destination'::bytea), 'hex'),
    'Recipient asked support to stop alerts', 'opt-out-key-sms', encode(sha256('opt-out-request-sms'::bytea), 'hex'));
  if result.contact_count <> 0 or result.patient_count <> 0 or result.replayed then
    raise exception 'An opt-out on another channel matched: %', result;
  end if;
  select * into result from identity.admin_opt_out_emergency_contact('email', encode(sha256('shared-destination'::bytea), 'hex'),
    'Recipient asked support to stop alerts', 'opt-out-key-0001', encode(sha256('opt-out-request-1'::bytea), 'hex'));
  if result.contact_count <> 2 or result.patient_count <> 2 or result.replayed then
    raise exception 'The opt-out did not remove the contact from both patients: %', result;
  end if;
  select * into result from identity.admin_opt_out_emergency_contact('email', encode(sha256('shared-destination'::bytea), 'hex'),
    'Recipient asked support to stop alerts', 'opt-out-key-0001', encode(sha256('opt-out-request-1'::bytea), 'hex'));
  if result.contact_count <> 2 or result.patient_count <> 2 or not result.replayed then
    raise exception 'A replayed opt-out returned %', result;
  end if;
  begin
    perform identity.admin_opt_out_emergency_contact('email', encode(sha256('other-destination'::bytea), 'hex'),
      'Recipient asked support to stop alerts', 'opt-out-key-0001', encode(sha256('opt-out-request-other'::bytea), 'hex'));
    raise exception 'A reused opt-out key with a different request was accepted';
  exception when unique_violation then
    if sqlerrm <> 'ADMIN_IDEMPOTENCY_CONFLICT' then raise; end if;
  end;
  -- Once removed, the destination matches nothing: no match is not an error.
  select * into result from identity.admin_opt_out_emergency_contact('email', encode(sha256('shared-destination'::bytea), 'hex'),
    'Recipient asked support again', 'opt-out-key-0002', encode(sha256('opt-out-request-2'::bytea), 'hex'));
  if result.contact_count <> 0 or result.patient_count <> 0 or result.replayed then
    raise exception 'A second opt-out matched removed contacts: %', result;
  end if;
end
$$;
-- Neither patient lists the removed contact; patient one's others remain.
select set_config('app.actor_subject', 'synthetic:contact:2', true);
do $$
begin
  if exists (select 1 from identity.list_my_emergency_contacts('synthetic:contact:2', 'e1300000-0000-4000-8000-000000000002')) then
    raise exception 'Patient two still lists an opted-out contact';
  end if;
end
$$;
select set_config('app.actor_subject', 'synthetic:contact:1', true);
do $$
begin
  if (select array_agg(contact_id order by contact_id)
        from identity.list_my_emergency_contacts('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001'))
     is distinct from array['e1800000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000002',
       'e1800000-0000-4000-8000-000000000004']::uuid[] then
    raise exception 'The opt-out changed another contact';
  end if;
end
$$;
reset role;
do $$
begin
  if (select count(*) from identity.patient_emergency_contacts
       where id in ('e1800000-0000-4000-8000-000000000005', 'e1800000-0000-4000-8000-000000000006')
         and status = 'deactivated' and deactivation_reason = 'contact_opted_out' and deactivated_at is not null
         and contact_ciphertext is null and contact_key_version is null and destination_hmac is null) <> 2 then
    raise exception 'Opted-out contacts were not erased';
  end if;
  if not exists (select 1 from identity.emergency_contact_notifications
                  where consent_grant_id = current_setting('hid.test.grant_patient_two')::uuid
                    and status = 'suppressed' and closed_reason = 'contact_deactivated' and lease_owner is null)
     or not exists (select 1 from identity.emergency_contact_verifications
                     where id = 'e1900000-0000-4000-8000-000000000004'
                       and invalidation_reason = 'contact_deactivated' and invalidated_at is not null) then
    raise exception 'An opted-out contact''s pending alert or open challenge was not closed';
  end if;
  -- One inbox notice per patient, naming neither the contact nor the address.
  if (select count(*) from notification.inbox_items where notification_code = 'EMERGENCY_CONTACT_OPTED_OUT') <> 2
     or (select count(distinct patient_id) from notification.inbox_items
          where notification_code = 'EMERGENCY_CONTACT_OPTED_OUT'
            and patient_id in ('e1200000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000002')
            and account_id in ('e1100000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000002')
            and resource_type = 'emergency-contact'
            and resource_id in ('e1800000-0000-4000-8000-000000000005', 'e1800000-0000-4000-8000-000000000006')
            and (select array_agg(key order by key) from jsonb_object_keys(metadata) key) = array['channel', 'relationship']
            and metadata ->> 'channel' = 'email') <> 2 then
    raise exception 'Each patient did not get exactly one opt-out notice';
  end if;
  -- Support's command writes no audit row and stores only counts.
  if exists (select 1 from audit.events where correlation_id in ('emergency-contact-opt-out-02')
               or details::text like '%' || encode(sha256('shared-destination'::bytea), 'hex') || '%')
     or (select response from auth.admin_command_idempotency
          where operation = 'emergency-contact.opt-out' and idempotency_key = 'opt-out-key-0001')
        <> '{"contacts": 2, "patients": 2}'::jsonb then
    raise exception 'The opt-out recorded more than counts';
  end if;
end
$$;

-- An alert leased when support opts its contact out is left to the lease
-- holder: accepted after the opt-out, it is recorded as delivered and audited.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:contact:2', true),
  set_config('app.correlation_id', 'emergency-contact-opt-out-03', true);
do $$
declare started record;
begin
  perform identity.add_my_emergency_contact('synthetic:contact:2', 'e1300000-0000-4000-8000-000000000002',
    'e1800000-0000-4000-8000-000000000007', 'sibling', 'email', '\x01'::bytea || decode(repeat('ef', 40), 'hex'), 'local-v1',
    encode(sha256('leased-destination'::bytea), 'hex'), true);
  select * into started from identity.start_my_emergency_contact_verification('synthetic:contact:2',
    'e1300000-0000-4000-8000-000000000002', 'e1800000-0000-4000-8000-000000000007',
    'e1900000-0000-4000-8000-000000000006', encode(sha256('verifier-leased'::bytea), 'hex'), 'local-v1', 300, 3);
  if identity.complete_my_emergency_contact_verification('synthetic:contact:2',
       'e1300000-0000-4000-8000-000000000002', 'e1800000-0000-4000-8000-000000000007',
       started.challenge_id, encode(sha256('verifier-leased'::bytea), 'hex')) <> 'verified' then
    raise exception 'Patient two''s second contact was not verified';
  end if;
end
$$;
reset role;
insert into identity.emergency_contact_notifications (id, consent_grant_id, contact_id, patient_id, facility_id, channel,
  occurred_at, deliver_before, correlation_id) values
  ('e1a00000-0000-4000-8000-000000000008', current_setting('hid.test.grant_patient_two')::uuid,
   'e1800000-0000-4000-8000-000000000007', 'e1200000-0000-4000-8000-000000000002', 'e1400000-0000-4000-8000-000000000002',
   'email', clock_timestamp(), clock_timestamp() + interval '1 day', 'leased-at-opt-out-fixture');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'emergency-contact-delivery-09', true);
do $$
begin
  if (select array_agg(notification_id) from identity.claim_emergency_contact_notifications('identity-api-test', 5, 120))
     is distinct from array['e1a00000-0000-4000-8000-000000000008']::uuid[] then
    raise exception 'The alert to be leased at the opt-out was not claimed';
  end if;
end
$$;
select set_config('app.actor_subject', 'synthetic:contact:support', true),
  set_config('app.correlation_id', 'emergency-contact-opt-out-04', true);
do $$
declare result record;
begin
  select * into result from identity.admin_opt_out_emergency_contact('email', encode(sha256('leased-destination'::bytea), 'hex'),
    'Recipient asked support to stop alerts', 'opt-out-key-0003', encode(sha256('opt-out-request-3'::bytea), 'hex'));
  if result.contact_count <> 1 or result.patient_count <> 1 or result.replayed then
    raise exception 'The opt-out of a contact with a leased alert returned %', result;
  end if;
end
$$;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'emergency-contact-delivery-10', true);
do $$
begin
  if identity.record_emergency_contact_notification_outcome('e1a00000-0000-4000-8000-000000000008', 'identity-api-test',
       'accepted', 'email-brevo', null) <> 'delivered' then
    raise exception 'An alert accepted after its contact was opted out was not recorded';
  end if;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from identity.emergency_contact_notifications
                  where id = 'e1a00000-0000-4000-8000-000000000008' and status = 'delivered'
                    and closed_reason = 'delivered' and delivered_at is not null and lease_owner is null)
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.delivered'
                      and resource_id = 'e1a00000-0000-4000-8000-000000000008'
                      and correlation_id = 'emergency-contact-delivery-10')
     or not exists (select 1 from identity.patient_emergency_contacts
                     where id = 'e1800000-0000-4000-8000-000000000007' and status = 'deactivated'
                       and deactivation_reason = 'contact_opted_out' and destination_hmac is null) then
    raise exception 'An alert delivered after its contact was opted out is not recorded as delivered';
  end if;
end
$$;

-- Deactivated or non-consenting contacts are not recipients; pending intents
-- are closed, and a removed contact is erased. An alert leased at the removal
-- is left to its lease holder (claimed here, accepted after the removal).
insert into identity.emergency_contact_notifications (id, consent_grant_id, contact_id, patient_id, facility_id, channel,
  occurred_at, deliver_before, correlation_id) values
  ('e1a00000-0000-4000-8000-000000000007', current_setting('hid.test.grant_audit_outage')::uuid,
   'e1800000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000002',
   'sms', clock_timestamp(), clock_timestamp() + interval '1 day', 'leased-at-removal-fixture');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'emergency-contact-delivery-11', true);
do $$
begin
  if (select array_agg(notification_id) from identity.claim_emergency_contact_notifications('identity-api-test', 5, 120))
     is distinct from array['e1a00000-0000-4000-8000-000000000007']::uuid[] then
    raise exception 'The alert to be leased at removal was not claimed';
  end if;
end
$$;
reset role;
insert into identity.emergency_contact_notifications (id, consent_grant_id, contact_id, patient_id, facility_id, channel,
  occurred_at, deliver_before, correlation_id) values
  ('e1a00000-0000-4000-8000-000000000002', current_setting('hid.test.grant_failed_intent')::uuid,
   'e1800000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000002',
   'sms', clock_timestamp(), clock_timestamp() + interval '1 day', 'suppression-fixture');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:contact:1', true),
  set_config('app.correlation_id', 'emergency-contact-deactivate-1', true);
do $$
declare removed record;
begin
  select * into removed from identity.deactivate_my_emergency_contact('synthetic:contact:1',
    'e1300000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000001');
  if removed.replayed then raise exception 'First deactivation was reported as a replay'; end if;
  select * into removed from identity.deactivate_my_emergency_contact('synthetic:contact:1',
    'e1300000-0000-4000-8000-000000000001', 'e1800000-0000-4000-8000-000000000001');
  if not removed.replayed then raise exception 'Repeated deactivation was not idempotent'; end if;
  begin
    perform identity.update_my_emergency_contact('synthetic:contact:1', 'e1300000-0000-4000-8000-000000000001',
      'e1800000-0000-4000-8000-000000000001', 4, 'sibling', '\x01'::bytea || decode(repeat('ab', 40), 'hex'), 'local-v1',
      encode(sha256('destination-one'::bytea), 'hex'), true);
    raise exception 'A removed contact was edited';
  exception when no_data_found then null;
  end;
end
$$;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'emergency-contact-delivery-12', true);
do $$
begin
  if identity.record_emergency_contact_notification_outcome('e1a00000-0000-4000-8000-000000000007', 'identity-api-test',
       'accepted', 'termii', null) <> 'delivered' then
    raise exception 'An alert accepted after its contact was removed was not recorded';
  end if;
end
$$;
select set_config('app.actor_subject', 'staff:contact-clinician', true),
  set_config('app.membership_id', 'e1600000-0000-4000-8000-000000000001', true),
  set_config('app.facility_id', 'e1400000-0000-4000-8000-000000000002', true),
  set_config('app.purpose_of_use', 'emergency', true),
  set_config('app.correlation_id', 'emergency-contact-breakglass-04', true);
select set_config('hid.test.grant_after_removal',
  (select consent_grant_id::text from identity.activate_break_glass('HID-CNTCTA', 'Stroke symptoms emergency access', 15)), true);
reset role;
do $$
begin
  if not exists (select 1 from identity.emergency_contact_notifications
                  where id = 'e1a00000-0000-4000-8000-000000000002' and status = 'suppressed'
                    and closed_reason = 'contact_deactivated')
     or exists (select 1 from identity.emergency_contact_notifications
                  where consent_grant_id = current_setting('hid.test.grant_after_removal')::uuid)
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.deactivated'
                      and patient_id = 'e1200000-0000-4000-8000-000000000001'
                      and details ->> 'pendingNotificationsSuppressed' = '1') then
    raise exception 'Deactivated contact remained an emergency recipient';
  end if;
  -- Only a record that the contact existed is kept.
  if not exists (select 1 from identity.patient_emergency_contacts
                  where id = 'e1800000-0000-4000-8000-000000000001' and status = 'deactivated'
                    and deactivation_reason = 'patient_removed' and relationship = 'sibling' and channel = 'sms'
                    and contact_ciphertext is null and contact_key_version is null and destination_hmac is null) then
    raise exception 'A removed contact kept its encrypted name or destination';
  end if;
  -- A removed contact cannot be stored with its name, nor an active one without.
  begin
    update identity.patient_emergency_contacts set contact_ciphertext = '\x01'::bytea || decode(repeat('ab', 40), 'hex')
     where id = 'e1800000-0000-4000-8000-000000000001';
    raise exception 'A removed contact took back its ciphertext';
  exception when check_violation then null;
  end;
  begin
    update identity.patient_emergency_contacts set destination_hmac = null
     where id = 'e1800000-0000-4000-8000-000000000002';
    raise exception 'An active contact lost its destination HMAC';
  exception when check_violation then null;
  end;
  -- Legacy emergency-contact data is neither used nor modified.
  if not exists (select 1 from identity.patients where id = 'e1200000-0000-4000-8000-000000000001'
                   and emergency_contact_ciphertext = '\x0102030405'::bytea and emergency_contact_key_version = 'legacy-v1') then
    raise exception 'Legacy emergency-contact data was modified';
  end if;
  if (select count(distinct action) from audit.events
       where patient_id = 'e1200000-0000-4000-8000-000000000001' and action in (
         'identity.emergency-contact.created', 'identity.emergency-contact.verification-requested',
         'identity.emergency-contact.verification-sent', 'identity.emergency-contact.verification-failed',
         'identity.emergency-contact.verification-expired', 'identity.emergency-contact.verification-succeeded')) <> 6 then
    raise exception 'Emergency-contact lifecycle audit is incomplete';
  end if;
  -- The alert leased at the removal and accepted after it is recorded as sent.
  if not exists (select 1 from identity.emergency_contact_notifications
                  where id = 'e1a00000-0000-4000-8000-000000000007' and status = 'delivered'
                    and closed_reason = 'delivered' and delivered_at is not null and lease_owner is null)
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.delivered'
                      and resource_id = 'e1a00000-0000-4000-8000-000000000007'
                      and correlation_id = 'emergency-contact-delivery-12') then
    raise exception 'An alert delivered after its contact was removed is not recorded as delivered';
  end if;
end
$$;

-- A claim never returns a notice whose contact is removed or no longer
-- consents: it closes the first as contact_deactivated, the second as
-- contact_ineligible, and audits both.
insert into identity.emergency_contact_notifications (id, consent_grant_id, contact_id, patient_id, facility_id, channel,
  occurred_at, deliver_before, correlation_id) values
  ('e1a00000-0000-4000-8000-000000000003', current_setting('hid.test.grant_after_removal')::uuid,
   'e1800000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000002',
   'sms', clock_timestamp(), clock_timestamp() + interval '1 day', 'removed-contact-fixture'),
  ('e1a00000-0000-4000-8000-000000000004', current_setting('hid.test.grant_verified')::uuid,
   'e1800000-0000-4000-8000-000000000004', 'e1200000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000002',
   'email', clock_timestamp(), clock_timestamp() + interval '1 day', 'alerts-off-contact-fixture');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'emergency-contact-delivery-07', true);
do $$
begin
  if exists (select 1 from identity.claim_emergency_contact_notifications('identity-api-test', 5, 120)) then
    raise exception 'A notice for a removed or non-consenting contact was claimed';
  end if;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from identity.emergency_contact_notifications
                  where id = 'e1a00000-0000-4000-8000-000000000003' and status = 'suppressed'
                    and closed_reason = 'contact_deactivated')
     or not exists (select 1 from identity.emergency_contact_notifications
                     where id = 'e1a00000-0000-4000-8000-000000000004' and status = 'suppressed'
                       and closed_reason = 'contact_ineligible')
     or (select count(*) from audit.events where action = 'identity.emergency-contact.notification.suppressed'
          and correlation_id = 'emergency-contact-delivery-07' and facility_id is null
          and details ->> 'reason' in ('contact_deactivated', 'contact_ineligible')) <> 2 then
    raise exception 'A removed or non-consenting contact''s notice was not closed and audited';
  end if;
  -- Every system audit row of the feature names no facility and no contact
  -- details: channels and counts only.
  if exists (select 1 from audit.events
              where action like 'identity.emergency-contact.notification.%'
                and (facility_id is not null or actor_type <> 'system'
                  or details ?| array['contactId', 'destination', 'destinationHmac', 'name', 'recipient', 'hid']
                  or details ->> 'reason' not in ('grant_unavailable', 'delivery_window_elapsed', 'attempts_exhausted',
                       'contact_deactivated', 'contact_ineligible', 'patient_unavailable'))) then
    raise exception 'A system emergency-contact audit row names a facility or contact details';
  end if;
end
$$;

rollback;
