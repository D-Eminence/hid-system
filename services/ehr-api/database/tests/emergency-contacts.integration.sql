\set ON_ERROR_STOP on
-- Synthetic rollback-only coverage for verified patient emergency contacts and
-- minimum-necessary emergency-contact notification intents.
begin;
set constraints all deferred;

insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1100000-0000-4000-8000-000000000001', 'synthetic:contact:1', 'contact-1@example.invalid', 'Contact Patient One', 'active'),
  ('e1100000-0000-4000-8000-000000000002', 'synthetic:contact:2', 'contact-2@example.invalid', 'Contact Patient Two', 'active'),
  ('e1100000-0000-4000-8000-000000000003', 'staff:contact-clinician', 'contact-clinician@example.invalid', 'Contact Clinician', 'active');
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
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('e1700000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000003', 'doctor', 'facility',
   'e1600000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000002', 'Contact fixture role');
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct care', 'contact-test'), ('emergency', 'Emergency', 'contact-test')
on conflict (code) do nothing;

do $$
begin
  if has_table_privilege('hid_identity_api_runtime', 'identity.patient_emergency_contacts', 'SELECT')
     or has_table_privilege('hid_identity_api_runtime', 'identity.emergency_contact_notifications', 'UPDATE')
     or has_table_privilege('hid_notification_worker', 'identity.patient_emergency_contacts', 'SELECT')
     or has_function_privilege('hid_identity_api_runtime',
       'identity.audit_emergency_contact_event(text,text,uuid,uuid,text,uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('hid_ehr_api_runtime', 'identity.list_my_emergency_contacts(text,uuid)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime', 'identity.add_my_emergency_contact(text,uuid,uuid,text,text,bytea,text,text,boolean)', 'EXECUTE') then
    raise exception 'Emergency-contact privileges exceed or miss the governed command boundary';
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
  if exists (select 1 from identity.emergency_contact_notifications)
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
reset role;

-- A verified, consenting contact receives exactly one intent per break-glass grant.
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
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.intent-created') then
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
  select * into claimed from identity.claim_emergency_contact_notifications('identity-api-test', 10, 60);
  if claimed.notification_id is null or claimed.patient_first_name <> 'Ada'
     or claimed.facility_name <> 'Contact Test Hospital' or claimed.attempt_count <> 1 then
    raise exception 'Claim did not return the minimum-necessary delivery fields: %', claimed;
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
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.notification.retry-scheduled') then
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
                      and resource_id = current_setting('hid.test.grant_failed_intent')) then
    raise exception 'Intent failure invalidated break-glass or was not audited';
  end if;
end
$$;
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp(), revoked_reason = 'Synthetic close'
 where id = current_setting('hid.test.grant_failed_intent')::uuid;

-- Deactivated or non-consenting contacts are not recipients; pending intents are suppressed.
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
end
$$;
select set_config('app.actor_subject', 'staff:contact-clinician', true),
  set_config('app.correlation_id', 'emergency-contact-breakglass-04', true);
select set_config('hid.test.grant_after_removal',
  (select consent_grant_id::text from identity.activate_break_glass('HID-CNTCTA', 'Stroke symptoms emergency access', 15)), true);
reset role;
do $$
begin
  if not exists (select 1 from identity.emergency_contact_notifications
                  where id = 'e1a00000-0000-4000-8000-000000000002' and status = 'suppressed')
     or exists (select 1 from identity.emergency_contact_notifications
                  where consent_grant_id = current_setting('hid.test.grant_after_removal')::uuid)
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.deactivated') then
    raise exception 'Deactivated contact remained an emergency recipient';
  end if;
  -- Legacy emergency-contact data is neither used nor modified.
  if not exists (select 1 from identity.patients where id = 'e1200000-0000-4000-8000-000000000001'
                   and emergency_contact_ciphertext = '\x0102030405'::bytea and emergency_contact_key_version = 'legacy-v1') then
    raise exception 'Legacy emergency-contact data was modified';
  end if;
  if not exists (select 1 from audit.events where action = 'identity.emergency-contact.created')
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.verification-requested')
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.verification-sent')
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.verification-failed')
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.verification-expired')
     or not exists (select 1 from audit.events where action = 'identity.emergency-contact.verification-succeeded') then
    raise exception 'Emergency-contact lifecycle audit is incomplete';
  end if;
end
$$;

rollback;
