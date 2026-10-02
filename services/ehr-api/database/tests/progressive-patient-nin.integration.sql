\set ON_ERROR_STOP on
begin;

-- Synthetic legacy identity inventory. These inert ciphertext bytes exercise
-- database invariants; the Identity service tests exercise AES-GCM/QoreID.
insert into migration.runs(id,source_system,source_snapshot,mode,status,started_by)
values('c1000000-0000-4000-8000-000000000099','legacy_identity',
  'synthetic-failed-historical-snapshot','stage','running','synthetic-test');
insert into migration.source_rows(run_id,entity_type,source_pk,payload,payload_sha256)
values('c1000000-0000-4000-8000-000000000099','patients',
  'c2000000-0000-4000-8000-000000000099','{"synthetic":"failed-history"}',repeat('9',64));
update migration.runs set status='staged',source_counts='{"patients":1}',
  source_checksum_sha256=repeat('9',64)
where id='c1000000-0000-4000-8000-000000000099';
update migration.runs set status='failed',completed_at=clock_timestamp()
where id='c1000000-0000-4000-8000-000000000099';
insert into migration.runs(id,source_system,source_snapshot,mode,status,started_by)
values('c1000000-0000-4000-8000-000000000001','legacy_identity',
  'synthetic-progressive-nin-snapshot','stage','running','synthetic-test');
insert into migration.source_rows(run_id,entity_type,source_pk,payload,payload_sha256)
values
 ('c1000000-0000-4000-8000-000000000001','patients',
  'c2000000-0000-4000-8000-000000000001','{"synthetic":true}',repeat('1',64)),
 ('c1000000-0000-4000-8000-000000000001','patients',
  'c2000000-0000-4000-8000-000000000002','{"synthetic":true}',repeat('2',64));
update migration.runs set status='staged',source_counts='{"patients":2}',
  source_checksum_sha256=repeat('e',64)
where id='c1000000-0000-4000-8000-000000000001';
update migration.runs set mode='reconcile',status='verified',completed_at=clock_timestamp()
where id='c1000000-0000-4000-8000-000000000001';
insert into auth.accounts(id,subject,email,display_name,status,source_system)
values
 ('c3000000-0000-4000-8000-000000000001','patient:progressive-legacy-1',
  'progressive-one@example.invalid','Amina Okafor','active','legacy_identity'),
 ('c3000000-0000-4000-8000-000000000002','patient:progressive-legacy-2',
  'progressive-two@example.invalid','Bola Uche','active','legacy_identity');
insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,
  dob,source_system,source_record_id,status)
values
 ('c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001',
  'HID-LEGACYA','Amina','Okafor','Amina Okafor','1990-05-12',
  'legacy_identity','c2000000-0000-4000-8000-000000000001','active'),
 ('c2000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000002',
  'HID-LEGACYB','Bola','Uche','Bola Uche','1988-03-04',
  'legacy_identity','c2000000-0000-4000-8000-000000000002','active');
insert into migration.legacy_identity_mappings(run_id,source_system,source_auth_user_id,
  source_patient_id,legacy_hid_code,canonical_patient_id,canonical_account_id,
  migration_status,source_checksum_sha256,source_version,migrated_at)
values
 ('c1000000-0000-4000-8000-000000000001','legacy_identity','legacy-auth-1',
  'c2000000-0000-4000-8000-000000000001','HID-LEGACYA',
  'c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001',
  'promoted',repeat('1',64),'synthetic-v1',clock_timestamp()),
 ('c1000000-0000-4000-8000-000000000001','legacy_identity','legacy-auth-2',
  'c2000000-0000-4000-8000-000000000002','HID-LEGACYB',
  'c2000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000002',
  'promoted',repeat('2',64),'synthetic-v1',clock_timestamp());
insert into identity.patient_assurance_states(patient_id,account_id,state,source_system)
values
 ('c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001',
  'LEGACY_MIGRATED','legacy_identity'),
 ('c2000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000002',
  'LEGACY_MIGRATED','legacy_identity');
insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,
  account_token_version,authentication_method,issued_at,expires_at,absolute_expires_at,
  session_kind,patient_id)
values
 ('c4000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001',
  'c4000000-0000-4000-8000-000000000001',repeat('1',64),gen_random_uuid(),1,
  'password',clock_timestamp(),clock_timestamp()+interval '1 hour',
  clock_timestamp()+interval '2 hours','patient','c2000000-0000-4000-8000-000000000001'),
 ('c4000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000002',
  'c4000000-0000-4000-8000-000000000002',repeat('2',64),gen_random_uuid(),1,
  'password',clock_timestamp(),clock_timestamp()+interval '1 hour',
  clock_timestamp()+interval '2 hours','patient','c2000000-0000-4000-8000-000000000002');

-- A pending public enrollment for the exact NIN attested to legacy patient 2.
-- Even verified contact and password cannot create a second patient.
insert into identity.public_patient_enrollments(id,nin_lookup_hmac,nin_last4,
  nin_ciphertext,profile_ciphertext,profile_sha256,key_version,provider_reference,
  request_hmac,token_hmac,state,contact_channel,contact_hmac,contact_lookup_hmac,
  contact_ciphertext,contact_verified_at,verified_challenge_id)
values('c5000000-0000-4000-8000-000000000001',repeat('b',64),'8902',
  decode(repeat('11',32),'hex'),decode(repeat('22',32),'hex'),
  encode(public.digest('{"nin":"12345678902","firstName":"Bola","lastName":"Uche","dateOfBirth":"1988-03-04","gender":"male","providerReference":"progressive-fixture"}',
    'sha256'),'hex'),'synthetic-v1','progressive-fixture',repeat('3',64),repeat('4',64),
  'set_password','email',repeat('5',64),repeat('6',64),decode(repeat('33',32),'hex'),
  clock_timestamp(),'c6000000-0000-4000-8000-000000000001');
insert into identity.public_patient_enrollment_otps(id,enrollment_id,recipient_hmac,
  channel,verifier_hmac,verifier_key_version,expires_at,max_attempts,
  delivery_outcome,verified_at,consumed_at)
values('c6000000-0000-4000-8000-000000000001',
  'c5000000-0000-4000-8000-000000000001',repeat('5',64),'email',repeat('7',64),
  'synthetic-v1',clock_timestamp()+interval '10 minutes',5,'accepted',
  clock_timestamp(),clock_timestamp());

set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true),
  set_config('app.correlation_id','progressive-nin-test-0001',true);
do $$
begin
  if identity.public_patient_enrollment_ready() then
    raise exception 'Unattested legacy inventory allowed public activation';
  end if;
  begin
    perform identity.activate_public_patient_enrollment(
      'c5000000-0000-4000-8000-000000000001',repeat('4',64)::char(64),
      '{"nin":"12345678902","firstName":"Bola","lastName":"Uche","dateOfBirth":"1988-03-04","gender":"male","providerReference":"progressive-fixture"}',
      'new-contact@example.invalid','HID-PRGABC',
      '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret',
      repeat('6',64)::char(64));
    raise exception 'Public activation ignored missing reconciliation attestation';
  exception when sqlstate '55000' then null; end;
end $$;
reset role;

insert into migration.legacy_nin_crosswalk(run_id,patient_id,source_row_sha256,
  nin_state,nin_lookup_hmac,source_snapshot,evidence_reference,attested_by,attested_at)
values
 ('c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001',
  repeat('1',64),'attested_absent',null,'synthetic-progressive-nin-snapshot',
  'synthetic-source-inventory-1','synthetic-operator',clock_timestamp()),
 ('c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000002',
  repeat('2',64),'attested_exact',repeat('b',64),'synthetic-progressive-nin-snapshot',
  'synthetic-source-inventory-2','synthetic-operator',clock_timestamp());
