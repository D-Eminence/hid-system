-- Run separately as an RDS security administrator after schema migration.
-- This file creates NOLOGIN group roles only. Login-role membership and
-- credentials remain environment-specific infrastructure.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    create role hid_identity_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    create role hid_ehr_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_api_runtime') then
    create role hid_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_identity_api_runtime') then
    create role hid_identity_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_ehr_api_runtime') then
    create role hid_ehr_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_ocr_api_runtime') then
    create role hid_ocr_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_audit_writer') then
    create role hid_audit_writer nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_document_scanner') then
    create role hid_document_scanner nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_ocr_runtime') then
    create role hid_ocr_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_ocr_worker') then
    create role hid_ocr_worker nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_lab_runtime') then
    create role hid_lab_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_lab_api_runtime') then
    create role hid_lab_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_pharmacy_runtime') then
    create role hid_pharmacy_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_pharmacy_api_runtime') then
    create role hid_pharmacy_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_outreach_runtime') then
    create role hid_outreach_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_outreach_api_runtime') then
    create role hid_outreach_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_migration_admin') then
    create role hid_migration_admin nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    create role hid_schema_test_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_event_delivery_commands') then
    create role hid_event_delivery_commands nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_event_dispatcher') then
    create role hid_event_dispatcher nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_notification_runtime') then
    create role hid_notification_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_notification_api_runtime') then
    create role hid_notification_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_notification_worker') then
    create role hid_notification_worker nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
  end if;
end
$$;

-- Reassert safety attributes on every run so prior manual role creation cannot
-- silently retain login, ownership-escalation, or RLS-bypass capabilities.
alter role hid_identity_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_ehr_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
alter role hid_identity_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
alter role hid_ehr_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
alter role hid_ocr_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
alter role hid_audit_writer nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_document_scanner nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_ocr_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_ocr_worker nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_lab_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_lab_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
alter role hid_pharmacy_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_pharmacy_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
alter role hid_outreach_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_outreach_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
alter role hid_migration_admin nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_schema_test_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
alter role hid_event_delivery_commands nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_event_dispatcher nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_notification_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
alter role hid_notification_api_runtime nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;
alter role hid_notification_worker nologin nosuperuser nocreatedb nocreaterole inherit nobypassrls;

comment on role hid_identity_runtime is
  'Identity and authentication persistence privileges for an Identity-owned service boundary.';
comment on role hid_ehr_runtime is
  'EHR persistence privileges with no direct Identity table access.';
comment on role hid_api_runtime is
  'Retired modular-monolith aggregate retained as a privilege-free compatibility role.';
comment on role hid_identity_api_runtime is
  'Extracted Identity API aggregate: Identity/authentication persistence plus append-only semantic audit.';
comment on role hid_ehr_api_runtime is
  'Extracted EHR API aggregate: EHR persistence plus append-only semantic audit; no OCR or Identity mutation authority.';
comment on role hid_ocr_api_runtime is
  'Extracted OCR API aggregate: OCR persistence plus append-only semantic audit; no EHR or Identity mutation authority.';
comment on role hid_audit_writer is
  'Append-only semantic audit writer. No audit read, update, or delete privilege.';
comment on role hid_document_scanner is
  'Isolated document scanner command role with no direct table privilege.';
comment on role hid_ocr_runtime is
  'OCR-owned job, extraction, validation, publication, and outbox persistence.';
comment on role hid_ocr_worker is
  'Isolated OCR workload command role with no direct table privilege.';
comment on role hid_lab_runtime is
  'Lab-owned imported evidence persistence with no Identity, EHR, or OCR mutation authority.';
comment on role hid_lab_api_runtime is
  'Extracted Lab API aggregate: Lab persistence plus append-only semantic audit only.';
comment on role hid_pharmacy_runtime is
  'Pharmacy-owned work, dispensing, reversal, imported-evidence, and outbox persistence only.';
comment on role hid_pharmacy_api_runtime is
  'Extracted Pharmacy API aggregate: Pharmacy persistence plus append-only semantic audit only.';
comment on role hid_outreach_runtime is
  'Outreach-owned temporary field-registration, mapping, event, idempotency, and outbox persistence only.';
comment on role hid_outreach_api_runtime is
  'Extracted Outreach API aggregate: Outreach persistence plus append-only semantic audit only.';
comment on role hid_migration_admin is
  'Migration and role-provisioning boundary. Never inherited by an application runtime login.';
comment on role hid_schema_test_runtime is
  'Test-only non-login role for transactional schema and RLS acceptance tests.';
comment on role hid_event_delivery_commands is
  'Technical owner for narrowly scoped security-definer delivery and inbox commands; never granted to a runtime login.';
comment on role hid_event_dispatcher is
  'Transport dispatcher command role with no direct domain or integration table privileges.';
