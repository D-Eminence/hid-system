-- Run separately as an RDS security administrator after schema migration.
-- This file creates NOLOGIN group roles only. Login-role membership and
-- credentials remain environment-specific infrastructure.
--
-- On RDS the administrator is not a PostgreSQL superuser: it is a
-- NOSUPERUSER NOBYPASSRLS CREATEROLE login that owns the schema and created
-- these roles, so it holds ADMIN OPTION on each of them. The file is sent as
-- one statement batch, which PostgreSQL runs as a single transaction, so the
-- temporary memberships and CREATE grants below are never visible to another
-- session and are gone when it commits.

-- A CREATEROLE administrator otherwise receives the memberships named here in
-- every role it creates, in addition to its ADMIN OPTION. Keep it to ADMIN.
set createrole_self_grant = '';

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
  if not exists (select 1 from pg_roles where rolname = 'hid_ocr_queue_metrics') then
    create role hid_ocr_queue_metrics nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_platform_control_reader') then
    create role hid_platform_control_reader nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
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

-- Check, rather than re-assert, the attributes a non-superuser administrator
-- may not change. PostgreSQL 16 lets only a superuser change SUPERUSER, and
-- only a role that holds BYPASSRLS or REPLICATION change that attribute, even
-- to the value it already has, so `ALTER ROLE ... NOSUPERUSER NOBYPASSRLS`
-- stopped this file on RDS. A role with any of the three is refused here, and
-- a superuser must remove the attribute before the bootstrap runs. The
-- attributes the administrator may change are still corrected, but only when
-- they differ, so a run that changes nothing issues no ALTER ROLE. Every
-- later GRANT and REVOKE of membership in these roles needs ADMIN OPTION on
-- them, which the administrator that created them holds.
do $$
declare
  expected record;
  actual record;
  changes text;
begin
  for expected in select * from (values
    ('hid_identity_runtime', false),
    ('hid_ehr_runtime', false),
    ('hid_api_runtime', true),
    ('hid_identity_api_runtime', true),
    ('hid_ehr_api_runtime', true),
    ('hid_ocr_api_runtime', true),
    ('hid_audit_writer', false),
    ('hid_document_scanner', false),
    ('hid_ocr_runtime', false),
    ('hid_ocr_worker', false),
    ('hid_lab_runtime', false),
    ('hid_lab_api_runtime', true),
    ('hid_pharmacy_runtime', false),
    ('hid_pharmacy_api_runtime', true),
    ('hid_outreach_runtime', false),
    ('hid_outreach_api_runtime', true),
    ('hid_migration_admin', false),
    ('hid_schema_test_runtime', true),
    ('hid_event_delivery_commands', false),
    ('hid_ocr_queue_metrics', false),
    ('hid_platform_control_reader', false),
    ('hid_event_dispatcher', false),
    ('hid_notification_runtime', false),
    ('hid_notification_api_runtime', true),
    ('hid_notification_worker', true)
  ) as roles(role_name, inherit)
  loop
    select rolsuper, rolbypassrls, rolreplication, rolcanlogin, rolcreatedb,
           rolcreaterole, rolinherit
      into strict actual
      from pg_roles where rolname = expected.role_name;
    if actual.rolsuper or actual.rolbypassrls or actual.rolreplication then
      raise exception using errcode = '42501', message = format(
        'HID role %s is SUPERUSER, BYPASSRLS or REPLICATION; a superuser must remove the attribute before the role bootstrap runs',
        expected.role_name);
    end if;
    if not pg_has_role(current_user, expected.role_name, 'MEMBER WITH ADMIN OPTION') then
      raise exception using errcode = '42501', message = format(
        'The role bootstrap must run as a superuser or as the administrator that created HID role %s',
        expected.role_name);
    end if;
    changes := concat_ws(' ',
      case when actual.rolcanlogin then 'nologin' end,
      case when actual.rolcreatedb then 'nocreatedb' end,
      case when actual.rolcreaterole then 'nocreaterole' end,
      case when actual.rolinherit <> expected.inherit
        then case when expected.inherit then 'inherit' else 'noinherit' end end);
    if changes <> '' then
      execute format('alter role %I %s', expected.role_name, changes);
    end if;
  end loop;
end
$$;

-- The administrator transfers functions to the three technical owners below
-- and then grants and revokes privileges on them. A non-superuser may give an
-- object to a role only if it may SET ROLE to it, and may grant or revoke on
-- an object it does not own only with the owner's privileges, which an
-- INHERIT membership provides; a rerun, where the technical roles already own
-- the functions, needs the same for the REVOKE ALL statements that follow.
-- These memberships are revoked at the end of this file, in this transaction.
grant hid_event_delivery_commands, hid_ocr_queue_metrics, hid_platform_control_reader
  to current_user with inherit true, set true;

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
comment on role hid_ocr_queue_metrics is
  'Technical owner of the aggregate-only OCR queue metrics command; reads OCR job status and queue time only; never granted to a runtime login.';
comment on role hid_platform_control_reader is
  'Technical owner of platform.control_enabled(text); reads only the platform control keys and their enabled flags; never granted to a runtime login.';
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

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_ocr_queue_metrics;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_ocr_queue_metrics;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_ocr_queue_metrics;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_ocr_queue_metrics;

