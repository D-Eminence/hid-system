-- Preserve source-account disable windows and make consent provenance an
-- authorization-grade relational contract. Legacy rows without a governed
-- purpose are retained but cannot authorize access until remediated.

alter table auth.accounts
  add column disabled_until timestamptz,
  add column email_verified_at timestamptz;

comment on column auth.accounts.disabled_until is
  'Source or HID account suspension boundary. An otherwise-active account is ineligible while this timestamp is in the future.';
comment on column auth.accounts.email_verified_at is
  'Preserved source email-confirmation evidence. Unconfirmed legacy accounts are migrated as pending_reset and cannot authenticate.';

alter table identity.staff_facility_memberships
  add constraint staff_memberships_exact_staff_facility_uq
    unique (id, staff_id, facility_id),
  add constraint staff_memberships_exact_actor_facility_uq
    unique (id, staff_id, account_id, facility_id);

alter table identity.access_requests
  add column purpose_of_use text references identity.purpose_of_use_codes(code) on delete restrict,
  add constraint access_requests_exact_membership_fk
    foreign key (membership_id, staff_id, facility_id)
    references identity.staff_facility_memberships(id, staff_id, facility_id) on delete restrict,
  add constraint access_requests_approver_is_patient_ck
    check (approved_by_patient_id is null or approved_by_patient_id = patient_id),
  add constraint access_requests_purpose_or_hold_ck
    check (purpose_of_use is not null or migration_hold_reason is not null),
  add constraint access_requests_authorization_tuple_uq
    unique (id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use);

alter table identity.consent_grants
  add column purpose_of_use text references identity.purpose_of_use_codes(code) on delete restrict,
  add column source_request_id text,
  add constraint consent_grants_exact_membership_fk
    foreign key (membership_id, staff_id, account_id, facility_id)
    references identity.staff_facility_memberships(id, staff_id, account_id, facility_id) on delete restrict,
  add constraint consent_grants_grantor_is_patient_ck
    check (granted_by_patient_id is null or granted_by_patient_id = patient_id),
  add constraint consent_grants_purpose_or_hold_ck
    check (purpose_of_use is not null or migration_hold_reason is not null),
  add constraint consent_grants_request_context_ck
    check (request_id is null or (facility_id is not null and purpose_of_use is not null)),
  add constraint consent_grants_source_request_id_ck
    check (source_request_id is null or length(source_request_id) between 1 and 255),
  add constraint consent_grants_exact_request_fk
    foreign key (request_id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use)
    references identity.access_requests(id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use)
    on delete restrict;

create index consent_grants_authorization_purpose_idx
  on identity.consent_grants (
    patient_id, membership_id, facility_id, purpose_of_use, status, expires_at desc
  );

create or replace function auth.account_id_for_subject(request_subject text)
returns uuid
language sql
stable
security definer
set search_path = auth, pg_temp
as $$
  select account_row.id
  from auth.accounts account_row
  where account_row.subject = request_subject
    and account_row.status = 'active'
    and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
  limit 1
$$;

create or replace function identity.has_active_membership(
  request_subject text,
  request_membership_id uuid,
  request_facility_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = identity, auth, pg_temp
as $$
  select exists (
    select 1
    from identity.staff_facility_memberships membership
    join auth.accounts account_row on account_row.id = membership.account_id
    join identity.staff staff_row on staff_row.id = membership.staff_id
    join identity.facilities facility on facility.id = membership.facility_id
    join identity.organizations organization_row on organization_row.id = membership.organization_id
    where membership.id = request_membership_id
      and membership.facility_id = request_facility_id
      and facility.organization_id = membership.organization_id
      and account_row.subject = request_subject
      and account_row.status = 'active'
      and (account_row.disabled_until is null or account_row.disabled_until <= current_timestamp)
      and staff_row.active
      and lower(staff_row.verification_status) in ('verified', 'approved', 'active')
      and membership.active
      and membership.migration_hold_reason is null
      and facility.active
      and organization_row.active
  )
$$;

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
    request_purpose is not null
    and length(btrim(request_purpose)) > 0
    and exists (
      select 1
      from identity.purpose_of_use_codes purpose
      where purpose.code = request_purpose and purpose.active
    )
    and identity.has_active_membership(request_subject, request_membership_id, request_facility_id)
    and exists (
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
        and (
          grant_row.scope = 'break_glass'
          or grant_row.scope = request_action
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
$$;

create or replace function auth.upgrade_legacy_password(
  requested_account_id uuid,
  requested_subject text,
  expected_row_version bigint,
  new_password_hash text
)
returns boolean
language plpgsql
security definer
set search_path = auth, platform, pg_temp
as $$
declare
  affected_rows integer;
begin
  if platform.current_actor_subject() <> 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Verified authentication context is required';
  end if;
  if requested_account_id is null
     or nullif(btrim(requested_subject), '') is null
     or expected_row_version < 1 then
    raise exception using errcode = '22023', message = 'Invalid password upgrade target';
  end if;
  if length(coalesce(new_password_hash, '')) not between 64 and 512
     or new_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$' then
    raise exception using errcode = '22023', message = 'Invalid Argon2id password hash policy';
  end if;

  update auth.accounts
     set password_hash = new_password_hash,
         password_algorithm = 'argon2id',
         password_changed_at = clock_timestamp(),
         row_version = row_version + 1,
         updated_at = clock_timestamp()
   where id = requested_account_id
     and subject = requested_subject
     and row_version = expected_row_version
     and status = 'active'
     and (disabled_until is null or disabled_until <= clock_timestamp())
     and password_algorithm = 'bcrypt_legacy';

  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

revoke all on function auth.upgrade_legacy_password(uuid, text, bigint, text) from public;

create or replace function identity.validate_consent_directive_vocabulary()
returns trigger
language plpgsql
set search_path = identity, pg_temp
as $$
begin
  if array_position(new.purposes, null) is not null
     or exists (
       select 1
       from unnest(new.purposes) requested(code)
       left join identity.purpose_of_use_codes purpose on purpose.code = requested.code and purpose.active
       where purpose.code is null
     ) then
    raise exception using errcode = '23514', message = 'Consent directive contains an inactive or unknown purpose';
  end if;
  if array_position(new.actions, null) is not null
     or not new.actions <@ array['read_records', 'write_records', 'break_glass']::text[] then
    raise exception using errcode = '23514', message = 'Consent directive contains an unsupported action';
  end if;
  return new;
end;
$$;

create trigger consent_directive_versions_vocabulary
  before insert on identity.consent_directive_versions
  for each row execute function identity.validate_consent_directive_vocabulary();

comment on column identity.consent_grants.source_request_id is
  'Preserves a legacy request identifier when the target request cannot yet be safely bound to a governed purpose.';
