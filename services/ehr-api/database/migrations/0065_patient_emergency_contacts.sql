-- Phase 3: verified patient emergency contacts and minimum-necessary
-- emergency-contact notification intents.
--
-- Contact names and destinations are encrypted by Identity with the existing
-- application AES-256-GCM pattern; the database stores ciphertext, a key
-- version, and a keyed destination HMAC used only for duplicate detection and
-- verification binding. A contact is an emergency recipient only after the
-- contact completes code verification and while the patient's notification
-- preference is enabled. The legacy `identity.patients.emergency_contact_*`
-- columns are not read or modified.
--
-- Break-glass authorization is unchanged. A trigger on the existing
-- `EmergencyAccessActivated` outbox row creates delivery intents; any failure
-- there is audited and never fails the emergency authorization.

create table identity.patient_emergency_contacts (
  id uuid primary key,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  created_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  relationship text not null check (relationship in (
    'spouse', 'partner', 'parent', 'child', 'sibling', 'relative',
    'guardian', 'caregiver', 'friend', 'other'
  )),
  channel text not null check (channel in ('email', 'sms')),
  contact_ciphertext bytea not null check (octet_length(contact_ciphertext) between 30 and 2048),
  contact_key_version text not null check (length(contact_key_version) between 1 and 64),
  destination_hmac char(64) not null check (destination_hmac ~ '^[0-9a-f]{64}$'),
  notify_on_emergency_access boolean not null default true,
  status text not null default 'unverified' check (status in ('unverified', 'verified', 'deactivated')),
  verified_at timestamptz,
  deactivated_at timestamptz,
  deactivation_reason text check (deactivation_reason is null or deactivation_reason in (
    'patient_removed', 'patient_replaced'
  )),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  check (status <> 'verified' or verified_at is not null),
  check ((status = 'deactivated') = (deactivated_at is not null)),
  check ((deactivated_at is null) = (deactivation_reason is null))
);
create unique index patient_emergency_contacts_destination_uq
  on identity.patient_emergency_contacts (patient_id, destination_hmac)
  where status <> 'deactivated';
create index patient_emergency_contacts_eligible_idx
  on identity.patient_emergency_contacts (patient_id)
  where status = 'verified' and notify_on_emergency_access;
create trigger patient_emergency_contacts_no_delete
  before delete on identity.patient_emergency_contacts
  for each row execute function platform.reject_mutation();