comment on role hid_notification_runtime is
  'Notification-owned protected device registration and PHI-free provider reconciliation persistence.';
comment on role hid_notification_api_runtime is
  'Notification API aggregate with no Identity or clinical persistence authority.';
comment on role hid_notification_worker is
  'Ordinary-notification inbox consumer and notification persistence aggregate.';

-- Reset object grants before reapplying the intended model. This makes the
-- script corrective as well as repeatable if an older grant model was applied.
revoke all privileges on schema platform, auth, identity, ehr, audit, outreach from hid_identity_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, outreach from hid_identity_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, outreach from hid_identity_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, outreach from hid_identity_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, outreach from hid_ehr_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, outreach from hid_ehr_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, outreach from hid_ehr_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, outreach from hid_ehr_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_api_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_api_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_api_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_api_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_identity_api_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_identity_api_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_identity_api_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_identity_api_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_ehr_api_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_ehr_api_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_ehr_api_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_ehr_api_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_ocr_api_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_ocr_api_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_ocr_api_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_ocr_api_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, outreach from hid_audit_writer;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, outreach from hid_audit_writer;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, outreach from hid_audit_writer;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, outreach from hid_audit_writer;

revoke all privileges on schema platform, auth, identity, ehr, audit, outreach from hid_document_scanner;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, outreach from hid_document_scanner;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, outreach from hid_document_scanner;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, outreach from hid_document_scanner;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, outreach from hid_ocr_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, outreach from hid_ocr_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, outreach from hid_ocr_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, outreach from hid_ocr_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, outreach from hid_ocr_worker;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, outreach from hid_ocr_worker;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, outreach from hid_ocr_worker;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, outreach from hid_ocr_worker;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, outreach from hid_lab_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, outreach from hid_lab_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, outreach from hid_lab_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, outreach from hid_lab_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_pharmacy_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_pharmacy_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_pharmacy_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_pharmacy_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_lab_api_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_lab_api_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_lab_api_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_lab_api_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_pharmacy_api_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_pharmacy_api_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_pharmacy_api_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_pharmacy_api_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_outreach_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_outreach_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_outreach_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_outreach_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_outreach_api_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_outreach_api_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_outreach_api_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_outreach_api_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_schema_test_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_schema_test_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_schema_test_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach from hid_schema_test_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration from hid_event_delivery_commands;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration from hid_event_delivery_commands;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration from hid_event_delivery_commands;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration from hid_event_delivery_commands;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration from hid_event_dispatcher;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration from hid_event_dispatcher;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration from hid_event_dispatcher;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration from hid_event_dispatcher;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_notification_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_notification_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_notification_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_notification_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_notification_api_runtime;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_notification_api_runtime;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_notification_api_runtime;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_notification_api_runtime;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_notification_worker;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_notification_worker;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_notification_worker;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_notification_worker;

revoke all privileges on schema notification from hid_identity_runtime, hid_ehr_runtime,
  hid_api_runtime, hid_identity_api_runtime, hid_ehr_api_runtime, hid_ocr_api_runtime,
  hid_audit_writer, hid_document_scanner, hid_ocr_runtime, hid_ocr_worker,
  hid_lab_runtime, hid_lab_api_runtime, hid_pharmacy_runtime,
  hid_pharmacy_api_runtime, hid_outreach_runtime, hid_outreach_api_runtime,
  hid_event_delivery_commands, hid_event_dispatcher, hid_schema_test_runtime;
revoke all privileges on all tables in schema notification from hid_identity_runtime, hid_ehr_runtime,
  hid_api_runtime, hid_identity_api_runtime, hid_ehr_api_runtime, hid_ocr_api_runtime,
  hid_audit_writer, hid_document_scanner, hid_ocr_runtime, hid_ocr_worker,
  hid_lab_runtime, hid_lab_api_runtime, hid_pharmacy_runtime,
  hid_pharmacy_api_runtime, hid_outreach_runtime, hid_outreach_api_runtime,
  hid_event_delivery_commands, hid_event_dispatcher, hid_schema_test_runtime;
revoke all privileges on all sequences in schema notification from hid_identity_runtime, hid_ehr_runtime,
  hid_api_runtime, hid_identity_api_runtime, hid_ehr_api_runtime, hid_ocr_api_runtime,
  hid_audit_writer, hid_document_scanner, hid_ocr_runtime, hid_ocr_worker,
  hid_lab_runtime, hid_lab_api_runtime, hid_pharmacy_runtime,
  hid_pharmacy_api_runtime, hid_outreach_runtime, hid_outreach_api_runtime,
  hid_event_delivery_commands, hid_event_dispatcher, hid_schema_test_runtime;

