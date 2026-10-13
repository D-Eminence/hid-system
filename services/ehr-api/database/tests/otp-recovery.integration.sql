\set ON_ERROR_STOP on
begin;

-- Synthetic data only. Exercise the exact non-owner role rather than the
-- privileged schema-test role that would hide a missing runtime grant.
insert into auth.accounts(id, subject, email, status, token_version, disabled_until)
select ('92000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
       'synthetic:otp:' || n, 'otp-' || n || '@example.invalid',
       case when n=2 then 'pending_reset' when n=3 then 'disabled' else 'active' end,
       case when n=5 then 2 else 1 end,
       case when n=4 then clock_timestamp()+interval '1 hour' else null end
from generate_series(1,10) n;
insert into identity.patients(id, account_id, hid_code, first_name, last_name, full_name)
values ('93000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',
  'HID-QRABCDEFG','Synthetic','OTP','Synthetic OTP');
insert into identity.patient_assurance_states(patient_id,account_id,state,source_system,nin_verified_at,verified_provider)
values ('93000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',
  'NIN_VERIFIED','synthetic',clock_timestamp(),'synthetic-provider');
insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,
  account_token_version,authentication_method,issued_at,expires_at,absolute_expires_at)
values ('94000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000001',repeat('d',64),'94000000-0000-4000-8000-000000000002',
  1,'password',clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours');
insert into auth.otp_challenges(id,account_id,recipient_hmac,purpose,channel,verifier_hmac,
  verifier_key_version,expires_at,max_attempts,failed_attempts,verified_at,
  completion_token_hmac,completion_expires_at,account_token_version)
select ('95000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
       ('92000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
       md5(n::text)||md5(n::text),'PASSWORD_RESET','email',repeat('b',64),'synthetic',
       clock_timestamp()+interval '5 minutes',5,case when n=9 then 5 else 0 end,
       case when n=8 then null else clock_timestamp() end,
       case when n=8 then null else repeat('a',64) end,
       case when n=8 then null when n=6 then clock_timestamp()-interval '1 second'
            else clock_timestamp()+interval '5 minutes' end,
       case when n=7 then null else 1 end
from generate_series(1,10) n;
insert into auth.otp_challenges(id,account_id,recipient_hmac,purpose,channel,verifier_hmac,
  verifier_key_version,expires_at,max_attempts,account_token_version)
values ('95000000-0000-4000-8000-000000000011','92000000-0000-4000-8000-000000000001',
  repeat('c',64),'LEGACY_ACCOUNT_RECOVERY','email',repeat('b',64),'synthetic',clock_timestamp()+interval '5 minutes',5,1);
-- A Google link of account 1 (made by whoever once held its password) and a
-- disabled one, and a link of account 10, whose recovery fails below (0086).
insert into auth.external_identities(id,account_id,issuer,subject,status,source_system) values
  ('97000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',
   'https://accounts.google.com','synthetic-google-subject-1','active','synthetic'),
  ('97000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000001',
   'https://accounts.google.com','synthetic-google-subject-2','disabled','synthetic'),
  ('97000000-0000-4000-8000-000000000010','92000000-0000-4000-8000-000000000010',
   'https://accounts.google.com','synthetic-google-subject-10','active','synthetic');
-- The legacy importer's provenance record of account 1 (issuer
-- 'legacy-identity', promote-legacy-identity.mjs): not a sign-in, so a
-- recovery keeps it and does not count it.
insert into auth.external_identities(id,account_id,issuer,subject,status,source_system) values
  ('97000000-0000-4000-8000-000000000003','92000000-0000-4000-8000-000000000001',
   'legacy-identity','92000000-0000-4000-8000-000000000001','active','legacy_identity');
-- Account 2 completes a staff reset: its staff and platform sessions end too.
insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,
  account_token_version,authentication_method,issued_at,expires_at,absolute_expires_at,session_kind)
values ('94000000-0000-4000-8000-000000000021','92000000-0000-4000-8000-000000000002',
  '94000000-0000-4000-8000-000000000021',repeat('e',64),'94000000-0000-4000-8000-000000000022',
  1,'password',clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours','staff'),
  ('94000000-0000-4000-8000-000000000023','92000000-0000-4000-8000-000000000002',
  '94000000-0000-4000-8000-000000000023',repeat('f',64),'94000000-0000-4000-8000-000000000024',
  1,'password',clock_timestamp(),clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '1 hour','platform');
-- Recovery audiences (0086): 11 staff, 12 platform administrator, 13 both a
-- patient and staff, 14 an inactive staff record, 15 a revoked platform role.
insert into auth.accounts(id, subject, email, status)
select ('92000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, 'synthetic:otp:' || n, 'otp-' || n || '@example.invalid',
  case when n=12 then 'pending_reset' else 'active' end
from generate_series(11,15) n;
insert into identity.staff(id, account_id, full_name, email, verification_status, default_role, active)
select ('98000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, ('92000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  'Synthetic Staff ' || n, 'otp-' || n || '@example.invalid', 'verified', 'nurse', n <> 14
from (values (11), (13), (14)) staff_fixture(n);
insert into identity.patients(id, account_id, hid_code, first_name, last_name, full_name)
values ('93000000-0000-4000-8000-000000000013','92000000-0000-4000-8000-000000000013',
  'HID-QRDUALRLE','Synthetic','Dual','Synthetic Dual');
insert into auth.account_roles(id, account_id, role_code, scope_type, grant_reason, granted_at, revoked_at, revoked_by,
  revocation_reason)
values ('99000000-0000-4000-8000-000000000012','92000000-0000-4000-8000-000000000012','platform_admin','platform',
   'Synthetic recovery audience role', clock_timestamp() - interval '1 hour', null, null, null),
  ('99000000-0000-4000-8000-000000000015','92000000-0000-4000-8000-000000000015','platform_admin','platform',
   'Synthetic recovery audience role', clock_timestamp() - interval '1 hour', clock_timestamp(),
   '92000000-0000-4000-8000-000000000012', 'Synthetic revoked platform role');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
select set_config('app.correlation_id','otp-schema-regression-0001',true);
do $$
declare
  test_hash text := '$argon2id$v=19$m=65536,t=3,p=1$synthetic-salt$synthetic-password-digest-not-an-operational-secret';
  n integer;
begin
  if auth.complete_recovery_otp('95000000-0000-4000-8000-000000000001','LEGACY_ACCOUNT_RECOVERY',repeat('a',64),test_hash)
     or auth.complete_recovery_otp('95000000-0000-4000-8000-000000000001','PASSWORD_RESET',repeat('f',64),test_hash) then
    raise exception 'Wrong purpose/token authorized recovery';
  end if;
  for n in 3..9 loop
    if auth.complete_recovery_otp(('95000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        'PASSWORD_RESET',repeat('a',64),test_hash) then
      raise exception 'Ineligible or expired/unbound/exhausted challenge % authorized recovery', n;
    end if;
  end loop;
  if not auth.complete_recovery_otp('95000000-0000-4000-8000-000000000001','PASSWORD_RESET',repeat('a',64),test_hash)
     or not auth.complete_recovery_otp('95000000-0000-4000-8000-000000000002','PASSWORD_RESET',repeat('a',64),test_hash) then
    raise exception 'Eligible exact-role recovery failed';
  end if;
  if auth.complete_recovery_otp('95000000-0000-4000-8000-000000000001','PASSWORD_RESET',repeat('a',64),test_hash) then
    raise exception 'Completion credential replay succeeded';
  end if;
  begin
    update auth.accounts set status='active' where id='92000000-0000-4000-8000-000000000003';
    raise exception 'Identity runtime received generic account UPDATE';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

do $$
begin
  if (select state from identity.patient_assurance_states where patient_id='93000000-0000-4000-8000-000000000001') <> 'NIN_VERIFIED'
     or (select contact_verified_at is null from identity.patient_assurance_states where patient_id='93000000-0000-4000-8000-000000000001') then
    raise exception 'Recovery lost existing NIN assurance or contact verification';
  end if;
  if (select count(*) from auth.accounts where id in ('92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000002')
      and status='active' and password_algorithm='argon2id' and token_version=2) <> 2 then
    raise exception 'Account recovery did not atomically update credential state';
  end if;
  if (select revoked_at is null from auth.sessions where id='94000000-0000-4000-8000-000000000001')
     or (select invalidation_reason from auth.otp_challenges where id='95000000-0000-4000-8000-000000000011') <> 'completed'
     or (select count(*) from audit.events where correlation_id='otp-schema-regression-0001'
       and action='auth.otp.recovery.completed' and outcome='success') <> 2 then
    raise exception 'Recovery session/challenge/audit transaction is incomplete';
  end if;
  if (select status from auth.accounts where id='92000000-0000-4000-8000-000000000003') <> 'disabled' then
    raise exception 'Recovery enabled a disabled account';
  end if;
end
$$;

-- A completed recovery ends every session of the account, staff and platform
-- included, and revokes every Google link not already revoked (0086).
do $$
begin
  if exists (select 1 from auth.sessions where account_id='92000000-0000-4000-8000-000000000002'
               and (revoked_at is null or revocation_reason <> 'password_recovered_with_otp')) then
    raise exception 'A completed staff reset left a staff or platform session open';
  end if;
  if exists (select 1 from auth.external_identities where account_id='92000000-0000-4000-8000-000000000001'
               and issuer <> 'legacy-identity' and (status <> 'revoked' or revoked_at is null)) then
    raise exception 'Recovery left an external identity (Google link) of the account usable';
  end if;
  if (select status from auth.external_identities where id='97000000-0000-4000-8000-000000000003') <> 'active'
     or (select revoked_at from auth.external_identities where id='97000000-0000-4000-8000-000000000003') is not null then
    raise exception 'Recovery revoked the legacy importer provenance record, which is not a sign-in';
  end if;
  if exists (select 1 from auth.resolve_google_identity('synthetic-google-subject-1')) then
    raise exception 'Google sign-in still resolves the recovered account';
  end if;
  if (select details->>'external_identities_revoked' from audit.events where correlation_id='otp-schema-regression-0001'
        and action='auth.otp.recovery.completed' and actor_account_id='92000000-0000-4000-8000-000000000001') is distinct from '2'
     or (select details->>'external_identities_revoked' from audit.events where correlation_id='otp-schema-regression-0001'
        and action='auth.otp.recovery.completed' and actor_account_id='92000000-0000-4000-8000-000000000002') is distinct from '0' then
    raise exception 'The recovery audit does not record how many external identities were revoked';
  end if;
end
$$;

-- Mandatory audit write failure must roll back password, token and consumption.
create function pg_temp.reject_recovery_audit() returns trigger language plpgsql as $$
begin
  if new.action='auth.otp.recovery.completed' then
    raise exception using errcode='23514', message='Synthetic primary audit failure';
  end if;
  return new;
end $$;
create trigger synthetic_recovery_audit_failure before insert on audit.events
  for each row execute function pg_temp.reject_recovery_audit();
set local role hid_identity_api_runtime;
do $$
begin
  begin
    perform auth.complete_recovery_otp('95000000-0000-4000-8000-000000000010','PASSWORD_RESET',repeat('a',64),
      '$argon2id$v=19$m=65536,t=3,p=1$synthetic-salt$synthetic-password-digest-not-an-operational-secret');
    raise exception 'Recovery ignored primary audit failure';
  exception when check_violation then null;
  end;
  perform set_config('app.actor_subject','',true);
  begin
    perform auth.complete_recovery_otp('95000000-0000-4000-8000-000000000010','PASSWORD_RESET',repeat('a',64),
      '$argon2id$v=19$m=65536,t=3,p=1$synthetic-salt$synthetic-password-digest-not-an-operational-secret');
    raise exception 'Recovery permitted missing system authentication context';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$
begin
  if (select token_version from auth.accounts where id='92000000-0000-4000-8000-000000000010') <> 1
     or (select consumed_at is not null from auth.otp_challenges where id='95000000-0000-4000-8000-000000000010') then
    raise exception 'Recovery audit failure did not roll back authoritative mutation';
  end if;
  if (select status from auth.external_identities where id='97000000-0000-4000-8000-000000000010') <> 'active' then
    raise exception 'Recovery audit failure did not roll back the external identity revocation';
  end if;
end $$;

-- Recovery audiences (0086): a start reaches only its own kind of account.
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$
declare
  expected constant jsonb := jsonb_build_object(
    '1',  jsonb_build_array(true,  false, false),
    '11', jsonb_build_array(false, true,  false),
    '12', jsonb_build_array(false, false, true),
    '13', jsonb_build_array(true,  true,  false),
    '14', jsonb_build_array(false, false, false),
    '15', jsonb_build_array(false, false, false),
    '5',  jsonb_build_array(false, false, false));
  account_number text;
  actual jsonb;
begin
  for account_number in select jsonb_object_keys(expected) loop
    actual := jsonb_build_array(
      auth.recovery_account_audience(('92000000-0000-4000-8000-' || lpad(account_number,12,'0'))::uuid, 'patient'),
      auth.recovery_account_audience(('92000000-0000-4000-8000-' || lpad(account_number,12,'0'))::uuid, 'staff'),
      auth.recovery_account_audience(('92000000-0000-4000-8000-' || lpad(account_number,12,'0'))::uuid, 'platform'));
    if actual is distinct from expected -> account_number then
      raise exception 'Recovery audience of account % is % (patient, staff, platform), expected %',
        account_number, actual, expected -> account_number;
    end if;
  end loop;
  if auth.recovery_account_audience(null, 'patient') then
    raise exception 'An absent account matched a recovery audience';
  end if;
  begin
    perform auth.recovery_account_audience('92000000-0000-4000-8000-000000000001', 'clinician');
    raise exception 'An unknown recovery audience was accepted';
  exception when invalid_parameter_value then null;
  end;
  perform set_config('app.actor_subject', 'synthetic:otp:11', true);
  begin
    perform auth.recovery_account_audience('92000000-0000-4000-8000-000000000001', 'patient');
    raise exception 'The recovery audience was readable outside the Identity system context';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Recovery start cooldown (0081): one row per purpose and keyed identifier,
-- whether or not the identifier has an account, so a repeat start inside the
-- cooldown is answered alike. Its challenge id may name no challenge.
do $$
begin
  if to_regclass('auth.otp_start_cooldowns') is null then
    raise exception 'Recovery start cooldown table auth.otp_start_cooldowns is missing';
  end if;
  if (select array_agg(attribute.attname::text order by key_column.seq)
        from pg_constraint key_constraint
        cross join lateral unnest(key_constraint.conkey) with ordinality key_column(attnum, seq)
        join pg_attribute attribute
          on attribute.attrelid = key_constraint.conrelid and attribute.attnum = key_column.attnum
       where key_constraint.conrelid = 'auth.otp_start_cooldowns'::regclass and key_constraint.contype = 'p')
     is distinct from array['purpose', 'identifier_hmac'] then
    raise exception 'Recovery start cooldown is not keyed by purpose and identifier HMAC';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'auth.otp_start_cooldowns'::regclass and contype = 'f') then
    raise exception 'Recovery start cooldown must not reference a challenge or an account';
  end if;
end $$;

set local role hid_identity_api_runtime;
do $$
declare
  marker_hmac constant char(64) := repeat('ab', 32);
  stored_challenge uuid;
begin
  insert into auth.otp_start_cooldowns(purpose, identifier_hmac, challenge_id)
  values ('PASSWORD_RESET', marker_hmac, '96000000-0000-4000-8000-000000000001'),
         ('LEGACY_ACCOUNT_RECOVERY', marker_hmac, '96000000-0000-4000-8000-000000000002');
  insert into auth.otp_start_cooldowns(purpose, identifier_hmac, challenge_id, started_at)
  values ('PASSWORD_RESET', marker_hmac, '96000000-0000-4000-8000-000000000003', clock_timestamp())
  on conflict (purpose, identifier_hmac) do update
    set challenge_id = excluded.challenge_id, started_at = excluded.started_at;
  select challenge_id into stored_challenge from auth.otp_start_cooldowns
   where purpose = 'PASSWORD_RESET' and identifier_hmac = marker_hmac;
  if stored_challenge is distinct from '96000000-0000-4000-8000-000000000003'
     or (select count(*) from auth.otp_start_cooldowns where identifier_hmac = marker_hmac) <> 2
     or exists (select 1 from auth.otp_start_cooldowns where identifier_hmac = marker_hmac and started_at is null) then
    raise exception 'Recovery start cooldown upsert did not replace the one row of its purpose and identifier';
  end if;
  begin
    insert into auth.otp_start_cooldowns(purpose, identifier_hmac, challenge_id)
    values ('PASSWORD_RESET', repeat('AB', 32), '96000000-0000-4000-8000-000000000004');
    raise exception 'Recovery start cooldown accepted an identifier HMAC that is not lower-case hex';
  exception when check_violation then null;
  end;
  begin
    insert into auth.otp_start_cooldowns(purpose, identifier_hmac, challenge_id)
    values ('SIGNUP_VERIFY', repeat('cd', 32), '96000000-0000-4000-8000-000000000004');
    raise exception 'Recovery start cooldown accepted a purpose other than account recovery';
  exception when check_violation then null;
  end;
  begin
    delete from auth.otp_start_cooldowns where identifier_hmac = marker_hmac;
    raise exception 'Identity runtime may delete recovery start cooldowns';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role hid_ehr_api_runtime;
do $$
begin
  begin
    perform 1 from auth.otp_start_cooldowns limit 1;
    raise exception 'EHR runtime can read recovery start cooldowns';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;
