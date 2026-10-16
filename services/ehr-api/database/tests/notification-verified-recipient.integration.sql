\set ON_ERROR_STOP on
-- Synthetic rollback-only coverage for 0095 (ADR-064): the notification
-- worker's claim-bound recipient lookup. The worker may learn a patient's
-- verified login email only for the event it holds a live inbox claim on,
-- only while the patient is active and opted in and the login is active,
-- verified and usable as main defines it (no suspension ahead, no deletion
-- due), and never a name. It reads no Identity or Auth table itself.
-- Every fixture is synthetic and the whole suite rolls back.
begin;

-- Fixtures A to T, each patient with one Identity outbox event. Inserted with
-- session_replication_role = replica (no triggers or foreign-key checks; CHECK
-- constraints still apply), as other suites do, so the outbox rows need no
-- registration case, facility or consent grant behind them.
set local session_replication_role = replica;
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at) values
  ('e9100000-0000-4000-8000-00000000000a', 'synthetic:recipient:a', 'recipient-a@example.invalid', 'Recipient A', 'active', clock_timestamp()),
  ('e9100000-0000-4000-8000-00000000000c', 'synthetic:recipient:c', 'recipient-c@example.invalid', 'Recipient C', 'active', null),
  ('e9100000-0000-4000-8000-00000000000d', 'synthetic:recipient:d', 'recipient-d@example.invalid', 'Recipient D', 'deleted', clock_timestamp()),
  ('e9100000-0000-4000-8000-00000000000e', 'synthetic:recipient:e', 'recipient-e@example.invalid', 'Recipient E', 'active', clock_timestamp()),
  ('e9100000-0000-4000-8000-00000000000f', 'synthetic:recipient:f', 'recipient-f@example.invalid', 'Recipient F', 'active', clock_timestamp()),
  ('e9100000-0000-4000-8000-000000000010', 'synthetic:recipient:h', 'recipient-h@example.invalid', 'Recipient H', 'locked', clock_timestamp()),
  ('e9100000-0000-4000-8000-000000000011', 'synthetic:recipient:i', '   ', 'Recipient I', 'active', clock_timestamp());
-- B is the phone-only shape of 0093/0094: a login with no email at all.
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at) values
  ('e9100000-0000-4000-8000-00000000000b', 'synthetic:recipient:b', null, 'Recipient B', 'active', null);
