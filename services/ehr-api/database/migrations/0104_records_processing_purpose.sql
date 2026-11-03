-- 0104 Records processing, Stage 1: the purpose of use OCR needs (owner
-- decisions of 2026-10-31, D-Eminence; the declaration signed separately).
-- Turning a paper record into the digital record runs under the purpose
-- healthcare-operations, shown to patients as "Records processing". The OCR
-- API already asks for it (create, validate, confirm and retry) and the staff
-- portal already sends it, but no migration on this branch seeds the code
-- (0071 seeds direct-care, 0085 emergency), so every OCR job is refused as a
-- missing grant and Identity refuses every request for it. Once the code is
-- active, a staff member asks the patient through the existing access request
-- (identity.create_access_request admits this purpose, 0098 R1), the patient
-- approves it (0072 copies the purpose onto the grant) and
-- identity.has_active_consent_grant honours that grant for this purpose only
-- (0012). Publishing into the chart stays a direct-care step.
--
-- D1 The code: ('healthcare-operations', 'Records processing', active, 'hid'),
--    ON CONFLICT (code) DO NOTHING as 0071 and 0085 insert theirs. A row an
--    operator already inserted, or deactivated, is kept as it is. The kill
--    switch is its active flag:
--      update identity.purpose_of_use_codes set active = false
--       where code = 'healthcare-operations';
--    Then create_access_request refuses the purpose (22023 "Invalid purpose
--    for a standard access request", Identity's 400 INVALID_CONSENT_COMMAND)
--    and has_active_consent_grant honours no grant for it, so every records-
--    processing read and write fails closed. No grant is seeded; no role,
--    permission, policy or runtime privilege changes.
-- D2 Who may ask (owner decision): staff whose membership holds ocr.job.write
--    (doctor, clinician, nurse, lab), not pharmacists or receptionists, who
--    hold identity.consent.write but could never use the grant. A BEFORE
--    INSERT trigger on identity.access_requests, for rows with this purpose
--    that are not break-glass, refuses unless
--    auth.membership_has_permission(platform.current_actor_subject(),
--    new.membership_id, new.facility_id, 'ocr.job.write'): 42501
--    RECORDS_PROCESSING_NOT_ALLOWED. The requesting membership is the one the
--    grant will belong to, and the actor must hold it, live and active. A
--    request with no actor (a direct insert) is refused too.
-- D3 Patients under 18 are refused until a guardian approval flow exists
--    (owner decision), and so is a patient with no date of birth on record
--    (fail closed): 42501 RECORDS_PROCESSING_MINOR. The date of birth is
--    identity.patients.dob; the age is taken on today's date in Africa/Lagos,
--    as 0090 and 0095 count their days. A patient is 18 from their 18th
--    birthday; one born on 29 February from 1 March in a year that has no 29
--    February. A date of birth in the future counts as under 18. The check
--    runs after D2's, so a caller who may not ask learns nothing about the
--    patient's age.
-- D4 One request lasts at most 24 hours (owner decision) and asks to read or
--    write records: the trigger refuses another scope or a duration outside 5
--    to 1440 minutes with 22023 RECORDS_PROCESSING_REQUEST_INVALID.
--    create_access_request already refuses both before its insert (and the
--    table's CHECK the duration), so only a direct insert can reach this one.
-- D5 The patient's request list shows the purpose: identity.list_my_access_
--    requests() gains a last column, purpose_of_use, and is otherwise 0072's
--    body. A function's result columns cannot change in place, so it is
--    dropped and created again with the same owner, its EXECUTE for
--    hid_identity_runtime given back (here when the role exists, and in
--    runtime-grants.sql, which already names it) and none for PUBLIC. Today's
--    Identity selects the eleven columns by name, so it reads the new
--    function unchanged. Its search_path is now pg_catalog, pg_temp; every
--    name in the body was already qualified.
--
-- Not changed: create_access_request, approve_access_request,
-- has_active_consent_grant and every other function body (their md5 pins in
-- 0091, 0094, 0095, 0098 and the suites stay true); break-glass (emergency,
-- break_glass rows never fire the trigger, and activate_break_glass admits only
-- the emergency purpose); the patient PIN (direct-care only); patient shares
-- (direct-care); the replay of a pending request, which inserts nothing. The
-- trigger fires on INSERT only: no service runtime may update
-- identity.access_requests (the schema-test runtime may), and the commands
-- that do (approval, denial, the expiries of 0086 and 0096) change only its
-- status.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0103 applied (else "0104: 0001-0103 must
--    be applied first"); not applied yet (else "0104: already applied"); the
--    bodies relied on are the ones 0001-0103 gave them (md5 of
--    pg_proc.prosrc), the replaced list among them, and the list still has
--    0072's result columns; the columns read have the types and NOT NULLs
--    0002, 0003 and 0008 gave them; identity.access_requests, identity.patients
--    and the list share one owner, the applying role is it or a member that
--    inherits it and may SET ROLE to it, and that owner may use the schemas,
--    read identity.facilities and execute the helpers (never through a
--    superuser's bypass). The trigger function reads identity.patients as its
--    owner, which row-level security does not restrict (not forced).
-- 1. The code (D1).
-- 2. The request list (D5).
-- 3. The trigger (D2-D4): identity.access_requests_records_processing(),
--    plpgsql, SECURITY DEFINER, search_path pg_catalog, pg_temp, owned by the
--    table's owner, granted to no role (a trigger needs no EXECUTE to fire).
-- 4. Post-checks: the code exists; the list's attributes, result and ACL;
--    the trigger's definition and the function's attributes and ACL.
--
-- Locks (measured with pg_locks before commit on a 0103 copy): ROW
-- EXCLUSIVE and ACCESS SHARE on identity.purpose_of_use_codes and its key
-- (one row written, then read back); SHARE ROW EXCLUSIVE on
-- identity.access_requests for CREATE
-- TRIGGER, so an access request being written waits for this transaction (a
-- few milliseconds) and the apply waits for one being written; ACCESS
-- EXCLUSIVE on the dropped list function and SHARE UPDATE EXCLUSIVE on the two
-- new ones (their comments); the schema, role and language read locks; ACCESS
-- EXCLUSIVE on the session's own temporary schema (section 0's helper). No
-- other application table. Behind a held lock the runner stops after its 5 s
-- lock_timeout and applies nothing. Calls take no lock on a function: a list
-- call already running finishes with 0072's body, and one that starts after
-- the commit runs the new one.
--
-- Old services on this schema: Identity reads the list by column name and
-- ignores the new column; the OCR API, the staff portal and Identity's
-- request route already use this purpose. Applied migrations 0001 through 0103
-- are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0097's and 0099's helper).
create function pg_temp.records_processing_0104_holds(holder oid, object_owner oid, object_acl aclitem[],
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
  -- a. Prerequisites (0001-0103; 0103's organization application gate body
  -- and 0102's demo story installer are the markers).
  if to_regprocedure('identity.organization_application_admin_account(text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = 'identity.organization_application_admin_account(text)'::regprocedure)
        is distinct from '186eb4ca420749b8bdb324bdc843bc50'
     or to_regprocedure('identity.demo_story_install(text)') is null
     or to_regclass('identity.access_requests') is null
     or to_regclass('identity.purpose_of_use_codes') is null
     or to_regclass('identity.patients') is null
     or to_regclass('identity.facilities') is null
     or to_regprocedure('identity.list_my_access_requests()') is null
     or to_regprocedure('identity.create_access_request(text,text,text,integer)') is null
     or to_regprocedure('identity.approve_access_request(uuid)') is null
     or to_regprocedure('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)') is null
     or to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null
     or to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('ehr.offline_audit_patient_allowed(uuid)') is null then
    raise exception using errcode = '55000', message = '0104: 0001-0103 must be applied first';
  end if;
  -- b. Not applied yet.
  if exists (select 1 from pg_proc proc
              where proc.pronamespace = 'identity'::regnamespace and proc.proname = 'access_requests_records_processing')
     or exists (select 1 from pg_trigger trigger_row
                 where trigger_row.tgrelid = 'identity.access_requests'::regclass
                   and trigger_row.tgname = 'access_requests_records_processing') then
    raise exception using errcode = '55000', message = '0104: already applied';
  end if;
  -- c. The bodies relied on, as 0001-0103 left them: the actor and account
  -- readers (0001, 0008), the permission check (0010), the request command
  -- whose insert the trigger guards (0098 R1), the approval that copies the
  -- purpose (0072), the grant check that honours it (0012), and the list
  -- this file replaces (0072).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('identity.create_access_request(text,text,text,integer)', 'f88923a49a180c2180fdedb29bf2eccf'),
      ('identity.approve_access_request(uuid)', 'af9482ccb8b9d9aa8486035478ac4e94'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '8b12ce866ee75cce411a2721795ffb92'),
      ('identity.list_my_access_requests()', '966c38f6e349caff2877316eed101ae3'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is null
     and pg_get_function_result('identity.list_my_access_requests()'::regprocedure) is distinct from
       'TABLE(access_request_id uuid, facility_id uuid, facility_name text, scope text, reason text, status text, '
       || 'requested_duration_minutes integer, requested_at timestamp with time zone, approved_at timestamp with time zone, '
       || 'denied_at timestamp with time zone, denied_reason text)' then
    mismatch := 'identity.list_my_access_requests() result columns';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0104: a function this migration relies on differs from 0001-0103: %s', mismatch);
  end if;
  -- d. The columns read.
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('identity.access_requests', 'patient_id', 'uuid', true),
      ('identity.access_requests', 'membership_id', 'uuid', true),
      ('identity.access_requests', 'facility_id', 'uuid', false),
      ('identity.access_requests', 'scope', 'text', true),
      ('identity.access_requests', 'requested_duration_minutes', 'integer', true),
      ('identity.access_requests', 'break_glass', 'boolean', true),
      ('identity.access_requests', 'purpose_of_use', 'text', false),
      ('identity.access_requests', 'migration_hold_reason', 'text', false),
      ('identity.patients', 'id', 'uuid', true),
      ('identity.patients', 'dob', 'date', false),
      ('identity.purpose_of_use_codes', 'code', 'text', true),
      ('identity.purpose_of_use_codes', 'active', 'boolean', true))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = expected.relation_name::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0104: a column this migration relies on differs from 0001-0103: %s', mismatch);
  end if;
  -- e. Ownership and privileges, never through a superuser's bypass
  -- (production's migrator has none).
  table_owner := (select relation.relowner from pg_class relation
                   where relation.oid = 'identity.access_requests'::regclass);
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not owned by %s', owned.what, pg_get_userbyid(table_owner)) as what
        from (select 'identity.patients' as what, relation.relowner as owner_id from pg_class relation
               where relation.oid = 'identity.patients'::regclass
              union all
              select 'identity.list_my_access_requests()', proc.proowner from pg_proc proc
               where proc.oid = 'identity.list_my_access_requests()'::regprocedure) owned
       where owned.owner_id <> table_owner
      union all
      select format('%s is not %s and may not act as it (INHERIT and SET)', current_user, pg_get_userbyid(table_owner))
       where applier <> table_owner
         and not (pg_has_role(applier, table_owner, 'USAGE') and pg_has_role(applier, table_owner, 'SET'))
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(table_owner), wanted.privilege, namespace.nspname)
        from (values ('identity', 'CREATE'), ('identity', 'USAGE'), ('auth', 'USAGE'), ('platform', 'USAGE'))
               wanted(schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.records_processing_0104_holds(table_owner, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks SELECT on %s', pg_get_userbyid(table_owner), relation.oid::regclass)
        from pg_class relation
       where relation.oid = 'identity.facilities'::regclass
         and not pg_temp.records_processing_0104_holds(table_owner, relation.relowner, relation.relacl, 'r', 'SELECT')
      union all
      select format('%s lacks EXECUTE on %s', pg_get_userbyid(table_owner), proc.oid::regprocedure)
        from (values ('platform.current_actor_subject()'), ('auth.account_id_for_subject(text)'),
                     ('auth.membership_has_permission(text,uuid,uuid,text)')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
       where not pg_temp.records_processing_0104_holds(table_owner, proc.proowner, proc.proacl, 'f', 'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0104: missing privileges: %s', mismatch);
  end if;
  raise notice '0104: owners checked: identity.access_requests=%, applier=%', pg_get_userbyid(table_owner), current_user;
end
$$;

-- 1. The code (D1).
insert into identity.purpose_of_use_codes (code, display, active, source_system)
values ('healthcare-operations', 'Records processing', true, 'hid')
on conflict (code) do nothing;

-- 2. The request list (D5): 0072's body and one more column.
drop function identity.list_my_access_requests();

create function identity.list_my_access_requests()
returns table (
  access_request_id uuid,
  facility_id uuid,
  facility_name text,
  scope text,
  reason text,
  status text,
  requested_duration_minutes integer,
  requested_at timestamptz,
  approved_at timestamptz,
  denied_at timestamptz,
  denied_reason text,
  purpose_of_use text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_account_id uuid := auth.account_id_for_subject(platform.current_actor_subject());
  patient_id_value uuid;
begin
  if actor_account_id is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;
  select patient_row.id into patient_id_value
    from identity.patients patient_row
   where patient_row.account_id = actor_account_id
     and patient_row.status = 'active'
   limit 1;
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;

  return query
  select request_row.id, request_row.facility_id, facility.name,
    request_row.scope, request_row.reason, request_row.status,
    request_row.requested_duration_minutes, request_row.created_at,
    request_row.approved_at, request_row.denied_at, request_row.denied_reason,
    request_row.purpose_of_use
    from identity.access_requests request_row
    join identity.facilities facility on facility.id = request_row.facility_id
   where request_row.patient_id = patient_id_value
     and request_row.break_glass = false
     and request_row.migration_hold_reason is null
   order by request_row.created_at desc, request_row.id desc
   limit 100;
end;
$$;

comment on function identity.list_my_access_requests() is
  '0104: the signed-in patient''s 100 latest standard access requests (no break-glass, none held by the cutover), with the purpose of use (0072''s body and its last column).';

-- 3. The trigger (D2-D4).
create function identity.access_requests_records_processing()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  birth_date date;
begin
  if not coalesce(auth.membership_has_permission(platform.current_actor_subject(), new.membership_id,
                    new.facility_id, 'ocr.job.write'), false) then
    raise exception using errcode = '42501', message = 'RECORDS_PROCESSING_NOT_ALLOWED';
  end if;
  if new.scope not in ('read_records', 'write_records')
     or new.requested_duration_minutes not between 5 and 1440 then
    raise exception using errcode = '22023', message = 'RECORDS_PROCESSING_REQUEST_INVALID';
  end if;
  select patient_row.dob into birth_date from identity.patients patient_row where patient_row.id = new.patient_id;
  if birth_date is null
     or birth_date > ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '18 years')::date then
    raise exception using errcode = '42501', message = 'RECORDS_PROCESSING_MINOR';
  end if;
  return new;
end
$$;

comment on function identity.access_requests_records_processing() is
  '0104: a records-processing (healthcare-operations, not break-glass) access request needs an actor whose membership holds ocr.job.write (42501 RECORDS_PROCESSING_NOT_ALLOWED), read or write for 5 to 1440 minutes (22023 RECORDS_PROCESSING_REQUEST_INVALID), and a patient aged 18 or over in Africa/Lagos with a date of birth on record (42501 RECORDS_PROCESSING_MINOR).';

create trigger access_requests_records_processing
  before insert on identity.access_requests
  for each row
  when (new.purpose_of_use = 'healthcare-operations' and not new.break_glass)
  execute function identity.access_requests_records_processing();

-- The table's owner owns both functions (a no-op when the applier is that
-- owner, as on every database built by one migration login).
do $$
declare
  table_owner oid := (select relation.relowner from pg_class relation
                       where relation.oid = 'identity.access_requests'::regclass);
  signature text;
begin
  foreach signature in array array['identity.list_my_access_requests()', 'identity.access_requests_records_processing()'] loop
    if (select proc.proowner from pg_proc proc where proc.oid = signature::regprocedure) <> table_owner then
      execute format('alter function %s owner to %I', signature, pg_get_userbyid(table_owner));
    end if;
  end loop;
end
$$;

-- Grants (here and in runtime-grants.sql).
revoke all on function identity.list_my_access_requests() from public;
revoke all on function identity.access_requests_records_processing() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.list_my_access_requests() to hid_identity_runtime;
  end if;
end
$$;

-- 4. Post-checks (after the grants, so the ACLs are the final ones).
do $$
declare
  mismatch text;
begin
  if not exists (select 1 from identity.purpose_of_use_codes where code = 'healthcare-operations') then
    raise exception using errcode = '55000', message = '0104: the healthcare-operations code is missing';
  end if;
  select string_agg(format('%s: owner=%s definer=%s volatile=%s language=%s strict=%s config=%s result=%s',
           proc.oid::regprocedure, pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
           language_row.lanname, proc.proisstrict, proc.proconfig, pg_get_function_result(proc.oid)), '; ')
    into mismatch
    from (values ('identity.list_my_access_requests()',
                  'TABLE(access_request_id uuid, facility_id uuid, facility_name text, scope text, reason text, '
                  || 'status text, requested_duration_minutes integer, requested_at timestamp with time zone, '
                  || 'approved_at timestamp with time zone, denied_at timestamp with time zone, denied_reason text, '
                  || 'purpose_of_use text)'),
                 ('identity.access_requests_records_processing()', 'trigger')) expected(signature, result)
    join pg_proc proc on proc.oid = expected.signature::regprocedure
    join pg_language language_row on language_row.oid = proc.prolang
   where proc.proowner <> (select relation.relowner from pg_class relation
                            where relation.oid = 'identity.access_requests'::regclass)
      or not proc.prosecdef or proc.provolatile <> 'v' or language_row.lanname <> 'plpgsql' or proc.proisstrict
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]
      or pg_get_function_result(proc.oid) is distinct from expected.result;
  if mismatch is null
     and (select count(*) from pg_proc proc
           where proc.pronamespace = 'identity'::regnamespace
             and proc.proname in ('list_my_access_requests', 'access_requests_records_processing')) <> 2 then
    mismatch := 'count';
  end if;
  if mismatch is null
     and (select count(*) from pg_trigger trigger_row
           where trigger_row.tgrelid = 'identity.access_requests'::regclass
             and trigger_row.tgname = 'access_requests_records_processing' and trigger_row.tgenabled = 'O'
             and pg_get_triggerdef(trigger_row.oid) =
               'CREATE TRIGGER access_requests_records_processing BEFORE INSERT ON identity.access_requests '
               || 'FOR EACH ROW WHEN (((new.purpose_of_use = ''healthcare-operations''::text) AND (NOT new.break_glass))) '
               || 'EXECUTE FUNCTION identity.access_requests_records_processing()') <> 1 then
    mismatch := 'the trigger';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0104: not as this file makes it: %s', mismatch);
  end if;
  select string_agg(granted.what, '; ') into mismatch
    from (
      select proc.oid::regprocedure || ' ' || case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
             || ' ' || acl.privilege_type as what
        from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where proc.oid in ('identity.list_my_access_requests()'::regprocedure,
                          'identity.access_requests_records_processing()'::regprocedure)
         and acl.grantee <> proc.proowner
         and (proc.oid <> 'identity.list_my_access_requests()'::regprocedure or acl.grantee = 0
              or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime' or acl.privilege_type <> 'EXECUTE')
      union all
      select 'missing hid_identity_runtime EXECUTE on identity.list_my_access_requests()'
        from pg_roles role_row
       where role_row.rolname = 'hid_identity_runtime'
         and not exists (select 1 from pg_proc proc, aclexplode(proc.proacl) acl
                          where proc.oid = 'identity.list_my_access_requests()'::regprocedure
                            and acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')) granted;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0104: an ACL is not this file''s: %s', mismatch);
  end if;
end
$$;
