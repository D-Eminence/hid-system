\set ON_ERROR_STOP on
-- Document scanning (0105): the GuardDuty bridge's account, its two read
-- commands, the scanner row lock and the OCR claim's detected media type.
-- Rollback-only.
--
-- Fixtures are inserted with session_replication_role = replica (no triggers
-- or foreign-key checks); every case then runs with triggers enforced, as the
-- exact runtime role: hid_document_scanner for the scanner commands (as the EHR
-- API's isolated workload pool sets its session: app.actor_subject is the
-- JWT's sub, app.correlation_id the request's), hid_identity_api_runtime for
-- identity-api's authenticateScanner query, hid_ocr_worker for the claim. Each
-- case records its outcome ('ok', or the SQLSTATE and message it raised) and
-- the suite fails at the end listing every case whose outcome differs. The
-- messages are the ones the EHR API maps to its 4xx codes
-- (services/ehr-api/src/documents/scan-errors.ts), so this suite pins them in
-- the database as the jest test pins them in the files.
--
-- Run on a database whose functions are owned by a role that is neither a
-- superuser nor BYPASSRLS, the append cases prove the 0105 row-lock policy:
-- without it, every append answers P0002 Document not found there. The OCR
-- claim case then expects no row (the worker's claim cannot see ocr.jobs under
-- such an owner, as test/database/ocr-worker-lease.integration.sql expects).
begin;

-- 1. The seed, the functions and their grants (as the suite owner).
do $$
declare
  mismatch text;
  scanner_account constant uuid := 'd0c5ca40-0105-4000-8000-000000000001';
begin
  if (select count(*) from auth.accounts account_row
       where account_row.id = scanner_account and account_row.subject = 'hid:staging:document-scanner'
         and account_row.status = 'active' and account_row.email is null and account_row.password_hash is null
         and account_row.password_algorithm is null and account_row.disabled_until is null
         and account_row.display_name = 'GuardDuty document scan bridge'
         and account_row.source_system = 'hid-workload') <> 1 then
    raise exception 'the scanner account is not as 0105 seeds it';
  end if;
  if (select count(*) from auth.account_roles assignment
       where assignment.account_id = scanner_account and assignment.revoked_at is null) <> 1
     or (select count(*) from auth.account_roles assignment
          where assignment.id = 'd0c5ca40-0105-4000-8000-000000000002' and assignment.account_id = scanner_account
            and assignment.role_code = 'document_scanner' and assignment.scope_type = 'platform'
            and assignment.membership_id is null and assignment.facility_id is null and assignment.granted_by is null
            and assignment.revoked_at is null and assignment.grant_reason like 'Owner approval (D-Eminence, 2026-10-31, D1)%'
            and assignment.grant_reason like '%migration 0105%') <> 1 then
    raise exception 'the scanner account must hold exactly the platform document_scanner role 0105 seeds';
  end if;
  if (select array_agg(grant_row.permission_code order by grant_row.permission_code)
        from auth.role_permissions grant_row where grant_row.role_code = 'document_scanner')
     is distinct from array['ehr.document.scan'] then
    raise exception 'document_scanner must grant exactly ehr.document.scan';
  end if;
  -- Attributes: SECURITY DEFINER, pinned search_path, owned like ehr.documents.
  select string_agg(format('%s: definer=%s config=%s owner=%s', p.oid::regprocedure, p.prosecdef, p.proconfig,
           p.proowner::regrole), '; ')
    into mismatch
    from pg_proc p
   where p.oid in ('ehr.resolve_document_scan_target(text,text,text,text)'::regprocedure,
                   'ehr.list_documents_awaiting_scan(integer,integer,text)'::regprocedure)
     and (not p.prosecdef or p.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]
          or p.proowner <> (select relowner from pg_class where oid = 'ehr.documents'::regclass));
  if mismatch is not null then
    raise exception 'scanner command attributes changed: %', mismatch;
  end if;
  -- No patient or facility ID in either result.
  if pg_get_function_result('ehr.resolve_document_scan_target(text,text,text,text)'::regprocedure) ~ '(patient|facility)'
     or pg_get_function_result('ehr.list_documents_awaiting_scan(integer,integer,text)'::regprocedure) ~ '(patient|facility)' then
    raise exception 'a scanner command returns a patient or facility column';
  end if;
  -- EXECUTE: hid_document_scanner only, never PUBLIC.
  select string_agg(format('%s on %s', coalesce(grantee.rolname, 'PUBLIC'), p.oid::regprocedure), '; ')
    into mismatch
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
    left join pg_roles grantee on grantee.oid = privilege.grantee
   where p.oid in ('ehr.resolve_document_scan_target(text,text,text,text)'::regprocedure,
                   'ehr.list_documents_awaiting_scan(integer,integer,text)'::regprocedure)
     and privilege.grantee <> p.proowner
     and coalesce(grantee.rolname, 'PUBLIC') <> 'hid_document_scanner';
  if mismatch is not null then
    raise exception 'unexpected EXECUTE grants on the scanner commands: %', mismatch;
  end if;
  if not has_function_privilege('hid_document_scanner', 'ehr.resolve_document_scan_target(text,text,text,text)', 'EXECUTE')
     or not has_function_privilege('hid_document_scanner', 'ehr.list_documents_awaiting_scan(integer,integer,text)', 'EXECUTE')
     or not has_function_privilege('hid_document_scanner',
       'ehr.append_document_scan_event(uuid,text,text,text,text,text,text,text,text,text)', 'EXECUTE') then
    raise exception 'hid_document_scanner lacks a scanner command';
  end if;
  -- The scanner still has no table, sequence or other function right.
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname in ('platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab', 'pharmacy', 'outreach')
                and c.relkind in ('r', 'p', 'v', 'm', 'S')
                and (has_table_privilege('hid_document_scanner', c.oid, 'SELECT')
                  or has_table_privilege('hid_document_scanner', c.oid, 'INSERT')
                  or has_table_privilege('hid_document_scanner', c.oid, 'UPDATE')
                  or has_table_privilege('hid_document_scanner', c.oid, 'DELETE'))) then
    raise exception 'hid_document_scanner holds a table privilege';
  end if;
  select string_agg(p.oid::regprocedure::text, '; ') into mismatch
    from pg_proc p, aclexplode(p.proacl) privilege
   where privilege.grantee = 'hid_document_scanner'::regrole
     and p.oid not in ('ehr.resolve_document_scan_target(text,text,text,text)'::regprocedure,
                       'ehr.list_documents_awaiting_scan(integer,integer,text)'::regprocedure,
                       'ehr.append_document_scan_event(uuid,text,text,text,text,text,text,text,text,text)'::regprocedure);
  if mismatch is not null then
    raise exception 'hid_document_scanner may execute other functions: %', mismatch;
  end if;
  -- The row-lock policy: UPDATE, permissive, PUBLIC, never admits a written row.
  if (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'ehr.documents'::regclass and policy_row.polname = 'documents_scanner_function_lock'
         and policy_row.polcmd = 'w' and policy_row.polpermissive and policy_row.polroles = array[0::oid]
         and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = 'false') <> 1
     or not exists (select 1 from pg_class where oid = 'ehr.documents'::regclass
                     and relrowsecurity and relforcerowsecurity) then
    raise exception 'the scanner row-lock policy or ehr.documents row-level security changed';
  end if;
