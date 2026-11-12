-- 0120 Access PIN: 24 hours, read and write. A patient's Access PIN now gives
-- the staff member who enters it read AND write access to all of that
-- patient's records for exactly 24 hours (1440 minutes), whatever duration is
-- asked, instead of read-only access for up to 60 minutes. Written on staging-novu-ci-20261005 at bf4ea233
-- (migrations 0001-0108 applied there) as 0121; renumbered 0120 by the release
-- order on 2026-11-11, on staging 51d6937a (migrations 0001-0114 applied
-- there). 0115-0119 are other branches' and are not on staging yet.
--
-- Owner decision (10 Nov 2026, relayed by Ola, clinical owner): "a PIN gives
-- exactly 24 hours of read AND write access to all records, with no separate
-- 'Ask for more access'", for the same staff roles as today. The declaration
-- in config/production-schema-compatibility.json is unsigned: its reviewed_by
-- stays empty until the owner signs it under 0120.
--
-- Today the PIN is held to 60 minutes and read_records in four places: the two
-- CHECK constraints of 0033 (access_requests_pin_scope_ck and
-- consent_grants_pin_scope_ck), identity.access_patient_with_pin (live body
-- 0098's, md5 830c1baa4bca3df57cc02b7b002a8831), the identity-api DTO
-- (@Max(60)) and the website, which sends 60. This file changes the first two;
-- identity-api and the website change in their own code.
--
-- What changes:
-- a. Both *_pin_scope_ck constraints allow scope read_records or write_records
--    for a PIN row (still direct-care and never break-glass). Dropped and added
--    again NOT VALID, then VALIDATE CONSTRAINT. Every row today is read_records,
--    so every row passes.
-- b. identity.access_patient_with_pin (CREATE OR REPLACE, from 0098's body):
--    - every grant lasts exactly 24 hours (1440 minutes), whatever duration
--      is asked (owner decision, 10 Nov 2026). The argument
--      requested_duration_minutes is kept, so old and new callers both work,
--      and is still checked as 5 to 1440 (was 5 to 60): a missing or
--      out-of-range value is refused as before. A caller that still sends 60
--      (or 5) gets 1440 minutes; the access request's
--      requested_duration_minutes and the audit's duration_minutes say 1440;
--    - the request and the grant it inserts are write_records (was
--      read_records). write_records also lets its holder read
--      (identity.has_active_consent_grant, 0104: a write grant answers a read);
--    - a still-valid PIN grant is reused (existing_grant true, a replay) only
--      if it is write_records. A 60-minute read grant made before this file is
--      not reused: the next correct PIN makes a new write grant, and the old
--      read grant runs out by itself within the hour. A reused grant follows
--      the same rule: whatever duration the new call asks, it keeps its own
--      24-hour expiry and the replay's audit duration_minutes says 1440;
--    - a patient's deny directive stops the PIN if it covers reading OR
--      writing (or every action). Before, only a deny of reading counted. A
--      deny of reading still stops it, so nothing the patient denied before
--      opens now;
--    - the success and replay audit rows carry "scope" in their details, and
--      the PatientAccessPinVerified outbox payload carries "scope" too
--      ({consentGrantId, reviewRequired, scope}).
--    Every other behaviour is 0098's, byte for byte: the permission
--    identity.patient-access-pin.verify, direct care only, the exact active
--    membership, the actor and target failure windows and locks (0075), the
--    sealed demo boundary (0098), the bcrypt work padding, the denial audit
--    rows, the attempts table, the advisory locks, the replay rule otherwise,
--    the result columns. Signature, SECURITY DEFINER, search_path, owner and
--    ACL are kept and compared after (section 4).
-- c. identity_outbox_minimum_necessary (0033) lets a PatientAccessPinVerified
--    payload be either the old two keys or the two keys plus "scope"
--    (read_records or write_records); EmergencyAccessActivated is unchanged.
--    Dropped and added again NOT VALID, then VALIDATE CONSTRAINT.
-- d. The insert policy identity_outbox_patient_access_pin_insert (0033) admits
--    a PIN grant of either scope, and requires the payload's "scope", when
--    present, to be the grant's scope (ALTER POLICY; name, command and roles
--    kept).
--
-- Who it affects. Only staff who may verify a patient PIN today: the
-- membership must hold identity.patient-access-pin.verify at that facility
-- (no role, permission or grant changes here). The patient still sees each
-- access in their access list and notification, can end it at any time
-- (0087's revoke_my_consent_grant; turning the PIN off ends every PIN grant,
-- 0075), and their deny choices still apply. Records processing (0104/0108)
-- already covered a PIN grant of either scope; its cover now lasts the PIN
-- grant's 24 hours, as 0108 D-a says.
--
-- What does not change: no table, column, index, trigger, role, permission or
-- grant; runtime-grants.sql is unchanged (its blocks name the same signature);
-- no row is written. identity.has_active_consent_grant and the records
-- processing cover are untouched (pinned before). Emergency access
-- (break-glass) and access requests the patient approves are untouched.
--
-- Services on this schema. identity-api reads the same result columns and
-- needs no change to work; its new default (1440) and DTO limit (1440) come in
-- the same pull request. The event dispatcher and the notification worker
-- check the PIN notice's payload: their change to accept both the two-key and
-- the three-key payload is in its own pull request (hid-system#206, branch
-- claude/fervent-galileo-datz4t-pin-notice-scope, no migration), which must be
-- merged and released before this file (it is live since 2026-11-11; then
-- this file and identity-api, hid-system#208, written as 0121 and renumbered
-- 0120; then the websites, hid-system#207 and health#197). A release that carries a migration
-- applies it before it rolls out the services (scripts/production_deployment.py),
-- so the two cannot safely go in one release. If this file applied first, a PIN
-- notice raised in between would be refused by the old check and not retried
-- (the patient would miss that notice; the access row and audit row are still
-- written). The websites keep working: they read the grant's expiresAt. Until
-- each website is changed it asks for its own duration (hid-system apps/web
-- sends 60), and the grant is still read and write for 24 hours.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): the objects this file touches exist; not applied
--    yet (the function's body is not already this file's, else "0120: already
--    applied"); the bodies replaced and relied on are those 0001-0108 gave
--    them (md5 of pg_proc.prosrc): access_patient_with_pin (0098's), the
--    session readers and auth.account_id_for_subject it calls,
--    auth.membership_has_permission (0010), the sealed demo helpers (0098),
--    has_active_consent_grant (0104) and the records-processing cover (0108);
--    the function's attributes and result are 0098's; the three CHECK
--    constraints and the policy are exactly 0033's; the column
--    identity.consent_directive_versions.actions is text[] NOT NULL;
--    identity.outbox_events forces row-level security; one owner for
--    identity.access_requests, identity.consent_grants, identity.outbox_events
--    and the function, and the applying role is it or a member that inherits
--    it and may SET ROLE to it.
-- 1. The two PIN scope constraints (a).
-- 2. The outbox payload constraint (c) and the insert policy (d).
-- 3. The function (b) and its comment.
-- 4. Post-checks: the new body (md5); every other attribute of the function as
--    it was before (owner, language, volatility, SECURITY DEFINER, strictness,
--    search_path, cost, rows, parallel, result, arguments, ACL); the three
--    constraints valid and exactly this file's; the policy exactly this
--    file's, with its command and roles as before; the bodies pinned in 0
--    unchanged.
--
-- Locks. ALTER TABLE ... DROP/ADD CONSTRAINT takes ACCESS EXCLUSIVE on
-- identity.access_requests, identity.consent_grants and identity.outbox_events,
-- and the runner applies the file in one transaction, so those locks are held
-- until commit, including the three VALIDATE scans (NOT VALID then VALIDATE
-- keeps the file's shape the one asked for; inside one transaction it does
-- not shorten the lock). ALTER POLICY takes ACCESS EXCLUSIVE on
-- identity.outbox_events too. The tables are small (every grant and request
-- and the identity outbox); behind a session holding a lock on one of them
-- the runner stops after its 5 s lock_timeout with nothing applied. Calls
-- take no lock on a function: a PIN check already running finishes with
-- 0098's body; one that starts after the commit runs the new one.
--
-- To undo: a follow-up migration that puts back 0098's body (60 minutes,
-- read_records) and narrows the two constraints again. It must first end or
-- let run out every write_records PIN grant (at most 24 hours), or the
-- narrowed constraints would not validate. The outbox constraint and policy
-- can stay widened. Applied migrations 0001 through 0119 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0104's helper).
create function pg_temp.pin_0120_holds(holder oid, object_owner oid, object_acl aclitem[],
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
  -- a. What this file touches and reads.
  if to_regprocedure('identity.access_patient_with_pin(text,text,integer)') is null
     or to_regclass('identity.access_requests') is null
     or to_regclass('identity.consent_grants') is null
     or to_regclass('identity.outbox_events') is null
     or to_regclass('identity.consent_directives') is null
     or to_regclass('identity.consent_directive_versions') is null
     or to_regclass('identity.patient_access_pins') is null
     or to_regprocedure('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)') is null
     or to_regprocedure('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)') is null
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'identity.outbox_events'::regclass
                       and policy_row.polname = 'identity_outbox_patient_access_pin_insert') then
    raise exception using errcode = '55000', message = '0120: 0001-0108 must be applied first';
  end if;
  -- b. Not applied yet.
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = 'identity.access_patient_with_pin(text,text,integer)'::regprocedure)
     = 'e17e8bb85b755866bb0f1a03b5555c23' then
    raise exception using errcode = '55000', message = '0120: already applied';
  end if;
  -- c. The body replaced (0098's) and the bodies it and the checks rely on.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.access_patient_with_pin(text,text,integer)', '830c1baa4bca3df57cc02b7b002a8831'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)',
       '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)',
       '6928763d3b69f0e4b4acf96a6a255736')) expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- The function's attributes and result as 0098 made them.
  if mismatch is null and not exists (
       select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
        where proc.oid = 'identity.access_patient_with_pin(text,text,integer)'::regprocedure
          and language_row.lanname = 'plpgsql' and proc.prosecdef and not proc.proisstrict and proc.provolatile = 'v'
          and proc.proretset and proc.prokind = 'f'
          and proc.proconfig = '{"search_path=identity, auth, audit, platform, pg_temp"}'::text[]
          and pg_get_function_result(proc.oid) = 'TABLE(verified boolean, access_request_id uuid, '
            || 'consent_grant_id uuid, subject_patient_id uuid, grant_status text, '
            || 'expires_at timestamp with time zone, existing_grant boolean)'
          and pg_get_function_arguments(proc.oid)
            = 'requested_hid text, requested_pin text, requested_duration_minutes integer') then
    mismatch := 'attributes or result of identity.access_patient_with_pin';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0120: a function this migration relies on differs from 0001-0108: %s', mismatch);
  end if;
  -- d. The constraints and the policy, exactly as 0033 made them.
  select string_agg(expected.what, '; ') into mismatch
    from (values
      ('identity.access_requests', 'access_requests_pin_scope_ck',
       $c$CHECK (((authorization_method IS DISTINCT FROM 'patient_access_pin'::text) OR ((scope = 'read_records'::text) AND (purpose_of_use = 'direct-care'::text) AND (break_glass = false))))$c$),
      ('identity.consent_grants', 'consent_grants_pin_scope_ck',
       $c$CHECK (((authorization_method IS DISTINCT FROM 'patient_access_pin'::text) OR ((scope = 'read_records'::text) AND (purpose_of_use = 'direct-care'::text) AND (break_glass = false))))$c$),
      ('identity.outbox_events', 'identity_outbox_minimum_necessary',
       $c$CHECK ((((event_type <> 'EmergencyAccessActivated'::text) OR ((aggregate_version = 1) AND (payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true)))) AND ((event_type <> 'PatientAccessPinVerified'::text) OR ((aggregate_version = 1) AND (payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true))))))$c$))
         expected(relation_name, what, definition)
   where not exists (select 1 from pg_constraint constraint_row
                      where constraint_row.conrelid = expected.relation_name::regclass
                        and constraint_row.conname = expected.what
                        and constraint_row.contype = 'c' and constraint_row.convalidated
                        and pg_get_constraintdef(constraint_row.oid) = expected.definition);
  if mismatch is null and not exists (
       select 1 from pg_policy policy_row
        where policy_row.polrelid = 'identity.outbox_events'::regclass
          and policy_row.polname = 'identity_outbox_patient_access_pin_insert'
          and policy_row.polcmd = 'a' and policy_row.polpermissive and policy_row.polroles = '{0}'::oid[]
          and policy_row.polqual is null
          and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = $p$((event_type = 'PatientAccessPinVerified'::text) AND (facility_id = platform.current_facility_id()) AND auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(), facility_id, 'identity.patient-access-pin.verify'::text) AND (EXISTS ( SELECT 1
   FROM identity.consent_grants grant_row
  WHERE ((grant_row.id = outbox_events.aggregate_id) AND (grant_row.patient_id = outbox_events.patient_id) AND (grant_row.facility_id = outbox_events.facility_id) AND (grant_row.membership_id = platform.current_membership_id()) AND (grant_row.account_id = auth.account_id_for_subject(platform.current_actor_subject())) AND (grant_row.authorization_method = 'patient_access_pin'::text) AND (grant_row.scope = 'read_records'::text) AND (grant_row.purpose_of_use = 'direct-care'::text)))))$p$) then
    mismatch := 'policy identity_outbox_patient_access_pin_insert';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0120: a constraint or policy this migration replaces differs from 0033: %s', mismatch);
  end if;
  -- e. The column the new deny check reads, and the outbox's row-level security.
  if not exists (select 1 from pg_attribute attribute_row
                  where attribute_row.attrelid = 'identity.consent_directive_versions'::regclass
                    and attribute_row.attname = 'actions' and not attribute_row.attisdropped
                    and format_type(attribute_row.atttypid, attribute_row.atttypmod) = 'text[]'
                    and attribute_row.attnotnull) then
    raise exception using errcode = '55000',
      message = '0120: identity.consent_directive_versions.actions is not text[] NOT NULL';
  end if;
  if not (select relation.relrowsecurity and relation.relforcerowsecurity from pg_class relation
           where relation.oid = 'identity.outbox_events'::regclass) then
    raise exception using errcode = '55000',
      message = '0120: identity.outbox_events does not force row-level security as 0025 made it';
  end if;
  -- f. Ownership, never through a superuser's bypass (production's migrator
  -- has none).
  table_owner := (select relation.relowner from pg_class relation
                   where relation.oid = 'identity.consent_grants'::regclass);
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not owned by %s', owned.what, pg_get_userbyid(table_owner)) as what
        from (select relation.oid::regclass::text as what, relation.relowner as owner_id from pg_class relation
               where relation.oid in ('identity.access_requests'::regclass, 'identity.outbox_events'::regclass)
              union all
              select proc.oid::regprocedure::text, proc.proowner from pg_proc proc
               where proc.oid = 'identity.access_patient_with_pin(text,text,integer)'::regprocedure) owned
       where owned.owner_id <> table_owner
      union all
      select format('%s is not %s and may not act as it (INHERIT and SET)', current_user, pg_get_userbyid(table_owner))
       where applier <> table_owner
         and not (pg_has_role(applier, table_owner, 'USAGE') and pg_has_role(applier, table_owner, 'SET'))
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(table_owner), wanted.privilege, namespace.nspname)
        from (values ('identity', 'CREATE'), ('identity', 'USAGE')) wanted(schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.pin_0120_holds(table_owner, namespace.nspowner, namespace.nspacl, 'n', wanted.privilege)) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0120: missing privileges: %s', mismatch);
  end if;
  raise notice '0120: owners checked: identity.consent_grants=%, applier=%', pg_get_userbyid(table_owner), current_user;