revoke all privileges on schema integration from hid_identity_runtime, hid_ehr_runtime,
  hid_api_runtime, hid_identity_api_runtime, hid_ehr_api_runtime, hid_ocr_api_runtime,
  hid_audit_writer, hid_document_scanner, hid_ocr_runtime, hid_ocr_worker,
  hid_lab_runtime, hid_lab_api_runtime, hid_pharmacy_runtime,
  hid_pharmacy_api_runtime, hid_outreach_runtime, hid_outreach_api_runtime,
  hid_schema_test_runtime;
revoke all privileges on all tables in schema integration from hid_identity_runtime, hid_ehr_runtime,
  hid_api_runtime, hid_identity_api_runtime, hid_ehr_api_runtime, hid_ocr_api_runtime,
  hid_audit_writer, hid_document_scanner, hid_ocr_runtime, hid_ocr_worker,
  hid_lab_runtime, hid_lab_api_runtime, hid_pharmacy_runtime,
  hid_pharmacy_api_runtime, hid_outreach_runtime, hid_outreach_api_runtime,
  hid_schema_test_runtime;
revoke all privileges on all sequences in schema integration from hid_identity_runtime, hid_ehr_runtime,
  hid_api_runtime, hid_identity_api_runtime, hid_ehr_api_runtime, hid_ocr_api_runtime,
  hid_audit_writer, hid_document_scanner, hid_ocr_runtime, hid_ocr_worker,
  hid_lab_runtime, hid_lab_api_runtime, hid_pharmacy_runtime,
  hid_pharmacy_api_runtime, hid_outreach_runtime, hid_outreach_api_runtime,
  hid_schema_test_runtime;
revoke all privileges on all functions in schema integration from hid_identity_runtime, hid_ehr_runtime,
  hid_api_runtime, hid_identity_api_runtime, hid_ehr_api_runtime, hid_ocr_api_runtime,
  hid_audit_writer, hid_document_scanner, hid_ocr_runtime, hid_ocr_worker,
  hid_lab_runtime, hid_lab_api_runtime, hid_pharmacy_runtime,
  hid_pharmacy_api_runtime, hid_outreach_runtime, hid_outreach_api_runtime,
  hid_schema_test_runtime;

revoke hid_identity_runtime from hid_ehr_runtime;
revoke hid_ehr_runtime from hid_identity_runtime;
revoke hid_identity_runtime, hid_ehr_runtime, hid_ocr_runtime, hid_audit_writer from hid_api_runtime;
revoke hid_api_runtime from hid_identity_api_runtime, hid_ehr_api_runtime, hid_ocr_api_runtime;
revoke hid_ehr_runtime, hid_ocr_runtime, hid_lab_runtime, hid_pharmacy_runtime,
  hid_outreach_runtime from hid_identity_api_runtime;
grant hid_identity_runtime, hid_audit_writer to hid_identity_api_runtime;
revoke hid_identity_runtime, hid_ocr_runtime, hid_lab_runtime, hid_pharmacy_runtime,
  hid_outreach_runtime from hid_ehr_api_runtime;
grant hid_ehr_runtime, hid_audit_writer to hid_ehr_api_runtime;
revoke hid_identity_runtime, hid_ehr_runtime, hid_lab_runtime, hid_pharmacy_runtime,
  hid_outreach_runtime from hid_ocr_api_runtime;
grant hid_ocr_runtime, hid_audit_writer to hid_ocr_api_runtime;
revoke hid_api_runtime from hid_migration_admin, hid_schema_test_runtime, hid_document_scanner, hid_ocr_worker, hid_lab_runtime, hid_pharmacy_runtime, hid_outreach_runtime;
revoke hid_migration_admin, hid_schema_test_runtime, hid_document_scanner from hid_api_runtime;
revoke hid_identity_runtime, hid_ehr_runtime, hid_lab_runtime, hid_pharmacy_runtime,
  hid_outreach_runtime, hid_audit_writer from hid_schema_test_runtime;
revoke hid_lab_runtime from hid_api_runtime;
revoke hid_identity_runtime, hid_ehr_runtime, hid_ocr_runtime from hid_lab_api_runtime;
grant hid_lab_runtime, hid_audit_writer to hid_lab_api_runtime;
revoke hid_pharmacy_runtime from hid_api_runtime;
revoke hid_identity_runtime, hid_ehr_runtime, hid_ocr_runtime, hid_lab_runtime from hid_pharmacy_api_runtime;
grant hid_pharmacy_runtime, hid_audit_writer to hid_pharmacy_api_runtime;
revoke hid_outreach_runtime from hid_api_runtime;
revoke hid_identity_runtime, hid_ehr_runtime, hid_ocr_runtime, hid_lab_runtime, hid_pharmacy_runtime from hid_outreach_api_runtime;
grant hid_outreach_runtime, hid_audit_writer to hid_outreach_api_runtime;
revoke hid_event_delivery_commands from hid_event_dispatcher;
revoke hid_event_delivery_commands, hid_event_dispatcher from hid_identity_api_runtime,
  hid_ehr_api_runtime, hid_ocr_api_runtime, hid_lab_api_runtime,
  hid_pharmacy_api_runtime, hid_outreach_api_runtime, hid_api_runtime,
  hid_schema_test_runtime;
