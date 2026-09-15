\set ON_ERROR_STOP on
begin;
set constraints all deferred;

-- Synthetic independent account/patient IDs; no workforce role is assigned
-- to either patient account. Every assertion rolls back with this transaction.
insert into auth.accounts(id,subject,email,display_name,status)
select ('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'synthetic:self:'||n,'self-'||n||'@example.invalid','Synthetic self '||n,'active'
from generate_series(1,3) n;
insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status)
values
 ('a2000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','HID-SELFABC','Self','One','Self One','active'),
 ('a2000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000002','HID-SELFDEF','Self','Two','Self Two','active');
insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,account_token_version,
  authentication_method,issued_at,expires_at,absolute_expires_at,session_kind,patient_id)
select ('a3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('a3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  md5(n::text)||md5(n::text),gen_random_uuid(),1,'password',clock_timestamp(),
  clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours','patient',
  ('a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
from generate_series(1,2)n;

set local role hid_identity_api_runtime;
select set_config('app.actor_subject','synthetic:self:1',true),
  set_config('app.correlation_id','patient-self-integration-0001',true);
do $$
begin
  if (select patient_id from identity.current_patient_account('synthetic:self:1'))
      <> 'a2000000-0000-4000-8000-000000000001'::uuid then raise exception 'canonical association lost'; end if;
  if exists(select 1 from identity.current_patient_account('synthetic:self:3')) then raise exception 'unlinked workforce account became a patient'; end if;
  if identity.patient_self_profile('synthetic:self:1','a3000000-0000-4000-8000-000000000001')->>'hid'
      <> 'HID-SELFABC' then raise exception 'self profile missing'; end if;
  if identity.patient_self_profile('synthetic:self:1','a3000000-0000-4000-8000-000000000002') is not null
    then raise exception 'another patient session was accepted'; end if;
  if identity.patient_self_profile('synthetic:self:2','a3000000-0000-4000-8000-000000000002') is not null
    then raise exception 'request subject substitution was accepted'; end if;
  if identity.authorize_patient_self('synthetic:self:1','a3000000-0000-4000-8000-000000000001') is null
    then raise exception 'current self authorization failed'; end if;
end;
$$;
reset role;
update auth.accounts set disabled_until=clock_timestamp()+interval '1 hour'
  where id='a1000000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
do $$ begin
  if exists(select 1 from identity.current_patient_account('synthetic:self:1'))
    or identity.patient_self_profile('synthetic:self:1','a3000000-0000-4000-8000-000000000001') is not null
    then raise exception 'temporarily disabled patient retained access'; end if;
end $$;
reset role;
update auth.accounts set disabled_until=null where id='a1000000-0000-4000-8000-000000000001';
update auth.sessions set revoked_at=clock_timestamp(),revocation_reason='synthetic-test'
  where id='a3000000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
do $$ begin
  if identity.patient_self_profile('synthetic:self:1','a3000000-0000-4000-8000-000000000001') is not null
    then raise exception 'revoked session retained profile access'; end if;
end $$;
reset role;

-- A new authenticated proof may only follow a current, non-revoked session.
-- Restore this synthetic fixture before testing the separate owning EHR RLS.
update auth.sessions set revoked_at=null,revocation_reason=null
  where id='a3000000-0000-4000-8000-000000000001';
update auth.accounts set token_version=2 where id='a1000000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
do $$ begin
  if identity.authorize_patient_self('synthetic:self:1','a3000000-0000-4000-8000-000000000001') is not null
    then raise exception 'stale account-token version retained authorization'; end if;
end $$;
reset role;
update auth.accounts set token_version=1 where id='a1000000-0000-4000-8000-000000000001';
update auth.accounts set status='pending_reset' where id='a1000000-0000-4000-8000-000000000001';
set local role hid_identity_api_runtime;
do $$ begin
  if exists(select 1 from identity.current_patient_account('synthetic:self:1'))
    or identity.authorize_patient_self('synthetic:self:1','a3000000-0000-4000-8000-000000000001') is not null
    then raise exception 'pending password recovery obtained patient access'; end if;
end $$;
reset role;
update auth.accounts set status='active' where id='a1000000-0000-4000-8000-000000000001';
-- Broad current deny directives block self-record disclosure as well.
savepoint before_self_deny;
insert into identity.consent_directives(id,patient_id,current_version)
values('a9000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001',1);
insert into identity.consent_directive_versions(id,directive_id,patient_id,version_no,status,provision_type,
  grantee_type,actions,starts_at,source_reference,reason,content_sha256)
values('a9000000-0000-4000-8000-000000000002','a9000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',1,'active','deny','all',array['read_records'],
  clock_timestamp()-interval '1 minute','patient-self-test','Synthetic deny test',repeat('c',64));
set local role hid_identity_api_runtime;
do $$ begin
  if identity.authorize_patient_self('synthetic:self:1','a3000000-0000-4000-8000-000000000001') is not null
    then raise exception 'active broad consent deny was bypassed'; end if;
end $$;
rollback to savepoint before_self_deny;

-- Clinical fixture attribution uses a separate real workforce principal.
insert into identity.organizations(id,name,slug)
values('a4000000-0000-4000-8000-000000000001','Self test organization','self-test-organization');
insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
values('a4000000-0000-4000-8000-000000000002','a4000000-0000-4000-8000-000000000001','Self test facility','SELF-A','Africa/Lagos',true,'verified');
insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
values('a5000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000003','Synthetic doctor','doctor-self@example.invalid','verified','doctor');
insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role,is_primary,active)
values('a6000000-0000-4000-8000-000000000001','a5000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000003',
  'a4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000002','doctor','doctor',true,true);
insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
values('aa000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000003','doctor','facility',
  'a6000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000002','Synthetic clinical fixture author');
insert into identity.purpose_of_use_codes(code,display,source_system)
values('direct-care','Direct care','patient-self-test') on conflict(code) do nothing;
insert into identity.access_requests(id,patient_id,staff_id,membership_id,facility_id,scope,purpose_of_use,
  reason,status,requested_duration_minutes,approved_by_patient_id,approved_at)
select ('ab000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a5000000-0000-4000-8000-000000000001',
  'a6000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000002','write_records','direct-care',
  'Synthetic fixture consent','approved',60,('a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,clock_timestamp()
from generate_series(1,2)n;
insert into identity.consent_grants(id,request_id,patient_id,staff_id,account_id,membership_id,facility_id,
  scope,purpose_of_use,status,reason,starts_at,expires_at,break_glass)
select ('ac000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('ab000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a5000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000003','a6000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000002',
  'write_records','direct-care','active','Synthetic fixture consent',clock_timestamp()-interval '1 minute',
  clock_timestamp()+interval '1 hour',false
from generate_series(1,2)n;
select set_config('app.actor_subject','synthetic:self:3',true),
  set_config('app.membership_id','a6000000-0000-4000-8000-000000000001',true),
  set_config('app.facility_id','a4000000-0000-4000-8000-000000000002',true),
  set_config('app.purpose_of_use','direct-care',true);
insert into ehr.encounters(id,patient_id,facility_id,created_by,created_by_membership_id,encounter_type,status,started_at,ended_at)
select ('a7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('a2000000-0000-4000-8000-'||lpad((case when n=3 then 2 else 1 end)::text,12,'0'))::uuid,
 'a4000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000003','a6000000-0000-4000-8000-000000000001',
 'ambulatory',case when n=2 then 'in_progress' else 'completed' end,clock_timestamp()-interval '1 hour',
 case when n=2 then null else clock_timestamp() end
from generate_series(1,3)n;

insert into ehr.clinical_notes(id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,
  note_type,title,status,current_revision_no,signed_at,signed_by)
select ('a8000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('a7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('a2000000-0000-4000-8000-'||lpad((case when n=3 then 2 else 1 end)::text,12,'0'))::uuid,
 'a4000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000003','a6000000-0000-4000-8000-000000000001',
 'progress','Synthetic note',case when n=2 then 'draft' else 'signed' end,1,
 case when n=2 then null else clock_timestamp() end,
 case when n=2 then null else 'a1000000-0000-4000-8000-000000000003'::uuid end
from generate_series(1,3)n;
insert into ehr.clinical_note_revisions(clinical_note_id,patient_id,facility_id,revision_no,content,change_reason,created_by,created_by_membership_id)
select id,patient_id,facility_id,1,'Synthetic clinical content','Synthetic fixture create',created_by,created_by_membership_id
from ehr.clinical_notes where id::text like 'a8000000-%';

set local role hid_ehr_api_runtime;
select set_config('app.actor_subject','synthetic:self:1',true),set_config('app.facility_id','',true),set_config('app.membership_id','',true),
  set_config('app.purpose_of_use','patient-self',true),set_config('app.account_id','a1000000-0000-4000-8000-000000000001',true),
  set_config('app.session_id','a3000000-0000-4000-8000-000000000001',true),
  set_config('app.patient_id','a2000000-0000-4000-8000-000000000001',true),
  set_config('app.self_authorized_until',(clock_timestamp()+interval '30 seconds')::text,true);
do $$ begin
  if (select count(*) from ehr.encounters)<>1 then raise exception 'self encounter RLS leaked wrong-patient or incomplete record'; end if;
  if (select count(*) from ehr.clinical_notes)<>1 then raise exception 'self note RLS leaked draft or another patient'; end if;
  if (select count(*) from ehr.clinical_note_revisions)<>1 then raise exception 'self revision RLS leaked unreleased content'; end if;
  if has_function_privilege(current_user,'identity.patient_self_profile(text,uuid)','EXECUTE') then raise exception 'EHR acquired Identity self lookup authority'; end if;
  begin
    update ehr.encounters set chief_complaint='Forbidden patient edit';
    if found then raise exception 'patient context acquired clinical mutation'; end if;
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('app.self_authorized_until',(clock_timestamp()-interval '1 second')::text,true);
do $$ begin
  if exists(select 1 from ehr.encounters) or exists(select 1 from ehr.clinical_notes)
    then raise exception 'expired self context retained clinical access'; end if;
end $$;
select set_config('app.self_authorized_until','',true);
do $$ begin
  if ehr.patient_self_context('a2000000-0000-4000-8000-000000000001')
    then raise exception 'missing self authorization did not deny'; end if;
end $$;
reset role;
rollback;