end
$$;

-- Every attribute but the body of the function before this file, and the
-- policy's command and roles, for section 4 (they must not change).
create temporary table pin_0120_before as
select proc.oid::regprocedure::text as signature,
       concat_ws(' | ', proc.proowner::regrole::text, proc.prolang::text, proc.procost::text, proc.prorows::text,
         proc.provariadic::text, proc.prosupport::text, proc.prokind::text, proc.prosecdef::text,
         proc.proleakproof::text, proc.proisstrict::text, proc.proretset::text, proc.provolatile::text,
         proc.proparallel::text, proc.pronargs::text, proc.pronargdefaults::text, proc.prorettype::text,
         proc.proargtypes::text, coalesce(proc.proallargtypes::text, '-'), coalesce(proc.proargmodes::text, '-'),
         coalesce(proc.proargnames::text, '-'), coalesce(pg_get_expr(proc.proargdefaults, 0), '-'),
         coalesce(proc.proconfig::text, '-'), coalesce(proc.proacl::text, 'default')) as attributes
  from pg_proc proc
 where proc.oid = 'identity.access_patient_with_pin(text,text,integer)'::regprocedure
union all
select 'policy', concat_ws(' | ', policy_row.polcmd::text, policy_row.polpermissive::text,
         policy_row.polroles::text, coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '-'))
  from pg_policy policy_row
 where policy_row.polrelid = 'identity.outbox_events'::regclass
   and policy_row.polname = 'identity_outbox_patient_access_pin_insert';