-- J to T: the logins main itself treats as unusable (identity.current_patient_account
-- and identity.patient_self_session, 0064), and the boundaries either side.
-- J is suspended (disabled_until ahead, as a banned legacy login imports);
-- K's confirmed deletion is due (scheduled_for passed, the sweep not yet run);
-- L's deletion is confirmed but not yet due, and M's suspension has ended,
-- so both logins are still usable; N is disabled and P pending_reset; Q's
-- and R's logins are active but their patients are inactive and merged.
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, disabled_until) values
  ('e9100000-0000-4000-8000-000000000012', 'synthetic:recipient:j', 'recipient-j@example.invalid', 'Recipient J', 'active',
   clock_timestamp(), clock_timestamp() + interval '100 years'),
  ('e9100000-0000-4000-8000-000000000013', 'synthetic:recipient:k', 'recipient-k@example.invalid', 'Recipient K', 'active',
   clock_timestamp(), null),
  ('e9100000-0000-4000-8000-000000000014', 'synthetic:recipient:l', 'recipient-l@example.invalid', 'Recipient L', 'active',
   clock_timestamp(), null),
  ('e9100000-0000-4000-8000-000000000015', 'synthetic:recipient:m', 'recipient-m@example.invalid', 'Recipient M', 'active',
   clock_timestamp(), clock_timestamp() - interval '1 day'),
  ('e9100000-0000-4000-8000-000000000016', 'synthetic:recipient:n', 'recipient-n@example.invalid', 'Recipient N', 'disabled',
   clock_timestamp(), null),
  ('e9100000-0000-4000-8000-000000000017', 'synthetic:recipient:p', 'recipient-p@example.invalid', 'Recipient P', 'pending_reset',
   clock_timestamp(), null),
  ('e9100000-0000-4000-8000-000000000018', 'synthetic:recipient:q', 'recipient-q@example.invalid', 'Recipient Q', 'active',
   clock_timestamp(), null),
  ('e9100000-0000-4000-8000-000000000019', 'synthetic:recipient:r', 'recipient-r@example.invalid', 'Recipient R', 'active',
   clock_timestamp(), null);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, notifications_enabled) values
  ('e9200000-0000-4000-8000-00000000000a', 'e9100000-0000-4000-8000-00000000000a', 'HID-NVRCPA', 'Synthetic', 'Alpha', 'Synthetic Alpha', 'active', true),
  ('e9200000-0000-4000-8000-00000000000b', 'e9100000-0000-4000-8000-00000000000b', 'HID-NVRCPB', 'Synthetic', 'Bravo', 'Synthetic Bravo', 'active', true),
  ('e9200000-0000-4000-8000-00000000000c', 'e9100000-0000-4000-8000-00000000000c', 'HID-NVRCPC', 'Synthetic', 'Charlie', 'Synthetic Charlie', 'active', true),
  ('e9200000-0000-4000-8000-00000000000d', 'e9100000-0000-4000-8000-00000000000d', 'HID-NVRCPD', 'Synthetic', 'Delta', 'Synthetic Delta', 'active', true),
  ('e9200000-0000-4000-8000-00000000000e', 'e9100000-0000-4000-8000-00000000000e', 'HID-NVRCPE', 'Synthetic', 'Echo', 'Synthetic Echo', 'deceased', true),
  ('e9200000-0000-4000-8000-00000000000f', 'e9100000-0000-4000-8000-00000000000f', 'HID-NVRCPF', 'Synthetic', 'Foxtrot', 'Synthetic Foxtrot', 'active', false),
  ('e9200000-0000-4000-8000-000000000010', null, 'HID-NVRCPG', 'Synthetic', 'Golf', 'Synthetic Golf', 'active', true),
  ('e9200000-0000-4000-8000-000000000011', 'e9100000-0000-4000-8000-000000000010', 'HID-NVRCPH', 'Synthetic', 'Hotel', 'Synthetic Hotel', 'active', true),
  ('e9200000-0000-4000-8000-000000000012', 'e9100000-0000-4000-8000-000000000011', 'HID-NVRCPJ', 'Synthetic', 'India', 'Synthetic India', 'active', true),
  ('e9200000-0000-4000-8000-000000000013', 'e9100000-0000-4000-8000-000000000012', 'HID-NVRCPK', 'Synthetic', 'Juliett', 'Synthetic Juliett', 'active', true),
  ('e9200000-0000-4000-8000-000000000014', 'e9100000-0000-4000-8000-000000000013', 'HID-NVRCPL', 'Synthetic', 'Kilo', 'Synthetic Kilo', 'active', true),
  ('e9200000-0000-4000-8000-000000000015', 'e9100000-0000-4000-8000-000000000014', 'HID-NVRCPM', 'Synthetic', 'Lima', 'Synthetic Lima', 'active', true),
  ('e9200000-0000-4000-8000-000000000016', 'e9100000-0000-4000-8000-000000000015', 'HID-NVRCPN', 'Synthetic', 'Mike', 'Synthetic Mike', 'active', true),
  ('e9200000-0000-4000-8000-000000000017', 'e9100000-0000-4000-8000-000000000016', 'HID-NVRCPP', 'Synthetic', 'November', 'Synthetic November', 'active', true),
  ('e9200000-0000-4000-8000-000000000018', 'e9100000-0000-4000-8000-000000000017', 'HID-NVRCPQ', 'Synthetic', 'Papa', 'Synthetic Papa', 'active', true),
  ('e9200000-0000-4000-8000-000000000019', 'e9100000-0000-4000-8000-000000000018', 'HID-NVRCPR', 'Synthetic', 'Quebec', 'Synthetic Quebec', 'inactive', true),
  ('e9200000-0000-4000-8000-00000000001a', 'e9100000-0000-4000-8000-000000000019', 'HID-NVRCPS', 'Synthetic', 'Romeo', 'Synthetic Romeo', 'merged', true);
