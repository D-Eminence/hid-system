\set ON_ERROR_STOP on
begin;

-- 0093 (ADR-062): a public enrollment reaches the contact step only after a
-- proof that the person holds the NIN, recorded by
-- identity.record_public_patient_holder_proof, the only writer of the holder
-- columns. This suite checks the schema rules, the runtime's column
-- privileges, the send, failure and proof commands (budgets, supersession,
-- the existing-Health-ID answer after proof), the refusals each command makes
-- on its own (Identity filters most of them first; these are the database's
-- defence against a runtime bug), retention, activation's holder check and
-- the lock order the commands and the prune keep. Two-connection races run in
-- services/identity-api/scripts/verify-patient-enrollment-runtime.mjs.
-- Fixture ciphertext bytes, digests and an inert Argon2-shaped hash; every
-- row rolls back. Every NIN, name and contact here is invented.

-- Fixture helpers, used only by the owner of this transaction.
create function pg_temp.seed_enrollment(requested_id uuid, requested_nin char(64), requested_token char(64),
  requested_recipient char(64), requested_reference text, requested_profile text)
returns void language sql as $$
  insert into identity.public_patient_enrollments (id, nin_lookup_hmac, nin_last4, nin_ciphertext,
    profile_ciphertext, profile_sha256, key_version, provider_reference, request_hmac, token_hmac,
    holder_recipient_hmac)
  values (requested_id, requested_nin, '9301', decode(repeat('a1',32),'hex'), decode(repeat('b1',32),'hex'),
    encode(public.digest(requested_profile, 'sha256'), 'hex'), 'fixture', requested_reference,
    encode(public.digest(requested_id::text, 'sha256'), 'hex'), requested_token, requested_recipient);
$$;
create function pg_temp.seed_holder_code(requested_id uuid, requested_enrollment uuid, requested_recipient char(64),
  requested_expires timestamptz default clock_timestamp() + interval '5 minutes')
returns void language sql as $$
  insert into identity.public_patient_enrollment_otps (id, enrollment_id, recipient_hmac, channel, purpose,
    verifier_hmac, verifier_key_version, expires_at, max_attempts, delivery_outcome)
  values (requested_id, requested_enrollment, requested_recipient, 'phone', 'nin_holder', repeat('ab',32),
    'fixture', requested_expires, 5, 'accepted');
$$;
create function pg_temp.seed_events(requested_kind text, requested_nin char(64), requested_phone char(64),
  requested_count integer, requested_age interval, requested_method text default 'registry_phone_otp')
returns void language sql as $$
  insert into identity.public_patient_holder_events (kind, nin_digest, phone_digest, method, occurred_at)
  select requested_kind, requested_nin, requested_phone, requested_method, clock_timestamp() - requested_age
    from generate_series(1, requested_count);
$$;
-- What Identity does before it asks for a send: closes the enrollment's open
-- holder code and stores the new one, unsent.
create function pg_temp.open_holder_code(requested_enrollment uuid, requested_recipient char(64))
returns void language sql as $$
  update identity.public_patient_enrollment_otps set invalidated_at = clock_timestamp(), invalidation_reason = 'resend'
   where enrollment_id = requested_enrollment and purpose = 'nin_holder'
     and consumed_at is null and invalidated_at is null;
  insert into identity.public_patient_enrollment_otps (id, enrollment_id, recipient_hmac, channel, purpose,
    verifier_hmac, verifier_key_version, expires_at, max_attempts)
  values (gen_random_uuid(), requested_enrollment, requested_recipient, 'phone', 'nin_holder', repeat('ab',32),
    'fixture', clock_timestamp() + interval '5 minutes', 5);
$$;
-- Runs one statement as the current role and requires its exact refusal.
-- The refused statement's work is rolled back with its subtransaction.
create function pg_temp.expect_refusal(statement text, expected_state text, expected_message text, label text)
returns void language plpgsql as $$
declare
  state text;
  message text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics state = returned_sqlstate, message = message_text;
    if state <> expected_state or message <> expected_message then
      raise exception '%: refused with % % instead of % %', label, state, message, expected_state, expected_message;
    end if;
    return;
  end;
  raise exception '%: was not refused', label;
end $$;

-- 1. Catalog contract: the commands are security definer with a fixed search
-- path, owned with the activation command, executable by the Identity
-- runtime only, and take the NIN lock before the enrollment row lock.
do $$
declare
  command regprocedure;
  definition text;
  nin_lock integer;
  row_lock integer;
begin
  foreach command in array array[
    'identity.record_public_patient_holder_send(uuid,char,char,integer,integer,integer)'::regprocedure,
    'identity.record_public_patient_holder_failure(uuid,char,uuid,char,integer,integer)'::regprocedure,
    'identity.record_public_patient_holder_proof(uuid,char,text,uuid,uuid,char,integer)'::regprocedure,
    'identity.prune_expired_public_patient_enrollments()'::regprocedure,
    'identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char,date,text)'::regprocedure
  ] loop
    if not (select prosecdef from pg_proc where oid = command)
       or not exists (select 1 from unnest((select proconfig from pg_proc where oid = command)) setting
         where setting like 'search_path=pg_catalog, identity, %')
       or (select proowner from pg_proc where oid = command)
         <> (select proowner from pg_proc where oid = 'identity.public_patient_enrollment_ready()'::regprocedure) then
      raise exception '% must be security definer with a fixed search path and the enrollment owner', command;
    end if;
    if not has_function_privilege('hid_identity_runtime', command, 'EXECUTE')
       or not has_function_privilege('hid_identity_api_runtime', command, 'EXECUTE')
       or has_function_privilege('public', command, 'EXECUTE')
       or has_function_privilege('hid_ehr_runtime', command, 'EXECUTE')
       or has_function_privilege('hid_ehr_api_runtime', command, 'EXECUTE') then
      raise exception '% must be executable by the Identity runtime only', command;
    end if;
  end loop;
  foreach command in array array[
    'identity.record_public_patient_holder_proof(uuid,char,text,uuid,uuid,char,integer)'::regprocedure,
    'identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char,date,text)'::regprocedure
  ] loop
    definition := regexp_replace(lower(pg_get_functiondef(command)), '\s+', ' ', 'g');
    nin_lock := position('pg_advisory_xact_lock(hashtextextended(''patient-nin:'' || lookup_hmac, 0))' in definition);
    row_lock := position('where id = requested_enrollment_id for update' in definition);
    if nin_lock = 0 or row_lock = 0 or nin_lock > row_lock then
      raise exception '% must take the NIN advisory lock before the enrollment row lock', command;
    end if;
  end loop;
  -- The prune locks the expired enrollments it removes, skipping any another
  -- transaction holds, before it deletes their codes: the order of the proof
  -- (enrollment rows, then their codes), so the two never deadlock.
  definition := regexp_replace(lower(pg_get_functiondef(
    'identity.prune_expired_public_patient_enrollments()'::regprocedure)), '\s+', ' ', 'g');
  row_lock := position('for update skip locked' in definition);
  if row_lock = 0
     or row_lock > position('delete from identity.public_patient_enrollment_otps' in definition)
     or row_lock > position('delete from identity.public_patient_enrollments' in definition) then
    raise exception 'The prune must lock expired enrollments, skipping locked ones, before it deletes their codes';
  end if;
end $$;