-- 1. The two PIN scope constraints (a): read_records or write_records, still
-- direct care and never break-glass.
alter table identity.access_requests
  drop constraint access_requests_pin_scope_ck,
  add constraint access_requests_pin_scope_ck
    check (authorization_method is distinct from 'patient_access_pin'
      or (scope in ('read_records', 'write_records') and purpose_of_use = 'direct-care' and break_glass = false))
    not valid;
alter table identity.access_requests validate constraint access_requests_pin_scope_ck;

alter table identity.consent_grants
  drop constraint consent_grants_pin_scope_ck,
  add constraint consent_grants_pin_scope_ck
    check (authorization_method is distinct from 'patient_access_pin'
      or (scope in ('read_records', 'write_records') and purpose_of_use = 'direct-care' and break_glass = false))
    not valid;
alter table identity.consent_grants validate constraint consent_grants_pin_scope_ck;

-- 2. The PIN notice may carry the grant's scope (c), and the insert policy
-- admits a PIN grant of either scope whose scope the payload names (d).
alter table identity.outbox_events
  drop constraint identity_outbox_minimum_necessary,
  add constraint identity_outbox_minimum_necessary
    check (
      (event_type <> 'EmergencyAccessActivated' or (
        aggregate_version = 1
        and payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true)
      ))
      and (event_type <> 'PatientAccessPinVerified' or (
        aggregate_version = 1
        and (payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true)
          or payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true,
               'scope', 'read_records')
          or payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true,
               'scope', 'write_records'))
      ))
    )
    not valid;
