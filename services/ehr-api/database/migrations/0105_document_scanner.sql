-- 0105 Document virus scanning with GuardDuty Malware Protection for S3 (owner
-- decisions of 2026-10-31 in chat, D-Eminence: D1 GuardDuty, D2 a file it
-- cannot scan is refused, D3 a type mismatch is accepted under the real type,
-- D4 enforcement only after the backfill; numbered 0105 by the owner's
-- decision 33 of 2026-11-03, "all recommended", item (6): records processing
-- 0104, scanner 0105, the owner re-signs each; the declaration is signed
-- separately). Written on 0103 (34d69557) from the unreleased 0101 of the
-- scan-be branch (2f3fd361): the same statements, with this number in its
-- messages, seed IDs and temporary names, and 0103's body as the
-- prerequisite marker instead of 0100's records-processing trigger. The
-- runner applies 0104 (records processing) first, but this file uses and
-- needs nothing 0104 adds, so it applies on 0103 alone or on 0103 + 0104.
-- Nothing here turns enforcement on: until the scanner's Terraform is applied
-- nothing calls the new commands, and every upload behaves exactly as today.
-- Production runs no virus scanner, so every uploaded document stays
-- scan-pending: it cannot be opened or sent to OCR. The scan contract has been
-- in place since 0009 (POST /ehr/documents/scan-events and
-- ehr.append_document_scan_event) but has never had a caller. A small bridge
-- Lambda will turn each GuardDuty scan result into a scan event; this file gives
-- it the account it authenticates as and the two read commands it needs, and
-- makes the OCR source use the type the scan detected.
--
-- Owner decisions: D1 GuardDuty Malware Protection for S3 on the documents
-- bucket (not ClamAV). D2 a file GuardDuty cannot scan is refused (the bridge
-- sends rejected, guardduty.unsupported.<reason>). D3 a media-type mismatch is
-- accepted under its real type: when the sniffed type is one of the four
-- allowed (application/pdf, image/jpeg, image/png, image/tiff) but differs from
-- the declared one, the bridge sends clean with detectedMediaType = the sniffed
-- type, and everything downstream uses the detected type; a sniffed type
-- outside the four is rejected (media.unsupported). D4 S3 tag enforcement
-- later, in Terraform. D5 no GuardDuty detector. D2 and D4 need nothing here.
--
-- S1 The scanner's account. identity-api's authenticateScanner accepts a
--    workload JWT (aud hid-identity-api, from the managed issuer) whose sub is
--    the subject of an active auth.accounts row holding the platform
--    document_scanner role. The issuer mints sub "hid:<environment>:<caller>"
--    with the application module's environment, which is "staging" in
--    production (the promoted staging stack), so the bridge's tokens carry
--    hid:staging:document-scanner. This file seeds that account (active, no
--    email, no password, so it can never sign in interactively; source_system
--    hid-workload) and its platform document_scanner role, ON CONFLICT DO
--    NOTHING; the role row's grant_reason names the approval. No audit row:
--    a dry run would consume audit.events' sequence, which the release's
--    rehearsal requires a dry run to leave as it was. The governed admin command
--    auth.admin_change_platform_role refuses this role (0064), so the seed
--    bypasses it: the owner signs that in the declaration. A row already there
--    must be exactly this one (else 55000, nothing applied), the account must
--    hold no other active role, and the role must grant only ehr.document.scan.
--    Kill switch, no release needed: revoke the role row (or set the account's
--    status to disabled), and identity-api refuses the bridge at once:
--      update auth.account_roles set revoked_at = clock_timestamp(),
--             revoked_by = <an admin account id>, revocation_reason = '<8-500 characters>'
--       where id = 'd0c5ca40-0105-4000-8000-000000000002' and revoked_at is null;
-- S2 ehr.resolve_document_scan_target(bucket, key, version, correlation id):
--    from the S3 object a GuardDuty result names to the document it belongs to.
--    It returns the document ID, the bound version, the SHA-256, the status,
--    the declared media type and the latest event on that version; no patient
--    or facility ID. It refuses as append_document_scan_event does, with the
--    same messages where the case is the same: P0002 Document not found (no
--    document holds that key in that bucket); 55000 Only an uploaded document
--    can be scanned (the upload is not completed yet, status initiated); 55000
--    Document is no longer awaiting a scan (status rejected or entered in
--    error); 55000 Scan result does not match the current immutable document
--    object (another version of the key is bound); 55000 Document object scan
--    has already reached a terminal result (clean or rejected on that version).
--    Writes one audit row, ehr.document.scan-target.resolve.
-- S3 ehr.list_documents_awaiting_scan(older than seconds, max rows,
--    correlation id): the reconcile and backfill work list. Uploaded documents
--    whose row last changed (the upload completion sets it) at least that many
--    seconds ago and that have no clean or rejected event on their bound
--    version and SHA-256, oldest first, at most 100; with the latest event on
--    that version and the number and time of its scan_started events. No
--    patient or facility ID. Writes one audit row,
--    ehr.document.scan-target.list, naming the documents listed.
--    Both functions: plpgsql, SECURITY DEFINER, search_path pg_catalog,
--    pg_temp, owned by ehr.documents' owner, EXECUTE for hid_document_scanner
--    only (its table rights stay none). Each first rechecks, as 0009 does, that
--    the actor (app.actor_subject) is an active account with the
--    document_scanner role and that the correlation ID passed is the
--    transaction's (42501 Authorized document scanner context is required;
--    compared with IS DISTINCT FROM, so a transaction without
--    app.correlation_id, unset or empty, is refused too), then validates its
--    arguments (22023).
-- S4 The row lock append_document_scan_event takes (SELECT ... FOR UPDATE on
--    ehr.documents, 0009). ehr.documents forces row-level security, and a
--    locking read must also pass the table's UPDATE policies, which only staff
--    context passes. Under an owner that neither is a superuser nor bypasses
--    row-level security, every append therefore found no row and answered
--    Document not found (measured on such an owner on a 0103 copy). One new
--    permissive UPDATE policy, documents_scanner_function_lock, lets the
--    scanner context lock rows: USING the same test as 0005's
--    documents_scanner_function_read, WITH CHECK (false), so it never admits a
--    written row. No other policy changes; the table's row-level security and
--    FORCE settings are unchanged.
-- S5 D3 downstream: the OCR worker's claim (ocr.claim_worker_job) returned the
--    declared media type, and the worker picks its Textract path by it. It now
--    returns the detected type of the clean scan the claim already requires
--    (bound to the job's source version and SHA-256, not held). The function is
--    replaced in the form RDS runs (rds-compat/0015: #variable_conflict
--    use_column in the body, search_path the only setting), its body otherwise
--    unchanged; owner, ACL and result columns are kept. On a database built
--    without MIGRATION_TARGET=rds the setting plpgsql.variable_conflict moves
--    from the function's configuration into its body, which means the same.
--    The EHR API's download, OCR source and list views use the detected type
--    in the service code; ehr.documents_effective already carries it.
--
-- 0. Preconditions (catalog reads, and the role, its permission and the seed
--    rows; each failure raises 55000 or 42501 and nothing is applied):
--    0001-0103 applied, 0103's identity.organization_application_admin_
--    account body the marker (else "0105: 0001-0103 must be applied first";
--    0104 is neither required nor read); not
--    applied yet (else "0105: already applied"); the bodies relied on are the
--    ones 0001-0103 gave them (md5 of pg_proc.prosrc; the claim either form of
--    0015); the columns read have their types and NOT NULLs; the object-key
--    unique index exists; document_scanner exists, is active and grants
--    exactly ehr.document.scan; ehr.documents, ehr.document_scan_events, the
--    append function and the claim share one owner, the applier is it or a
--    member that inherits it and may SET ROLE to it, and that owner may use
--    the schemas, write auth.accounts and auth.account_roles, write
--    audit.events (the two read commands' audit rows), read auth.roles and
--    execute the helpers (never through a superuser's
--    bypass).
-- 1. The seed (S1). 2. The two functions (S2, S3). 3. The claim (S5).
-- 4. Owners and grants. 5. The policy (S4). 6. Post-checks.
--
-- Locks (measured with pg_locks before commit on a 0103 copy): ROW EXCLUSIVE
-- on auth.accounts and auth.account_roles (the two seed rows);
-- ROW SHARE and ACCESS SHARE on auth.accounts and auth.roles (the foreign
-- keys) and ACCESS SHARE on auth.role_permissions and
-- identity.sealed_demo_members (the precondition and 0098's seal trigger);
-- SHARE UPDATE EXCLUSIVE on the two new functions and the claim (their
-- comments); ACCESS EXCLUSIVE on ehr.documents (CREATE POLICY), created last,
-- so a document read or write waits for this transaction's last statements
-- and the apply waits for one running; the schema, role and language read
-- locks; ACCESS EXCLUSIVE on the session's own temporary schema. No lock on
-- ocr.jobs is held at commit, but compiling the replaced claim (its
-- ocr.jobs%rowtype variables) briefly needs one: behind a session holding
-- ACCESS EXCLUSIVE on ocr.jobs the runner stopped after its 5 s lock_timeout
-- with nothing applied, and ROW EXCLUSIVE there did not delay it. Behind any
-- held conflicting lock the runner stops after its 5 s lock_timeout and
-- applies nothing.
--
-- Old services on this schema: today's EHR API never calls the new functions;
-- its scan-event, upload, completion, list, download and OCR-source SQL read
-- and write as before. Today's OCR worker reads the claim's media_type column
-- by name. Applied migrations 0001 through 0104 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass.
create function pg_temp.document_scanner_0105_holds(holder oid, object_owner oid, object_acl aclitem[],
  object_type "char", wanted text)
returns boolean
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  with recursive held(role_id) as (
    select holder
    union
    select membership.roleid from pg_catalog.pg_auth_members membership join held on membership.member = held.role_id
  )
  select object_owner in (select held.role_id from held)
    or exists (select 1 from pg_catalog.aclexplode(coalesce(object_acl, pg_catalog.acldefault(object_type, object_owner))) acl
                where acl.privilege_type = wanted
                  and (acl.grantee = 0 or acl.grantee in (select held.role_id from held)))
$$;

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
  table_owner oid;
begin
  -- a. Prerequisites: 0001-0103 (0103's admin gate body is the marker). Nothing
  -- 0104 adds is read or required.
  if to_regclass('ehr.documents') is null
     or to_regclass('ehr.document_scan_events') is null
     or to_regclass('ehr.documents_effective') is null
     or to_regclass('auth.accounts') is null
     or to_regclass('auth.account_roles') is null
     or to_regclass('auth.roles') is null
     or to_regclass('auth.role_permissions') is null
     or to_regclass('audit.events') is null
     or to_regclass('ocr.jobs') is null
     or to_regprocedure('ehr.append_document_scan_event(uuid,text,text,text,text,text,text,text,text,text)') is null
     or to_regprocedure('ocr.claim_worker_job(text,integer)') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null
     or to_regprocedure('auth.account_has_active_role(uuid,text)') is null
     or to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('platform.current_account_id()') is null
     or to_regprocedure('platform.current_correlation_id()') is null
     or to_regprocedure('identity.organization_application_admin_account(text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = 'identity.organization_application_admin_account(text)'::regprocedure)
        is distinct from '186eb4ca420749b8bdb324bdc843bc50' then
    raise exception using errcode = '55000', message = '0105: 0001-0103 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regprocedure('ehr.resolve_document_scan_target(text,text,text,text)') is not null
     or to_regprocedure('ehr.list_documents_awaiting_scan(integer,integer,text)') is not null
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polrelid = 'ehr.documents'::regclass
                   and policy_row.polname = 'documents_scanner_function_lock') then
    raise exception using errcode = '55000', message = '0105: already applied';
  end if;
  -- c. The bodies relied on, as 0001-0103 left them: the actor, account and
  -- correlation readers (0001, 0005, 0008), the role check (0005), the append
  -- command whose refusals the EHR API maps and whose row lock S4 admits
  -- (0009), and the claim S5 replaces (0014 as 0015 left it, either form).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('platform.current_actor_subject()', array['cf14c2d4a16d44a79ea9dbef9dc79c2b']),
      ('platform.current_account_id()', array['b715ffe72856836d13ab16656fa6e94a']),
      ('platform.current_correlation_id()', array['48d3bf187101d33bfda51dac829aa223']),
      ('auth.account_id_for_subject(text)', array['4678770cf6a210034740f09422fdfbaa']),
      ('auth.account_has_active_role(uuid,text)', array['a3310b48da6ff8bcd3ecb9d7dbef900a']),
      ('ehr.append_document_scan_event(uuid,text,text,text,text,text,text,text,text,text)',
        array['48028691118378511414feabd53ccbc7']),
      ('ocr.claim_worker_job(text,integer)',
        array['1572865c10fcfb673293e83776d6cf50', '59a60b466df9b8effeb3519939fc54a2']))
         expected(proc, digests)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where proc.oid is null or not (md5(proc.prosrc) = any (expected.digests));
  if mismatch is null
     and pg_get_function_result('ocr.claim_worker_job(text,integer)'::regprocedure) is distinct from
       'TABLE(job_id uuid, facility_id uuid, document_id uuid, patient_id uuid, storage_bucket text, '
       || 'storage_key text, object_version_id text, source_sha256_hex text, size_bytes bigint, media_type text, '
       || 'provider text, attempt_no integer, max_attempts integer, claim_token uuid, '
       || 'claim_expires_at timestamp with time zone, correlation_id text)' then
    mismatch := 'ocr.claim_worker_job(text,integer) result columns';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0105: a function this migration relies on differs from 0001-0103: %s', mismatch);
  end if;
  -- d. The columns read or written.
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('ehr.documents', 'id', 'uuid', true),
      ('ehr.documents', 'patient_id', 'uuid', true),
      ('ehr.documents', 'facility_id', 'uuid', true),
      ('ehr.documents', 'storage_bucket', 'text', true),
      ('ehr.documents', 'storage_key', 'text', true),
      ('ehr.documents', 'object_version_id', 'text', false),
      ('ehr.documents', 'declared_media_type', 'text', true),
      ('ehr.documents', 'sha256_hex', 'character(64)', false),
      ('ehr.documents', 'status', 'text', true),
      ('ehr.documents', 'created_at', 'timestamp with time zone', true),
      ('ehr.documents', 'updated_at', 'timestamp with time zone', true),
      ('ehr.document_scan_events', 'id', 'uuid', true),
      ('ehr.document_scan_events', 'document_id', 'uuid', true),
      ('ehr.document_scan_events', 'event_type', 'text', true),
      ('ehr.document_scan_events', 'detected_media_type', 'text', false),
      ('ehr.document_scan_events', 'object_version_id', 'text', false),
      ('ehr.document_scan_events', 'object_sha256_hex', 'character(64)', false),
      ('ehr.document_scan_events', 'binding_migration_hold_reason', 'text', false),
      ('ehr.document_scan_events', 'created_at', 'timestamp with time zone', true),
      ('auth.accounts', 'id', 'uuid', true),
      ('auth.accounts', 'subject', 'text', true),
      ('auth.accounts', 'email', 'text', false),
      ('auth.accounts', 'display_name', 'text', false),
      ('auth.accounts', 'status', 'text', true),
      ('auth.accounts', 'password_hash', 'text', false),
      ('auth.accounts', 'password_algorithm', 'text', false),
      ('auth.accounts', 'source_system', 'text', true),
      ('auth.accounts', 'disabled_until', 'timestamp with time zone', false),
      ('auth.account_roles', 'id', 'uuid', true),
      ('auth.account_roles', 'account_id', 'uuid', true),
      ('auth.account_roles', 'role_code', 'text', true),
      ('auth.account_roles', 'scope_type', 'text', true),
      ('auth.account_roles', 'membership_id', 'uuid', false),
      ('auth.account_roles', 'facility_id', 'uuid', false),
      ('auth.account_roles', 'granted_by', 'uuid', false),
      ('auth.account_roles', 'grant_reason', 'text', true),
      ('auth.account_roles', 'revoked_at', 'timestamp with time zone', false))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = expected.relation_name::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is null and not exists (
       select 1 from pg_index index_row
        where index_row.indrelid = 'ehr.documents'::regclass and index_row.indisunique and index_row.indisvalid
          and index_row.indpred is null
          and index_row.indkey::text = (select string_agg(attribute_row.attnum::text, ' ' order by wanted.position)
                                          from unnest(array['storage_bucket', 'storage_key', 'object_version_id'])
                                               with ordinality wanted(column_name, position)
                                          join pg_attribute attribute_row
                                            on attribute_row.attrelid = 'ehr.documents'::regclass
                                           and attribute_row.attname = wanted.column_name)) then
    mismatch := 'the unique index on ehr.documents (storage_bucket, storage_key, object_version_id)';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0105: a column this migration relies on differs from 0001-0103: %s', mismatch);
  end if;
  -- e. Ownership and privileges, never through a superuser's bypass
  -- (production's migrator has none).
  table_owner := (select relation.relowner from pg_class relation where relation.oid = 'ehr.documents'::regclass);
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not owned by %s', owned.what, pg_get_userbyid(table_owner)) as what
        from (select 'ehr.document_scan_events' as what, relation.relowner as owner_id from pg_class relation
               where relation.oid = 'ehr.document_scan_events'::regclass
              union all
              select proc.oid::regprocedure::text, proc.proowner from pg_proc proc
               where proc.oid in ('ehr.append_document_scan_event(uuid,text,text,text,text,text,text,text,text,text)'::regprocedure,
                                  'ocr.claim_worker_job(text,integer)'::regprocedure)) owned
       where owned.owner_id <> table_owner
      union all
      select format('%s is not %s and may not act as it (INHERIT and SET)', current_user, pg_get_userbyid(table_owner))
       where applier <> table_owner
         and not (pg_has_role(applier, table_owner, 'USAGE') and pg_has_role(applier, table_owner, 'SET'))
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(table_owner), wanted.privilege, namespace.nspname)
        from (values ('ehr', 'CREATE'), ('ehr', 'USAGE'), ('ocr', 'USAGE'), ('auth', 'USAGE'), ('audit', 'USAGE'),
                     ('platform', 'USAGE')) wanted(schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.document_scanner_0105_holds(table_owner, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks %s on %s', pg_get_userbyid(table_owner), wanted.privilege, relation.oid::regclass)
        from (values ('auth.accounts', 'INSERT'), ('auth.accounts', 'SELECT'), ('auth.account_roles', 'INSERT'),
                     ('auth.account_roles', 'SELECT'), ('auth.roles', 'SELECT'), ('auth.role_permissions', 'SELECT'),
                     ('audit.events', 'INSERT'), ('ocr.jobs', 'SELECT')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
       where not pg_temp.document_scanner_0105_holds(table_owner, relation.relowner, relation.relacl, 'r',
               wanted.privilege)
      union all
      select format('%s lacks EXECUTE on %s', pg_get_userbyid(table_owner), proc.oid::regprocedure)
        from (values ('platform.current_actor_subject()'), ('platform.current_account_id()'),
                     ('platform.current_correlation_id()'), ('auth.account_id_for_subject(text)'),
                     ('auth.account_has_active_role(uuid,text)')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
       where not pg_temp.document_scanner_0105_holds(table_owner, proc.proowner, proc.proacl, 'f', 'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0105: missing privileges: %s', mismatch);
  end if;
  -- f. The role the seed grants: active, platform-assignable, and granting
  -- exactly ehr.document.scan (0006), so the bridge gets nothing more.
  if not exists (select 1 from auth.roles role_row where role_row.code = 'document_scanner' and role_row.active)
     or (select array_agg(grant_row.permission_code order by grant_row.permission_code)
           from auth.role_permissions grant_row where grant_row.role_code = 'document_scanner')
        is distinct from array['ehr.document.scan'] then
    raise exception using errcode = '55000',
      message = '0105: the document_scanner role must exist, be active and grant exactly ehr.document.scan';
  end if;
  raise notice '0105: owners checked: ehr.documents=%, applier=%', pg_get_userbyid(table_owner), current_user;
end
$$;

-- 1. The seed (S1): the bridge's account and its platform role.
do $$
declare
  scanner_account constant uuid := 'd0c5ca40-0105-4000-8000-000000000001';
  scanner_role_row constant uuid := 'd0c5ca40-0105-4000-8000-000000000002';
  scanner_subject constant text := 'hid:staging:document-scanner';
  grant_text constant text := 'Owner approval (D-Eminence, 2026-10-31, D1): the GuardDuty document scan bridge '
    || 'workload. Seeded by migration 0105 outside auth.admin_change_platform_role, which refuses this role.';
  others integer;
begin
  insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm,
    source_system)
  values (scanner_account, scanner_subject, null, 'GuardDuty document scan bridge', 'active', null, null,
    'hid-workload')
  on conflict do nothing;
  if (select count(*) from auth.accounts account_row
       where account_row.id = scanner_account or account_row.subject = scanner_subject) <> 1
     or not exists (select 1 from auth.accounts account_row
                     where account_row.id = scanner_account and account_row.subject = scanner_subject
                       and account_row.status = 'active' and account_row.email is null
                       and account_row.password_hash is null and account_row.password_algorithm is null
                       and account_row.disabled_until is null and account_row.source_system = 'hid-workload') then
    raise exception using errcode = '55000',
      message = format('0105: auth.accounts already holds %s or %s, not as this file seeds it', scanner_account,
        scanner_subject);
  end if;

  insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, granted_by,
    grant_reason)
  values (scanner_role_row, scanner_account, 'document_scanner', 'platform', null, null, null, grant_text)
  on conflict do nothing;
  if (select count(*) from auth.account_roles assignment
       where assignment.account_id = scanner_account and assignment.revoked_at is null) <> 1
     or not exists (select 1 from auth.account_roles assignment
                     where assignment.id = scanner_role_row and assignment.account_id = scanner_account
                       and assignment.role_code = 'document_scanner' and assignment.scope_type = 'platform'
                       and assignment.membership_id is null and assignment.facility_id is null
                       and assignment.revoked_at is null) then
    raise exception using errcode = '55000',
      message = '0105: the scanner account must hold exactly one active role, the platform document_scanner row this file seeds';
  end if;
  others := (select count(distinct assignment.account_id) from auth.account_roles assignment
              where assignment.role_code = 'document_scanner' and assignment.revoked_at is null
                and assignment.account_id <> scanner_account);
  raise notice '0105: scanner account %, subject %; other accounts holding document_scanner: %',
    scanner_account, scanner_subject, others;
end
$$;

-- 2. The two read commands (S2, S3).
create function ehr.resolve_document_scan_target(
  requested_storage_bucket text,
  requested_storage_key text,
  requested_object_version_id text,
  requested_correlation_id text
)
returns table (
  document_id uuid,
  object_version_id text,
  sha256_hex text,
  status text,
  declared_media_type text,
  latest_event_type text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  document_row ehr.documents%rowtype;
  latest_event text;
begin
  if actor_account is null
     or not auth.account_has_active_role(actor_account, 'document_scanner')
     or requested_correlation_id is null
     or requested_correlation_id is distinct from platform.current_correlation_id() then
    raise exception using errcode = '42501', message = 'Authorized document scanner context is required';
  end if;
  if length(coalesce(requested_storage_bucket, '')) not between 3 and 63
     or length(coalesce(requested_storage_key, '')) not between 1 and 1024
     or length(coalesce(requested_object_version_id, '')) not between 1 and 1024 then
    raise exception using errcode = '22023', message = 'Invalid document scan target';
  end if;

  select * into document_row
    from ehr.documents candidate
   where candidate.storage_bucket = requested_storage_bucket
     and candidate.storage_key = requested_storage_key
     and candidate.object_version_id = requested_object_version_id;
  if not found then
    -- Another row for the key: one not completed yet first, then the latest.
    select * into document_row
      from ehr.documents candidate
     where candidate.storage_bucket = requested_storage_bucket
       and candidate.storage_key = requested_storage_key
     order by (candidate.object_version_id is null) desc, candidate.created_at desc, candidate.id desc
     limit 1;
    if not found then
      raise exception using errcode = 'P0002', message = 'Document not found';
    end if;
  end if;
  if document_row.status = 'initiated' then
    raise exception using errcode = '55000', message = 'Only an uploaded document can be scanned';
  end if;
  if document_row.status <> 'uploaded' then
    raise exception using errcode = '55000', message = 'Document is no longer awaiting a scan';
  end if;
  if document_row.object_version_id is distinct from requested_object_version_id then
    raise exception using errcode = '55000', message = 'Scan result does not match the current immutable document object';
  end if;
  if exists (select 1 from ehr.document_scan_events terminal_event
              where terminal_event.document_id = document_row.id
                and terminal_event.object_version_id = document_row.object_version_id
                and terminal_event.object_sha256_hex = document_row.sha256_hex
                and terminal_event.event_type in ('clean', 'rejected')) then
    raise exception using errcode = '55000', message = 'Document object scan has already reached a terminal result';
  end if;

  select scan_event.event_type into latest_event
    from ehr.document_scan_events scan_event
   where scan_event.document_id = document_row.id
     and scan_event.object_version_id = document_row.object_version_id
     and scan_event.object_sha256_hex = document_row.sha256_hex
   order by scan_event.created_at desc, scan_event.id desc
   limit 1;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    requested_correlation_id, 'workload', actor_subject, actor_account,
    document_row.facility_id, document_row.patient_id,
    'ehr.document.scan-target.resolve', 'success', 'document', document_row.id::text,
    'operations-security', 'application', 'ehr-document-scanner',
    jsonb_build_object('object_version_id', document_row.object_version_id, 'latest_event_type', latest_event)
  );

  return query select document_row.id, document_row.object_version_id, document_row.sha256_hex::text,
    document_row.status, document_row.declared_media_type, latest_event;
end
$$;

comment on function ehr.resolve_document_scan_target(text, text, text, text) is
  '0105: the document an S3 object version belongs to, for the document scanner only (42501 otherwise): document ID, bound version, SHA-256, status, declared media type and the latest event on that version; no patient or facility ID. P0002 Document not found; 55000 Only an uploaded document can be scanned (initiated), Document is no longer awaiting a scan, Scan result does not match the current immutable document object (another version bound), Document object scan has already reached a terminal result. Audited as ehr.document.scan-target.resolve.';

create function ehr.list_documents_awaiting_scan(
  requested_older_than_seconds integer,
  requested_max_rows integer,
  requested_correlation_id text
)
returns table (
  document_id uuid,
  storage_bucket text,
  storage_key text,
  object_version_id text,
  sha256_hex text,
  declared_media_type text,
  updated_at timestamptz,
  latest_event_type text,
  scan_started_count integer,
  last_scan_started_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  listed record;
  listed_ids uuid[] := array[]::uuid[];
begin
  if actor_account is null
     or not auth.account_has_active_role(actor_account, 'document_scanner')
     or requested_correlation_id is null
     or requested_correlation_id is distinct from platform.current_correlation_id() then
    raise exception using errcode = '42501', message = 'Authorized document scanner context is required';
  end if;
  if requested_older_than_seconds is null or requested_older_than_seconds not between 0 and 31536000
     or requested_max_rows is null or requested_max_rows not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Invalid scan target list request';
  end if;

  for listed in
    select candidate.id, candidate.storage_bucket, candidate.storage_key, candidate.object_version_id,
           candidate.sha256_hex::text as sha256_hex, candidate.declared_media_type, candidate.updated_at,
           latest.event_type as latest_event_type, started.started_count, started.last_started_at
      from ehr.documents candidate
      left join lateral (
        select scan_event.event_type
          from ehr.document_scan_events scan_event
         where scan_event.document_id = candidate.id
           and scan_event.object_version_id = candidate.object_version_id
           and scan_event.object_sha256_hex = candidate.sha256_hex
         order by scan_event.created_at desc, scan_event.id desc
         limit 1) latest on true
      left join lateral (
        select count(*)::integer as started_count, max(scan_event.created_at) as last_started_at
          from ehr.document_scan_events scan_event
         where scan_event.document_id = candidate.id
           and scan_event.object_version_id = candidate.object_version_id
           and scan_event.object_sha256_hex = candidate.sha256_hex
           and scan_event.event_type = 'scan_started') started on true
     where candidate.status = 'uploaded'
       and candidate.updated_at <= clock_timestamp() - make_interval(secs => requested_older_than_seconds)
       and not exists (
         select 1 from ehr.document_scan_events terminal_event
          where terminal_event.document_id = candidate.id
            and terminal_event.object_version_id = candidate.object_version_id
            and terminal_event.object_sha256_hex = candidate.sha256_hex
            and terminal_event.event_type in ('clean', 'rejected'))
     order by candidate.updated_at, candidate.id
     limit requested_max_rows
  loop
    document_id := listed.id;
    storage_bucket := listed.storage_bucket;
    storage_key := listed.storage_key;
    object_version_id := listed.object_version_id;
    sha256_hex := listed.sha256_hex;
    declared_media_type := listed.declared_media_type;
    updated_at := listed.updated_at;
    latest_event_type := listed.latest_event_type;
    scan_started_count := listed.started_count;
    last_scan_started_at := listed.last_started_at;
    listed_ids := listed_ids || listed.id;
    return next;
  end loop;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    action, outcome, resource_type, purpose_of_use, provenance, source_system, details
  ) values (
    requested_correlation_id, 'workload', actor_subject, actor_account,
    'ehr.document.scan-target.list', 'success', 'document-scan-targets',
    'operations-security', 'application', 'ehr-document-scanner',
    jsonb_build_object('older_than_seconds', requested_older_than_seconds, 'max_rows', requested_max_rows,
      'returned', cardinality(listed_ids), 'document_ids', to_jsonb(listed_ids))
  );
  return;
end
$$;

comment on function ehr.list_documents_awaiting_scan(integer, integer, text) is
  '0105: for the document scanner only (42501 otherwise): uploaded documents whose row last changed at least the given seconds ago (0 to 31536000) with no clean or rejected event on their bound version and SHA-256, oldest first, at most the given rows (1 to 100), with the latest event on that version and the count and time of its scan_started events; no patient or facility ID. Audited as ehr.document.scan-target.list.';

-- 3. The claim (S5): the RDS form of 0014's body (rds-compat/0015), with the
-- media type of the clean scan the claim requires instead of the declared one.
create temporary table document_scanner_0105_claim_before on commit drop as
  select proc.proowner, proc.proacl::text as acl, pg_get_function_result(proc.oid) as result
    from pg_proc proc where proc.oid = 'ocr.claim_worker_job(text,integer)'::regprocedure;

create or replace function ocr.claim_worker_job(
  requested_provider text,
  requested_lease_seconds integer
)
returns table (
  job_id uuid, facility_id uuid, document_id uuid, patient_id uuid,
  storage_bucket text, storage_key text, object_version_id text,
  source_sha256_hex text, size_bytes bigint, media_type text,
  provider text, attempt_no integer, max_attempts integer,
  claim_token uuid, claim_expires_at timestamptz, correlation_id text
) language plpgsql security definer
set search_path = ocr, ehr, audit, auth, platform, pg_temp as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  candidate ocr.jobs%rowtype;
  expired ocr.jobs%rowtype;
  new_token uuid := gen_random_uuid();
begin
  if actor_account is null or not auth.account_has_active_role(actor_account, 'ocr_worker') then
    raise exception using errcode = '42501', message = 'Authorized OCR workload context is required';
  end if;
  if requested_provider is null or length(btrim(requested_provider)) not between 1 and 120
     or requested_lease_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Invalid OCR claim request';
  end if;

  -- Recover a bounded number of abandoned leases. Each transition remains visible
  -- through the existing immutable job-event and transactional-outbox triggers.
  for expired in
    select * from ocr.jobs
     where status = 'processing' and provider = requested_provider
       and claim_expires_at <= clock_timestamp()
     order by claim_expires_at, id for update skip locked limit 10
  loop
    update ocr.jobs set status = 'failed', failed_at = clock_timestamp(),
      last_error_code = 'WORKER_LEASE_EXPIRED',
      last_error_summary = 'OCR worker lease expired before completion',
      claim_token = null, claim_expires_at = null, claimed_by_subject = null,
      row_version = row_version + 1 where id = expired.id;
    if expired.attempt_count < expired.max_attempts then
      update ocr.jobs set status = 'queued', started_at = null, failed_at = null,
        next_attempt_at = clock_timestamp(), row_version = row_version + 1
       where id = expired.id;
    end if;
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
      patient_id, action, outcome, resource_type, resource_id, provenance, details
    ) values (
      expired.correlation_id, 'workload', actor_subject, actor_account,
      expired.facility_id, expired.patient_id, 'ocr.worker.lease_recovered', 'failure',
      'ocr_job', expired.id::text, 'application',
      jsonb_build_object('errorCode', 'WORKER_LEASE_EXPIRED',
        'retryScheduled', expired.attempt_count < expired.max_attempts)
    );
  end loop;

  select job.* into candidate from ocr.jobs job
   join ehr.documents document on document.id = job.document_id
   where job.status = 'queued' and job.provider = requested_provider
     and job.next_attempt_at <= clock_timestamp() and job.attempt_count < job.max_attempts
     and document.status = 'uploaded'
     and document.object_version_id = job.source_object_version_id
     and document.sha256_hex = job.source_sha256_hex
     and exists (
       select 1 from ehr.document_scan_events scan
        where scan.id = (select latest.id from ehr.document_scan_events latest
          where latest.document_id = job.document_id
          order by latest.created_at desc, latest.id desc limit 1)
          and scan.event_type = 'clean'
          and scan.object_version_id = job.source_object_version_id
          and scan.object_sha256_hex = job.source_sha256_hex
          and scan.binding_migration_hold_reason is null
     )
   order by job.next_attempt_at, job.queued_at, job.id
   for update of job skip locked limit 1;
  if candidate.id is null then return; end if;

  update ocr.jobs job set status = 'processing', attempt_count = job.attempt_count + 1,
    started_at = clock_timestamp(), completed_at = null, failed_at = null,
    last_error_code = null, last_error_summary = null, claim_token = new_token,
    claim_expires_at = clock_timestamp() + make_interval(secs => requested_lease_seconds),
    claimed_by_subject = actor_subject, row_version = job.row_version + 1
   where job.id = candidate.id;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, facility_id,
    patient_id, action, outcome, resource_type, resource_id, provenance, details
  ) values (
    candidate.correlation_id, 'workload', actor_subject, actor_account,
    candidate.facility_id, candidate.patient_id, 'ocr.worker.claim', 'success',
    'ocr_job', candidate.id::text, 'application',
    jsonb_build_object('provider', requested_provider, 'attempt', candidate.attempt_count + 1)
  );

  return query select job.id, job.facility_id, job.document_id, job.patient_id,
    document.storage_bucket, document.storage_key, job.source_object_version_id,
    job.source_sha256_hex::text, document.size_bytes,
    (select clean_scan.detected_media_type from ehr.document_scan_events clean_scan
      where clean_scan.document_id = job.document_id and clean_scan.event_type = 'clean'
        and clean_scan.object_version_id = job.source_object_version_id
        and clean_scan.object_sha256_hex = job.source_sha256_hex
        and clean_scan.binding_migration_hold_reason is null
      order by clean_scan.created_at desc, clean_scan.id desc limit 1),
    job.provider, job.attempt_count, job.max_attempts, job.claim_token,
    job.claim_expires_at, job.correlation_id
   from ocr.jobs job join ehr.documents document on document.id = job.document_id
   where job.id = candidate.id;
end
$$;

comment on function ocr.claim_worker_job(text, integer) is
  'Atomically recovers stale leases, claims one eligible job, and returns only exact immutable source metadata. 0105: media_type is the detected type of the clean scan bound to the job''s source version and SHA-256 (owner decision D3 of 2026-10-31), not the declared type.';

-- 4. Owners and grants. ehr.documents' owner owns both new functions (a no-op
-- when the applier is that owner, as on every database built by one migration
-- login); the claim keeps its owner and ACL (CREATE OR REPLACE).
do $$
declare
  table_owner oid := (select relation.relowner from pg_class relation where relation.oid = 'ehr.documents'::regclass);
  signature text;
begin
  foreach signature in array array['ehr.resolve_document_scan_target(text,text,text,text)',
                                   'ehr.list_documents_awaiting_scan(integer,integer,text)'] loop
    if (select proc.proowner from pg_proc proc where proc.oid = signature::regprocedure) <> table_owner then
      execute format('alter function %s owner to %I', signature, pg_get_userbyid(table_owner));
    end if;
  end loop;
end
$$;

-- Here and in runtime-grants.sql.
revoke all on function ehr.resolve_document_scan_target(text, text, text, text),
  ehr.list_documents_awaiting_scan(integer, integer, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_document_scanner') then
    grant execute on function ehr.resolve_document_scan_target(text, text, text, text),
      ehr.list_documents_awaiting_scan(integer, integer, text) to hid_document_scanner;
  end if;
end
$$;

-- 5. The policy (S4), last: it holds ACCESS EXCLUSIVE on ehr.documents until
-- commit.
create policy documents_scanner_function_lock on ehr.documents for update
  using (auth.account_has_active_role(platform.current_account_id(), 'document_scanner'))
  with check (false);

-- 6. Post-checks (after the grants, so the ACLs are the final ones).
do $$
declare
  mismatch text;
  table_owner oid := (select relation.relowner from pg_class relation where relation.oid = 'ehr.documents'::regclass);
begin
  select string_agg(format('%s: owner=%s definer=%s volatile=%s language=%s strict=%s config=%s result=%s',
           proc.oid::regprocedure, pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
           language_row.lanname, proc.proisstrict, proc.proconfig, pg_get_function_result(proc.oid)), '; ')
    into mismatch
    from (values ('ehr.resolve_document_scan_target(text,text,text,text)',
                  'TABLE(document_id uuid, object_version_id text, sha256_hex text, status text, '
                  || 'declared_media_type text, latest_event_type text)'),
                 ('ehr.list_documents_awaiting_scan(integer,integer,text)',
                  'TABLE(document_id uuid, storage_bucket text, storage_key text, object_version_id text, '
                  || 'sha256_hex text, declared_media_type text, updated_at timestamp with time zone, '
                  || 'latest_event_type text, scan_started_count integer, '
                  || 'last_scan_started_at timestamp with time zone)')) expected(signature, result)
    join pg_proc proc on proc.oid = expected.signature::regprocedure
    join pg_language language_row on language_row.oid = proc.prolang
   where proc.proowner <> table_owner
      or not proc.prosecdef or proc.provolatile <> 'v' or language_row.lanname <> 'plpgsql' or proc.proisstrict
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]
      or pg_get_function_result(proc.oid) is distinct from expected.result;
  if mismatch is null
     and (select count(*) from pg_proc proc
           where proc.pronamespace = 'ehr'::regnamespace
             and proc.proname in ('resolve_document_scan_target', 'list_documents_awaiting_scan')) <> 2 then
    mismatch := 'count';
  end if;
  if mismatch is null and not exists (
       select 1 from pg_proc proc, document_scanner_0105_claim_before before_row
        where proc.oid = 'ocr.claim_worker_job(text,integer)'::regprocedure
          and proc.proowner = before_row.proowner and proc.proacl::text is not distinct from before_row.acl
          and pg_get_function_result(proc.oid) = before_row.result
          and proc.prosecdef and not proc.proisstrict and proc.provolatile = 'v'
          and proc.proconfig is not distinct from '{"search_path=ocr, ehr, audit, auth, platform, pg_temp"}'::text[]
          and proc.prosrc like '%#variable_conflict use_column%'
          and proc.prosrc not like '%declared_media_type%') then
    mismatch := 'ocr.claim_worker_job(text,integer)';
  end if;
  if mismatch is null and (
       select count(*) from pg_policy policy_row
        where policy_row.polrelid = 'ehr.documents'::regclass
          and policy_row.polname = 'documents_scanner_function_lock'
          and policy_row.polcmd = 'w' and policy_row.polpermissive and policy_row.polroles = array[0::oid]
          and pg_get_expr(policy_row.polqual, policy_row.polrelid)
            = 'auth.account_has_active_role(platform.current_account_id(), ''document_scanner''::text)'
          and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = 'false') <> 1 then
    mismatch := 'the policy documents_scanner_function_lock';
  end if;
  if mismatch is null and not exists (
       select 1 from pg_class relation where relation.oid = 'ehr.documents'::regclass
          and relation.relrowsecurity and relation.relforcerowsecurity) then
    mismatch := 'ehr.documents row-level security';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0105: not as this file makes it: %s', mismatch);
  end if;
  select string_agg(granted.what, '; ') into mismatch
    from (
      select proc.oid::regprocedure || ' ' || case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
             || ' ' || acl.privilege_type as what
        from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where proc.oid in ('ehr.resolve_document_scan_target(text,text,text,text)'::regprocedure,
                          'ehr.list_documents_awaiting_scan(integer,integer,text)'::regprocedure)
         and acl.grantee <> proc.proowner
         and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_document_scanner'
              or acl.privilege_type <> 'EXECUTE')
      union all
      select 'missing hid_document_scanner EXECUTE on ' || proc.oid::regprocedure
        from pg_roles role_row, pg_proc proc
       where role_row.rolname = 'hid_document_scanner'
         and proc.oid in ('ehr.resolve_document_scan_target(text,text,text,text)'::regprocedure,
                          'ehr.list_documents_awaiting_scan(integer,integer,text)'::regprocedure)
         and not exists (select 1 from aclexplode(proc.proacl) acl
                          where acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')) granted;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0105: an ACL is not this file''s: %s', mismatch);
  end if;
end
$$;
