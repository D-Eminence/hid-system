\set ON_ERROR_STOP on
-- All principals, requests, grants, and audit rows are synthetic and rolled back.
begin;
set constraints all deferred;

do $$ begin
  if not has_function_privilege('hid_identity_api_runtime',
      'identity.list_my_staff_access_requests(text)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime',
      'identity.list_my_access_request_context()', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime',
      'identity.approve_access_request(uuid)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime',
      'identity.deny_access_request(uuid,text)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime',
      'identity.revoke_my_consent_grant(uuid,text)', 'EXECUTE')
     or not has_function_privilege('hid_identity_api_runtime',
      'identity.patient_self_session(text,uuid)', 'EXECUTE') then
    raise exception 'Identity runtime lacks governed patient consent commands';
  end if;
  if has_function_privilege('hid_ehr_api_runtime',
      'identity.revoke_my_consent_grant(uuid,text)', 'EXECUTE') then
    raise exception 'EHR runtime can mutate Identity consent';
  end if;
end $$;

insert into auth.accounts(id,subject,email,display_name,status) values
 ('b1000000-0000-4000-8000-000000000001','staff:consent-test','consent-staff@test.invalid','Consent Clinician','active'),
 ('b1000000-0000-4000-8000-000000000002','patient:consent-one','consent-one@test.invalid','Consent Patient One','active'),
 ('b1000000-0000-4000-8000-000000000003','patient:consent-two','consent-two@test.invalid','Consent Patient Two','active');
insert into identity.organizations(id,name,slug) values
 ('b2000000-0000-4000-8000-000000000001','Consent Organization A','consent-organization-a'),
 ('b2000000-0000-4000-8000-000000000002','Consent Organization B','consent-organization-b');
insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status) values
 ('b3000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001',
  'Consent Facility A','CONSENT-A','Africa/Lagos',true,'verified'),
 ('b3000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000002',
  'Consent Facility B','CONSENT-B','Africa/Lagos',true,'verified');
insert into identity.staff(id,account_id,full_name,email,verification_status,default_role) values
 ('b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',
  'Consent Clinician','consent-staff@test.invalid','verified','doctor');
insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,
  membership_role,app_role,is_primary,active) values
 ('b5000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001',
  'b3000000-0000-4000-8000-000000000001','doctor','doctor',true,true),
 ('b5000000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000002',
  'b3000000-0000-4000-8000-000000000002','doctor','doctor',false,true);
insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason) values
 ('b6000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',
  'doctor','facility','b5000000-0000-4000-8000-000000000001',
  'b3000000-0000-4000-8000-000000000001','Synthetic consent role'),
 ('b6000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000001',
  'doctor','facility','b5000000-0000-4000-8000-000000000002',
  'b3000000-0000-4000-8000-000000000002','Synthetic second organization role');
insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status) values
 ('b7000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002',
  'HID-CNSNTABC','Consent','One','Consent One','active'),
 ('b7000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000003',
  'HID-CNSNTDEF','Consent','Two','Consent Two','active');
insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,account_token_version,
  authentication_method,issued_at,expires_at,absolute_expires_at,session_kind,patient_id)