-- K's confirmed deletion fell due a day ago; L's falls due in 14 days. The
-- session id has no row: foreign keys are off for the fixtures.
insert into identity.patient_account_deletion_requests (account_id, patient_id, requested_session_id, state,
  confirmation_token_sha256, confirmation_expires_at, confirmation_consumed_at, requested_at, confirmed_at,
  waiting_period, scheduled_for, correlation_id) values
  ('e9100000-0000-4000-8000-000000000013', 'e9200000-0000-4000-8000-000000000014', 'e9600000-0000-4000-8000-000000000013',
   'pending', encode(sha256('recipient-suite-k'::bytea), 'hex'), clock_timestamp() - interval '2 days' + interval '10 minutes',
   clock_timestamp() - interval '2 days' + interval '1 minute', clock_timestamp() - interval '2 days',
   clock_timestamp() - interval '2 days' + interval '1 minute', interval '1 day', clock_timestamp() - interval '1 day',
   'recipient-suite-k-deletion'),
  ('e9100000-0000-4000-8000-000000000014', 'e9200000-0000-4000-8000-000000000015', 'e9600000-0000-4000-8000-000000000014',
   'pending', encode(sha256('recipient-suite-l'::bytea), 'hex'), clock_timestamp() + interval '10 minutes',
   clock_timestamp() + interval '1 minute', clock_timestamp(), clock_timestamp() + interval '1 minute',
   interval '14 days', clock_timestamp() + interval '14 days', 'recipient-suite-l-deletion');
create temporary table recipient_fixture (label text primary key, patient_id uuid not null, event_id uuid not null,
  event_type text not null, correlation_id text not null) on commit drop;