revoke all privileges on schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_platform_control_reader;
revoke all privileges on all tables in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_platform_control_reader;
revoke all privileges on all sequences in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_platform_control_reader;
revoke all privileges on all functions in schema platform, auth, identity, ehr, audit, ocr, lab, pharmacy, outreach, integration, notification from hid_platform_control_reader;

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
revoke hid_ocr_queue_metrics from hid_ocr_worker, hid_ocr_runtime, hid_ocr_api_runtime,
  hid_api_runtime, hid_identity_api_runtime, hid_ehr_api_runtime, hid_lab_api_runtime,
  hid_pharmacy_api_runtime, hid_outreach_api_runtime, hid_schema_test_runtime,
  hid_migration_admin, hid_event_dispatcher, hid_event_delivery_commands,
  hid_notification_api_runtime, hid_notification_worker;
revoke hid_platform_control_reader from hid_identity_runtime, hid_ehr_runtime,
  hid_api_runtime, hid_identity_api_runtime, hid_ehr_api_runtime, hid_ocr_api_runtime,
  hid_audit_writer, hid_document_scanner, hid_ocr_runtime, hid_ocr_worker,
  hid_lab_runtime, hid_lab_api_runtime, hid_pharmacy_runtime, hid_pharmacy_api_runtime,
  hid_outreach_runtime, hid_outreach_api_runtime, hid_schema_test_runtime,
  hid_migration_admin, hid_event_dispatcher, hid_event_delivery_commands,
  hid_ocr_queue_metrics, hid_notification_runtime, hid_notification_api_runtime,
  hid_notification_worker;

-- Launch (P8-CONTROL): platform.control_enabled(text) is the SECURITY
-- DEFINER read of platform.control_settings that the Identity, EHR and
-- Outreach guards make on every request that is not a platform
-- administrator's. The table forces row-level security, and its only read
-- policy requires platform.control.read, so under a schema owner that does
-- not bypass row-level security (RDS) the function saw no row and raised
-- PLATFORM_CONTROL_UNAVAILABLE, which the guards answer with 503. Its
-- technical owner reads only the key and enabled flag of the seven non-PHI
-- platform-wide controls through one exact policy, so the function no longer
-- depends on its owner bypassing row-level security. EXECUTE stays granted to
-- PUBLIC (0040). platform.require_control_enabled reads no table and calls
-- this function, so its owner is unchanged.
-- The table's PUBLIC read policy also applies to this role. PostgreSQL inlines
-- its SQL function platform.current_account_id() while planning, as the
-- reading role, and the body names schema auth, so the role needs USAGE on
-- auth for the plan to be built; it receives no privilege on any auth object.
-- The policies are OR-ed, so the `true` below decides the row and the PUBLIC
-- expression is folded away and never executed.
-- Lock order: DROP and CREATE POLICY lock the table ACCESS EXCLUSIVE until
-- this transaction commits. An Identity break-glass activation reads the
-- controls (platform.require_control_enabled) and then inserts into
-- identity.outbox_events in one transaction, so this block comes before the
-- first statement below that locks another table (the ocr.jobs and outbox
-- policies): a run that has to wait for platform.control_settings then holds
-- no lock that such a transaction needs. The policy is replaced only when it
-- is missing or differs, so a rerun takes no lock on the table at all.
do $$
begin
  if not exists (
    select 1 from pg_policy policy
     where policy.polrelid = 'platform.control_settings'::regclass
       and policy.polname = 'platform_controls_definer_read'
       and policy.polcmd = 'r' and policy.polpermissive
       and policy.polroles = array['hid_platform_control_reader'::regrole::oid]
       and pg_get_expr(policy.polqual, policy.polrelid) = 'true'
       and policy.polwithcheck is null
  ) then
    drop policy if exists platform_controls_definer_read on platform.control_settings;
    create policy platform_controls_definer_read on platform.control_settings
      for select to hid_platform_control_reader using (true);
  end if;
end
$$;
grant usage on schema platform, auth to hid_platform_control_reader;
grant select (control_key, enabled) on platform.control_settings to hid_platform_control_reader;
grant create on schema platform to hid_platform_control_reader;
alter function platform.control_enabled(text) owner to hid_platform_control_reader;
revoke create on schema platform from hid_platform_control_reader;

-- Identity owns canonical patients, registration, consent, workforce context,
-- and the local authentication persistence used by the current Identity API.
grant usage on schema platform, auth, identity, audit to hid_identity_runtime;
grant select on auth.accounts, auth.roles, auth.permissions,
  auth.role_permissions, auth.account_roles to hid_identity_runtime;
grant select, insert, update on auth.sessions to hid_identity_runtime;
grant select, insert, update, delete on auth.login_attempts to hid_identity_runtime;
grant select, insert, update on auth.otp_challenges, auth.otp_rate_limits to hid_identity_runtime;
-- Recovery start cooldowns (0081): no DELETE; each row is overwritten by the
-- identifier's next start.
grant select, insert, update on auth.otp_start_cooldowns to hid_identity_runtime;
grant insert on auth.session_events to hid_identity_runtime;
grant select on identity.organizations, identity.facilities, identity.staff,
  identity.staff_facility_memberships, identity.purpose_of_use_codes,
  identity.consent_directives, identity.consent_directive_versions,
  identity.access_requests, identity.consent_grants,
  identity.facility_status_events to hid_identity_runtime;
