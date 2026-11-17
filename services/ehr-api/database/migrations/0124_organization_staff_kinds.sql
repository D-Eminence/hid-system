-- 0124 The kinds of an organisation, for the staff sign-in gate (owner
-- decisions Q90 and Q91 of 17 November 2026). Written on
-- staging-novu-ci-20261005 at 73eae090, where 0001-0123 are applied (as in
-- production). This file requires 0001-0123 applied.
--
-- Owner, verbatim: Q90 "Q90 A since its the best option that gives each
-- product seperate environment"; Q91 "Q91 A". identity-api's product gate
-- (Q88, src/auth/product-gate.ts) admits an administrator (organization.manage,
-- or the administrator of a self-signed-up facility awaiting review) as a
-- hospital role only at an organisation that is not recorded as a laboratory
-- or a pharmacy: a laboratory-only organisation's administrator signs in on
-- lab. only, a pharmacy-only one on pharmacy. only, one that is both on lab.
-- and pharmacy.; an organisation with no recorded kind (Q91 A), or with any
-- hospital or clinic kind, is a hospital. The declaration in
-- config/production-schema-compatibility.json is unsigned: its reviewed_by
-- stays empty until the owner signs it under 0124.
--
-- WHY A FUNCTION
--   The kind is recorded only in identity.organization_applications
--   (organization_type: clinic, hospital, laboratory, pharmacy or other),
--   linked to the organisation by identity.organization_products
--   (source_application_id). The Identity runtime has no privilege on either
--   table (runtime-grants.sql), and identity.organization_self_service_state
--   (0086) answers only self-signed-up organisations. So the staff context
--   reads the kinds through one STABLE SECURITY DEFINER function, one call
--   per membership, as it reads the self sign-up state.
--
-- WHAT IT DOES
--   1. identity.organization_staff_kinds(target_organization_id uuid) returns
--      text[]: the distinct effective kinds of the organisation, sorted, from
--      (a) the application behind each of its active organization_products
--      rows (an organisation may hold several products, each with its own
--      approved application: a governed approval may reuse an organisation),
--      and (b) the self sign-up application identity.organization_self_service_state
--      reads (the newest approved or released self-service application with
--      no reviewer), while it is pending or reviewed (not released).
--      Each application gives its organization_type, except 'other': it gives
--      'hospital' when the application's product_code is ehr or migrate (as
--      identity.staff_invitable_roles (0086) gives 'other' with ehr or migrate
--      the hospital roles), and nothing otherwise. The answer is always an
--      array (empty when nothing is recorded), only of clinic, hospital,
--      laboratory and pharmacy; nothing else of the applications or products
--      is returned. STABLE, SECURITY DEFINER, search_path pinned, owned by the
--      owner of identity.organization_self_service_state.
--   2. EXECUTE: revoked from PUBLIC, granted to hid_identity_runtime only
--      (here when the role exists, and in runtime-grants.sql), as
--      identity.organization_self_service_state is.
--
-- No table, column, index, constraint, policy, trigger, role or permission
-- changes; no other function changes; no row is read or written by this file
-- beyond the catalog. CREATE FUNCTION and GRANT take no lock on any table.
--
-- Services on this schema. Today's identity-api never calls the function, so
-- it works unchanged before and after this file. The identity-api of this
-- branch calls it in its staff context query, so this file must be applied
-- before that image runs (a release applies its migrations before it rolls
-- out the services).
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied): 0123
--    applied (identity.sealed_qa_facility(uuid) exists), else "0124:
--    0001-0123 must be applied first"; not applied yet (no
--    identity.organization_staff_kinds(uuid)), else "0124: already applied";
--    the columns read exist with the types 0046 and 0086 gave them; the
--    organization_type, product_code and product status checks are 0046's;
--    the bodies this function mirrors are as 0086 made them (md5 of
--    pg_proc.prosrc): identity.organization_self_service_state(uuid)
--    c67aa5224b2aa3d95e4415e26787d470 and
--    identity.staff_invitable_roles(text,text) b6f4068712d97284fd95d169e3bde0cf.
-- 1. The function, its comment, owner and EXECUTE.
-- 2. Post-checks: attributes, owner, ACL.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regprocedure('identity.sealed_qa_facility(uuid)') is null then
    raise exception using errcode = '55000', message = '0124: 0001-0123 must be applied first';
  end if;
  if to_regprocedure('identity.organization_staff_kinds(uuid)') is not null then
    raise exception using errcode = '55000', message = '0124: already applied';
  end if;
  select string_agg(expected.table_name || '.' || expected.column_name, ', ') into mismatch
    from (values
      ('identity.organization_applications', 'id', 'uuid'),
      ('identity.organization_applications', 'organization_id', 'uuid'),
      ('identity.organization_applications', 'organization_type', 'text'),
      ('identity.organization_applications', 'product_code', 'text'),
      ('identity.organization_applications', 'status', 'text'),
      ('identity.organization_applications', 'approval_mode', 'text'),
      ('identity.organization_applications', 'reviewed_by_account_id', 'uuid'),
      ('identity.organization_applications', 'reviewed_at', 'timestamp with time zone'),
      ('identity.organization_applications', 'self_service_released_at', 'timestamp with time zone'),
      ('identity.organization_products', 'organization_id', 'uuid'),
      ('identity.organization_products', 'status', 'text'),
      ('identity.organization_products', 'source_application_id', 'uuid')) expected(table_name, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = to_regclass(expected.table_name)
                        and attribute.attname = expected.column_name and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0124: these columns are not as 0046 and 0086 made them: ' || mismatch;
  end if;
  select string_agg(expected.constraint_name, ', ') into mismatch
    from (values
      ('identity.organization_applications', 'organization_applications_organization_type_check',
       'CHECK ((organization_type = ANY (ARRAY[''clinic''::text, ''hospital''::text, ''laboratory''::text, ''pharmacy''::text, ''other''::text])))'),
      ('identity.organization_applications', 'organization_applications_product_code_check',
       'CHECK ((product_code = ANY (ARRAY[''ehr''::text, ''migrate''::text, ''laboratory''::text, ''pharmacy''::text])))'),
      ('identity.organization_products', 'organization_products_status_check',
       'CHECK ((status = ANY (ARRAY[''active''::text, ''suspended''::text])))')) expected(table_name, constraint_name, definition)
   where not exists (select 1 from pg_constraint constraint_row
                      where constraint_row.conrelid = to_regclass(expected.table_name)
                        and constraint_row.conname = expected.constraint_name
                        and pg_get_constraintdef(constraint_row.oid) = expected.definition);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0124: these checks are not as 0046 made them: ' || mismatch;
  end if;
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('identity.organization_self_service_state(uuid)', 'c67aa5224b2aa3d95e4415e26787d470'),
      ('identity.staff_invitable_roles(text,text)', 'b6f4068712d97284fd95d169e3bde0cf')) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0124: these bodies are not as 0086 made them: ' || mismatch;
  end if;