end $$;

-- 2. Fixtures.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('dc5a0000-0000-4000-8000-000000000001', 'Scan Suite Organization', 'scan-suite-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('dc5a0000-0000-4000-8000-000000000002', 'dc5a0000-0000-4000-8000-000000000001', 'Scan Suite Clinic',
   'SCAN-SUITE-A', 'Africa/Lagos', true, 'verified');
insert into auth.accounts (id, subject, email, display_name, status) values
  ('dc5a1000-0000-4000-8000-000000000001', 'synthetic:scan-suite-clinician', 'scan-suite-clinician@example.invalid',
   'Scan Suite Clinician', 'active'),
  ('dc5a1000-0000-4000-8000-000000000002', 'workload:scan-suite-ocr-worker', null, 'Scan Suite OCR Worker', 'active');
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  ('dc5a8000-0000-4000-8000-000000000001', 'dc5a1000-0000-4000-8000-000000000002', 'ocr_worker', 'platform',
   'Synthetic scan suite OCR worker');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('dc5a2000-0000-4000-8000-000000000001', 'dc5a1000-0000-4000-8000-000000000001', 'Scan Suite Clinician',
   'scan-suite-clinician@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role) values
  ('dc5a3000-0000-4000-8000-000000000001', 'dc5a2000-0000-4000-8000-000000000001',
   'dc5a1000-0000-4000-8000-000000000001', 'dc5a0000-0000-4000-8000-000000000001',
   'dc5a0000-0000-4000-8000-000000000002', 'doctor', 'doctor');
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('dc5a4000-0000-4000-8000-000000000001', 'HID-SCNPAT', 'Scan', 'Patient', 'Scan Patient', 'active');
-- D1 uploaded (declared PDF); D2 not completed; D3 clean; D4 rejected; D5 two
-- scan_started and a failed; D6 entered in error; D7 uploaded; D8 uploaded just
-- now; D9 uploaded, with a quarantined legacy clean event bound to nothing.
-- updated_at is fixed far in the past so the list's order is theirs.
insert into ehr.documents (id, patient_id, facility_id, created_by, created_by_membership_id, original_file_name,
  storage_bucket, storage_key, object_version_id, declared_media_type, size_bytes, sha256_hex, status,
  retention_class, created_at, updated_at)
select ('dc5a5000-0000-4000-8000-00000000000' || d.n)::uuid, 'dc5a4000-0000-4000-8000-000000000001',
       'dc5a0000-0000-4000-8000-000000000002', 'dc5a1000-0000-4000-8000-000000000001',
       'dc5a3000-0000-4000-8000-000000000001', 'scan-suite-' || d.n || '.pdf', 'hid-scan-suite',
       'clinical/objects/dc5a5000-0000-4000-8000-00000000000' || d.n,
       case when d.status = 'initiated' then null else 'scan-v' || d.n end, 'application/pdf',
       1024, repeat(d.n::text, 64), d.status, 'clinical_record', d.changed, d.changed
  from (values (1, 'uploaded', timestamptz '2000-01-01 01:00+00'),
               (2, 'initiated', timestamptz '2000-01-01 00:30+00'),
               (3, 'uploaded', timestamptz '2000-01-01 00:10+00'),
               (4, 'uploaded', timestamptz '2000-01-01 00:20+00'),
               (5, 'uploaded', timestamptz '2000-01-01 00:00+00'),
               (6, 'entered_in_error', timestamptz '2000-01-01 00:40+00'),
               (7, 'uploaded', timestamptz '2000-01-01 02:00+00'),
               (8, 'uploaded', clock_timestamp()),
               (9, 'uploaded', timestamptz '2000-01-01 03:00+00')) d(n, status, changed);
insert into ehr.document_scan_events (id, document_id, patient_id, facility_id, created_by, event_type,
  detected_media_type, reason_code, scanner_engine, scanner_version, idempotency_key, correlation_id,
  object_version_id, object_sha256_hex, binding_migration_hold_reason, created_at)
select ('dc5a6000-0000-4000-8000-00000000000' || e.n)::uuid, ('dc5a5000-0000-4000-8000-00000000000' || e.document)::uuid,
       'dc5a4000-0000-4000-8000-000000000001', 'dc5a0000-0000-4000-8000-000000000002',
       'd0c5ca40-0105-4000-8000-000000000001', e.event_type, e.detected, e.reason,
       'aws-guardduty-malware-protection-s3', '1.0', 'scan-suite-fixture-000' || e.n, 'scan-suite-fixture',
       case when e.held then null else 'scan-v' || e.document end,
       case when e.held then null else repeat(e.document::text, 64) end,
       case when e.held then 'legacy scan event lacks immutable object binding' end, e.at
  from (values (1, 3, 'clean', 'application/pdf', null, false, timestamptz '2000-01-02 00:00+00'),
               (2, 4, 'rejected', null, 'guardduty.threats-found', false, timestamptz '2000-01-02 00:00+00'),
               (3, 5, 'scan_started', null, null, false, timestamptz '2000-01-02 00:00+00'),
               (4, 5, 'scan_started', null, null, false, timestamptz '2000-01-02 01:00+00'),
               (5, 5, 'failed', null, 'guardduty.failed', false, timestamptz '2000-01-02 02:00+00'),
               (6, 9, 'clean', 'application/pdf', null, true, timestamptz '2000-01-02 00:00+00'))
         e(n, document, event_type, detected, reason, held, at);
set local session_replication_role = origin;

-- Whether the commands' owner can see ocr.jobs (it cannot under an owner that
-- is neither a superuser nor BYPASSRLS; see the header).
do $$
declare owner_role text := (select proowner::regrole::text from pg_proc
                             where oid = 'ocr.claim_worker_job(text,integer)'::regprocedure);