grant select, insert on identity.patients, identity.patient_identifiers to hid_identity_runtime;
-- Assurance transitions are evidence-bound SECURITY DEFINER commands. Revoke
-- legacy broad grants as well as omitting them for a fresh role bootstrap.
revoke select, insert, update, delete on identity.patient_assurance_states from hid_identity_runtime;
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
  auth.complete_recovery_otp(uuid, text, text, text),
  identity.has_active_membership(text, uuid, uuid),
  identity.has_active_consent_grant(uuid, text, uuid, uuid, text, text, timestamptz),
  identity.create_access_request(text, text, text, integer),
  identity.list_my_staff_access_requests(text),
  identity.activate_break_glass(text, text, integer),
  identity.close_own_consent_grant(uuid, text),
  identity.admin_transition_facility(uuid, bigint, text, text, text, character),
  auth.admin_transition_account(uuid, bigint, text, text, text, character),
  auth.admin_change_platform_role(uuid, bigint, text, text, text, text, character),
  auth.admin_revoke_account_sessions(uuid, text, text, character),
  audit.list_facility_events(integer, bigint),
  audit.list_platform_events(integer, bigint, text, uuid, text, text, text, timestamptz, timestamptz, text, text)
  to hid_identity_runtime;

-- EHR owns only clinical persistence. Its Identity capabilities are the
-- security-definer authorization decisions needed by the current transaction
-- boundary: the consent decision row-level security uses and, since 0090, the
-- membership permission decision the encounter retraction guard uses
-- (ehr.require_retraction_permission). It receives no Identity table or
-- sequence privilege.
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
  auth.membership_has_permission(text, uuid, uuid, text),
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

-- Phase 4 Stage 6 (0075): the worker reads queue depth and age only through
-- this aggregate command. Its technical owner can read job status and queue
-- time across facilities through one exact policy, so the command does not
-- depend on its owner bypassing FORCE ROW LEVEL SECURITY. The owner is never
-- granted to a login, and the worker still has no table privileges.
drop policy if exists ocr_jobs_queue_metrics_read on ocr.jobs;
create policy ocr_jobs_queue_metrics_read on ocr.jobs
  for select to hid_ocr_queue_metrics using (true);
grant usage on schema ocr to hid_ocr_queue_metrics;
grant select (status, queued_at) on ocr.jobs to hid_ocr_queue_metrics;
-- A non-superuser may give a function only to a role that may create in its
-- schema. CREATE is held for the transfer alone (here and below).
grant create on schema ocr to hid_ocr_queue_metrics;
alter function ocr.worker_queue_metrics() owner to hid_ocr_queue_metrics;
revoke create on schema ocr from hid_ocr_queue_metrics;
grant execute on function ocr.worker_queue_metrics() to hid_ocr_worker;

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
grant select, insert, update on outreach.campaigns to hid_outreach_runtime;
grant select, insert, delete on outreach.campaign_members to hid_outreach_runtime;
grant select, insert on outreach.campaign_events to hid_outreach_runtime;
grant select, insert on outreach.patient_mappings, outreach.registration_case_events,
  outreach.command_idempotency, outreach.outbox_events to hid_outreach_runtime;
grant usage, select on all sequences in schema outreach to hid_outreach_runtime;
-- Outreach RLS policies and the invoker-rights event trigger call
-- platform.current_account_id() as the runtime, and that SQL function calls
-- auth.account_id_for_subject(text), which is revoked from PUBLIC below.
grant execute on function platform.current_actor_subject(), platform.current_account_id(),
  platform.current_facility_id(), platform.current_membership_id(), platform.current_correlation_id(),
  platform.current_purpose_of_use(),
  auth.account_id_for_subject(text),
  auth.membership_has_permission(text, uuid, uuid, text),
  outreach.context_allows(uuid,text),
  outreach.registration_campaign_member(uuid,uuid) to hid_outreach_runtime;

-- Notification persistence contains no message bodies or OTP credentials.
-- Authentication challenges stay exclusively with the Identity runtime.
grant usage on schema notification to hid_notification_runtime;
grant select, insert, update on notification.device_registrations to hid_notification_runtime;
grant select, insert on notification.delivery_attempts to hid_notification_runtime;
grant usage, select on all sequences in schema notification to hid_notification_runtime;

-- Migration mappings are available only to the controlled migration role.
grant usage on schema auth, identity, migration to hid_migration_admin;
grant select, insert, update on migration.runs,
  migration.conflicts, migration.conflict_resolutions,
  migration.entity_reconciliations, migration.legacy_identity_mappings
  to hid_migration_admin;
grant select, insert, update (status, revoked_at, revocation_reason)
  on migration.legacy_nin_crosswalk,
  migration.legacy_nin_crosswalk_attestations to hid_migration_admin;
grant select, insert on migration.patient_contact_lookup_rekeys to hid_migration_admin;
revoke update on migration.source_rows from hid_migration_admin;
grant select, insert on migration.source_rows to hid_migration_admin;
grant update (promoted_at) on migration.source_rows to hid_migration_admin;
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

