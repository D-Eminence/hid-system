-- Runtime LOGIN verification (launch, DB-LOGIN-VERIFY). Run by
-- scripts/verify-runtime-logins.mjs (`npm run db:verify-logins`) on a
-- connection made with one service credential's own URL, never with an
-- administrator's: a check of the catalogue alone cannot tell that a service
-- secret holds the migration administrator's URL. The script sets
-- hid_verify.expected_role to the aggregate role the credential must use and
-- hid_verify.forbidden_logins to the comma-separated names of the RDS master
-- and the migration administrator. This file is assertion-only.
--
-- runtime-roles.integration.sql (db:verify-roles) checks the NOLOGIN group
-- roles; this checks the login itself. Row-level security is the main
-- cross-facility control: a login that is a superuser or BYPASSRLS skips it,
-- and a login with the privileges of a table's owner skips it on every table
-- that does not force it (the Identity patient and consent tables among them).
do $$
declare
  expected_role text := current_setting('hid_verify.expected_role');
  forbidden text[] := array_remove(
    string_to_array(coalesce(current_setting('hid_verify.forbidden_logins', true), ''), ','), '');
  login_row record;
  problems text[] := '{}';
  found text;
  application_schemas text[] := array['platform', 'auth', 'identity', 'ehr', 'audit', 'ocr', 'lab',
    'pharmacy', 'outreach', 'integration', 'notification', 'migration'];
begin
  if expected_role not in ('hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_document_scanner',
       'hid_lab_api_runtime', 'hid_pharmacy_api_runtime', 'hid_ocr_api_runtime', 'hid_ocr_worker',
       'hid_outreach_api_runtime', 'hid_event_dispatcher', 'hid_notification_worker') then
    raise exception 'hid_verify.expected_role names no runtime aggregate: %', expected_role;
  end if;
  if to_regrole(expected_role) is null then
    raise exception 'runtime aggregate % does not exist; run the role bootstrap first', expected_role;
  end if;

  -- The URL authenticates as the login itself and sets no other role.
  if session_user <> current_user then
    problems := problems || format('the connection authenticated as %s but runs as %s', session_user, current_user);
  end if;
  if current_user = any (forbidden) then
    problems := problems || format('%s is the RDS master or the migration administrator', current_user);
  end if;
  select oid, rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
    into strict login_row from pg_roles where rolname = current_user;
  if login_row.rolsuper or login_row.rolbypassrls or login_row.rolcreaterole or login_row.rolcreatedb
     or login_row.rolreplication then
    problems := problems || format('%s has SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION',
      login_row.rolname);
  end if;

  -- Exactly one direct membership, in the expected aggregate, inherited and
  -- without ADMIN OPTION; and every role whose privileges or membership the
  -- login reaches is one the aggregate reaches, so the login has no
  -- membership in rds_superuser, pg_read_all_data, the migration role, the
  -- schema-test role, a technical owner, another service's aggregate or the
  -- database owner.
  select array_to_string((array_agg(granted.rolname
           || case when membership.admin_option then ' with ADMIN OPTION' else '' end
           || case when membership.inherit_option then '' else ' without INHERIT' end
           order by granted.rolname))[1:10], ', ')
    into found
    from pg_auth_members membership join pg_roles granted on granted.oid = membership.roleid
   where membership.member = login_row.oid;
  if found is distinct from expected_role then
    problems := problems || format('%s must be a direct member of %s only, inherited and without ADMIN OPTION; it is a member of %s',
      login_row.rolname, expected_role, coalesce(found, 'no role'));
  end if;
  select array_to_string((array_agg(reached.rolname::text order by reached.rolname))[1:10], ', ') into found
    from pg_roles reached
   where reached.oid <> login_row.oid
     and pg_has_role(login_row.oid, reached.oid, 'MEMBER')
     and not pg_has_role(expected_role, reached.oid, 'MEMBER');
  if found is not null then
    problems := problems || format('%s reaches roles its aggregate does not: %s', login_row.rolname, found);
  end if;

  -- No owner privileges: not the database owner, and no schema, relation or
  -- function whose owner's privileges the login has, directly or inherited.
  if pg_has_role(login_row.oid, (select datdba from pg_database where datname = current_database()), 'USAGE') then
    problems := problems || format('%s has the privileges of the database owner', login_row.rolname);
  end if;
  select count(*) || ' objects, among them ' || array_to_string((array_agg(owned.name order by owned.name))[1:10], ', ')
    into found
    from (
      select namespace_row.nspname::text as name
        from pg_namespace namespace_row
       where namespace_row.nspname = any (application_schemas)
         and pg_has_role(login_row.oid, namespace_row.nspowner, 'USAGE')
      union all
      select relation.oid::regclass::text
        from pg_class relation join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
       where namespace_row.nspname = any (application_schemas)
         and pg_has_role(login_row.oid, relation.relowner, 'USAGE')
      union all
      select proc.oid::regprocedure::text
        from pg_proc proc join pg_namespace namespace_row on namespace_row.oid = proc.pronamespace
       where namespace_row.nspname = any (application_schemas)
         and pg_has_role(login_row.oid, proc.proowner, 'USAGE')
    ) owned
   having count(*) > 0;
  if found is not null then
    problems := problems || format('%s has the owner''s privileges on %s', login_row.rolname, found);
  end if;

  -- Privileges come only through the aggregate: no grant names the login,
  -- and it may create nothing.
  select count(*) || ' objects, among them ' || array_to_string((array_agg(granted.name order by granted.name))[1:10], ', ')
    into found
    from (
      select distinct relation.oid::regclass::text as name
        from pg_class relation
        join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
        cross join lateral aclexplode(relation.relacl) privilege
       where namespace_row.nspname = any (application_schemas) and privilege.grantee = login_row.oid
      union
      select relation.oid::regclass::text || '.' || attribute.attname
        from pg_class relation
        join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
        join pg_attribute attribute on attribute.attrelid = relation.oid
        cross join lateral aclexplode(attribute.attacl) privilege
       where namespace_row.nspname = any (application_schemas) and privilege.grantee = login_row.oid
      union
      select proc.oid::regprocedure::text
        from pg_proc proc
        join pg_namespace namespace_row on namespace_row.oid = proc.pronamespace
        cross join lateral aclexplode(proc.proacl) privilege
       where namespace_row.nspname = any (application_schemas) and privilege.grantee = login_row.oid
      union
      select 'schema ' || namespace_row.nspname
        from pg_namespace namespace_row, aclexplode(namespace_row.nspacl) privilege
       where namespace_row.nspname = any (application_schemas) and privilege.grantee = login_row.oid
    ) granted
   having count(*) > 0;
  if found is not null then
    problems := problems || format('grants name %s directly on %s', login_row.rolname, found);
  end if;
  if has_database_privilege(login_row.oid, current_database(), 'CREATE')
     or exists (
       select 1 from pg_namespace namespace_row
        where namespace_row.nspname !~ '^pg_' and namespace_row.nspname <> 'information_schema'
          and has_schema_privilege(login_row.oid, namespace_row.oid, 'CREATE')
     ) then
    problems := problems || format('%s may create schemas or objects', login_row.rolname);
  end if;

  if cardinality(problems) > 0 then
    raise exception 'runtime login verification failed for %: %', expected_role, array_to_string(problems, '; ');
  end if;
end
$$;