-- Verification challenges mirror the OTP verifier convention: only a
-- challenge-bound HMAC of the code is stored and each challenge is single use.
create table identity.emergency_contact_verifications (
  id uuid primary key,
  contact_id uuid not null references identity.patient_emergency_contacts(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  verifier_hmac char(64) not null check (verifier_hmac ~ '^[0-9a-f]{64}$'),
  verifier_key_version text not null check (length(verifier_key_version) between 1 and 64),
  expires_at timestamptz not null,
  max_attempts smallint not null check (max_attempts between 1 and 10),
  failed_attempts smallint not null default 0 check (failed_attempts between 0 and max_attempts),
  delivery_outcome text not null default 'pending' check (
    delivery_outcome in ('pending', 'accepted', 'definitive_failure', 'unknown')
  ),
  delivery_provider text check (delivery_provider is null or delivery_provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  verified_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text check (invalidation_reason is null or invalidation_reason in (
    'resend', 'expired', 'attempts_exhausted', 'delivery_failed', 'contact_deactivated'
  )),
  created_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  check (expires_at > created_at),
  check (not (verified_at is not null and invalidated_at is not null)),
  check ((invalidated_at is null) = (invalidation_reason is null))
);
create unique index emergency_contact_verifications_active_uq
  on identity.emergency_contact_verifications (contact_id)
  where verified_at is null and invalidated_at is null;
create index emergency_contact_verifications_patient_idx
  on identity.emergency_contact_verifications (patient_id, created_at desc);
create trigger emergency_contact_verifications_no_delete
  before delete on identity.emergency_contact_verifications
  for each row execute function platform.reject_mutation();

-- One intent per break-glass grant and contact is the idempotency boundary.
create table identity.emergency_contact_notifications (
  id uuid primary key default gen_random_uuid(),
  consent_grant_id uuid not null references identity.consent_grants(id) on delete restrict,
  contact_id uuid not null references identity.patient_emergency_contacts(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid references identity.facilities(id) on delete restrict,
  channel text not null check (channel in ('email', 'sms')),
  occurred_at timestamptz not null,
  status text not null default 'pending' check (status in (
    'pending', 'delivered', 'failed', 'expired', 'suppressed'
  )),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 8),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_owner text check (lease_owner is null or lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  lease_expires_at timestamptz,
  deliver_before timestamptz not null,
  last_outcome text check (last_outcome is null or last_outcome in ('accepted', 'definitive_failure', 'unknown')),
  last_safe_code text check (last_safe_code is null or last_safe_code ~ '^[A-Za-z0-9_]{1,80}$'),
  provider text check (provider is null or provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  delivered_at timestamptz,
  closed_reason text check (closed_reason is null or closed_reason in (
    'delivered', 'definitive_failure', 'attempts_exhausted', 'delivery_window_elapsed',
    'contact_ineligible'
  )),
  correlation_id text not null check (
    length(correlation_id) between 8 and 128
    and correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  unique (consent_grant_id, contact_id),
  check (deliver_before > occurred_at),
  check ((status = 'delivered') = (delivered_at is not null)),
  check ((status = 'pending') = (closed_reason is null)),
  check ((lease_owner is null) = (lease_expires_at is null))
);
create index emergency_contact_notifications_due_idx
  on identity.emergency_contact_notifications (next_attempt_at)
  where status = 'pending';
create index emergency_contact_notifications_contact_idx
  on identity.emergency_contact_notifications (contact_id, created_at desc);
create trigger emergency_contact_notifications_no_delete
  before delete on identity.emergency_contact_notifications
  for each row execute function platform.reject_mutation();

revoke all on identity.patient_emergency_contacts, identity.emergency_contact_verifications,
  identity.emergency_contact_notifications from public;

-- System audit rows for asynchronous emergency-contact delivery.
create function identity.audit_emergency_contact_event(
  requested_action text,
  requested_outcome text,
  requested_patient uuid,
  requested_facility uuid,
  requested_resource_type text,
  requested_resource_id uuid,
  requested_details jsonb
) returns void
language sql security definer
set search_path = pg_catalog, audit, platform, pg_temp as $$
  insert into audit.events (
    correlation_id, actor_type, patient_id, facility_id, action, outcome,
    resource_type, resource_id, purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system', requested_patient, requested_facility,
    requested_action, requested_outcome, requested_resource_type, requested_resource_id::text,
    'emergency', 'system', 'identity-api', coalesce(requested_details, '{}'::jsonb)
  )
$$;
revoke all on function identity.audit_emergency_contact_event(text, text, uuid, uuid, text, uuid, jsonb) from public;

create function identity.on_emergency_access_contact_notification()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp as $$
declare
  grant_row identity.consent_grants%rowtype;
  contact_row identity.patient_emergency_contacts%rowtype;
  intent_id uuid;
  created_count integer := 0;
begin
  if new.event_type <> 'EmergencyAccessActivated' then return new; end if;
  -- Emergency-contact notification must never invalidate the emergency
  -- authorization that has already been granted and audited.
  begin
    select * into grant_row from identity.consent_grants where id = new.aggregate_id;
    if not found or grant_row.break_glass is not true then return new; end if;
    for contact_row in
      select * from identity.patient_emergency_contacts contact
       where contact.patient_id = new.patient_id
         and contact.status = 'verified'
         and contact.notify_on_emergency_access
       order by contact.created_at, contact.id
    loop
      insert into identity.emergency_contact_notifications (
        consent_grant_id, contact_id, patient_id, facility_id, channel,
        occurred_at, deliver_before, correlation_id
      ) values (
        grant_row.id, contact_row.id, new.patient_id, grant_row.facility_id, contact_row.channel,
        grant_row.starts_at, grant_row.starts_at + interval '24 hours', new.correlation_id
      ) on conflict (consent_grant_id, contact_id) do nothing
      returning id into intent_id;
      if intent_id is not null then
        created_count := created_count + 1;
        perform identity.audit_emergency_contact_event(
          'identity.emergency-contact.notification.intent-created', 'success', new.patient_id,
          grant_row.facility_id, 'emergency-contact-notification', intent_id,
          jsonb_build_object('consentGrantId', grant_row.id, 'contactId', contact_row.id,
            'channel', contact_row.channel));
      end if;
    end loop;
    if created_count = 0 then
      perform identity.audit_emergency_contact_event(
        'identity.emergency-contact.notification.no-eligible-contact', 'success', new.patient_id,
        grant_row.facility_id, 'consent-grant', grant_row.id, '{}'::jsonb);
    end if;
  exception when others then
    perform identity.audit_emergency_contact_event(
      'identity.emergency-contact.notification.intent-failed', 'failure', new.patient_id,
      new.facility_id, 'consent-grant', new.aggregate_id,
      jsonb_build_object('sqlstate', sqlstate));
  end;
  return new;
end
$$;
revoke all on function identity.on_emergency_access_contact_notification() from public;
create trigger emergency_contact_notification_intent
  after insert on identity.outbox_events
  for each row execute function identity.on_emergency_access_contact_notification();

create function identity.list_my_emergency_contacts(requested_subject text, requested_session uuid)
returns table(
  contact_id uuid, relationship text, channel text, contact_ciphertext bytea,
  contact_key_version text, notify_on_emergency_access boolean, status text,
  verified_at timestamptz, created_at timestamptz, row_version bigint,
  verification_expires_at timestamptz, verification_delivery_outcome text,
  last_notification_status text, last_notification_at timestamptz
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, pg_temp as $$
#variable_conflict use_column
declare
  patient_id_value uuid;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  return query
  select contact.id, contact.relationship, contact.channel, contact.contact_ciphertext,
    contact.contact_key_version, contact.notify_on_emergency_access, contact.status,
    contact.verified_at, contact.created_at, contact.row_version,
    challenge.expires_at, challenge.delivery_outcome,
    case when last_notice.status = 'pending' and last_notice.deliver_before <= statement_timestamp()
      then 'expired' else last_notice.status end,
    last_notice.created_at
  from identity.patient_emergency_contacts contact
  left join lateral (
    select verification.expires_at, verification.delivery_outcome
      from identity.emergency_contact_verifications verification
     where verification.contact_id = contact.id
       and verification.verified_at is null and verification.invalidated_at is null
       and verification.expires_at > statement_timestamp()
     order by verification.created_at desc limit 1
  ) challenge on true
  left join lateral (
    select notice.status, notice.deliver_before, notice.created_at
      from identity.emergency_contact_notifications notice
     where notice.contact_id = contact.id
     order by notice.created_at desc limit 1
  ) last_notice on true
  where contact.patient_id = patient_id_value and contact.status <> 'deactivated'
  order by contact.created_at, contact.id;
end
$$;

create function identity.add_my_emergency_contact(
  requested_subject text,
  requested_session uuid,
  requested_contact_id uuid,
  requested_relationship text,
  requested_channel text,
  requested_ciphertext bytea,
  requested_key_version text,
  requested_destination_hmac text,
  requested_notify boolean
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('patient-emergency-contacts:' || patient_id_value::text, 0));
  if (select count(*) from identity.patient_emergency_contacts contact
       where contact.patient_id = patient_id_value and contact.status <> 'deactivated') >= 5 then
    raise exception using errcode = 'P0001', message = 'EMERGENCY_CONTACT_LIMIT_REACHED';
  end if;
  insert into identity.patient_emergency_contacts (
    id, patient_id, created_by_account_id, relationship, channel, contact_ciphertext,
    contact_key_version, destination_hmac, notify_on_emergency_access
  ) values (
    requested_contact_id, patient_id_value, account_id_value, requested_relationship, requested_channel,
    requested_ciphertext, requested_key_version, requested_destination_hmac, coalesce(requested_notify, true)
  );
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.emergency-contact.created', 'success', 'emergency-contact', requested_contact_id::text,
    'patient-self', 'application', 'identity-api',
    jsonb_build_object('relationship', requested_relationship, 'channel', requested_channel,
      'notifyOnEmergencyAccess', coalesce(requested_notify, true))
  );
  return requested_contact_id;
end
$$;

-- The destination is immutable: replacing it requires a new contact and a new
-- verification. Only the display name (re-encrypted with the same destination),
-- relationship, and notification preference change here.
create function identity.update_my_emergency_contact(
  requested_subject text,
  requested_session uuid,
  requested_contact_id uuid,
  requested_expected_version bigint,
  requested_relationship text,
  requested_ciphertext bytea,
  requested_key_version text,
  requested_destination_hmac text,
  requested_notify boolean
) returns bigint
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
  contact_row identity.patient_emergency_contacts%rowtype;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;
  select * into contact_row from identity.patient_emergency_contacts contact
   where contact.id = requested_contact_id and contact.patient_id = patient_id_value
     and contact.status <> 'deactivated'
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'The emergency contact is unavailable';
  end if;
  if contact_row.row_version <> requested_expected_version then
    raise exception using errcode = '40001', message = 'EMERGENCY_CONTACT_VERSION_CONFLICT';
  end if;
  if requested_destination_hmac is distinct from contact_row.destination_hmac then
    raise exception using errcode = '22023', message = 'EMERGENCY_CONTACT_DESTINATION_IMMUTABLE';
  end if;
  update identity.patient_emergency_contacts
     set relationship = requested_relationship, contact_ciphertext = requested_ciphertext,
         contact_key_version = requested_key_version,
         notify_on_emergency_access = coalesce(requested_notify, notify_on_emergency_access),
         updated_at = clock_timestamp(), row_version = row_version + 1
   where id = contact_row.id;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.emergency-contact.changed', 'success', 'emergency-contact', contact_row.id::text,
    'patient-self', 'application', 'identity-api',
    jsonb_build_object('relationshipChanged', requested_relationship is distinct from contact_row.relationship,
      'notifyOnEmergencyAccess', coalesce(requested_notify, contact_row.notify_on_emergency_access),
      'changedFields', array_remove(array[
        case when requested_relationship is distinct from contact_row.relationship then 'relationship' end,
        case when requested_ciphertext is distinct from contact_row.contact_ciphertext then 'name' end,
        case when coalesce(requested_notify, contact_row.notify_on_emergency_access)
          is distinct from contact_row.notify_on_emergency_access then 'notifyOnEmergencyAccess' end
      ], null))
  );
  return contact_row.row_version + 1;
end
$$;

create function identity.deactivate_my_emergency_contact(
  requested_subject text,
  requested_session uuid,
  requested_contact_id uuid
) returns table(contact_id uuid, replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp as $$
#variable_conflict use_column
declare
  patient_id_value uuid;
  account_id_value uuid;
  contact_row identity.patient_emergency_contacts%rowtype;
  suppressed integer;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;
  select * into contact_row from identity.patient_emergency_contacts contact
   where contact.id = requested_contact_id and contact.patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'The emergency contact is unavailable';
  end if;
  if contact_row.status = 'deactivated' then
    return query select contact_row.id, true;
    return;
  end if;
  update identity.patient_emergency_contacts
     set status = 'deactivated', deactivated_at = clock_timestamp(),
         deactivation_reason = 'patient_removed', updated_at = clock_timestamp(),
         row_version = row_version + 1
   where id = contact_row.id;
  update identity.emergency_contact_verifications
     set invalidated_at = clock_timestamp(), invalidation_reason = 'contact_deactivated',
         row_version = row_version + 1
   where emergency_contact_verifications.contact_id = contact_row.id
     and verified_at is null and invalidated_at is null;
  update identity.emergency_contact_notifications
     set status = 'suppressed', closed_reason = 'contact_ineligible', lease_owner = null,
         lease_expires_at = null, updated_at = clock_timestamp(), row_version = row_version + 1
   where emergency_contact_notifications.contact_id = contact_row.id and status = 'pending';
  get diagnostics suppressed = row_count;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.emergency-contact.deactivated', 'success', 'emergency-contact', contact_row.id::text,
    'patient-self', 'application', 'identity-api',
    jsonb_build_object('previousStatus', contact_row.status, 'pendingNotificationsSuppressed', suppressed)
  );
  return query select contact_row.id, false;
end
$$;

-- Returns the encrypted destination so Identity can deliver the code. Rate
-- limits: five challenges per patient per hour and one per contact per minute.
create function identity.start_my_emergency_contact_verification(
  requested_subject text,
  requested_session uuid,
  requested_contact_id uuid,
  requested_challenge_id uuid,
  requested_verifier_hmac text,
  requested_key_version text,
  requested_ttl_seconds integer,
  requested_max_attempts integer
) returns table(
  challenge_id uuid, expires_at timestamptz, channel text,
  contact_ciphertext bytea, contact_key_version text, destination_hmac text
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp as $$
#variable_conflict use_column
declare
  patient_id_value uuid;
  account_id_value uuid;
  contact_row identity.patient_emergency_contacts%rowtype;
  expires_value timestamptz;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_ttl_seconds not between 60 and 600 or requested_max_attempts not between 1 and 10 then
    raise exception using errcode = '22023', message = 'Invalid verification policy';
  end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('patient-emergency-contacts:' || patient_id_value::text, 0));
  select * into contact_row from identity.patient_emergency_contacts contact
   where contact.id = requested_contact_id and contact.patient_id = patient_id_value
   for update;
  if not found or contact_row.status = 'deactivated' then
    raise exception using errcode = 'P0002', message = 'The emergency contact is unavailable';
  end if;
  if contact_row.status = 'verified' then
    raise exception using errcode = '55000', message = 'EMERGENCY_CONTACT_ALREADY_VERIFIED';
  end if;
  if exists (select 1 from identity.emergency_contact_verifications verification
              where verification.contact_id = contact_row.id
                and verification.created_at > clock_timestamp() - interval '60 seconds')
     or (select count(*) from identity.emergency_contact_verifications verification
          where verification.patient_id = patient_id_value
            and verification.created_at > clock_timestamp() - interval '1 hour') >= 5 then
    raise exception using errcode = 'P0001', message = 'EMERGENCY_CONTACT_VERIFICATION_RATE_LIMITED';
  end if;
  update identity.emergency_contact_verifications
     set invalidated_at = clock_timestamp(), invalidation_reason = 'resend', row_version = row_version + 1
   where emergency_contact_verifications.contact_id = contact_row.id
     and verified_at is null and invalidated_at is null;
  expires_value := clock_timestamp() + make_interval(secs => requested_ttl_seconds);
  insert into identity.emergency_contact_verifications (
    id, contact_id, patient_id, account_id, verifier_hmac, verifier_key_version,
    expires_at, max_attempts
  ) values (
    requested_challenge_id, contact_row.id, patient_id_value, account_id_value, requested_verifier_hmac,
    requested_key_version, expires_value, requested_max_attempts
  );
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.emergency-contact.verification-requested', 'success', 'emergency-contact',
    contact_row.id::text, 'patient-self', 'application', 'identity-api',
    jsonb_build_object('challengeId', requested_challenge_id, 'channel', contact_row.channel,
      'expiresAt', expires_value)
  );
  return query select requested_challenge_id, expires_value, contact_row.channel,
    contact_row.contact_ciphertext, contact_row.contact_key_version, contact_row.destination_hmac::text;
end
$$;

create function identity.record_my_emergency_contact_verification_delivery(
  requested_subject text,
  requested_session uuid,
  requested_challenge_id uuid,
  requested_outcome text,
  requested_provider text
) returns void
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
  challenge_row identity.emergency_contact_verifications%rowtype;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_outcome not in ('accepted', 'definitive_failure', 'unknown') then
    raise exception using errcode = '22023', message = 'Invalid delivery outcome';
  end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;
  select * into challenge_row from identity.emergency_contact_verifications verification
   where verification.id = requested_challenge_id and verification.patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'The verification is unavailable';
  end if;
  update identity.emergency_contact_verifications
     set delivery_outcome = requested_outcome, delivery_provider = requested_provider,
         invalidated_at = case when requested_outcome = 'definitive_failure'
           and invalidated_at is null and verified_at is null then clock_timestamp() else invalidated_at end,
         invalidation_reason = case when requested_outcome = 'definitive_failure'
           and invalidated_at is null and verified_at is null then 'delivery_failed' else invalidation_reason end,
         row_version = row_version + 1
   where id = challenge_row.id;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.emergency-contact.verification-sent',
    case requested_outcome when 'accepted' then 'success' when 'unknown' then 'success' else 'failure' end,
    'emergency-contact', challenge_row.contact_id::text, 'patient-self', 'application', 'identity-api',
    jsonb_build_object('challengeId', challenge_row.id, 'deliveryOutcome', requested_outcome,
      'provider', requested_provider)
  );
end
$$;

-- Failed, expired, exhausted, and replayed codes return a non-disclosing
-- outcome so the attempt counter and denial audit commit.
create function identity.complete_my_emergency_contact_verification(
  requested_subject text,
  requested_session uuid,
  requested_contact_id uuid,
  requested_challenge_id uuid,
  requested_verifier_hmac text
) returns text
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
  challenge_row identity.emergency_contact_verifications%rowtype;
  result text;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('patient-emergency-contacts:' || patient_id_value::text, 0));
  select verification.* into challenge_row
    from identity.emergency_contact_verifications verification
    join identity.patient_emergency_contacts contact on contact.id = verification.contact_id
   where verification.id = requested_challenge_id
     and verification.contact_id = requested_contact_id
     and verification.patient_id = patient_id_value
     and contact.patient_id = patient_id_value
     and contact.status = 'unverified'
   for update of verification;

  if not found or challenge_row.verified_at is not null or challenge_row.invalidated_at is not null then
    result := 'invalid';
  elsif challenge_row.expires_at <= clock_timestamp() then
    result := 'expired';
    update identity.emergency_contact_verifications
       set invalidated_at = clock_timestamp(), invalidation_reason = 'expired', row_version = row_version + 1
     where id = challenge_row.id;
  elsif challenge_row.failed_attempts >= challenge_row.max_attempts then
    result := 'invalid';
    update identity.emergency_contact_verifications
       set invalidated_at = clock_timestamp(), invalidation_reason = 'attempts_exhausted',
           row_version = row_version + 1
     where id = challenge_row.id;
  elsif requested_verifier_hmac is distinct from challenge_row.verifier_hmac then
    result := 'invalid';
    update identity.emergency_contact_verifications
       set failed_attempts = failed_attempts + 1,
           invalidated_at = case when failed_attempts + 1 >= max_attempts then clock_timestamp() end,
           invalidation_reason = case when failed_attempts + 1 >= max_attempts then 'attempts_exhausted' end,
           row_version = row_version + 1
     where id = challenge_row.id;
  else
    result := 'verified';
    update identity.emergency_contact_verifications
       set verified_at = clock_timestamp(), row_version = row_version + 1
     where id = challenge_row.id;
    update identity.patient_emergency_contacts
       set status = 'verified', verified_at = clock_timestamp(),
           updated_at = clock_timestamp(), row_version = row_version + 1
     where id = challenge_row.contact_id;
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    case result when 'verified' then 'identity.emergency-contact.verification-succeeded'
      when 'expired' then 'identity.emergency-contact.verification-expired'
      else 'identity.emergency-contact.verification-failed' end,
    case result when 'verified' then 'success' else 'denied' end,
    'emergency-contact', requested_contact_id::text, 'patient-self', 'application', 'identity-api',
    jsonb_build_object('challengeId', requested_challenge_id)
  );
  return result;
