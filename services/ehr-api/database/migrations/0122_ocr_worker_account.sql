-- 0122 The OCR worker's workload account. Written on production's backend
-- (staging-novu-ci-20261005 at f11c9ec9, migrations 0001-0105 applied); 0106
-- through 0121 are claimed by other work, and this file uses and needs nothing
-- they add.
--
-- Why. ocr.claim_worker_job (0014, last replaced by 0105) and the worker's
-- other commands (0014, 0077) first check that app.actor_subject is the
-- subject of an active auth.accounts row holding the platform ocr_worker role,
-- and otherwise raise 42501 Authorized OCR workload context is required. The
-- role exists since 0013 (granting only ocr.job.process) but no migration,
-- release step or admin command ever gave it to anyone:
-- auth.admin_change_platform_role accepts only the six admin roles (0064) and
-- bootstrap-platform-admin.mjs grants only platform_super_admin. So the
-- production worker (login hid_stg_ocr_worker) has failed every claim with
-- 42501 since it started, and no OCR job is ever claimed. 0105 seeded the
-- document scanner's account for the same reason; this file does the same for
-- the OCR worker.
--
-- S1 The worker's account. The worker sets app.actor_subject to its
--    OCR_WORKER_SUBJECT (services/ocr-worker/src/repository.ts) and never uses
--    a workload token, so the subject is only this database label. It gets its
--    own subject, hid:staging:ocr-worker, in the pattern of the issuer's
--    hid:<environment>:<caller> ("staging" in production, the promoted staging
--    stack), not the OCR API's hid:staging:ocr-api: the API's service identity
--    then carries no worker authority, and audit rows tell the two apart.
--    Terraform (dev, infra/terraform/modules/application/workloads.tf) must set
--    OCR_WORKER_SUBJECT = "hid:${local.workload_identity_environment}:ocr-worker"
--    for the claims to start; until it does the worker keeps answering 42501
--    exactly as today. This file seeds the account (active, no email, no
--    password, so it can never sign in interactively; source_system
--    hid-workload) and its platform ocr_worker role, ON CONFLICT DO NOTHING;
--    the role row's grant_reason names the approval. No audit row: a dry run
--    would consume audit.events' sequence, which the release's rehearsal
--    requires a dry run to leave as it was. The governed admin command refuses
--    this role (0064), so the seed bypasses it: the owner signs that in the
--    declaration. A row already there must be exactly this one (else 55000,
--    nothing applied), the account must hold no other active role, and the
--    role must grant only ocr.job.process. No function, policy or grant
--    changes, so runtime-grants.sql is unchanged; no patient data is read or
--    written.
--    Kill switch, no release needed: revoke the role row (or set the account's
--    status to disabled), and the worker's next claim answers 42501 again:
--      update auth.account_roles set revoked_at = clock_timestamp(),
--             revoked_by = <an admin account id>, revocation_reason = '<8-500 characters>'
--       where id = '0c4e0122-0122-4000-8000-000000000002' and revoked_at is null;
--
-- What it does not do. A claim still only takes a job whose document's latest
-- scan event is clean (0105), and production runs no scanner yet (0105's
-- header), so claims return no job until the scanner's Terraform is applied.
--
-- 0. Preconditions (catalog reads and the role; each failure raises 55000 or
--    42501 and nothing is applied): 0001-0105 applied (0105's
--    ehr.resolve_document_scan_target is the marker, else "0122: 0001-0105
--    must be applied first"); not applied yet (neither seeded ID present, else
--    "0122: already applied"); the two helpers the worker's check relies on
--    have the bodies 0002/0005 gave them (md5 of pg_proc.prosrc, the same pins
--    as 0105), and ocr.claim_worker_job still checks the ocr_worker role
--    through them; the columns written have their types and NOT NULLs;
--    ocr_worker exists, is active and grants exactly ocr.job.process; the
--    applier may read and insert both tables and execute the two helpers.
-- 1. The seed (S1). 2. Post-checks.
--
-- Locks (measured with pg_locks before commit on a 0105 copy): ROW EXCLUSIVE
-- on auth.accounts and auth.account_roles (the two seed rows); ROW SHARE on
-- auth.accounts and auth.roles and their keys (the foreign keys' row locks);
-- ACCESS SHARE on auth.accounts, auth.account_roles, auth.roles,
-- auth.role_permissions and identity.sealed_demo_members (the preconditions
-- and 0098's seal trigger) and the catalog read locks. Nothing on ocr.jobs,
-- ehr.documents or audit.events, and no lock stronger than ROW EXCLUSIVE.
-- Behind any held conflicting lock the runner stops after its 5 s
-- lock_timeout and applies nothing.
--
-- Old services on this schema: nothing reads the new rows except the
-- worker's commands through the two helpers; today's worker image with
-- today's OCR_WORKER_SUBJECT (hid:staging:ocr-api) still answers 42501.
-- Applied migrations 0001 through 0121 are immutable.

-- 0. Preconditions.
do $$
declare
  mismatch text;
  worker_account constant uuid := '0c4e0122-0122-4000-8000-000000000001';
  worker_role_row constant uuid := '0c4e0122-0122-4000-8000-000000000002';
begin
  -- a. Prerequisites: 0001-0105 (0105's scanner command is the marker).
  if to_regclass('auth.accounts') is null
     or to_regclass('auth.account_roles') is null
     or to_regclass('auth.roles') is null
     or to_regclass('auth.role_permissions') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null
     or to_regprocedure('auth.account_has_active_role(uuid,text)') is null
     or to_regprocedure('ocr.claim_worker_job(text,integer)') is null
     or to_regprocedure('ehr.resolve_document_scan_target(text,text,text,text)') is null then
    raise exception using errcode = '55000', message = '0122: 0001-0105 must be applied first';
  end if;
  -- b. Not applied yet.
  if exists (select 1 from auth.accounts account_row where account_row.id = worker_account)
     or exists (select 1 from auth.account_roles assignment where assignment.id = worker_role_row) then
    raise exception using errcode = '55000', message = '0122: already applied';
  end if;
  -- c. The bodies the worker's check relies on, as 0002 and 0005 left them
  -- (the pins 0105 uses), and the claim still checking ocr_worker through them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('auth.account_has_active_role(uuid,text)', 'a3310b48da6ff8bcd3ecb9d7dbef900a')) expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where proc.oid is null or md5(proc.prosrc) <> expected.digest;
  if mismatch is null and not exists (
       select 1 from pg_proc proc
        where proc.oid = 'ocr.claim_worker_job(text,integer)'::regprocedure
          and proc.prosrc like '%auth.account_id_for_subject(actor_subject)%'
          and proc.prosrc like '%auth.account_has_active_role(actor_account, ''ocr_worker'')%') then
    mismatch := 'ocr.claim_worker_job(text,integer) no longer checks the ocr_worker role';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0122: a function this migration relies on differs from 0001-0105: %s', mismatch);
  end if;
  -- d. The columns written or checked.
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
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
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0122: a column this migration relies on differs from 0001-0105: %s', mismatch);
  end if;
  -- e. The applier writes the two rows itself and runs the post-check.
  select string_agg(format('%s on %s', wanted.privilege, wanted.relation_name), '; ') into mismatch
    from (values ('auth.accounts', 'SELECT'), ('auth.accounts', 'INSERT'),
                 ('auth.account_roles', 'SELECT'), ('auth.account_roles', 'INSERT'),
                 ('auth.roles', 'SELECT'), ('auth.role_permissions', 'SELECT')) wanted(relation_name, privilege)
   where not has_table_privilege(current_user, wanted.relation_name, wanted.privilege);
  if mismatch is null and not (has_function_privilege(current_user, 'auth.account_id_for_subject(text)', 'EXECUTE')
       and has_function_privilege(current_user, 'auth.account_has_active_role(uuid,text)', 'EXECUTE')) then
    mismatch := 'EXECUTE on auth.account_id_for_subject or auth.account_has_active_role (the post-check)';
  end if;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0122: %s lacks %s', current_user, mismatch);
  end if;
  -- f. The role the seed grants: active and granting exactly ocr.job.process
  -- (0013), so the worker gets nothing more.
  if not exists (select 1 from auth.roles role_row where role_row.code = 'ocr_worker' and role_row.active)
     or (select array_agg(grant_row.permission_code order by grant_row.permission_code)
           from auth.role_permissions grant_row where grant_row.role_code = 'ocr_worker')
        is distinct from array['ocr.job.process'] then
    raise exception using errcode = '55000',
      message = '0122: the ocr_worker role must exist, be active and grant exactly ocr.job.process';
  end if;
end
$$;

-- 1. The seed (S1): the worker's account and its platform role.
do $$
declare
  worker_account constant uuid := '0c4e0122-0122-4000-8000-000000000001';
  worker_role_row constant uuid := '0c4e0122-0122-4000-8000-000000000002';
  worker_subject constant text := 'hid:staging:ocr-worker';
  grant_text constant text := 'Owner approval in the 0122 release declaration: the OCR worker workload '
    || '(services/ocr-worker, OCR_WORKER_SUBJECT). Seeded by migration 0122 outside '
    || 'auth.admin_change_platform_role, which refuses this role.';
  others integer;
begin
  insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm,
    source_system)
  values (worker_account, worker_subject, null, 'OCR worker', 'active', null, null, 'hid-workload')
  on conflict do nothing;
  if (select count(*) from auth.accounts account_row
       where account_row.id = worker_account or account_row.subject = worker_subject) <> 1
     or not exists (select 1 from auth.accounts account_row
                     where account_row.id = worker_account and account_row.subject = worker_subject
                       and account_row.status = 'active' and account_row.email is null
                       and account_row.password_hash is null and account_row.password_algorithm is null
                       and account_row.disabled_until is null and account_row.source_system = 'hid-workload') then
    raise exception using errcode = '55000',
      message = format('0122: auth.accounts already holds %s or %s, not as this file seeds it', worker_account,
        worker_subject);
  end if;

  insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, granted_by,
    grant_reason)
  values (worker_role_row, worker_account, 'ocr_worker', 'platform', null, null, null, grant_text)
  on conflict do nothing;
  if (select count(*) from auth.account_roles assignment
       where assignment.account_id = worker_account and assignment.revoked_at is null) <> 1
     or not exists (select 1 from auth.account_roles assignment
                     where assignment.id = worker_role_row and assignment.account_id = worker_account
                       and assignment.role_code = 'ocr_worker' and assignment.scope_type = 'platform'
                       and assignment.membership_id is null and assignment.facility_id is null
                       and assignment.granted_by is null and assignment.revoked_at is null) then
    raise exception using errcode = '55000',
      message = '0122: the OCR worker account must hold exactly one active role, the platform ocr_worker row this file seeds';
  end if;
  others := (select count(distinct assignment.account_id) from auth.account_roles assignment
              where assignment.role_code = 'ocr_worker' and assignment.revoked_at is null
                and assignment.account_id <> worker_account);
  raise notice '0122: OCR worker account %, subject %; other accounts holding ocr_worker: %',
    worker_account, worker_subject, others;
end
$$;

-- 2. Post-check: the worker's own check now passes for the subject, through
-- the same two helpers the claim calls.
do $$
begin
  if not coalesce(auth.account_has_active_role(auth.account_id_for_subject('hid:staging:ocr-worker'), 'ocr_worker'),
                  false) then
    raise exception using errcode = '55000', message = '0122: not as this file makes it: the worker check fails';
  end if;
end
$$;
