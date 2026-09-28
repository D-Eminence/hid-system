-- Supabase-to-AWS cutover controls.
--
-- This migration deliberately preserves legacy bcrypt PIN hashes and Google
-- provider subjects, but does not preserve the legacy PIN authorization
-- semantics. A PIN-derived grant is read-only, direct-care-only, short lived,
-- rate limited, reviewed, and cannot bypass consent directives.

insert into auth.permissions (code, description) values
  ('identity.patient-access-pin.verify',
   'Verify a patient-configured access PIN for a narrow, time-limited read grant')
on conflict (code) do update set description = excluded.description, active = true;

insert into auth.role_permissions (role_code, permission_code)
select mapping.role_code, mapping.permission_code
from (values
  ('doctor', 'identity.patient-access-pin.verify'),
  ('clinician', 'identity.patient-access-pin.verify'),
  ('nurse', 'identity.patient-access-pin.verify')
) as mapping(role_code, permission_code)
on conflict (role_code, permission_code) do nothing;

-- The hash is the source bcrypt envelope, never a PIN or a reversible secret.
-- No application role receives table access; only narrowly scoped commands
-- below may use it.
create table identity.patient_access_pins (
  patient_id uuid primary key references identity.patients(id) on delete restrict,
  pin_hash text not null check (
    pin_hash ~ E'^\\$2[aby]\\$(0[4-9]|1[0-2])\\$[./A-Za-z0-9]{53}$'
  ),
  status text not null default 'active' check (status in ('active', 'disabled', 'revoked')),
  hash_algorithm text not null default 'bcrypt' check (hash_algorithm = 'bcrypt'),
  disabled_at timestamptz,
  disabled_reason text check (disabled_reason is null or length(btrim(disabled_reason)) between 8 and 500),
  source_system text not null default 'hid',
  source_record_id text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  check ((status = 'active') = (disabled_at is null)),
  check ((status = 'active') = (disabled_reason is null))
);

