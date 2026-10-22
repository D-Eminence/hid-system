-- A correct patient access PIN for one patient no longer resets the staff
-- member's PIN failure window. identity.access_patient_with_pin (0033) cleared
-- the actor window (identity.patient_access_pin_actor_limits) on every
-- success, for any patient. A clinician who knew one patient's PIN could
-- guess another patient's PIN four times, enter the known PIN, and repeat
-- without ever reaching the five-failure actor lock, limited only by the
-- per-patient window of each target. A success now clears only the window of
-- the patient it verified; the actor window ends when its 15 minutes run out
-- or locks at five failures, as before. Applied migrations 0001 through 0074
-- are immutable.
--
-- The function is replaced with CREATE OR REPLACE, which keeps its owner and
-- ACL; the signature, SECURITY DEFINER attribute, search_path and result are
-- restated exactly as in 0033, and every other statement is unchanged.

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