revoke hid_identity_runtime, hid_ehr_runtime, hid_ocr_runtime, hid_lab_runtime,
  hid_pharmacy_runtime, hid_outreach_runtime, hid_audit_writer,
  hid_event_delivery_commands, hid_event_dispatcher from hid_notification_api_runtime,
  hid_notification_worker;
revoke hid_notification_runtime, hid_notification_api_runtime, hid_notification_worker
  from hid_identity_api_runtime, hid_ehr_api_runtime, hid_ocr_api_runtime,
  hid_lab_api_runtime, hid_pharmacy_api_runtime, hid_outreach_api_runtime,
  hid_api_runtime, hid_migration_admin, hid_schema_test_runtime,
  hid_event_dispatcher, hid_event_delivery_commands;
grant hid_notification_runtime to hid_notification_api_runtime, hid_notification_worker;

-- Identity owns canonical patients, registration, consent, workforce context,
-- and the local authentication persistence used by the current Identity API.
grant usage on schema platform, auth, identity, audit to hid_identity_runtime;
grant select on auth.accounts, auth.roles, auth.permissions,
  auth.role_permissions, auth.account_roles to hid_identity_runtime;
grant select, insert, update on auth.sessions to hid_identity_runtime;
grant select, insert, update, delete on auth.login_attempts to hid_identity_runtime;
grant select, insert, update on auth.otp_challenges, auth.otp_rate_limits to hid_identity_runtime;
grant insert on auth.session_events to hid_identity_runtime;
grant select on identity.organizations, identity.facilities, identity.staff,
  identity.staff_facility_memberships, identity.purpose_of_use_codes,
  identity.consent_directives, identity.consent_directive_versions,
  identity.access_requests, identity.consent_grants,
  identity.facility_status_events to hid_identity_runtime;
grant select, insert on identity.patients, identity.patient_identifiers to hid_identity_runtime;
grant select, insert, update on identity.patient_assurance_states to hid_identity_runtime;
grant select, insert, update on identity.registration_cases to hid_identity_runtime;
grant select, insert on identity.registration_case_candidates,
  identity.registration_case_events, identity.outbox_events to hid_identity_runtime;
grant usage, select on all sequences in schema auth, identity to hid_identity_runtime;
grant execute on function platform.current_actor_subject(),
  platform.current_account_id(),
  platform.current_facility_id(),
  platform.current_membership_id(),
  platform.current_correlation_id(),
  platform.current_purpose_of_use(),
  auth.account_id_for_subject(text),
  auth.account_has_active_role(uuid, text),
  auth.account_has_platform_permission(uuid, text),
  identity.admin_platform_overview(),
  auth.membership_has_permission(text, uuid, uuid, text),
  auth.upgrade_legacy_password(uuid, text, bigint, text),
  identity.has_active_membership(text, uuid, uuid),
  identity.has_active_consent_grant(uuid, text, uuid, uuid, text, text, timestamptz),
  identity.create_access_request(text, text, text, integer),
  identity.activate_break_glass(text, text, integer),
  identity.close_own_consent_grant(uuid, text),
  identity.admin_transition_facility(uuid, bigint, text, text, text, character),
  auth.admin_transition_account(uuid, bigint, text, text, text, character),
  auth.admin_change_platform_role(uuid, bigint, text, text, text, text, character),
  auth.admin_revoke_account_sessions(uuid, text, text, character),
  audit.list_facility_events(integer, bigint),
  audit.list_platform_events(integer, bigint, text, uuid, text, text, text, timestamptz, timestamptz)
  to hid_identity_runtime;

-- EHR owns only clinical persistence. Its single Identity capability is the
-- security-definer authorization decision needed by the current transaction
-- boundary; it receives no Identity table or sequence privilege.
grant usage on schema platform, auth, ehr, identity to hid_ehr_runtime;
grant select, insert, update on ehr.encounters, ehr.clinical_notes, ehr.vitals,
  ehr.diagnoses, ehr.prescriptions, ehr.lab_requests, ehr.documents,
  ehr.idempotency_keys to hid_ehr_runtime;
grant select, insert on ehr.ocr_import_provenance to hid_ehr_runtime;
grant select, insert on ehr.clinical_note_revisions,
  ehr.vital_corrections to hid_ehr_runtime;
grant select on ehr.document_scan_events, ehr.documents_effective,
  ehr.record_versions to hid_ehr_runtime;
