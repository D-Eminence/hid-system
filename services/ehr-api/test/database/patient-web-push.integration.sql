\set ON_ERROR_STOP on
-- Phone and computer notifications (0097, B6): the patient's web push
-- subscriptions and their delivery state. Covers: the boundary (no runtime
-- role reads the table; the six commands to the Identity and schema test
-- runtimes only; the helpers to no role); subscribe, re-subscribe (same id),
-- rebind to another sign-in, one per sign-in, another account's endpoint
-- reassigned, the 10 limit evicting the least recently bound; unsubscribe;
-- the list (never the ciphertext); 42501 without a live session, after
-- logout, after the token version changes and with a deletion due; a refresh
-- keeps the subscription; the claim (nothing without a new unread item,
-- nothing within 2 minutes of a delivery, nothing for another key id,
-- nothing for an ended or suspended sign-in, the lease, its expiry); every
-- outcome branch and the backoff values; the prune's reasons; account
-- deletion erasing them inside 0096's completion; the guard; and audit rows
-- without an endpoint, digest or session id. Two-session SKIP LOCKED runs in
-- the build's race harness (two connections). Rollback-only. Synthetic
-- values only; uuid prefix 97a.
begin;
set constraints all deferred;

-- Six patients with patient sessions. Patient 1 has twelve sign-ins (the
-- limit), patient 3 two (claims and outcomes), patient 6 two (the prune).
insert into auth.accounts (id, subject, email, display_name, status)
select ('97a10000-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid, 'synthetic:webpush:' || k,
  'webpush-' || k || '@example.invalid', 'Web Push ' || k, 'active'
from generate_series(1, 6) k;
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status)
select ('97a20000-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid,
  ('97a10000-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid,
  'HID-WEBPSH' || chr(64 + k), 'Web', 'Push ' || k, 'Web Push ' || k, 'active'
from generate_series(1, 6) k;
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('97a30000-0000-4000-8000-' || lpad((s.k * 100 + s.n)::text, 12, '0'))::uuid,
  ('97a10000-0000-4000-8000-' || lpad(s.k::text, 12, '0'))::uuid,
  ('97a30000-0000-4000-8000-' || lpad((s.k * 100 + s.n)::text, 12, '0'))::uuid,
  md5('webpush' || s.k || ':' || s.n) || md5('session' || s.k || ':' || s.n), gen_random_uuid(), 1, 'password',
  clock_timestamp() - interval '1 minute', clock_timestamp() + interval '7 days', clock_timestamp() + interval '30 days',
  'patient', ('97a20000-0000-4000-8000-' || lpad(s.k::text, 12, '0'))::uuid
from (select 1 as k, n from generate_series(1, 12) n
      union all select 2, 1 union all select 3, 1 union all select 3, 2 union all select 4, 1
      union all select 5, 1 union all select 6, 1 union all select 6, 2) s;

create temporary table web_push_audit_baseline on commit drop as
  select coalesce(max(sequence_id), 0)::bigint as last_sequence from audit.events;
grant select on web_push_audit_baseline to public;

-- The boundary. No runtime role holds any privilege on the table (and row
-- level security is forced for its owner's policy only); the six commands
-- belong to the Identity and schema test runtimes; the helpers and trigger
-- functions to no role.
do $$
declare offender text;
begin
  select string_agg(format('%s %s', role_row.rolname, privilege.name), ', ') into offender
    from pg_roles role_row
   cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege(name)
   where role_row.rolname like 'hid\_%' and role_row.rolname <> 'hid_synthetic_schema_owner'
     and not role_row.rolsuper
     and pg_has_role(role_row.oid, (select relowner from pg_class
                                     where oid = 'notification.web_push_subscriptions'::regclass), 'USAGE') = false
     and has_table_privilege(role_row.oid, 'notification.web_push_subscriptions', privilege.name);
  if offender is not null then
    raise exception 'A runtime role holds a privilege on notification.web_push_subscriptions: %', offender;
  end if;
  if not exists (select 1 from pg_class where oid = 'notification.web_push_subscriptions'::regclass
                  and relrowsecurity and relforcerowsecurity) then
    raise exception 'Row-level security is not forced on notification.web_push_subscriptions';
  end if;
  select string_agg(format('%s %s', role_row.rolname, proc.oid::regprocedure), ', ') into offender
    from pg_roles role_row cross join pg_proc proc
   where role_row.rolname in ('hid_identity_runtime', 'hid_identity_api_runtime', 'hid_schema_test_runtime',
           'hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_lab_runtime', 'hid_pharmacy_runtime',
           'hid_notification_runtime', 'hid_notification_api_runtime', 'hid_notification_worker')
     and proc.oid in ('identity.web_push_audit(text,text,uuid,uuid,text,text,uuid,jsonb)'::regprocedure,
           'identity.web_push_remove(uuid,text,text,text,uuid)'::regprocedure,
           'identity.web_push_sign_in_live(uuid,uuid,uuid,boolean)'::regprocedure,
           'notification.remove_web_push_for_deleted_account()'::regprocedure,
           'notification.guard_web_push_subscription_mutation()'::regprocedure)
     and has_function_privilege(role_row.oid, proc.oid, 'EXECUTE');
  if offender is not null then
    raise exception 'An internal web push function is executable by a runtime role: %', offender;
  end if;
  select string_agg(format('%s %s %s', role_row.rolname, proc.oid::regprocedure,
           has_function_privilege(role_row.oid, proc.oid, 'EXECUTE')), ', ') into offender
    from pg_roles role_row cross join pg_proc proc
   where role_row.rolname in ('hid_identity_runtime', 'hid_schema_test_runtime', 'hid_ehr_runtime',
           'hid_lab_runtime', 'hid_pharmacy_runtime', 'hid_notification_runtime', 'hid_notification_worker')
     and proc.oid in ('identity.subscribe_my_web_push(text,uuid,uuid,text,bytea,text,text,text)'::regprocedure,
           'identity.unsubscribe_my_web_push(text,uuid,text)'::regprocedure,
           'identity.list_my_web_push_subscriptions(text,uuid)'::regprocedure,
           'identity.claim_web_push_deliveries(text,integer,integer,text)'::regprocedure,
           'identity.record_web_push_outcome(uuid,text,text,integer,text)'::regprocedure,
           'identity.prune_web_push_subscriptions(integer)'::regprocedure)
     and has_function_privilege(role_row.oid, proc.oid, 'EXECUTE')
         <> (role_row.rolname in ('hid_identity_runtime', 'hid_schema_test_runtime'));
  if offender is not null then
    raise exception 'The web push commands are granted to more or fewer roles than the Identity and test runtimes: %', offender;
  end if;
  if exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.pronamespace in ('identity'::regnamespace, 'notification'::regnamespace)
                and proc.proname like '%web_push%' and acl.grantee = 0) then
    raise exception 'A web push function is executable by PUBLIC';
  end if;
  -- The list never returns the ciphertext, a key or a session.
  if pg_get_function_result('identity.list_my_web_push_subscriptions(text,uuid)'::regprocedure)
     <> 'TABLE(subscription_id uuid, endpoint_sha256 text, push_service text, this_sign_in boolean, vapid_key_id text, created_at timestamp with time zone, bound_at timestamp with time zone, last_delivered_at timestamp with time zone)' then
    raise exception 'The list returns other columns: %',
      pg_get_function_result('identity.list_my_web_push_subscriptions(text,uuid)'::regprocedure);
  end if;
end
$$;

-- The Identity and test runtimes cannot read the table directly.
set local role hid_identity_runtime;
do $$
begin
  begin
    perform 1 from notification.web_push_subscriptions;
    raise exception 'hid_identity_runtime read notification.web_push_subscriptions';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;
set local role hid_schema_test_runtime;
do $$
begin
  begin
    perform 1 from notification.web_push_subscriptions;
    raise exception 'hid_schema_test_runtime read notification.web_push_subscriptions';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

-- Subscribe: refusals before anything is written, then a first
-- subscription, a re-subscribe that keeps its id, a rebind to another
-- sign-in, and one per sign-in.
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'synthetic:webpush:1', true),
  set_config('app.correlation_id', 'web-push-integration-0001', true);
do $$
declare
  result record;
  listed record;
  e1 constant text := encode(sha256(convert_to('https://fcm.googleapis.com/fcm/send/webpush-e1', 'UTF8')), 'hex');
  e2 constant text := encode(sha256(convert_to('https://fcm.googleapis.com/fcm/send/webpush-e2', 'UTF8')), 'hex');
  cipher constant bytea := decode(repeat('ab', 60), 'hex');
  s101 constant uuid := '97a30000-0000-4000-8000-000000000101';
  s102 constant uuid := '97a30000-0000-4000-8000-000000000102';
begin
  -- Another patient's session, and a subject other than the actor's.
  begin
    perform identity.subscribe_my_web_push('synthetic:webpush:1', '97a30000-0000-4000-8000-000000000201',
      '97a40000-0000-4000-8000-000000000001', e1, cipher, 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
    raise exception 'Subscribed with another patient''s session';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.subscribe_my_web_push('synthetic:webpush:2', '97a30000-0000-4000-8000-000000000201',
      '97a40000-0000-4000-8000-000000000001', e1, cipher, 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
    raise exception 'Subscribed with a subject other than the actor''s';
  exception when insufficient_privilege then null;
  end;
  -- Each malformed argument is 22023.
  begin perform identity.subscribe_my_web_push('synthetic:webpush:1', s101, null, e1, cipher, 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
    raise exception 'null id accepted'; exception when invalid_parameter_value then null; end;
  begin perform identity.subscribe_my_web_push('synthetic:webpush:1', s101, gen_random_uuid(), upper(e1), cipher, 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
    raise exception 'upper-case digest accepted'; exception when invalid_parameter_value then null; end;
  begin perform identity.subscribe_my_web_push('synthetic:webpush:1', s101, gen_random_uuid(), e1, decode(repeat('ab', 29), 'hex'), 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
    raise exception 'short ciphertext accepted'; exception when invalid_parameter_value then null; end;
  begin perform identity.subscribe_my_web_push('synthetic:webpush:1', s101, gen_random_uuid(), e1, decode(repeat('ab', 2101), 'hex'), 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
    raise exception 'long ciphertext accepted'; exception when invalid_parameter_value then null; end;
  begin perform identity.subscribe_my_web_push('synthetic:webpush:1', s101, gen_random_uuid(), e1, cipher, 'local v1', 'fcm', 'aaaaaaaaaaaaaaaa');
    raise exception 'key version with a space accepted'; exception when invalid_parameter_value then null; end;
  begin perform identity.subscribe_my_web_push('synthetic:webpush:1', s101, gen_random_uuid(), e1, cipher, 'local-v1', 'evil', 'aaaaaaaaaaaaaaaa');
    raise exception 'unknown push service accepted'; exception when invalid_parameter_value then null; end;
  begin perform identity.subscribe_my_web_push('synthetic:webpush:1', s101, gen_random_uuid(), e1, cipher, 'local-v1', 'fcm', 'AAAAAAAAAAAAAAAA');
    raise exception 'upper-case key id accepted'; exception when invalid_parameter_value then null; end;

  select * into result from identity.subscribe_my_web_push('synthetic:webpush:1', s101,
    '97a40000-0000-4000-8000-000000000001', e1, cipher, 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
  if result.subscription_id <> '97a40000-0000-4000-8000-000000000001' or not result.created then
    raise exception 'First subscription not created: %', result;
  end if;
  -- The same endpoint again in the same sign-in keeps its id.
  select * into result from identity.subscribe_my_web_push('synthetic:webpush:1', s101,
    '97a40000-0000-4000-8000-000000000099', e1, cipher, 'local-v1', 'fcm', 'aaaaaaaaaaaaaaab');
  if result.subscription_id <> '97a40000-0000-4000-8000-000000000001' or result.created then
    raise exception 'Re-subscribe did not keep its id: %', result;
  end if;
  select * into listed from identity.list_my_web_push_subscriptions('synthetic:webpush:1', s101);
  if listed.subscription_id <> '97a40000-0000-4000-8000-000000000001' or listed.endpoint_sha256 <> e1
     or listed.push_service <> 'fcm' or not listed.this_sign_in or listed.vapid_key_id <> 'aaaaaaaaaaaaaaab'
     or listed.last_delivered_at is not null then
    raise exception 'List is wrong: %', listed;
  end if;
  -- The same endpoint from another sign-in (the patient signed in again):
  -- rebound there, same id; the first sign-in no longer owns it.
  select * into result from identity.subscribe_my_web_push('synthetic:webpush:1', s102,
    '97a40000-0000-4000-8000-000000000098', e1, cipher, 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
  if result.subscription_id <> '97a40000-0000-4000-8000-000000000001' or result.created then
    raise exception 'Rebind did not keep its id: %', result;
  end if;
  select * into listed from identity.list_my_web_push_subscriptions('synthetic:webpush:1', s101);
  if listed.this_sign_in then raise exception 'The old sign-in still owns the rebound subscription'; end if;
  select * into listed from identity.list_my_web_push_subscriptions('synthetic:webpush:1', s102);
  if not listed.this_sign_in then raise exception 'The new sign-in does not own the rebound subscription'; end if;
  -- One per sign-in: a new endpoint in sign-in 102 replaces the old one.
  select * into result from identity.subscribe_my_web_push('synthetic:webpush:1', s102,
    '97a40000-0000-4000-8000-000000000002', e2, cipher, 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
  if result.subscription_id <> '97a40000-0000-4000-8000-000000000002' or not result.created then
    raise exception 'A new endpoint in the sign-in was not created: %', result;
  end if;
  if (select count(*) from identity.list_my_web_push_subscriptions('synthetic:webpush:1', s102)) <> 1 then
    raise exception 'The sign-in has more than one subscription';
  end if;
end
$$;
reset role;
do $$
declare row_value record;
begin
  select * into row_value from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000001';
  if row_value.status <> 'removed' or row_value.removal_reason <> 'replaced_in_sign_in'
     or row_value.endpoint_ciphertext is not null or row_value.endpoint_sha256 is not null
     or row_value.removed_at is null or row_value.lease_owner is not null
     or row_value.session_family_id <> '97a30000-0000-4000-8000-000000000102' then
    raise exception 'Replaced row is not erased: %', row_value;
  end if;
  if (select count(*) from notification.web_push_subscriptions where id in
        ('97a40000-0000-4000-8000-000000000099', '97a40000-0000-4000-8000-000000000098')) <> 0 then
    raise exception 'A re-subscribe inserted a row';
  end if;
end
$$;

-- Another account subscribes the same endpoint (the device changed hands):
-- patient 1's row is removed as endpoint_reassigned, audited for patient 1.
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'synthetic:webpush:2', true);
do $$
declare result record;
begin
  select * into result from identity.subscribe_my_web_push('synthetic:webpush:2', '97a30000-0000-4000-8000-000000000201',
    '97a40000-0000-4000-8000-000000000201',
    encode(sha256(convert_to('https://fcm.googleapis.com/fcm/send/webpush-e2', 'UTF8')), 'hex'),
    decode(repeat('cd', 60), 'hex'), 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
  if result.subscription_id <> '97a40000-0000-4000-8000-000000000201' or not result.created then
    raise exception 'The new owner''s subscription was not created: %', result;
  end if;
  -- Patient 2 cannot remove patient 1's endpoint, which is no longer active anyway.
  if identity.unsubscribe_my_web_push('synthetic:webpush:2', '97a30000-0000-4000-8000-000000000201',
       encode(sha256(convert_to('https://fcm.googleapis.com/fcm/send/webpush-e1', 'UTF8')), 'hex')) then
    raise exception 'Patient 2 removed an endpoint that is not theirs';
  end if;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000002'
                  and status = 'removed' and removal_reason = 'endpoint_reassigned' and endpoint_sha256 is null)
     or not exists (select 1 from audit.events event, web_push_audit_baseline baseline
                     where event.sequence_id > baseline.last_sequence
                       and event.action = 'identity.patient.web-push.removed' and event.actor_type = 'system'
                       and event.patient_id = '97a20000-0000-4000-8000-000000000001'
                       and event.resource_id = '97a40000-0000-4000-8000-000000000002'
                       and event.details = '{"reason": "endpoint_reassigned"}'::jsonb) then
    raise exception 'The reassigned endpoint was not removed and audited for its previous owner';
  end if;
end
$$;

-- The limit: ten sign-ins of patient 1 subscribe (ten active rows); the
-- eleventh evicts the least recently bound one.
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'synthetic:webpush:1', true);
do $$
declare result record; n integer;
begin
  for n in 1..10 loop
    select * into result from identity.subscribe_my_web_push('synthetic:webpush:1',
      ('97a30000-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid,
      ('97a40000-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid,
      encode(sha256(convert_to('https://updates.push.services.mozilla.com/wpush/v2/limit-' || n, 'UTF8')), 'hex'),
      decode(repeat('ef', 60), 'hex'), 'local-v1', 'mozilla', 'aaaaaaaaaaaaaaaa');
    if not result.created then raise exception 'Limit fixture % not created', n; end if;
  end loop;
  -- Patient 1 had none active (its last one went to patient 2), so ten are now.
  if (select count(*) from identity.list_my_web_push_subscriptions('synthetic:webpush:1',
        '97a30000-0000-4000-8000-000000000101')) <> 10 then
    raise exception 'Ten subscriptions expected';
  end if;
  select * into result from identity.subscribe_my_web_push('synthetic:webpush:1',
    '97a30000-0000-4000-8000-000000000111', '97a40000-0000-4000-8000-000000000111',
    encode(sha256(convert_to('https://web.push.apple.com/limit-11', 'UTF8')), 'hex'),
    decode(repeat('ef', 60), 'hex'), 'local-v1', 'apple', 'aaaaaaaaaaaaaaaa');
  if not result.created or (select count(*) from identity.list_my_web_push_subscriptions('synthetic:webpush:1',
        '97a30000-0000-4000-8000-000000000101')) <> 10 then
    raise exception 'The eleventh did not keep the limit at ten';
  end if;
  if exists (select 1 from identity.list_my_web_push_subscriptions('synthetic:webpush:1',
               '97a30000-0000-4000-8000-000000000101') listed
              where listed.subscription_id = '97a40000-0000-4000-8000-000000000101') then
    raise exception 'The least recently bound subscription was not evicted';
  end if;
  -- Unsubscribe: true once, then false (idempotent); a malformed digest is 22023.
  if not identity.unsubscribe_my_web_push('synthetic:webpush:1', '97a30000-0000-4000-8000-000000000103',
       encode(sha256(convert_to('https://updates.push.services.mozilla.com/wpush/v2/limit-3', 'UTF8')), 'hex')) then
    raise exception 'Unsubscribe removed nothing';
  end if;
  if identity.unsubscribe_my_web_push('synthetic:webpush:1', '97a30000-0000-4000-8000-000000000103',
       encode(sha256(convert_to('https://updates.push.services.mozilla.com/wpush/v2/limit-3', 'UTF8')), 'hex')) then
    raise exception 'A second unsubscribe removed something';
  end if;
  begin
    perform identity.unsubscribe_my_web_push('synthetic:webpush:1', '97a30000-0000-4000-8000-000000000103', 'nope');
    raise exception 'Malformed digest accepted';
  exception when invalid_parameter_value then null;
  end;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000101'
                  and status = 'removed' and removal_reason = 'replaced_by_newer')
     or not exists (select 1 from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000103'
                     and status = 'removed' and removal_reason = 'patient_turned_off' and endpoint_ciphertext is null)
     or (select count(*) from notification.web_push_subscriptions
          where account_id = '97a10000-0000-4000-8000-000000000001' and status = 'active') <> 9 then
    raise exception 'Eviction or unsubscribe left the wrong rows';
  end if;
end
$$;

-- A live session is required: after logout, after the token version
-- changes, and once a deletion is due, every patient command is 42501.
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'synthetic:webpush:4', true);
do $$
declare result record;
begin
  select * into result from identity.subscribe_my_web_push('synthetic:webpush:4', '97a30000-0000-4000-8000-000000000401',
    '97a40000-0000-4000-8000-000000000401',
    encode(sha256(convert_to('https://wns2-par02p.notify.windows.com/w/?token=webpush-4', 'UTF8')), 'hex'),
    decode(repeat('ab', 60), 'hex'), 'local-v1', 'windows', 'aaaaaaaaaaaaaaaa');
  if not result.created then raise exception 'Patient 4 not subscribed'; end if;
end
$$;
reset role;
update auth.sessions set revoked_at = clock_timestamp(), revocation_reason = 'logout'
 where id = '97a30000-0000-4000-8000-000000000401';
set local role hid_identity_runtime;
do $$
begin
  begin
    perform identity.list_my_web_push_subscriptions('synthetic:webpush:4', '97a30000-0000-4000-8000-000000000401');
    raise exception 'Listed after logout';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.unsubscribe_my_web_push('synthetic:webpush:4', '97a30000-0000-4000-8000-000000000401', repeat('a', 64));
    raise exception 'Unsubscribed after logout';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;
update auth.sessions set revoked_at = null, revocation_reason = null where id = '97a30000-0000-4000-8000-000000000401';
update auth.accounts set token_version = token_version + 1 where id = '97a10000-0000-4000-8000-000000000004';
set local role hid_identity_runtime;
do $$
begin
  begin
    perform identity.list_my_web_push_subscriptions('synthetic:webpush:4', '97a30000-0000-4000-8000-000000000401');
    raise exception 'Listed after the token version changed';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;
update auth.accounts set token_version = 1 where id = '97a10000-0000-4000-8000-000000000004';
insert into identity.patient_account_deletion_requests (id, account_id, patient_id, requested_session_id, state,
  confirmation_token_sha256, confirmation_expires_at, confirmation_consumed_at, requested_at, confirmed_at,
  waiting_period, scheduled_for, correlation_id) values
  ('97a50000-0000-4000-8000-000000000004', '97a10000-0000-4000-8000-000000000004',
   '97a20000-0000-4000-8000-000000000004', '97a30000-0000-4000-8000-000000000401', 'pending', repeat('4', 64),
   clock_timestamp() - interval '1 day' + interval '10 minutes', clock_timestamp() - interval '1 day',
   clock_timestamp() - interval '1 day', clock_timestamp() - interval '1 day', interval '14 days',
   clock_timestamp() - interval '1 minute', 'web-push-deletion-0004');
set local role hid_identity_runtime;
do $$
begin
  begin
    perform identity.subscribe_my_web_push('synthetic:webpush:4', '97a30000-0000-4000-8000-000000000401',
      gen_random_uuid(), repeat('b', 64), decode(repeat('ab', 60), 'hex'), 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
    raise exception 'Subscribed with a deletion due';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

-- Claims and outcomes (patient 3, key cccccccccccccccc). The system
-- commands need the system context.
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'synthetic:webpush:3', true);
do $$
declare result record;
begin
  select * into result from identity.subscribe_my_web_push('synthetic:webpush:3', '97a30000-0000-4000-8000-000000000301',
    '97a40000-0000-4000-8000-000000000301',
    encode(sha256(convert_to('https://fcm.googleapis.com/fcm/send/webpush-3a', 'UTF8')), 'hex'),
    decode(repeat('ab', 60), 'hex'), 'local-v1', 'fcm', 'cccccccccccccccc');
  select * into result from identity.subscribe_my_web_push('synthetic:webpush:3', '97a30000-0000-4000-8000-000000000302',
    '97a40000-0000-4000-8000-000000000302',
    encode(sha256(convert_to('https://web.push.apple.com/webpush-3b', 'UTF8')), 'hex'),
    decode(repeat('ab', 60), 'hex'), 'local-v1', 'apple', 'cccccccccccccccc');
  -- A patient context cannot claim, record or prune.
  begin
    perform identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc');
    raise exception 'A patient context claimed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000301', 'identity-api:worker-1', 'accepted', null, null);
    raise exception 'A patient context recorded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform identity.prune_web_push_subscriptions(10);
    raise exception 'A patient context pruned';
  exception when insufficient_privilege then null;
  end;
end
$$;
select set_config('app.actor_subject', 'system:auth', true);
do $$
declare claimed integer;
begin
  -- Invalid claims, outcomes and prunes are 22023.
  begin perform identity.claim_web_push_deliveries('x', 10, 60, 'cccccccccccccccc');
    raise exception 'bad worker'; exception when invalid_parameter_value then null; end;
  begin perform identity.claim_web_push_deliveries('identity-api:worker-1', 51, 60, 'cccccccccccccccc');
    raise exception 'limit 51'; exception when invalid_parameter_value then null; end;
  begin perform identity.claim_web_push_deliveries('identity-api:worker-1', 10, 14, 'cccccccccccccccc');
    raise exception 'lease 14'; exception when invalid_parameter_value then null; end;
  begin perform identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccc');
    raise exception 'short key id'; exception when invalid_parameter_value then null; end;
  begin perform identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000301', 'identity-api:worker-1', 'sent', null, null);
    raise exception 'outcome sent'; exception when invalid_parameter_value then null; end;
  begin perform identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000301', 'identity-api:worker-1', 'retry', 86401, null);
    raise exception 'retry after 86401'; exception when invalid_parameter_value then null; end;
  begin perform identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000301', 'identity-api:worker-1', 'retry', null, 'Bad Code');
    raise exception 'bad safe code'; exception when invalid_parameter_value then null; end;
  begin perform identity.prune_web_push_subscriptions(501);
    raise exception 'prune 501'; exception when invalid_parameter_value then null; end;
  -- No unread inbox item newer than the watermark: nothing to claim.
  select count(*) into claimed from identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc');
  if claimed <> 0 then raise exception 'Claimed without a new inbox item'; end if;
end
$$;
reset role;
-- A read item causes no push; an unread one does.
select notification.enqueue_patient_inbox_item('97a20000-0000-4000-8000-000000000003', 'WEB_PUSH_TEST', null, null, '{}');
update notification.inbox_items set read_at = clock_timestamp()
 where account_id = '97a10000-0000-4000-8000-000000000003';
set local role hid_identity_runtime;
do $$
begin
  if exists (select 1 from identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc')) then
    raise exception 'A read item caused a push';
  end if;
end
$$;
reset role;
select notification.enqueue_patient_inbox_item('97a20000-0000-4000-8000-000000000003', 'WEB_PUSH_TEST', null, null, '{}');
set local role hid_identity_runtime;
do $$
declare
  claimed record;
  claim_count integer := 0;
  newest timestamptz;
begin
  perform set_config('role', 'none', true);
  select max(created_at) into newest from notification.inbox_items where account_id = '97a10000-0000-4000-8000-000000000003';
  perform set_config('role', 'hid_identity_runtime', true);
  if exists (select 1 from identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'dddddddddddddddd')) then
    raise exception 'Claimed for another key id';
  end if;
  for claimed in select * from identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc') loop
    claim_count := claim_count + 1;
    if claimed.claimed_through <> newest or claimed.attempt_count <> 0 or claimed.endpoint_key_version <> 'local-v1'
       or claimed.endpoint_ciphertext <> decode(repeat('ab', 60), 'hex') then
      raise exception 'Claim row is wrong: %', claimed;
    end if;
  end loop;
  if claim_count <> 2 then raise exception 'Both of patient 3''s subscriptions should be claimed, got %', claim_count; end if;
  -- Leased: another worker gets nothing and cannot record.
  if exists (select 1 from identity.claim_web_push_deliveries('identity-api:worker-2', 10, 60, 'cccccccccccccccc')) then
    raise exception 'A leased subscription was claimed again';
  end if;
  if identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000301', 'identity-api:worker-2', 'accepted', null, null)
     <> 'lease_lost' then
    raise exception 'Another worker recorded an outcome';
  end if;
  if identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000301', 'identity-api:worker-1', 'accepted', null, null)
     <> 'delivered' then
    raise exception 'Accepted was not delivered';
  end if;
  -- 404/410 from the push service: removed.
  if identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000302', 'identity-api:worker-1', 'gone', null, 'push_410')
     <> 'removed' then
    raise exception 'Gone was not removed';
  end if;
  if identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000302', 'identity-api:worker-1', 'accepted', null, null)
     <> 'lease_lost' then
    raise exception 'A removed subscription recorded an outcome';
  end if;
end
$$;
reset role;
do $$
declare row_value record; newest timestamptz;
begin
  select max(created_at) into newest from notification.inbox_items where account_id = '97a10000-0000-4000-8000-000000000003';
  select * into row_value from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000301';
  if row_value.delivered_through <> newest or row_value.last_delivered_at is null or row_value.delivered_count <> 1
     or row_value.lease_owner is not null or row_value.claimed_through is not null
     or row_value.last_outcome_code <> 'accepted' then
    raise exception 'Delivered row is wrong: %', row_value;
  end if;
  select * into row_value from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000302';
  if row_value.status <> 'removed' or row_value.removal_reason <> 'push_service_gone'
     or row_value.last_outcome_code <> 'push_410' or row_value.endpoint_ciphertext is not null then
    raise exception 'Gone row is wrong: %', row_value;
  end if;
end
$$;

-- Coalescing: a new item within 2 minutes of a delivery waits.
select notification.enqueue_patient_inbox_item('97a20000-0000-4000-8000-000000000003', 'WEB_PUSH_TEST', null, null, '{}');
set local role hid_identity_runtime;
do $$
begin
  if exists (select 1 from identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc')) then
    raise exception 'Claimed within 2 minutes of a delivery';
  end if;
end
$$;
reset role;
update notification.web_push_subscriptions set last_delivered_at = clock_timestamp() - interval '2 minutes 1 second'
 where id = '97a40000-0000-4000-8000-000000000301';

-- Retries: 1, 2, 4, 8, 16 minutes, then the sixth failure drops the round.
-- A Retry-After longer than the backoff is honoured, capped at an hour.
set local role hid_identity_runtime;
do $$
declare
  attempt integer;
  outcome text;
  row_value record;
  expected integer[] := array[60, 120, 240, 480, 960];
  waited double precision;
  claimed_at timestamptz;
begin
  for attempt in 1..6 loop
    select claimed_through into claimed_at
      from identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc');
    if claimed_at is null then raise exception 'Retry round % not claimed', attempt; end if;
    outcome := identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000301', 'identity-api:worker-1',
      'retry', case when attempt = 2 then 0 else null end, 'push_5xx');
    perform set_config('role', 'none', true);
    select * into row_value from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000301';
    if attempt < 6 then
      waited := extract(epoch from row_value.next_attempt_at - clock_timestamp());
      if outcome <> 'retrying' or row_value.attempt_count <> attempt or row_value.last_outcome_code <> 'push_5xx'
         or waited > expected[attempt] or waited < expected[attempt] - 5 then
        raise exception 'Retry % is wrong: outcome %, attempts %, waits %', attempt, outcome, row_value.attempt_count, waited;
      end if;
      update notification.web_push_subscriptions set next_attempt_at = clock_timestamp() - interval '1 second'
       where id = '97a40000-0000-4000-8000-000000000301';
    elsif outcome <> 'dropped' or row_value.attempt_count <> 0 or row_value.next_attempt_at is not null
          or row_value.delivered_through <> claimed_at or row_value.last_outcome_code <> 'attempts_exhausted'
          or row_value.status <> 'active' then
      raise exception 'The sixth failure did not drop the round: % %', outcome, row_value;
    end if;
    perform set_config('role', 'hid_identity_runtime', true);
  end loop;
  -- The round was dropped: nothing to claim until a new item arrives.
  if exists (select 1 from identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc')) then
    raise exception 'A dropped round was claimed again';
  end if;
end
$$;
reset role;
select notification.enqueue_patient_inbox_item('97a20000-0000-4000-8000-000000000003', 'WEB_PUSH_TEST', null, null, '{}');
set local role hid_identity_runtime;
do $$
declare outcome text; waited double precision;
begin
  perform identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc');
  outcome := identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000301', 'identity-api:worker-1',
    'retry', 1800, 'push_429');
  perform set_config('role', 'none', true);
  select extract(epoch from next_attempt_at - clock_timestamp()) into waited
    from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000301';
  if outcome <> 'retrying' or waited > 1800 or waited < 1795 then
    raise exception 'Retry-After 1800 was not honoured: % %', outcome, waited;
  end if;
  update notification.web_push_subscriptions set next_attempt_at = clock_timestamp() - interval '1 second'
   where id = '97a40000-0000-4000-8000-000000000301';
  perform set_config('role', 'hid_identity_runtime', true);
  perform identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc');
  outcome := identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000301', 'identity-api:worker-1',
    'retry', 86400, 'push_429');
  perform set_config('role', 'none', true);
  select extract(epoch from next_attempt_at - clock_timestamp()) into waited
    from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000301';
  if outcome <> 'retrying' or waited > 3600 or waited < 3595 then
    raise exception 'Retry-After was not capped at an hour: % %', outcome, waited;
  end if;
  update notification.web_push_subscriptions set next_attempt_at = clock_timestamp() - interval '1 second'
   where id = '97a40000-0000-4000-8000-000000000301';
  perform set_config('role', 'hid_identity_runtime', true);
  -- Rejections: dropped with an hour's wait; an acceptance resets the count.
  perform identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc');
  outcome := identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000301', 'identity-api:worker-1',
    'rejected', null, 'push_400');
  perform set_config('role', 'none', true);
  select extract(epoch from next_attempt_at - clock_timestamp()) into waited
    from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000301'
     and consecutive_rejections = 1 and attempt_count = 0 and last_outcome_code = 'push_400';
  if outcome <> 'dropped' or waited is null or waited > 3600 or waited < 3595 then
    raise exception 'A rejection did not drop the round for an hour: % %', outcome, waited;
  end if;
end
$$;
reset role;
-- Second and third rejections in a row: the third removes.
do $$
declare round integer; outcome text;
begin
  for round in 2..3 loop
    perform notification.enqueue_patient_inbox_item('97a20000-0000-4000-8000-000000000003', 'WEB_PUSH_TEST', null, null, '{}');
    update notification.web_push_subscriptions set next_attempt_at = clock_timestamp() - interval '1 second'
     where id = '97a40000-0000-4000-8000-000000000301';
    perform set_config('role', 'hid_identity_runtime', true);
    if not exists (select 1 from identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc')) then
      raise exception 'Rejection round % not claimed', round;
    end if;
    outcome := identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000301', 'identity-api:worker-1',
      'rejected', null, null);
    perform set_config('role', 'none', true);
    if (round = 2 and outcome <> 'dropped') or (round = 3 and outcome <> 'removed') then
      raise exception 'Rejection % answered %', round, outcome;
    end if;
  end loop;
  if not exists (select 1 from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000301'
                  and status = 'removed' and removal_reason = 'rejected_repeatedly' and last_outcome_code = 'rejected') then
    raise exception 'Three rejections in a row did not remove the subscription';
  end if;
end
$$;

-- An acceptance resets the rejections, and a lease expires: patient 3
-- subscribes again in sign-in 301; a rejection, then an accepted round;
-- then a lease that expires is taken over by another worker.
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'synthetic:webpush:3', true);
select created from identity.subscribe_my_web_push('synthetic:webpush:3', '97a30000-0000-4000-8000-000000000301',
  '97a40000-0000-4000-8000-000000000303', encode(sha256(convert_to('https://fcm.googleapis.com/fcm/send/webpush-3c', 'UTF8')), 'hex'),
  decode(repeat('ab', 60), 'hex'), 'local-v1', 'fcm', 'cccccccccccccccc');
select set_config('app.actor_subject', 'system:auth', true);
reset role;
select notification.enqueue_patient_inbox_item('97a20000-0000-4000-8000-000000000003', 'WEB_PUSH_TEST', null, null, '{}');
do $$
declare outcome text;
begin
  perform set_config('role', 'hid_identity_runtime', true);
  perform identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc');
  outcome := identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000303', 'identity-api:worker-1', 'rejected', null, 'push_403');
  perform set_config('role', 'none', true);
  perform notification.enqueue_patient_inbox_item('97a20000-0000-4000-8000-000000000003', 'WEB_PUSH_TEST', null, null, '{}');
  update notification.web_push_subscriptions set next_attempt_at = clock_timestamp() - interval '1 second'
   where id = '97a40000-0000-4000-8000-000000000303';
  perform set_config('role', 'hid_identity_runtime', true);
  perform identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc');
  outcome := identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000303', 'identity-api:worker-1', 'accepted', null, null);
  perform set_config('role', 'none', true);
  if outcome <> 'delivered' or not exists (select 1 from notification.web_push_subscriptions
       where id = '97a40000-0000-4000-8000-000000000303' and consecutive_rejections = 0 and delivered_count = 1) then
    raise exception 'An acceptance did not reset the rejections';
  end if;
  -- The lease expires: another worker takes the round; the first has lost it.
  perform notification.enqueue_patient_inbox_item('97a20000-0000-4000-8000-000000000003', 'WEB_PUSH_TEST', null, null, '{}');
  update notification.web_push_subscriptions set last_delivered_at = clock_timestamp() - interval '3 minutes'
   where id = '97a40000-0000-4000-8000-000000000303';
  perform set_config('role', 'hid_identity_runtime', true);
  perform identity.claim_web_push_deliveries('identity-api:worker-1', 10, 15, 'cccccccccccccccc');
  perform set_config('role', 'none', true);
  update notification.web_push_subscriptions set lease_expires_at = clock_timestamp() - interval '1 second'
   where id = '97a40000-0000-4000-8000-000000000303';
  perform set_config('role', 'hid_identity_runtime', true);
  if (select count(*) from identity.claim_web_push_deliveries('identity-api:worker-2', 10, 60, 'cccccccccccccccc')) <> 1 then
    raise exception 'An expired lease was not claimed by another worker';
  end if;
  if identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000303', 'identity-api:worker-1', 'accepted', null, null)
     <> 'lease_lost'
     or identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000303', 'identity-api:worker-2', 'accepted', null, null)
     <> 'delivered' then
    raise exception 'The expired lease''s outcomes are wrong';
  end if;
  perform set_config('role', 'none', true);
end
$$;

-- A refresh keeps the subscription (same sign-in); an ended or suspended
-- sign-in is never claimed.
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id) values
  ('97a30000-0000-4000-8000-000000000311', '97a10000-0000-4000-8000-000000000003',
   '97a30000-0000-4000-8000-000000000301', md5('webpush-refresh') || md5('webpush-refresh-2'), gen_random_uuid(), 1,
   'password', clock_timestamp(), clock_timestamp() + interval '7 days', clock_timestamp() + interval '29 days',
   'patient', '97a20000-0000-4000-8000-000000000003');
update auth.sessions set revoked_at = clock_timestamp(), revocation_reason = 'rotated',
  replaced_by_session_id = '97a30000-0000-4000-8000-000000000311'
 where id = '97a30000-0000-4000-8000-000000000301';
update notification.web_push_subscriptions set last_delivered_at = clock_timestamp() - interval '3 minutes'
 where id = '97a40000-0000-4000-8000-000000000303';
select notification.enqueue_patient_inbox_item('97a20000-0000-4000-8000-000000000003', 'WEB_PUSH_TEST', null, null, '{}');
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'synthetic:webpush:3', true);
do $$
begin
  if not (select this_sign_in from identity.list_my_web_push_subscriptions('synthetic:webpush:3',
            '97a30000-0000-4000-8000-000000000311') where subscription_id = '97a40000-0000-4000-8000-000000000303') then
    raise exception 'The refreshed session does not own the subscription';
  end if;
end
$$;
select set_config('app.actor_subject', 'system:auth', true);
do $$
begin
  if (select count(*) from identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc')) <> 1
     or identity.record_web_push_outcome('97a40000-0000-4000-8000-000000000303', 'identity-api:worker-1', 'accepted', null, null)
        <> 'delivered' then
    raise exception 'A refreshed sign-in was not pushed to';
  end if;
end
$$;
reset role;
-- Suspended (disabled_until in the future): not claimed, and not pruned.
update notification.web_push_subscriptions set last_delivered_at = clock_timestamp() - interval '3 minutes'
 where id = '97a40000-0000-4000-8000-000000000303';
select notification.enqueue_patient_inbox_item('97a20000-0000-4000-8000-000000000003', 'WEB_PUSH_TEST', null, null, '{}');
update auth.accounts set disabled_until = clock_timestamp() + interval '1 hour'
 where id = '97a10000-0000-4000-8000-000000000003';
set local role hid_identity_runtime;
do $$
begin
  if exists (select 1 from identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc')) then
    raise exception 'A suspended account was pushed to';
  end if;
  -- The prune keeps a suspended sign-in; it takes only patient 4's, whose
  -- deletion is due (account_closed).
  if identity.prune_web_push_subscriptions(500) <> 1 then
    raise exception 'The prune removed more or less than patient 4''s subscription';
  end if;
  perform set_config('role', 'none', true);
  if not exists (select 1 from notification.web_push_subscriptions
                  where id = '97a40000-0000-4000-8000-000000000303' and status = 'active') then
    raise exception 'The prune removed a suspended sign-in''s subscription';
  end if;
  perform set_config('role', 'hid_identity_runtime', true);
end
$$;
reset role;
-- Signed out (the refreshed session revoked): not claimed.
update auth.accounts set disabled_until = null where id = '97a10000-0000-4000-8000-000000000003';
update auth.sessions set revoked_at = clock_timestamp(), revocation_reason = 'logout'
 where id = '97a30000-0000-4000-8000-000000000311';
set local role hid_identity_runtime;
do $$
begin
  if exists (select 1 from identity.claim_web_push_deliveries('identity-api:worker-1', 10, 60, 'cccccccccccccccc')) then
    raise exception 'A signed-out sign-in was pushed to';
  end if;
end
$$;
reset role;

-- The prune: patient 3's signed-out sign-in (session_ended) and patient 6's
-- idle-expired sign-in (session_ended), then patient 6's locked account
-- (account_closed); patient 4's (deletion due, account_closed) went above.
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'synthetic:webpush:6', true);
select created from identity.subscribe_my_web_push('synthetic:webpush:6', '97a30000-0000-4000-8000-000000000601',
  '97a40000-0000-4000-8000-000000000601', encode(sha256(convert_to('https://fcm.googleapis.com/fcm/send/webpush-6a', 'UTF8')), 'hex'),
  decode(repeat('ab', 60), 'hex'), 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
select created from identity.subscribe_my_web_push('synthetic:webpush:6', '97a30000-0000-4000-8000-000000000602',
  '97a40000-0000-4000-8000-000000000602', encode(sha256(convert_to('https://fcm.googleapis.com/fcm/send/webpush-6b', 'UTF8')), 'hex'),
  decode(repeat('ab', 60), 'hex'), 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
reset role;
update auth.sessions set expires_at = clock_timestamp() - interval '1 second', issued_at = clock_timestamp() - interval '2 days'
 where id = '97a30000-0000-4000-8000-000000000602';
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'system:auth', true);
do $$
declare removed integer;
begin
  removed := identity.prune_web_push_subscriptions(500);
  if removed <> 2 then raise exception 'The prune removed % instead of 2', removed; end if;
end
$$;
reset role;
update auth.accounts set status = 'locked' where id = '97a10000-0000-4000-8000-000000000006';
set local role hid_identity_runtime;
do $$
begin
  if identity.prune_web_push_subscriptions(1) <> 1 or identity.prune_web_push_subscriptions(500) <> 0 then
    raise exception 'The locked account was not pruned once';
  end if;
end
$$;
reset role;
do $$
declare missing text;
begin
  select string_agg(expected.id::text || ' ' || expected.reason, ', ') into missing
    from (values ('97a40000-0000-4000-8000-000000000303'::uuid, 'session_ended'),
                 ('97a40000-0000-4000-8000-000000000401'::uuid, 'account_closed'),
                 ('97a40000-0000-4000-8000-000000000602'::uuid, 'session_ended'),
                 ('97a40000-0000-4000-8000-000000000601'::uuid, 'account_closed')) expected(id, reason)
   where not exists (select 1 from notification.web_push_subscriptions subscription
                      where subscription.id = expected.id and subscription.status = 'removed'
                        and subscription.removal_reason = expected.reason and subscription.endpoint_sha256 is null
                        and subscription.endpoint_ciphertext is null);
  if missing is not null then raise exception 'Prune reasons are wrong: %', missing; end if;
  -- Patient 1's live sign-ins were left alone.
  if (select count(*) from notification.web_push_subscriptions
       where account_id = '97a10000-0000-4000-8000-000000000001' and status = 'active') <> 9 then
    raise exception 'The prune removed a live subscription';
  end if;
end
$$;

-- Account deletion: 0096's finalizer completes patient 5's due deletion and
-- the trigger erases the subscription in that transaction.
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'synthetic:webpush:5', true);
select created from identity.subscribe_my_web_push('synthetic:webpush:5', '97a30000-0000-4000-8000-000000000501',
  '97a40000-0000-4000-8000-000000000501', encode(sha256(convert_to('https://fcm.googleapis.com/fcm/send/webpush-5', 'UTF8')), 'hex'),
  decode(repeat('ab', 60), 'hex'), 'local-v1', 'fcm', 'aaaaaaaaaaaaaaaa');
reset role;
insert into identity.patient_account_deletion_requests (id, account_id, patient_id, requested_session_id, state,
  confirmation_token_sha256, confirmation_expires_at, confirmation_consumed_at, requested_at, confirmed_at,
  waiting_period, scheduled_for, correlation_id) values
  ('97a50000-0000-4000-8000-000000000005', '97a10000-0000-4000-8000-000000000005',
   '97a20000-0000-4000-8000-000000000005', '97a30000-0000-4000-8000-000000000501', 'pending', repeat('5', 64),
   clock_timestamp() - interval '14 days' + interval '10 minutes', clock_timestamp() - interval '14 days',
   clock_timestamp() - interval '14 days', clock_timestamp() - interval '14 days', interval '14 days',
   clock_timestamp() - interval '1 minute', 'web-push-deletion-0005');
-- Patient 4's due request must not complete here (patient 4's login stays);
-- only patient 5's is finalized.
update identity.patient_account_deletion_requests set state = 'cancelled', cancelled_at = clock_timestamp()
 where id = '97a50000-0000-4000-8000-000000000004';
set local role hid_identity_runtime;
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'web-push-deletion-finalize-0001', true);
do $$
declare finalized record;
begin
  for finalized in select * from identity.finalize_due_patient_account_deletions(10) loop
    if finalized.request_id = '97a50000-0000-4000-8000-000000000005' and finalized.outcome <> 'completed' then
      raise exception 'Patient 5''s deletion did not complete: %', finalized.outcome;
    end if;
  end loop;
end
$$;
reset role;
do $$
begin
  if not exists (select 1 from auth.accounts where id = '97a10000-0000-4000-8000-000000000005' and status = 'deleted')
     or not exists (select 1 from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000501'
                     and status = 'removed' and removal_reason = 'account_deleted' and endpoint_ciphertext is null
                     and endpoint_sha256 is null)
     or not exists (select 1 from audit.events event, web_push_audit_baseline baseline
                     where event.sequence_id > baseline.last_sequence
                       and event.correlation_id = 'web-push-deletion-finalize-0001'
                       and event.action = 'identity.patient.web-push.removed' and event.actor_type = 'system'
                       and event.resource_id = '97a40000-0000-4000-8000-000000000501'
                       and event.details = '{"reason": "account_deleted"}'::jsonb) then
    raise exception 'Account deletion did not erase the subscription in its transaction';
  end if;
  -- Other account updates do not fire the trigger's work.
  update auth.accounts set display_name = 'Web Push 1 renamed' where id = '97a10000-0000-4000-8000-000000000001';
  update auth.accounts set status = 'disabled' where id = '97a10000-0000-4000-8000-000000000002';
  if not exists (select 1 from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000201'
                  and status = 'active') then
    raise exception 'A non-deleting status change erased a subscription';
  end if;
  update auth.accounts set status = 'active' where id = '97a10000-0000-4000-8000-000000000002';
end
$$;

-- The guard: no delete; a removed row is terminal; a row never changes whose it is.
do $$
begin
  begin
    delete from notification.web_push_subscriptions where id = '97a40000-0000-4000-8000-000000000201';
    raise exception 'A subscription was deleted';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'WEB_PUSH_SUBSCRIPTION_NOT_DELETABLE' then raise; end if;
  end;
  begin
    update notification.web_push_subscriptions set removal_reason = 'patient_turned_off'
     where id = '97a40000-0000-4000-8000-000000000101';
    raise exception 'A removed subscription was updated';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'WEB_PUSH_SUBSCRIPTION_REMOVED_TERMINAL' then raise; end if;
  end;
  begin
    update notification.web_push_subscriptions set account_id = '97a10000-0000-4000-8000-000000000001'
     where id = '97a40000-0000-4000-8000-000000000201';
    raise exception 'A subscription changed account';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'WEB_PUSH_SUBSCRIPTION_IMMUTABLE' then raise; end if;
  end;
  -- The CHECKs: an active row needs its ciphertext and digest.
  begin
    update notification.web_push_subscriptions set endpoint_ciphertext = null
     where id = '97a40000-0000-4000-8000-000000000201';
    raise exception 'An active row lost its ciphertext';
  exception when check_violation then null;
  end;
end
$$;

-- Audit: every command left its rows, and none holds an endpoint, a digest,
-- a key or a session id.
do $$
declare
  leaked text;
  actions text[];
begin
  select string_agg(event.action || ' ' || event.details::text, '; ') into leaked
    from audit.events event, web_push_audit_baseline baseline
   where event.sequence_id > baseline.last_sequence and event.resource_type = 'web-push-subscription'
     and (event.details::text ~ '[0-9a-f]{64}' or event.details::text ~* 'https?:'
          or event.details::text ~ '97a3' or event.details ?| array['endpoint', 'endpointSha256', 'session', 'keys']);
  if leaked is not null then raise exception 'An audit row holds an endpoint, digest or session: %', leaked; end if;
  select array_agg(distinct event.action order by event.action) into actions
    from audit.events event, web_push_audit_baseline baseline
   where event.sequence_id > baseline.last_sequence and event.resource_type = 'web-push-subscription';
  if actions is distinct from array['identity.patient.web-push.dropped', 'identity.patient.web-push.removed',
       'identity.patient.web-push.subscribed', 'identity.patient.web-push.unsubscribed'] then
    raise exception 'Audit actions are %', actions;
  end if;
  if exists (select 1 from audit.events event, web_push_audit_baseline baseline
              where event.sequence_id > baseline.last_sequence
                and event.action = 'identity.patient.web-push.subscribed'
                and (event.actor_type <> 'patient' or event.actor_subject is null
                     or event.purpose_of_use <> 'patient-self' or event.source_system <> 'identity-api'
                     or not (event.details ? 'pushService' and event.details ? 'created' and event.details ? 'rebound'))) then
    raise exception 'A subscribe audit row is malformed';
  end if;
end
$$;

rollback;
