-- 0126 The kinds of an organisation, for the staff sign-in gate (owner
-- decisions Q90 and Q91 of 17 November 2026). Written as 0124 on
-- staging-novu-ci-20261005 at 73eae090, where 0001-0123 are applied (as in
-- production); renumbered 0126 after hid-system#254's 0124 and #255's 0125
-- (booked on hid-system#258). This file requires 0001-0125 applied.
--
-- Owner, verbatim: Q90 "Q90 A since its the best option that gives each
-- product seperate environment"; Q91 "Q91 A". identity-api's product gate
-- (Q88, src/auth/product-gate.ts) admits an administrator (organization.manage,
-- or the administrator of a self-signed-up facility awaiting review) as a
-- hospital role only at an organisation that is not recorded as a laboratory
-- or a pharmacy: a laboratory-only organisation's administrator signs in on
-- lab. only, a pharmacy-only one on pharmacy. only, one that is both on lab.
-- and pharmacy. (and each also on the site of any other product its
-- organisation holds); an organisation with no recorded kind (Q91 A), or with
-- any hospital or clinic kind, is a hospital. The declaration in
-- config/production-schema-compatibility.json is unsigned: its reviewed_by
-- stays empty until the owner signs it under 0126.
--
-- WHY A FUNCTION
--   The kind is recorded only in identity.organization_applications
--   (organization_type: clinic, hospital, laboratory, pharmacy or other, and
--   product_code), and the products an organisation holds only in
--   identity.organization_products. The Identity runtime has no privilege on
--   either table (runtime-grants.sql), and
--   identity.organization_self_service_state (0086) answers only
--   self-signed-up organisations. So the staff context reads both through one
--   STABLE SECURITY DEFINER function, one call per membership, as it reads
--   the self sign-up state.
--
-- WHAT IT DOES
--   1. identity.organization_staff_kinds(target_organization_id uuid,
--      OUT organization_kinds text[], OUT organization_products text[])
--      returns one row:
--      organization_kinds: the distinct effective kinds of the organisation,
--      sorted, from every approved application of the organisation (status
--      'approved' with this organization_id: each governed approval, also one
--      that reused the organisation or whose product row already existed or
--      was later suspended, and a self sign-up while it is pending or
--      reviewed; a released self sign-up is 'rejected', 0086's
--      organization_applications_self_service_release_ck). Each application
--      gives its organization_type, except 'other', which gives the kind its
--      product makes it, exactly as identity.staff_invitable_roles (0086) and
--      identity-api's staffInvitableRoles read it: ehr or migrate 'hospital',
--      laboratory 'laboratory', pharmacy 'pharmacy'. An organisation promoted
--      from the legacy system (identity.organizations.source_system
--      'legacy_identity', scripts/promote-legacy-identity.mjs) also gives
--      'hospital': Q91 A made it a hospital because no kind was recorded for
--      it, and a governed approval that later reuses it for a laboratory or a
--      pharmacy product adds that kind without taking the hospital away.
--      organization_products: the distinct product codes (ehr, migrate,
--      laboratory, pharmacy), sorted, of the organisation's active
--      organization_products rows. The gate admits an administrator of an
--      organisation that is not a hospital on the site of each product its
--      organisation holds as well as on the sites of its kinds, so a
--      laboratory or a pharmacy that holds ehr or migrate keeps that site.
--      Both are always arrays (empty when nothing is recorded); nothing else
--      of the applications, products or organisation is returned. STABLE,
--      SECURITY DEFINER, search_path pinned, owned by the owner of
--      identity.organization_self_service_state.
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
--    and 0125 applied (identity.sealed_qa_facility(uuid) and
--    pharmacy.work_item_prescription_details(uuid[]) exist), else "0126:
--    0001-0125 must be applied first"; not applied yet (no
--    identity.organization_staff_kinds(uuid)), else "0126: already applied";
--    the columns read exist with the types 0002, 0046 and 0086 gave them; the
--    organization_type, product_code, application status and product status
--    checks are 0046's, and 0086's release check (a released self sign-up is
--    'rejected') is as 0086 made it (md5 of its definition
--    7d5cf043ccf443e618172df8462fb014); the bodies this function mirrors or
--    takes its owner from are as 0086 made them (md5 of pg_proc.prosrc):
--    identity.organization_self_service_state(uuid)
--    c67aa5224b2aa3d95e4415e26787d470 and
--    identity.staff_invitable_roles(text,text) b6f4068712d97284fd95d169e3bde0cf.
-- 1. The function, its comment, owner and EXECUTE.
-- 2. Post-checks: attributes, owner, ACL.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regprocedure('identity.sealed_qa_facility(uuid)') is null
     or to_regprocedure('pharmacy.work_item_prescription_details(uuid[])') is null then
    raise exception using errcode = '55000', message = '0126: 0001-0125 must be applied first';
  end if;
  if to_regprocedure('identity.organization_staff_kinds(uuid)') is not null then
    raise exception using errcode = '55000', message = '0126: already applied';
  end if;
  select string_agg(expected.table_name || '.' || expected.column_name, ', ') into mismatch
    from (values
      ('identity.organizations', 'id', 'uuid'),
      ('identity.organizations', 'source_system', 'text'),
      ('identity.organization_applications', 'organization_id', 'uuid'),
      ('identity.organization_applications', 'organization_type', 'text'),
      ('identity.organization_applications', 'product_code', 'text'),
      ('identity.organization_applications', 'status', 'text'),
      ('identity.organization_products', 'organization_id', 'uuid'),
      ('identity.organization_products', 'product_code', 'text'),
      ('identity.organization_products', 'status', 'text')) expected(table_name, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = to_regclass(expected.table_name)
                        and attribute.attname = expected.column_name and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0126: these columns are not as 0002, 0046 and 0086 made them: ' || mismatch;
  end if;
  select string_agg(expected.constraint_name, ', ') into mismatch
    from (values
      ('identity.organization_applications', 'organization_applications_organization_type_check',
       'CHECK ((organization_type = ANY (ARRAY[''clinic''::text, ''hospital''::text, ''laboratory''::text, ''pharmacy''::text, ''other''::text])))'),
      ('identity.organization_applications', 'organization_applications_product_code_check',
       'CHECK ((product_code = ANY (ARRAY[''ehr''::text, ''migrate''::text, ''laboratory''::text, ''pharmacy''::text])))'),
      ('identity.organization_applications', 'organization_applications_status_check',
       'CHECK ((status = ANY (ARRAY[''pending_verification''::text, ''ready_for_review''::text, ''approved''::text, ''rejected''::text])))'),
      ('identity.organization_products', 'organization_products_product_code_check',
       'CHECK ((product_code = ANY (ARRAY[''ehr''::text, ''migrate''::text, ''laboratory''::text, ''pharmacy''::text])))'),
      ('identity.organization_products', 'organization_products_status_check',
       'CHECK ((status = ANY (ARRAY[''active''::text, ''suspended''::text])))')) expected(table_name, constraint_name, definition)
   where not exists (select 1 from pg_constraint constraint_row
                      where constraint_row.conrelid = to_regclass(expected.table_name)
                        and constraint_row.conname = expected.constraint_name
                        and pg_get_constraintdef(constraint_row.oid) = expected.definition);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0126: these checks are not as 0046 made them: ' || mismatch;
  end if;
  if (select md5(pg_get_constraintdef(constraint_row.oid)) from pg_constraint constraint_row
       where constraint_row.conrelid = to_regclass('identity.organization_applications')
         and constraint_row.conname = 'organization_applications_self_service_release_ck')
     is distinct from '7d5cf043ccf443e618172df8462fb014' then
    raise exception using errcode = '55000',
      message = '0126: organization_applications_self_service_release_ck is not as 0086 made it';
  end if;
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('identity.organization_self_service_state(uuid)', 'c67aa5224b2aa3d95e4415e26787d470'),
      ('identity.staff_invitable_roles(text,text)', 'b6f4068712d97284fd95d169e3bde0cf')) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0126: these bodies are not as 0086 made them: ' || mismatch;
  end if;