end
$$;

-- Asynchronous delivery runs in the Identity system context. Claiming expires
-- intents outside their delivery window and suppresses intents whose contact
-- is no longer verified or consenting; both are audited, never sent.
create function identity.claim_emergency_contact_notifications(
  requested_worker text,
  requested_limit integer,
  requested_lease_seconds integer
) returns table(
  notification_id uuid, contact_id uuid, channel text, contact_ciphertext bytea,
  contact_key_version text, patient_first_name text, facility_name text,
  occurred_at timestamptz, attempt_count smallint
)
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp as $$
#variable_conflict use_column
declare
  notice identity.emergency_contact_notifications%rowtype;
  contact_row identity.patient_emergency_contacts%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'A system notification context is required';
  end if;
  if requested_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     or requested_lease_seconds not between 15 and 600 then
    raise exception using errcode = '22023', message = 'Invalid notification claim';
  end if;
  for notice in
    select * from identity.emergency_contact_notifications candidate
     where candidate.status = 'pending' and candidate.next_attempt_at <= clock_timestamp()
       and (candidate.lease_expires_at is null or candidate.lease_expires_at <= clock_timestamp())
     order by candidate.next_attempt_at, candidate.id
     limit least(greatest(coalesce(requested_limit, 10), 1), 50)
     for update skip locked
  loop
    select * into contact_row from identity.patient_emergency_contacts contact where contact.id = notice.contact_id;
    if notice.deliver_before <= clock_timestamp() then
      update identity.emergency_contact_notifications
         set status = 'expired', closed_reason = 'delivery_window_elapsed', lease_owner = null,
             lease_expires_at = null, updated_at = clock_timestamp(), row_version = row_version + 1
       where id = notice.id;
      perform identity.audit_emergency_contact_event(
        'identity.emergency-contact.notification.failed', 'failure', notice.patient_id, notice.facility_id,
        'emergency-contact-notification', notice.id, jsonb_build_object('reason', 'delivery_window_elapsed'));
    elsif notice.attempt_count >= 8 then
      -- The final attempt's outcome was never recorded and its lease expired.
      -- Close it instead of leasing a ninth attempt, which the attempt bound
      -- rejects and which would otherwise abort every later claim batch.
      update identity.emergency_contact_notifications
         set status = 'failed', closed_reason = 'attempts_exhausted', lease_owner = null,
             lease_expires_at = null, updated_at = clock_timestamp(), row_version = row_version + 1
       where id = notice.id;
      perform identity.audit_emergency_contact_event(
        'identity.emergency-contact.notification.failed', 'failure', notice.patient_id, notice.facility_id,
        'emergency-contact-notification', notice.id,
        jsonb_build_object('reason', 'attempts_exhausted', 'attempt', notice.attempt_count));
    elsif contact_row.status <> 'verified' or not contact_row.notify_on_emergency_access then
      update identity.emergency_contact_notifications
         set status = 'suppressed', closed_reason = 'contact_ineligible', lease_owner = null,
             lease_expires_at = null, updated_at = clock_timestamp(), row_version = row_version + 1
       where id = notice.id;
      perform identity.audit_emergency_contact_event(
        'identity.emergency-contact.notification.suppressed', 'success', notice.patient_id, notice.facility_id,
        'emergency-contact-notification', notice.id, jsonb_build_object('reason', 'contact_ineligible'));
    else
      update identity.emergency_contact_notifications
         set lease_owner = requested_worker,
             lease_expires_at = clock_timestamp() + make_interval(secs => requested_lease_seconds),
             attempt_count = attempt_count + 1, updated_at = clock_timestamp(),
             row_version = row_version + 1
       where id = notice.id;
      return query
      select notice.id, contact_row.id, notice.channel, contact_row.contact_ciphertext,
        contact_row.contact_key_version, patient.first_name, facility.name,
        notice.occurred_at, (notice.attempt_count + 1)::smallint
        from identity.patients patient
        left join identity.facilities facility on facility.id = notice.facility_id
       where patient.id = notice.patient_id;
    end if;
  end loop;