alter table identity.outbox_events validate constraint identity_outbox_minimum_necessary;

alter policy identity_outbox_patient_access_pin_insert on identity.outbox_events
  with check (
    event_type = 'PatientAccessPinVerified'
    and facility_id = platform.current_facility_id()
    and auth.membership_has_permission(platform.current_actor_subject(),
      platform.current_membership_id(), facility_id, 'identity.patient-access-pin.verify')
    and exists (
      select 1 from identity.consent_grants grant_row
       where grant_row.id = identity.outbox_events.aggregate_id
         and grant_row.patient_id = identity.outbox_events.patient_id
         and grant_row.facility_id = identity.outbox_events.facility_id
         and grant_row.membership_id = platform.current_membership_id()
         and grant_row.account_id = auth.account_id_for_subject(platform.current_actor_subject())
         and grant_row.authorization_method = 'patient_access_pin'
         and grant_row.scope in ('read_records', 'write_records')
         and coalesce(identity.outbox_events.payload ->> 'scope', grant_row.scope) = grant_row.scope
         and grant_row.purpose_of_use = 'direct-care'
    )
  );

-- 3. The function (b): 0098's body with the four changes marked "0121" (the
-- number this file was written under: the body is kept byte for byte, so the
-- md5 pinned in 0 and 4 still holds) or named in the header, and its comment.
create or replace function identity.access_patient_with_pin(
  requested_hid text,
  requested_pin text,
  requested_duration_minutes integer
)
returns table (
  verified boolean,
  access_request_id uuid,
  consent_grant_id uuid,
  subject_patient_id uuid,
  grant_status text,
  expires_at timestamptz,
  existing_grant boolean
)
language plpgsql security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id_value uuid := auth.account_id_for_subject(actor_subject);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  actor_correlation_id text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_staff_id uuid;
  actor_organization_id uuid;
  patient_id_value uuid;
  request_id_value uuid;
  grant_id_value uuid;
  grant_expires_at timestamptz;
  normalized_pin text := regexp_replace(coalesce(requested_pin, ''), E'\\s+', '', 'g');
  pin_row identity.patient_access_pins%rowtype;
  verification_hash text;
  pin_hash_cost integer;
  padding_cost integer;
  pin_matches boolean := false;
  actor_limit identity.patient_access_pin_actor_limits%rowtype;
  target_limit identity.patient_access_pin_target_limits%rowtype;
  replayed boolean := false;
  denial_action text := 'identity.patient-access-pin.verify-denied';
  -- 0121 (owner decision, 10 Nov 2026): a PIN opens the patient's records to
  -- read and to add to, for exactly 24 hours, whatever duration is asked.
  pin_scope constant text := 'write_records';
  pin_minutes constant integer := 1440;