insert into migration.legacy_nin_crosswalk_attestations(run_id,source_snapshot,
  source_checksum_sha256,patient_count,exact_nin_count,absent_nin_count,
  inventory_sha256,evidence_reference,attested_by,attested_at)
select 'c1000000-0000-4000-8000-000000000001',
  'synthetic-progressive-nin-snapshot',repeat('e',64),2,1,1,
  encode(public.digest(string_agg(item.patient_id::text || E'\x1f'
    || item.source_row_sha256::text || E'\x1f' || item.nin_state || E'\x1f'
    || coalesce(item.nin_lookup_hmac::text,''),E'\n' order by item.patient_id),'sha256'),'hex'),
  'synthetic-complete-inventory','synthetic-operator',clock_timestamp()
from migration.legacy_nin_crosswalk item
where item.run_id='c1000000-0000-4000-8000-000000000001' and item.status='active';

-- Terminal failed attempts remain immutable evidence, while the complete
-- later verified run governs readiness. Revoked or incomplete current evidence
-- still closes the boundary.
select set_config('app.actor_subject','system:auth',true);
do $$ begin
  if not identity.legacy_nin_crosswalk_ready() then
    raise exception 'Failed historical run permanently blocked a valid later inventory';
  end if;
end $$;
savepoint before_revoked_attestation;
update migration.legacy_nin_crosswalk_attestations
  set status='revoked',revoked_at=clock_timestamp(),
      revocation_reason='Synthetic revoked attestation'
where run_id='c1000000-0000-4000-8000-000000000001';
do $$ begin
  if identity.legacy_nin_crosswalk_ready() then
    raise exception 'Revoked active-run attestation left readiness open';
  end if;
end $$;
rollback to savepoint before_revoked_attestation;
savepoint before_incomplete_inventory;
update migration.legacy_nin_crosswalk
  set status='revoked',revoked_at=clock_timestamp(),
      revocation_reason='Synthetic incomplete inventory'
where patient_id='c2000000-0000-4000-8000-000000000001';
do $$ begin
  if identity.legacy_nin_crosswalk_ready() then
    raise exception 'Incomplete active crosswalk inventory left readiness open';
  end if;
end $$;
rollback to savepoint before_incomplete_inventory;

insert into migration.patient_contact_lookup_rekeys(source_snapshot,operator,
  legacy_patient_count,legacy_contact_count,enrollment_count)
values('synthetic-progressive-nin-snapshot','synthetic-operator',2,0,1);

set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
begin
  if not identity.public_patient_enrollment_ready()
    or not identity.public_patient_nin_already_bound(repeat('b',64)::char(64)) then
    raise exception 'Exact legacy crosswalk was not active after attestation';
  end if;
  begin
    perform identity.activate_public_patient_enrollment(
      'c5000000-0000-4000-8000-000000000001',repeat('4',64)::char(64),
      '{"nin":"12345678902","firstName":"Bola","lastName":"Uche","dateOfBirth":"1988-03-04","gender":"male","providerReference":"progressive-fixture"}',
      'new-contact@example.invalid','HID-PRGABC',
      '$argon2id$v=19$m=65536,t=3,p=1$fixture-salt$fixture-password-digest-not-an-operational-secret',
      repeat('6',64)::char(64));
    raise exception 'Crosswalk NIN created a duplicate patient';
  exception when unique_violation then null; end;
end $$;
select set_config('app.actor_subject','patient:progressive-legacy-1',true);
do $$
declare
  result record;
  patient_one_unbound text;
  patient_one_conflict text;
  patient_two_exact text;
  patient_two_mismatch text;