insert into recipient_fixture values
  ('A', 'e9200000-0000-4000-8000-00000000000a', 'e9300000-0000-4000-8000-00000000000a', 'PatientRegistered', 'recipient-suite-a-0001'),
  ('B', 'e9200000-0000-4000-8000-00000000000b', 'e9300000-0000-4000-8000-00000000000b', 'PatientRegistered', 'recipient-suite-b-0001'),
  ('C', 'e9200000-0000-4000-8000-00000000000c', 'e9300000-0000-4000-8000-00000000000c', 'PatientRegistered', 'recipient-suite-c-0001'),
  ('D', 'e9200000-0000-4000-8000-00000000000d', 'e9300000-0000-4000-8000-00000000000d', 'PatientRegistered', 'recipient-suite-d-0001'),
  ('E', 'e9200000-0000-4000-8000-00000000000e', 'e9300000-0000-4000-8000-00000000000e', 'PatientRegistered', 'recipient-suite-e-0001'),
  ('F', 'e9200000-0000-4000-8000-00000000000f', 'e9300000-0000-4000-8000-00000000000f', 'PatientRegistered', 'recipient-suite-f-0001'),
  ('F-safety', 'e9200000-0000-4000-8000-00000000000f', 'e9300000-0000-4000-8000-0000000000f5', 'PatientAccessPinVerified', 'recipient-suite-f-0002'),
  ('G', 'e9200000-0000-4000-8000-000000000010', 'e9300000-0000-4000-8000-000000000010', 'PatientRegistered', 'recipient-suite-g-0001'),
  ('H', 'e9200000-0000-4000-8000-000000000011', 'e9300000-0000-4000-8000-000000000011', 'PatientRegistered', 'recipient-suite-h-0001'),
  ('I', 'e9200000-0000-4000-8000-000000000012', 'e9300000-0000-4000-8000-000000000012', 'PatientRegistered', 'recipient-suite-i-0001'),
  ('J', 'e9200000-0000-4000-8000-000000000013', 'e9300000-0000-4000-8000-000000000013', 'PatientRegistered', 'recipient-suite-j-0001'),
  ('K', 'e9200000-0000-4000-8000-000000000014', 'e9300000-0000-4000-8000-000000000014', 'PatientRegistered', 'recipient-suite-k-0001'),
  ('L', 'e9200000-0000-4000-8000-000000000015', 'e9300000-0000-4000-8000-000000000015', 'PatientRegistered', 'recipient-suite-l-0001'),
  ('M', 'e9200000-0000-4000-8000-000000000016', 'e9300000-0000-4000-8000-000000000016', 'PatientRegistered', 'recipient-suite-m-0001'),
  ('N', 'e9200000-0000-4000-8000-000000000017', 'e9300000-0000-4000-8000-000000000017', 'PatientRegistered', 'recipient-suite-n-0001'),
  ('P', 'e9200000-0000-4000-8000-000000000018', 'e9300000-0000-4000-8000-000000000018', 'PatientRegistered', 'recipient-suite-p-0001'),
  ('Q', 'e9200000-0000-4000-8000-000000000019', 'e9300000-0000-4000-8000-000000000019', 'PatientRegistered', 'recipient-suite-q-0001'),
  ('R', 'e9200000-0000-4000-8000-00000000001a', 'e9300000-0000-4000-8000-00000000001a', 'PatientRegistered', 'recipient-suite-r-0001'),
  -- A second event of patient A: claimed below with another correlation id.
  ('A-mismatch', 'e9200000-0000-4000-8000-00000000000a', 'e9300000-0000-4000-8000-0000000000a2', 'PatientRegistered', 'recipient-suite-a-0002'),
  -- PatientIdentifierAdded has no notification workflow (event.ts).
  ('A-unrouted', 'e9200000-0000-4000-8000-00000000000a', 'e9300000-0000-4000-8000-0000000000a3', 'PatientIdentifierAdded', 'recipient-suite-a-0003'),
  ('A-expired', 'e9200000-0000-4000-8000-00000000000a', 'e9300000-0000-4000-8000-0000000000a4', 'PatientRegistered', 'recipient-suite-a-0004');
insert into identity.outbox_events (event_id, event_type, aggregate_id, aggregate_version, facility_id, patient_id,
  correlation_id, payload)
select fixture.event_id, fixture.event_type,
  case when fixture.event_type = 'PatientAccessPinVerified' then 'e9400000-0000-4000-8000-0000000000f5'::uuid
    else gen_random_uuid() end,
  1, 'e9500000-0000-4000-8000-000000000001', fixture.patient_id, fixture.correlation_id,
  case when fixture.event_type = 'PatientAccessPinVerified'
    then jsonb_build_object('consentGrantId', 'e9400000-0000-4000-8000-0000000000f5', 'reviewRequired', true)
    else '{}'::jsonb end
from recipient_fixture fixture;
set local session_replication_role = origin;

create temporary table recipient_claims (label text primary key, claim_token uuid) on commit drop;
grant select, insert, update on recipient_fixture, recipient_claims to public;

-- Catalogue: both functions are SECURITY DEFINER with a pinned search_path,
-- neither is executable by PUBLIC, the claim function belongs to the
-- event-delivery technical owner (moved in runtime-grants.sql's CREATE
-- window) and the helper to the owner of identity.patients, auth.accounts and
-- identity.patient_account_deletion_requests, none of which forces row-level
-- security, so the helper reads all three as their owner without BYPASSRLS.
do $$
declare
  claim_function regprocedure := to_regprocedure('integration.notification_recipient_for_claim(uuid,uuid,uuid)');
  helper regprocedure := to_regprocedure('integration.notification_recipient_state(uuid)');
  checked record;
  role_name text;