begin
  perform set_config('scan_suite.owner_bypasses_rls',
    (select (rolsuper or rolbypassrls)::text from pg_roles where rolname = owner_role), true);
end $$;

create temporary table scan_cases (
  seq serial, name text primary key, expected text not null, actual text
) on commit drop;

-- Runs a statement as run_as: 'ok', or the SQLSTATE and message it raised.
-- With keep = false a successful statement is undone.
create function pg_temp.scan_try(run_as text, statement text, keep boolean) returns text language plpgsql as $$
declare outcome text;
begin
  execute format('set local role %I', run_as);
  begin
    execute statement;
    outcome := 'ok';
    if not keep then raise exception using errcode = 'P0001', message = 'document-scanner-suite: undo'; end if;
  exception when others then
    if sqlerrm <> 'document-scanner-suite: undo' then outcome := sqlstate || ' ' || sqlerrm; end if;
  end;
  reset role;
  return outcome;
end $$;
create function pg_temp.scan_case(case_name text, run_as text, expected text, statement text, keep boolean)
returns void language plpgsql as $$
begin
  insert into scan_cases (name, expected, actual)
  values (case_name, expected, pg_temp.scan_try(run_as, statement, keep));
end $$;
-- The EHR API's workload session (DatabaseService.withWorkloadTransaction).
create function pg_temp.as_workload(subject text, correlation text) returns void language plpgsql as $$
begin
  perform set_config('app.actor_subject', subject, true), set_config('app.correlation_id', correlation, true);
end $$;

-- 3. identity-api's authenticateScanner query (workload-auth.service.ts,
-- verbatim but for the subject), as the Identity API runtime. The issuer mints
-- sub hid:staging:document-scanner for the bridge in production (the promoted
-- staging stack); another environment's subject or a revoked role is refused.
create function pg_temp.identity_accepts(subject text) returns text language plpgsql as $fn$
begin
  return format($q$
  do $d$ begin
    if (select string_agg(account_id, ',') from (select account.id::text as account_id
         from auth.accounts account
        where account.subject = %L
          and account.status = 'active'
          and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
          and auth.account_has_active_role(account.id, 'document_scanner')) accepted)
       is distinct from 'd0c5ca40-0105-4000-8000-000000000001' then
      raise exception using errcode = 'P0001', message = 'not accepted';
    end if;
  end $d$$q$, subject);