grant create on schema integration to hid_event_delivery_commands;
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
revoke create on schema integration from hid_event_delivery_commands;

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
grant select, insert, update on auth.otp_start_cooldowns to hid_schema_test_runtime;
grant select, insert on auth.admin_command_idempotency to hid_schema_test_runtime;
grant select, insert, update on identity.organizations, identity.facilities,
  identity.staff, identity.staff_facility_memberships, identity.patients,
  identity.patient_identifiers, identity.purpose_of_use_codes,
  identity.access_requests, identity.consent_grants,
  identity.consent_directives, identity.consent_directive_versions,
  identity.registration_cases, identity.registration_case_candidates,
  identity.registration_case_events, identity.outbox_events,
  identity.facility_status_events, identity.patient_assurance_states,
  identity.verification_evidence to hid_schema_test_runtime;
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
grant select, insert, update on outreach.campaigns to hid_schema_test_runtime;
grant select, insert, delete on outreach.campaign_members to hid_schema_test_runtime;
grant select, insert on outreach.campaign_events to hid_schema_test_runtime;
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
  auth.complete_recovery_otp(uuid, text, text, text),
  identity.has_active_membership(text, uuid, uuid),
  identity.has_active_consent_grant(uuid, text, uuid, uuid, text, text, timestamptz),
  identity.create_access_request(text, text, text, integer),
  identity.list_my_staff_access_requests(text),
  identity.activate_break_glass(text, text, integer),
  identity.close_own_consent_grant(uuid, text),
  identity.admin_transition_facility(uuid, bigint, text, text, text, character),
  auth.admin_transition_account(uuid, bigint, text, text, text, character),
  auth.admin_change_platform_role(uuid, bigint, text, text, text, text, character),
  auth.admin_revoke_account_sessions(uuid, text, text, character),
  audit.list_facility_events(integer, bigint),
  audit.list_platform_events(integer, bigint, text, uuid, text, text, text, timestamptz, timestamptz, text, text),
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
  outreach.registration_campaign_member(uuid,uuid),
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
  auth.complete_recovery_otp(uuid, text, text, text),
  identity.has_active_membership(text, uuid, uuid),
  identity.has_active_consent_grant(uuid, text, uuid, uuid, text, text, timestamptz),
  identity.create_access_request(text, text, text, integer),
  identity.list_my_staff_access_requests(text),
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
  ocr.worker_queue_metrics(),
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

-- Patient self-service is an Identity-owned authorization boundary; EHR only
-- evaluates the private context established after that service authorization.
grant execute on function identity.current_patient_account(text),
  identity.patient_self_profile(text,uuid), identity.authorize_patient_self(text,uuid),
  identity.patient_self_access_history(text,uuid)
  to hid_identity_runtime, hid_schema_test_runtime;
grant execute on function ehr.patient_self_context(uuid) to hid_ehr_runtime, hid_schema_test_runtime;
revoke all on function identity.current_patient_account(text),
  identity.patient_self_session(text,uuid), identity.patient_self_profile(text,uuid),
  identity.authorize_patient_self(text,uuid), identity.patient_self_access_history(text,uuid),
  ehr.patient_self_context(uuid) from public;

-- Recovery and patient search hardening (0086): the recovery audience check,
-- the audit subject of a refused staff lookup and governed registration's
-- duplicate checks are Identity-only commands; each checks its own caller.
grant execute on function auth.recovery_account_audience(uuid, text),
  identity.patient_lookup_audit_subject(text),
  identity.registration_nin_holder(text),
  identity.registration_candidates(date, text, text)
  to hid_identity_runtime, hid_schema_test_runtime;
revoke all on function auth.recovery_account_audience(uuid, text),
  identity.patient_lookup_audit_subject(text),
  identity.registration_nin_holder(text),
  identity.registration_candidates(date, text, text) from public;

-- Governed enrollment creates only a pending-reset account for a resolved case.
grant execute on function identity.enroll_registered_patient(uuid, bigint, text, text, text, char)
  to hid_identity_runtime;

-- Supabase cutover commands are security-definer boundaries. The Identity
-- runtime cannot read PIN hashes, attempt windows, or external-identity rows
-- directly; it can only resolve a verified Google subject and invoke the
-- named patient/staff commands.
grant execute on function auth.resolve_google_identity(text),
  identity.set_my_patient_access_pin(text,uuid,text),
  identity.revoke_my_patient_access_pin(text,uuid),
  identity.access_patient_with_pin(text,text,integer),
  identity.legacy_nin_crosswalk_patient(char),
  identity.legacy_nin_crosswalk_ready(),
  identity.patient_contact_lookup_ready(),
  identity.patient_self_nin_eligibility(text,uuid,char),
  identity.bind_my_verified_nin(text,uuid,uuid,char,bytea,text,char,text,bytea,char),
  identity.patient_self_nin_binding_matches(text,uuid,text),
  identity.record_my_nin_verification_evidence(text,uuid,text,text,text,text),
  identity.record_organization_cac_verification_evidence(text,text,text,text)
  to hid_identity_runtime, hid_schema_test_runtime;

grant select, insert on auth.external_identities, identity.patient_access_pins,
  migration.cutover_preservation_holds to hid_migration_admin;
grant usage on schema migration to hid_schema_test_runtime;
grant usage, select on all sequences in schema identity to hid_schema_test_runtime;
grant select, insert, update on identity.patient_access_pins,
  identity.patient_access_pin_actor_limits, identity.patient_access_pin_target_limits
  to hid_schema_test_runtime;
