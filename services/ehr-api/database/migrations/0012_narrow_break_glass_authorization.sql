-- Keep emergency access distinct from normal consent. A break-glass grant may
-- override an applicable patient deny only for an exact, reasoned, active
-- emergency read. It must never authorize writes or arbitrary actions.

create or replace function identity.has_active_consent_grant(
  request_patient_id uuid,
  request_subject text,
  request_membership_id uuid,
  request_facility_id uuid,
  request_action text,
  request_purpose text,
  at_time timestamptz default current_timestamp
)
returns boolean
language sql
stable
security definer
set search_path = identity, auth, pg_temp
as $$
  select
    at_time is not null
    and request_purpose is not null
    and length(btrim(request_purpose)) > 0
    and coalesce(request_action in ('read_records', 'write_records'), false)
    and exists (
      select 1
      from identity.purpose_of_use_codes purpose
      where purpose.code = request_purpose and purpose.active
    )
    and identity.has_active_membership(request_subject, request_membership_id, request_facility_id)
    and (
      (
        exists (
          select 1
          from identity.consent_grants grant_row
          join auth.accounts account_row on account_row.id = grant_row.account_id
          where grant_row.patient_id = request_patient_id
            and grant_row.membership_id = request_membership_id
            and grant_row.facility_id = request_facility_id
            and grant_row.purpose_of_use = request_purpose
            and account_row.subject = request_subject
            and account_row.status = 'active'
            and (account_row.disabled_until is null or account_row.disabled_until <= at_time)
            and grant_row.status = 'active'
            and grant_row.migration_hold_reason is null
            and grant_row.starts_at <= at_time
            and grant_row.expires_at > at_time
            and grant_row.scope <> 'break_glass'
            and not grant_row.break_glass
            and (
              grant_row.scope = request_action
              or (request_action = 'read_records' and grant_row.scope = 'write_records')
            )
        )
        and not exists (
          select 1
          from identity.consent_directives directive
          join identity.consent_directive_versions directive_version
            on directive_version.directive_id = directive.id
           and directive_version.version_no = directive.current_version
          join identity.staff_facility_memberships membership
            on membership.id = request_membership_id
           and membership.facility_id = request_facility_id
          where directive.patient_id = request_patient_id
            and directive_version.status = 'active'
            and directive_version.provision_type = 'deny'
            and directive_version.starts_at <= at_time
            and (directive_version.expires_at is null or directive_version.expires_at > at_time)
            and (directive_version.facility_id is null or directive_version.facility_id = request_facility_id)
            and (cardinality(directive_version.actions) = 0 or request_action = any(directive_version.actions))
            and (cardinality(directive_version.purposes) = 0 or request_purpose = any(directive_version.purposes))
            and (
              directive_version.grantee_type = 'all'
              or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = request_facility_id)
              or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = membership.organization_id)
              or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = membership.staff_id)
            )
        )
      )
      or (
        request_action = 'read_records'
        and request_purpose = 'emergency'
        and exists (
          select 1
          from identity.consent_grants emergency_grant
          join auth.accounts emergency_account on emergency_account.id = emergency_grant.account_id
          where emergency_grant.patient_id = request_patient_id
            and emergency_grant.membership_id = request_membership_id
            and emergency_grant.facility_id = request_facility_id
            and emergency_grant.purpose_of_use = 'emergency'
            and emergency_account.subject = request_subject
            and emergency_account.status = 'active'
            and (emergency_account.disabled_until is null or emergency_account.disabled_until <= at_time)
            and emergency_grant.scope = 'break_glass'
            and emergency_grant.break_glass
            and emergency_grant.status = 'active'
            and emergency_grant.migration_hold_reason is null
            and length(btrim(emergency_grant.reason)) between 8 and 500
            and emergency_grant.starts_at <= at_time
            and emergency_grant.expires_at > at_time
        )
      )
    )
$$;

comment on function identity.has_active_consent_grant(uuid, text, uuid, uuid, text, text, timestamptz) is
  'Authorizes exact active normal consent subject to directives, or an exact reasoned emergency break-glass grant for read_records only.';