end $fn$;
select pg_temp.scan_case('identity: hid:staging:document-scanner accepted', 'hid_identity_api_runtime', 'ok',
  pg_temp.identity_accepts('hid:staging:document-scanner'), false);
select pg_temp.scan_case('identity: hid:production:document-scanner refused', 'hid_identity_api_runtime',
  'P0001 not accepted', pg_temp.identity_accepts('hid:production:document-scanner'), false);
savepoint revoked;
update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = 'dc5a1000-0000-4000-8000-000000000001',
  revocation_reason = 'Scan suite kill switch'
 where id = 'd0c5ca40-0105-4000-8000-000000000002';
select pg_temp.scan_case('identity: refused once the role is revoked (kill switch)', 'hid_identity_api_runtime',
  'P0001 not accepted', pg_temp.identity_accepts('hid:staging:document-scanner'), false);
rollback to savepoint revoked;
savepoint disabled;
update auth.accounts set status = 'disabled' where id = 'd0c5ca40-0105-4000-8000-000000000001';
select pg_temp.scan_case('identity: refused once the account is disabled', 'hid_identity_api_runtime',
  'P0001 not accepted', pg_temp.identity_accepts('hid:staging:document-scanner'), false);
rollback to savepoint disabled;

-- 4. Resolve, as the bridge's session.
-- First with no correlation ID in the transaction at all: nothing earlier in
-- this session has set app.correlation_id, so platform.current_correlation_id()
-- is null and a correlation ID passed in must still be refused.
select set_config('app.actor_subject', 'hid:staging:document-scanner', true);
do $$ begin
  if platform.current_correlation_id() is not null then
    raise exception 'document scanner suite: app.correlation_id is set before the no-correlation cases';
  end if;
end $$;
select pg_temp.scan_case('resolve: the transaction carries no correlation ID', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  $s$select * from ehr.resolve_document_scan_target('hid-scan-suite',
    'clinical/objects/dc5a5000-0000-4000-8000-000000000001', 'scan-v1', 'scan-suite-correlation-0001')$s$, false);
select pg_temp.scan_case('list: the transaction carries no correlation ID', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  $s$select * from ehr.list_documents_awaiting_scan(0, 10, 'scan-suite-correlation-0001')$s$, false);
select pg_temp.scan_case('resolve: no correlation ID passed and none in the transaction', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  $s$select * from ehr.resolve_document_scan_target('hid-scan-suite',
    'clinical/objects/dc5a5000-0000-4000-8000-000000000001', 'scan-v1', null)$s$, false);
select pg_temp.scan_case('list: no correlation ID passed and none in the transaction', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  $s$select * from ehr.list_documents_awaiting_scan(0, 10, null)$s$, false);
select pg_temp.as_workload('hid:staging:document-scanner', 'scan-suite-correlation-0001');
create function pg_temp.resolve_expect(document_n integer, version text, expected jsonb) returns text
language plpgsql as $fn$
begin
  return format($q$
  do $d$
  declare got jsonb;
  begin
    select to_jsonb(r) into strict got
      from ehr.resolve_document_scan_target('hid-scan-suite',
             'clinical/objects/dc5a5000-0000-4000-8000-00000000000%s', %L, 'scan-suite-correlation-0001') r;
    if got is distinct from %L::jsonb then
      raise exception using errcode = 'P0001', message = 'resolve returned ' || got::text;
    end if;
  end $d$$q$, document_n, version, expected::text);
end $fn$;
create function pg_temp.resolve_call(bucket text, document_key text, version text, correlation text) returns text
language plpgsql as $$
begin
  return format('select * from ehr.resolve_document_scan_target(%L, %L, %L, %L)', bucket, document_key, version,
    correlation);
end $$;

select pg_temp.scan_case('resolve: uploaded, no event yet', 'hid_document_scanner', 'ok',
  pg_temp.resolve_expect(1, 'scan-v1', jsonb_build_object('document_id', 'dc5a5000-0000-4000-8000-000000000001',
    'object_version_id', 'scan-v1', 'sha256_hex', repeat('1', 64), 'status', 'uploaded',
    'declared_media_type', 'application/pdf', 'latest_event_type', null)), true);
select pg_temp.scan_case('resolve: failed and scan_started are not terminal', 'hid_document_scanner', 'ok',
  pg_temp.resolve_expect(5, 'scan-v5', jsonb_build_object('document_id', 'dc5a5000-0000-4000-8000-000000000005',
    'object_version_id', 'scan-v5', 'sha256_hex', repeat('5', 64), 'status', 'uploaded',
    'declared_media_type', 'application/pdf', 'latest_event_type', 'failed')), false);
select pg_temp.scan_case('resolve: a quarantined legacy clean event does not count', 'hid_document_scanner', 'ok',
  pg_temp.resolve_expect(9, 'scan-v9', jsonb_build_object('document_id', 'dc5a5000-0000-4000-8000-000000000009',
    'object_version_id', 'scan-v9', 'sha256_hex', repeat('9', 64), 'status', 'uploaded',
    'declared_media_type', 'application/pdf', 'latest_event_type', null)), false);
select pg_temp.scan_case('resolve: upload not completed', 'hid_document_scanner',
  '55000 Only an uploaded document can be scanned',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000002', 'scan-v2',
    'scan-suite-correlation-0001'), false);