create table identity.patient_access_pin_attempts (
  sequence_id bigint generated always as identity primary key,
  occurred_at timestamptz not null default clock_timestamp(),
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid references identity.patients(id) on delete restrict,
  outcome text not null check (outcome in ('success', 'denied', 'locked', 'authorization_denied')),
  correlation_id text not null check (
    length(correlation_id) between 8 and 128
    and correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  foreign key (membership_id, facility_id, actor_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict
);
create index patient_access_pin_attempt_actor_idx
  on identity.patient_access_pin_attempts (actor_account_id, facility_id, occurred_at desc);
create index patient_access_pin_attempt_patient_idx
  on identity.patient_access_pin_attempts (patient_id, occurred_at desc)
  where patient_id is not null;
create trigger patient_access_pin_attempts_no_mutation
  before update or delete on identity.patient_access_pin_attempts
  for each row execute function platform.reject_mutation();

-- Separate actor and target windows prevent a staff account from distributing
-- guesses over many patients while also protecting a particular patient PIN.
create table identity.patient_access_pin_actor_limits (
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  failure_count integer not null default 0 check (failure_count >= 0),
  window_started_at timestamptz not null default clock_timestamp(),
  locked_until timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (actor_account_id, facility_id)
);
create table identity.patient_access_pin_target_limits (
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  failure_count integer not null default 0 check (failure_count >= 0),
  window_started_at timestamptz not null default clock_timestamp(),
  locked_until timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (actor_account_id, facility_id, patient_id)
);

alter table identity.access_requests
  add column authorization_method text,
  add constraint access_requests_authorization_method_ck
    check (authorization_method is null or authorization_method in ('patient_access_pin')),
  add constraint access_requests_pin_scope_ck
    check (authorization_method is distinct from 'patient_access_pin'
      or (scope = 'read_records' and purpose_of_use = 'direct-care' and break_glass = false));

alter table identity.consent_grants
  add column authorization_method text,
  add constraint consent_grants_authorization_method_ck
    check (authorization_method is null or authorization_method in ('patient_access_pin')),
  add constraint consent_grants_pin_scope_ck
    check (authorization_method is distinct from 'patient_access_pin'
      or (scope = 'read_records' and purpose_of_use = 'direct-care' and break_glass = false));

create index consent_grants_patient_pin_active_idx
  on identity.consent_grants (patient_id, status, expires_at desc)
  where authorization_method = 'patient_access_pin';

-- A stable issuer spelling is part of the mapping key. This deliberately
-- returns no email, profile, or provider-subject data to the application.
create function auth.resolve_google_identity(requested_subject text)
returns table(account_id uuid, account_subject text)
language sql stable security definer
set search_path = auth, pg_temp
as $$
  select account_row.id, account_row.subject
  from auth.external_identities identity_row
  join auth.accounts account_row on account_row.id = identity_row.account_id
  where identity_row.issuer = 'https://accounts.google.com'
    and identity_row.subject = requested_subject
    and identity_row.status = 'active'
    and account_row.status = 'active'
    and (account_row.disabled_until is null or account_row.disabled_until <= statement_timestamp())
$$;

-- Patient portal configuration is a server-side operation. It accepts a raw
-- PIN only within this definer command, hashes it with pgcrypto bcrypt cost 12,
-- and emits no raw PIN or hash to audit/output.
create function identity.set_my_patient_access_pin(
  requested_subject text,
  requested_session uuid,
  requested_pin text
)
returns uuid
language plpgsql security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
  normalized_pin text := regexp_replace(coalesce(requested_pin, ''), E'\\s+', '', 'g');
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  -- Serialize PIN replacement/revocation with staff verification so a grant
  -- cannot be created from an old PIN after this command has revoked it.
  perform pg_advisory_xact_lock(hashtextextended(
    'patient-access-pin:' || patient_id_value::text, 0
  ));
  if normalized_pin !~ '^[0-9]{4,8}$' then
    raise exception using errcode = '22023', message = 'Invalid patient access PIN';
  end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;

  -- Replacing a PIN invalidates all active grants that were justified by the
  -- old PIN. Other authorization paths remain untouched.
  update identity.consent_grants as grant_row
     set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = account_id_value,
         revoked_reason = 'Patient access PIN was changed', updated_at = clock_timestamp(),
         row_version = row_version + 1
   where grant_row.patient_id = patient_id_value
     and grant_row.authorization_method = 'patient_access_pin'
     and grant_row.status = 'active';

  insert into identity.patient_access_pins (
    patient_id, pin_hash, status, hash_algorithm, disabled_at, disabled_reason,
    source_system, source_record_id, source_created_at, source_updated_at,
    created_at, updated_at, row_version
  ) values (
    patient_id_value, public.crypt(normalized_pin, public.gen_salt('bf', 12)), 'active', 'bcrypt',
    null, null, 'hid-patient-self', null, null, null,
    clock_timestamp(), clock_timestamp(), 1
  ) on conflict (patient_id) do update
    set pin_hash = excluded.pin_hash, status = 'active', hash_algorithm = 'bcrypt',
        disabled_at = null, disabled_reason = null, source_system = 'hid-patient-self',
        source_record_id = null, source_created_at = null, source_updated_at = null,
        updated_at = clock_timestamp(),
        row_version = identity.patient_access_pins.row_version + 1;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient-access-pin.set', 'success', 'patient-access-pin', patient_id_value::text,
    'patient-self', 'application', 'identity-api', jsonb_build_object('bcryptCost', 12)
  );
  return patient_id_value;
end;
$$;

create function identity.revoke_my_patient_access_pin(
  requested_subject text,
  requested_session uuid
)
returns uuid
language plpgsql security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  -- Keep revocation ordered with staff verification for this patient PIN.
  perform pg_advisory_xact_lock(hashtextextended(
    'patient-access-pin:' || patient_id_value::text, 0
  ));
  select account_id into account_id_value from identity.patients where id = patient_id_value;

  update identity.patient_access_pins as pin_row
     set status = 'revoked', disabled_at = clock_timestamp(),
         disabled_reason = 'Revoked by the patient', updated_at = clock_timestamp(),
         row_version = row_version + 1
   where pin_row.patient_id = patient_id_value and pin_row.status <> 'revoked';

  update identity.consent_grants as grant_row
     set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = account_id_value,
         revoked_reason = 'Patient access PIN was revoked', updated_at = clock_timestamp(),
         row_version = row_version + 1
   where grant_row.patient_id = patient_id_value
     and grant_row.authorization_method = 'patient_access_pin'
     and grant_row.status = 'active';

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient-access-pin.revoke', 'success', 'patient-access-pin', patient_id_value::text,
    'patient-self', 'application', 'identity-api', '{}'::jsonb
  );
  return patient_id_value;