grant usage, select on all sequences in schema ehr to hid_ehr_runtime;
grant execute on function platform.current_actor_subject(),
  platform.current_account_id(),
  platform.current_facility_id(),
  platform.current_membership_id(),
  platform.current_correlation_id(),
  platform.current_purpose_of_use(),
  auth.account_id_for_subject(text),
  auth.account_has_active_role(uuid, text),
  identity.has_active_consent_grant(uuid, text, uuid, uuid, text, text, timestamptz),
  ehr.context_allows(uuid, uuid, text) to hid_ehr_runtime;

-- Append-only audit is isolated from both domain roles. Environment-specific
-- Identity, EHR, or transitional API logins inherit this role separately.
grant usage on schema audit to hid_audit_writer;
grant insert on audit.events to hid_audit_writer;
grant usage, select on all sequences in schema audit to hid_audit_writer;

-- The scanner login receives no direct table access. The isolated workload
-- pool can only invoke the security-definer append command, which revalidates
-- its workload subject and exact object binding.
grant usage on schema ehr to hid_document_scanner;
grant execute on function ehr.append_document_scan_event(
  uuid, text, text, text, text, text, text, text, text, text
) to hid_document_scanner;

grant usage on schema platform, ocr to hid_ocr_runtime;
grant select, insert, update on ocr.jobs to hid_ocr_runtime;
grant select on ocr.job_events to hid_ocr_runtime;
grant select, insert on ocr.extractions, ocr.validations to hid_ocr_runtime;
grant select, insert on ocr.patient_confirmations to hid_ocr_runtime;
grant select, insert, update on ocr.publications to hid_ocr_runtime;
grant select, insert on ocr.outbox_events to hid_ocr_runtime;
grant usage, select on all sequences in schema ocr to hid_ocr_runtime;
grant execute on function platform.current_actor_subject(),
  platform.current_account_id(),
  platform.current_facility_id(),
  platform.current_membership_id(),
  platform.current_correlation_id(),
  platform.current_purpose_of_use() to hid_ocr_runtime;

grant usage on schema ocr to hid_ocr_worker;
grant execute on function ocr.claim_worker_job(text, integer),
  ocr.renew_worker_claim(uuid, uuid, integer),
  ocr.complete_worker_job(uuid, uuid, text, text, text, text, text, jsonb, numeric, jsonb, text),
  ocr.fail_worker_job(uuid, uuid, text, text, boolean, integer, text) to hid_ocr_worker;

grant usage on schema platform,identity,lab to hid_lab_runtime;
grant select,insert on lab.imported_evidence,lab.imported_observations,lab.work_items,
  lab.work_item_requested_tests,lab.work_item_events,lab.accessions,lab.specimen_requirements,
  lab.accession_events,lab.specimen_events,lab.specimen_command_idempotency,lab.test_executions,
  lab.execution_events,lab.results,lab.result_revisions,lab.result_events,lab.outbox_events to hid_lab_runtime;
grant select,insert on lab.result_verifications,lab.result_releases,lab.result_invalidations to hid_lab_runtime;
grant select,insert,update on lab.specimens to hid_lab_runtime;
grant update on lab.test_executions,lab.results to hid_lab_runtime;
grant usage,select on all sequences in schema lab to hid_lab_runtime;
grant execute on function platform.current_actor_subject(),platform.current_account_id(),
  platform.current_facility_id(),platform.current_membership_id(),platform.current_correlation_id(),
  platform.current_purpose_of_use(),
  identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz),
  lab.context_allows(uuid,uuid,text) to hid_lab_runtime;

grant usage on schema platform, identity, pharmacy to hid_pharmacy_runtime;
grant select, insert on pharmacy.work_items, pharmacy.work_item_events,
  pharmacy.dispensings, pharmacy.dispensing_reversals,
  pharmacy.imported_medication_evidence, pharmacy.outbox_events to hid_pharmacy_runtime;
grant usage, select on all sequences in schema pharmacy to hid_pharmacy_runtime;
grant execute on function platform.current_actor_subject(), platform.current_account_id(),
  platform.current_facility_id(), platform.current_membership_id(), platform.current_correlation_id(),
  platform.current_purpose_of_use(),
  identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz),
  pharmacy.context_allows(uuid,uuid,text) to hid_pharmacy_runtime;

grant usage on schema platform, auth, identity, outreach to hid_outreach_runtime;
grant select, insert, update on outreach.registration_cases to hid_outreach_runtime;
grant select, insert on outreach.patient_mappings, outreach.registration_case_events,
  outreach.command_idempotency, outreach.outbox_events to hid_outreach_runtime;
grant usage, select on all sequences in schema outreach to hid_outreach_runtime;
grant execute on function platform.current_actor_subject(), platform.current_account_id(),
  platform.current_facility_id(), platform.current_membership_id(), platform.current_correlation_id(),
  platform.current_purpose_of_use(),
  auth.membership_has_permission(text, uuid, uuid, text),
  outreach.context_allows(uuid,text) to hid_outreach_runtime;

