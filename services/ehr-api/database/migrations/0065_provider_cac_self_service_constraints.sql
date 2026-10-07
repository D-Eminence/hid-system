-- Complete the provider self-service onboarding extension.
-- The previous migration added the approval mode column; this migration replaces
-- the original reviewer-required check dynamically because its generated
-- PostgreSQL constraint name is not part of the stable contract.

do $$
declare constraint_row record;
begin
  for constraint_row in
    select constraint_row.conname
      from pg_constraint constraint_row
     where constraint_row.conrelid = 'identity.organization_applications'::regclass
       and constraint_row.contype = 'c'
       and pg_get_constraintdef(constraint_row.oid) like '%reviewed_by_account_id%'
       and pg_get_constraintdef(constraint_row.oid) like '%reviewed_at%'
       and pg_get_constraintdef(constraint_row.oid) like '%review_reason%'
  loop
    execute format('alter table identity.organization_applications drop constraint %I',
      constraint_row.conname);
  end loop;
end
$$;

alter table identity.organization_applications
  add constraint organization_applications_review_check_self_service check (
    status not in ('approved', 'rejected')
    or (
      reviewed_at is not null
      and length(btrim(coalesce(review_reason, ''))) >= 8
      and (
        approval_mode = 'self_service'
        or reviewed_by_account_id is not null
      )
    )
  );

create function identity.submit_self_service_organization_application(
  requested_product text,
  requested_organization_type text,
  requested_cac_number text,
  requested_administrator_name text,
  requested_administrator_email text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  normalized_cac text := upper(regexp_replace(coalesce(requested_cac_number, ''), '[[:space:]]+', '', 'g'));
  normalized_email text := lower(btrim(coalesce(requested_administrator_email, '')));
  application identity.organization_applications%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Organization enrollment context is required';
  end if;

  if requested_product not in ('ehr', 'migrate', 'laboratory', 'pharmacy')
     or requested_organization_type not in ('clinic', 'hospital', 'laboratory', 'pharmacy', 'other')
     or normalized_cac !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or length(btrim(coalesce(requested_administrator_name, ''))) not between 2 and 200
     or length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'Invalid provider enrollment';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('self-service-org-application:' || normalized_cac || ':' || requested_product, 0)
  );

  select * into application
    from identity.organization_applications row
   where row.cac_registration_number = normalized_cac
     and row.product_code = requested_product
     and row.status <> 'rejected'
   order by row.created_at desc
   limit 1
   for update;

  if found then
    if application.approval_mode <> 'self_service'
       or lower(application.administrator_email) <> normalized_email then
      raise exception using errcode = '23514',
        message = 'This organization application requires manual resolution';
    end if;
    if application.status = 'approved' then
      raise exception using errcode = '23514',
        message = 'This CAC is already registered with HID';
    end if;
    return application.id;
  end if;

  insert into identity.organization_applications (
    product_code, organization_name, organization_type, cac_registration_number,
    administrator_name, administrator_email, approval_mode
  ) values (
    requested_product, 'Pending CAC verification', requested_organization_type,
    normalized_cac, btrim(requested_administrator_name), normalized_email, 'self_service'
  ) returning * into application;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.submit', 'success',
    'organization-application', application.id::text,
    'application', 'identity-api',
    jsonb_build_object(
      'productCode', requested_product,
      'organizationType', requested_organization_type
    )
  );

  return application.id;
end;
$$;

revoke all on function identity.submit_self_service_organization_application(text,text,text,text,text)
  from public;