end
$$;

create function identity.record_emergency_contact_notification_outcome(
  requested_notification_id uuid,
  requested_worker text,
  requested_outcome text,
  requested_provider text,
  requested_safe_code text
) returns text
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp as $$
declare
  notice identity.emergency_contact_notifications%rowtype;
  next_status text;
  retry_delay interval;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'A system notification context is required';
  end if;
  if requested_outcome not in ('accepted', 'definitive_failure', 'unknown') then
    raise exception using errcode = '22023', message = 'Invalid delivery outcome';
  end if;
  select * into notice from identity.emergency_contact_notifications
   where id = requested_notification_id and lease_owner = requested_worker and status = 'pending'
   for update;
  if not found then return 'stale_lease'; end if;

  if requested_outcome = 'accepted' then
    next_status := 'delivered';
    update identity.emergency_contact_notifications
       set status = 'delivered', delivered_at = clock_timestamp(), closed_reason = 'delivered',
           last_outcome = 'accepted', provider = requested_provider, last_safe_code = requested_safe_code,
           lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp(),
           row_version = row_version + 1
     where id = notice.id;
    perform identity.audit_emergency_contact_event(
      'identity.emergency-contact.notification.delivered', 'success', notice.patient_id, notice.facility_id,
      'emergency-contact-notification', notice.id,
      jsonb_build_object('channel', notice.channel, 'provider', requested_provider,
        'attempt', notice.attempt_count));
  elsif requested_outcome = 'definitive_failure' or notice.attempt_count >= 8 then
    next_status := 'failed';
    update identity.emergency_contact_notifications
       set status = 'failed',
           closed_reason = case when requested_outcome = 'definitive_failure'
             then 'definitive_failure' else 'attempts_exhausted' end,
           last_outcome = requested_outcome, provider = requested_provider,
           last_safe_code = requested_safe_code, lease_owner = null, lease_expires_at = null,
           updated_at = clock_timestamp(), row_version = row_version + 1
     where id = notice.id;
    perform identity.audit_emergency_contact_event(
      'identity.emergency-contact.notification.failed', 'failure', notice.patient_id, notice.facility_id,
      'emergency-contact-notification', notice.id,
      jsonb_build_object('channel', notice.channel, 'provider', requested_provider,
        'safeCode', requested_safe_code, 'attempt', notice.attempt_count));
  else
    next_status := 'pending';
    retry_delay := make_interval(secs => least(3600, power(2, notice.attempt_count)::integer * 30));
    update identity.emergency_contact_notifications
       set next_attempt_at = clock_timestamp() + retry_delay, last_outcome = 'unknown',
           provider = requested_provider, last_safe_code = requested_safe_code,
           lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp(),
           row_version = row_version + 1
     where id = notice.id;
    perform identity.audit_emergency_contact_event(
      'identity.emergency-contact.notification.retry-scheduled', 'failure', notice.patient_id,
      notice.facility_id, 'emergency-contact-notification', notice.id,
      jsonb_build_object('channel', notice.channel, 'attempt', notice.attempt_count,
        'retryAfterSeconds', extract(epoch from retry_delay)::integer, 'safeCode', requested_safe_code));
  end if;
  return next_status;
end
$$;

revoke all on function identity.list_my_emergency_contacts(text, uuid),
  identity.add_my_emergency_contact(text, uuid, uuid, text, text, bytea, text, text, boolean),
  identity.update_my_emergency_contact(text, uuid, uuid, bigint, text, bytea, text, text, boolean),
  identity.deactivate_my_emergency_contact(text, uuid, uuid),
  identity.start_my_emergency_contact_verification(text, uuid, uuid, uuid, text, text, integer, integer),
  identity.record_my_emergency_contact_verification_delivery(text, uuid, uuid, text, text),
  identity.complete_my_emergency_contact_verification(text, uuid, uuid, uuid, text),
  identity.claim_emergency_contact_notifications(text, integer, integer),
  identity.record_emergency_contact_notification_outcome(uuid, text, text, text, text) from public;

comment on table identity.patient_emergency_contacts is
  'Patient-managed emergency contacts. Encrypted name/destination; only verified, consenting contacts receive minimum-necessary emergency-access alerts.';
comment on table identity.emergency_contact_notifications is
  'Idempotent emergency-contact notification intents created from EmergencyAccessActivated; delivery state only, no message body or recipient address.';