end
$$;

-- 1. The function.
create function identity.organization_staff_kinds(target_organization_id uuid)
returns text[]
language sql stable security definer
set search_path = pg_catalog, identity, pg_temp
as $$
  select coalesce(array_agg(distinct recorded.kind order by recorded.kind), array[]::text[])
    from (
      select case when application.organization_type <> 'other' then application.organization_type
                  when application.product_code in ('ehr', 'migrate') then 'hospital' end as kind
        from identity.organization_products product
        join identity.organization_applications application on application.id = product.source_application_id
       where product.organization_id = target_organization_id
         and product.status = 'active'
      union all
      select case when self_service.organization_type <> 'other' then self_service.organization_type
                  when self_service.product_code in ('ehr', 'migrate') then 'hospital' end
        from (select application.organization_type, application.product_code, application.self_service_released_at
                from identity.organization_applications application
               where application.organization_id = target_organization_id
                 and application.approval_mode = 'self_service'
                 and application.reviewed_by_account_id is null
                 and (application.status = 'approved' or application.self_service_released_at is not null)
               order by application.reviewed_at desc, application.id desc
               limit 1) self_service
       where self_service.self_service_released_at is null
    ) recorded
   where recorded.kind is not null
$$;

comment on function identity.organization_staff_kinds(uuid) is
  '0124 (owner decisions Q90 and Q91, 17 November 2026): the distinct effective kinds (clinic, hospital, laboratory, pharmacy), sorted, of an organisation: the organization_type of the application behind each active organization_products row and of the pending or reviewed self sign-up application organization_self_service_state reads; other counts as hospital with product ehr or migrate (as staff_invitable_roles) and is otherwise left out. Empty when nothing is recorded. For the Identity runtime''s staff context (product gate): an administrator counts as a hospital role only where this is empty or holds clinic or hospital.';

revoke all on function identity.organization_staff_kinds(uuid) from public;

do $$
declare
  state_owner name := (select pg_get_userbyid(proowner) from pg_proc
                        where oid = 'identity.organization_self_service_state(uuid)'::regprocedure);
begin
  if state_owner <> current_user then
    execute format('alter function identity.organization_staff_kinds(uuid) owner to %I', state_owner);
  end if;
  -- EXECUTE (here and in runtime-grants.sql).
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.organization_staff_kinds(uuid) to hid_identity_runtime;
  end if;
end
$$;

-- 2. Post-checks.
do $$
begin
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'identity.organization_staff_kinds(uuid)'::regprocedure
                    and proc.prosecdef and proc.provolatile = 's' and not proc.proretset
                    and proc.prorettype = 'text[]'::regtype
                    and proc.proconfig = array['search_path=pg_catalog, identity, pg_temp']
                    and proc.proowner = (select state.proowner from pg_proc state
                                          where state.oid = 'identity.organization_self_service_state(uuid)'::regprocedure)) then
    raise exception using errcode = '55000', message = '0124: identity.organization_staff_kinds is not as section 1 made it';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid = 'identity.organization_staff_kinds(uuid)'::regprocedure
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime')) then
    raise exception using errcode = '55000', message = '0124: identity.organization_staff_kinds is granted to a role other than hid_identity_runtime';
  end if;
end
$$;
