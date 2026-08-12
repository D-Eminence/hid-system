-- Runtime role and grant acceptance checks.
-- Run as the database security administrator after runtime-grants.sql.
-- This file is assertion-only and does not mutate roles or application data.

do $$
declare
  role_name text;
  table_name text;
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
    'hid_notification_api_runtime', 'hid_notification_worker'
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
  if not has_table_privilege('hid_identity_runtime', 'auth.otp_challenges', 'SELECT,INSERT,UPDATE')
     or not has_table_privilege('hid_identity_runtime', 'auth.otp_rate_limits', 'SELECT,INSERT,UPDATE')
     or not has_table_privilege('hid_identity_runtime', 'identity.patient_assurance_states', 'SELECT,INSERT,UPDATE')
     or has_table_privilege('hid_identity_runtime', 'notification.device_registrations', 'SELECT') then
    raise exception 'Identity OTP and progressive-assurance ownership is inconsistent';
  end if;
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
        'hid_event_delivery_commands', 'hid_event_dispatcher'
      )
  ) then
    raise exception 'a runtime or test role owns a protected application relation';
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