begin
  if claim_function is null or helper is null then
    raise exception 'the 0095 recipient functions are missing';
  end if;
  for checked in select p.oid, p.prosecdef, p.proconfig, pg_get_function_result(p.oid) as result, p.proowner
                   from pg_proc p where p.oid in (claim_function, helper) loop
    if not checked.prosecdef or checked.proconfig is distinct from array['search_path=pg_catalog, pg_temp']
       or checked.result <> 'TABLE(delivery text, email text)' then
      raise exception 'recipient function % must be SECURITY DEFINER with search_path pg_catalog, pg_temp returning (delivery, email)',
        checked.oid::regprocedure;
    end if;
    if has_function_privilege('public', checked.oid, 'EXECUTE') then
      raise exception 'PUBLIC can execute %', checked.oid::regprocedure;
    end if;
  end loop;
  if (select proowner from pg_proc where oid = claim_function) <> 'hid_event_delivery_commands'::regrole then
    raise exception 'the claim function must be owned by hid_event_delivery_commands';
  end if;
  if exists (select 1 from pg_class
              where oid in ('identity.patients'::regclass, 'auth.accounts'::regclass,
                            'identity.patient_account_deletion_requests'::regclass)
                and (relowner <> (select proowner from pg_proc where oid = helper) or relforcerowsecurity)) then
    raise exception 'the recipient helper must be owned by the owner of identity.patients, auth.accounts and identity.patient_account_deletion_requests, none forcing row-level security';
  end if;
  if not has_function_privilege('hid_notification_worker', claim_function, 'EXECUTE')
     or has_function_privilege('hid_notification_worker', helper, 'EXECUTE')
     or not has_function_privilege('hid_event_delivery_commands', helper, 'EXECUTE') then
    raise exception 'only the worker may call the claim function and only its owner the helper';
  end if;
  foreach role_name in array array['hid_identity_api_runtime', 'hid_identity_runtime', 'hid_ehr_api_runtime',
    'hid_event_dispatcher', 'hid_notification_api_runtime', 'hid_notification_runtime', 'hid_schema_test_runtime',
    'hid_migration_admin'] loop
    if has_function_privilege(role_name, claim_function, 'EXECUTE') or has_function_privilege(role_name, helper, 'EXECUTE') then
      raise exception '% can execute a recipient function', role_name;
    end if;
  end loop;
end
$$;

-- The worker claims every fixture event as it would (live claim, 60 s lease);
-- A-mismatch with a correlation id its outbox row does not carry.
set local role hid_notification_worker;
insert into recipient_claims
select fixture.label, claimed.claim_token
from recipient_fixture fixture
cross join lateral integration.claim_inbox_message('notification-worker-v1', fixture.event_id, 'identity',
  fixture.event_type, 1,
  case when fixture.label = 'A-mismatch' then 'recipient-suite-a-9999' else fixture.correlation_id end,
  repeat('a', 64)::character(64), 'notification-worker-recipient-suite', 60) claimed;

-- The worker reads no patient or login row directly.
do $$
begin
  begin
    perform 1 from identity.patients limit 1;
    raise exception 'the notification worker read identity.patients';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from auth.accounts limit 1;
    raise exception 'the notification worker read auth.accounts';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from identity.patient_account_deletion_requests limit 1;
    raise exception 'the notification worker read identity.patient_account_deletion_requests';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from integration.notification_recipient_state('e9200000-0000-4000-8000-00000000000a');
    raise exception 'the notification worker executed the private recipient helper';
  exception when insufficient_privilege then null;
  end;
end
$$;

