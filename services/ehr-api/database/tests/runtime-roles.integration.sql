-- Runtime role and grant acceptance checks.
-- Run as the database security administrator that ran runtime-grants.sql
-- (db:bootstrap and db:verify-roles do): the creator membership allowed below
-- is that administrator's only.
-- This file is assertion-only and does not mutate roles or application data.

do $$
declare
  role_name text;
  table_name text;
  -- The administrator running these assertions, if it may create roles. Every
  -- HID role is NOCREATEROLE (checked below), so none of them qualifies.
  administrator oid := (select oid from pg_roles where rolname = current_user and rolcreaterole);
begin
  foreach role_name in array array[
    'hid_identity_runtime', 'hid_ehr_runtime', 'hid_api_runtime',
    'hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_ocr_api_runtime',
    'hid_audit_writer', 'hid_document_scanner', 'hid_ocr_runtime', 'hid_ocr_worker',
    'hid_lab_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_runtime',
    'hid_pharmacy_api_runtime', 'hid_outreach_runtime',
    'hid_outreach_api_runtime', 'hid_migration_admin',
    'hid_schema_test_runtime', 'hid_event_delivery_commands',
    'hid_event_dispatcher', 'hid_notification_runtime',
    'hid_notification_api_runtime', 'hid_notification_worker',
    'hid_ocr_queue_metrics', 'hid_platform_control_reader', 'hid_lab_release_reader',
    'hid_imported_history_commands', 'hid_imported_history_importer'
  ] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      raise exception 'required HID role is missing: %', role_name;
    end if;
    if (select rolsuper or rolcreaterole or rolcreatedb or rolbypassrls or rolcanlogin
          from pg_roles where rolname = role_name) then
      raise exception 'HID group role has unsafe attributes: %', role_name;
    end if;
  end loop;

  if pg_has_role('hid_api_runtime', 'hid_identity_runtime', 'member')
     or pg_has_role('hid_api_runtime', 'hid_ehr_runtime', 'member')
     or pg_has_role('hid_api_runtime', 'hid_ocr_runtime', 'member')
     or pg_has_role('hid_api_runtime', 'hid_audit_writer', 'member')
     or has_table_privilege('hid_api_runtime', 'identity.patients', 'INSERT')
     or has_table_privilege('hid_api_runtime', 'ehr.encounters', 'INSERT') then
    raise exception 'retired modular-monolith aggregate retains active persistence privileges';
  end if;
  if not pg_has_role('hid_identity_api_runtime', 'hid_identity_runtime', 'member')
     or not pg_has_role('hid_identity_api_runtime', 'hid_audit_writer', 'member')
     or pg_has_role('hid_identity_api_runtime', 'hid_ehr_runtime', 'member')
     or pg_has_role('hid_identity_api_runtime', 'hid_ocr_runtime', 'member') then
    raise exception 'Identity API aggregate violates extracted service ownership';
  end if;
  if not pg_has_role('hid_ehr_api_runtime', 'hid_ehr_runtime', 'member')
     or not pg_has_role('hid_ehr_api_runtime', 'hid_audit_writer', 'member')
     or pg_has_role('hid_ehr_api_runtime', 'hid_identity_runtime', 'member')
     or pg_has_role('hid_ehr_api_runtime', 'hid_ocr_runtime', 'member') then
    raise exception 'EHR API aggregate violates extracted service ownership';
  end if;
  if not pg_has_role('hid_ocr_api_runtime', 'hid_ocr_runtime', 'member')
     or not pg_has_role('hid_ocr_api_runtime', 'hid_audit_writer', 'member')
     or pg_has_role('hid_ocr_api_runtime', 'hid_identity_runtime', 'member')
     or pg_has_role('hid_ocr_api_runtime', 'hid_ehr_runtime', 'member') then
    raise exception 'OCR API aggregate violates extracted service ownership';
  end if;
  if not pg_has_role('hid_lab_api_runtime','hid_lab_runtime','member')
     or not pg_has_role('hid_lab_api_runtime','hid_audit_writer','member')
     or pg_has_role('hid_lab_api_runtime','hid_ehr_runtime','member')
     or pg_has_role('hid_lab_api_runtime','hid_identity_runtime','member') then
    raise exception 'Lab API aggregate violates extracted service ownership';
  end if;
  if has_table_privilege('hid_api_runtime', 'lab.results', 'UPDATE')
     or has_table_privilege('hid_api_runtime', 'lab.work_items', 'INSERT') then
    raise exception 'EHR API aggregate must not mutate extracted Lab persistence';
  end if;
  if not pg_has_role('hid_pharmacy_api_runtime','hid_pharmacy_runtime','member')
     or not pg_has_role('hid_pharmacy_api_runtime','hid_audit_writer','member')
     or pg_has_role('hid_pharmacy_api_runtime','hid_ehr_runtime','member')
     or pg_has_role('hid_pharmacy_api_runtime','hid_identity_runtime','member')
     or pg_has_role('hid_pharmacy_api_runtime','hid_lab_runtime','member') then
    raise exception 'Pharmacy API aggregate violates extracted service ownership';
  end if;
  if has_table_privilege('hid_api_runtime', 'pharmacy.work_items', 'INSERT')
     or has_table_privilege('hid_api_runtime', 'pharmacy.dispensings', 'INSERT') then
    raise exception 'EHR API aggregate must not mutate extracted Pharmacy persistence';
  end if;
  if not pg_has_role('hid_outreach_api_runtime','hid_outreach_runtime','member')
     or not pg_has_role('hid_outreach_api_runtime','hid_audit_writer','member')
     or pg_has_role('hid_outreach_api_runtime','hid_ehr_runtime','member')
     or pg_has_role('hid_outreach_api_runtime','hid_identity_runtime','member')
     or pg_has_role('hid_outreach_api_runtime','hid_lab_runtime','member')
     or pg_has_role('hid_outreach_api_runtime','hid_pharmacy_runtime','member') then
    raise exception 'Outreach API aggregate violates extracted service ownership';
  end if;
  if has_table_privilege('hid_api_runtime', 'outreach.registration_cases', 'INSERT')
     or has_table_privilege('hid_api_runtime', 'outreach.patient_mappings', 'INSERT') then
    raise exception 'EHR API aggregate must not mutate extracted Outreach persistence';
  end if;
  if pg_has_role('hid_ehr_runtime', 'hid_identity_runtime', 'member')
     or pg_has_role('hid_identity_runtime', 'hid_ehr_runtime', 'member') then
    raise exception 'domain roles must not inherit each other';
  end if;
  if pg_has_role('hid_migration_admin', 'hid_api_runtime', 'member')
     or pg_has_role('hid_schema_test_runtime', 'hid_api_runtime', 'member') then
    raise exception 'migration and schema-test roles must not inherit the application aggregate';
  end if;
  if not has_table_privilege('hid_migration_admin', 'migration.source_rows', 'SELECT')
     or not has_table_privilege('hid_migration_admin', 'migration.source_rows', 'INSERT')
     or not has_column_privilege('hid_migration_admin', 'migration.source_rows', 'promoted_at', 'UPDATE')
     or has_column_privilege('hid_migration_admin', 'migration.source_rows', 'payload', 'UPDATE')
     or has_column_privilege('hid_migration_admin', 'migration.source_rows', 'payload_sha256', 'UPDATE') then
    raise exception 'migration source ledger is not restricted to append-only staging and promotion marking';
  end if;
  if pg_has_role('hid_event_dispatcher', 'hid_event_delivery_commands', 'member')
     or pg_has_role('hid_event_delivery_commands', 'hid_event_dispatcher', 'member') then
    raise exception 'event dispatcher must not inherit its security-definer command owner';
  end if;
  if not pg_has_role('hid_notification_api_runtime', 'hid_notification_runtime', 'member')
     or not pg_has_role('hid_notification_worker', 'hid_notification_runtime', 'member')
     or pg_has_role('hid_notification_api_runtime', 'hid_identity_runtime', 'member')
     or pg_has_role('hid_notification_worker', 'hid_event_delivery_commands', 'member')
     or pg_has_role('hid_notification_worker', 'hid_event_dispatcher', 'member') then
    raise exception 'notification aggregate role boundaries are inconsistent';
  end if;
  if has_table_privilege('hid_identity_api_runtime', 'auth.accounts', 'UPDATE')
     or not has_function_privilege('hid_identity_api_runtime',
       'auth.complete_recovery_otp(uuid,text,text,text)', 'EXECUTE')
     or has_function_privilege('hid_ehr_api_runtime',
       'auth.complete_recovery_otp(uuid,text,text,text)', 'EXECUTE')
     or has_function_privilege('hid_notification_worker',
       'auth.complete_recovery_otp(uuid,text,text,text)', 'EXECUTE') then
    raise exception 'OTP recovery must use the isolated Identity command without generic account mutation';
  end if;
  if not has_table_privilege('hid_identity_runtime', 'auth.otp_challenges', 'SELECT,INSERT,UPDATE')
     or not has_table_privilege('hid_identity_runtime', 'auth.otp_rate_limits', 'SELECT,INSERT,UPDATE')
     or has_table_privilege('hid_identity_runtime', 'identity.patient_assurance_states', 'SELECT')
     or has_table_privilege('hid_identity_runtime', 'identity.patient_assurance_states', 'INSERT')
     or has_table_privilege('hid_identity_runtime', 'identity.patient_assurance_states', 'UPDATE')
     or has_table_privilege('hid_identity_runtime', 'identity.patient_assurance_states', 'DELETE')
     or has_table_privilege('hid_identity_runtime', 'notification.device_registrations', 'SELECT') then
    raise exception 'Identity OTP or evidence-bound progressive-assurance boundary is inconsistent';
  end if;
  -- Recovery start cooldowns (0081): the Identity runtime reads and writes
  -- them but never deletes them. Every other required runtime role has no
  -- privilege on them; the schema-test runtime is granted as the Identity
  -- runtime is, and the migration administrator is not checked here.
  if not has_table_privilege('hid_identity_runtime', 'auth.otp_start_cooldowns', 'SELECT')
     or not has_table_privilege('hid_identity_runtime', 'auth.otp_start_cooldowns', 'INSERT')
     or not has_table_privilege('hid_identity_runtime', 'auth.otp_start_cooldowns', 'UPDATE')
     or has_table_privilege('hid_identity_runtime', 'auth.otp_start_cooldowns', 'DELETE,TRUNCATE')
     or has_table_privilege('hid_identity_api_runtime', 'auth.otp_start_cooldowns', 'DELETE,TRUNCATE') then
    raise exception 'Identity recovery start cooldown privileges are inconsistent';
  end if;
  foreach role_name in array array[
    'hid_ehr_runtime', 'hid_api_runtime', 'hid_ehr_api_runtime', 'hid_ocr_api_runtime',
    'hid_audit_writer', 'hid_document_scanner', 'hid_ocr_runtime', 'hid_ocr_worker',
    'hid_lab_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_runtime',
    'hid_pharmacy_api_runtime', 'hid_outreach_runtime', 'hid_outreach_api_runtime',
    'hid_event_delivery_commands', 'hid_event_dispatcher', 'hid_notification_runtime',
    'hid_notification_api_runtime', 'hid_notification_worker', 'hid_ocr_queue_metrics',
    'hid_platform_control_reader', 'hid_lab_release_reader',
    'hid_imported_history_commands', 'hid_imported_history_importer'
  ] loop
    if has_table_privilege(role_name, 'auth.otp_start_cooldowns',
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'Runtime role % can access recovery start cooldowns', role_name;
    end if;
  end loop;
  -- Public enrollment NIN lookup quota (0085): the Identity runtime charges it
  -- only through its definer command and holds no privilege on the counters;
  -- every other required runtime role can do neither. The schema-test runtime
  -- is granted as the Identity runtime is.
  if not has_function_privilege('hid_identity_runtime',
       'platform.consume_public_patient_nin_quota(char,integer,integer,integer)', 'EXECUTE')
     or has_function_privilege('public',
       'platform.consume_public_patient_nin_quota(char,integer,integer,integer)', 'EXECUTE')
     or has_table_privilege('hid_identity_runtime', 'platform.public_patient_nin_quota_counters',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
    raise exception 'Identity public enrollment NIN lookup quota privileges are inconsistent';
  end if;
  foreach role_name in array array[
    'hid_ehr_runtime', 'hid_api_runtime', 'hid_ehr_api_runtime', 'hid_ocr_api_runtime',
    'hid_audit_writer', 'hid_document_scanner', 'hid_ocr_runtime', 'hid_ocr_worker',
    'hid_lab_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_runtime',
    'hid_pharmacy_api_runtime', 'hid_outreach_runtime', 'hid_outreach_api_runtime',
    'hid_event_delivery_commands', 'hid_event_dispatcher', 'hid_notification_runtime',
    'hid_notification_api_runtime', 'hid_notification_worker', 'hid_ocr_queue_metrics',
    'hid_lab_release_reader',
    'hid_imported_history_commands', 'hid_imported_history_importer'
  ] loop
    if has_function_privilege(role_name,
         'platform.consume_public_patient_nin_quota(char,integer,integer,integer)', 'EXECUTE')
       or has_table_privilege(role_name, 'platform.public_patient_nin_quota_counters',
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'Runtime role % can reach the public enrollment NIN lookup quota', role_name;
    end if;
  end loop;
  if not has_table_privilege('hid_notification_runtime', 'notification.device_registrations', 'SELECT,INSERT,UPDATE')
     or not has_table_privilege('hid_notification_runtime', 'notification.delivery_attempts', 'SELECT,INSERT')
     or has_table_privilege('hid_notification_runtime', 'auth.otp_challenges', 'SELECT')
     or has_table_privilege('hid_notification_runtime', 'identity.patients', 'SELECT') then
    raise exception 'notification persistence ownership is inconsistent';
  end if;
  if not has_function_privilege(
       'hid_notification_worker',
       'integration.claim_inbox_message(text,uuid,text,text,integer,text,character,text,integer)',
       'EXECUTE'
     ) or not has_function_privilege(
       'hid_notification_worker', 'integration.complete_inbox_message(text,uuid,uuid)', 'EXECUTE'
     ) or not has_function_privilege(
       'hid_notification_worker',
       'integration.fail_inbox_message(text,uuid,uuid,text,boolean,timestamptz,integer)',
       'EXECUTE'
     ) or has_table_privilege(
       'hid_notification_worker', 'integration.inbox_messages', 'SELECT,INSERT,UPDATE,DELETE'
     ) then
    raise exception 'notification worker durable inbox boundary is inconsistent';
  end if;
  if not has_function_privilege(
       'hid_event_dispatcher',
       'integration.claim_outbox_events(text,integer,integer,integer)', 'EXECUTE'
     )
     or not has_function_privilege(
       'hid_event_dispatcher',
       'integration.record_outbox_delivered(text,uuid,uuid,text,text)', 'EXECUTE'
     )
     or not has_function_privilege(
       'hid_event_dispatcher',
       'integration.record_outbox_failure(text,uuid,uuid,text,text,text,boolean,timestamptz,integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'hid_event_dispatcher', 'integration.event_delivery_status()', 'EXECUTE'
     )
     or not has_function_privilege(
       'hid_event_dispatcher', 'integration.list_terminal_event_failures(integer)', 'EXECUTE'
     )
     or has_function_privilege(
       'hid_event_dispatcher',
       'integration.claim_inbox_message(text,uuid,text,text,integer,text,character,text,integer)',
       'EXECUTE'
     ) then
    raise exception 'event dispatcher command surface is inconsistent';
  end if;
  if has_table_privilege('hid_event_dispatcher', 'identity.outbox_events', 'SELECT')
     or has_table_privilege('hid_event_dispatcher', 'ocr.outbox_events', 'SELECT')
     or has_table_privilege('hid_event_dispatcher', 'lab.outbox_events', 'SELECT')
     or has_table_privilege('hid_event_dispatcher', 'pharmacy.outbox_events', 'SELECT')
     or has_table_privilege('hid_event_dispatcher', 'outreach.outbox_events', 'SELECT')
     or has_table_privilege(
       'hid_event_dispatcher', 'integration.outbox_delivery_state', 'SELECT,INSERT,UPDATE,DELETE'
     )
     or has_schema_privilege('hid_event_dispatcher', 'integration', 'CREATE') then
    raise exception 'event dispatcher has direct persistence or schema authority';
  end if;
  if not has_table_privilege('hid_event_delivery_commands', 'identity.outbox_events', 'SELECT')
     or not has_table_privilege('hid_event_delivery_commands', 'ocr.outbox_events', 'SELECT')
     or not has_table_privilege('hid_event_delivery_commands', 'lab.outbox_events', 'SELECT')
     or not has_table_privilege('hid_event_delivery_commands', 'pharmacy.outbox_events', 'SELECT')
     or not has_table_privilege('hid_event_delivery_commands', 'outreach.outbox_events', 'SELECT')
     or has_table_privilege('hid_event_delivery_commands', 'identity.outbox_events', 'INSERT')
     or has_table_privilege('hid_event_delivery_commands', 'ocr.outbox_events', 'UPDATE')
     or has_table_privilege('hid_event_delivery_commands', 'lab.outbox_events', 'DELETE') then
    raise exception 'event delivery command owner is not constrained to domain outbox reads';
  end if;
  if has_function_privilege(
       'public', 'integration.claim_outbox_events(text,integer,integer,integer)', 'EXECUTE'
     ) then
    raise exception 'PUBLIC can execute an event delivery command';
  end if;
  if has_function_privilege(
       'public', 'identity.admin_transition_facility(uuid,bigint,text,text,text,character)', 'EXECUTE'
     ) or has_function_privilege(
       'public', 'auth.admin_transition_account(uuid,bigint,text,text,text,character)', 'EXECUTE'
     ) or has_function_privilege(
       'public', 'auth.admin_change_platform_role(uuid,bigint,text,text,text,text,character)', 'EXECUTE'
     ) or has_function_privilege(
       'public', 'auth.admin_revoke_account_sessions(uuid,text,text,character)', 'EXECUTE'
     ) then
    raise exception 'PUBLIC can execute a governed platform administration command';
  end if;
  if not has_function_privilege(
       'hid_identity_runtime', 'identity.admin_transition_facility(uuid,bigint,text,text,text,character)', 'EXECUTE'
     ) or not has_function_privilege(
       'hid_identity_runtime', 'identity.admin_platform_overview()', 'EXECUTE'
     ) or not has_function_privilege(
       'hid_identity_runtime', 'auth.admin_transition_account(uuid,bigint,text,text,text,character)', 'EXECUTE'
     ) or not has_function_privilege(
       'hid_identity_runtime', 'auth.admin_change_platform_role(uuid,bigint,text,text,text,text,character)', 'EXECUTE'
     ) or not has_function_privilege(
       'hid_identity_runtime', 'auth.admin_revoke_account_sessions(uuid,text,text,character)', 'EXECUTE'
     ) or has_table_privilege('hid_identity_runtime', 'auth.account_roles', 'INSERT,UPDATE,DELETE')
     or has_table_privilege('hid_identity_runtime', 'identity.facilities', 'UPDATE,DELETE')
     or has_table_privilege('hid_identity_runtime', 'audit.events', 'UPDATE,DELETE') then
    raise exception 'Identity administration runtime boundary is inconsistent';
  end if;
  -- Platform controls (0039) are listed and changed only through the two
  -- Identity-owned security-definer commands, which check the control permissions.
  if not has_function_privilege('hid_identity_api_runtime', 'platform.admin_list_controls()', 'EXECUTE')
     or not has_function_privilege(
       'hid_identity_api_runtime', 'platform.admin_set_control(text,boolean,bigint,text)', 'EXECUTE'
     ) or has_function_privilege('public', 'platform.admin_list_controls()', 'EXECUTE')
     or has_function_privilege('public', 'platform.admin_set_control(text,boolean,bigint,text)', 'EXECUTE')
     or has_function_privilege('hid_ehr_api_runtime', 'platform.admin_set_control(text,boolean,bigint,text)', 'EXECUTE')
     or has_table_privilege('hid_identity_runtime', 'platform.control_settings', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('hid_identity_runtime', 'platform.control_events', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'platform control administration must use only the granted Identity commands';
  end if;
  -- Platform audit (0072): the eleven-argument reader with the target filter
  -- replaces the 0067 reader and is executable by the Identity runtime only.
  -- The reachability helper stays internal to the security-definer commands.
  if to_regprocedure('audit.list_platform_events(integer,bigint,text,uuid,text,text,text,timestamptz,timestamptz)') is not null
     or not has_function_privilege('hid_identity_api_runtime',
       'audit.list_platform_events(integer,bigint,text,uuid,text,text,text,timestamptz,timestamptz,text,text)', 'EXECUTE')
     or has_function_privilege('public',
       'audit.list_platform_events(integer,bigint,text,uuid,text,text,text,timestamptz,timestamptz,text,text)', 'EXECUTE')
     or exists (
       select 1 from unnest(array['hid_ehr_api_runtime', 'hid_ocr_api_runtime', 'hid_lab_api_runtime',
         'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_notification_api_runtime']) runtime(role_name)
       where has_function_privilege(runtime.role_name,
         'audit.list_platform_events(integer,bigint,text,uuid,text,text,text,timestamptz,timestamptz,text,text)', 'EXECUTE')
     )
     or has_function_privilege('public', 'auth.other_reachable_super_admins(uuid,text)', 'EXECUTE')
     or has_function_privilege('hid_identity_api_runtime', 'auth.other_reachable_super_admins(uuid,text)', 'EXECUTE') then
    raise exception 'platform audit reader or Super Admin reachability helper privileges are inconsistent';
  end if;
  -- Session revocation serialization (0073): the account-row lock helper is
  -- executable by the Identity runtime only, which still cannot update accounts.
  if not has_function_privilege('hid_identity_api_runtime', 'auth.lock_account_sessions(uuid)', 'EXECUTE')
     or has_function_privilege('public', 'auth.lock_account_sessions(uuid)', 'EXECUTE')
     or has_table_privilege('hid_identity_api_runtime', 'auth.accounts', 'UPDATE')
     or exists (
       select 1 from unnest(array['hid_ehr_api_runtime', 'hid_ocr_api_runtime', 'hid_lab_api_runtime',
         'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_notification_api_runtime']) runtime(role_name)
       where has_function_privilege(runtime.role_name, 'auth.lock_account_sessions(uuid)', 'EXECUTE')
     ) then
    raise exception 'session revocation lock helper privileges are inconsistent';
  end if;
  -- The MFA account lock (0076): the Identity runtime only. Its ACL must name
  -- no grantee but the owner and hid_identity_runtime, so a grant to any other
  -- role, PUBLIC included, fails here. A NULL ACL is the default PUBLIC grant.
  if not has_function_privilege('hid_identity_api_runtime', 'auth.lock_account_for_mfa(uuid)', 'EXECUTE')
     or (select function_row.proacl from pg_proc function_row
          where function_row.oid = 'auth.lock_account_for_mfa(uuid)'::regprocedure) is null
     or exists (
       select 1 from pg_proc function_row, aclexplode(function_row.proacl) privilege
       where function_row.oid = 'auth.lock_account_for_mfa(uuid)'::regprocedure
         and privilege.grantee <> function_row.proowner
         and privilege.grantee <> 'hid_identity_runtime'::regrole
     ) then
    raise exception 'MFA account lock helper privileges are inconsistent';
  end if;
  -- Launch D14 (0087): the workforce commands and the effective-role check are
  -- executable by the Identity runtime only; their helpers by nobody; and no
  -- runtime reads or writes the attestation, lifecycle or role-grant tables,
  -- or updates memberships, directly.
  if exists (
       select 1 from unnest(array[
         'identity.admin_attach_workforce_member(uuid,uuid,text,text,text,text,character)',
         'identity.admin_record_credential_attestation(uuid,bigint,text[],text,text,text,timestamptz,text,text,character)',
         'identity.admin_change_workforce_role(uuid,uuid,bigint,text,text,text,text,character)',
         'identity.admin_end_workforce_membership(uuid,uuid,bigint,text,text,character)',
         'identity.admin_workforce_profile(uuid)', 'auth.facility_role_is_effective(uuid)']) command(signature)
       where not has_function_privilege('hid_identity_api_runtime', command.signature, 'EXECUTE')
          or has_function_privilege('public', command.signature, 'EXECUTE')
          or exists (
            select 1 from unnest(array['hid_ehr_api_runtime', 'hid_ocr_api_runtime', 'hid_lab_api_runtime',
              'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_notification_api_runtime',
              'hid_schema_test_runtime']) runtime(role_name)
            where has_function_privilege(runtime.role_name, command.signature, 'EXECUTE'))
     ) or exists (
       select 1 from unnest(array['identity.workforce_command_actor()', 'identity.workforce_require_assurance(uuid)',
         'identity.workforce_works_at(uuid,uuid)', 'identity.workforce_target_eligible(auth.accounts)',
         'identity.guard_workforce_membership_change()', 'identity.guard_ended_membership_change()']) helper(signature)
       where has_function_privilege('public', helper.signature, 'EXECUTE')
          or has_function_privilege('hid_identity_api_runtime', helper.signature, 'EXECUTE')
     ) or exists (
       select 1
       from unnest(array['identity.staff_credential_attestations', 'identity.workforce_memberships',
         'identity.workforce_role_grants']) evidence(table_name),
         unnest(array['hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_schema_test_runtime',
           'hid_migration_admin']) runtime(role_name),
         unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege(name)
       where has_table_privilege(runtime.role_name, evidence.table_name, privilege.name)
     ) or has_table_privilege('hid_identity_api_runtime', 'identity.staff_facility_memberships', 'UPDATE')
       or not exists (select 1 from auth.role_permissions where role_code = 'platform_super_admin'
         and permission_code = 'platform.workforce.manage')
       or exists (select 1 from auth.role_permissions where permission_code = 'platform.workforce.manage'
         and role_code <> 'platform_super_admin') then
    raise exception 'workforce provisioning privileges are inconsistent';
  end if;
  -- Clinician self sign-up (0098, ADR-066): the public, capability and system
  -- commands are executable by the Identity runtime (and the schema test
  -- runtime) only; the administration commands by the Identity runtime only;
  -- the internal helpers, the pinned 0087 grant and the guard by no runtime;
  -- and no runtime reads or writes the five tables directly.
  if exists (
       select 1 from unnest(array[
         'identity.clinician_signup_open()',
         'platform.consume_clinician_application_quota(character,text,integer,integer,integer)',
         'identity.begin_clinician_application_challenge(text,uuid,character,text,character)',
         'identity.invalidate_clinician_application_challenge(uuid)',
         'identity.verify_clinician_application_signup_code(uuid,character,text,character,character)',
         'identity.verify_clinician_application_status_code(uuid,character,character,character)',
         'identity.clinician_application_session(character)',
         'identity.clinician_application_submit_probe(character,character,text,character,text,text,text,text,text,date,uuid,integer)',
         'identity.count_clinician_application_submit_attempt(character)',
         'identity.search_clinician_application_facilities(character,text)',
         'identity.submit_clinician_application(character,character,text,character,text,character,text,text,text,text,text,date,uuid,integer,integer)',
         'identity.bind_clinician_application_mfa_challenge(character,uuid)',
         'identity.clinician_application_authenticator_ready(character,uuid,text)',
         'identity.current_clinician_applications(character)',
         'identity.withdraw_clinician_application(character,uuid,bigint)',
         'identity.file_clinician_application(character,text,character,text,text,text,date,uuid,integer,integer)',
         'identity.end_clinician_application_session(character)',
         'identity.expire_clinician_applications(integer)',
         'identity.prune_clinician_application_artifacts()']) command(signature)
       where not has_function_privilege('hid_identity_api_runtime', command.signature, 'EXECUTE')
          or not has_function_privilege('hid_schema_test_runtime', command.signature, 'EXECUTE')
          or has_function_privilege('public', command.signature, 'EXECUTE')
          or exists (
            select 1 from unnest(array['hid_ehr_api_runtime', 'hid_ocr_api_runtime', 'hid_lab_api_runtime',
              'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_notification_api_runtime']) runtime(role_name)
            where has_function_privilege(runtime.role_name, command.signature, 'EXECUTE'))
     ) or exists (
       select 1 from unnest(array[
         'identity.admin_list_clinician_applications(text,timestamptz,uuid,integer)',
         'identity.admin_get_clinician_application(uuid)',
         'identity.admin_clinician_application_attest_precheck(uuid,bigint,timestamptz,text,jsonb,text,text)',
         'identity.admin_clinician_application_prior(text,text,character)',
         'identity.admin_attest_clinician_application(uuid,bigint,timestamptz,text,jsonb,uuid,text,text,character)',
         'identity.admin_approve_clinician_application(uuid,bigint,text,text,character)',
         'identity.admin_reject_clinician_application(uuid,bigint,text,text,text,character)']) command(signature)
       where not has_function_privilege('hid_identity_api_runtime', command.signature, 'EXECUTE')
          or has_function_privilege('public', command.signature, 'EXECUTE')
          or exists (
            select 1 from unnest(array['hid_ehr_api_runtime', 'hid_ocr_api_runtime', 'hid_lab_api_runtime',
              'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_notification_api_runtime',
              'hid_schema_test_runtime']) runtime(role_name)
            where has_function_privilege(runtime.role_name, command.signature, 'EXECUTE'))
     ) or exists (
       select 1 from unnest(array[
         'identity.workforce_change_role(uuid,uuid,bigint,text,text,text,text,character,uuid)',
         'identity.workforce_attestation_usable(uuid,uuid,uuid,uuid)', 'identity.clinician_licence_key(text,text)',
         'identity.clinician_application_displayed_state(text,timestamptz)',
         'identity.clinician_application_require_system()', 'identity.clinician_intake_require_open()',
         'identity.clinician_application_require_not_maintenance()',
         'identity.clinician_application_session_row(character,boolean)',
         'identity.clinician_application_account_session(character,text[],text,boolean)',
         'identity.clinician_application_account_stage(uuid)', 'identity.clinician_application_status_eligible(uuid)',
         'identity.clinician_application_effective_stage(identity.clinician_application_sessions)',
         'identity.clinician_application_account_usable(uuid)', 'identity.clinician_application_staff_enrolment_only(uuid)',
         'platform.count_clinician_application_submission(integer)',
         'identity.clinician_application_identity_refused(uuid)', 'identity.clinician_application_account_refusal(uuid)',
         'identity.clinician_application_access_state(identity.clinician_applications)',
         'identity.clinician_application_view(identity.clinician_applications)',
         'identity.clinician_application_account_view(uuid,text)',
         'identity.clinician_application_audit(text,text,text,text,jsonb)',
         'identity.clinician_application_inner_key_free(uuid,text[],text)',
         'identity.guard_clinician_application_change()']) helper(signature)
       where has_function_privilege('public', helper.signature, 'EXECUTE')
          or has_function_privilege('hid_identity_api_runtime', helper.signature, 'EXECUTE')
          or has_function_privilege('hid_schema_test_runtime', helper.signature, 'EXECUTE')
     ) or exists (
       select 1
       from unnest(array['identity.clinician_applications', 'identity.clinician_application_challenges',
         'identity.clinician_application_sessions', 'identity.clinician_application_idempotency',
         'platform.clinician_application_quota_counters']) application_table(table_name),
         unnest(array['hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_schema_test_runtime',
           'hid_migration_admin', 'hid_api_runtime']) runtime(role_name),
         unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege(name)
       where has_table_privilege(runtime.role_name, application_table.table_name, privilege.name)
     ) then
    raise exception 'clinician self sign-up privileges are inconsistent';
  end if;
  -- Self-NIN identifiers are written only by identity.bind_my_verified_nin, a
  -- definer owned by the table owner, which bypasses row-level security on
  -- this table. No policy may let another role insert one directly (0078).
  if exists (
       select 1 from pg_policy policy_row
       where policy_row.polrelid = 'identity.patient_identifiers'::regclass
         and policy_row.polcmd in ('a', '*')
         and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) like '%hid-patient-self-qoreid-verification%'
     ) or (select relforcerowsecurity from pg_class where oid = 'identity.patient_identifiers'::regclass) then
    raise exception 'a policy lets a role other than the binding function insert a self-NIN identifier';
  end if;
  -- RLS policies and invoker-rights trigger functions run with the querying
  -- role's rights. platform.current_account_id() is an invoker SQL function
  -- that calls auth.account_id_for_subject(text), which is revoked from PUBLIC.
  -- A runtime that can reach a table whose policy or invoker trigger resolves
  -- the session account must be able to execute it, or each such statement
  -- fails with 42501 (every Outreach command did until 0077).
  if exists (
    select 1
    from unnest(array[
      'hid_identity_runtime', 'hid_ehr_runtime', 'hid_api_runtime',
      'hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_ocr_api_runtime',
      'hid_audit_writer', 'hid_document_scanner', 'hid_ocr_runtime', 'hid_ocr_worker',
      'hid_lab_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_runtime',
      'hid_pharmacy_api_runtime', 'hid_outreach_runtime',
      'hid_outreach_api_runtime', 'hid_migration_admin',
      'hid_schema_test_runtime', 'hid_event_delivery_commands',
      'hid_event_dispatcher', 'hid_notification_runtime',
      'hid_notification_api_runtime', 'hid_notification_worker',
      'hid_ocr_queue_metrics', 'hid_platform_control_reader', 'hid_lab_release_reader',
      'hid_imported_history_commands', 'hid_imported_history_importer'
    ]) runtime(role_name)
    join pg_class relation on relation.relkind in ('r', 'p')
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname not in ('pg_catalog', 'information_schema')
      and has_table_privilege(runtime.role_name, relation.oid, 'SELECT,INSERT,UPDATE,DELETE')
      and not has_function_privilege(runtime.role_name, 'auth.account_id_for_subject(text)', 'EXECUTE')
      and (
        exists (
          select 1 from pg_policy policy
          where policy.polrelid = relation.oid
            and (coalesce(pg_get_expr(policy.polqual, policy.polrelid), '') ~ 'current_account_id\('
              or coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '') ~ 'current_account_id\(')
        )
        or exists (
          select 1 from pg_trigger trigger_row
          join pg_proc function_row on function_row.oid = trigger_row.tgfoid
          where trigger_row.tgrelid = relation.oid
            and not trigger_row.tgisinternal
            and not function_row.prosecdef
            and function_row.prosrc ~ 'current_account_id\('
        )
      )
  ) or not has_function_privilege('hid_outreach_api_runtime', 'auth.account_id_for_subject(text)', 'EXECUTE') then
    raise exception 'a runtime cannot resolve the session account its RLS policies or invoker triggers require';
  end if;
  -- A clinician's own access-request list (0036) runs as the Identity runtime;
  -- the function itself checks the caller's membership and identity.consent.write.
  if not has_function_privilege('hid_identity_api_runtime', 'identity.list_my_staff_access_requests(text)', 'EXECUTE')
     or not has_function_privilege('hid_schema_test_runtime', 'identity.list_my_staff_access_requests(text)', 'EXECUTE')
     or has_function_privilege('public', 'identity.list_my_staff_access_requests(text)', 'EXECUTE')
     or exists (
       select 1 from unnest(array['hid_ehr_api_runtime', 'hid_ocr_api_runtime', 'hid_lab_api_runtime',
         'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_notification_api_runtime']) runtime(role_name)
       where has_function_privilege(runtime.role_name, 'identity.list_my_staff_access_requests(text)', 'EXECUTE')
     ) then
    raise exception 'staff access-request list privileges are inconsistent';
  end if;
  -- Recovery and patient search hardening (0086): Identity-only commands that
  -- check their own caller; no other runtime and not PUBLIC may call them.
  if exists (
       select 1
         from unnest(array['auth.recovery_account_audience(uuid,text)',
           'identity.patient_lookup_audit_subject(text)', 'identity.registration_nin_holder(text)',
           'identity.registration_candidates(date,text,text)']) command(signature)
        where not has_function_privilege('hid_identity_api_runtime', command.signature, 'EXECUTE')
           or not has_function_privilege('hid_schema_test_runtime', command.signature, 'EXECUTE')
           or has_function_privilege('public', command.signature, 'EXECUTE')
           or exists (
             select 1 from unnest(array['hid_ehr_api_runtime', 'hid_ocr_api_runtime', 'hid_lab_api_runtime',
               'hid_pharmacy_api_runtime', 'hid_outreach_api_runtime', 'hid_notification_api_runtime',
               'hid_notification_worker', 'hid_event_dispatcher']) runtime(role_name)
             where has_function_privilege(runtime.role_name, command.signature, 'EXECUTE')
           )
     ) then
    raise exception 'recovery audience, lookup audit and registration match privileges are inconsistent';
  end if;
  if not has_table_privilege('hid_identity_api_runtime', 'identity.patients', 'INSERT')
     or has_table_privilege('hid_identity_api_runtime', 'ehr.encounters', 'INSERT')
     or not has_table_privilege('hid_identity_api_runtime', 'audit.events', 'INSERT')
     or not has_table_privilege('hid_ehr_api_runtime', 'ehr.encounters', 'INSERT')
     or has_table_privilege('hid_ehr_api_runtime', 'identity.patients', 'INSERT')
     or has_table_privilege('hid_ehr_api_runtime', 'ocr.jobs', 'INSERT')
     or not has_table_privilege('hid_ehr_api_runtime', 'audit.events', 'INSERT')
     or not has_table_privilege('hid_ocr_api_runtime', 'ocr.jobs', 'INSERT')
     or has_table_privilege('hid_ocr_api_runtime', 'ehr.encounters', 'INSERT')
     or has_table_privilege('hid_ocr_api_runtime', 'identity.patients', 'INSERT')
     or not has_table_privilege('hid_ocr_api_runtime', 'audit.events', 'INSERT') then
    raise exception 'extracted API aggregate privileges are inconsistent';
  end if;

  foreach table_name in array array[
    'patients', 'patient_identifiers', 'registration_cases',
    'registration_case_candidates', 'registration_case_events',
    'access_requests', 'consent_grants', 'consent_directives',
    'consent_directive_versions', 'organizations', 'facilities',
    'staff', 'staff_facility_memberships'
  ] loop
    if has_table_privilege('hid_ehr_runtime', 'identity.' || table_name, 'SELECT')
       or has_table_privilege('hid_ehr_runtime', 'identity.' || table_name, 'INSERT')
       or has_table_privilege('hid_ehr_runtime', 'identity.' || table_name, 'UPDATE')
       or has_table_privilege('hid_ehr_runtime', 'identity.' || table_name, 'DELETE') then
      raise exception 'EHR runtime has direct Identity table privilege: identity.%', table_name;
    end if;
  end loop;

  foreach table_name in array array[
    'encounters', 'clinical_notes', 'clinical_note_revisions', 'vitals',
    'vital_corrections', 'diagnoses', 'prescriptions', 'lab_requests',
    'documents', 'document_scan_events', 'idempotency_keys', 'record_versions'
  ] loop
    if has_table_privilege('hid_identity_runtime', 'ehr.' || table_name, 'SELECT')
       or has_table_privilege('hid_identity_runtime', 'ehr.' || table_name, 'INSERT')
       or has_table_privilege('hid_identity_runtime', 'ehr.' || table_name, 'UPDATE')
       or has_table_privilege('hid_identity_runtime', 'ehr.' || table_name, 'DELETE') then
      raise exception 'Identity runtime has direct EHR table privilege: ehr.%', table_name;
    end if;
  end loop;

  if not has_table_privilege('hid_identity_runtime', 'identity.patients', 'SELECT')
     or not has_table_privilege('hid_identity_runtime', 'identity.patients', 'INSERT')
     or not has_table_privilege('hid_identity_runtime', 'identity.patient_identifiers', 'INSERT')
     or not has_table_privilege('hid_identity_runtime', 'identity.registration_cases', 'UPDATE')
     or not has_table_privilege('hid_identity_runtime', 'identity.registration_case_events', 'INSERT')
     or not has_table_privilege('hid_identity_runtime', 'identity.outbox_events', 'INSERT') then
    raise exception 'Identity runtime is missing required governed registration privileges';
  end if;
  if not has_function_privilege(
       'hid_identity_runtime', 'identity.record_my_nin_verification_evidence(text,uuid,text,text,text,text)', 'EXECUTE'
     ) or not has_function_privilege(
       'hid_identity_runtime', 'identity.record_organization_cac_verification_evidence(text,text,text,text)', 'EXECUTE'
     ) or not has_function_privilege(
       'hid_identity_runtime', 'identity.patient_self_nin_binding_matches(text,uuid,text)', 'EXECUTE'
     ) or has_function_privilege(
       'public', 'identity.record_my_nin_verification_evidence(text,uuid,text,text,text,text)', 'EXECUTE'
     ) or has_function_privilege(
       'public', 'identity.patient_self_nin_binding_matches(text,uuid,text)', 'EXECUTE'
     ) or has_function_privilege(
       'public', 'identity.record_organization_cac_verification_evidence(text,text,text,text)', 'EXECUTE'
     ) or has_table_privilege('hid_identity_runtime', 'identity.verification_evidence', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('hid_ehr_runtime', 'identity.verification_evidence', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'QoreID verification evidence command boundary is inconsistent';
  end if;

  if not has_table_privilege('hid_ocr_runtime', 'ocr.jobs', 'INSERT')
     or not has_table_privilege('hid_ocr_runtime', 'ocr.extractions', 'INSERT')
     or not has_table_privilege('hid_ocr_runtime', 'ocr.validations', 'INSERT')
     or has_table_privilege('hid_ocr_runtime', 'identity.patients', 'INSERT')
     or has_table_privilege('hid_ocr_runtime', 'ehr.encounters', 'INSERT') then
    raise exception 'OCR runtime ownership boundary is invalid';
  end if;
  if not has_table_privilege('hid_ocr_runtime', 'ocr.publications', 'INSERT')
     or not has_table_privilege('hid_ehr_runtime', 'ehr.ocr_import_provenance', 'INSERT')
     or has_table_privilege('hid_ocr_runtime', 'ehr.ocr_import_provenance', 'INSERT')
     or has_table_privilege('hid_ocr_worker', 'ehr.clinical_notes', 'INSERT')
     or has_table_privilege('hid_ocr_worker', 'identity.patients', 'INSERT') then
    raise exception 'OCR publication ownership boundary is invalid';
  end if;
  if not has_table_privilege('hid_lab_runtime','lab.imported_evidence','INSERT')
     or not has_table_privilege('hid_lab_runtime','lab.imported_observations','INSERT')
     or not has_table_privilege('hid_lab_runtime','lab.outbox_events','INSERT')
     or has_table_privilege('hid_lab_runtime','identity.patients','INSERT')
     or has_table_privilege('hid_lab_runtime','ehr.lab_requests','INSERT')
     or has_table_privilege('hid_lab_runtime','ocr.publications','UPDATE')
     or has_table_privilege('hid_ehr_runtime','lab.imported_evidence','INSERT')
     or has_table_privilege('hid_ocr_runtime','lab.imported_evidence','INSERT') then
    raise exception 'Lab imported-evidence ownership boundary is invalid';
  end if;
  if not has_table_privilege('hid_lab_runtime','lab.accessions','INSERT')
     or not has_table_privilege('hid_lab_runtime','lab.specimens','UPDATE')
     or not has_table_privilege('hid_lab_runtime','lab.specimen_events','INSERT')
     or has_table_privilege('hid_ehr_runtime','lab.accessions','INSERT')
     or has_table_privilege('hid_ehr_runtime','lab.specimens','UPDATE')
     or has_table_privilege('hid_ocr_runtime','lab.accessions','INSERT')
     or has_table_privilege('hid_ocr_runtime','lab.specimens','UPDATE')
     or has_table_privilege('hid_ocr_worker','lab.specimens','UPDATE')
     or has_table_privilege('hid_lab_runtime','identity.patients','INSERT') then
    raise exception 'Lab accession/specimen ownership boundary is invalid';
  end if;
  if not has_table_privilege('hid_lab_runtime','lab.test_executions','INSERT')
     or not has_table_privilege('hid_lab_runtime','lab.test_executions','UPDATE')
     or not has_table_privilege('hid_lab_runtime','lab.result_revisions','INSERT')
     or has_table_privilege('hid_ehr_runtime','lab.test_executions','INSERT')
     or has_table_privilege('hid_ehr_runtime','lab.results','UPDATE')
     or has_table_privilege('hid_ocr_runtime','lab.result_revisions','INSERT')
     or has_table_privilege('hid_ocr_worker','lab.test_executions','UPDATE') then
    raise exception 'Lab execution/result ownership boundary is invalid';
  end if;
  if not has_table_privilege('hid_pharmacy_runtime','pharmacy.work_items','INSERT')
     or not has_table_privilege('hid_pharmacy_runtime','pharmacy.dispensings','INSERT')
     or not has_table_privilege('hid_pharmacy_runtime','pharmacy.dispensing_reversals','INSERT')
     or not has_table_privilege('hid_pharmacy_runtime','pharmacy.imported_medication_evidence','INSERT')
     or not has_table_privilege('hid_pharmacy_runtime','pharmacy.outbox_events','INSERT')
     or has_table_privilege('hid_pharmacy_runtime','identity.patients','INSERT')
     or has_table_privilege('hid_pharmacy_runtime','ehr.prescriptions','UPDATE')
     or has_table_privilege('hid_pharmacy_runtime','lab.work_items','INSERT')
     or has_table_privilege('hid_ehr_runtime','pharmacy.dispensings','INSERT')
     or has_table_privilege('hid_ocr_runtime','pharmacy.imported_medication_evidence','INSERT')
     or has_table_privilege('hid_ocr_worker','pharmacy.dispensings','INSERT') then
    raise exception 'Pharmacy persistence ownership boundary is invalid';
  end if;
  if not has_table_privilege('hid_outreach_runtime','outreach.registration_cases','INSERT')
     or not has_table_privilege('hid_outreach_runtime','outreach.registration_cases','UPDATE')
     or not has_table_privilege('hid_outreach_runtime','outreach.patient_mappings','INSERT')
     or not has_table_privilege('hid_outreach_runtime','outreach.registration_case_events','INSERT')
     or not has_table_privilege('hid_outreach_runtime','outreach.outbox_events','INSERT')
     or has_table_privilege('hid_outreach_runtime','identity.patients','INSERT')
     or has_table_privilege('hid_outreach_runtime','ehr.encounters','INSERT')
     or has_table_privilege('hid_outreach_runtime','lab.work_items','INSERT')
     or has_table_privilege('hid_outreach_runtime','pharmacy.work_items','INSERT')
     or has_table_privilege('hid_outreach_runtime','ocr.jobs','INSERT')
     or has_table_privilege('hid_ehr_runtime','outreach.registration_cases','INSERT')
     or has_table_privilege('hid_ocr_runtime','outreach.registration_cases','INSERT') then
    raise exception 'Outreach persistence ownership boundary is invalid';
  end if;
  if not has_function_privilege('hid_ocr_worker', 'ocr.claim_worker_job(text,integer)', 'EXECUTE')
     or not has_function_privilege('hid_ocr_worker', 'ocr.complete_worker_job(uuid,uuid,text,text,text,text,text,jsonb,numeric,jsonb,text)', 'EXECUTE')
     or has_function_privilege('hid_ocr_worker', 'ocr.claim_next_job(text)', 'EXECUTE')
     or has_table_privilege('hid_ocr_worker', 'ocr.jobs', 'SELECT')
     or has_table_privilege('hid_ocr_worker', 'ocr.jobs', 'UPDATE') then
    raise exception 'OCR worker is not constrained to lease-bound commands';
  end if;
  -- OCR queue metrics (0075): only the worker executes the aggregate command
  -- (besides its owner). The non-login technical owner holds exactly SELECT on
  -- ocr.jobs (status, queued_at) and nothing else and reads rows only through
  -- one exact policy. Its memberships are checked with the other technical
  -- owners below.
  if not has_function_privilege('hid_ocr_worker', 'ocr.worker_queue_metrics()', 'EXECUTE')
     or has_function_privilege('public', 'ocr.worker_queue_metrics()', 'EXECUTE')
     or (select coalesce(array_agg(distinct privilege.grantee::regrole::text), '{}')
           from pg_proc proc, aclexplode(proc.proacl) privilege
          where proc.oid = 'ocr.worker_queue_metrics()'::regprocedure
            and privilege.grantee <> proc.proowner) <> array['hid_ocr_worker']
     or (select owner_role.rolname from pg_proc proc join pg_roles owner_role on owner_role.oid = proc.proowner
          where proc.oid = 'ocr.worker_queue_metrics()'::regprocedure) <> 'hid_ocr_queue_metrics'
     or not (select prosecdef from pg_proc where oid = 'ocr.worker_queue_metrics()'::regprocedure)
     or (select coalesce(array_agg(relation.oid::regclass::text || '.' || attribute.attname || ':' || privilege.privilege_type
              order by relation.oid::regclass::text, attribute.attname, privilege.privilege_type), '{}')
           from pg_class relation
           join pg_attribute attribute on attribute.attrelid = relation.oid
           cross join lateral aclexplode(attribute.attacl) privilege
          where privilege.grantee = 'hid_ocr_queue_metrics'::regrole)
        <> array['ocr.jobs.queued_at:SELECT', 'ocr.jobs.status:SELECT']
     or exists (
       select 1 from pg_class relation, aclexplode(relation.relacl) privilege
        where privilege.grantee = 'hid_ocr_queue_metrics'::regrole
     )
     or not exists (
       select 1 from pg_policy policy
        where policy.polrelid = 'ocr.jobs'::regclass and policy.polname = 'ocr_jobs_queue_metrics_read'
          and policy.polcmd = 'r' and policy.polpermissive
          and policy.polroles = array['hid_ocr_queue_metrics'::regrole::oid]
          and pg_get_expr(policy.polqual, policy.polrelid) = 'true'
     ) then
    raise exception 'OCR queue metrics command privileges are inconsistent';
  end if;
  -- Platform control reads (launch, P8-CONTROL): platform.control_enabled(text)
  -- belongs to the non-login technical role hid_platform_control_reader, so it
  -- does not depend on its owner bypassing FORCE ROW LEVEL SECURITY. The role
  -- holds exactly SELECT on platform.control_settings (control_key, enabled),
  -- reads rows only through one exact policy, has USAGE on schemas platform
  -- and auth only (auth to plan the table's PUBLIC policy), owns nothing else
  -- and receives no function grant. EXECUTE stays with PUBLIC (0040), and
  -- platform.require_control_enabled keeps its owner.
  if (select owner_role.rolname from pg_proc proc join pg_roles owner_role on owner_role.oid = proc.proowner
        where proc.oid = 'platform.control_enabled(text)'::regprocedure) <> 'hid_platform_control_reader'
     or not (select prosecdef from pg_proc where oid = 'platform.control_enabled(text)'::regprocedure)
     or not has_function_privilege('public', 'platform.control_enabled(text)', 'EXECUTE')
     or not has_function_privilege('public', 'platform.require_control_enabled(text)', 'EXECUTE')
     or (select proowner from pg_proc where oid = 'platform.require_control_enabled(text)'::regprocedure)
        <> (select relowner from pg_class where oid = 'platform.control_settings'::regclass)
     or (select count(*) from pg_proc where proowner = 'hid_platform_control_reader'::regrole) <> 1
     or exists (select 1 from pg_class where relowner = 'hid_platform_control_reader'::regrole)
     or exists (select 1 from pg_namespace where nspowner = 'hid_platform_control_reader'::regrole)
     or (select coalesce(array_agg(relation.oid::regclass::text || '.' || attribute.attname || ':' || privilege.privilege_type
              order by relation.oid::regclass::text, attribute.attname, privilege.privilege_type), '{}')
           from pg_class relation
           join pg_attribute attribute on attribute.attrelid = relation.oid
           cross join lateral aclexplode(attribute.attacl) privilege
          where privilege.grantee = 'hid_platform_control_reader'::regrole)
        <> array['platform.control_settings.control_key:SELECT', 'platform.control_settings.enabled:SELECT']
     or exists (
       select 1 from pg_class relation, aclexplode(relation.relacl) privilege
        where privilege.grantee = 'hid_platform_control_reader'::regrole
     )
     or exists (
       select 1 from pg_proc proc, aclexplode(proc.proacl) privilege
        where privilege.grantee = 'hid_platform_control_reader'::regrole
          and proc.proowner <> 'hid_platform_control_reader'::regrole
     )
     or (select coalesce(array_agg(namespace_row.nspname::text order by namespace_row.nspname), '{}')
           from pg_namespace namespace_row
          where namespace_row.nspname in ('platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab',
              'pharmacy', 'outreach', 'integration', 'notification', 'migration')
            and has_schema_privilege('hid_platform_control_reader', namespace_row.oid, 'USAGE'))
        <> array['auth', 'platform']
     or not exists (
       select 1 from pg_policy policy
        where policy.polrelid = 'platform.control_settings'::regclass
          and policy.polname = 'platform_controls_definer_read'
          and policy.polcmd = 'r' and policy.polpermissive
          and policy.polroles = array['hid_platform_control_reader'::regrole::oid]
          and pg_get_expr(policy.polqual, policy.polrelid) = 'true'
     )
     or exists (
       select 1 from pg_policy policy
        where 'hid_platform_control_reader'::regrole::oid = any(policy.polroles)
          and policy.polname <> 'platform_controls_definer_read'
     ) then
    raise exception 'platform control reader privileges are inconsistent';
  end if;
  -- The six technical owners are never granted to a role and are members of
  -- none, and none may create objects: the role bootstrap grants its
  -- administrator SET and INHERIT membership in them, and each of them CREATE
  -- on one schema, only while it transfers and grants their objects, and
  -- revokes both in the same transaction. The one membership row allowed is
  -- the ADMIN OPTION that PostgreSQL 16 records, as granted by the bootstrap
  -- superuser, for a CREATEROLE administrator that is not a superuser in every
  -- role it creates; it carries no privilege and no SET ROLE, and that
  -- administrator cannot revoke it. It is allowed only when its member is the
  -- administrator running these assertions. A superuser records its own
  -- grants with the same grantor, so an ADMIN OPTION-only grant to any other
  -- role (with which a runtime login could grant itself the owner and SET ROLE
  -- to it) is refused. `is not true` also refuses the row when the runner may
  -- not create roles (administrator is null).
  foreach role_name in array array[
    'hid_event_delivery_commands', 'hid_ocr_queue_metrics', 'hid_platform_control_reader',
    'hid_lab_release_reader',
    'hid_imported_history_commands', 'hid_imported_history_importer'
  ] loop
    if exists (select 1 from pg_auth_members where member = role_name::regrole)
       or exists (
         select 1 from pg_auth_members membership
          where membership.roleid = role_name::regrole
            and (membership.admin_option and not membership.inherit_option
                 and not membership.set_option and membership.grantor = 10
                 and membership.member = administrator) is not true
       )
       or (select count(*) from pg_auth_members where roleid = role_name::regrole) > 1
       or exists (
         select 1 from pg_namespace namespace_row
          where namespace_row.nspname in ('platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab',
              'pharmacy', 'outreach', 'integration', 'notification', 'migration')
            and has_schema_privilege(role_name, namespace_row.oid, 'CREATE')
       ) then
      raise exception 'technical owner % has a member, a membership or schema CREATE privilege', role_name;
    end if;
  end loop;
  -- The OCR API appends outbox events for its own facility only (0075).
  if not has_table_privilege('hid_ocr_api_runtime', 'ocr.outbox_events', 'INSERT')
     or not exists (
       select 1 from pg_policy policy
        where policy.polrelid = 'ocr.outbox_events'::regclass and policy.polname = 'ocr_outbox_staff_insert'
          and policy.polcmd = 'a' and policy.polpermissive
          and pg_get_expr(policy.polwithcheck, policy.polrelid) = '(facility_id = platform.current_facility_id())'
     ) then
    raise exception 'OCR outbox insert policy is missing or not facility-scoped';
  end if;

  if not has_table_privilege(
       'hid_schema_test_runtime', 'ehr.document_scan_events', 'SELECT'
     )
     or has_table_privilege(
       'hid_schema_test_runtime', 'ehr.document_scan_events', 'INSERT'
     ) then
    raise exception 'schema-test runtime lacks read-only scanner evidence access';
  end if;

  if not has_function_privilege(
       'hid_ehr_runtime',
       'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)',
       'EXECUTE'
     ) then
    raise exception 'EHR runtime cannot call the constrained Identity authorization decision';
  end if;
  if not has_function_privilege(
       'hid_schema_test_runtime',
       'ehr.context_allows(uuid,uuid,text)',
       'EXECUTE'
     ) then
    raise exception 'schema-test runtime cannot exercise EHR RLS authorization policies';
  end if;
  if has_function_privilege(
       'hid_ehr_runtime',
       'identity.create_access_request(text,text,text,integer)',
       'EXECUTE'
     ) then
    raise exception 'EHR runtime has direct Identity consent mutation execution privilege';
  end if;
  if has_schema_privilege('hid_ehr_runtime', 'identity', 'CREATE') then
    raise exception 'EHR runtime can create objects in the Identity schema';
  end if;

  if not has_table_privilege('hid_audit_writer', 'audit.events', 'INSERT')
     or has_table_privilege('hid_audit_writer', 'audit.events', 'SELECT')
     or has_table_privilege('hid_audit_writer', 'audit.events', 'UPDATE')
     or has_table_privilege('hid_audit_writer', 'audit.events', 'DELETE') then
    raise exception 'audit writer is not append-only';
  end if;

  if exists (
    select 1
    from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    join pg_roles owner_role on owner_role.oid = relation.relowner
    where namespace_row.nspname in ('platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab', 'pharmacy', 'outreach', 'integration')
      and relation.relkind in ('r', 'p', 'S')
      and owner_role.rolname in (
        'hid_identity_runtime', 'hid_ehr_runtime', 'hid_api_runtime',
        'hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_ocr_api_runtime',
        'hid_audit_writer', 'hid_document_scanner', 'hid_ocr_runtime',
        'hid_ocr_worker', 'hid_lab_runtime', 'hid_pharmacy_runtime',
        'hid_pharmacy_api_runtime', 'hid_outreach_runtime',
        'hid_outreach_api_runtime', 'hid_schema_test_runtime',
        'hid_event_delivery_commands', 'hid_event_dispatcher',
        'hid_ocr_queue_metrics', 'hid_platform_control_reader', 'hid_lab_release_reader',
        'hid_imported_history_commands', 'hid_imported_history_importer'
      )
  ) then
    raise exception 'a runtime or test role owns a protected application relation';
  end if;
end
$$;

-- The launch module set (0084, 0091 and 0097, decision D17, ADR-058): Lab,
-- Pharmacy, OCR and Outreach are off, EHR lab ordering is off and document
-- uploads are off. No role holds a permission of a module that is off (lab.*,
-- pharmacy.*, ocr.*, outreach.*), the EHR lab-ordering write or
-- ehr.document.write, so the routes that need them answer 403 before any
-- write and Health-id hides their navigation and actions. The EHR reads and
-- writes of the launch set stay. Re-enabling a module takes its own reviewed
-- migration that grants the permissions again and changes this assertion with
-- it. Break-glass is the first (D9, owner decision of 2026-10-14, ADR-058
-- addendum): 0097 grants identity.break-glass.write again to exactly the
-- roles 0010 granted it to, doctor, clinician and nurse, and no other role may
-- hold it; its platform control stays an operator's step.
do $$
declare
  holders text;
begin
  select string_agg(format('%s holds %s', role_code, permission_code), ', ' order by role_code, permission_code)
    into holders
    from auth.role_permissions
   where permission_code ~ '^(lab|pharmacy|ocr|outreach)\.'
      or permission_code in ('ehr.lab-request.write', 'ehr.document.write')
      or (permission_code = 'identity.break-glass.write' and role_code not in ('doctor', 'clinician', 'nurse'));
  if holders is not null then
    raise exception 'a role holds a permission withdrawn by the launch module set: %', holders;
  end if;
  select string_agg(format('%s lacks %s', expected.role_code, expected.permission_code), ', ')
    into holders
    from (values ('doctor', 'ehr.lab-request.read'), ('clinician', 'ehr.lab-request.read'),
                 ('lab', 'ehr.lab-request.read'), ('doctor', 'ehr.prescription.write'),
                 ('clinician', 'ehr.prescription.write'),
                 ('doctor', 'ehr.document.read'), ('clinician', 'ehr.document.read'),
                 ('nurse', 'ehr.document.read'), ('lab', 'ehr.document.read'),
                 ('doctor', 'ehr.encounter.read'), ('nurse', 'ehr.encounter.read'),
                 ('doctor', 'identity.consent.write'), ('clinician', 'identity.consent.write'),
                 ('nurse', 'identity.consent.write'),
                 ('doctor', 'identity.patient-access-pin.verify'),
                 ('clinician', 'identity.patient-access-pin.verify'),
                 ('nurse', 'identity.patient-access-pin.verify'),
                 ('doctor', 'identity.break-glass.write'),
                 ('clinician', 'identity.break-glass.write'),
                 ('nurse', 'identity.break-glass.write'))
         expected(role_code, permission_code)
   where not exists (select 1 from auth.role_permissions held
                      where held.role_code = expected.role_code and held.permission_code = expected.permission_code);
  if holders is not null then
    raise exception 'the launch module set withdrew a permission it must keep: %', holders;
  end if;
end
$$;

-- 0091 objects. The patient-self RLS context is a security-definer check
-- with a pinned search_path that only the EHR runtime (and the test role)
-- may call (PSELF-RLS); the PIN-use inbox trigger function is internal; the
-- patient's access-request list is reachable only through its session-bound
-- wrapper (CONSENT-GRANTEE).
do $$
declare
  checked record;
begin
  select prosecdef, proconfig into checked from pg_proc where oid = 'ehr.patient_self_context(uuid)'::regprocedure;
  if not checked.prosecdef or checked.proconfig is distinct from array['search_path=pg_catalog, pg_temp'] then
    raise exception 'ehr.patient_self_context must be SECURITY DEFINER with search_path pg_catalog, pg_temp';
  end if;
  if not has_function_privilege('hid_ehr_runtime', 'ehr.patient_self_context(uuid)', 'EXECUTE')
     or has_function_privilege('public', 'ehr.patient_self_context(uuid)', 'EXECUTE')
     or has_function_privilege('hid_identity_runtime', 'ehr.patient_self_context(uuid)', 'EXECUTE')
     or has_function_privilege('hid_notification_worker', 'ehr.patient_self_context(uuid)', 'EXECUTE') then
    raise exception 'ehr.patient_self_context must be executable by the EHR runtime only';
  end if;
  -- Exactly: no grant beside the EHR runtime and the test role, whichever
  -- role it would name (PSELF-RLS; the patient record release keeps it).
  if (select coalesce(array_agg(privilege.grantee::regrole::text order by privilege.grantee::regrole::text), '{}')
        from pg_proc proc, aclexplode(proc.proacl) privilege
       where proc.oid = 'ehr.patient_self_context(uuid)'::regprocedure and privilege.grantee <> proc.proowner)
     is distinct from array['hid_ehr_runtime', 'hid_schema_test_runtime'] then
    raise exception 'ehr.patient_self_context must be granted to hid_ehr_runtime and hid_schema_test_runtime only';
  end if;
  if to_regprocedure('notification.on_identity_pin_outbox_created()') is null
     or not exists (select 1 from pg_trigger
                     where tgrelid = 'identity.outbox_events'::regclass and tgname = 'pin_use_notification_inbox'
                       and tgfoid = 'notification.on_identity_pin_outbox_created()'::regprocedure and tgenabled = 'O') then
    raise exception 'the PIN-use inbox trigger is missing';
  end if;
  if has_function_privilege('public', 'notification.on_identity_pin_outbox_created()', 'EXECUTE')
     or has_function_privilege('hid_identity_runtime', 'notification.on_identity_pin_outbox_created()', 'EXECUTE')
     or has_function_privilege('hid_notification_worker', 'notification.on_identity_pin_outbox_created()', 'EXECUTE') then
    raise exception 'the PIN-use inbox trigger function must not be callable by a runtime role';
  end if;
  if not has_function_privilege('hid_identity_runtime', 'identity.list_my_patient_access_requests(text,uuid)', 'EXECUTE')
     or has_function_privilege('public', 'identity.list_my_patient_access_requests(text,uuid)', 'EXECUTE')
     or has_function_privilege('hid_identity_runtime', 'identity.list_my_access_requests()', 'EXECUTE')
     or has_function_privilege('public', 'identity.list_my_access_requests()', 'EXECUTE') then
    raise exception 'the patient access-request list must be reachable only through its session-bound wrapper';
  end if;
end
$$;

-- Patient record release (owner decision 4 of 2026-10-16, D7). The view of
-- the patient's released Lab results belongs to the technical owner
-- hid_lab_release_reader: it is a security-barrier view (not
-- security_invoker), selected only by hid_ehr_runtime and the test role.
-- Its ACL holds exactly those two SELECT entries from the first bootstrap
-- run on: no entry of the owner itself, which the migration's REVOKE ... FROM
-- PUBLIC would otherwise leave until the next run (release checklist P36).
-- Its owner reads exactly the listed columns through one exact `true` policy
-- per table, holds no schema USAGE, no table or function privilege and no
-- EXECUTE on ehr.patient_self_context, and owns nothing else. The EHR runtime
-- reaches no Lab object; the Lab runtimes reach neither the view nor the
-- patient-self context, and hold no USAGE on schema ehr (D17).
do $$
begin
  if (select concat_ws('|', relation.relkind, relation.relowner::regrole::text,
        array_to_string(relation.reloptions, ','))
        from pg_class relation where relation.oid = 'ehr.patient_released_lab_results'::regclass)
     is distinct from 'v|hid_lab_release_reader|security_barrier=true'
     or (select coalesce(array_agg(privilege.grantee::regrole::text || ':' || privilege.privilege_type
              order by privilege.grantee::regrole::text, privilege.privilege_type), '{}')
           from pg_class relation, aclexplode(relation.relacl) privilege
          where relation.oid = 'ehr.patient_released_lab_results'::regclass)
        is distinct from array['hid_ehr_runtime:SELECT', 'hid_schema_test_runtime:SELECT'] then
    raise exception 'ehr.patient_released_lab_results must be the technical owner''s security-barrier view, selected only by the EHR runtime and the test role, with no entry of its owner';
  end if;
  if (select coalesce(array_agg(relation.oid::regclass::text || '.' || attribute.attname || ':' || privilege.privilege_type
          order by relation.oid::regclass::text, attribute.attname, privilege.privilege_type), '{}')
        from pg_class relation
        join pg_attribute attribute on attribute.attrelid = relation.oid
        cross join lateral aclexplode(attribute.attacl) privilege
       where privilege.grantee = 'hid_lab_release_reader'::regrole)
     is distinct from array[
       'ehr.encounters.facility_id:SELECT', 'ehr.encounters.id:SELECT', 'ehr.encounters.patient_id:SELECT',
       'ehr.encounters.status:SELECT',
       'ehr.lab_requests.facility_id:SELECT', 'ehr.lab_requests.id:SELECT', 'ehr.lab_requests.patient_id:SELECT',
       'ehr.lab_requests.status:SELECT',
       'lab.result_invalidations.patient_id:SELECT', 'lab.result_invalidations.result_id:SELECT',
       'lab.result_invalidations.result_version:SELECT',
       'lab.result_releases.facility_id:SELECT', 'lab.result_releases.patient_id:SELECT',
       'lab.result_releases.released_at:SELECT', 'lab.result_releases.result_id:SELECT',
       'lab.result_releases.result_version:SELECT',
       'lab.result_revisions.abnormal_flag:SELECT', 'lab.result_revisions.facility_id:SELECT',
       'lab.result_revisions.numeric_value:SELECT', 'lab.result_revisions.patient_id:SELECT',
       'lab.result_revisions.reference_range:SELECT', 'lab.result_revisions.result_id:SELECT',
       'lab.result_revisions.result_type:SELECT', 'lab.result_revisions.revision_kind:SELECT',
       'lab.result_revisions.text_value:SELECT', 'lab.result_revisions.unit:SELECT',
       'lab.result_revisions.version:SELECT',
       'lab.results.execution_id:SELECT', 'lab.results.facility_id:SELECT', 'lab.results.id:SELECT',
       'lab.results.patient_id:SELECT',
       'lab.test_executions.facility_id:SELECT', 'lab.test_executions.id:SELECT',
       'lab.test_executions.patient_id:SELECT', 'lab.test_executions.requested_test_id:SELECT',
       'lab.work_item_requested_tests.code:SELECT', 'lab.work_item_requested_tests.code_system:SELECT',
       'lab.work_item_requested_tests.facility_id:SELECT', 'lab.work_item_requested_tests.id:SELECT',
       'lab.work_item_requested_tests.name:SELECT', 'lab.work_item_requested_tests.patient_id:SELECT',
       'lab.work_item_requested_tests.work_item_id:SELECT',
       'lab.work_items.facility_id:SELECT', 'lab.work_items.id:SELECT',
       'lab.work_items.ordering_facility_id:SELECT', 'lab.work_items.patient_id:SELECT',
       'lab.work_items.source_ehr_order_id:SELECT', 'lab.work_items.source_encounter_id:SELECT'] then
    raise exception 'the Lab release reader must read exactly the released result columns and the source order and encounter status';
  end if;
  if exists (select 1 from pg_class relation, aclexplode(relation.relacl) privilege
              where privilege.grantee = 'hid_lab_release_reader'::regrole
                and relation.relowner <> 'hid_lab_release_reader'::regrole)
     or exists (select 1 from pg_proc proc, aclexplode(proc.proacl) privilege
                 where privilege.grantee = 'hid_lab_release_reader'::regrole)
     or exists (select 1 from pg_proc where proowner = 'hid_lab_release_reader'::regrole)
     or (select count(*) from pg_class where relowner = 'hid_lab_release_reader'::regrole) <> 1
     or exists (select 1 from pg_namespace where nspowner = 'hid_lab_release_reader'::regrole)
     or exists (select 1 from pg_namespace namespace_row
                 where namespace_row.nspname in ('platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab',
                     'pharmacy', 'outreach', 'integration', 'notification', 'migration')
                   and has_schema_privilege('hid_lab_release_reader', namespace_row.oid, 'USAGE'))
     or has_function_privilege('hid_lab_release_reader', 'ehr.patient_self_context(uuid)', 'EXECUTE')
     or has_function_privilege('hid_lab_release_reader', 'identity.patient_self_session(text,uuid)', 'EXECUTE') then
    raise exception 'the Lab release reader holds a privilege beyond its column grants, or can evaluate patient-self';
  end if;
  if (select coalesce(array_agg(policy.polrelid::regclass::text order by policy.polrelid::regclass::text), '{}')
        from pg_policy policy
       where policy.polname = 'patient_release_reader_read' and policy.polcmd = 'r' and policy.polpermissive
         and policy.polroles = array['hid_lab_release_reader'::regrole::oid]
         and pg_get_expr(policy.polqual, policy.polrelid) = 'true' and policy.polwithcheck is null)
     is distinct from array['ehr.lab_requests', 'lab.result_invalidations', 'lab.result_releases',
       'lab.result_revisions', 'lab.results', 'lab.test_executions', 'lab.work_item_requested_tests',
       'lab.work_items']
     or exists (select 1 from pg_policy policy
                 where 'hid_lab_release_reader'::regrole::oid = any(policy.polroles)
                   and policy.polname <> 'patient_release_reader_read') then
    raise exception 'the Lab release reader must read through exactly one true policy on each of its eight tables';
  end if;
  if has_schema_privilege('hid_ehr_runtime', 'lab', 'USAGE')
     or exists (select 1 from pg_class relation join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
                 where namespace_row.nspname = 'lab' and relation.relkind in ('r', 'p', 'v')
                   and has_any_column_privilege('hid_ehr_runtime', relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES')) then
    raise exception 'the EHR runtime must reach the released Lab results through the view only';
  end if;
  if exists (select 1 from unnest(array['hid_lab_runtime', 'hid_lab_api_runtime', 'public']) lab_role(role_name)
              where has_table_privilege(lab_role.role_name, 'ehr.patient_released_lab_results', 'SELECT')
                 or has_function_privilege(lab_role.role_name, 'ehr.patient_self_context(uuid)', 'EXECUTE')
                 or (lab_role.role_name <> 'public' and has_schema_privilege(lab_role.role_name, 'ehr', 'USAGE'))) then
    raise exception 'Lab never reaches the patient-self context or the patient release view (D17)';
  end if;
end
$$;

-- Imported legacy medical history (owner decision 3 of 2026-10-16, ADR-067,
-- 0099). Two NOLOGIN technical owners, created by the role bootstrap:
-- hid_imported_history_commands owns the staff read helper and the patient's
-- two sharing commands and reads exactly what they need (the patient's
-- account, the login's status, the sharing row) through column grants and
-- policies naming it, because identity.patients has row-level security and the
-- sharing tables force it, so no owner bypass is relied on;
-- hid_imported_history_importer owns the import command, reads the sealed
-- migration ledger and inserts only into the three imported tables. Only
-- hid_migration_admin may run the import, the EHR runtime and the test role
-- the staff helper, the Identity runtime and the test role the sharing
-- commands. identity.patient_self_session gains exactly one EXECUTE holder,
-- the commands owner; ehr.patient_self_context keeps its two (PSELF-RLS).
do $$
declare
  commands oid := 'hid_imported_history_commands'::regrole;
  importer oid := 'hid_imported_history_importer'::regrole;
  every_role text[] := array['public', 'hid_identity_runtime', 'hid_ehr_runtime', 'hid_api_runtime',
    'hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_ocr_api_runtime', 'hid_audit_writer',
    'hid_document_scanner', 'hid_ocr_runtime', 'hid_ocr_worker', 'hid_lab_runtime', 'hid_lab_api_runtime',
    'hid_pharmacy_runtime', 'hid_pharmacy_api_runtime', 'hid_outreach_runtime', 'hid_outreach_api_runtime',
    'hid_schema_test_runtime', 'hid_event_delivery_commands', 'hid_event_dispatcher', 'hid_notification_runtime',
    'hid_notification_api_runtime', 'hid_notification_worker', 'hid_ocr_queue_metrics',
    'hid_platform_control_reader', 'hid_lab_release_reader', 'hid_migration_admin'];
begin
  if (select coalesce(array_agg(replace(oid::regprocedure::text, ' ', '') order by oid::regprocedure::text), '{}')
        from pg_proc where proowner = commands)
     is distinct from array['ehr.imported_history_staff_read_allowed(uuid)',
       'identity.my_imported_history_sharing(text,uuid)', 'identity.set_my_imported_history_sharing(text,uuid,boolean)']
     or (select coalesce(array_agg(replace(oid::regprocedure::text, ' ', '')), '{}') from pg_proc where proowner = importer)
     is distinct from array['ehr.import_legacy_medical_history(uuid,uuid,text,jsonb)']
     or exists (select 1 from pg_proc where proowner in (commands, importer) and (not prosecdef
          or proconfig is distinct from case when proowner = importer
            then array['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'plan_cache_mode=force_custom_plan']
            else array['search_path=pg_catalog, pg_temp'] end))
     or exists (select 1 from pg_class where relowner in (commands, importer))
     or exists (select 1 from pg_namespace where nspowner in (commands, importer)) then
    raise exception 'the imported history technical owners must own exactly their pinned security-definer commands and nothing else';
  end if;
  -- The bootstrap leaves no owner entry on their functions, on its first run
  -- as on a rerun, so that every run leaves the same ACL (P38).
  if exists (select 1 from pg_proc proc, aclexplode(proc.proacl) privilege
              where proc.proowner in (commands, importer) and privilege.grantee = proc.proowner) then
    raise exception 'the imported history technical owners must hold no EXECUTE entry on their own functions';
  end if;
  -- The staff policies' binding function runs as its caller: only the EHR
  -- runtime and the test role may run it, and it pins its search path.
  if to_regprocedure('ehr.imported_history_staff_patient()') is null then
    raise exception 'ehr.imported_history_staff_patient() is missing';
  end if;
  if (select prosecdef or provolatile <> 's' or proconfig is distinct from array['search_path=pg_catalog, pg_temp']
           from pg_proc where oid = to_regprocedure('ehr.imported_history_staff_patient()'))
     or exists (select 1 from unnest(every_role) runtime(role_name)
                 where has_function_privilege(runtime.role_name, 'ehr.imported_history_staff_patient()', 'EXECUTE')
                       <> (runtime.role_name in ('hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_schema_test_runtime'))) then
    raise exception 'ehr.imported_history_staff_patient() must be a pinned invoker function that only the EHR runtime and the test role run';
  end if;
  if (select coalesce(array_agg(relation.oid::regclass::text || ':' || privilege.privilege_type
          order by relation.oid::regclass::text, privilege.privilege_type), '{}')
        from pg_class relation, aclexplode(relation.relacl) privilege where privilege.grantee = commands)
     is distinct from array['identity.imported_history_sharing:INSERT', 'identity.imported_history_sharing:SELECT',
       'identity.imported_history_sharing:UPDATE', 'identity.imported_history_sharing_events:INSERT']
     or (select coalesce(array_agg(relation.oid::regclass::text || '.' || attribute.attname || ':' || privilege.privilege_type
          order by relation.oid::regclass::text, attribute.attname, privilege.privilege_type), '{}')
        from pg_class relation join pg_attribute attribute on attribute.attrelid = relation.oid
        cross join lateral aclexplode(attribute.attacl) privilege where privilege.grantee = commands)
     is distinct from array['auth.accounts.id:SELECT', 'auth.accounts.status:SELECT',
       'identity.patients.account_id:SELECT', 'identity.patients.id:SELECT']
     or (select coalesce(array_agg(replace(proc.oid::regprocedure::text, ' ', '') order by proc.oid::regprocedure::text), '{}')
        from pg_proc proc, aclexplode(proc.proacl) privilege
       where privilege.grantee = commands and proc.proowner <> commands)
     is distinct from array['auth.membership_has_permission(text,uuid,uuid,text)', 'ehr.context_allows(uuid,uuid,text)',
       'identity.patient_self_session(text,uuid)', 'platform.current_actor_subject()',
       'platform.current_correlation_id()', 'platform.current_facility_id()', 'platform.current_membership_id()',
       'platform.current_purpose_of_use()']
     or (select coalesce(array_agg(namespace_row.nspname::text order by namespace_row.nspname), '{}') from pg_namespace namespace_row
          where namespace_row.nspname in ('platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab', 'pharmacy',
            'outreach', 'integration', 'notification', 'migration')
            and has_schema_privilege('hid_imported_history_commands', namespace_row.oid, 'USAGE'))
     is distinct from array['auth', 'ehr', 'identity', 'platform']::text[]
     or has_function_privilege('hid_imported_history_commands', 'ehr.patient_self_context(uuid)', 'EXECUTE') then
    raise exception 'the imported history commands owner must hold exactly its column, table, function and schema privileges';
  end if;
  if (select coalesce(array_agg(policy.polrelid::regclass::text || ':' || policy.polname || ':' || policy.polcmd::text
          || ':' || coalesce(pg_get_expr(policy.polqual, policy.polrelid), '-')
          || ':' || coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '-')
          order by policy.polrelid::regclass::text, policy.polname), '{}')
        from pg_policy policy where commands = any(policy.polroles))
     is distinct from array['identity.imported_history_sharing:imported_history_commands_insert:a:-:true',
       'identity.imported_history_sharing:imported_history_commands_read:r:true:-',
       'identity.imported_history_sharing:imported_history_commands_update:w:true:true',
       'identity.imported_history_sharing_events:imported_history_commands_insert:a:-:true',
       'identity.patients:imported_history_commands_read:r:true:-']
     or exists (select 1 from pg_policy policy where commands = any(policy.polroles)
                 and (policy.polroles <> array[commands] or not policy.polpermissive)) then
    raise exception 'the imported history commands owner must reach its tables through exactly its five policies';
  end if;
  if (select coalesce(array_agg(relation.oid::regclass::text || ':' || privilege.privilege_type
          order by relation.oid::regclass::text, privilege.privilege_type), '{}')
        from pg_class relation, aclexplode(relation.relacl) privilege where privilege.grantee = importer)
     is distinct from array['ehr.imported_medical_record_files:INSERT', 'ehr.imported_medical_record_files:SELECT',
       'ehr.imported_medical_record_versions:INSERT', 'ehr.imported_medical_record_versions:SELECT',
       'ehr.imported_medical_records:INSERT', 'ehr.imported_medical_records:SELECT', 'migration.runs:INSERT']
     or (select coalesce(array_agg(relation.oid::regclass::text || '.' || attribute.attname || ':' || privilege.privilege_type
          order by relation.oid::regclass::text, attribute.attname, privilege.privilege_type), '{}')
        from pg_class relation join pg_attribute attribute on attribute.attrelid = relation.oid
        cross join lateral aclexplode(attribute.attacl) privilege where privilege.grantee = importer)
     is distinct from array['migration.conflicts.run_id:SELECT',
       'migration.runs.id:SELECT', 'migration.runs.mode:SELECT', 'migration.runs.notes:SELECT',
       'migration.runs.source_checksum_sha256:SELECT', 'migration.runs.source_counts:SELECT',
       'migration.runs.source_snapshot:SELECT', 'migration.runs.source_system:SELECT', 'migration.runs.status:SELECT',
       'migration.runs.target_checksum_sha256:SELECT', 'migration.runs.target_counts:SELECT',
       'migration.source_rows.entity_type:SELECT', 'migration.source_rows.payload:SELECT',
       'migration.source_rows.payload_sha256:SELECT', 'migration.source_rows.run_id:SELECT',
       'migration.source_rows.source_pk:SELECT']
     or exists (select 1 from pg_proc proc, aclexplode(proc.proacl) privilege
                 where privilege.grantee = importer and proc.proowner <> importer)
     or (select coalesce(array_agg(namespace_row.nspname::text order by namespace_row.nspname), '{}') from pg_namespace namespace_row
          where namespace_row.nspname in ('platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab', 'pharmacy',
            'outreach', 'integration', 'notification', 'migration')
            and has_schema_privilege('hid_imported_history_importer', namespace_row.oid, 'USAGE'))
     is distinct from array['ehr', 'migration']::text[]
     or (select coalesce(array_agg(policy.polrelid::regclass::text || ':' || policy.polname || ':' || policy.polcmd::text
          || ':' || coalesce(pg_get_expr(policy.polqual, policy.polrelid), '-')
          || ':' || coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '-')
          order by policy.polrelid::regclass::text, policy.polname), '{}')
        from pg_policy policy where importer = any(policy.polroles))
     is distinct from array['ehr.imported_medical_record_files:imported_history_importer_insert:a:-:true',
       'ehr.imported_medical_record_files:imported_history_importer_read:r:true:-',
       'ehr.imported_medical_record_versions:imported_history_importer_insert:a:-:true',
       'ehr.imported_medical_record_versions:imported_history_importer_read:r:true:-',
       'ehr.imported_medical_records:imported_history_importer_insert:a:-:true',
       'ehr.imported_medical_records:imported_history_importer_read:r:true:-'] then
    raise exception 'the imported history importer must hold exactly its ledger reads, its inserts and its six policies';
  end if;
  if exists (
       select 1 from unnest(every_role) runtime(role_name)
        where has_function_privilege(runtime.role_name, 'ehr.import_legacy_medical_history(uuid,uuid,text,jsonb)', 'EXECUTE')
              <> (runtime.role_name = 'hid_migration_admin')
           or (runtime.role_name = 'hid_migration_admin' and not has_schema_privilege(runtime.role_name, 'ehr', 'USAGE'))
           or has_function_privilege(runtime.role_name, 'ehr.imported_history_staff_read_allowed(uuid)', 'EXECUTE')
              <> (runtime.role_name in ('hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_schema_test_runtime'))
           or has_function_privilege(runtime.role_name, 'identity.set_my_imported_history_sharing(text,uuid,boolean)', 'EXECUTE')
              <> (runtime.role_name in ('hid_identity_runtime', 'hid_identity_api_runtime',
                  'hid_schema_test_runtime'))
           or has_function_privilege(runtime.role_name, 'identity.my_imported_history_sharing(text,uuid)', 'EXECUTE')
              <> (runtime.role_name in ('hid_identity_runtime', 'hid_identity_api_runtime',
                  'hid_schema_test_runtime'))
           or has_table_privilege(runtime.role_name, 'ehr.imported_medical_records', 'SELECT')
              <> (runtime.role_name in ('hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_schema_test_runtime'))
           or exists (select 1 from unnest(array['ehr.imported_medical_records', 'ehr.imported_medical_record_versions',
                 'ehr.imported_medical_record_files', 'identity.imported_history_sharing',
                 'identity.imported_history_sharing_events']) imported(table_name)
               where has_table_privilege(runtime.role_name, imported.table_name, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                  or (imported.table_name like 'identity.%'
                      and has_any_column_privilege(runtime.role_name, imported.table_name, 'SELECT,INSERT,UPDATE,REFERENCES')))
     ) then
    raise exception 'only the migration administrator imports, only the EHR runtime reads imported history and runs its staff helper, and only the Identity runtime runs the sharing commands';
  end if;
  if (select coalesce(array_agg(privilege.grantee::regrole::text order by privilege.grantee::regrole::text), '{}')
        from pg_proc proc, aclexplode(proc.proacl) privilege
       where proc.oid = 'identity.patient_self_session(text,uuid)'::regprocedure and privilege.grantee <> proc.proowner)
     is distinct from array['hid_imported_history_commands']
     or (select coalesce(array_agg(privilege.grantee::regrole::text order by privilege.grantee::regrole::text), '{}')
        from pg_proc proc, aclexplode(proc.proacl) privilege
       where proc.oid = 'ehr.patient_self_context(uuid)'::regprocedure and privilege.grantee <> proc.proowner)
     is distinct from array['hid_ehr_runtime', 'hid_schema_test_runtime'] then
    raise exception 'identity.patient_self_session must be executable by the imported history commands owner alone, and ehr.patient_self_context by the EHR runtime and the test role alone';
  end if;
  if (select array_agg(role_code::text order by role_code) from auth.role_permissions
      where permission_code = 'ehr.imported-history.read')
     is distinct from array['clinician', 'doctor', 'nurse'] then
    raise exception 'ehr.imported-history.read must be held by doctor, clinician and nurse only';
  end if;
end
$$;

-- 0093 and 0094 (ADR-062, ADR-063). The Identity runtime runs the three
-- holder commands, the facility list, the in-person check command and the two
-- designation commands; no other runtime role and not PUBLIC. The
-- participation, attestation and staff-session helpers and the check guard
-- run for no role but their owner. No runtime role reaches the holder
-- events, the designations, their events or the in-person checks directly.
-- The runtime inserts only an enrollment's start columns, so it always
-- begins at verify_holder, and never writes its holder columns.
do $$
declare
  other_runtimes text[] := array[
    'hid_ehr_runtime', 'hid_api_runtime', 'hid_ehr_api_runtime', 'hid_ocr_api_runtime',
    'hid_audit_writer', 'hid_document_scanner', 'hid_ocr_runtime', 'hid_ocr_worker',
    'hid_lab_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_runtime',
    'hid_pharmacy_api_runtime', 'hid_outreach_runtime', 'hid_outreach_api_runtime',
    'hid_event_delivery_commands', 'hid_event_dispatcher', 'hid_notification_runtime',
    'hid_notification_api_runtime', 'hid_notification_worker', 'hid_ocr_queue_metrics',
    'hid_platform_control_reader', 'hid_lab_release_reader',
    'hid_imported_history_commands', 'hid_imported_history_importer'];
  every_role text[] := array['public', 'hid_identity_runtime', 'hid_identity_api_runtime',
    'hid_schema_test_runtime', 'hid_migration_admin'] || other_runtimes;
begin
  if exists (
       select 1 from unnest(array[
         'identity.record_public_patient_holder_send(uuid,char,char,integer,integer,integer)',
         'identity.record_public_patient_holder_failure(uuid,char,uuid,char,integer,integer)',
         'identity.record_public_patient_holder_proof(uuid,char,text,uuid,uuid,char,integer)',
         'identity.list_participating_facilities()',
         'identity.record_assisted_verification(uuid,char,char,text,text,text,text,text,text,char,char,integer,integer)',
         'identity.admin_facility_assisted_registration(uuid)',
         'identity.admin_set_facility_assisted_registration(uuid,bigint,text,text,text,text,text,text,text,text,char)'
       ]) command(signature)
       where not has_function_privilege('hid_identity_runtime', command.signature, 'EXECUTE')
          or not has_function_privilege('hid_identity_api_runtime', command.signature, 'EXECUTE')
          or has_function_privilege('public', command.signature, 'EXECUTE')
          or exists (select 1 from unnest(other_runtimes) runtime(role_name)
                     where has_function_privilege(runtime.role_name, command.signature, 'EXECUTE'))
     ) then
    raise exception 'the NIN holder and facility-assisted commands must be executable by the Identity runtime only';
  end if;
  if exists (
       select 1
       from unnest(array['identity.facility_assisted_registration_participating(uuid)',
         'identity.assisted_registration_actor_attested(text,uuid,uuid)', 'auth.staff_session_is_mfa()',
         'identity.guard_assisted_verification_change()']) helper(signature),
         unnest(every_role) runtime(role_name)
       where has_function_privilege(runtime.role_name, helper.signature, 'EXECUTE')
     ) then
    raise exception 'the facility-assisted helpers must run only inside their commands';
  end if;
  if exists (
       select 1
       from unnest(array['identity.public_patient_holder_events', 'identity.facility_assisted_registration',
         'identity.facility_assisted_registration_events', 'identity.assisted_registration_verifications'])
           evidence(table_name),
         unnest(every_role) runtime(role_name)
       where has_table_privilege(runtime.role_name, evidence.table_name,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or has_any_column_privilege(runtime.role_name, evidence.table_name, 'SELECT,INSERT,UPDATE,REFERENCES')
     ) then
    raise exception 'a runtime role can reach the holder events, the designations or the in-person checks';
  end if;
  if has_table_privilege('hid_identity_runtime', 'identity.public_patient_enrollments', 'INSERT,UPDATE')
     or exists (
       select 1 from unnest(array['state', 'holder_method', 'holder_verified_at', 'holder_challenge_id',
         'holder_verification_id', 'desk_code_hmac', 'desk_code_salt', 'desk_code_issues']) column_row(name)
       where has_column_privilege('hid_identity_runtime', 'identity.public_patient_enrollments', column_row.name,
         'INSERT'))
     or exists (
       select 1 from unnest(array['holder_method', 'holder_verified_at', 'holder_challenge_id',
         'holder_verification_id']) column_row(name)
       where has_column_privilege('hid_identity_runtime', 'identity.public_patient_enrollments', column_row.name,
         'UPDATE'))
     or exists (
       select 1 from unnest(array['holder_recipient_hmac', 'desk_code_hmac', 'desk_code_expires_at', 'desk_code_salt',
         'desk_code_issues']) column_row(name)
       where not has_column_privilege('hid_identity_runtime', 'identity.public_patient_enrollments', column_row.name,
         'UPDATE')) then
    raise exception 'the Identity runtime must insert only the start columns of an enrollment and never write its holder columns';
  end if;
  if (select array_agg(role_code::text order by role_code) from auth.role_permissions
      where permission_code = 'identity.patient.assisted_registration')
     is distinct from array['clinician', 'doctor', 'nurse'] then
    raise exception 'identity.patient.assisted_registration must be held by doctor, clinician and nurse only';
  end if;
end
$$;

-- 0095 (ADR-064). The notification worker learns a patient's verified login
-- email only through the claim-bound integration.notification_recipient_for_claim,
-- owned by the event-delivery technical owner, which alone executes the
-- private helper that reads identity.patients and auth.accounts as their
-- owner, with the login's deletion requests. The exact ACLs: the worker on
-- the claim function and the technical owner on the helper, besides their
-- owners. Neither the worker, its notification aggregate nor the technical
-- owner holds any table or column privilege on the three tables.
do $$
declare
  claim_function regprocedure := to_regprocedure('integration.notification_recipient_for_claim(uuid,uuid,uuid)');
  helper regprocedure := to_regprocedure('integration.notification_recipient_state(uuid)');
begin
  if claim_function is null or helper is null then
    raise exception 'the 0095 notification recipient functions are missing';
  end if;
  if (select proowner from pg_proc where oid = claim_function) <> 'hid_event_delivery_commands'::regrole
     or (select proowner from pg_proc where oid = helper)
        <> (select relowner from pg_class where oid = 'identity.patients'::regclass)
     or exists (select 1 from pg_proc where oid in (claim_function, helper)
                 and (not prosecdef or proconfig is distinct from array['search_path=pg_catalog, pg_temp'])) then
    raise exception 'the 0095 recipient functions have the wrong owner, security or search_path';
  end if;
  if (select proacl from pg_proc where oid = claim_function) is null
     or (select coalesce(array_agg(distinct privilege.grantee::regrole::text), '{}')
           from pg_proc proc, aclexplode(proc.proacl) privilege
          where proc.oid = claim_function and privilege.grantee <> proc.proowner) <> array['hid_notification_worker']
     or (select proacl from pg_proc where oid = helper) is null
     or (select coalesce(array_agg(distinct privilege.grantee::regrole::text), '{}')
           from pg_proc proc, aclexplode(proc.proacl) privilege
          where proc.oid = helper and privilege.grantee <> proc.proowner) <> array['hid_event_delivery_commands']
     or not has_function_privilege('hid_notification_worker', claim_function, 'EXECUTE')
     or has_function_privilege('hid_notification_worker', helper, 'EXECUTE')
     or has_function_privilege('hid_notification_runtime', claim_function, 'EXECUTE')
     or has_function_privilege('hid_notification_api_runtime', claim_function, 'EXECUTE') then
    raise exception 'the 0095 recipient function grants are broader or narrower than the worker and its technical owner';
  end if;
  if exists (
       select 1
       from unnest(array['hid_notification_worker', 'hid_notification_runtime', 'hid_notification_api_runtime',
         'hid_event_delivery_commands', 'hid_event_dispatcher']) runtime(role_name),
         unnest(array['identity.patients', 'auth.accounts', 'identity.patient_account_deletion_requests']) protected(table_name)
       where has_table_privilege(runtime.role_name, protected.table_name,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or has_any_column_privilege(runtime.role_name, protected.table_name, 'SELECT,INSERT,UPDATE,REFERENCES')
     ) then
    raise exception 'a notification or event-delivery role can read identity.patients, auth.accounts or identity.patient_account_deletion_requests directly';
  end if;
end
$$;

-- Patient record chat (owner decision 1 of 2026-10-16). The EHR runtime
-- reads, writes and deletes the patient's own history (row-level security
-- binds every row to the patient-self transaction) and never updates it; it
-- runs the two limit commands and the legal hold check of its own history,
-- and reaches no limit table. No other role, the schema-test role and the
-- imported history's two technical owners included, holds any privilege on
-- the chat tables or commands; PUBLIC executes none of the commands.
do $$
declare
  other_roles text[] := array[
    'public', 'hid_identity_runtime', 'hid_api_runtime', 'hid_identity_api_runtime', 'hid_ocr_api_runtime',
    'hid_audit_writer', 'hid_document_scanner', 'hid_ocr_runtime', 'hid_ocr_worker',
    'hid_lab_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_runtime',
    'hid_pharmacy_api_runtime', 'hid_outreach_runtime', 'hid_outreach_api_runtime', 'hid_migration_admin',
    'hid_schema_test_runtime', 'hid_event_delivery_commands', 'hid_event_dispatcher', 'hid_notification_runtime',
    'hid_notification_api_runtime', 'hid_notification_worker', 'hid_ocr_queue_metrics',
    'hid_platform_control_reader', 'hid_lab_release_reader',
    'hid_imported_history_commands', 'hid_imported_history_importer'];
  history text[] := array['ehr.patient_chat_conversations', 'ehr.patient_chat_messages'];
  limits text[] := array['ehr.record_chat_usage_counters', 'ehr.record_chat_reservations',
    'ehr.record_chat_daily_budget'];
  commands text[] := array['ehr.reserve_record_chat(text,uuid,integer,bigint)',
    'ehr.settle_record_chat(uuid,integer,integer,integer,integer,text)', 'ehr.record_chat_history_on_hold(uuid)'];
begin
  -- PUBLIC and the 28 group roles listed at the top of this file, less the
  -- EHR runtime and its API role, each an existing NOLOGIN role.
  if cardinality(other_roles) <> 27
     or (select count(*) from pg_roles role_row
          where role_row.rolname = any (other_roles) and not role_row.rolcanlogin) <> 26 then
    raise exception 'the record chat check must name every group role but the EHR runtime and its API role';
  end if;
  if exists (select 1 from unnest(history) relation(name)
              where not has_table_privilege('hid_ehr_runtime', relation.name, 'SELECT')
                 or not has_table_privilege('hid_ehr_runtime', relation.name, 'INSERT')
                 or not has_table_privilege('hid_ehr_runtime', relation.name, 'DELETE')
                 or has_table_privilege('hid_ehr_runtime', relation.name, 'UPDATE,TRUNCATE,REFERENCES,TRIGGER')
                 or has_any_column_privilege('hid_ehr_runtime', relation.name, 'UPDATE,REFERENCES')) then
    raise exception 'the EHR runtime must select, insert and delete the record chat history and never update it';
  end if;
  if exists (select 1 from unnest(limits) relation(name)
              where has_table_privilege('hid_ehr_runtime', relation.name,
                      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 or has_any_column_privilege('hid_ehr_runtime', relation.name, 'SELECT,INSERT,UPDATE,REFERENCES')) then
    raise exception 'the EHR runtime must reach the record chat limits through their commands only';
  end if;
  if exists (select 1 from unnest(commands) command(signature)
              where not has_function_privilege('hid_ehr_runtime', command.signature, 'EXECUTE')
                 or not has_function_privilege('hid_ehr_api_runtime', command.signature, 'EXECUTE')) then
    raise exception 'the EHR runtime must execute the record chat commands';
  end if;
  if exists (
       select 1 from unnest(other_roles) runtime(role_name), unnest(history || limits) relation(name)
        where has_table_privilege(runtime.role_name, relation.name,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           or has_any_column_privilege(runtime.role_name, relation.name, 'SELECT,INSERT,UPDATE,REFERENCES'))
     or exists (
       select 1 from unnest(other_roles) runtime(role_name), unnest(commands) command(signature)
        where has_function_privilege(runtime.role_name, command.signature, 'EXECUTE')) then
    raise exception 'a role other than the EHR runtime can reach the record chat tables or commands';
  end if;
end
$$;

select
  rolname,
  rolcanlogin,
  rolsuper,
  rolcreaterole,
  rolcreatedb,
  rolbypassrls,
  rolinherit
from pg_roles
where rolname like 'hid_%'
order by rolname;