begin
  if actor_account_id_value is null or actor_membership_id is null or actor_facility_id is null
     or actor_correlation_id is null
     or not auth.membership_has_permission(
       actor_subject, actor_membership_id, actor_facility_id, 'identity.patient-access-pin.verify'
     ) then
    raise exception using errcode = '42501', message = 'Authorized patient PIN context is required';
  end if;
  if actor_purpose is distinct from 'direct-care'
     or not exists (select 1 from identity.purpose_of_use_codes
                    where code = 'direct-care' and active) then
    raise exception using errcode = '22023', message = 'Patient PIN access requires direct care';
  end if;
  if requested_duration_minutes is null or requested_duration_minutes not between 5 and 1440 then
    raise exception using errcode = '22023', message = 'Invalid patient PIN access duration';
  end if;
  select membership.staff_id, membership.organization_id
    into actor_staff_id, actor_organization_id
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership_id
     and membership.account_id = actor_account_id_value
     and membership.facility_id = actor_facility_id
     and membership.active and membership.migration_hold_reason is null;
  if actor_staff_id is null then
    raise exception using errcode = '42501', message = 'Exact active staff membership is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    actor_account_id_value::text || ':' || actor_facility_id::text || ':patient-pin', 0
  ));
  insert into identity.patient_access_pin_actor_limits (actor_account_id, facility_id)
    values (actor_account_id_value, actor_facility_id)
    on conflict on constraint patient_access_pin_actor_limits_pkey do nothing;
  select * into actor_limit from identity.patient_access_pin_actor_limits as limit_row
   where limit_row.actor_account_id = actor_account_id_value
     and limit_row.facility_id = actor_facility_id for update;
  if actor_limit.locked_until is not null and actor_limit.locked_until > clock_timestamp() then
    insert into identity.patient_access_pin_attempts (
      actor_account_id, membership_id, facility_id, patient_id, outcome, correlation_id
    ) values (actor_account_id_value, actor_membership_id, actor_facility_id, null, 'locked', actor_correlation_id);
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, action, outcome, resource_type, purpose_of_use,
      provenance, source_system, details
    ) values (
      actor_correlation_id, 'staff', actor_subject, actor_account_id_value, actor_membership_id,
      actor_organization_id, actor_facility_id, denial_action, 'denied', 'patient-access-pin',
      'direct-care', 'application', 'identity-api', jsonb_build_object('rate_limited', true)
    );
    return query select false, null::uuid, null::uuid, null::uuid, null::text, null::timestamptz, false;
    return;
  end if;

  select patient_row.id into patient_id_value
    from identity.patients patient_row
   where upper(patient_row.hid_code) = upper(btrim(requested_hid))
     and patient_row.status = 'active'
     and identity.sealed_demo_facility(actor_facility_id) = identity.sealed_demo_patient(patient_row.id)
   limit 1;

  if patient_id_value is not null then
    -- The same lock is taken by patient PIN set/revoke commands. Without it,
    -- a verifier could read an old hash before a revocation and create a grant
    -- after the revocation had already closed prior grants.
    perform pg_advisory_xact_lock(hashtextextended(
      'patient-access-pin:' || patient_id_value::text, 0
    ));
    perform pg_advisory_xact_lock(hashtextextended(
      actor_account_id_value::text || ':' || actor_facility_id::text || ':' || patient_id_value::text || ':patient-pin', 0
    ));
    insert into identity.patient_access_pin_target_limits (actor_account_id, facility_id, patient_id)
      values (actor_account_id_value, actor_facility_id, patient_id_value)
      on conflict on constraint patient_access_pin_target_limits_pkey do nothing;
    select * into target_limit from identity.patient_access_pin_target_limits as limit_row
     where limit_row.actor_account_id = actor_account_id_value
       and limit_row.facility_id = actor_facility_id
       and limit_row.patient_id = patient_id_value for update;
    if target_limit.locked_until is not null and target_limit.locked_until > clock_timestamp() then
      insert into identity.patient_access_pin_attempts (
        actor_account_id, membership_id, facility_id, patient_id, outcome, correlation_id
      ) values (actor_account_id_value, actor_membership_id, actor_facility_id, patient_id_value, 'locked', actor_correlation_id);
      insert into audit.events (
        correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
        organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
        purpose_of_use, provenance, source_system, details
      ) values (
        actor_correlation_id, 'staff', actor_subject, actor_account_id_value, actor_membership_id,
        actor_organization_id, actor_facility_id, patient_id_value, denial_action, 'denied',
        'patient-access-pin', patient_id_value::text, 'direct-care', 'application', 'identity-api',
        jsonb_build_object('rate_limited', true)
      );
      return query select false, null::uuid, null::uuid, null::uuid, null::text, null::timestamptz, false;
      return;
    end if;
  end if;

  if patient_id_value is null or normalized_pin !~ '^[0-9]{4,8}$' then
    pin_row := null;
  else
    select * into pin_row from identity.patient_access_pins as secret_row
     where secret_row.patient_id = patient_id_value
       and secret_row.status = 'active'
       and secret_row.hash_algorithm = 'bcrypt';
  end if;

  -- PostgreSQL pgcrypto verifies the historic Blowfish `$2a$` setting, but
  -- returns a non-matching failure marker for `$2b$` and `$2y$` rather than
  -- raising an error. PINs are restricted to ASCII digits, for which those
  -- variants have the same bcrypt semantics. Keep the imported source hash
  -- byte-for-byte and normalize only the transient pgcrypto comparison value.
  if pin_row.patient_id is not null then
    verification_hash := case
      when pin_row.pin_hash ~ E'^\\$2[by]\\$' then '$2a$' || substring(pin_row.pin_hash from 5)
      else pin_row.pin_hash
    end;
  end if;

  -- Every permitted verifier consumes a bounded cost-12 bcrypt work budget.
  -- Historic `gen_salt('bf')` calls normally produced cost 06, while new HID
  -- PINs use cost 12. A cost-06 verifier plus dummy work at 06..11 has the
  -- same exponential-work total as one cost-12 verifier. The same construction
  -- works for every accepted 04..12 envelope. This avoids exposing an active
  -- legacy/current PIN through its bcrypt cost; out-of-range hashes are
  -- rejected at staging and by the table constraint.
  if pin_row.patient_id is null then
    perform public.crypt(normalized_pin, '$2a$12$C5UqoLY4dzh793px/LPNXeivTi5Z1q6uMC9AZF0woY.hZ6S/kPnf6');
  else
    pin_hash_cost := substring(verification_hash from 5 for 2)::integer;
    pin_matches := public.crypt(normalized_pin, verification_hash) = verification_hash;
    if pin_hash_cost < 12 then
      for padding_cost in pin_hash_cost..11 loop
        perform public.crypt(
          normalized_pin,
          '$2a$' || lpad(padding_cost::text, 2, '0')
            || '$C5UqoLY4dzh793px/LPNXeivTi5Z1q6uMC9AZF0woY.hZ6S/kPnf6'
        );
      end loop;
    end if;
  end if;
  if not pin_matches then
    update identity.patient_access_pin_actor_limits as limit_row
       set failure_count = case when window_started_at < clock_timestamp() - interval '15 minutes' then 1 else failure_count + 1 end,
           window_started_at = case when window_started_at < clock_timestamp() - interval '15 minutes' then clock_timestamp() else window_started_at end,
           locked_until = case when (case when window_started_at < clock_timestamp() - interval '15 minutes' then 1 else failure_count + 1 end) >= 5
             then clock_timestamp() + interval '15 minutes' else null end,
           updated_at = clock_timestamp()
     where limit_row.actor_account_id = actor_account_id_value
       and limit_row.facility_id = actor_facility_id;
    if patient_id_value is not null then
      update identity.patient_access_pin_target_limits as limit_row
         set failure_count = case when window_started_at < clock_timestamp() - interval '15 minutes' then 1 else failure_count + 1 end,
             window_started_at = case when window_started_at < clock_timestamp() - interval '15 minutes' then clock_timestamp() else window_started_at end,
             locked_until = case when (case when window_started_at < clock_timestamp() - interval '15 minutes' then 1 else failure_count + 1 end) >= 5
               then clock_timestamp() + interval '15 minutes' else null end,
             updated_at = clock_timestamp()
       where limit_row.actor_account_id = actor_account_id_value
         and limit_row.facility_id = actor_facility_id
         and limit_row.patient_id = patient_id_value;
    end if;
    insert into identity.patient_access_pin_attempts (
      actor_account_id, membership_id, facility_id, patient_id, outcome, correlation_id
    ) values (actor_account_id_value, actor_membership_id, actor_facility_id, patient_id_value, 'denied', actor_correlation_id);
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      actor_correlation_id, 'staff', actor_subject, actor_account_id_value, actor_membership_id,
      actor_organization_id, actor_facility_id, patient_id_value, denial_action, 'denied',
      'patient-access-pin', patient_id_value::text, 'direct-care', 'application', 'identity-api',
      jsonb_build_object('rate_limited', false)
    );
    return query select false, null::uuid, null::uuid, null::uuid, null::text, null::timestamptz, false;
    return;
  end if;

  -- A PIN cannot defeat a current patient deny directive. This mirrors the
  -- downstream authorization check before materializing the grant. Since 0121
  -- the grant is write_records, which also lets its holder read, so a deny for
  -- either reading or writing (or for every action) stops it.
  if exists (
    select 1
      from identity.consent_directives directive
      join identity.consent_directive_versions directive_version
        on directive_version.directive_id = directive.id
       and directive_version.version_no = directive.current_version
     where directive.patient_id = patient_id_value
       and directive_version.status = 'active'
       and directive_version.provision_type = 'deny'
       and directive_version.starts_at <= clock_timestamp()
       and (directive_version.expires_at is null or directive_version.expires_at > clock_timestamp())
       and (directive_version.facility_id is null or directive_version.facility_id = actor_facility_id)
       and (cardinality(directive_version.actions) = 0
            or directive_version.actions && array['read_records', pin_scope]::text[])
       and (cardinality(directive_version.purposes) = 0 or 'direct-care' = any(directive_version.purposes))
       and (
         directive_version.grantee_type = 'all'
         or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = actor_facility_id)
         or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = actor_organization_id)
         or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = actor_staff_id)
       )
  ) then
    insert into identity.patient_access_pin_attempts (
      actor_account_id, membership_id, facility_id, patient_id, outcome, correlation_id
    ) values (actor_account_id_value, actor_membership_id, actor_facility_id, patient_id_value, 'authorization_denied', actor_correlation_id);
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      actor_correlation_id, 'staff', actor_subject, actor_account_id_value, actor_membership_id,
      actor_organization_id, actor_facility_id, patient_id_value,
      'identity.patient-access-pin.authorization-denied', 'denied', 'patient-access-pin',
      patient_id_value::text, 'direct-care', 'application', 'identity-api', '{}'::jsonb
    );
    return query select false, null::uuid, null::uuid, null::uuid, null::text, null::timestamptz, false;
    return;
  end if;

  -- Only the verified patient's window is cleared. The actor's window is
  -- left to run out: a success for one patient must not forgive failed
  -- guesses at another (0075; main 0079).
  update identity.patient_access_pin_target_limits as limit_row
     set failure_count = 0, window_started_at = clock_timestamp(), locked_until = null, updated_at = clock_timestamp()
   where limit_row.actor_account_id = actor_account_id_value
     and limit_row.facility_id = actor_facility_id
     and limit_row.patient_id = patient_id_value;

  select grant_row.request_id, grant_row.id, grant_row.expires_at
    into request_id_value, grant_id_value, grant_expires_at
    from identity.consent_grants grant_row
   where grant_row.patient_id = patient_id_value
     and grant_row.account_id = actor_account_id_value
     and grant_row.membership_id = actor_membership_id
     and grant_row.facility_id = actor_facility_id
     and grant_row.scope = pin_scope
     and grant_row.purpose_of_use = 'direct-care'
     and grant_row.authorization_method = 'patient_access_pin'
     and grant_row.status = 'active'
     and grant_row.expires_at > clock_timestamp()
     and grant_row.migration_hold_reason is null
   order by grant_row.expires_at desc
   limit 1;

  if grant_id_value is null then
    -- pg_catalog is searched before every SECURITY DEFINER search_path, while
    -- pgcrypto itself lives in public in this schema history. Qualify the UUID
    -- generator so a public-schema shadow can never be used here.
    request_id_value := pg_catalog.gen_random_uuid();
    grant_id_value := pg_catalog.gen_random_uuid();
    -- The command may be authorized in this same request transaction.
    -- current_timestamp is transaction-consistent; a later clock_timestamp()
    -- would leave starts_at future-dated versus the authorization default.
    grant_expires_at := current_timestamp + make_interval(mins => pin_minutes);
    insert into identity.access_requests (
      id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use,
      reason, status, requested_duration_minutes, break_glass, approved_at,
      correlation_id, authorization_method
    ) values (
      request_id_value, patient_id_value, actor_staff_id, actor_membership_id,
      actor_facility_id, pin_scope, 'direct-care', 'Patient access PIN verification',
      'approved', pin_minutes, false, current_timestamp, actor_correlation_id,
      'patient_access_pin'
    );
    insert into identity.consent_grants (
      id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
      scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass,
      correlation_id, authorization_method
    ) values (
      grant_id_value, request_id_value, patient_id_value, actor_staff_id, actor_account_id_value,
      actor_membership_id, actor_facility_id, pin_scope, 'direct-care', 'active',
      'Patient access PIN verification', current_timestamp, grant_expires_at, false,
      actor_correlation_id, 'patient_access_pin'
    );
  else
    replayed := true;
  end if;

  insert into identity.patient_access_pin_attempts (
    actor_account_id, membership_id, facility_id, patient_id, outcome, correlation_id
  ) values (actor_account_id_value, actor_membership_id, actor_facility_id, patient_id_value, 'success', actor_correlation_id);
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor_correlation_id, 'staff', actor_subject, actor_account_id_value, actor_membership_id,
    actor_organization_id, actor_facility_id, patient_id_value,
    case when replayed then 'identity.patient-access-pin.replay' else 'identity.patient-access-pin.verify' end,
    'success', 'consent-grant', grant_id_value::text, 'direct-care', 'application', 'identity-api',
    jsonb_build_object('access_request_id', request_id_value, 'duration_minutes', pin_minutes,
      'expires_at', grant_expires_at, 'existing_grant', replayed, 'review_required', true,
      'scope', pin_scope)
  );
  if not replayed then
    insert into identity.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id, patient_id, correlation_id, payload
    ) values (
      'PatientAccessPinVerified', grant_id_value, 1, actor_facility_id, patient_id_value,
      actor_correlation_id,
      jsonb_build_object('consentGrantId', grant_id_value, 'reviewRequired', true, 'scope', pin_scope)
    );
  end if;
  return query select true, request_id_value, grant_id_value, patient_id_value,
    'active'::text, grant_expires_at, replayed;
