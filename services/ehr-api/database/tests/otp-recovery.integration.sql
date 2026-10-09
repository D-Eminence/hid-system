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
end $$;
rollback;