-- The answers: A, L and M get their verified email. B (phone-only), C
-- (unverified), D (deleted login), E (deceased), F (opted out, for an
-- ordinary and a safety event), G (no login), H (locked login), I (blank
-- email), J (suspended), K (deletion due), N (disabled login), P
-- (pending_reset), Q (inactive patient) and R (merged patient) are
-- withheld: the trigger still goes in-app, without email. The answer
-- follows main's own test of a usable patient login.
do $$
declare
  expected record;
  answer record;
  answers integer;
begin
  for expected in select * from (values
    ('A', 'email', 'recipient-a@example.invalid'), ('B', 'withhold', null), ('C', 'withhold', null),
    ('D', 'withhold', null), ('E', 'withhold', null), ('F', 'withhold', null), ('F-safety', 'withhold', null),
    ('G', 'withhold', null), ('H', 'withhold', null), ('I', 'withhold', null), ('J', 'withhold', null),
    ('K', 'withhold', null), ('L', 'email', 'recipient-l@example.invalid'), ('M', 'email', 'recipient-m@example.invalid'),
    ('N', 'withhold', null), ('P', 'withhold', null), ('Q', 'withhold', null), ('R', 'withhold', null)
  ) as rows(label, delivery, email) loop
    answers := 0;
    for answer in
      select result.* from recipient_fixture fixture join recipient_claims claim using (label)
      cross join lateral integration.notification_recipient_for_claim(fixture.event_id, claim.claim_token, fixture.patient_id) result
      where fixture.label = expected.label
    loop
      answers := answers + 1;
      if answer.delivery is distinct from expected.delivery or answer.email is distinct from expected.email then
        raise exception 'fixture % answered (%, %), expected (%, %)', expected.label, answer.delivery,
          coalesce(answer.email, 'null'), expected.delivery, coalesce(expected.email, 'null');
      end if;
    end loop;
    if answers <> 1 then
      raise exception 'fixture % gave % rows, expected one', expected.label, answers;
    end if;
  end loop;
end
$$;

-- The claim binds the answer to the claimed outbox event and its patient: a
-- live claim names no other patient, a claim with another correlation id
-- binds nothing, and an event without a notification workflow binds nothing.
do $$
declare
  rows_seen integer;
begin
  select count(*) into rows_seen from recipient_fixture fixture join recipient_claims claim using (label)
   cross join lateral integration.notification_recipient_for_claim(fixture.event_id, claim.claim_token,
     'e9200000-0000-4000-8000-00000000000f') result
   where fixture.label = 'A';
  if rows_seen <> 0 then raise exception 'a claim on A answered for another patient'; end if;
  select count(*) into rows_seen from recipient_fixture fixture join recipient_claims claim using (label)
   cross join lateral integration.notification_recipient_for_claim(fixture.event_id, claim.claim_token, fixture.patient_id) result
   where fixture.label = 'A-mismatch';
  if rows_seen <> 0 then raise exception 'a claim with a foreign correlation id bound an outbox event'; end if;
  select count(*) into rows_seen from recipient_fixture fixture join recipient_claims claim using (label)
   cross join lateral integration.notification_recipient_for_claim(fixture.event_id, claim.claim_token, fixture.patient_id) result
   where fixture.label = 'A-unrouted';
  if rows_seen <> 0 then raise exception 'an event without a notification workflow bound a recipient'; end if;
end
$$;

-- A token the worker does not hold, a claim on another event and an expired
-- claim are refused as stale (55000), the message complete_inbox_message uses.
do $$
begin
  begin
    perform * from integration.notification_recipient_for_claim('e9300000-0000-4000-8000-00000000000a',
      gen_random_uuid(), 'e9200000-0000-4000-8000-00000000000a');
    raise exception 'a random claim token was accepted';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'Inbox claim is stale or not owned' then raise; end if;
  end;
  begin
    perform * from integration.notification_recipient_for_claim('e9300000-0000-4000-8000-00000000000a',
      (select claim_token from recipient_claims where label = 'B'), 'e9200000-0000-4000-8000-00000000000a');
    raise exception 'the claim on another event was accepted';
  exception when object_not_in_prerequisite_state then null;
  end;
