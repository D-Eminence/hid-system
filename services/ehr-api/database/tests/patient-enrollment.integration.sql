\set ON_ERROR_STOP on
begin;

-- Synthetic setup only; commands below execute as the real non-owner Identity
-- role. Keep registration triggers enabled while preparing governed cases.
insert into auth.accounts(id,subject,email,status) values
 ('a2100000-0000-4000-8000-000000000001','staff:synthetic-enrollment','enrollment-approver@example.invalid','active'),
 ('a2100000-0000-4000-8000-000000000002','patient:synthetic-existing','already-owned@example.invalid','active');
insert into identity.organizations(id,name,slug) values
 ('a1100000-0000-4000-8000-000000000001','Synthetic enrollment organization','synthetic-enrollment');
insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
select ('a1100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'a1100000-0000-4000-8000-000000000001','Synthetic enrollment facility '||n,'ENROLL-'||n,'Africa/Lagos',true,'verified'
from generate_series(2,3) n;
insert into identity.staff(id,account_id,full_name,email,verification_status,default_role) values
 ('a3100000-0000-4000-8000-000000000001','a2100000-0000-4000-8000-000000000001',
  'Synthetic approver','enrollment-approver@example.invalid','verified','admin');
insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,
 membership_role,app_role,is_primary,active)