select pg_temp.scan_case('resolve: clean is terminal', 'hid_document_scanner',
  '55000 Document object scan has already reached a terminal result',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000003', 'scan-v3',
    'scan-suite-correlation-0001'), false);
select pg_temp.scan_case('resolve: rejected is terminal', 'hid_document_scanner',
  '55000 Document object scan has already reached a terminal result',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000004', 'scan-v4',
    'scan-suite-correlation-0001'), false);
select pg_temp.scan_case('resolve: entered in error', 'hid_document_scanner',
  '55000 Document is no longer awaiting a scan',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000006', 'scan-v6',
    'scan-suite-correlation-0001'), false);
select pg_temp.scan_case('resolve: another version of the key is bound', 'hid_document_scanner',
  '55000 Scan result does not match the current immutable document object',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000007', 'scan-v7-earlier',
    'scan-suite-correlation-0001'), false);
select pg_temp.scan_case('resolve: unknown key', 'hid_document_scanner', 'P0002 Document not found',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-00000000000f', 'scan-v1',
    'scan-suite-correlation-0001'), false);
select pg_temp.scan_case('resolve: the key in another bucket', 'hid_document_scanner', 'P0002 Document not found',
  pg_temp.resolve_call('hid-other-bucket', 'clinical/objects/dc5a5000-0000-4000-8000-000000000001', 'scan-v1',
    'scan-suite-correlation-0001'), false);
select pg_temp.scan_case('resolve: bucket too short', 'hid_document_scanner', '22023 Invalid document scan target',
  pg_temp.resolve_call('ab', 'clinical/objects/x', 'scan-v1', 'scan-suite-correlation-0001'), false);
select pg_temp.scan_case('resolve: empty key', 'hid_document_scanner', '22023 Invalid document scan target',
  pg_temp.resolve_call('hid-scan-suite', '', 'scan-v1', 'scan-suite-correlation-0001'), false);
select pg_temp.scan_case('resolve: version too long', 'hid_document_scanner', '22023 Invalid document scan target',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/x', repeat('v', 1025), 'scan-suite-correlation-0001'),
  false);
select pg_temp.scan_case('resolve: no version', 'hid_document_scanner', '22023 Invalid document scan target',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/x', null, 'scan-suite-correlation-0001'), false);
select pg_temp.scan_case('resolve: correlation is not the transaction''s', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000001', 'scan-v1',
    'scan-suite-correlation-other'), false);
select pg_temp.scan_case('resolve: no correlation', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000001', 'scan-v1', null),
  false);
select pg_temp.as_workload('hid:staging:document-scanner', '');
select pg_temp.scan_case('resolve: the transaction''s correlation ID is empty', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000001', 'scan-v1',
    'scan-suite-correlation-0001'), false);
select pg_temp.as_workload('hid:staging:document-scanner', 'scan-suite-correlation-0001');
select pg_temp.scan_case('resolve: the scanner reads no table itself', 'hid_document_scanner', '42501 refused', $s$
  do $d$ begin
    perform count(*) from ehr.documents;
  exception when insufficient_privilege then
    raise exception using errcode = '42501', message = 'refused';
  end $d$$s$, false);
select pg_temp.scan_case('resolve: the EHR runtime may not call it', 'hid_ehr_runtime',
  '42501 permission denied for function resolve_document_scan_target',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000001', 'scan-v1',
    'scan-suite-correlation-0001'), false);
select pg_temp.scan_case('resolve: the schema-test runtime may not call it', 'hid_schema_test_runtime',
  '42501 permission denied for function resolve_document_scan_target',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000001', 'scan-v1',
    'scan-suite-correlation-0001'), false);
select pg_temp.as_workload('synthetic:scan-suite-clinician', 'scan-suite-correlation-0001');
select pg_temp.scan_case('resolve: an actor without the scanner role', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000001', 'scan-v1',
    'scan-suite-correlation-0001'), false);
select pg_temp.as_workload('hid:staging:document-scanner', 'scan-suite-correlation-0001');
savepoint revoked;
update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = 'dc5a1000-0000-4000-8000-000000000001',
  revocation_reason = 'Scan suite kill switch'
 where id = 'd0c5ca40-0105-4000-8000-000000000002';
select pg_temp.scan_case('resolve: refused once the role is revoked', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000001', 'scan-v1',
    'scan-suite-correlation-0001'), false);
rollback to savepoint revoked;

-- 5. The work list.
create function pg_temp.list_expect(older_than integer, max_rows integer, expected text) returns text
language plpgsql as $fn$
begin
  return format($q$
  do $d$
  declare got text;
  begin
    select string_agg(right(r.document_id::text, 1), ',' order by r.ordinality) into got
      from ehr.list_documents_awaiting_scan(%s, %s, 'scan-suite-correlation-0001') with ordinality r
     where r.document_id::text like 'dc5a5000-%%';
    if got is distinct from %L then
      raise exception using errcode = 'P0001', message = 'listed ' || coalesce(got, 'nothing');
    end if;
  end $d$$q$, older_than, max_rows, expected);