grant select, insert on identity.patient_access_pin_attempts,
  migration.cutover_preservation_holds to hid_schema_test_runtime;

revoke all on function auth.resolve_google_identity(text),
  identity.set_my_patient_access_pin(text,uuid,text),
  identity.revoke_my_patient_access_pin(text,uuid),
  identity.access_patient_with_pin(text,text,integer),
  identity.legacy_nin_crosswalk_patient(char),
  identity.legacy_nin_crosswalk_ready(),
  identity.patient_contact_lookup_ready(),
  identity.patient_self_nin_eligibility(text,uuid,char),
  identity.bind_my_verified_nin(text,uuid,uuid,char,bytea,text,char,text,bytea,char),
  identity.patient_self_nin_binding_matches(text,uuid,text),
  identity.record_my_nin_verification_evidence(text,uuid,text,text,text,text),
  identity.record_organization_cac_verification_evidence(text,text,text,text) from public;

-- Demo intake is insert-only for anonymous callers. RLS limits the same
-- Identity runtime role to permissioned platform-admin reads and transitions.
grant select, insert, update on identity.demo_requests to hid_identity_runtime;
grant select, insert on identity.demo_request_events to hid_identity_runtime;
grant usage, select on sequence identity.demo_request_events_sequence_id_seq to hid_identity_runtime;
grant select, insert, update on identity.demo_requests to hid_schema_test_runtime;
grant select, insert on identity.demo_request_events to hid_schema_test_runtime;
grant usage, select on sequence identity.demo_request_events_sequence_id_seq to hid_schema_test_runtime;

-- Pricing is read and changed only through the exact Identity-owned functions.
-- No application runtime receives direct table or event-log privileges.
grant execute on function platform.public_list_commercial_prices(),
  platform.admin_list_commercial_products(), platform.admin_list_commercial_prices(),
  platform.admin_set_commercial_product(text, bigint, text, text, text, text, char),
  platform.admin_set_commercial_price(text, text, bigint, text, bigint, text, text, text, boolean, text, text, char)
  to hid_identity_runtime, hid_schema_test_runtime;
grant select on platform.commercial_products, platform.commercial_prices,
  platform.commercial_catalog_events to hid_schema_test_runtime;

-- Platform controls (0039) are listed and changed only through these two
-- Identity-owned security-definer commands, which check platform.control.read
-- and platform.control.manage themselves. No runtime receives direct privileges
-- on the control tables or their event log.
grant execute on function platform.admin_list_controls(),
  platform.admin_set_control(text, boolean, bigint, text)
  to hid_identity_runtime, hid_schema_test_runtime;

-- Runtime provider decisions and admin commands have narrow function grants.
-- Notification API receives no direct database access or provider table grant.
grant execute on function platform.integration_runtime_provider(text,text),
  platform.integration_runtime_route(text),
  platform.admin_list_integration_providers(),
  platform.admin_list_integration_routes(),
  platform.admin_list_integration_events(text,integer),
  platform.admin_set_integration_provider(text,bigint,boolean,jsonb,text,text,text,char),
  platform.admin_set_integration_route(text,bigint,text,text,text,text,text,char),
  platform.admin_integration_test_replay(text,char),
  platform.admin_record_integration_test(text,bigint,text,text,text,char),
  platform.consume_qoreid_quota(text,uuid,uuid,char,char),
  platform.consume_public_application_quota(char),
  platform.prune_verification_quotas()
  to hid_identity_runtime, hid_schema_test_runtime;
grant select on platform.integration_providers, platform.integration_provider_capabilities,
  platform.integration_capability_routes, platform.integration_events to hid_schema_test_runtime;

-- Public organization intake and platform review use narrow commands. The
-- Identity runtime cannot directly mutate canonical organizations or roles.
grant execute on function identity.submit_organization_application(text,text,text,text,text),
  identity.admin_list_organization_applications(text),
  identity.admin_get_organization_application(uuid),
  identity.admin_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text,text),
  identity.begin_organization_profile_completion(text,text,text,uuid,char),
  identity.invalidate_organization_profile_completion_challenge(uuid),
  identity.verify_organization_profile_completion_challenge(uuid,char,char),
  identity.current_organization_profile_completion(char),
  identity.complete_organization_profile(char,bigint,text,text,text,text,text),
  identity.current_organization_cac_binding_matches(text,text,text,text,text,text,text),
  identity.admin_approve_organization_application(uuid,bigint,uuid,uuid,text),
  identity.admin_reject_organization_application(uuid,bigint,text)
  to hid_identity_runtime, hid_schema_test_runtime;

-- Accountless provider self-enrollment (0061-0063). The runtime activates only
-- through the wrapper that returns the login email in the same transaction;
-- the underlying activation command stays owner-only. The CAC lookup is
-- charged through the network/application quota command, never the
-- account-scoped `application_cac` path.
grant execute on function identity.submit_self_service_organization_application(text,text,text,text,text),
  identity.public_get_organization_application(text,text,text),
  identity.public_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text),
  identity.activate_self_service_provider_enrollment(char,text),
  platform.consume_self_service_cac_quota(uuid,char)
  to hid_identity_runtime, hid_schema_test_runtime;