end
$$;

-- 1. The function.
create function identity.organization_staff_kinds(target_organization_id uuid,
  out organization_kinds text[], out organization_products text[])
language sql stable security definer
set search_path = pg_catalog, identity, pg_temp
as $$
  select
    coalesce((select array_agg(distinct recorded.kind order by recorded.kind)
                from (select case when application.organization_type <> 'other' then application.organization_type
                                  when application.product_code in ('ehr', 'migrate') then 'hospital'
                                  when application.product_code = 'laboratory' then 'laboratory'
                                  when application.product_code = 'pharmacy' then 'pharmacy' end as kind
                        from identity.organization_applications application
                       where application.organization_id = target_organization_id
                         and application.status = 'approved'
                      union all
                      select 'hospital'
                        from identity.organizations organization
                       where organization.id = target_organization_id
                         and organization.source_system = 'legacy_identity') recorded
               where recorded.kind is not null),
             array[]::text[]),
    coalesce((select array_agg(product.product_code order by product.product_code)
                from identity.organization_products product
               where product.organization_id = target_organization_id
                 and product.status = 'active'),
             array[]::text[])
$$;

comment on function identity.organization_staff_kinds(uuid) is
  '0126 (owner decisions Q90 and Q91, 17 November 2026): one row. organization_kinds: the distinct effective kinds (clinic, hospital, laboratory, pharmacy), sorted, of the organisation''s approved applications (a released self sign-up is rejected), other giving the kind its product makes it as staff_invitable_roles does (ehr or migrate hospital, laboratory laboratory, pharmacy pharmacy), plus hospital for an organisation promoted from the legacy system (Q91 A). organization_products: the distinct product codes, sorted, of its active organization_products rows. Both empty when nothing is recorded. For the Identity runtime''s staff context (product gate): an administrator counts as a hospital role only where the kinds are empty or hold clinic or hospital, and is otherwise admitted on the sites of its kinds and of its products.';

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
                    and proc.prorettype = 'record'::regtype
                    and proc.proallargtypes = array['uuid', 'text[]', 'text[]']::regtype[]::oid[]
                    and proc.proargmodes = array['i', 'o', 'o']::"char"[]
                    and proc.proargnames = array['target_organization_id', 'organization_kinds', 'organization_products']
                    and proc.proconfig = array['search_path=pg_catalog, identity, pg_temp']
                    and proc.proowner = (select state.proowner from pg_proc state
                                          where state.oid = 'identity.organization_self_service_state(uuid)'::regprocedure)) then
    raise exception using errcode = '55000', message = '0126: identity.organization_staff_kinds is not as section 1 made it';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid = 'identity.organization_staff_kinds(uuid)'::regprocedure
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime')) then
    raise exception using errcode = '55000', message = '0126: identity.organization_staff_kinds is granted to a role other than hid_identity_runtime';
  end if;
end
$$;