-- Notification persistence contains no message bodies or OTP credentials.
-- Authentication challenges stay exclusively with the Identity runtime.
grant usage on schema notification to hid_notification_runtime;
grant select, insert, update on notification.device_registrations to hid_notification_runtime;
grant select, insert on notification.delivery_attempts to hid_notification_runtime;
grant usage, select on all sequences in schema notification to hid_notification_runtime;

-- Migration mappings are available only to the controlled migration role.
grant usage on schema migration to hid_migration_admin;
grant select, insert, update on migration.runs, migration.source_rows,
  migration.conflicts, migration.conflict_resolutions,
  migration.entity_reconciliations, migration.legacy_identity_mappings
  to hid_migration_admin;
grant usage, select on all sequences in schema migration to hid_migration_admin;

-- The dispatcher can execute only lease-bound commands. A separate technical
-- owner has the minimum underlying SELECT/state privileges required by those
-- SECURITY DEFINER commands and is never inherited by a runtime login.
drop policy if exists identity_outbox_event_delivery_read on identity.outbox_events;
create policy identity_outbox_event_delivery_read on identity.outbox_events
  for select to hid_event_delivery_commands using (true);
drop policy if exists ocr_outbox_event_delivery_read on ocr.outbox_events;
create policy ocr_outbox_event_delivery_read on ocr.outbox_events
  for select to hid_event_delivery_commands using (true);
drop policy if exists lab_outbox_event_delivery_read on lab.outbox_events;
create policy lab_outbox_event_delivery_read on lab.outbox_events
  for select to hid_event_delivery_commands using (true);
drop policy if exists pharmacy_outbox_event_delivery_read on pharmacy.outbox_events;
create policy pharmacy_outbox_event_delivery_read on pharmacy.outbox_events
  for select to hid_event_delivery_commands using (true);
drop policy if exists outreach_outbox_event_delivery_read on outreach.outbox_events;
create policy outreach_outbox_event_delivery_read on outreach.outbox_events
  for select to hid_event_delivery_commands using (true);

grant usage on schema identity, ocr, lab, pharmacy, outreach, integration
  to hid_event_delivery_commands;
grant select on identity.outbox_events, ocr.outbox_events, lab.outbox_events,
  pharmacy.outbox_events, outreach.outbox_events to hid_event_delivery_commands;
grant select on integration.outbox_envelopes to hid_event_delivery_commands;
grant select, insert, update on integration.outbox_delivery_state,
  integration.outbox_delivery_attempts, integration.inbox_consumers,
  integration.inbox_messages to hid_event_delivery_commands;
grant usage, select on all sequences in schema integration to hid_event_delivery_commands;

alter function integration.outbox_envelope_sha256(
  text,uuid,text,integer,timestamptz,text,uuid,bigint,text,uuid,uuid,uuid,jsonb
) owner to hid_event_delivery_commands;
alter function integration.claim_outbox_events(text,integer,integer,integer)
  owner to hid_event_delivery_commands;
alter function integration.record_outbox_delivered(text,uuid,uuid,text,text)
  owner to hid_event_delivery_commands;
alter function integration.record_outbox_failure(
  text,uuid,uuid,text,text,text,boolean,timestamptz,integer
) owner to hid_event_delivery_commands;
alter function integration.event_delivery_status()
  owner to hid_event_delivery_commands;
alter function integration.list_terminal_event_failures(integer)
  owner to hid_event_delivery_commands;
alter function integration.assert_inbox_consumer_authorized(text)
  owner to hid_event_delivery_commands;
alter function integration.claim_inbox_message(
  text,uuid,text,text,integer,text,character,text,integer
) owner to hid_event_delivery_commands;
alter function integration.complete_inbox_message(text,uuid,uuid)
  owner to hid_event_delivery_commands;
alter function integration.fail_inbox_message(
  text,uuid,uuid,text,boolean,timestamptz,integer
) owner to hid_event_delivery_commands;

-- The command-owner executes these two private helpers from inside
-- SECURITY DEFINER functions. They remain unavailable to every runtime role.
grant execute on function integration.outbox_envelope_sha256(
  text,uuid,text,integer,timestamptz,text,uuid,bigint,text,uuid,uuid,uuid,jsonb
), integration.assert_inbox_consumer_authorized(text)
  to hid_event_delivery_commands;

grant usage on schema integration to hid_event_dispatcher;
grant execute on function
  integration.claim_outbox_events(text,integer,integer,integer),
  integration.record_outbox_delivered(text,uuid,uuid,text,text),
  integration.record_outbox_failure(text,uuid,uuid,text,text,text,boolean,timestamptz,integer),
  integration.event_delivery_status(),
  integration.list_terminal_event_failures(integer)
  to hid_event_dispatcher;