end;
$$;

-- A valid PIN is necessary but not sufficient: exact staff membership,
-- purpose, capability, active patient state, and current deny directives are
-- all rechecked before any grant is created. Denials are returned as a simple
-- false result so their rate-limit and audit evidence commits atomically.
create function identity.access_patient_with_pin(
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
  if requested_duration_minutes is null or requested_duration_minutes not between 5 and 60 then
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
  -- downstream authorization check before materializing the narrow grant.
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
       and (cardinality(directive_version.actions) = 0 or 'read_records' = any(directive_version.actions))
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

  update identity.patient_access_pin_actor_limits as limit_row
     set failure_count = 0, window_started_at = clock_timestamp(), locked_until = null, updated_at = clock_timestamp()
   where limit_row.actor_account_id = actor_account_id_value
     and limit_row.facility_id = actor_facility_id;
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
     and grant_row.scope = 'read_records'
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
    grant_expires_at := current_timestamp + make_interval(mins => requested_duration_minutes);
    insert into identity.access_requests (
      id, patient_id, staff_id, membership_id, facility_id, scope, purpose_of_use,
      reason, status, requested_duration_minutes, break_glass, approved_at,
      correlation_id, authorization_method
    ) values (
      request_id_value, patient_id_value, actor_staff_id, actor_membership_id,
      actor_facility_id, 'read_records', 'direct-care', 'Patient access PIN verification',
      'approved', requested_duration_minutes, false, current_timestamp, actor_correlation_id,
      'patient_access_pin'
    );
    insert into identity.consent_grants (
      id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
      scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass,
      correlation_id, authorization_method
    ) values (
      grant_id_value, request_id_value, patient_id_value, actor_staff_id, actor_account_id_value,
      actor_membership_id, actor_facility_id, 'read_records', 'direct-care', 'active',
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
    jsonb_build_object('access_request_id', request_id_value, 'duration_minutes', requested_duration_minutes,
      'expires_at', grant_expires_at, 'existing_grant', replayed, 'review_required', true)
  );
  if not replayed then
    insert into identity.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id, patient_id, correlation_id, payload
    ) values (
      'PatientAccessPinVerified', grant_id_value, 1, actor_facility_id, patient_id_value,
      actor_correlation_id, jsonb_build_object('consentGrantId', grant_id_value, 'reviewRequired', true)
    );
  end if;
  return query select true, request_id_value, grant_id_value, patient_id_value,
    'active'::text, grant_expires_at, replayed;
end;
$$;

-- Reuse the established minimum-necessary consent event envelope. The new
-- generated reference prevents an arbitrary aggregate being smuggled in.
alter table identity.outbox_events drop constraint outbox_events_event_type_check;
alter table identity.outbox_events add constraint outbox_events_event_type_check
  check (event_type in (
    'PatientRegistered', 'PatientIdentifierAdded', 'PatientIdentityResolved',
    'EmergencyAccessActivated', 'PatientAccessPinVerified'
  ));
-- 0031 treated every non-emergency event as a registration case. Narrow that
-- generated relation before introducing the second consent-grant event type.
alter table identity.outbox_events drop column registration_case_id;
alter table identity.outbox_events
  add column registration_case_id uuid generated always as
    (case when event_type not in ('EmergencyAccessActivated', 'PatientAccessPinVerified')
      then aggregate_id end) stored
    references identity.registration_cases(id) on delete restrict;
alter table identity.outbox_events
  add column patient_access_pin_grant_id uuid generated always as
    (case when event_type = 'PatientAccessPinVerified' then aggregate_id end) stored
    references identity.consent_grants(id) on delete restrict;
alter table identity.outbox_events drop constraint emergency_outbox_minimum_necessary;
alter table identity.outbox_events add constraint identity_outbox_minimum_necessary
  check (
    (event_type <> 'EmergencyAccessActivated' or (
      aggregate_version = 1
      and payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true)
    ))
    and (event_type <> 'PatientAccessPinVerified' or (
      aggregate_version = 1
      and payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true)
    ))
  );