select ('a4100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'a3100000-0000-4000-8000-000000000001','a2100000-0000-4000-8000-000000000001',
 'a1100000-0000-4000-8000-000000000001',
 ('a1100000-0000-4000-8000-'||lpad((n+1)::text,12,'0'))::uuid,'admin','admin',n=1,true
from generate_series(1,2) n;
insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
select ('a6100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'a2100000-0000-4000-8000-000000000001','admin','facility',
 ('a4100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('a1100000-0000-4000-8000-'||lpad((n+1)::text,12,'0'))::uuid,'Synthetic enrollment approval role'
from generate_series(1,2) n;
insert into identity.purpose_of_use_codes(code,display,source_system)
 values('healthcare-operations','Healthcare operations','synthetic') on conflict do nothing;
insert into identity.patients(id,hid_code,first_name,last_name,full_name,status)
select ('a5100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'HID-ENRAAAA'||substr('ABCDEFGHJKLM',n,1),'Synthetic','Enrollment','Synthetic Enrollment '||n,'active'
from generate_series(1,8) n;

select set_config('app.actor_subject','staff:synthetic-enrollment',true);
select set_config('app.correlation_id','synthetic-enrollment-0001',true);
select set_config('app.purpose_of_use','healthcare-operations',true);
do $$
declare n integer; membership uuid; facility uuid; case_id uuid;
begin
 for n in 1..8 loop
  membership := case when n=3 then 'a4100000-0000-4000-8000-000000000002'::uuid
    else 'a4100000-0000-4000-8000-000000000001'::uuid end;
  facility := case when n=3 then 'a1100000-0000-4000-8000-000000000003'::uuid
    else 'a1100000-0000-4000-8000-000000000002'::uuid end;
  case_id := ('a7100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  perform set_config('app.membership_id',membership::text,true);
  perform set_config('app.facility_id',facility::text,true);
  insert into identity.registration_cases(id,facility_id,created_by_account_id,created_by_membership_id,
    status,first_name,last_name,full_name,dob,nin_ciphertext,nin_lookup_hmac,nin_last4,nin_key_version,
    verification_provider,verification_reference,verified_at,idempotency_key,request_sha256)
  values(case_id,facility,'a2100000-0000-4000-8000-000000000001',membership,
    'pending_new_identity_approval','Synthetic','Enrollment','Synthetic Enrollment '||n,date '1991-02-03',
    decode(repeat('ab',32),'hex'),md5(n::text)||md5(n::text),'1234','synthetic',
    'synthetic-provider','synthetic-ref-'||n,clock_timestamp(),'synthetic-enrollment-case-'||n,repeat('b',64));
  if n<>6 then
   insert into identity.patient_identifiers(id,patient_id,identifier_type,value_ciphertext,lookup_hmac,
     encryption_key_version,verified,verified_at,verification_provider,verification_reference,registration_case_id,
     revoked_at,revocation_reason)
   values (('a8100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
     ('a5100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'nin',decode(repeat('ab',32),'hex'),
     case when n=7 then repeat('f',64) else md5(n::text)||md5(n::text) end,
     'synthetic',true,clock_timestamp(),'synthetic-provider','synthetic-ref-'||n,case_id,
     case when n=8 then clock_timestamp() else null end,
     case when n=8 then 'Synthetic revoked NIN' else null end);
  end if;
  if n<>2 then
   update identity.registration_cases set status='approved_new_identity',
     resolved_patient_id=('a5100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
     reviewed_by_account_id='a2100000-0000-4000-8000-000000000001',reviewed_by_membership_id=membership,
     review_reason='Synthetic approval fixture',review_idempotency_key='synthetic-enrollment-review-'||n,
     review_request_sha256=repeat('c',64),row_version=2,updated_at=clock_timestamp()
   where id=case_id;
  end if;
 end loop;
 perform set_config('app.membership_id','a4100000-0000-4000-8000-000000000001',true);
 perform set_config('app.facility_id','a1100000-0000-4000-8000-000000000002',true);
end $$;

set local role hid_identity_api_runtime;
do $$
declare created record; replay record; n integer;
begin
 if has_table_privilege(current_user,'auth.accounts','INSERT')
    or has_table_privilege(current_user,'auth.accounts','UPDATE')
    or has_table_privilege(current_user,'identity.patients','UPDATE')
    or has_table_privilege(current_user,'identity.patient_enrollments','INSERT')
    or has_function_privilege('hid_ehr_api_runtime',
      'identity.enroll_registered_patient(uuid,bigint,text,text,text,character)','EXECUTE') then
   raise exception 'Enrollment broadened runtime authority';
 end if;
 begin
  perform identity.enroll_registered_patient('a7100000-0000-4000-8000-000000000002',1,
    'pending@example.invalid','Synthetic approval reason','synthetic-pending-key',repeat('d',64)::char(64));
  raise exception 'Unresolved case enrolled';
 exception when check_violation then null; end;
 begin
  perform identity.enroll_registered_patient('a7100000-0000-4000-8000-000000000003',2,
    'foreign@example.invalid','Synthetic approval reason','synthetic-foreign-key',repeat('d',64)::char(64));
  raise exception 'Foreign facility case enrolled';
 exception when no_data_found then null; end;
 begin
  perform identity.enroll_registered_patient('a7100000-0000-4000-8000-000000000001',1,
    'new-patient@example.invalid','Synthetic approval reason','synthetic-positive-key',repeat('d',64)::char(64));
  raise exception 'Stale case version enrolled';
 exception when serialization_failure then null; end;
 begin
  perform identity.enroll_registered_patient('a7100000-0000-4000-8000-000000000005',2,
    'ALREADY-OWNED@example.invalid','Synthetic approval reason','synthetic-existing-key',repeat('d',64)::char(64));
  raise exception 'Existing email account was linked by assertion';
 exception when unique_violation then null; end;
 for n in 6..8 loop
  begin
   perform identity.enroll_registered_patient(('a7100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,2,
     'unverified-'||n||'@example.invalid','Synthetic approval reason','synthetic-unverified-key-'||n,repeat('d',64)::char(64));
   raise exception 'Missing/mismatched/revoked canonical NIN authorized enrollment';
  exception when check_violation then null; end;
 end loop;
 perform set_config('app.purpose_of_use','direct-care',true);
 begin
  perform identity.enroll_registered_patient('a7100000-0000-4000-8000-000000000001',2,
    'new-patient@example.invalid','Synthetic approval reason','synthetic-positive-key',repeat('d',64)::char(64));
  raise exception 'Wrong purpose authorized enrollment';
 exception when insufficient_privilege then null; end;
 perform set_config('app.purpose_of_use','healthcare-operations',true);
 select * into created from identity.enroll_registered_patient('a7100000-0000-4000-8000-000000000001',2,
   'new-patient@example.invalid','Synthetic approval reason','synthetic-positive-key',repeat('d',64)::char(64));
 select * into replay from identity.enroll_registered_patient('a7100000-0000-4000-8000-000000000001',2,
   'new-patient@example.invalid','Synthetic approval reason','synthetic-positive-key',repeat('d',64)::char(64));
 if created.replayed or not replay.replayed or created.account_id<>replay.account_id
    or created.patient_id<>'a5100000-0000-4000-8000-000000000001'::uuid then
  raise exception 'Enrollment success/replay contract failed';
 end if;
 begin
  perform identity.enroll_registered_patient('a7100000-0000-4000-8000-000000000001',2,
    'attacker@example.invalid','Synthetic approval reason','synthetic-positive-key',repeat('e',64)::char(64));
  raise exception 'Changed replay request accepted';
 exception when unique_violation then null; end;
 begin
  update identity.patients set account_id='a2100000-0000-4000-8000-000000000002'
    where id='a5100000-0000-4000-8000-000000000005';
  raise exception 'Identity runtime directly relinked a patient';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$
begin
 if (select count(*) from identity.patient_enrollments)<>1
    or not exists(select 1 from identity.patients p join auth.accounts a on a.id=p.account_id
      where p.id='a5100000-0000-4000-8000-000000000001' and p.row_version=2
        and a.status='pending_reset' and a.password_hash is null and a.token_version=1)
    or (select count(*) from audit.events where correlation_id='synthetic-enrollment-0001'
      and action in ('identity.patient.enroll','identity.patient.enroll.replay'))<>2
    or not exists(select 1 from identity.patient_assurance_states
      where patient_id='a5100000-0000-4000-8000-000000000001' and state='NIN_VERIFIED'
        and nin_verified_at is not null and verified_provider='synthetic-provider'
        and contact_verified_at is null) then
  raise exception 'Enrollment mapping/credential/audit transaction is incomplete';
 end if;
end $$;

-- Verified contact establishes credentials without discarding governed NIN.
insert into auth.otp_challenges(id,account_id,recipient_hmac,purpose,channel,verifier_hmac,
 verifier_key_version,expires_at,max_attempts,verified_at,completion_token_hmac,
 completion_expires_at,account_token_version)
select 'a9100000-0000-4000-8000-000000000001',account_id,repeat('a',64),'LEGACY_ACCOUNT_RECOVERY',
 'email',repeat('b',64),'synthetic',clock_timestamp()+interval '5 minutes',5,clock_timestamp(),
 repeat('c',64),clock_timestamp()+interval '5 minutes',1 from identity.patient_enrollments
where case_id='a7100000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
select set_config('app.actor_subject','system:auth',true);
do $$ begin
 if not auth.complete_recovery_otp('a9100000-0000-4000-8000-000000000001','LEGACY_ACCOUNT_RECOVERY',repeat('c',64),
   '$argon2id$v=19$m=65536,t=3,p=1$synthetic-salt$synthetic-password-digest-not-an-operational-secret') then
  raise exception 'Governed enrollment contact completion failed';
 end if;
end $$;
reset role;
select set_config('app.actor_subject','staff:synthetic-enrollment',true);
do $$ begin
 if not exists(select 1 from identity.patient_assurance_states assurance
   join auth.accounts account_row on account_row.id=assurance.account_id
   where assurance.patient_id='a5100000-0000-4000-8000-000000000001'
     and assurance.state='NIN_VERIFIED' and assurance.nin_verified_at is not null
     and assurance.verified_provider='synthetic-provider' and assurance.contact_verified_at is not null
     and account_row.status='active' and account_row.token_version=2) then
  raise exception 'Contact completion lost NIN assurance or failed to establish account';
 end if;
end $$;

-- A fresh resolution of an existing verified identifier keeps its original
-- registration provenance; it must not require a duplicate canonical binding.
insert into identity.registration_cases(id,facility_id,created_by_account_id,created_by_membership_id,
 status,first_name,last_name,full_name,dob,nin_ciphertext,nin_lookup_hmac,nin_last4,nin_key_version,
 verification_provider,verification_reference,verified_at,idempotency_key,request_sha256,resolved_patient_id)
values ('a7100000-0000-4000-8000-000000000009','a1100000-0000-4000-8000-000000000002',
 'a2100000-0000-4000-8000-000000000001','a4100000-0000-4000-8000-000000000001',
 'resolved_existing_identity','Synthetic','Enrollment','Synthetic Enrollment 5',date '1991-02-03',
 decode(repeat('ab',32),'hex'),md5('5')||md5('5'),'1234','synthetic',
 'synthetic-provider','synthetic-current-resolution',clock_timestamp(),'synthetic-new-resolution-key',repeat('a',64),
 'a5100000-0000-4000-8000-000000000005');
set local role hid_identity_api_runtime;
do $$ declare enrolled record;
begin
 select * into enrolled from identity.enroll_registered_patient('a7100000-0000-4000-8000-000000000009',1,
  'resolved-existing@example.invalid','Synthetic current resolution','synthetic-resolved-existing-key',repeat('a',64)::char(64));
 if enrolled.patient_id<>'a5100000-0000-4000-8000-000000000005'::uuid or enrolled.replayed then
  raise exception 'Existing verified NIN resolution lost canonical identity';
 end if;
end $$;
reset role;
do $$ begin
 if not exists(select 1 from identity.patient_assurance_states where patient_id='a5100000-0000-4000-8000-000000000005'
   and state='NIN_VERIFIED' and source_reference='a7100000-0000-4000-8000-000000000009')
   or (select registration_case_id from identity.patient_identifiers where id='a8100000-0000-4000-8000-000000000005')
      <>'a7100000-0000-4000-8000-000000000005'::uuid then
  raise exception 'Existing NIN resolution rewrote identifier provenance or omitted assurance';
 end if;
end $$;

-- Revoked approvers and failed primary audit writes must never create accounts.
update auth.account_roles set revoked_at=clock_timestamp(),revoked_by='a2100000-0000-4000-8000-000000000001',
 revocation_reason='Synthetic revoked approver' where id='a6100000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
do $$ begin
 begin
  perform identity.enroll_registered_patient('a7100000-0000-4000-8000-000000000004',2,
   'audit-failure@example.invalid','Synthetic approval reason','synthetic-audit-key',repeat('f',64)::char(64));
  raise exception 'Revoked approver enrolled patient';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
update auth.account_roles set revoked_at=null,revoked_by=null,revocation_reason=null
 where id='a6100000-0000-4000-8000-000000000001';
create function pg_temp.reject_enrollment_audit() returns trigger language plpgsql as $$
begin
 if new.action='identity.patient.enroll' then
  raise exception using errcode='P0997',message='Synthetic primary audit failure';
 end if;
 return new;
end $$;
create trigger synthetic_enrollment_audit_failure before insert on audit.events
 for each row execute function pg_temp.reject_enrollment_audit();
set local role hid_identity_api_runtime;
do $$ begin
 begin
  perform identity.enroll_registered_patient('a7100000-0000-4000-8000-000000000004',2,
   'audit-failure@example.invalid','Synthetic approval reason','synthetic-audit-key',repeat('f',64)::char(64));
  raise exception 'Enrollment ignored audit failure';
 exception when sqlstate 'P0997' then null; end;
end $$;
reset role;
do $$ begin
 if exists(select 1 from auth.accounts where email='audit-failure@example.invalid')
   or exists(select 1 from identity.patient_enrollments where case_id='a7100000-0000-4000-8000-000000000004')
   or exists(select 1 from identity.patient_assurance_states where patient_id='a5100000-0000-4000-8000-000000000004')
   or (select account_id is not null from identity.patients where id='a5100000-0000-4000-8000-000000000004') then
  raise exception 'Audit failure did not roll back enrollment account and mapping';
 end if;
end $$;
rollback;
