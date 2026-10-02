-- Existing-organization verification must compare the complete registry
-- snapshot established during governed onboarding. Legacy name-only bindings
-- cannot become verified evidence without a separate reconciliation.
drop function identity.current_organization_cac_binding_matches(text,text,text);

create function identity.current_organization_cac_binding_matches(
  requested_context text,
  requested_registration_number text,
  requested_legal_name text,
  requested_entity_type text,
  requested_registration_date text,
  requested_address text,
  requested_registry_status text
) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_subject_value text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject_value);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  expected_product text;
begin
  if actor_account_id is null or actor_membership_id is null or actor_facility_id is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.membership_has_permission(
       actor_subject_value, actor_membership_id, actor_facility_id, 'organization.manage'
     ) then
    raise exception using errcode = '42501', message = 'Organization CAC binding authorization is required';
  end if;
  expected_product := case requested_context when 'hospital' then 'ehr'
    when 'laboratory' then 'laboratory' when 'pharmacy' then 'pharmacy' else null end;
  if expected_product is null
     or requested_registration_number !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or length(btrim(coalesce(requested_legal_name, ''))) not between 2 and 200
     or requested_legal_name ~ '[[:cntrl:]]'
     or length(btrim(coalesce(requested_entity_type, ''))) not between 2 and 120
     or requested_entity_type ~ '[[:cntrl:]]'
     or requested_registration_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or length(btrim(coalesce(requested_address, ''))) not between 5 and 1000
     or requested_address ~ '[[:cntrl:]]'
     or requested_registry_status is distinct from 'active' then
    return false;
  end if;
  return exists (
    select 1
    from identity.staff_facility_memberships membership
    join identity.facilities facility on facility.id = membership.facility_id
    join identity.organizations organization_row on organization_row.id = facility.organization_id
    join identity.organization_cac_registrations binding
      on binding.organization_id = organization_row.id
    join identity.organization_applications application
      on application.id = binding.source_application_id
    join identity.organization_products product
      on product.organization_id = organization_row.id and product.facility_id = facility.id
    where membership.id = actor_membership_id and membership.account_id = actor_account_id
      and membership.facility_id = actor_facility_id
      and membership.organization_id = organization_row.id and membership.active
      and facility.active and facility.lifecycle_status = 'verified' and organization_row.active
      and product.product_code = expected_product and product.status = 'active'
      and binding.cac_registration_number = requested_registration_number
      and application.cac_registration_number = binding.cac_registration_number
      and application.organization_id = organization_row.id
      and application.status = 'approved' and application.verification_result = 'verified'
      and binding.verified_registry_status = 'active'
      and application.verified_registry_status = binding.verified_registry_status
      and binding.verified_organization_name is not null
      and application.verified_organization_name is not null
      and regexp_replace(lower(btrim(organization_row.name)), '[[:space:]]+', ' ', 'g')
        = regexp_replace(lower(btrim(binding.verified_organization_name)), '[[:space:]]+', ' ', 'g')
      and regexp_replace(lower(btrim(application.verified_organization_name)), '[[:space:]]+', ' ', 'g')
        = regexp_replace(lower(btrim(binding.verified_organization_name)), '[[:space:]]+', ' ', 'g')
      and regexp_replace(lower(btrim(requested_legal_name)), '[[:space:]]+', ' ', 'g')
        = regexp_replace(lower(btrim(binding.verified_organization_name)), '[[:space:]]+', ' ', 'g')
      and binding.verified_entity_type is not null
      and application.verified_entity_type = binding.verified_entity_type
      and requested_entity_type = binding.verified_entity_type
      and binding.verified_registration_date is not null
      and application.verified_registration_date = binding.verified_registration_date
      and requested_registration_date = binding.verified_registration_date::text
      and binding.verified_address is not null
      and application.verified_address = binding.verified_address
      and requested_address = binding.verified_address
  );
end;
$$;

revoke all on function identity.current_organization_cac_binding_matches(
  text,text,text,text,text,text,text) from public;