grant usage on schema integration to hid_notification_worker;
grant execute on function
  integration.claim_inbox_message(text,uuid,text,text,integer,text,character,text,integer),
  integration.complete_inbox_message(text,uuid,uuid),
  integration.fail_inbox_message(text,uuid,uuid,text,boolean,timestamptz,integer)
  to hid_notification_worker;

-- The schema test role is intentionally more capable than any runtime role.
-- It is NOLOGIN and is used only inside the rollback-only integration test.
grant usage on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification to hid_schema_test_runtime;
grant select, insert, update on auth.accounts, auth.account_roles to hid_schema_test_runtime;
grant select on auth.roles, auth.permissions, auth.role_permissions to hid_schema_test_runtime;
grant select, insert, update on auth.sessions to hid_schema_test_runtime;
grant select, insert, update on auth.otp_challenges, auth.otp_rate_limits to hid_schema_test_runtime;
grant select, insert on auth.admin_command_idempotency to hid_schema_test_runtime;
grant select, insert, update on identity.organizations, identity.facilities,
  identity.staff, identity.staff_facility_memberships, identity.patients,
  identity.patient_identifiers, identity.purpose_of_use_codes,
  identity.access_requests, identity.consent_grants,
  identity.consent_directives, identity.consent_directive_versions,
  identity.registration_cases, identity.registration_case_candidates,
  identity.registration_case_events, identity.outbox_events,
  identity.facility_status_events, identity.patient_assurance_states to hid_schema_test_runtime;
grant select, insert, update on ehr.encounters, ehr.documents to hid_schema_test_runtime;
grant select, insert on ehr.lab_requests to hid_schema_test_runtime;
grant select, insert on ehr.ocr_import_provenance to hid_schema_test_runtime;
grant select on ehr.document_scan_events, ehr.documents_effective,
  ehr.record_versions to hid_schema_test_runtime;
grant select, insert on audit.events to hid_schema_test_runtime;
grant select, insert, update on ocr.jobs to hid_schema_test_runtime;
grant select on ocr.job_events, ocr.outbox_events to hid_schema_test_runtime;
grant select, insert on ocr.extractions, ocr.validations to hid_schema_test_runtime;
grant select, insert on ocr.patient_confirmations to hid_schema_test_runtime;
grant select, insert, update on ocr.publications to hid_schema_test_runtime;
grant select,insert on lab.imported_evidence,lab.imported_observations,lab.work_items,
  lab.work_item_requested_tests,lab.work_item_events,lab.accessions,lab.specimen_requirements,
  lab.accession_events,lab.specimen_events,lab.specimen_command_idempotency,lab.test_executions,
  lab.execution_events,lab.results,lab.result_revisions,lab.result_events,lab.outbox_events to hid_schema_test_runtime;
grant select,insert on lab.result_verifications,lab.result_releases,lab.result_invalidations to hid_schema_test_runtime;
grant select,insert,update on lab.specimens to hid_schema_test_runtime;
grant select, insert on ehr.prescriptions to hid_schema_test_runtime;
grant select, insert on pharmacy.work_items, pharmacy.work_item_events,
  pharmacy.dispensings, pharmacy.dispensing_reversals,
  pharmacy.imported_medication_evidence, pharmacy.outbox_events to hid_schema_test_runtime;
grant select, insert, update on outreach.registration_cases to hid_schema_test_runtime;
grant select, insert on outreach.patient_mappings, outreach.registration_case_events,
  outreach.command_idempotency, outreach.outbox_events to hid_schema_test_runtime;
grant select, insert, update on notification.device_registrations to hid_schema_test_runtime;
-- UPDATE is test-only so the schema suite can prove the immutable-table
-- trigger rejects mutation. Production notification roles remain INSERT-only.
grant select, insert, update on notification.delivery_attempts to hid_schema_test_runtime;
grant update on lab.test_executions,lab.results to hid_schema_test_runtime;
grant usage, select on all sequences in schema auth, identity, ehr, audit, lab, pharmacy, outreach, notification to hid_schema_test_runtime;
grant select on integration.outbox_envelopes to hid_schema_test_runtime;
grant select, insert, update, delete on integration.outbox_delivery_state,
  integration.outbox_delivery_attempts, integration.inbox_consumers,
  integration.inbox_messages to hid_schema_test_runtime;