end
$$;
reset role;
update integration.inbox_messages set claim_expires_at = clock_timestamp() - interval '1 second'
 where consumer_name = 'notification-worker-v1' and event_id = 'e9300000-0000-4000-8000-0000000000a4';
set local role hid_notification_worker;
do $$
begin
  perform * from integration.notification_recipient_for_claim('e9300000-0000-4000-8000-0000000000a4',
    (select claim_token from recipient_claims where label = 'A-expired'), 'e9200000-0000-4000-8000-00000000000a');
  raise exception 'an expired claim was accepted';
exception when object_not_in_prerequisite_state then null;
end
$$;
reset role;

-- The consumer row must be enabled and still bound to the worker role.
savepoint consumer_disabled;
update integration.inbox_consumers set enabled = false where consumer_name = 'notification-worker-v1';
set local role hid_notification_worker;
do $$
begin
  perform * from integration.notification_recipient_for_claim('e9300000-0000-4000-8000-00000000000a',
    (select claim_token from recipient_claims where label = 'A'), 'e9200000-0000-4000-8000-00000000000a');
  raise exception 'a disabled inbox consumer was accepted';
exception when insufficient_privilege then null;
end
$$;
reset role;
rollback to savepoint consumer_disabled;
savepoint consumer_rebound;
update integration.inbox_consumers set database_role = 'hid_schema_test_runtime'
 where consumer_name = 'notification-worker-v1';
set local role hid_schema_test_runtime;
do $$
begin
  perform * from integration.notification_recipient_for_claim('e9300000-0000-4000-8000-00000000000a',
    (select claim_token from recipient_claims where label = 'A'), 'e9200000-0000-4000-8000-00000000000a');
  raise exception 'the schema test role executed the claim function';
exception when insufficient_privilege then null;
end
$$;
reset role;
-- The superuser running this suite is a member of every role, so the
-- membership check passes and the explicit worker-role binding refuses.
do $$
begin
  perform * from integration.notification_recipient_for_claim('e9300000-0000-4000-8000-00000000000a',
    (select claim_token from recipient_claims where label = 'A'), 'e9200000-0000-4000-8000-00000000000a');
  raise exception 'a consumer rebound to another role was accepted';
exception when insufficient_privilege then
  if sqlerrm <> 'Notification consumer authorization required' then raise; end if;
end
$$;
rollback to savepoint consumer_rebound;

-- No other runtime may call the claim function.
set local role hid_identity_api_runtime;
do $$
begin
  perform * from integration.notification_recipient_for_claim('e9300000-0000-4000-8000-00000000000a',
    gen_random_uuid(), 'e9200000-0000-4000-8000-00000000000a');
  raise exception 'the Identity runtime executed the claim function';
exception when insufficient_privilege then null;
end
$$;
reset role;
set local role hid_event_dispatcher;
do $$
begin
  perform * from integration.notification_recipient_for_claim('e9300000-0000-4000-8000-00000000000a',
    gen_random_uuid(), 'e9200000-0000-4000-8000-00000000000a');
  raise exception 'the event dispatcher executed the claim function';
exception when insufficient_privilege then null;
end
$$;
reset role;
set local role hid_notification_api_runtime;
do $$
begin
  perform * from integration.notification_recipient_for_claim('e9300000-0000-4000-8000-00000000000a',
    gen_random_uuid(), 'e9200000-0000-4000-8000-00000000000a');
  raise exception 'the notification API runtime executed the claim function';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- The lookup changes nothing: every claim is still live and unprocessed.
do $$
begin
  if exists (select 1 from integration.inbox_messages message join recipient_fixture fixture using (event_id)
              where message.consumer_name = 'notification-worker-v1'
                and (message.status <> 'processing' or message.attempt_count <> 1)) then
    raise exception 'the recipient lookup changed an inbox claim';
  end if;
end
$$;

rollback;