create policy identity_outbox_patient_access_pin_insert on identity.outbox_events for insert
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
         and grant_row.scope = 'read_records'
         and grant_row.purpose_of_use = 'direct-care'
    )
  );

create or replace view integration.outbox_envelopes
with (security_invoker = true)
as
select
  'identity'::text as producer,
  event_id,
  event_type,
  1::integer as event_version,
  created_at as occurred_at,
  case when event_type in ('EmergencyAccessActivated', 'PatientAccessPinVerified')
    then 'identity-consent-grant' else 'identity-registration-case' end::text as aggregate_type,
  aggregate_id,
  aggregate_version,
  correlation_id,
  null::uuid as causation_id,
  facility_id,
  patient_id,
  payload,
  published_at as source_published_at,
  attempt_count as source_attempt_count,
  next_attempt_at as source_next_attempt_at,
  last_error_code as source_last_error_code
from identity.outbox_events
union all
select
  'ocr'::text, id, event_type, event_version, occurred_at, 'ocr-job'::text,
  aggregate_id, aggregate_version, correlation_id, null::uuid, facility_id, null::uuid,
  payload, published_at, attempt_count, next_attempt_at, null::text
from ocr.outbox_events
union all
select
  'lab'::text, id, event_type, event_version, occurred_at,
  case
    when event_type like 'LabImportedEvidence%' then 'lab-imported-evidence'
    when event_type = 'LabWorkItemCreated' then 'lab-work-item'
    when event_type = 'LabAccessionCreated' then 'lab-accession'
    when event_type like 'LabSpecimen%' then 'lab-specimen'
    when event_type like 'LabTestExecution%' then 'lab-test-execution'
    else 'lab-result'
  end,
  aggregate_id, aggregate_version, correlation_id, null::uuid, facility_id, patient_id,
  payload, published_at, attempt_count, next_attempt_at, null::text
from lab.outbox_events
union all
select
  'pharmacy'::text, id, event_type, event_version, occurred_at, aggregate_type,
  aggregate_id, aggregate_version, correlation_id, null::uuid, facility_id, patient_id,
  payload, published_at, attempt_count, next_attempt_at, null::text
from pharmacy.outbox_events
union all
select
  'outreach'::text, event_id, event_type, 1::integer, created_at,
  'outreach-registration-case'::text, aggregate_id, aggregate_version, correlation_id,
  null::uuid, facility_id, patient_id, payload, published_at, attempt_count,
  next_attempt_at, last_error_code
from outreach.outbox_events;

-- Unsupported outreach activity is retained as immutable evidence, not mapped
-- into registration cases or EHR encounters. The raw payload remains only in
-- the existing restricted source-row ledger; this hold stores its integrity
-- proof and relationship-safe source coordinates.
create table migration.cutover_preservation_holds (
  run_id uuid not null,
  entity_type text not null check (entity_type in (
    'outreach_campaigns', 'outreach_workers', 'outreach_encounters',
    'outreach_sync_queue', 'outreach_referrals', 'outreach_vaccinations',
    'outreach_mobile_lab_samples', 'outreach_invites'
  )),
  source_pk text not null,
  source_status text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  payload_sha256 char(64) not null,
  disposition text not null default 'preserved_unmapped'
    check (disposition = 'preserved_unmapped'),
  reason text not null default 'AWS has no approved campaign or queued-encounter replacement'
    check (length(btrim(reason)) between 8 and 500),
  created_at timestamptz not null default clock_timestamp(),
  primary key (run_id, entity_type, source_pk),
  foreign key (run_id, entity_type, source_pk)
    references migration.source_rows(run_id, entity_type, source_pk) on delete restrict
);
create trigger cutover_preservation_holds_no_mutation
  before update or delete on migration.cutover_preservation_holds
  for each row execute function platform.reject_mutation();