end;
$$;

comment on function identity.access_patient_with_pin(text,text,integer) is
  '0120: a verified patient Access PIN gives the staff member direct-care read and write access (write_records) to the patient for exactly 24 hours (1440 minutes), whatever duration is asked (5 to 1440 is still checked); a still-valid write_records PIN grant is reused; a deny directive for reading or writing stops it; audit details and the PatientAccessPinVerified payload carry the scope.';

-- 4. Post-checks.
do $$
declare
  mismatch text;
begin
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = 'identity.access_patient_with_pin(text,text,integer)'::regprocedure)
     is distinct from 'e17e8bb85b755866bb0f1a03b5555c23' then
    raise exception using errcode = '55000', message = '0120: the function body is not this file''s';
  end if;
  select string_agg(before_row.signature, '; ') into mismatch
    from pin_0120_before before_row
   where before_row.attributes is distinct from (
     case when before_row.signature = 'policy' then
       (select concat_ws(' | ', policy_row.polcmd::text, policy_row.polpermissive::text,
                 policy_row.polroles::text, coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '-'))
          from pg_policy policy_row
         where policy_row.polrelid = 'identity.outbox_events'::regclass
           and policy_row.polname = 'identity_outbox_patient_access_pin_insert')
     else
       (select concat_ws(' | ', proc.proowner::regrole::text, proc.prolang::text, proc.procost::text, proc.prorows::text,
                 proc.provariadic::text, proc.prosupport::text, proc.prokind::text, proc.prosecdef::text,
                 proc.proleakproof::text, proc.proisstrict::text, proc.proretset::text, proc.provolatile::text,
                 proc.proparallel::text, proc.pronargs::text, proc.pronargdefaults::text, proc.prorettype::text,
                 proc.proargtypes::text, coalesce(proc.proallargtypes::text, '-'), coalesce(proc.proargmodes::text, '-'),
                 coalesce(proc.proargnames::text, '-'), coalesce(pg_get_expr(proc.proargdefaults, 0), '-'),
                 coalesce(proc.proconfig::text, '-'), coalesce(proc.proacl::text, 'default'))
          from pg_proc proc where proc.oid = before_row.signature::regprocedure)
     end);
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0120: attributes changed: %s', mismatch);
  end if;
  select string_agg(expected.what, '; ') into mismatch
    from (values
      ('identity.access_requests', 'access_requests_pin_scope_ck',
       $c$CHECK (((authorization_method IS DISTINCT FROM 'patient_access_pin'::text) OR ((scope = ANY (ARRAY['read_records'::text, 'write_records'::text])) AND (purpose_of_use = 'direct-care'::text) AND (break_glass = false))))$c$),
      ('identity.consent_grants', 'consent_grants_pin_scope_ck',
       $c$CHECK (((authorization_method IS DISTINCT FROM 'patient_access_pin'::text) OR ((scope = ANY (ARRAY['read_records'::text, 'write_records'::text])) AND (purpose_of_use = 'direct-care'::text) AND (break_glass = false))))$c$),
      ('identity.outbox_events', 'identity_outbox_minimum_necessary',
       $c$CHECK ((((event_type <> 'EmergencyAccessActivated'::text) OR ((aggregate_version = 1) AND (payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true)))) AND ((event_type <> 'PatientAccessPinVerified'::text) OR ((aggregate_version = 1) AND ((payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true)) OR (payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true, 'scope', 'read_records')) OR (payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true, 'scope', 'write_records')))))))$c$))
         expected(relation_name, what, definition)
   where (select count(*) from pg_constraint constraint_row
           where constraint_row.conrelid = expected.relation_name::regclass
             and constraint_row.conname = expected.what) <> 1
      or not exists (select 1 from pg_constraint constraint_row
                      where constraint_row.conrelid = expected.relation_name::regclass
                        and constraint_row.conname = expected.what
                        and constraint_row.contype = 'c' and constraint_row.convalidated
                        and pg_get_constraintdef(constraint_row.oid) = expected.definition);
  if mismatch is null and not exists (
       select 1 from pg_policy policy_row
        where policy_row.polrelid = 'identity.outbox_events'::regclass
          and policy_row.polname = 'identity_outbox_patient_access_pin_insert'
          and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = $p$((event_type = 'PatientAccessPinVerified'::text) AND (facility_id = platform.current_facility_id()) AND auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(), facility_id, 'identity.patient-access-pin.verify'::text) AND (EXISTS ( SELECT 1
   FROM identity.consent_grants grant_row
  WHERE ((grant_row.id = outbox_events.aggregate_id) AND (grant_row.patient_id = outbox_events.patient_id) AND (grant_row.facility_id = outbox_events.facility_id) AND (grant_row.membership_id = platform.current_membership_id()) AND (grant_row.account_id = auth.account_id_for_subject(platform.current_actor_subject())) AND (grant_row.authorization_method = 'patient_access_pin'::text) AND (grant_row.scope = ANY (ARRAY['read_records'::text, 'write_records'::text])) AND (COALESCE((outbox_events.payload ->> 'scope'::text), grant_row.scope) = grant_row.scope) AND (grant_row.purpose_of_use = 'direct-care'::text)))))$p$) then
    mismatch := 'policy identity_outbox_patient_access_pin_insert';
  end if;
  if mismatch is null then
    select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
      into mismatch
      from (values
        ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
        ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)',
         '732d11892dd4e27e1ff9093ae3b7de5a'),
        ('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamptz)',
         '6928763d3b69f0e4b4acf96a6a255736')) expected(proc, digest)
      left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
     where md5(proc.prosrc) is distinct from expected.digest;
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0120: not as this file makes it: %s', mismatch);
  end if;
end
$$;

drop table pin_0120_before;