select ('b8000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('b1000000-0000-4000-8000-'||lpad((n+1)::text,12,'0'))::uuid,
  ('b8000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  md5(n::text)||md5(n::text),gen_random_uuid(),1,'password',clock_timestamp(),
  clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours','patient',
  ('b7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
from generate_series(1,2)n;
insert into identity.purpose_of_use_codes(code,display,source_system) values
 ('direct-care','Direct care','consent-test'),
 ('emergency','Emergency treatment','consent-test'),
 ('healthcare-operations','Healthcare operations','consent-test');

set local role hid_identity_api_runtime;
select set_config('app.actor_subject','staff:consent-test',true),
  set_config('app.membership_id','b5000000-0000-4000-8000-000000000001',true),
  set_config('app.facility_id','b3000000-0000-4000-8000-000000000001',true),
  set_config('app.correlation_id','patient-consent-integration-0001',true),
  set_config('app.purpose_of_use','direct-care',true);

do $$ declare request_read record; request_write record; approved record;
  request_context record; denied record; closed record;
begin
  select * into request_read from identity.create_access_request(
    'HID-CNSNTABC','read_records','Continuity of care consent request',30);
  select * into request_write from identity.create_access_request(
    'HID-CNSNTABC','write_records','Treatment documentation consent request',30);
  if request_read.request_status <> 'pending' or request_write.request_status <> 'pending'
     or request_read.access_request_id = request_write.access_request_id then
    raise exception 'Valid access requests were not created independently';
  end if;
  if (select count(*) from identity.list_my_staff_access_requests('pending')) <> 2 then
    raise exception 'Exact staff request list is unavailable';
  end if;
  perform set_config('app.membership_id','b5000000-0000-4000-8000-000000000002',true);
  perform set_config('app.facility_id','b3000000-0000-4000-8000-000000000002',true);
  if (select count(*) from identity.list_my_staff_access_requests(null)) <> 0 then
    raise exception 'Staff request list crossed organization boundary';
  end if;

  perform set_config('app.actor_subject','patient:consent-two',true);
  perform set_config('app.membership_id','',true);
  perform set_config('app.facility_id','',true);
  if identity.patient_self_session('patient:consent-two',
      'b8000000-0000-4000-8000-000000000001') is not null then
    raise exception 'Wrong patient session was accepted';
  end if;
  begin
    perform identity.approve_access_request(request_read.access_request_id);
    raise exception 'Wrong patient approved an access request';
  exception when sqlstate 'P0002' then null; end;
  begin
    perform identity.deny_access_request(request_write.access_request_id,'Wrong patient denial');
    raise exception 'Wrong patient denied an access request';
  exception when sqlstate 'P0002' then null; end;

  perform set_config('app.actor_subject','patient:consent-one',true);
  if identity.patient_self_session('patient:consent-one',
      'b8000000-0000-4000-8000-000000000001')
      <> 'b7000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'Verified patient session was not resolved';
  end if;
  select * into request_context from identity.list_my_access_request_context()
    where access_request_id = request_read.access_request_id;
  if request_context.patient_id <> 'b7000000-0000-4000-8000-000000000001'::uuid
     or request_context.organization_id <> 'b2000000-0000-4000-8000-000000000001'::uuid
     or request_context.facility_id <> 'b3000000-0000-4000-8000-000000000001'::uuid
     or request_context.staff_id <> 'b4000000-0000-4000-8000-000000000001'::uuid
     or request_context.staff_name <> 'Consent Clinician'
     or request_context.purpose_of_use <> 'direct-care'
     or request_context.scope <> 'read_records'
     or request_context.status <> 'pending' then
    raise exception 'Patient request context omitted the exact requester or scope';
  end if;
  select * into approved from identity.approve_access_request(request_read.access_request_id);
  if approved.status <> 'approved' or approved.consent_grant_id is null
     or approved.expires_at <= clock_timestamp() then
    raise exception 'Patient approval failed to create a current grant';
  end if;
  if not identity.has_active_consent_grant(
      'b7000000-0000-4000-8000-000000000001','staff:consent-test',
      'b5000000-0000-4000-8000-000000000001',
      'b3000000-0000-4000-8000-000000000001','read_records','direct-care',clock_timestamp())
     or identity.has_active_consent_grant(
      'b7000000-0000-4000-8000-000000000001','staff:consent-test',
      'b5000000-0000-4000-8000-000000000002',
      'b3000000-0000-4000-8000-000000000002','read_records','direct-care',clock_timestamp())
     or identity.has_active_consent_grant(
      'b7000000-0000-4000-8000-000000000001','staff:consent-test',
      'b5000000-0000-4000-8000-000000000001',
      'b3000000-0000-4000-8000-000000000001','read_records','direct-care',clock_timestamp()+interval '31 minutes') then
    raise exception 'Grant authorization crossed patient, organization or expiry bounds';
  end if;
  select * into denied from identity.deny_access_request(request_write.access_request_id,
    'The patient declined write access');
  if denied.status <> 'denied' then raise exception 'Patient denial failed'; end if;
  begin
    perform identity.revoke_my_consent_grant('b9000000-0000-4000-8000-000000000001',
      'Invalid unrelated grant');
    raise exception 'Wrong grant was revoked';
  exception when sqlstate 'P0002' then null; end;
  select * into closed from identity.revoke_my_consent_grant(
    approved.consent_grant_id,'The patient ended this access');
  if closed.grant_status <> 'revoked' or closed.already_closed then
    raise exception 'Patient revocation did not close the grant';
  end if;
  select * into closed from identity.revoke_my_consent_grant(
    approved.consent_grant_id,'The patient ended this access');
  if not closed.already_closed then raise exception 'Revocation replay was not idempotent'; end if;
  if identity.has_active_consent_grant(
      'b7000000-0000-4000-8000-000000000001','staff:consent-test',
      'b5000000-0000-4000-8000-000000000001',
      'b3000000-0000-4000-8000-000000000001','read_records','direct-care',clock_timestamp()) then
    raise exception 'Revoked grant still authorized records';
  end if;
  if (select status from identity.list_my_access_request_context()
      where access_request_id=request_read.access_request_id) <> 'revoked' then
    raise exception 'Patient request context did not reflect revocation';
  end if;
  if identity.patient_self_access_history('patient:consent-one',
      'b8000000-0000-4000-8000-000000000001')->'items'->0->>'status' <> 'revoked' then
    raise exception 'Patient grant history did not reflect revocation';
  end if;
end $$;
reset role;

do $$ begin
  if not exists(select 1 from identity.consent_grants
      where patient_id='b7000000-0000-4000-8000-000000000001'
        and purpose_of_use='direct-care' and status='revoked'
        and granted_by_patient_id=patient_id and revoked_by='b1000000-0000-4000-8000-000000000002') then
    raise exception 'Approval or revocation lost exact patient ownership and purpose';
  end if;
  if (select count(*) from audit.events where patient_id='b7000000-0000-4000-8000-000000000001'
      and action in ('identity.access-request.create','identity.access-request.approve',
        'identity.access-request.deny','identity.patient.consent-grant.revoke')) <> 5 then
    raise exception 'Consent command audit evidence is incomplete';
  end if;
end $$;
rollback;