-- Public patient enrollment persists only encrypted pending evidence. Its
-- activation command performs the canonical account/patient writes atomically.
-- 0092 dropped and recreated the command with the two self-reported profile
-- arguments (ADR-061); a dropped function loses its grants, so this file, run
-- after every migration, grants the new signature.
grant select, insert, update, delete on identity.public_patient_enrollments,
  identity.public_patient_enrollment_otps,
  identity.public_patient_enrollment_rates to hid_identity_runtime, hid_schema_test_runtime;
grant select on identity.patient_authoritative_profiles to hid_schema_test_runtime;
grant execute on function identity.public_patient_nin_already_bound(char),
  identity.public_patient_enrollment_ready(),
  identity.public_patient_contact_already_bound(text,char),
  identity.prune_expired_public_patient_enrollments(),
  identity.activate_public_patient_enrollment(uuid,char,text,text,text,text,char,date,text)
  to hid_identity_runtime, hid_schema_test_runtime;
-- Each QoreID NIN lookup of public enrollment is charged, before any account
-- exists, through the network and platform quota command (0085); the runtime
-- has no privilege on its counters.
grant execute on function platform.consume_public_patient_nin_quota(char,integer,integer,integer)
  to hid_identity_runtime, hid_schema_test_runtime;

-- Google onboarding capabilities are accountless and only the Identity API
-- may use their narrow commands. Runtime roles never read provider subjects.
grant execute on function auth.create_google_onboarding_capability(uuid,char,text),
  auth.google_onboarding_capability_status(uuid,char),
  auth.bind_google_onboarding_capability(uuid,char,uuid,char),
  auth.google_onboarding_enrollment_requirement(uuid,char),
  auth.consume_google_onboarding_capability(uuid,char,uuid,uuid),
  auth.link_google_identity_to_patient_account(uuid,text)
  to hid_identity_runtime, hid_schema_test_runtime;
revoke all on function auth.create_google_onboarding_capability(uuid,char,text),
  auth.google_onboarding_capability_status(uuid,char),
  auth.bind_google_onboarding_capability(uuid,char,uuid,char),
  auth.google_onboarding_enrollment_requirement(uuid,char),
  auth.consume_google_onboarding_capability(uuid,char,uuid,uuid),
  auth.link_google_identity_to_patient_account(uuid,text)
  from public;

-- Phase 3 patient safety. Every command below resolves the authenticated
-- patient through `identity.patient_self_session` (or the Identity system
-- context for asynchronous lifecycle/delivery work) and writes its own audit.
-- Internal completion, retention evaluation, and audit helpers are not granted.
grant execute on function identity.list_my_notification_inbox(integer),
  identity.mark_my_notification_read(uuid),
  identity.list_my_patient_access_requests(text,uuid),
  identity.approve_my_access_request(text,uuid,uuid),
  identity.deny_my_access_request(text,uuid,uuid,text),
  identity.revoke_my_consent_grant(text,uuid,uuid,text),
  identity.my_account_deletion_status(text,uuid),
  identity.request_my_account_deletion(text,uuid,text),
  identity.confirm_my_account_deletion(text,uuid,uuid,text,text),
  identity.cancel_my_account_deletion(text,uuid,uuid),
  identity.finalize_due_patient_account_deletions(integer),
  identity.list_my_emergency_contacts(text,uuid),
  identity.add_my_emergency_contact(text,uuid,uuid,text,text,bytea,text,text,boolean),
  identity.update_my_emergency_contact(text,uuid,uuid,bigint,text,bytea,text,text,boolean),
  identity.deactivate_my_emergency_contact(text,uuid,uuid),
  identity.start_my_emergency_contact_verification(text,uuid,uuid,uuid,text,text,integer,integer),
  identity.record_my_emergency_contact_verification_delivery(text,uuid,uuid,text,text),
  identity.complete_my_emergency_contact_verification(text,uuid,uuid,uuid,text),
  identity.claim_emergency_contact_notifications(text,integer,integer),
  identity.record_emergency_contact_notification_outcome(uuid,text,text,text,text)
  to hid_identity_runtime, hid_schema_test_runtime;
revoke all on function identity.patient_account_deletion_due(uuid),
  platform.evaluate_patient_account_deletion(uuid,uuid),
  identity.complete_patient_account_deletion(uuid,text),
  identity.audit_emergency_contact_event(text,text,uuid,uuid,text,uuid,jsonb),
  identity.on_emergency_access_contact_notification(),
  identity.list_my_access_requests(), identity.approve_access_request(uuid),
  identity.deny_access_request(uuid,text)
  from public;
revoke all on platform.record_class_retention_policies, platform.legal_holds,
  platform.patient_account_deletion_settings, identity.patient_account_deletion_requests,
  identity.patient_emergency_contacts, identity.emergency_contact_verifications,
  identity.emergency_contact_notifications
  from public, hid_identity_runtime, hid_ehr_runtime, hid_api_runtime, hid_identity_api_runtime,
    hid_ehr_api_runtime, hid_notification_runtime, hid_notification_worker;

-- Phase 4 Stage 2A platform MFA, sessions and approvals (0069-0070). The
-- Identity runtime verifies TOTP codes itself and maintains challenges, factors,
-- recovery codes and session assurance; the 0069 trigger guards restrict which
-- columns and transitions those updates may touch. It never deletes them.
-- Approval requests are read directly but change only through the
-- security-definer commands, which repeat permission and step-up checks.
grant select, insert, update on auth.mfa_factors, auth.mfa_recovery_codes,
  auth.mfa_login_challenges, auth.session_assurance to hid_identity_runtime;