-- The restricted source ledger is evidence, not an editable work queue.
-- Promotion is its only permitted state transition: a row can be marked once
-- as promoted, while the source coordinate, payload, and checksum remain
-- immutable. A corrected source extract must use a new migration run.
create function migration.guard_source_row_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.run_id is distinct from old.run_id
     or new.entity_type is distinct from old.entity_type
     or new.source_pk is distinct from old.source_pk
     or new.payload is distinct from old.payload
     or new.payload_sha256 is distinct from old.payload_sha256
     or new.source_updated_at is distinct from old.source_updated_at
     or new.staged_at is distinct from old.staged_at
     or (old.promoted_at is not null and new.promoted_at is distinct from old.promoted_at)
     or (old.promoted_at is null and new.promoted_at is null) then
    raise exception using errcode = '55000', message = 'migration.source_rows is append-only';
  end if;
  return new;
end;
$$;
create trigger source_rows_promoted_at_only
  before update on migration.source_rows
  for each row execute function migration.guard_source_row_mutation();
create trigger source_rows_no_delete
  before delete on migration.source_rows
  for each row execute function platform.reject_mutation();

-- A legacy-identity ledger is sealed to the repeatable-read snapshot that
-- created it. Source rows may be inserted only while that staging run is
-- running; after it is marked staged, promotion may update `promoted_at` but
-- cannot append a newer source row to the same snapshot evidence.
create function migration.guard_legacy_identity_source_row_insert()
returns trigger
language plpgsql
set search_path = migration, pg_temp
as $$
declare
  run_source_system text;
  run_status text;
  run_mode text;
begin
  select source_system, status, mode
    into run_source_system, run_status, run_mode
    from migration.runs
   where id = new.run_id
   for share;
  if run_source_system = 'legacy_identity'
     and (run_status is distinct from 'running' or run_mode is distinct from 'stage') then
    raise exception using errcode = '55000',
      message = 'legacy identity source rows may be inserted only during their original staging run';
  end if;
  return new;
end;
$$;
create trigger source_rows_legacy_identity_stage_only
  before insert on migration.source_rows
  for each row execute function migration.guard_legacy_identity_source_row_insert();

-- Preserve the source snapshot evidence once the initial stage operation has
-- finished. Other migration systems share these tables, so this guard scopes
-- the stricter transition rule to the Supabase/AWS legacy-identity run.
create function migration.guard_legacy_identity_run_mutation()
returns trigger
language plpgsql
set search_path = migration, pg_temp
as $$
begin
  if old.source_system is distinct from 'legacy_identity' then
    return new;
  end if;
  if new.source_system is distinct from old.source_system
     or new.source_snapshot is distinct from old.source_snapshot
     or new.source_transaction_snapshot is distinct from old.source_transaction_snapshot then
    raise exception using errcode = '55000', message = 'legacy identity source snapshot evidence is immutable';
  end if;
  if old.status is distinct from 'running' and new.status = 'running' then
    raise exception using errcode = '55000',
      message = 'a legacy identity staging run cannot be resumed from a later source transaction';
  end if;
  if new.source_counts is distinct from old.source_counts
     or new.source_checksum_sha256 is distinct from old.source_checksum_sha256 then
    if old.status is distinct from 'running'
       or new.status is distinct from 'staged'
       or old.mode is distinct from 'stage'
       or new.mode is distinct from 'stage' then
      raise exception using errcode = '55000',
        message = 'legacy identity source count and checksum evidence may be sealed only once';
    end if;
  end if;
  return new;
end;
$$;
create trigger runs_legacy_identity_source_evidence_immutable
  before update on migration.runs
  for each row execute function migration.guard_legacy_identity_run_mutation();

revoke all on identity.patient_access_pins,
  identity.patient_access_pin_attempts,
  identity.patient_access_pin_actor_limits,
  identity.patient_access_pin_target_limits,
  migration.cutover_preservation_holds from public;
revoke all on all sequences in schema identity from public;
revoke all on function auth.resolve_google_identity(text) from public;
revoke all on function identity.set_my_patient_access_pin(text, uuid, text) from public;
revoke all on function identity.revoke_my_patient_access_pin(text, uuid) from public;
revoke all on function identity.access_patient_with_pin(text, text, integer) from public;
revoke all on function migration.guard_source_row_mutation() from public;

comment on table identity.patient_access_pins is
  'bcrypt access-PIN hashes only. Imported Supabase hashes are retained byte-for-byte until a patient changes the PIN.';
comment on table migration.cutover_preservation_holds is
  'Immutable evidence that unsupported Supabase outreach rows were retained without operational reinterpretation.';