end $fn$;
select pg_temp.scan_case('list: older than 900 s, oldest first, no terminal, no other status',
  'hid_document_scanner', 'ok', pg_temp.list_expect(900, 100, '5,1,7,9'), false);
select pg_temp.scan_case('list: older than 0 s includes the one uploaded just now',
  'hid_document_scanner', 'ok', pg_temp.list_expect(0, 100, '5,1,7,9,8'), false);
select pg_temp.scan_case('list: at most the rows asked', 'hid_document_scanner', 'ok',
  pg_temp.list_expect(900, 2, '5,1'), false);
select pg_temp.scan_case('list: the scan_started count, last start and latest event', 'hid_document_scanner', 'ok', $s$
  do $d$
  declare got jsonb;
  begin
    select to_jsonb(r) into strict got
      from ehr.list_documents_awaiting_scan(900, 100, 'scan-suite-correlation-0001') r
     where r.document_id = 'dc5a5000-0000-4000-8000-000000000005';
    if got is distinct from jsonb_build_object('document_id', 'dc5a5000-0000-4000-8000-000000000005',
         'storage_bucket', 'hid-scan-suite', 'storage_key', 'clinical/objects/dc5a5000-0000-4000-8000-000000000005',
         'object_version_id', 'scan-v5', 'sha256_hex', repeat('5', 64), 'declared_media_type', 'application/pdf',
         'updated_at', to_jsonb(timestamptz '2000-01-01 00:00+00'), 'latest_event_type', 'failed',
         'scan_started_count', 2, 'last_scan_started_at', to_jsonb(timestamptz '2000-01-02 01:00+00')) then
      raise exception using errcode = 'P0001', message = 'listed ' || got::text;
    end if;
  end $d$$s$, false);
select pg_temp.scan_case('list: negative age', 'hid_document_scanner', '22023 Invalid scan target list request',
  $s$select * from ehr.list_documents_awaiting_scan(-1, 10, 'scan-suite-correlation-0001')$s$, false);
select pg_temp.scan_case('list: age over a year', 'hid_document_scanner', '22023 Invalid scan target list request',
  $s$select * from ehr.list_documents_awaiting_scan(31536001, 10, 'scan-suite-correlation-0001')$s$, false);
select pg_temp.scan_case('list: no rows asked', 'hid_document_scanner', '22023 Invalid scan target list request',
  $s$select * from ehr.list_documents_awaiting_scan(0, 0, 'scan-suite-correlation-0001')$s$, false);
select pg_temp.scan_case('list: more than 100 rows', 'hid_document_scanner', '22023 Invalid scan target list request',
  $s$select * from ehr.list_documents_awaiting_scan(0, 101, 'scan-suite-correlation-0001')$s$, false);
select pg_temp.scan_case('list: null age', 'hid_document_scanner', '22023 Invalid scan target list request',
  $s$select * from ehr.list_documents_awaiting_scan(null, 10, 'scan-suite-correlation-0001')$s$, false);
select pg_temp.scan_case('list: correlation is not the transaction''s', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  $s$select * from ehr.list_documents_awaiting_scan(0, 10, 'scan-suite-correlation-other')$s$, false);
select pg_temp.as_workload('hid:staging:document-scanner', '');
select pg_temp.scan_case('list: the transaction''s correlation ID is empty', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  $s$select * from ehr.list_documents_awaiting_scan(0, 10, 'scan-suite-correlation-0001')$s$, false);
select pg_temp.as_workload('hid:staging:document-scanner', 'scan-suite-correlation-0001');
select pg_temp.scan_case('list: the EHR runtime may not call it', 'hid_ehr_runtime',
  '42501 permission denied for function list_documents_awaiting_scan',
  $s$select * from ehr.list_documents_awaiting_scan(0, 10, 'scan-suite-correlation-0001')$s$, false);
select pg_temp.as_workload('synthetic:scan-suite-clinician', 'scan-suite-correlation-0001');
select pg_temp.scan_case('list: an actor without the scanner role', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  $s$select * from ehr.list_documents_awaiting_scan(0, 10, 'scan-suite-correlation-0001')$s$, false);
select pg_temp.as_workload('hid:staging:document-scanner', 'scan-suite-correlation-0002');
-- Kept: one audited list call.
select pg_temp.scan_case('list: one audited call', 'hid_document_scanner', 'ok',
  $s$select * from ehr.list_documents_awaiting_scan(900, 100, 'scan-suite-correlation-0002')$s$, true);