grant select on auth.admin_approval_requests to hid_identity_runtime;
grant execute on function platform.current_session_id(),
  auth.account_has_active_mfa(uuid),
  auth.platform_step_up_is_fresh(uuid),
  auth.admin_revoke_session_family(uuid, uuid, boolean, text, text, character),
  auth.admin_request_approval(text, uuid, text, text, text, character),
  auth.admin_decide_approval(uuid, bigint, text, text, text, character)
  to hid_identity_runtime, hid_schema_test_runtime;
revoke all on function auth.require_platform_step_up(uuid),
  auth.other_reachable_super_admins(uuid, text),
  auth.guard_mfa_factor_change(), auth.guard_mfa_recovery_code_change(),
  auth.guard_mfa_login_challenge_change(), auth.guard_session_assurance_change(),
  auth.guard_admin_approval_request_change()
  from public;

-- Staff working facility per sign-in (0089, ADR-046). The Identity runtime
-- reads, records and replaces a sign-in's selection, as it does
-- auth.session_assurance; the 0089 guard admits only the root session of a
-- live staff sign-in of the same account and an active membership, and refuses
-- deletes, so DELETE is not granted. No other service reads it: the selection
-- authorizes nothing, and every service authorizes a request by its
-- X-Facility-ID. The guard runs as the invoker and reads only tables this
-- runtime already reads (auth.sessions and the identity workforce tables).
grant select, insert, update on auth.session_facility_selection to hid_identity_runtime;
revoke all on function auth.guard_session_facility_selection_change() from public;

-- Phase 4 Stage 5B (0073): the Identity API's own revocations (refresh-token
-- reuse, an administrator revoking their own session, sign-out, expiry) take the
-- account row lock through this helper before revoking, as the 0073 admin
-- commands do. It only locks; the runtime still cannot update auth.accounts.
grant execute on function auth.lock_account_sessions(uuid) to hid_identity_runtime;
revoke all on function auth.lock_account_sessions(uuid) from public;

-- Phase 4 Stage 7A (0076): every platform MFA transaction takes the account
-- row (FOR NO KEY UPDATE) through this helper first, so it serializes with an
-- approved MFA reset, with session revocations and with the other MFA
-- transactions of the account. It only locks.
grant execute on function auth.lock_account_for_mfa(uuid) to hid_identity_runtime;
revoke all on function auth.lock_account_for_mfa(uuid) from public;

-- Launch D14 (0087): governed workforce provisioning. The Identity runtime
-- runs the five platform commands, each of which repeats the
-- platform.workforce.manage, MFA and step-up checks, and the effective-role
-- check its staff context uses. It reads and writes the attestation, lifecycle
-- and role-grant tables only through those commands; the shared check helpers
-- and the triggers stay internal.
grant execute on function identity.admin_attach_workforce_member(uuid, uuid, text, text, text, text, character),
  identity.admin_record_credential_attestation(uuid, bigint, text[], text, text, text, timestamptz, text, text,
    character),
  identity.admin_change_workforce_role(uuid, uuid, bigint, text, text, text, text, character),
  identity.admin_end_workforce_membership(uuid, uuid, bigint, text, text, character),
  identity.admin_workforce_profile(uuid),
  auth.facility_role_is_effective(uuid)
  to hid_identity_runtime;
revoke all on function identity.admin_attach_workforce_member(uuid, uuid, text, text, text, text, character),
  identity.admin_record_credential_attestation(uuid, bigint, text[], text, text, text, timestamptz, text, text,
    character),
  identity.admin_change_workforce_role(uuid, uuid, bigint, text, text, text, text, character),
  identity.admin_end_workforce_membership(uuid, uuid, bigint, text, text, character),
  identity.admin_workforce_profile(uuid),
  auth.facility_role_is_effective(uuid),
  identity.workforce_command_actor(),
  identity.workforce_require_assurance(uuid),
  identity.workforce_works_at(uuid, uuid),
  identity.workforce_target_eligible(auth.accounts),
  identity.guard_workforce_membership_change(),
  identity.guard_ended_membership_change()
  from public;
revoke all on identity.staff_credential_attestations, identity.workforce_memberships,
  identity.workforce_role_grants
  from public, hid_identity_runtime, hid_ehr_runtime, hid_api_runtime, hid_identity_api_runtime,
    hid_ehr_api_runtime, hid_schema_test_runtime;

-- Launch (0091, ADR-058). ehr.patient_self_context is now a security-definer
-- binding check; its EXECUTE grant to hid_ehr_runtime is above (Phase 3 patient
-- self-service). 0091 recreates identity.list_my_patient_access_requests with
-- the requesting clinician's name and role, so its Identity grant above
-- returns with this run; the internal list stays revoked. The PIN-use inbox
-- trigger function runs only as its trigger.
revoke all on function notification.on_identity_pin_outbox_created() from public;

-- Break-glass at launch, with limits (0093, D9, ADR-058 addendum). 0093
-- creates no object and changes no database grant: it inserts the
-- identity.break-glass.write rows of doctor, clinician and nurse into
-- auth.role_permissions and the emergency purpose of use. The Identity
-- runtime's EXECUTE on identity.activate_break_glass and its read of the
-- vocabulary are above and unchanged. The role assertions
-- (runtime-roles.integration.sql) now require exactly those three holders.