begin
  patient_one_unbound := identity.patient_self_nin_eligibility(
    'patient:progressive-legacy-1','c4000000-0000-4000-8000-000000000001',
    repeat('a',64)::char(64));
  patient_one_conflict := identity.patient_self_nin_eligibility(
    'patient:progressive-legacy-1','c4000000-0000-4000-8000-000000000001',
    repeat('b',64)::char(64));
  perform set_config('app.actor_subject','patient:progressive-legacy-2',true);
  patient_two_exact := identity.patient_self_nin_eligibility(
    'patient:progressive-legacy-2','c4000000-0000-4000-8000-000000000002',
    repeat('b',64)::char(64));
  patient_two_mismatch := identity.patient_self_nin_eligibility(
    'patient:progressive-legacy-2','c4000000-0000-4000-8000-000000000002',
    repeat('a',64)::char(64));
  perform set_config('app.actor_subject','patient:progressive-legacy-1',true);
  if patient_one_unbound <> 'legacy_unbound'
    or patient_one_conflict <> 'denied'
    or patient_two_exact <> 'legacy_unbound'
    or patient_two_mismatch <> 'denied' then
    raise exception 'Session-bound eligibility failed: one=%, conflict=%, exact=%, mismatch=%',
      patient_one_unbound,patient_one_conflict,patient_two_exact,patient_two_mismatch;
  end if;
  select * into result from identity.bind_my_verified_nin(
    'patient:progressive-legacy-1','c4000000-0000-4000-8000-000000000001',
    'c7000000-0000-4000-8000-000000000001',repeat('a',64)::char(64),
    decode(repeat('81',32),'hex'),'synthetic-v1','8901','qoreid-fixture-1',
    decode(repeat('82',64),'hex'),
    encode(public.digest(decode(repeat('82',64),'hex'),'sha256'),'hex')::char(64));
  if result.evidence_id <> 'c7000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'Progressive verification evidence was not returned';
  end if;
  if identity.patient_self_nin_eligibility('patient:progressive-legacy-1',
      'c4000000-0000-4000-8000-000000000001',repeat('a',64)::char(64)) <> 'bound_exact' then
    raise exception 'Verified patient was not recognized by exact NIN';
  end if;
  begin
    perform identity.bind_my_verified_nin(
      'patient:progressive-legacy-1','c4000000-0000-4000-8000-000000000002',
      'c7000000-0000-4000-8000-000000000002',repeat('a',64)::char(64),
      decode(repeat('81',32),'hex'),'synthetic-v1','8901','qoreid-fixture-2',
      decode(repeat('82',64),'hex'),
      encode(public.digest(decode(repeat('82',64),'hex'),'sha256'),'hex')::char(64));
    raise exception 'Other patient session bound NIN';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$
begin
  if (select count(*) from identity.patients where source_system='legacy_identity') <> 2
    or (select count(*) from auth.accounts where source_system='legacy_identity') <> 2
    or (select hid_code from identity.patients
      where id='c2000000-0000-4000-8000-000000000001') <> 'HID-LEGACYA'
    or (select state from identity.patient_assurance_states
      where patient_id='c2000000-0000-4000-8000-000000000001') <> 'NIN_VERIFIED'
    or (select source_system from identity.patient_assurance_states
      where patient_id='c2000000-0000-4000-8000-000000000001') <> 'legacy_identity'
    or (select state from identity.patient_assurance_states
      where patient_id='c2000000-0000-4000-8000-000000000002') <> 'LEGACY_MIGRATED'
    or (select count(*) from identity.patient_identifiers
      where patient_id='c2000000-0000-4000-8000-000000000001'
        and identifier_type='nin' and patient_self_evidence_id is not null) <> 1
    or (select count(*) from identity.patient_authoritative_profiles
      where patient_id='c2000000-0000-4000-8000-000000000001'
        and patient_self_evidence_id='c7000000-0000-4000-8000-000000000001') <> 1
    or (select count(*) from identity.patients where source_system='hid-public-qoreid-enrollment') <> 0
    or (select count(*) from audit.events where correlation_id='progressive-nin-test-0001'
      and action='identity.patient.nin-verification' and outcome='success') <> 1 then
    raise exception 'Progressive NIN changed canonical identity or lacked atomic evidence';
  end if;
end $$;

rollback;