-- 2. Schema rules, as the owner: a contact step, a password step or an
-- activation always carries a holder proof; a holder code goes to a phone.
do $$
begin
  perform pg_temp.seed_enrollment('b9300000-0000-4000-8000-0000000000f1', repeat('f1',32), repeat('f2',32),
    repeat('f3',32), 'holder-schema-001', '{}');
  if (select state from identity.public_patient_enrollments
      where id = 'b9300000-0000-4000-8000-0000000000f1') <> 'verify_holder' then
    raise exception 'A new enrollment must start at verify_holder';
  end if;
  begin
    update identity.public_patient_enrollments set state = 'verify_contact'
      where id = 'b9300000-0000-4000-8000-0000000000f1';
    raise exception 'An enrollment reached the contact step without a holder proof';
  exception when check_violation then null; end;
  begin
    update identity.public_patient_enrollments set contact_channel = 'email', contact_hmac = repeat('f4',32),
      contact_ciphertext = decode(repeat('f5',32),'hex') where id = 'b9300000-0000-4000-8000-0000000000f1';
    raise exception 'A contact was stored on an unproven enrollment';
  exception when check_violation then null; end;
  begin
    update identity.public_patient_enrollments set holder_method = 'registry_phone_otp',
      holder_verified_at = clock_timestamp() where id = 'b9300000-0000-4000-8000-0000000000f1';
    raise exception 'A registry phone proof was stored without its code';
  exception when check_violation then null; end;
  begin
    update identity.public_patient_enrollments set holder_method = 'none_before_0093'
      where id = 'b9300000-0000-4000-8000-0000000000f1';
    raise exception 'none_before_0093 was stored on an enrollment that is not active';
  exception when check_violation then null; end;
  begin
    update identity.public_patient_enrollments set holder_method = 'facility_in_person',
      holder_verified_at = clock_timestamp(), holder_challenge_id = gen_random_uuid(),
      holder_verification_id = gen_random_uuid(), state = 'verify_contact'
      where id = 'b9300000-0000-4000-8000-0000000000f1';
    raise exception 'An in-person proof was stored with a code';
  exception when check_violation then null; end;
  begin
    update identity.public_patient_enrollments set desk_code_hmac = repeat('f6',32)
      where id = 'b9300000-0000-4000-8000-0000000000f1';
    raise exception 'A desk code was stored without its expiry';
  exception when check_violation then null; end;
  begin
    insert into identity.public_patient_enrollment_otps (id, enrollment_id, recipient_hmac, channel, purpose,
      verifier_hmac, verifier_key_version, expires_at, max_attempts)
    values (gen_random_uuid(), 'b9300000-0000-4000-8000-0000000000f1', repeat('f3',32), 'email', 'nin_holder',
      repeat('ab',32), 'fixture', clock_timestamp() + interval '5 minutes', 5);
    raise exception 'A holder code was addressed to an email';
  exception when check_violation then null; end;
  begin
    insert into identity.public_patient_holder_events (kind, nin_digest, method)
      values ('send', repeat('f7',32), 'registry_phone_otp');
    raise exception 'A send event was recorded without its phone digest';
  exception when check_violation then null; end;
  -- The NIN is no longer unique: a second start inserts its own row.
  perform pg_temp.seed_enrollment('b9300000-0000-4000-8000-0000000000f2', repeat('f1',32), repeat('f8',32),
    repeat('f3',32), 'holder-schema-002', '{}');
  if to_regclass('identity.public_patient_enrollments_proven_nin_uq') is null
     or exists (select 1 from pg_constraint where conname = 'public_patient_enrollments_nin_lookup_hmac_key') then
    raise exception 'The NIN must be unique only among proven enrollments';
  end if;
  if (select column_default from information_schema.columns where table_schema = 'identity'
      and table_name = 'public_patient_enrollment_otps' and column_name = 'purpose') <> '''contact''::text' then
    raise exception 'An enrollment code must be a contact code unless it says otherwise';
  end if;
end $$;

-- 3. The runtime writes no holder column and no holder event directly.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select set_config('app.correlation_id','public-patient-holder-0001',true);
do $$
declare
  forbidden text;
begin
  foreach forbidden in array array[
    'update identity.public_patient_enrollments set holder_method = ''registry_phone_otp'' where false',
    'update identity.public_patient_enrollments set holder_verified_at = clock_timestamp() where false',
    'update identity.public_patient_enrollments set holder_challenge_id = gen_random_uuid() where false',
    'update identity.public_patient_enrollments set holder_verification_id = gen_random_uuid() where false',
    'update identity.public_patient_enrollments set nin_lookup_hmac = repeat(''00'',32) where false',
    'update identity.public_patient_enrollments set token_hmac = repeat(''00'',32) where false',
    'insert into identity.public_patient_enrollments (id, nin_lookup_hmac, nin_last4, nin_ciphertext, profile_ciphertext, profile_sha256, key_version, provider_reference, request_hmac, token_hmac, state) values (gen_random_uuid(), repeat(''00'',32), ''0000'', decode(repeat(''a1'',32),''hex''), decode(repeat(''b1'',32),''hex''), repeat(''00'',32), ''fixture'', ''x'', repeat(''00'',32), repeat(''00'',32), ''set_password'')',
    'insert into identity.public_patient_enrollments (id, nin_lookup_hmac, nin_last4, nin_ciphertext, profile_ciphertext, profile_sha256, key_version, provider_reference, request_hmac, token_hmac, holder_method) values (gen_random_uuid(), repeat(''00'',32), ''0000'', decode(repeat(''a1'',32),''hex''), decode(repeat(''b1'',32),''hex''), repeat(''00'',32), ''fixture'', ''x'', repeat(''00'',32), repeat(''00'',32), ''registry_phone_otp'')',
    'select count(*) from identity.public_patient_holder_events',
    'insert into identity.public_patient_holder_events (kind, nin_digest, phone_digest, method) values (''proof'', repeat(''00'',32), repeat(''00'',32), ''registry_phone_otp'')',
    'delete from identity.public_patient_holder_events where false'
  ] loop
    begin
      execute forbidden;
      raise exception 'The Identity runtime ran: %', forbidden;
    exception when insufficient_privilege then null; end;
  end loop;
  -- The start columns, the contact columns and the holder recipient remain writable.
  update identity.public_patient_enrollments set holder_recipient_hmac = repeat('f3',32), updated_at = clock_timestamp()
    where id = 'b9300000-0000-4000-8000-0000000000f2';
  if not found then raise exception 'The Identity runtime could not store the holder recipient'; end if;
end $$;
reset role;

-- 4. Proof, supersession and the answer for a NIN that has a Health ID.
-- NIN A (repeat('a1')): A1 and A2 unproven, then A3 later.
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-000000000001', repeat('a1',32), repeat('01',32),
  repeat('c1',32), 'holder-a-001', '{"nin":"12345679301"}');
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-000000000002', repeat('a1',32), repeat('02',32),
  repeat('c1',32), 'holder-a-002', '{"nin":"12345679301"}');
select pg_temp.seed_holder_code('b9310000-0000-4000-8000-000000000001', 'b9300000-0000-4000-8000-000000000001',
  repeat('c1',32));
select pg_temp.seed_holder_code('b9310000-0000-4000-8000-000000000002', 'b9300000-0000-4000-8000-000000000002',
  repeat('c1',32));
-- An open contact-purpose phone code (on F1) and an expired holder code (on F2).
insert into identity.public_patient_enrollment_otps (id, enrollment_id, recipient_hmac, channel, purpose,
  verifier_hmac, verifier_key_version, expires_at, max_attempts, delivery_outcome, invalidated_at, invalidation_reason)
values ('b9310000-0000-4000-8000-0000000000c1', 'b9300000-0000-4000-8000-0000000000f1', repeat('f3',32), 'phone',
  'contact', repeat('ab',32), 'fixture', clock_timestamp() + interval '5 minutes', 5, 'accepted', null, null);
select pg_temp.seed_holder_code('b9310000-0000-4000-8000-0000000000e1', 'b9300000-0000-4000-8000-0000000000f2',
  repeat('f3',32), clock_timestamp() - interval '1 second');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
declare
  outcome text;
begin
  -- Refusals change nothing: a wrong token, an unsupported method, a code of
  -- another purpose or enrollment, an invalidated code.
  begin
    perform identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-000000000001', repeat('09',32),
      'registry_phone_otp', 'b9310000-0000-4000-8000-000000000001', null, repeat('d1',32), 5);
    raise exception 'A wrong enrollment token recorded a holder proof';
  exception when insufficient_privilege then null; end;
  -- 0094 (ADR-063): an in-person proof needs a matched check of this
  -- enrollment (facility-assisted-registration.integration.sql).
  begin
    perform identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-000000000001', repeat('01',32),
      'facility_in_person', null, gen_random_uuid(), repeat('d1',32), 5);
    raise exception 'An in-person proof was recorded without a recorded check';
  exception when check_violation then
    if sqlerrm <> 'PATIENT_HOLDER_PROOF_INVALID' then raise; end if;
  end;
  begin
    perform identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-000000000001', repeat('01',32),
      'facility_in_person', gen_random_uuid(), gen_random_uuid(), repeat('d1',32), 5);
    raise exception 'An in-person proof that names a code was recorded';
  exception when invalid_parameter_value then null; end;
  begin
    perform identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-000000000001', repeat('01',32),
      'registry_phone_otp', 'b9310000-0000-4000-8000-000000000002', null, repeat('d1',32), 5);
    raise exception 'Another enrollment''s code proved this enrollment';
  exception when check_violation then null; end;
  begin
    perform identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-0000000000f1', repeat('f2',32),
      'registry_phone_otp', 'b9310000-0000-4000-8000-0000000000c1', null, repeat('df',32), 5);
    raise exception 'A contact code proved the holder';
  exception when check_violation then null; end;
  begin
    perform identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-0000000000f2', repeat('f8',32),
      'registry_phone_otp', 'b9310000-0000-4000-8000-0000000000e1', null, repeat('df',32), 5);
    raise exception 'An expired holder code proved the holder';
  exception when check_violation then null; end;
  begin
    perform identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-000000000001', repeat('01',32),
      'registry_phone_otp', 'b9310000-0000-4000-8000-000000000001', null, 'not-a-digest', 5);
    raise exception 'A malformed NIN digest was accepted';
  exception when insufficient_privilege then null; end;

  -- A1 proves: A2 (unproven, same NIN) is superseded with its codes.
  outcome := identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-000000000001', repeat('01',32),
    'registry_phone_otp', 'b9310000-0000-4000-8000-000000000001', null, repeat('d1',32), 5);
  if outcome <> 'verified' then raise exception 'A valid holder code answered %', outcome; end if;
  -- The same code cannot prove twice.
  begin
    perform identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-000000000001', repeat('01',32),
      'registry_phone_otp', 'b9310000-0000-4000-8000-000000000001', null, repeat('d1',32), 5);
    raise exception 'A holder code proved twice';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$
declare
  proven record;
begin
  select * into proven from identity.public_patient_enrollments where id = 'b9300000-0000-4000-8000-000000000001';
  if proven.state <> 'verify_contact' or proven.holder_method <> 'registry_phone_otp'
     or proven.holder_challenge_id <> 'b9310000-0000-4000-8000-000000000001'
     or proven.holder_verified_at is null or proven.holder_verification_id is not null then
    raise exception 'A holder proof did not record its method, code and time';
  end if;
  if not exists (select 1 from identity.public_patient_enrollment_otps
      where id = 'b9310000-0000-4000-8000-000000000001' and purpose = 'nin_holder'
        and verified_at = proven.holder_verified_at and consumed_at is not null and invalidated_at is null) then
    raise exception 'A holder proof did not consume its code';
  end if;
  if exists (select 1 from identity.public_patient_enrollments where id = 'b9300000-0000-4000-8000-000000000002')
     or exists (select 1 from identity.public_patient_enrollment_otps
       where enrollment_id = 'b9300000-0000-4000-8000-000000000002') then
    raise exception 'A holder proof left another unproven enrollment of the NIN';
  end if;
  if (select count(*) from audit.events where action = 'identity.public-patient-enrollment.superseded'
      and details = jsonb_build_object('count', 1, 'methods', '["unproven"]'::jsonb, 'ninDigest', repeat('d1',32))) <> 1
     or (select count(*) from audit.events where action = 'identity.public-patient-enrollment.holder-verified'
      and resource_id = 'b9300000-0000-4000-8000-000000000001'
      and details = jsonb_build_object('method', 'registry_phone_otp', 'ninDigest', repeat('d1',32))) <> 1 then
    raise exception 'A holder proof or its supersession was not audited';
  end if;
  -- The append-only audit log never keeps the registry phone's digest: it
  -- would link the NINs one phone proved beyond the holder events' 366 days.
  if exists (select 1 from audit.events where action like 'identity.public-patient-enrollment.%'
      and details ? 'phoneDigest') then
    raise exception 'A holder audit event recorded the registry phone digest';
  end if;
  if (select count(*) from identity.public_patient_holder_events where kind = 'proof'
      and nin_digest = repeat('d1',32) and phone_digest = repeat('c1',32) and method = 'registry_phone_otp') <> 1 then
    raise exception 'A holder proof was not counted';
  end if;
  -- One proven enrollment per NIN.
  begin
    update identity.public_patient_enrollments set state = 'verify_contact', holder_method = 'registry_phone_otp',
      holder_verified_at = clock_timestamp(), holder_challenge_id = gen_random_uuid()
      where id = 'b9300000-0000-4000-8000-0000000000f2';
    update identity.public_patient_enrollments set nin_lookup_hmac = repeat('a1',32)
      where id = 'b9300000-0000-4000-8000-0000000000f2';
    raise exception 'Two proven enrollments held one NIN';
  exception when unique_violation then null; end;
end $$;

-- A later proof of the same NIN by the registry phone replaces the earlier
-- one (a registry-phone proof is displaced by any proof).
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-000000000003', repeat('a1',32), repeat('03',32),
  repeat('c1',32), 'holder-a-003', '{"nin":"12345679301"}');
select pg_temp.seed_holder_code('b9310000-0000-4000-8000-000000000003', 'b9300000-0000-4000-8000-000000000003',
  repeat('c1',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-000000000003', repeat('03',32),
      'registry_phone_otp', 'b9310000-0000-4000-8000-000000000003', null, repeat('d1',32), 5) <> 'verified' then
    raise exception 'A second registry-phone proof of the NIN was refused';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from identity.public_patient_enrollments where id = 'b9300000-0000-4000-8000-000000000001')
     or (select state from identity.public_patient_enrollments
       where id = 'b9300000-0000-4000-8000-000000000003') <> 'verify_contact'
     or (select count(*) from audit.events where action = 'identity.public-patient-enrollment.superseded'
       and details = jsonb_build_object('count', 1, 'methods', '["registry_phone_otp"]'::jsonb,
         'ninDigest', repeat('d1',32))) <> 1 then
    raise exception 'A later registry-phone proof did not replace the earlier one';
  end if;
end $$;

-- An unexpired in-person proof is displaced only by another in-person proof:
-- a registry-phone proof answers facility_conflict and changes nothing. Once
-- it has expired, the phone proof removes it, audited as contested.
insert into identity.public_patient_enrollments (id, nin_lookup_hmac, nin_last4, nin_ciphertext, profile_ciphertext,
  profile_sha256, key_version, provider_reference, request_hmac, token_hmac, state, holder_method,
  holder_verified_at, holder_verification_id)
values ('b9300000-0000-4000-8000-0000000000b1', repeat('b1',32), '9302', decode(repeat('a1',32),'hex'),
  decode(repeat('b1',32),'hex'), repeat('0b',32), 'fixture', 'holder-b-facility', repeat('1b',32), repeat('2b',32),
  'verify_contact', 'facility_in_person', clock_timestamp(), gen_random_uuid());
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-0000000000b2', repeat('b1',32), repeat('3b',32),
  repeat('c2',32), 'holder-b-phone', '{"nin":"12345679302"}');
select pg_temp.seed_holder_code('b9310000-0000-4000-8000-0000000000b2', 'b9300000-0000-4000-8000-0000000000b2',
  repeat('c2',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-0000000000b2', repeat('3b',32),
      'registry_phone_otp', 'b9310000-0000-4000-8000-0000000000b2', null, repeat('d2',32), 5)
      <> 'facility_conflict' then
    raise exception 'A registry-phone proof displaced an unexpired in-person proof';
  end if;
end $$;
reset role;
do $$
begin
  if (select state from identity.public_patient_enrollments where id = 'b9300000-0000-4000-8000-0000000000b2')
       <> 'verify_holder'
     or not exists (select 1 from identity.public_patient_enrollments where id = 'b9300000-0000-4000-8000-0000000000b1')
     or (select consumed_at from identity.public_patient_enrollment_otps
       where id = 'b9310000-0000-4000-8000-0000000000b2') is not null then
    raise exception 'A facility conflict changed an enrollment or spent the code';
  end if;
  update identity.public_patient_enrollments set expires_at = clock_timestamp() - interval '1 second'
    where id = 'b9300000-0000-4000-8000-0000000000b1';
end $$;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-0000000000b2', repeat('3b',32),
      'registry_phone_otp', 'b9310000-0000-4000-8000-0000000000b2', null, repeat('d2',32), 5) <> 'verified' then
    raise exception 'An expired in-person proof still blocked a registry-phone proof';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from identity.public_patient_enrollments where id = 'b9300000-0000-4000-8000-0000000000b1')
     or (select count(*) from audit.events where action = 'identity.public-patient-enrollment.contested'
       and details = jsonb_build_object('count', 1, 'methods', '["facility_in_person"]'::jsonb,
         'ninDigest', repeat('d2',32))) <> 1 then
    raise exception 'A proof that displaced an in-person proof was not audited as contested';
  end if;
end $$;

-- A NIN that already has a Health ID is answered only after a valid proof:
-- the enrollment and its codes are deleted and the event audited with the
-- method of the existing binding.
insert into identity.public_patient_enrollments (id, nin_lookup_hmac, nin_last4, nin_ciphertext, profile_ciphertext,
  profile_sha256, key_version, provider_reference, request_hmac, token_hmac, state, contact_channel, contact_hmac,
  contact_lookup_hmac, contact_ciphertext, contact_verified_at, verified_challenge_id, patient_id, account_id,
  activated_at, holder_method)
values ('b9300000-0000-4000-8000-0000000000e0', repeat('e1',32), '9303', decode(repeat('a1',32),'hex'),
  decode(repeat('b1',32),'hex'), repeat('0e',32), 'fixture', 'holder-e-bound', repeat('1e',32), repeat('2e',32),
  'active', 'email', repeat('3e',32), repeat('4e',32), decode(repeat('5e',32),'hex'), clock_timestamp(),
  gen_random_uuid(), 'b9330000-0000-4000-8000-0000000000e0', 'b9340000-0000-4000-8000-0000000000e0',
  clock_timestamp(), 'none_before_0093');
insert into auth.accounts (id, subject, display_name, status, source_system)
values ('b9340000-0000-4000-8000-0000000000e0', 'patient:b9340000-0000-4000-8000-0000000000e0',
  'Existing Sample', 'active', 'hid-public-qoreid-enrollment');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status)
values ('b9330000-0000-4000-8000-0000000000e0', 'b9340000-0000-4000-8000-0000000000e0', 'HID-ABCDEFHE',
  'Existing', 'Sample', 'Existing Sample', 'active');
insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
  encryption_key_version, verified, verified_at, verification_provider, verification_reference, public_enrollment_id)
values (gen_random_uuid(), 'b9330000-0000-4000-8000-0000000000e0', 'nin', decode(repeat('e4',32),'hex'),
  repeat('e1',32), 'fixture', true, clock_timestamp(), 'qoreid', 'holder-e-bound',
  'b9300000-0000-4000-8000-0000000000e0');
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-0000000000e1', repeat('e1',32), repeat('6e',32),
  repeat('c3',32), 'holder-e-again', '{"nin":"12345679303"}');
select pg_temp.seed_holder_code('b9310000-0000-4000-8000-0000000000e2', 'b9300000-0000-4000-8000-0000000000e1',
  repeat('c3',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  -- Without a valid code the bound NIN is not revealed: the proof is refused.
  begin
    perform identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-0000000000e1', repeat('6e',32),
      'registry_phone_otp', gen_random_uuid(), null, repeat('d3',32), 5);
    raise exception 'A proof without its code reached the existing Health ID check';
  exception when check_violation then null; end;
  if identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-0000000000e1', repeat('6e',32),
      'registry_phone_otp', 'b9310000-0000-4000-8000-0000000000e2', null, repeat('d3',32), 5)
      <> 'existing_identity' then
    raise exception 'A proof of a NIN that has a Health ID was not answered existing_identity';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from identity.public_patient_enrollments where id = 'b9300000-0000-4000-8000-0000000000e1')
     or exists (select 1 from identity.public_patient_enrollment_otps
       where enrollment_id = 'b9300000-0000-4000-8000-0000000000e1')
     or (select state from identity.public_patient_enrollments
       where id = 'b9300000-0000-4000-8000-0000000000e0') <> 'active' then
    raise exception 'An existing-identity answer kept the new enrollment or changed the bound one';
  end if;
  if (select count(*) from audit.events where action = 'identity.public-patient-enrollment.existing-identity'
      and resource_id = 'b9300000-0000-4000-8000-0000000000e1' and outcome = 'denied'
      and patient_id is null and facility_id is null
      and details = jsonb_build_object('method', 'registry_phone_otp', 'ninDigest', repeat('d3',32),
        'existingBinding', 'none_before_0093')) <> 1 then
    raise exception 'An existing-identity answer was not audited with its binding';
  end if;
  if exists (select 1 from identity.public_patient_holder_events where nin_digest = repeat('d3',32)) then
    raise exception 'An existing-identity answer was counted as a proof';
  end if;
end $$;

-- 5. Budgets. Sends per registry phone in 24 hours; failures per NIN in 24
-- hours and in 30 days, checked at send; distinct NINs proved per phone in
-- 365 days, checked at proof. Each holds well past the 48-hour rate table.
-- Identity stores the enrollment's one open code before it asks for a send,
-- so a send counts that code's attempts with every other open code of the
-- NIN: a NIN never has more wrong codes left to try than its budgets allow.
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-000000000051', repeat('51',32), repeat('05',32),
  repeat('c5',32), 'holder-budget-001', '{"nin":"12345679305"}');
-- Four sends in the last day and twenty older ones: under a daily limit of 5.
select pg_temp.seed_events('send', repeat('d5',32), repeat('c5',32), 4, interval '23 hours');
select pg_temp.seed_events('send', repeat('d6',32), repeat('c5',32), 20, interval '25 hours');
select pg_temp.open_holder_code('b9300000-0000-4000-8000-000000000051', repeat('c5',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if not identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000051', repeat('05',32),
      repeat('d5',32), 5, 10, 30) then
    raise exception 'A fifth send in 24 hours was refused';
  end if;
end $$;
reset role;
select pg_temp.open_holder_code('b9300000-0000-4000-8000-000000000051', repeat('c5',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000051', repeat('05',32),
      repeat('d5',32), 5, 10, 30) then
    raise exception 'A sixth send in 24 hours to one registry phone was allowed';
  end if;
  begin
    perform identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000051', repeat('09',32),
      repeat('d5',32), 5, 10, 30);
    raise exception 'A wrong token recorded a send';
  exception when insufficient_privilege then null; end;
  begin
    perform identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000051', repeat('05',32),
      repeat('d5',32), 5, 31, 30);
    raise exception 'A monthly failure limit below the daily one was accepted';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;
do $$
begin
  if (select count(*) from identity.public_patient_holder_events where kind = 'send' and phone_digest = repeat('c5',32)
      and occurred_at > clock_timestamp() - interval '24 hours') <> 5 then
    raise exception 'A refused send was recorded';
  end if;
end $$;

-- Failures: ten in the last day close the route for the day; thirty in 30
-- days, all older than 48 hours, still close it.
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-000000000052', repeat('52',32), repeat('06',32),
  repeat('c6',32), 'holder-budget-002', '{"nin":"12345679306"}');
select pg_temp.open_holder_code('b9300000-0000-4000-8000-000000000052', repeat('c6',32));
select pg_temp.seed_events('failure', repeat('d7',32), repeat('c6',32), 10, interval '1 hour');
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-000000000053', repeat('53',32), repeat('07',32),
  repeat('c7',32), 'holder-budget-003', '{"nin":"12345679307"}');
select pg_temp.open_holder_code('b9300000-0000-4000-8000-000000000053', repeat('c7',32));
select pg_temp.seed_events('failure', repeat('d8',32), repeat('c7',32), 20, interval '49 hours');
select pg_temp.seed_events('failure', repeat('d8',32), repeat('c7',32), 10, interval '29 days');
select pg_temp.seed_events('failure', repeat('d8',32), repeat('c7',32), 40, interval '31 days');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000052', repeat('06',32),
      repeat('d7',32), 5, 10, 30) then
    raise exception 'A NIN with ten failures in 24 hours got another code';
  end if;
  if identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000053', repeat('07',32),
      repeat('d8',32), 5, 10, 30) then
    raise exception 'A NIN with thirty failures in 30 days, all older than 48 hours, got another code';
  end if;
  -- Ten failures 29 days old are within the monthly window but not the daily
  -- one: with the new code's five attempts, 35 fit a monthly limit of 35.
  if not identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000053', repeat('07',32),
      repeat('d8',32), 5, 10, 35) then
    raise exception 'Failures older than 24 hours counted against the daily budget';
  end if;
end $$;
reset role;

-- The attempts left on the NIN's open codes count before a new code is sent:
-- two enrollments of one NIN with an open code each use the daily budget of
-- ten, so a third enrollment gets no code until those expire or are spent.
select pg_temp.seed_enrollment(('b9300000-0000-4000-8000-00000000005' || n)::uuid, repeat('56',32),
  repeat('5' || n, 32), repeat('cb',32), 'holder-open-00' || n, '{"nin":"12345679310"}')
  from unnest(array['6', '7', '8']) n;
select pg_temp.open_holder_code('b9300000-0000-4000-8000-000000000056', repeat('cb',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if not identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000056', repeat('56',32),
      repeat('db',32), 5, 10, 30) then
    raise exception 'The first open code of a NIN was refused';
  end if;
end $$;
reset role;
select pg_temp.open_holder_code('b9300000-0000-4000-8000-000000000057', repeat('cb',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if not identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000057', repeat('57',32),
      repeat('db',32), 5, 10, 30) then
    raise exception 'A second open code of a NIN, within ten attempts, was refused';
  end if;
end $$;
reset role;
select pg_temp.open_holder_code('b9300000-0000-4000-8000-000000000058', repeat('cb',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000058', repeat('58',32),
      repeat('db',32), 5, 10, 30) then
    raise exception 'A third open code put fifteen attempts in reach of a daily budget of ten';
  end if;
end $$;
reset role;
-- Wrong codes already made count with the new code's attempts: five
-- failures today and a new code fit ten; a sixth failure does not.
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-000000000059', repeat('59',32), repeat('5a',32),
  repeat('cc',32), 'holder-open-004', '{"nin":"12345679311"}');
select pg_temp.seed_events('failure', repeat('dc',32), repeat('cc',32), 5, interval '1 hour');
select pg_temp.open_holder_code('b9300000-0000-4000-8000-000000000059', repeat('cc',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if not identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000059', repeat('5a',32),
      repeat('dc',32), 5, 10, 30) then
    raise exception 'Five failures and a new five-attempt code were refused under a daily budget of ten';
  end if;
end $$;
reset role;
select pg_temp.seed_events('failure', repeat('dc',32), repeat('cc',32), 1, interval '1 hour');
select pg_temp.open_holder_code('b9300000-0000-4000-8000-000000000059', repeat('cc',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000059', repeat('5a',32),
      repeat('dc',32), 5, 10, 30) then
    raise exception 'Six failures and a new five-attempt code passed a daily budget of ten';
  end if;
end $$;
reset role;
-- The same over 30 days: 25 failures and a new code fit thirty; 26 do not.
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-00000000005a', repeat('5b',32), repeat('5c',32),
  repeat('cd',32), 'holder-open-005', '{"nin":"12345679312"}');
select pg_temp.seed_events('failure', repeat('dd',32), repeat('cd',32), 25, interval '3 days');
select pg_temp.open_holder_code('b9300000-0000-4000-8000-00000000005a', repeat('cd',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if not identity.record_public_patient_holder_send('b9300000-0000-4000-8000-00000000005a', repeat('5c',32),
      repeat('dd',32), 5, 10, 30) then
    raise exception 'Twenty-five failures this month and a new code were refused under a monthly budget of thirty';
  end if;
end $$;
reset role;
select pg_temp.seed_events('failure', repeat('dd',32), repeat('cd',32), 1, interval '3 days');
select pg_temp.open_holder_code('b9300000-0000-4000-8000-00000000005a', repeat('cd',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if identity.record_public_patient_holder_send('b9300000-0000-4000-8000-00000000005a', repeat('5c',32),
      repeat('dd',32), 5, 10, 30) then
    raise exception 'Twenty-six failures this month and a new code passed a monthly budget of thirty';
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from identity.public_patient_holder_events where kind = 'send'
      and nin_digest in (repeat('db',32), repeat('dc',32), repeat('dd',32))) <> 4 then
    raise exception 'A send refused for the attempts in reach was recorded';
  end if;
end $$;
-- A send needs the enrollment's open code (0051 allows one per enrollment),
-- unused and addressed to the registry phone: none, or one to another phone,
-- is a caller error.
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-00000000005b', repeat('5d',32), repeat('5e',32),
  repeat('ce',32), 'holder-open-006', '{"nin":"12345679313"}');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select pg_temp.expect_refusal($sql$select identity.record_public_patient_holder_send(
  'b9300000-0000-4000-8000-00000000005b', repeat('5e',32), repeat('de',32), 5, 10, 30)$sql$,
  '55000', 'PATIENT_HOLDER_CODE_REQUIRED', 'A send without a stored code');
reset role;
select pg_temp.open_holder_code('b9300000-0000-4000-8000-00000000005b', repeat('cf',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select pg_temp.expect_refusal($sql$select identity.record_public_patient_holder_send(
  'b9300000-0000-4000-8000-00000000005b', repeat('5e',32), repeat('de',32), 5, 10, 30)$sql$,
  '55000', 'PATIENT_HOLDER_CODE_REQUIRED', 'A send whose open code goes to another phone');
reset role;

-- The failure command records each wrong code and audits the closing of the
-- route once, when a budget is reached.
update identity.public_patient_enrollment_otps set invalidated_at = clock_timestamp(), invalidation_reason = 'resend'
  where enrollment_id = 'b9300000-0000-4000-8000-000000000051' and consumed_at is null and invalidated_at is null;
select pg_temp.seed_holder_code('b9310000-0000-4000-8000-000000000054', 'b9300000-0000-4000-8000-000000000051',
  repeat('c5',32));
select pg_temp.seed_events('failure', repeat('d9',32), repeat('c5',32), 8, interval '2 hours');
select pg_temp.seed_events('failure', repeat('d9',32), repeat('c5',32), 20, interval '5 days');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  perform identity.record_public_patient_holder_failure('b9300000-0000-4000-8000-000000000051', repeat('05',32),
    'b9310000-0000-4000-8000-000000000054', repeat('d9',32), 10, 30);
  perform identity.record_public_patient_holder_failure('b9300000-0000-4000-8000-000000000051', repeat('05',32),
    'b9310000-0000-4000-8000-000000000054', repeat('d9',32), 10, 30);
  perform identity.record_public_patient_holder_failure('b9300000-0000-4000-8000-000000000051', repeat('05',32),
    'b9310000-0000-4000-8000-000000000054', repeat('d9',32), 10, 30);
  begin
    perform identity.record_public_patient_holder_failure('b9300000-0000-4000-8000-000000000051', repeat('09',32),
      'b9310000-0000-4000-8000-000000000054', repeat('d9',32), 10, 30);
    raise exception 'A wrong token recorded a failure';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$
begin
  if (select count(*) from identity.public_patient_holder_events where kind = 'failure'
      and nin_digest = repeat('d9',32)) <> 31 then
    raise exception 'The failure command did not record each wrong code';
  end if;
  if (select array_agg(details->>'window' order by sequence_id) from audit.events
      where action = 'identity.public-patient-enrollment.holder-route-closed'
        and details->>'ninDigest' = repeat('d9',32)) is distinct from array['day', 'month'] then
    raise exception 'Reaching the daily and monthly failure budgets was not audited once each';
  end if;
end $$;


-- Distinct NINs per registry phone: five other NINs proved within 365 days
-- close the online route for that phone; a proof older than a year does not
-- count. The refusal changes nothing.
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-000000000055', repeat('55',32), repeat('08',32),
  repeat('c8',32), 'holder-budget-005', '{"nin":"12345679308"}');
select pg_temp.seed_holder_code('b9310000-0000-4000-8000-000000000055', 'b9300000-0000-4000-8000-000000000055',
  repeat('c8',32));
insert into identity.public_patient_holder_events (kind, nin_digest, phone_digest, method, occurred_at)
select 'proof', lpad(to_hex(n), 64, '0'), repeat('c8',32), 'registry_phone_otp',
  clock_timestamp() - (n * interval '60 days')
  from generate_series(1, 5) n;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-000000000055', repeat('08',32),
      'registry_phone_otp', 'b9310000-0000-4000-8000-000000000055', null, repeat('da',32), 5) <> 'route_limited' then
    raise exception 'A registry phone that proved five other NINs this year proved another';
  end if;
end $$;
reset role;
do $$
begin
  if (select state from identity.public_patient_enrollments where id = 'b9300000-0000-4000-8000-000000000055')
       <> 'verify_holder'
     or (select consumed_at from identity.public_patient_enrollment_otps
       where id = 'b9310000-0000-4000-8000-000000000055') is not null then
    raise exception 'A refused proof changed the enrollment or spent its code';
  end if;
  update identity.public_patient_holder_events set occurred_at = clock_timestamp() - interval '366 days'
    where kind = 'proof' and phone_digest = repeat('c8',32) and nin_digest = lpad(to_hex(5), 64, '0');
end $$;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-000000000055', repeat('08',32),
      'registry_phone_otp', 'b9310000-0000-4000-8000-000000000055', null, repeat('da',32), 5) <> 'verified' then
    raise exception 'A proof older than a year still counted against the registry phone';
  end if;
end $$;
reset role;

-- 5b. What each command refuses on its own. Identity checks most of these
-- before it calls a command; the database refuses them again, so a runtime
-- bug cannot pass a spent, exhausted or misaddressed code, an expired or
-- proven enrollment, or another actor. Each refusal has its exact SQLSTATE
-- and message and changes nothing.
-- One NIN: enrollments A1 to A5 each hold a code in one refused state (0051
-- allows one open code per enrollment); R1 holds a valid code (r6).
select pg_temp.seed_enrollment(('b9300000-0000-4000-8000-0000000000a' || n)::uuid, repeat('a9',32),
  repeat('a8',32), repeat('a7',32), 'holder-refuse-a0' || n, '{"nin":"12345679314"}')
  from generate_series(1, 5) n;
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-000000000091', repeat('a9',32), repeat('a8',32),
  repeat('a7',32), 'holder-refuse-001', '{"nin":"12345679314"}');
insert into identity.public_patient_enrollment_otps (id, enrollment_id, recipient_hmac, channel, purpose,
  verifier_hmac, verifier_key_version, expires_at, max_attempts, failed_attempts, delivery_outcome,
  verified_at, invalidated_at, invalidation_reason)
values
  ('b9350000-0000-4000-8000-000000000001', 'b9300000-0000-4000-8000-0000000000a1', repeat('a7',32), 'phone',
   'nin_holder', repeat('ab',32), 'fixture', clock_timestamp() + interval '5 minutes', 5, 0, 'accepted',
   null, clock_timestamp(), 'resend'),
  ('b9350000-0000-4000-8000-000000000002', 'b9300000-0000-4000-8000-0000000000a2', repeat('a7',32), 'phone',
   'nin_holder', repeat('ab',32), 'fixture', clock_timestamp() + interval '5 minutes', 5, 5, 'accepted',
   null, null, null),
  ('b9350000-0000-4000-8000-000000000003', 'b9300000-0000-4000-8000-0000000000a3', repeat('a7',32), 'phone',
   'nin_holder', repeat('ab',32), 'fixture', clock_timestamp() + interval '5 minutes', 5, 0, 'definitive_failure',
   null, null, null),
  ('b9350000-0000-4000-8000-000000000004', 'b9300000-0000-4000-8000-0000000000a4', repeat('a7',32), 'phone',
   'nin_holder', repeat('ab',32), 'fixture', clock_timestamp() + interval '5 minutes', 5, 0, 'accepted',
   clock_timestamp(), null, null),
  ('b9350000-0000-4000-8000-000000000005', 'b9300000-0000-4000-8000-0000000000a5', repeat('a5',32), 'phone',
   'nin_holder', repeat('ab',32), 'fixture', clock_timestamp() + interval '5 minutes', 5, 0, 'accepted',
   null, null, null),
  ('b9350000-0000-4000-8000-000000000006', 'b9300000-0000-4000-8000-000000000091', repeat('a7',32), 'phone',
   'nin_holder', repeat('ab',32), 'fixture', clock_timestamp() + interval '5 minutes', 5, 0, 'accepted',
   null, null, null);
-- R2 has expired with a valid open code; R3 has no holder recipient yet.
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-000000000092', repeat('b9',32), repeat('b8',32),
  repeat('b7',32), 'holder-refuse-002', '{"nin":"12345679315"}');
select pg_temp.seed_holder_code('b9350000-0000-4000-8000-000000000007', 'b9300000-0000-4000-8000-000000000092',
  repeat('b7',32));
update identity.public_patient_enrollments set expires_at = clock_timestamp() - interval '1 second'
  where id = 'b9300000-0000-4000-8000-000000000092';
select pg_temp.seed_enrollment('b9300000-0000-4000-8000-000000000093', repeat('c9',32), repeat('c8',32),
  null, 'holder-refuse-003', '{"nin":"12345679316"}');
select pg_temp.seed_holder_code('b9350000-0000-4000-8000-000000000008', 'b9300000-0000-4000-8000-000000000093',
  repeat('ca',32));
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select pg_temp.expect_refusal(format($sql$select identity.record_public_patient_holder_proof(
    %L, repeat('a8',32), 'registry_phone_otp', %L, null, repeat('a6',32), 5)$sql$,
    'b9300000-0000-4000-8000-0000000000a' || refused.n, 'b9350000-0000-4000-8000-00000000000' || refused.n),
    '23514', 'PATIENT_HOLDER_PROOF_INVALID', 'A proof with ' || refused.label)
  from (values (1, 'a code closed by a resend'), (2, 'a code whose attempts are spent'),
    (3, 'a code whose delivery definitively failed'), (4, 'a code already verified'),
    (5, 'a code sent to another phone')) refused(n, label);
select pg_temp.expect_refusal($sql$select identity.record_public_patient_holder_proof(
    'b9300000-0000-4000-8000-000000000092', repeat('b8',32), 'registry_phone_otp',
    'b9350000-0000-4000-8000-000000000007', null, repeat('b6',32), 5)$sql$,
  '42501', 'PATIENT_ENROLLMENT_DENIED', 'A proof of an expired enrollment');
-- Sends: an expired enrollment, a proven one, one without a recipient.
select pg_temp.expect_refusal($sql$select identity.record_public_patient_holder_send(
    'b9300000-0000-4000-8000-000000000092', repeat('b8',32), repeat('b6',32), 5, 10, 30)$sql$,
  '42501', 'PATIENT_ENROLLMENT_DENIED', 'A send for an expired enrollment');
select pg_temp.expect_refusal($sql$select identity.record_public_patient_holder_send(
    'b9300000-0000-4000-8000-000000000003', repeat('03',32), repeat('d1',32), 5, 10, 30)$sql$,
  '42501', 'PATIENT_ENROLLMENT_DENIED', 'A send for a proven enrollment');
select pg_temp.expect_refusal($sql$select identity.record_public_patient_holder_send(
    'b9300000-0000-4000-8000-000000000093', repeat('c8',32), repeat('c6',32), 5, 10, 30)$sql$,
  '42501', 'PATIENT_ENROLLMENT_DENIED', 'A send for an enrollment without a holder recipient');
-- Failures: a contact code, and a proven enrollment's spent holder code.
select pg_temp.expect_refusal($sql$select identity.record_public_patient_holder_failure(
    'b9300000-0000-4000-8000-0000000000f1', repeat('f2',32), 'b9310000-0000-4000-8000-0000000000c1',
    repeat('df',32), 10, 30)$sql$,
  '42501', 'PATIENT_ENROLLMENT_DENIED', 'A failure counted on a contact code');
select pg_temp.expect_refusal($sql$select identity.record_public_patient_holder_failure(
    'b9300000-0000-4000-8000-000000000003', repeat('03',32), 'b9310000-0000-4000-8000-000000000003',
    repeat('d1',32), 10, 30)$sql$,
  '42501', 'PATIENT_ENROLLMENT_DENIED', 'A failure counted on a proven enrollment');
-- Another actor runs none of the commands.
select set_config('app.actor_subject','patient:b9340000-0000-4000-8000-0000000000aa',true);
select pg_temp.expect_refusal(refused.statement, '42501', 'PATIENT_ENROLLMENT_DENIED', refused.label)
  from (values
    ($sql$select identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-000000000091', repeat('a8',32),
      'registry_phone_otp', 'b9350000-0000-4000-8000-000000000006', null, repeat('a6',32), 5)$sql$,
     'A proof by another actor'),
    ($sql$select identity.record_public_patient_holder_send('b9300000-0000-4000-8000-000000000056', repeat('56',32),
      repeat('db',32), 5, 10, 30)$sql$, 'A send by another actor'),
    ($sql$select identity.record_public_patient_holder_failure('b9300000-0000-4000-8000-000000000091', repeat('a8',32),
      'b9350000-0000-4000-8000-000000000006', repeat('a6',32), 10, 30)$sql$, 'A failure by another actor')
  ) refused(statement, label);
select set_config('app.actor_subject','system:auth',true);
reset role;
-- While identity reconciliation is open, no proof is recorded.
savepoint holder_readiness;
insert into migration.runs (id, source_system, source_snapshot, mode, status, started_by)
values ('b9360000-0000-4000-8000-000000000001', 'legacy_identity', 'holder-readiness-fixture', 'stage', 'running',
  'synthetic-test');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select pg_temp.expect_refusal($sql$select identity.record_public_patient_holder_proof(
    'b9300000-0000-4000-8000-000000000091', repeat('a8',32), 'registry_phone_otp',
    'b9350000-0000-4000-8000-000000000006', null, repeat('a6',32), 5)$sql$,
  '55000', 'PATIENT_ENROLLMENT_RECONCILIATION_REQUIRED', 'A proof while reconciliation is open');
reset role;
rollback to savepoint holder_readiness;
do $$
begin
  if (select state from identity.public_patient_enrollments where id = 'b9300000-0000-4000-8000-000000000091')
       <> 'verify_holder'
     or exists (select 1 from identity.public_patient_enrollment_otps
       where enrollment_id = 'b9300000-0000-4000-8000-000000000091' and consumed_at is not null)
     or exists (select 1 from identity.public_patient_holder_events
       where nin_digest in (repeat('a6',32), repeat('b6',32), repeat('c6',32), repeat('df',32))) then
    raise exception 'A refused holder command changed an enrollment, spent a code or counted an event';
  end if;
end $$;
-- The refused codes stay usable once valid: r6 still proves R1.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if identity.record_public_patient_holder_proof('b9300000-0000-4000-8000-000000000091', repeat('a8',32),
      'registry_phone_otp', 'b9350000-0000-4000-8000-000000000006', null, repeat('a6',32), 5) <> 'verified' then
    raise exception 'A valid code was refused after the refusals around it';
  end if;
end $$;
reset role;

-- 6. Retention: send and failure events after 31 days, proofs after 366.
insert into identity.public_patient_holder_events (kind, nin_digest, phone_digest, method, occurred_at) values
  ('send', repeat('e6',32), repeat('c9',32), 'registry_phone_otp', clock_timestamp() - interval '32 days'),
  ('failure', repeat('e6',32), repeat('c9',32), 'registry_phone_otp', clock_timestamp() - interval '30 days'),
  ('proof', repeat('e6',32), repeat('c9',32), 'registry_phone_otp', clock_timestamp() - interval '365 days'),
  ('proof', repeat('e7',32), repeat('c9',32), 'registry_phone_otp', clock_timestamp() - interval '367 days');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select identity.prune_expired_public_patient_enrollments();
reset role;
do $$
begin
  if (select array_agg(kind || ':' || nin_digest order by kind, nin_digest) from identity.public_patient_holder_events
      where phone_digest = repeat('c9',32)) is distinct from
      array['failure:' || repeat('e6',32), 'proof:' || repeat('e6',32)] then
    raise exception 'The prune kept or removed the wrong holder events';
  end if;
end $$;

-- 7. Activation requires the holder proof. G1 to G7 are proved through the
-- command, then given a verified contact by the owner fixture; each case then
-- breaks one part of the proof.
select pg_temp.seed_enrollment(('b9300000-0000-4000-8000-00000000007' || n)::uuid, repeat('7' || n, 32),
  repeat('8' || n, 32), repeat('9' || n, 32), 'holder-g-00' || n,
  '{"nin":"12345679301","firstName":"Gift","lastName":"Sample","dateOfBirth":"1991-02-03","gender":"female","providerReference":"holder-g-00' || n || '"}')
  from generate_series(1, 7) n;
select pg_temp.seed_holder_code(('b9310000-0000-4000-8000-00000000007' || n)::uuid,
  ('b9300000-0000-4000-8000-00000000007' || n)::uuid, repeat('9' || n, 32))
  from generate_series(1, 7) n;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select set_config('app.correlation_id','public-patient-holder-0002',true);
do $$
declare
  n integer;
begin
  for n in 1..7 loop
    if identity.record_public_patient_holder_proof(('b9300000-0000-4000-8000-00000000007' || n)::uuid,
        repeat('8' || n, 32)::char(64), 'registry_phone_otp', ('b9310000-0000-4000-8000-00000000007' || n)::uuid,
        null, repeat('e' || n, 32)::char(64), 5) <> 'verified' then
      raise exception 'Fixture proof % failed', n;
    end if;
  end loop;
end $$;
reset role;
insert into identity.public_patient_enrollment_otps (id, enrollment_id, recipient_hmac, channel, purpose,
  verifier_hmac, verifier_key_version, created_at, expires_at, max_attempts, delivery_outcome, verified_at, consumed_at)
select ('b9320000-0000-4000-8000-00000000007' || n)::uuid, ('b9300000-0000-4000-8000-00000000007' || n)::uuid,
  repeat('a' || n, 32), 'email', 'contact', repeat('ab',32), 'fixture', clock_timestamp(),
  clock_timestamp() + interval '5 minutes', 5, 'accepted', clock_timestamp(), clock_timestamp()
  from generate_series(1, 7) n;
update identity.public_patient_enrollments enrollment
   set state = 'set_password', contact_channel = 'email', contact_hmac = repeat('a' || n, 32),
       contact_lookup_hmac = repeat('b' || n, 32), contact_ciphertext = decode(repeat('d' || n, 32), 'hex'),
       contact_verified_at = clock_timestamp(),
       verified_challenge_id = ('b9320000-0000-4000-8000-00000000007' || n)::uuid
  from generate_series(1, 7) n
 where enrollment.id = ('b9300000-0000-4000-8000-00000000007' || n)::uuid;
-- G2: the holder proof is later than the contact proof.
update identity.public_patient_enrollments set holder_verified_at = contact_verified_at + interval '1 second'
  where id = 'b9300000-0000-4000-8000-000000000072';
-- G3: the holder code was used after it expired.
update identity.public_patient_enrollment_otps set expires_at = verified_at - interval '1 second'
  where id = 'b9310000-0000-4000-8000-000000000073';
-- G4: the holder code went to another phone.
update identity.public_patient_enrollments set holder_recipient_hmac = repeat('ff',32)
  where id = 'b9300000-0000-4000-8000-000000000074';
-- G5: the recorded holder code is the contact code.
update identity.public_patient_enrollments set holder_challenge_id = verified_challenge_id
  where id = 'b9300000-0000-4000-8000-000000000075';
-- G6: an in-person proof with no recorded check (0094 accepts only a matched one).
update identity.public_patient_enrollments set holder_method = 'facility_in_person', holder_challenge_id = null,
  holder_verification_id = gen_random_uuid() where id = 'b9300000-0000-4000-8000-000000000076';
-- G7: the contact code was used after it expired.
update identity.public_patient_enrollment_otps set expires_at = verified_at - interval '1 second'
  where id = 'b9320000-0000-4000-8000-000000000077';

set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
declare
  test_hash text := '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret';
  activated record;
  n integer;
  expected text;
begin
  for n in 2..7 loop
    expected := case when n = 7 then 'PATIENT_CONTACT_NOT_VERIFIED' else 'PATIENT_HOLDER_PROOF_INVALID' end;
    begin
      perform identity.activate_public_patient_enrollment(('b9300000-0000-4000-8000-00000000007' || n)::uuid,
        repeat('8' || n, 32)::char(64),
        '{"nin":"12345679301","firstName":"Gift","lastName":"Sample","dateOfBirth":"1991-02-03","gender":"female","providerReference":"holder-g-00' || n || '"}',
        'gift' || n || '@example.invalid', 'HID-ABCDEFGK', test_hash, repeat('b' || n, 32)::char(64));
      raise exception 'Activation case G% created a Health ID', n;
    exception when check_violation then
      if sqlerrm <> expected then
        raise exception 'Activation case G% was refused with % instead of %', n, sqlerrm, expected;
      end if;
    end;
  end loop;
  select * into activated from identity.activate_public_patient_enrollment('b9300000-0000-4000-8000-000000000071',
    repeat('81',32)::char(64),
    '{"nin":"12345679301","firstName":"Gift","lastName":"Sample","dateOfBirth":"1991-02-03","gender":"female","providerReference":"holder-g-001"}',
    'gift1@example.invalid', 'HID-ABCDEFGJ', test_hash, repeat('b1',32)::char(64));
  if activated.replayed or activated.patient_id is null then
    raise exception 'A proven enrollment did not activate';
  end if;
end $$;
reset role;
set constraints all immediate;
do $$
begin
  if (select assurance.nin_verified_at = enrollment.holder_verified_at
      from identity.patient_assurance_states assurance
      join identity.public_patient_enrollments enrollment on enrollment.patient_id = assurance.patient_id
      where enrollment.id = 'b9300000-0000-4000-8000-000000000071') is not true then
    raise exception 'The NIN was not recorded as verified at the holder proof';
  end if;
  if (select details->>'holderMethod' from audit.events where action = 'identity.public-patient-enrollment.activated'
      and correlation_id = 'public-patient-holder-0002') is distinct from 'registry_phone_otp' then
    raise exception 'The activation audit event does not name the holder method';
  end if;
  if (select count(*) from identity.patients where hid_code like 'HID-ABCDEFG%' and source_system = 'hid-public-qoreid-enrollment') <> 1 then
    raise exception 'A refused activation created a patient';
  end if;
end $$;

-- H1 to H4: activation re-reads both codes. Each enrollment is proved through
-- the command and given a verified contact (H4 a phone), then one code is
-- changed: H1 the holder code is no longer consumed, H2 it was closed by a
-- resend, H3 it is re-purposed as a contact code, H4 the contact code is
-- re-purposed as a holder code.
select pg_temp.seed_enrollment(('b9300000-0000-4000-8000-00000000008' || n)::uuid, repeat('4' || n, 32),
  repeat('6' || n, 32), repeat('3' || n, 32), 'holder-h-00' || n,
  '{"nin":"12345679301","firstName":"Gift","lastName":"Sample","dateOfBirth":"1991-02-03","gender":"female","providerReference":"holder-h-00' || n || '"}')
  from generate_series(1, 4) n;
select pg_temp.seed_holder_code(('b9310000-0000-4000-8000-00000000008' || n)::uuid,
  ('b9300000-0000-4000-8000-00000000008' || n)::uuid, repeat('3' || n, 32))
  from generate_series(1, 4) n;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
declare
  n integer;
begin
  for n in 1..4 loop
    if identity.record_public_patient_holder_proof(('b9300000-0000-4000-8000-00000000008' || n)::uuid,
        repeat('6' || n, 32)::char(64), 'registry_phone_otp', ('b9310000-0000-4000-8000-00000000008' || n)::uuid,
        null, repeat('2' || n, 32)::char(64), 5) <> 'verified' then
      raise exception 'Fixture proof H% failed', n;
    end if;
  end loop;
end $$;
reset role;
insert into identity.public_patient_enrollment_otps (id, enrollment_id, recipient_hmac, channel, purpose,
  verifier_hmac, verifier_key_version, created_at, expires_at, max_attempts, delivery_outcome, verified_at, consumed_at)
select ('b9320000-0000-4000-8000-00000000008' || n)::uuid, ('b9300000-0000-4000-8000-00000000008' || n)::uuid,
  repeat('1' || n, 32), case when n = 4 then 'phone' else 'email' end, 'contact', repeat('ab',32), 'fixture',
  clock_timestamp(), clock_timestamp() + interval '5 minutes', 5, 'accepted', clock_timestamp(), clock_timestamp()
  from generate_series(1, 4) n;
update identity.public_patient_enrollments enrollment
   set state = 'set_password', contact_channel = case when n = 4 then 'phone' else 'email' end,
       contact_hmac = repeat('1' || n, 32), contact_lookup_hmac = repeat('0' || n, 32),
       contact_ciphertext = decode(repeat('d' || n, 32), 'hex'), contact_verified_at = clock_timestamp(),
       verified_challenge_id = ('b9320000-0000-4000-8000-00000000008' || n)::uuid
  from generate_series(1, 4) n
 where enrollment.id = ('b9300000-0000-4000-8000-00000000008' || n)::uuid;
update identity.public_patient_enrollment_otps set consumed_at = null
  where id = 'b9310000-0000-4000-8000-000000000081';
update identity.public_patient_enrollment_otps set consumed_at = null, invalidated_at = clock_timestamp(),
    invalidation_reason = 'resend'
  where id = 'b9310000-0000-4000-8000-000000000082';
update identity.public_patient_enrollment_otps set purpose = 'contact'
  where id = 'b9310000-0000-4000-8000-000000000083';
update identity.public_patient_enrollment_otps set purpose = 'nin_holder'
  where id = 'b9320000-0000-4000-8000-000000000084';
-- Deferred again, as in production, so an activation that is not refused
-- completes and reports itself rather than tripping a foreign key early.
set constraints all deferred;
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select set_config('app.correlation_id','public-patient-holder-0003',true);
select pg_temp.expect_refusal(format($sql$select identity.activate_public_patient_enrollment(%L::uuid,
    repeat(%L, 32)::char(64),
    %L, %L, 'HID-ABCDEFHK',
    '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret',
    repeat(%L, 32)::char(64))$sql$,
    'b9300000-0000-4000-8000-00000000008' || n, '6' || n,
    '{"nin":"12345679301","firstName":"Gift","lastName":"Sample","dateOfBirth":"1991-02-03","gender":"female","providerReference":"holder-h-00' || n || '"}',
    case when n = 4 then '+2348030000084' else 'gift-h' || n || '@example.invalid' end, '0' || n),
  '23514', case when n = 4 then 'PATIENT_CONTACT_NOT_VERIFIED' else 'PATIENT_HOLDER_PROOF_INVALID' end,
  'Activation case H' || n)
  from generate_series(1, 4) n;
reset role;
do $$
begin
  if exists (select 1 from identity.public_patient_enrollments
      where id::text like 'b9300000-0000-4000-8000-00000000008_' and state <> 'set_password')
     or exists (select 1 from identity.patients where hid_code = 'HID-ABCDEFHK') then
    raise exception 'A refused activation changed an enrollment or created a patient';
  end if;
end $$;

rollback;