grant usage, select on all sequences in schema integration to hid_schema_test_runtime;
grant execute on function platform.current_actor_subject(),
  platform.current_account_id(),
  platform.current_facility_id(),
  platform.current_membership_id(),
  platform.current_correlation_id(),
  platform.current_purpose_of_use(),
  auth.account_id_for_subject(text),
  auth.account_has_active_role(uuid, text),
  auth.account_has_platform_permission(uuid, text),
  identity.admin_platform_overview(),
  auth.membership_has_permission(text, uuid, uuid, text),
  auth.upgrade_legacy_password(uuid, text, bigint, text),
  identity.has_active_membership(text, uuid, uuid),
  identity.has_active_consent_grant(uuid, text, uuid, uuid, text, text, timestamptz),
  identity.create_access_request(text, text, text, integer),
  identity.activate_break_glass(text, text, integer),
  identity.close_own_consent_grant(uuid, text),
  identity.admin_transition_facility(uuid, bigint, text, text, text, character),
  auth.admin_transition_account(uuid, bigint, text, text, text, character),
  auth.admin_change_platform_role(uuid, bigint, text, text, text, text, character),
  auth.admin_revoke_account_sessions(uuid, text, text, character),
  audit.list_facility_events(integer, bigint),
  audit.list_platform_events(integer, bigint, text, uuid, text, text, text, timestamptz, timestamptz),
  ehr.context_allows(uuid, uuid, text),
  ocr.claim_next_job(text),
  ocr.record_extraction(uuid, text, text, text, text, text, jsonb, numeric, jsonb, text),
  ocr.fail_job(uuid, text, text, boolean, integer, text),
  ocr.claim_worker_job(text, integer),
  ocr.renew_worker_claim(uuid, uuid, integer),
  ocr.complete_worker_job(uuid, uuid, text, text, text, text, text, jsonb, numeric, jsonb, text),
  ocr.fail_worker_job(uuid, uuid, text, text, boolean, integer, text),
  ehr.append_document_scan_event(uuid, text, text, text, text, text, text, text, text, text),
  lab.context_allows(uuid,uuid,text),
  pharmacy.context_allows(uuid,uuid,text),
  outreach.context_allows(uuid,text),
  integration.claim_outbox_events(text,integer,integer,integer),
  integration.record_outbox_delivered(text,uuid,uuid,text,text),
  integration.record_outbox_failure(text,uuid,uuid,text,text,text,boolean,timestamptz,integer),
  integration.event_delivery_status(),
  integration.list_terminal_event_failures(integer),
  integration.claim_inbox_message(text,uuid,text,text,integer,text,character,text,integer),
  integration.complete_inbox_message(text,uuid,uuid),
  integration.fail_inbox_message(text,uuid,uuid,text,boolean,timestamptz,integer)
  to hid_schema_test_runtime;

-- These security-definer functions are never executable by PUBLIC. Runtime
-- execute grants above are exact and named.
revoke all on function auth.account_id_for_subject(text),
  auth.account_has_active_role(uuid, text),
  auth.membership_has_permission(text, uuid, uuid, text),
  auth.upgrade_legacy_password(uuid, text, bigint, text),
  identity.has_active_membership(text, uuid, uuid),
  identity.has_active_consent_grant(uuid, text, uuid, uuid, text, text, timestamptz),
  identity.create_access_request(text, text, text, integer),
  identity.activate_break_glass(text, text, integer),
  identity.close_own_consent_grant(uuid, text),
  audit.list_facility_events(integer, bigint),
  ehr.context_allows(uuid, uuid, text),
  ocr.claim_next_job(text),
  ocr.record_extraction(uuid, text, text, text, text, text, jsonb, numeric, jsonb, text),
  ocr.fail_job(uuid, text, text, boolean, integer, text),
  ocr.claim_worker_job(text, integer),
  ocr.renew_worker_claim(uuid, uuid, integer),
  ocr.complete_worker_job(uuid, uuid, text, text, text, text, text, jsonb, numeric, jsonb, text),
  ocr.fail_worker_job(uuid, uuid, text, text, boolean, integer, text),
  ehr.append_document_scan_event(uuid, text, text, text, text, text, text, text, text, text),
  lab.context_allows(uuid,uuid,text),
  pharmacy.context_allows(uuid,uuid,text),
  outreach.context_allows(uuid,text)
  from public;

alter default privileges in schema auth revoke all on tables from public;
alter default privileges in schema identity revoke all on tables from public;
alter default privileges in schema ehr revoke all on tables from public;
alter default privileges in schema audit revoke all on tables from public;
alter default privileges in schema auth revoke all on functions from public;
alter default privileges in schema identity revoke all on functions from public;
alter default privileges in schema ehr revoke all on functions from public;
alter default privileges in schema audit revoke all on functions from public;
alter default privileges in schema ocr revoke all on tables from public;
alter default privileges in schema ocr revoke all on functions from public;
alter default privileges in schema lab revoke all on tables from public;
alter default privileges in schema lab revoke all on functions from public;
alter default privileges in schema pharmacy revoke all on tables from public;
alter default privileges in schema pharmacy revoke all on functions from public;
alter default privileges in schema outreach revoke all on tables from public;
alter default privileges in schema outreach revoke all on functions from public;
alter default privileges in schema integration revoke all on tables from public;
alter default privileges in schema integration revoke all on sequences from public;
alter default privileges in schema integration revoke all on functions from public;