-- Clinician self sign-up (0094, ADR-064). The Identity runtime runs the
-- public, capability and system commands in its system context (each checks
-- the system:auth subject, a correlation id and no signed-in account), and the
-- schema test runtime may too. Only the Identity runtime runs the platform
-- administration commands, each of which repeats the platform.workforce.manage,
-- MFA and (for the three mutations) step-up checks. The internal helpers,
-- identity.workforce_change_role (the pinned 0087 grant) and the guard stay
-- internal, and no runtime holds a privilege on the five tables: the commands
-- are the only path.
grant execute on function identity.clinician_signup_open(),
  platform.consume_clinician_application_quota(character, text, integer, integer, integer),
  identity.begin_clinician_application_challenge(text, uuid, character, text, character),
  identity.invalidate_clinician_application_challenge(uuid),
  identity.verify_clinician_application_signup_code(uuid, character, text, character, character),
  identity.verify_clinician_application_status_code(uuid, character, character, character),
  identity.clinician_application_session(character),
  identity.search_clinician_application_facilities(character, text),
  identity.submit_clinician_application(character, character, text, character, text, character, text, text, text,
    text, text, date, uuid, integer),
  identity.bind_clinician_application_mfa_challenge(character, uuid),
  identity.clinician_application_authenticator_ready(character, uuid, text),
  identity.current_clinician_applications(character),
  identity.withdraw_clinician_application(character, uuid, bigint),
  identity.file_clinician_application(character, text, character, text, text, text, date, uuid, integer),
  identity.end_clinician_application_session(character),
  identity.expire_clinician_applications(integer),
  identity.prune_clinician_application_artifacts()
  to hid_identity_runtime, hid_schema_test_runtime;
grant execute on function identity.admin_list_clinician_applications(text, timestamptz, uuid, integer),
  identity.admin_get_clinician_application(uuid),
  identity.admin_clinician_application_account(uuid),
  identity.admin_clinician_application_prior(text, text, character),
  identity.admin_attest_clinician_application(uuid, bigint, timestamptz, text, jsonb, uuid, text, text, character),
  identity.admin_approve_clinician_application(uuid, bigint, text, text, character),
  identity.admin_reject_clinician_application(uuid, bigint, text, text, text, character)
  to hid_identity_runtime;
revoke all on function identity.clinician_licence_key(text, text),
  identity.clinician_application_displayed_state(text, timestamptz),
  identity.workforce_attestation_usable(uuid, uuid, uuid, uuid),
  identity.workforce_change_role(uuid, uuid, bigint, text, text, text, text, character, uuid),
  identity.clinician_application_require_system(),
  identity.clinician_intake_require_open(),
  identity.clinician_application_require_not_maintenance(),
  identity.clinician_application_session_row(character, boolean),
  identity.clinician_application_account_session(character, text[], text, boolean),
  identity.clinician_application_account_stage(uuid),
  identity.clinician_application_status_eligible(uuid),
  identity.clinician_application_identity_refused(uuid),
  identity.clinician_application_account_refusal(uuid),
  identity.clinician_application_access_state(identity.clinician_applications),
  identity.clinician_application_view(identity.clinician_applications),
  identity.clinician_application_account_view(uuid, text),
  identity.clinician_application_audit(text, text, text, text, jsonb),
  identity.clinician_application_inner_key_free(uuid, text[], text),
  identity.guard_clinician_application_change()
  from public, hid_identity_runtime, hid_ehr_runtime, hid_api_runtime, hid_identity_api_runtime,
    hid_ehr_api_runtime, hid_schema_test_runtime;
revoke all on identity.clinician_applications, identity.clinician_application_challenges,
  identity.clinician_application_sessions, identity.clinician_application_idempotency,
  platform.clinician_application_quota_counters
  from public, hid_identity_runtime, hid_ehr_runtime, hid_api_runtime, hid_identity_api_runtime,
    hid_ehr_api_runtime, hid_schema_test_runtime;

-- End the temporary memberships granted after the role check above. A
-- creator's ADMIN OPTION, which PostgreSQL 16 gives a CREATEROLE
-- administrator in every role it creates, is a separate grant and stays; it
-- carries no privilege and no SET ROLE.
revoke hid_event_delivery_commands, hid_ocr_queue_metrics, hid_platform_control_reader
  from current_user;
do $$
begin
  if exists (
    select 1 from pg_auth_members membership
     where membership.member = (select oid from pg_roles where rolname = current_user)
       and membership.roleid in (
         'hid_event_delivery_commands'::regrole, 'hid_ocr_queue_metrics'::regrole,
         'hid_platform_control_reader'::regrole)
       and (membership.inherit_option or membership.set_option)
  ) or exists (
    select 1 from pg_namespace namespace_row
     cross join unnest(array['hid_event_delivery_commands', 'hid_ocr_queue_metrics',
       'hid_platform_control_reader']) technical(role_name)
     where namespace_row.nspname in ('platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab',
         'pharmacy', 'outreach', 'integration', 'notification', 'migration')
       and has_schema_privilege(technical.role_name, namespace_row.oid, 'CREATE')
  ) then
    raise exception 'the role bootstrap left a temporary membership or schema CREATE grant in place';
  end if;
end
$$;
