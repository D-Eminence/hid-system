\set ON_ERROR_STOP on
-- Privileges, row security and audit hygiene of 0086 section 5 (P4b) and the
-- applicant's withdrawal (R18). Rollback-only.
--
--   1. EXECUTE exactly as 0086 and runtime-grants.sql grant it: the staff,
--      invitee and signed-in commands and the withdrawal to the Identity
--      runtimes and the schema test runtime; the state read and support's
--      commands to the Identity runtimes only; every helper and trigger
--      function to no role; nothing to PUBLIC; no other runtime;
--   2. every command is SECURITY DEFINER with a pinned search_path; the
--      owner-only helpers are not;
--   3. no runtime role holds any privilege on a P4b table; every P4b table
--      has uuid keys only (no sequence), forced row-level security and four
--      permissive policies, so its no-mutation trigger fires for every role,
--      also as the table owner (the NOSUPERUSER NOBYPASSRLS owner under the
--      rehearsal's owner swap);
--   4. the triggers are enabled ('O');
--   5. after a run of every command, no audit row's details or reason holds
--      a synthetic email, name, licence number, token or code; no row with a
--      facility carries an account case; open's details are {invitationId};
--      support's two staff reads refuse an administrator without
--      platform.principal.read (42501 ADMIN_PERMISSION_DENIED).
begin;

do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;

-- 1 and 2. Functions.
do $$
declare
  signature text;
  runtime_role text;
  everyone constant text[] := array['hid_identity_runtime', 'hid_identity_api_runtime', 'hid_schema_test_runtime',
    'hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_api_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_api_runtime',
    'hid_outreach_api_runtime', 'hid_ocr_api_runtime', 'hid_notification_api_runtime', 'hid_audit_writer'];
  staff_and_public constant text[] := array[
    'identity.withdraw_self_service_provider_enrollment(char)',
    'identity.record_self_service_administrator_licence(text,text)',
    'identity.list_facility_staff()',
    'identity.list_facility_staff_invitations()',
    'identity.facility_staff_management_state()',
    'identity.create_staff_invitation(uuid,uuid,text,text,text,text,text,text,text,char,char,char,text)',
    'identity.record_staff_invitation_delivery(uuid,text)',
    'identity.resend_staff_invitation(uuid,bigint,uuid,char,char,text)',
    'identity.revoke_staff_invitation(uuid,bigint)',
    'identity.end_facility_staff_membership(uuid,bigint,text)',
    'identity.change_facility_staff_role(uuid,bigint,text,text,text,text,text)',
    'identity.open_staff_invitation(uuid,char,text,char,char)',
    'identity.prepare_staff_invitation_acceptance(char)',
    'identity.accept_staff_invitation_with_password(char,text)',
    'identity.preview_staff_invitation_for_account(uuid,char,char)',
    'identity.accept_staff_invitation_for_account(uuid,char,char)'];
  identity_only constant text[] := array[
    'identity.organization_self_service_state(uuid)',
    'identity.admin_list_self_service_facilities(text)',
    'identity.admin_review_self_service_facility(uuid,bigint,text,text,text,text,text)',
    'identity.admin_release_self_service_facility(uuid,bigint,text,boolean)',
    'identity.admin_list_facility_staff(uuid)',
    'identity.admin_set_self_service_administrator_role(uuid,bigint,text,text,text,text,text)',
    'identity.admin_end_self_service_probation(uuid,bigint,text)',
    'identity.admin_find_staff_invitations(text)'];
  owner_only constant text[] := array[
    'identity.self_service_reviewable_roles(text,text)', 'identity.self_service_administrator_role(text,text)',
    'identity.staff_invitable_roles(text,text)', 'identity.staff_role_licence_body(text)',
    'identity.normalize_licence_number(text)', 'identity.licence_number_valid(text)',
    'identity.licence_number_hint(text)', 'identity.staff_licence_key(text,text)',
    'identity.staff_invitation_limits(boolean)', 'identity.facility_self_service_state(uuid)',
    'identity.lock_self_service_application(uuid)',
    'identity.self_service_review_state(identity.organization_applications)',
    'identity.self_service_on_probation(uuid)', 'identity.enforce_review_before_facility_role()',
    'identity.enforce_self_service_break_glass_probation()', 'identity.guard_staff_invitation_mutation()',
    'identity.guard_staff_invitation_send_mutation()', 'identity.staff_management_actor(boolean)',
    'identity.staff_invitation_account_case(text,uuid)',
    'identity.staff_invitation_still_valid(identity.staff_invitations)',
    'identity.attach_invited_member(identity.staff_invitations,uuid,uuid,boolean)',
    'identity.staff_invitation_fields_valid(text,text,text,text,text,text)',
    'identity.match_staff_invitation(uuid,char,text,char)', 'identity.end_staff_invitation_session(uuid,boolean)',
    'identity.lock_staff_invitation_acceptance(identity.staff_invitations)',
    'identity.staff_invitation_account_actor()',
    'identity.signed_in_staff_invitation(uuid,text,uuid,char,char,boolean)',
    'identity.self_service_unlock_actor()',
    'identity.self_service_review_licence(identity.organization_applications,text,text,text)',
    'identity.lock_self_service_administrator(identity.organization_applications,text)',
    'identity.grant_self_service_administrator_role(identity.organization_applications,identity.staff_facility_memberships,text,text,text,uuid,text)',
    'identity.activate_self_service_organization_application(char,text)',
    'identity.lapse_stale_self_service_organization_application(text,text,text)',
    'identity.issue_organization_profile_completion_code(text,text,text,uuid,char,text)'];
begin
  foreach signature in array staff_and_public || identity_only || owner_only loop
    if exists (select 1 from pg_proc proc,
                 lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                where proc.oid = signature::regprocedure and acl.grantee = 0) then
      raise exception 'PUBLIC can execute %', signature;
    end if;
    foreach runtime_role in array everyone loop
      if has_function_privilege(runtime_role, signature, 'EXECUTE') <> (
           (signature = any(staff_and_public)
             and runtime_role in ('hid_identity_runtime', 'hid_identity_api_runtime', 'hid_schema_test_runtime'))
           or (signature = any(identity_only) and runtime_role in ('hid_identity_runtime', 'hid_identity_api_runtime'))) then
        raise exception '% has the wrong EXECUTE on %', runtime_role, signature;
      end if;
    end loop;
  end loop;
  -- The old review signature is gone.
  if to_regprocedure('identity.admin_review_self_service_facility(uuid,bigint,text)') is not null then
    raise exception 'The three-argument review command still exists';
  end if;
  -- Every command: SECURITY DEFINER with a pinned search_path; the helpers
  -- are not definers except the gate's trigger functions and the state read.
  foreach signature in array staff_and_public || identity_only loop
    if not (select proc.prosecdef and exists (select 1 from unnest(proc.proconfig) setting where setting like 'search_path=%')
              from pg_proc proc where proc.oid = signature::regprocedure) then
      raise exception '% is not a definer with a pinned search_path', signature;
    end if;
  end loop;
  foreach signature in array owner_only loop
    if not exists (select 1 from pg_proc proc, unnest(proc.proconfig) setting
                    where proc.oid = signature::regprocedure and setting like 'search_path=%') then
      raise exception '% has no pinned search_path', signature;
    end if;
    if (select proc.prosecdef from pg_proc proc where proc.oid = signature::regprocedure)
       <> (signature in ('identity.enforce_review_before_facility_role()',
             'identity.enforce_self_service_break_glass_probation()',
             'identity.activate_self_service_organization_application(char,text)')) then
      raise exception '% has the wrong security', signature;
    end if;
  end loop;
end $$;

-- 3. Tables.
do $$
declare
  table_name text;
  runtime_role text;
  privilege text;
begin
  foreach table_name in array array['identity.staff_invitations', 'identity.staff_invitation_sends',
      'identity.staff_licence_attestations', 'identity.staff_attestation_texts'] loop
    foreach runtime_role in array array['hid_identity_runtime', 'hid_identity_api_runtime', 'hid_schema_test_runtime',
        'hid_ehr_runtime', 'hid_api_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_api_runtime',
        'hid_outreach_api_runtime', 'hid_ocr_api_runtime', 'hid_notification_api_runtime', 'hid_audit_writer'] loop
      foreach privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(runtime_role, table_name, privilege) then
          raise exception '% holds % on %', runtime_role, privilege, table_name;
        end if;
      end loop;
    end loop;
    if not (select relation.relrowsecurity and relation.relforcerowsecurity from pg_class relation
             where relation.oid = table_name::regclass) then
      raise exception '% does not force row-level security', table_name;
    end if;
    if (select array_agg(policy.cmd order by policy.cmd) from pg_policies policy
         where policy.schemaname || '.' || policy.tablename = table_name and policy.permissive = 'PERMISSIVE')
       is distinct from array['DELETE', 'INSERT', 'SELECT', 'UPDATE'] then
      raise exception '% does not have its four policies', table_name;
    end if;
    if exists (select 1 from pg_depend dependency join pg_class sequence_row on sequence_row.oid = dependency.objid
                where dependency.refobjid = table_name::regclass and sequence_row.relkind = 'S') then
      raise exception '% owns a sequence', table_name;
    end if;
    if exists (select 1 from pg_attribute attribute where attribute.attrelid = table_name::regclass
                and attribute.attidentity <> '') then
      raise exception '% has an identity column', table_name;
    end if;
  end loop;
end $$;

-- 4. The triggers.
do $$ begin
  if (select array_agg(trigger_row.tgname::text || ':' || trigger_row.tgenabled::text order by trigger_row.tgname)
        from pg_trigger trigger_row
       where trigger_row.tgname in ('account_roles_review_gate', 'consent_grants_self_service_probation',
         'staff_invitations_immutable', 'staff_invitation_sends_outcome_only', 'staff_licence_attestations_no_mutation',
         'staff_attestation_texts_no_mutation') and not trigger_row.tgisinternal)
     is distinct from array['account_roles_review_gate:O', 'consent_grants_self_service_probation:O',
       'staff_attestation_texts_no_mutation:O', 'staff_invitation_sends_outcome_only:O',
       'staff_invitations_immutable:O', 'staff_licence_attestations_no_mutation:O'] then
    raise exception 'A P4b trigger is missing or not enabled';
  end if;
end $$;

-- 5. A run of every command with synthetic values, then the audit scan.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('d6000000-0000-4000-8000-000000000001', 'synthetic:privileges:super', 'super@privileges.invalid', 'Privileges Super', 'active'),
  ('d6000000-0000-4000-8000-000000000002', 'synthetic:privileges:auditor', 'auditor@privileges.invalid',
   'Privileges Auditor', 'active'),
  ('d6000000-0000-4000-8000-000000000003', 'synthetic:privileges:support', 'support@privileges.invalid',
   'Privileges Support', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('d6010000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 'platform_super_admin', 'platform',
   'Privileges suite super admin'),
  ('d6010000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000002', 'security_auditor', 'platform',
   'Privileges suite auditor: admin access without platform.principal.read'),
  ('d6010000-0000-4000-8000-000000000003', 'd6000000-0000-4000-8000-000000000003', 'support_admin', 'platform',
   'Privileges suite support: platform.principal.read');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('d6060000-0000-4000-8000-000000000001', 'HID-PRVPATAB', 'Privileges', 'Patient', 'Privileges Patient', 'active');
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'synthetic:privileges:super', true),
  set_config('app.correlation_id', 'privileges-open-controls', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true),
  set_config('app.facility_id', '', true),
  set_config('app.membership_id', '', true);
select platform.admin_set_control('provider_self_service_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'provider_self_service_enabled'), 'Privileges suite opens facility sign-up');
select platform.admin_set_control('staff_invitations_enabled', true,
  (select control.row_version from platform.admin_list_controls() control
    where control.control_key = 'staff_invitations_enabled'), 'Privileges suite opens staff invitations');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.correlation_id', 'privileges-signup-0001', true),
  set_config('app.purpose_of_use', '', true);
do $$
declare application_id uuid; current_application record; activated record;
begin
  application_id := identity.submit_self_service_organization_application('ehr', 'hospital', 'RC9960006001',
    'Zainab Privacy Admin', 'zainab@privacy-hospital.invalid', repeat('d', 64));
  select * into current_application from identity.public_get_organization_application('RC9960006001',
    'zainab@privacy-hospital.invalid', 'ehr');
  perform identity.public_record_organization_cac_result(application_id, current_application.row_version, 'verified',
    '99601', 'RC9960006001', 'Zainab Privacy Hospital Ltd', 'Private Company Limited by Shares', '2016-01-01',
    '1 Privacy Road, Lagos', 'active');
  perform identity.begin_self_service_provider_enrollment('RC9960006001', 'zainab@privacy-hospital.invalid', 'ehr',
    'd6900000-0000-4000-8000-000000000001', encode(sha256('privacy-otp-1'::bytea), 'hex'), 'Zainab Privacy Admin', 'hospital');
  perform identity.verify_organization_profile_completion_challenge('d6900000-0000-4000-8000-000000000001',
    encode(sha256('privacy-otp-1'::bytea), 'hex'), encode(sha256('privacy-session-1'::bytea), 'hex'));
  select * into activated from identity.activate_self_service_provider_enrollment(encode(sha256('privacy-session-1'::bytea), 'hex'),
    '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('a', 22) || '$' || repeat('b', 43));
  perform set_config('hid.test.p_app', application_id::text, true);
  perform set_config('hid.test.p_account', activated.account_id::text, true);
  perform set_config('hid.test.p_facility', activated.facility_id::text, true);
  -- A second application, withdrawn by its applicant (R18).
  application_id := identity.submit_self_service_organization_application('laboratory', 'laboratory', 'RC9960006002',
    'Wale Withdrawer', 'wale@privacy-withdraw.invalid', repeat('e', 64));
  select * into current_application from identity.public_get_organization_application('RC9960006002',
    'wale@privacy-withdraw.invalid', 'laboratory');
  perform identity.public_record_organization_cac_result(application_id, current_application.row_version, 'verified',
    '99602', 'RC9960006002', 'Somebody Else Laboratory Ltd', 'Private Company Limited by Shares', '2016-02-02',
    '2 Privacy Road, Lagos', 'active');
  perform identity.begin_self_service_provider_enrollment('RC9960006002', 'wale@privacy-withdraw.invalid', 'laboratory',
    'd6900000-0000-4000-8000-000000000002', encode(sha256('privacy-otp-2'::bytea), 'hex'), 'Wale Withdrawer', 'laboratory');
  perform identity.verify_organization_profile_completion_challenge('d6900000-0000-4000-8000-000000000002',
    encode(sha256('privacy-otp-2'::bytea), 'hex'), encode(sha256('privacy-session-2'::bytea), 'hex'));
  if identity.withdraw_self_service_provider_enrollment(encode(sha256('privacy-session-2'::bytea), 'hex')) <> 'withdrawn' then
    raise exception 'The withdrawal did not withdraw';
  end if;
end $$;
reset role;
select set_config('hid.test.p_membership', (select id::text from identity.staff_facility_memberships
  where account_id = current_setting('hid.test.p_account')::uuid), true);
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.p_account'), true),
  set_config('app.membership_id', current_setting('hid.test.p_membership'), true),
  set_config('app.facility_id', current_setting('hid.test.p_facility'), true),
  set_config('app.correlation_id', 'privileges-licence', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select * from identity.record_self_service_administrator_licence('MDCN', 'MDCN/93 761');
select set_config('app.actor_subject', 'synthetic:privileges:super', true),
  set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
  set_config('app.correlation_id', 'privileges-review', true);
select granted_role from identity.admin_review_self_service_facility(current_setting('hid.test.p_app')::uuid,
  (select item.row_version from identity.admin_list_self_service_facilities('all') item
    where item.application_id = current_setting('hid.test.p_app')::uuid),
  'Checked the company and its administrator', 'doctor', 'regulator_register', 'MDCN', 'MDCN/93 761');
select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.p_account'), true),
  set_config('app.membership_id', current_setting('hid.test.p_membership'), true),
  set_config('app.facility_id', current_setting('hid.test.p_facility'), true),
  set_config('app.correlation_id', 'privileges-invite', true);
select invitation_id from identity.create_staff_invitation('d6970000-0000-4000-8000-000000000001',
  'd6960000-0000-4000-8000-000000000001', 'Yemisi Quietname', 'yemisi.quietname@privacy-people.invalid', 'nurse', 'NMCN',
  'RN-58213', 'facility-staff-attestation-v1', 'privileges-key-000001',
  encode(sha256('privacy-request'::bytea), 'hex'), encode(sha256('privacy-token-Kx81vQ'::bytea), 'hex'),
  encode(sha256('privacy-code-604217'::bytea), 'hex'), 'v1');
select identity.record_staff_invitation_delivery('d6960000-0000-4000-8000-000000000001', 'accepted');
select set_config('app.actor_subject', 'system:auth', true),
  set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
  set_config('app.correlation_id', 'privileges-accept', true),
  set_config('app.purpose_of_use', '', true);
select result, account_case from identity.open_staff_invitation('d6970000-0000-4000-8000-000000000001',
  encode(sha256('privacy-token-Kx81vQ'::bytea), 'hex'), null, null, encode(sha256('privacy-open-session'::bytea), 'hex'));
select result from identity.prepare_staff_invitation_acceptance(encode(sha256('privacy-open-session'::bytea), 'hex'));
select account_case from identity.accept_staff_invitation_with_password(encode(sha256('privacy-open-session'::bytea), 'hex'),
  '$argon2id$v=19$m=65536,t=3,p=1$' || repeat('q', 22) || '$' || repeat('r', 43));
reset role;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  status, reason, starts_at, expires_at, purpose_of_use)
select 'd6080000-0000-4000-8000-000000000001', 'd6060000-0000-4000-8000-000000000001', membership.staff_id,
  membership.account_id, membership.id, membership.facility_id, 'read_records', 'active', 'Patient consented',
  clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day', 'direct-care'
  from identity.staff_facility_memberships membership
  join auth.accounts account on account.id = membership.account_id
 where account.email = 'yemisi.quietname@privacy-people.invalid';
select set_config('hid.test.p_member', (select membership.id::text from identity.staff_facility_memberships membership
  join auth.accounts account on account.id = membership.account_id
  where account.email = 'yemisi.quietname@privacy-people.invalid'), true);
set local role hid_identity_api_runtime;
select set_config('app.actor_subject', 'org-onboarding:' || current_setting('hid.test.p_account'), true),
  set_config('app.membership_id', current_setting('hid.test.p_membership'), true),
  set_config('app.facility_id', current_setting('hid.test.p_facility'), true),
  set_config('app.correlation_id', 'privileges-role', true),
  set_config('app.purpose_of_use', 'healthcare-operations', true);
select role_code from identity.change_facility_staff_role(current_setting('hid.test.p_member')::uuid, 1, 'doctor', 'MDCN',
  'MDCN/77 455', 'facility-staff-attestation-v1', 'Promoted after the licence was checked');
select grants_revoked from identity.end_facility_staff_membership(current_setting('hid.test.p_member')::uuid, 2,
  'Left the facility for another job');
select set_config('app.actor_subject', 'synthetic:privileges:super', true),
  set_config('app.membership_id', '', true), set_config('app.facility_id', '', true),
  set_config('app.correlation_id', 'privileges-admin', true);
select count(*) from identity.admin_list_facility_staff(current_setting('hid.test.p_facility')::uuid);
select count(*) from identity.admin_find_staff_invitations('d6970000');
-- Support's two reads need platform.admin.access and platform.principal.read:
-- support_admin holds both; security_auditor holds only the first.
select set_config('app.actor_subject', 'synthetic:privileges:support', true);
do $$ begin
  if (select count(*) from identity.admin_list_facility_staff(current_setting('hid.test.p_facility')::uuid)) = 0
     or (select count(*) from identity.admin_find_staff_invitations('d6970000')) = 0 then
    raise exception 'support_admin cannot use support''s staff reads';
  end if;
end $$;
select set_config('app.actor_subject', 'synthetic:privileges:auditor', true);
do $$
declare attempt integer;
begin
  for attempt in 1..2 loop
    begin
      if attempt = 1 then
        perform identity.admin_list_facility_staff(current_setting('hid.test.p_facility')::uuid);
      else
        perform identity.admin_find_staff_invitations('d6970000');
      end if;
      raise exception 'Support read % worked without platform.principal.read', attempt;
    exception when insufficient_privilege then
      if sqlerrm <> 'ADMIN_PERMISSION_DENIED' then raise; end if;
    end;
  end loop;
end $$;
select set_config('app.actor_subject', 'synthetic:privileges:super', true);
select granted_role from identity.admin_set_self_service_administrator_role(current_setting('hid.test.p_app')::uuid,
  (select item.row_version from identity.admin_list_self_service_facilities('all') item
    where item.application_id = current_setting('hid.test.p_app')::uuid),
  'nurse', 'NMCN', 'RN 7731', 'in_person', 'Administrator works as a nurse');
select probation_ended_at is not null from identity.admin_end_self_service_probation(current_setting('hid.test.p_app')::uuid,
  (select item.row_version from identity.admin_list_self_service_facilities('all') item
    where item.application_id = current_setting('hid.test.p_app')::uuid), 'Support ended the first days early');
reset role;
do $$
declare
  leaked record;
begin
  -- The run produced every P4b audit action.
  if (select count(distinct action) from audit.events where action in ('identity.facility-administrator-licence.record',
        'admin.self-service-facility.review', 'identity.facility-access.unlock', 'identity.staff-invitation.create',
        'identity.staff-invitation.delivery', 'identity.staff-invitation.open', 'identity.staff-invitation.accept',
        'identity.facility-staff.role-change', 'identity.facility-staff.end', 'identity.consent-grant.close',
        'admin.self-service-facility.administrator-role', 'identity.facility-access.change',
        'admin.self-service-facility.probation-end', 'identity.organization.self-service.withdraw')) <> 14 then
    raise exception 'The privileges run did not produce every audit action';
  end if;
  select * into leaked from audit.events
   where (details::text || ' ' || coalesce(reason, '')) ~*
     'yemisi|quietname|privacy-people|zainab|privacy-hospital|wale|withdrawer|privacy-withdraw|93 ?761|58213|77 ?455|7731|Kx81vQ|604217|RC9960006'
   limit 1;
  if leaked.event_id is not null then
    raise exception 'An audit row holds a synthetic secret or name: % %', leaked.action, leaked.details;
  end if;
  if exists (select 1 from audit.events where facility_id is not null
              and (details ? 'accountCase' or details::text ~* 'account_case|dormant|existing_staff')) then
    raise exception 'A facility audit row carries an account case';
  end if;
  if exists (select 1 from audit.events where action = 'identity.staff-invitation.open'
              and details <> jsonb_build_object('invitationId', resource_id)) then
    raise exception 'Open''s details hold more than the invitation id';
  end if;
end $$;

-- 3 (owner). The no-mutation triggers refuse the tables' owner too (under the
-- rehearsal's owner swap, a NOSUPERUSER NOBYPASSRLS role).
do $$
declare owner_name text;
begin
  select pg_get_userbyid(relation.relowner) into owner_name from pg_class relation
   where relation.oid = 'identity.staff_licence_attestations'::regclass;
  execute format('set local role %I', owner_name);
  begin
    update identity.staff_licence_attestations set licence_number = 'MDCN/1' where true;
    raise exception 'The owner changed an attestation';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from identity.staff_attestation_texts where true;
    raise exception 'The owner deleted an attestation text';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from identity.staff_invitations where true;
    raise exception 'The owner deleted an invitation';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    update identity.staff_invitation_sends set kind = 'invite' where true;
    raise exception 'The owner rewrote a send';
  exception when object_not_in_prerequisite_state then null;
  end;
  reset role;
end $$;

rollback;