-- 6. Appends through the scanner context (the EHR API's scan-events), with
-- the messages it maps. D1 was declared application/pdf; the bytes are a JPEG,
-- so under owner decision D3 the bridge sends clean with the detected type.
select pg_temp.as_workload('hid:staging:document-scanner', 'scan-suite-correlation-0003');
create function pg_temp.append_call(document_n text, version text, sha text, event_type text, detected text,
  reason text, idempotency_key text) returns text language plpgsql as $$
begin
  return format('select ehr.append_document_scan_event(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L)',
    'dc5a5000-0000-4000-8000-00000000000' || document_n, version, sha, event_type, detected,
    'aws-guardduty-malware-protection-s3', '1.0', reason, idempotency_key, 'scan-suite-correlation-0003');
end $$;
select pg_temp.scan_case('append: clean under the detected type (D3), kept', 'hid_document_scanner', 'ok',
  $s$select set_config('scan_suite.d1_event', ehr.append_document_scan_event('dc5a5000-0000-4000-8000-000000000001',
    'scan-v1', repeat('1', 64), 'clean', 'image/jpeg', 'aws-guardduty-malware-protection-s3', '1.0', null,
    'gdmp-scan-suite-d1-clean', 'scan-suite-correlation-0003')::text, true)$s$, true);
select pg_temp.scan_case('append: the identical replay answers the first event', 'hid_document_scanner', 'ok', $s$
  do $d$ begin
    if ehr.append_document_scan_event('dc5a5000-0000-4000-8000-000000000001', 'scan-v1', repeat('1', 64), 'clean',
         'image/jpeg', 'aws-guardduty-malware-protection-s3', '1.0', null, 'gdmp-scan-suite-d1-clean',
         'scan-suite-correlation-0003')::text is distinct from current_setting('scan_suite.d1_event', true) then
      raise exception using errcode = 'P0001', message = 'the replay answered another event';
    end if;
  end $d$$s$, false);
select pg_temp.scan_case('append: the same key with another payload', 'hid_document_scanner',
  '23505 Scanner idempotency key payload mismatch',
  pg_temp.append_call('1', 'scan-v1', repeat('1', 64), 'clean', 'application/pdf', null, 'gdmp-scan-suite-d1-clean'),
  false);
select pg_temp.scan_case('append: after a terminal result', 'hid_document_scanner',
  '55000 Document object scan has already reached a terminal result',
  pg_temp.append_call('1', 'scan-v1', repeat('1', 64), 'rejected', null, 'guardduty.threats-found',
    'gdmp-scan-suite-d1-later'), false);
select pg_temp.scan_case('append: upload not completed', 'hid_document_scanner',
  '55000 Only an uploaded document can be scanned',
  pg_temp.append_call('2', 'scan-v2', repeat('2', 64), 'scan_started', null, null, 'gdod-scan-suite-d2-start'), false);
select pg_temp.scan_case('append: unknown document', 'hid_document_scanner', 'P0002 Document not found',
  pg_temp.append_call('f', 'scan-v1', repeat('1', 64), 'scan_started', null, null, 'gdod-scan-suite-df-start'), false);
select pg_temp.scan_case('append: another object than the bound one', 'hid_document_scanner',
  '55000 Scan result does not match the current immutable document object',
  pg_temp.append_call('7', 'scan-v7', repeat('a', 64), 'scan_started', null, null, 'gdod-scan-suite-d7-start'), false);
select pg_temp.scan_case('append: an unknown event type', 'hid_document_scanner', '22023 Invalid document scan event type',
  pg_temp.append_call('7', 'scan-v7', repeat('7', 64), 'infected', null, 'x', 'gdmp-scan-suite-d7-bad'), false);
select pg_temp.scan_case('append: clean needs one of the four types', 'hid_document_scanner',
  '22023 A supported detected media type is required for a clean scan',
  pg_temp.append_call('7', 'scan-v7', repeat('7', 64), 'clean', 'image/gif', null, 'gdmp-scan-suite-d7-gif'), false);
select pg_temp.scan_case('append: the D2 reason code', 'hid_document_scanner', 'ok',
  pg_temp.append_call('7', 'scan-v7', repeat('7', 64), 'rejected', null, 'guardduty.unsupported.password-protected',
    'gdmp-scan-suite-d7-unsupported'), false);
select pg_temp.scan_case('append: a reconcile start, kept', 'hid_document_scanner', 'ok',
  pg_temp.append_call('7', 'scan-v7', repeat('7', 64), 'scan_started', null, null, 'gdod-scan-suite-d7-start-1'), true);
select pg_temp.as_workload('synthetic:scan-suite-clinician', 'scan-suite-correlation-0003');
select pg_temp.scan_case('append: an actor without the scanner role', 'hid_document_scanner',
  '42501 Authorized document scanner context is required',
  pg_temp.append_call('7', 'scan-v7', repeat('7', 64), 'scan_started', null, null, 'gdod-scan-suite-d7-start-2'), false);
select pg_temp.as_workload('hid:staging:document-scanner', 'scan-suite-correlation-0001');
select pg_temp.scan_case('resolve: after the clean append D1 is terminal', 'hid_document_scanner',
  '55000 Document object scan has already reached a terminal result',
  pg_temp.resolve_call('hid-scan-suite', 'clinical/objects/dc5a5000-0000-4000-8000-000000000001', 'scan-v1',
    'scan-suite-correlation-0001'), false);
select pg_temp.scan_case('list: D1 has left the list; D7 shows its start', 'hid_document_scanner', 'ok', $s$
  do $d$
  declare got text;
  begin
    select string_agg(right(r.document_id::text, 1) || ':' || coalesce(r.latest_event_type, '-') || ':'
             || r.scan_started_count, ',' order by r.ordinality) into got
      from ehr.list_documents_awaiting_scan(900, 100, 'scan-suite-correlation-0001') with ordinality r
     where r.document_id::text like 'dc5a5000-%';
    if got is distinct from '5:failed:2,7:scan_started:1,9:-:0' then
      raise exception using errcode = 'P0001', message = 'listed ' || coalesce(got, 'nothing');
    end if;
  end $d$$s$, false);

-- 7. The OCR claim (D3): media_type is the detected type of the clean scan.
set local session_replication_role = replica;
insert into ocr.jobs (id, facility_id, document_id, patient_id, source_object_version_id, source_sha256_hex,
  idempotency_key, request_sha256, provider, max_attempts, created_by, created_by_membership_id, correlation_id)
values ('dc5a7000-0000-4000-8000-000000000001', 'dc5a0000-0000-4000-8000-000000000002',
        'dc5a5000-0000-4000-8000-000000000001', 'dc5a4000-0000-4000-8000-000000000001', 'scan-v1', repeat('1', 64),
        'scan-suite-ocr-job-0001', repeat('b', 64), 'scan-suite-provider', 3, 'dc5a1000-0000-4000-8000-000000000001',
        'dc5a3000-0000-4000-8000-000000000001', 'scan-suite-ocr-job');
set local session_replication_role = origin;
select set_config('app.actor_subject', 'workload:scan-suite-ocr-worker', true),
       set_config('app.correlation_id', 'scan-suite-ocr-worker', true);
select pg_temp.scan_case('claim: the detected type, not the declared one', 'hid_ocr_worker',
  case when current_setting('scan_suite.owner_bypasses_rls')::boolean then 'ok' else 'P0001 claimed nothing' end, $s$
  do $d$
  declare got text;
  begin
    select string_agg(c.document_id::text || ' ' || c.media_type, ',') into got
      from ocr.claim_worker_job('scan-suite-provider', 300) c;
    if got is null then
      raise exception using errcode = 'P0001', message = 'claimed nothing';
    end if;
    if got is distinct from 'dc5a5000-0000-4000-8000-000000000001 image/jpeg' then
      raise exception using errcode = 'P0001', message = 'claimed ' || got;
    end if;
  end $d$$s$, false);

-- 8. Outcomes the cases alone do not show, as the suite owner.
do $$
declare
  mismatches text;
  view_row record;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by seq)
    into mismatches
    from scan_cases
   where actual is distinct from expected;
  if mismatches is not null then
    raise exception E'document scanner cases failed (owner bypasses row-level security: %):\n%',
      current_setting('scan_suite.owner_bypasses_rls'), mismatches;
  end if;
  -- D3: the view the EHR API reads gives the detected type and available.
  select * into view_row from ehr.documents_effective where id = 'dc5a5000-0000-4000-8000-000000000001';
  if view_row.status <> 'available' or view_row.scan_status <> 'clean'
     or view_row.detected_media_type <> 'image/jpeg' or view_row.declared_media_type <> 'application/pdf' then
    raise exception 'documents_effective after a D3 clean scan: %', row_to_json(view_row);
  end if;
  -- One resolve audit row (the kept call), none for a refused one; one list row
  -- naming exactly what it listed; the append audited as usual.
  if (select count(*) from audit.events where action = 'ehr.document.scan-target.resolve'
        and resource_id = 'dc5a5000-0000-4000-8000-000000000001' and actor_type = 'workload'
        and actor_subject = 'hid:staging:document-scanner' and actor_account_id = 'd0c5ca40-0105-4000-8000-000000000001'
        and patient_id = 'dc5a4000-0000-4000-8000-000000000001' and facility_id = 'dc5a0000-0000-4000-8000-000000000002'
        and purpose_of_use = 'operations-security' and correlation_id = 'scan-suite-correlation-0001'
        and details = jsonb_build_object('object_version_id', 'scan-v1', 'latest_event_type', null)) <> 1
     or (select count(*) from audit.events where action = 'ehr.document.scan-target.resolve') <> 1 then
    raise exception 'resolve audit rows are not one per kept call';
  end if;
  if (select count(*) from audit.events where action = 'ehr.document.scan-target.list'
        and correlation_id = 'scan-suite-correlation-0002' and actor_type = 'workload' and patient_id is null
        and facility_id is null and purpose_of_use = 'operations-security'
        and details ->> 'returned' = '4' and details -> 'document_ids' = jsonb_build_array(
          'dc5a5000-0000-4000-8000-000000000005', 'dc5a5000-0000-4000-8000-000000000001',
          'dc5a5000-0000-4000-8000-000000000007', 'dc5a5000-0000-4000-8000-000000000009')) <> 1
     or (select count(*) from audit.events where action = 'ehr.document.scan-target.list') <> 1 then
    raise exception 'list audit rows are not one per kept call';
  end if;
  if (select count(*) from audit.events where action = 'ehr.document.scan.clean'
        and resource_id = 'dc5a5000-0000-4000-8000-000000000001') <> 1
     or (select count(*) from audit.events where action = 'ehr.document.scan.idempotent-replay') <> 0 then
    raise exception 'the kept append was not audited once';
  end if;
  raise notice 'document scanner suite: % cases passed (owner bypasses row-level security: %)',
    (select count(*) from scan_cases), current_setting('scan_suite.owner_bypasses_rls');
end $$;

rollback;
