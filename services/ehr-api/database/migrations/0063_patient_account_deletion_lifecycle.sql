-- Phase 3: governed patient login/account deletion.
--
-- Account deletion closes the authentication login bound to a canonical
-- patient. It revokes credentials, sessions, federated links, the patient
-- access PIN, patient-granted sharing, and notification registrations. It does
-- not delete or de-identify the canonical patient, the NIN binding, clinical
-- records, consent evidence, audit/security evidence, or notification history.
-- A patient may exist without a login (DECISIONS.md), so the patient record
-- remains active for clinical continuity and break-glass rules are unchanged.
--
-- DATABASE.md sections 3.5 and 15 gate erasure. The retention model below
-- therefore admits only the `retain` disposition and never schedules purge.

create table platform.record_class_retention_policies (
  record_class text primary key check (record_class in (
    'patient_identity', 'nin_identity_binding', 'clinical_record',
    'consent_and_access_evidence', 'audit_security_record',
    'authentication_account_record', 'notification_record'
  )),
  -- A non-retain disposition is an erasure decision and requires a separately
  -- approved migration; this phase can only represent preservation.
  disposition text not null check (disposition = 'retain'),
  automatic_purge boolean not null default false check (automatic_purge = false),
  basis text not null check (length(btrim(basis)) between 8 and 500),
  approval_reference text check (
    approval_reference is null or length(btrim(approval_reference)) between 3 and 200
  ),
  row_version bigint not null default 1 check (row_version > 0),
  updated_at timestamptz not null default clock_timestamp()
);

insert into platform.record_class_retention_policies (record_class, disposition, automatic_purge, basis)
select record_class, 'retain', false,
  'No approved retention or erasure policy exists; retain without automatic purge (DATABASE.md 3.5 and 15)'
from unnest(array[
  'patient_identity', 'nin_identity_binding', 'clinical_record',
  'consent_and_access_evidence', 'audit_security_record',
  'authentication_account_record', 'notification_record'
]) as record_class;

-- Legal holds are preservation evidence. They can be released but never
-- deleted or rewritten. No runtime role can place or release a hold; the
-- authority and procedure remain a governance decision.
create table platform.legal_holds (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('patient', 'account')),
  subject_id uuid not null,
  reason text not null check (length(btrim(reason)) between 8 and 500),
  reference text check (reference is null or length(btrim(reference)) between 3 and 200),
  placed_by_account_id uuid references auth.accounts(id) on delete restrict,
  placed_at timestamptz not null default clock_timestamp(),
  released_at timestamptz,
  released_by_account_id uuid references auth.accounts(id) on delete restrict,
  release_reason text check (release_reason is null or length(btrim(release_reason)) between 8 and 500),
  check ((released_at is null) = (release_reason is null)),
  check (released_by_account_id is null or released_at is not null),
  check (released_at is null or released_at >= placed_at)
);
create index legal_holds_active_subject_idx
  on platform.legal_holds (subject_type, subject_id) where released_at is null;

create function platform.guard_legal_hold_mutation()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' or old.released_at is not null
     or new.id is distinct from old.id
     or new.subject_type is distinct from old.subject_type
     or new.subject_id is distinct from old.subject_id
     or new.reason is distinct from old.reason
     or new.reference is distinct from old.reference
     or new.placed_by_account_id is distinct from old.placed_by_account_id
     or new.placed_at is distinct from old.placed_at then
    raise exception using errcode = '55000', message = 'LEGAL_HOLD_IMMUTABLE';
  end if;
  return new;
end
$$;
create trigger legal_holds_guarded_mutation
  before update or delete on platform.legal_holds
  for each row execute function platform.guard_legal_hold_mutation();

-- Product configuration, not a legal retention period. The waiting period is a
-- patient cancellation window; zero completes deletion at confirmation.
create table platform.patient_account_deletion_settings (
  singleton boolean primary key default true check (singleton),
  waiting_period interval not null check (
    waiting_period >= interval '0' and waiting_period <= interval '90 days'
  ),
  confirmation_ttl interval not null check (
    confirmation_ttl between interval '1 minute' and interval '30 minutes'
  ),
  max_requests_per_day integer not null check (max_requests_per_day between 1 and 20),
  max_confirmation_attempts smallint not null check (max_confirmation_attempts between 1 and 10),
  reason text not null check (length(btrim(reason)) between 8 and 500),
  row_version bigint not null default 1 check (row_version > 0),
  updated_at timestamptz not null default clock_timestamp()
);
insert into platform.patient_account_deletion_settings (
  singleton, waiting_period, confirmation_ttl, max_requests_per_day,
  max_confirmation_attempts, reason
) values (
  true, interval '14 days', interval '10 minutes', 5, 5,
  'Initial product cancellation window; not a legal retention period'
);

create table identity.patient_account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.accounts(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  requested_session_id uuid not null references auth.sessions(id) on delete restrict,
  state text not null check (state in (
    'awaiting_confirmation', 'pending', 'blocked', 'cancelled',
    'completed', 'expired', 'superseded'
  )),
  -- Only the SHA-256 of the single-use confirmation token is stored.
  confirmation_token_sha256 char(64) not null unique
    check (confirmation_token_sha256 ~ '^[0-9a-f]{64}$'),
  confirmation_expires_at timestamptz not null,
  confirmation_failed_attempts smallint not null default 0
    check (confirmation_failed_attempts between 0 and 10),
  confirmation_consumed_at timestamptz,
  requested_at timestamptz not null default clock_timestamp(),
  confirmed_at timestamptz,
  waiting_period interval check (waiting_period is null or waiting_period >= interval '0'),
  scheduled_for timestamptz,
  blocked_at timestamptz,
  blocked_reason_code text check (blocked_reason_code is null or blocked_reason_code in (
    'LEGAL_HOLD', 'RETENTION_POLICY_UNAVAILABLE', 'WORKFORCE_ACCOUNT'
  )),
  cancelled_at timestamptz,
  closed_at timestamptz,
  completed_at timestamptz,
  retention_decision jsonb not null default '{}'::jsonb check (jsonb_typeof(retention_decision) = 'object'),
  completion_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(completion_summary) = 'object'),
  correlation_id text not null check (
    length(correlation_id) between 8 and 128
    and correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  row_version bigint not null default 1 check (row_version > 0),
  updated_at timestamptz not null default clock_timestamp(),
  check (confirmation_expires_at > requested_at),
  check (state <> 'awaiting_confirmation'
    or (confirmation_consumed_at is null and confirmed_at is null)),
  check (state not in ('pending', 'completed') or (
    confirmed_at is not null and confirmation_consumed_at is not null
    and waiting_period is not null and scheduled_for is not null)),
  check (state <> 'pending' or (completed_at is null and cancelled_at is null)),
  check ((state = 'completed') = (completed_at is not null)),
  check ((state = 'blocked') = (blocked_at is not null and blocked_reason_code is not null)),
  check ((state = 'cancelled') = (cancelled_at is not null)),
  check ((state in ('expired', 'superseded')) = (closed_at is not null))
);
-- At most one open deletion lifecycle per login; concurrent requests serialize
-- on an advisory lock and this index is the final duplicate guard.
create unique index patient_account_deletion_open_uq
  on identity.patient_account_deletion_requests (account_id)
  where state in ('awaiting_confirmation', 'pending');
create index patient_account_deletion_due_idx
  on identity.patient_account_deletion_requests (scheduled_for)
  where state = 'pending';
create index patient_account_deletion_account_idx
  on identity.patient_account_deletion_requests (account_id, requested_at desc);
create trigger patient_account_deletion_requests_no_delete
  before delete on identity.patient_account_deletion_requests
  for each row execute function platform.reject_mutation();
revoke all on platform.record_class_retention_policies, platform.legal_holds,
  platform.patient_account_deletion_settings,
  identity.patient_account_deletion_requests from public;

-- A deleted login is terminal. Administrative transitions, recovery, or
-- credential upgrades must never reactivate it or attach a new password.
create function auth.protect_deleted_account()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if old.status = 'deleted' and (
       new.status is distinct from 'deleted'
       or (new.password_hash is not null and new.password_hash is distinct from old.password_hash)
       or new.token_version < old.token_version
       or new.subject is distinct from old.subject
     ) then
    raise exception using errcode = '55000', message = 'ACCOUNT_DELETED_TERMINAL';
  end if;
  return new;
end
$$;
create trigger accounts_deleted_terminal
  before update on auth.accounts
  for each row execute function auth.protect_deleted_account();

create function identity.patient_account_deletion_due(requested_account uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from identity.patient_account_deletion_requests request_row
     where request_row.account_id = requested_account
       and request_row.state = 'pending'
       and request_row.scheduled_for <= statement_timestamp()
  )
$$;
revoke all on function identity.patient_account_deletion_due(uuid) from public;

-- The login becomes unusable at `scheduled_for`, before finalization runs.
-- Every patient authentication and self-service path resolves through these
-- two functions; their signatures and grants are unchanged.
create or replace function identity.current_patient_account(requested_subject text)
returns table(account_id uuid, subject text, email text, display_name text, patient_id uuid)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select a.id, a.subject, a.email, a.display_name, p.id
  from auth.accounts a join identity.patients p on p.account_id = a.id
  where a.subject = requested_subject and a.status = 'active'
    and (a.disabled_until is null or a.disabled_until <= statement_timestamp())
    and p.status = 'active'
    and not identity.patient_account_deletion_due(a.id)
$$;

create or replace function identity.patient_self_session(requested_subject text, requested_session uuid)
returns uuid language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p.id from auth.accounts a
  join auth.sessions s on s.account_id = a.id
  join identity.patients p on p.account_id = a.id and p.id = s.patient_id
  where a.subject = requested_subject
    and requested_subject = nullif(current_setting('app.actor_subject', true), '')
    and nullif(current_setting('app.correlation_id', true), '') is not null
    and s.id = requested_session and s.session_kind = 'patient'
    and s.revoked_at is null and s.expires_at > statement_timestamp()
    and s.absolute_expires_at > statement_timestamp()
    and s.account_token_version = a.token_version
    and a.status = 'active'
    and (a.disabled_until is null or a.disabled_until <= statement_timestamp())
    and p.status = 'active'
    and not identity.patient_account_deletion_due(a.id)
$$;

-- Retention and legal-hold evaluation records which record classes are
-- preserved. It cannot approve erasure because only `retain` is representable.
create function platform.evaluate_patient_account_deletion(
  requested_account uuid,
  requested_patient uuid
) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, platform, identity, auth, pg_temp as $$
declare
  required_classes constant text[] := array[
    'patient_identity', 'nin_identity_binding', 'clinical_record',
    'consent_and_access_evidence', 'audit_security_record',
    'authentication_account_record', 'notification_record'
  ];
  policies jsonb;
  policy_count integer;
  active_hold boolean;
  workforce boolean;
  reason_code text;
begin
  select coalesce(jsonb_object_agg(policy.record_class, jsonb_build_object(
           'disposition', policy.disposition,
           'automaticPurge', policy.automatic_purge,
           'approvedPolicy', policy.approval_reference is not null)), '{}'::jsonb),
         count(*)
    into policies, policy_count
    from platform.record_class_retention_policies policy
   where policy.record_class = any(required_classes);

  select exists (
    select 1 from platform.legal_holds hold
     where hold.released_at is null
       and ((hold.subject_type = 'patient' and hold.subject_id = requested_patient)
         or (hold.subject_type = 'account' and hold.subject_id = requested_account))
  ) into active_hold;

  select exists (select 1 from identity.staff staff_row where staff_row.account_id = requested_account)
      or exists (select 1 from auth.account_roles assignment
                  where assignment.account_id = requested_account and assignment.revoked_at is null)
    into workforce;

  reason_code := case
    when active_hold then 'LEGAL_HOLD'
    when policy_count <> cardinality(required_classes) then 'RETENTION_POLICY_UNAVAILABLE'
    when workforce then 'WORKFORCE_ACCOUNT'
    else null
  end;

  return jsonb_build_object(
    'allowed', reason_code is null,
    'reasonCode', reason_code,
    'legalHold', active_hold,
    'recordClasses', policies,
    'accountActions', case when reason_code is null then jsonb_build_array(
      'revoke_sessions', 'clear_password_credential', 'revoke_federated_identities',
      'revoke_patient_access_pin', 'revoke_patient_granted_access',
      'expire_pending_access_requests', 'revoke_notification_devices', 'close_login'
    ) else '[]'::jsonb end,
    'evaluatedAt', clock_timestamp()
  );
end
$$;
revoke all on function platform.evaluate_patient_account_deletion(uuid, uuid) from public;

-- Internal completion. Callers are the confirmation command (zero waiting
-- period) and the system finalizer; it is not granted to any runtime role.
create function identity.complete_patient_account_deletion(
  requested_request_id uuid,
  requested_actor_subject text
) returns text
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, notification, platform, pg_temp as $$
declare
  request_row identity.patient_account_deletion_requests%rowtype;
  decision jsonb;
  correlation text := platform.current_correlation_id();
  actor_type_value text := case when requested_actor_subject is null then 'system' else 'patient' end;
  actor_account uuid;
  sessions_revoked integer := 0;
  identities_revoked integer := 0;
  pins_revoked integer := 0;
  grants_revoked integer := 0;
  requests_expired integer := 0;
  devices_revoked integer := 0;
  summary jsonb;
begin
  if correlation is null then
    raise exception using errcode = '42501', message = 'A correlated lifecycle context is required';
  end if;
  select * into request_row from identity.patient_account_deletion_requests
   where id = requested_request_id for update;
  if not found then return 'not_found'; end if;
  if request_row.state <> 'pending' then return 'not_pending'; end if;
  if request_row.scheduled_for > clock_timestamp() then return 'not_due'; end if;
  actor_account := case when actor_type_value = 'patient' then request_row.account_id else null end;

  perform 1 from auth.accounts where id = request_row.account_id for update;

  -- A hold may be placed during the waiting period; recheck before closing.
  decision := platform.evaluate_patient_account_deletion(request_row.account_id, request_row.patient_id);
  if not (decision->>'allowed')::boolean then
    update identity.patient_account_deletion_requests
       set state = 'blocked', blocked_at = clock_timestamp(),
           blocked_reason_code = decision->>'reasonCode', retention_decision = decision,
           updated_at = clock_timestamp(), row_version = row_version + 1
     where id = request_row.id;
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
      action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details
    ) values (
      correlation, actor_type_value, requested_actor_subject, actor_account, request_row.patient_id,
      'identity.patient-account-deletion.blocked', 'denied', 'patient-account-deletion',
      request_row.id::text, 'patient-self', 'application', 'identity-api',
      jsonb_build_object('reasonCode', decision->>'reasonCode', 'stage', 'finalization')
    );
    return 'blocked';
  end if;

  with revoked as (
    update auth.sessions as session_row
       set revoked_at = clock_timestamp(), revocation_reason = 'patient_account_deleted',
           row_version = session_row.row_version + 1
     where session_row.account_id = request_row.account_id and session_row.revoked_at is null
    returning session_row.id
  ), events as (
    insert into auth.session_events (session_id, account_id, event_type, outcome, correlation_id, details)
    select revoked.id, request_row.account_id, 'revoked', 'success', correlation,
      jsonb_build_object('reason', 'patient_account_deleted')
      from revoked
    returning 1
  )
  select count(*) into sessions_revoked from events;

  update auth.external_identities as identity_row
     set status = 'revoked', revoked_at = coalesce(identity_row.revoked_at, clock_timestamp())
   where identity_row.account_id = request_row.account_id and identity_row.status <> 'revoked';
  get diagnostics identities_revoked = row_count;

  -- Serialize with staff PIN verification exactly as PIN revocation does.
  perform pg_advisory_xact_lock(hashtextextended('patient-access-pin:' || request_row.patient_id::text, 0));
  update identity.patient_access_pins as pin_row
     set status = 'revoked', disabled_at = clock_timestamp(),
         disabled_reason = 'The patient login was deleted', updated_at = clock_timestamp(),
         row_version = pin_row.row_version + 1
   where pin_row.patient_id = request_row.patient_id and pin_row.status <> 'revoked';
  get diagnostics pins_revoked = row_count;

  -- Only access the patient granted is closed. Break-glass grants and any
  -- workforce authorization that does not depend on the patient are untouched.
  update identity.consent_grants as grant_row
     set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = request_row.account_id,
         revoked_reason = 'The patient login was deleted', updated_at = clock_timestamp(),
         row_version = grant_row.row_version + 1
   where grant_row.patient_id = request_row.patient_id
     and grant_row.status = 'active'
     and grant_row.break_glass = false
     and (grant_row.granted_by_patient_id = request_row.patient_id
       or grant_row.authorization_method = 'patient_access_pin');
  get diagnostics grants_revoked = row_count;

  update identity.access_requests as access_row
     set status = 'expired', updated_at = clock_timestamp(), row_version = access_row.row_version + 1
   where access_row.patient_id = request_row.patient_id
     and access_row.status = 'pending' and access_row.break_glass = false;
  get diagnostics requests_expired = row_count;

  update notification.device_registrations as device_row
     set status = 'revoked', revoked_at = clock_timestamp(),
         revocation_reason_code = 'PATIENT_ACCOUNT_DELETED', updated_at = clock_timestamp(),
         row_version = device_row.row_version + 1
   where device_row.account_id = request_row.account_id and device_row.status = 'active';
  get diagnostics devices_revoked = row_count;

  update auth.accounts as account_row
     set status = 'deleted', password_hash = null, password_algorithm = null,
         password_changed_at = clock_timestamp(), disabled_until = null,
         token_version = account_row.token_version + 1,
         row_version = account_row.row_version + 1, updated_at = clock_timestamp()
   where account_row.id = request_row.account_id;

  summary := jsonb_build_object(
    'sessionsRevoked', sessions_revoked, 'federatedIdentitiesRevoked', identities_revoked,
    'accessPinRevoked', pins_revoked > 0, 'patientGrantsRevoked', grants_revoked,
    'pendingAccessRequestsExpired', requests_expired, 'notificationDevicesRevoked', devices_revoked,
    'patientIdentityRetained', true, 'clinicalRecordsRetained', true, 'auditRecordsRetained', true
  );
  update identity.patient_account_deletion_requests
     set state = 'completed', completed_at = clock_timestamp(), retention_decision = decision,
         completion_summary = summary, updated_at = clock_timestamp(), row_version = row_version + 1
   where id = request_row.id;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values
    (correlation, actor_type_value, requested_actor_subject, actor_account, request_row.patient_id,
     'identity.patient-account-deletion.sessions-revoked', 'success', 'patient-account-deletion',
     request_row.id::text, 'patient-self', 'application', 'identity-api',
     jsonb_build_object('sessionsRevoked', sessions_revoked,
       'federatedIdentitiesRevoked', identities_revoked, 'accessPinRevoked', pins_revoked > 0)),
    (correlation, actor_type_value, requested_actor_subject, actor_account, request_row.patient_id,
     'identity.patient-account-deletion.access-revoked', 'success', 'patient-account-deletion',
     request_row.id::text, 'patient-self', 'application', 'identity-api',
     jsonb_build_object('patientGrantsRevoked', grants_revoked,
       'pendingAccessRequestsExpired', requests_expired, 'notificationDevicesRevoked', devices_revoked,
       'breakGlassUnchanged', true)),
    (correlation, actor_type_value, requested_actor_subject, actor_account, request_row.patient_id,
     'identity.patient-account-deletion.completed', 'success', 'patient-account-deletion',
     request_row.id::text, 'patient-self', 'application', 'identity-api',
     jsonb_build_object('summary', summary, 'recordClasses', decision->'recordClasses'));
  return 'completed';
end
$$;
revoke all on function identity.complete_patient_account_deletion(uuid, text) from public;

create function identity.my_account_deletion_status(
  requested_subject text,
  requested_session uuid
) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp as $$
declare
  patient_id_value uuid;
  account_id_value uuid;
  settings_row platform.patient_account_deletion_settings%rowtype;
  request_row identity.patient_account_deletion_requests%rowtype;
  effective_state text;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then return null; end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;
  select * into settings_row from platform.patient_account_deletion_settings where singleton;
  select * into request_row from identity.patient_account_deletion_requests
   where account_id = account_id_value order by requested_at desc, id desc limit 1;
  effective_state := case
    when request_row.id is null then null
    when request_row.state = 'awaiting_confirmation'
      and request_row.confirmation_expires_at <= statement_timestamp() then 'expired'
    else request_row.state
  end;
  return jsonb_build_object(
    'waitingPeriodSeconds', extract(epoch from settings_row.waiting_period)::bigint,
    'confirmationTtlSeconds', extract(epoch from settings_row.confirmation_ttl)::bigint,
    'request', case when request_row.id is null then null else jsonb_build_object(
      'requestId', request_row.id,
      'state', effective_state,
      'requestedAt', request_row.requested_at,
      'confirmationExpiresAt', case when effective_state = 'awaiting_confirmation'
        then request_row.confirmation_expires_at end,
      'scheduledFor', request_row.scheduled_for,
      'blockedReasonCode', request_row.blocked_reason_code,
      'cancelledAt', request_row.cancelled_at,
      'cancellable', effective_state in ('awaiting_confirmation', 'pending')
    ) end
  );
end
$$;

create function identity.request_my_account_deletion(
  requested_subject text,
  requested_session uuid,
  requested_token_sha256 text
) returns table(request_id uuid, confirmation_expires_at timestamptz, waiting_period_seconds bigint)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp as $$
#variable_conflict use_column
declare
  patient_id_value uuid;
  account_id_value uuid;
  settings_row platform.patient_account_deletion_settings%rowtype;
  new_request uuid := gen_random_uuid();
  expires_at_value timestamptz;
  recent_requests integer;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_token_sha256 is null or requested_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid deletion confirmation verifier';
  end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('patient-account-deletion:' || account_id_value::text, 0));

  select * into settings_row from platform.patient_account_deletion_settings where singleton;
  if not found then
    raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_SETTINGS_UNAVAILABLE';
  end if;
  if exists (select 1 from identity.patient_account_deletion_requests request_row
              where request_row.account_id = account_id_value and request_row.state = 'pending') then
    raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_ALREADY_PENDING';
  end if;
  select count(*) into recent_requests from identity.patient_account_deletion_requests request_row
   where request_row.account_id = account_id_value
     and request_row.requested_at > clock_timestamp() - interval '1 day';
  if recent_requests >= settings_row.max_requests_per_day then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_DELETION_RATE_LIMITED';
  end if;

  -- A newer request invalidates any earlier unconsumed confirmation token.
  update identity.patient_account_deletion_requests as request_row
     set state = 'superseded', closed_at = clock_timestamp(),
         updated_at = clock_timestamp(), row_version = request_row.row_version + 1
   where request_row.account_id = account_id_value and request_row.state = 'awaiting_confirmation';

  expires_at_value := clock_timestamp() + settings_row.confirmation_ttl;
  insert into identity.patient_account_deletion_requests (
    id, account_id, patient_id, requested_session_id, state,
    confirmation_token_sha256, confirmation_expires_at, correlation_id
  ) values (
    new_request, account_id_value, patient_id_value, requested_session, 'awaiting_confirmation',
    requested_token_sha256, expires_at_value, platform.current_correlation_id()
  );
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient-account-deletion.requested', 'success', 'patient-account-deletion',
    new_request::text, 'patient-self', 'application', 'identity-api',
    jsonb_build_object('confirmationExpiresAt', expires_at_value,
      'waitingPeriodSeconds', extract(epoch from settings_row.waiting_period)::bigint)
  );
  return query select new_request, expires_at_value,
    extract(epoch from settings_row.waiting_period)::bigint;
end
$$;

-- Invalid, expired, and replayed confirmations return a non-disclosing outcome
-- so their denial audit commits; the API converts the outcome after commit.
create function identity.confirm_my_account_deletion(
  requested_subject text,
  requested_session uuid,
  requested_request_id uuid,
  requested_token_sha256 text,
  requested_confirmation text
) returns table(
  outcome text,
  request_id uuid,
  request_state text,
  scheduled_for timestamptz,
  blocked_reason_code text
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp as $$
#variable_conflict use_column
declare
  patient_id_value uuid;
  account_id_value uuid;
  settings_row platform.patient_account_deletion_settings%rowtype;
  request_row identity.patient_account_deletion_requests%rowtype;
  decision jsonb;
  denial text;
  scheduled_value timestamptz;
  completion text;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('patient-account-deletion:' || account_id_value::text, 0));
  select * into settings_row from platform.patient_account_deletion_settings where singleton;
  if not found then
    raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_SETTINGS_UNAVAILABLE';
  end if;

  select * into request_row from identity.patient_account_deletion_requests r
   where r.id = requested_request_id and r.account_id = account_id_value
     and r.patient_id = patient_id_value
   for update;

  if not found then
    denial := 'unknown_request';
  elsif request_row.state <> 'awaiting_confirmation' then
    denial := 'not_awaiting_confirmation';
  elsif request_row.confirmation_expires_at <= clock_timestamp() then
    denial := 'expired';
    update identity.patient_account_deletion_requests
       set state = 'expired', closed_at = clock_timestamp(),
           updated_at = clock_timestamp(), row_version = row_version + 1
     where id = request_row.id;
  elsif requested_token_sha256 is null
     or requested_token_sha256 is distinct from request_row.confirmation_token_sha256
     or upper(regexp_replace(btrim(coalesce(requested_confirmation, '')), '\s+', ' ', 'g'))
        <> 'DELETE MY ACCOUNT' then
    denial := 'invalid_proof';
    update identity.patient_account_deletion_requests
       set confirmation_failed_attempts = confirmation_failed_attempts + 1,
           state = case when confirmation_failed_attempts + 1 >= settings_row.max_confirmation_attempts
             then 'expired' else state end,
           closed_at = case when confirmation_failed_attempts + 1 >= settings_row.max_confirmation_attempts
             then clock_timestamp() else closed_at end,
           updated_at = clock_timestamp(), row_version = row_version + 1
     where id = request_row.id;
  end if;

  if denial is not null then
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
      action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details
    ) values (
      platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
      'identity.patient-account-deletion.confirmation-rejected', 'denied', 'patient-account-deletion',
      requested_request_id::text, 'patient-self', 'application', 'identity-api',
      jsonb_build_object('reason', denial)
    );
    return query select case when denial = 'expired' then 'expired' else 'invalid' end,
      requested_request_id, null::text, null::timestamptz, null::text;
    return;
  end if;

  -- The token is consumed in the same update that leaves
  -- `awaiting_confirmation`, so it can never be replayed.
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient-account-deletion.verified', 'success', 'patient-account-deletion',
    request_row.id::text, 'patient-self', 'application', 'identity-api',
    jsonb_build_object('proof', 'recent-authentication+single-use-token+typed-confirmation')
  );

  decision := platform.evaluate_patient_account_deletion(account_id_value, patient_id_value);
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient-account-deletion.retention-evaluated',
    case when (decision->>'allowed')::boolean then 'success' else 'denied' end,
    'patient-account-deletion', request_row.id::text, 'patient-self', 'application', 'identity-api',
    jsonb_build_object('allowed', decision->'allowed', 'reasonCode', decision->'reasonCode',
      'legalHold', decision->'legalHold', 'recordClasses', decision->'recordClasses')
  );

  if not (decision->>'allowed')::boolean then
    update identity.patient_account_deletion_requests
       set state = 'blocked', confirmation_consumed_at = clock_timestamp(),
           confirmed_at = clock_timestamp(), blocked_at = clock_timestamp(),
           blocked_reason_code = decision->>'reasonCode', retention_decision = decision,
           updated_at = clock_timestamp(), row_version = row_version + 1
     where id = request_row.id;
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
      action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details
    ) values (
      platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
      'identity.patient-account-deletion.blocked', 'denied', 'patient-account-deletion',
      request_row.id::text, 'patient-self', 'application', 'identity-api',
      jsonb_build_object('reasonCode', decision->>'reasonCode', 'stage', 'confirmation')
    );
    return query select 'blocked'::text, request_row.id, 'blocked'::text, null::timestamptz,
      decision->>'reasonCode';
    return;
  end if;

  scheduled_value := clock_timestamp() + settings_row.waiting_period;
  update identity.patient_account_deletion_requests
     set state = 'pending', confirmation_consumed_at = clock_timestamp(),
         confirmed_at = clock_timestamp(), waiting_period = settings_row.waiting_period,
         scheduled_for = scheduled_value, retention_decision = decision,
         updated_at = clock_timestamp(), row_version = row_version + 1
   where id = request_row.id;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient-account-deletion.scheduled', 'success', 'patient-account-deletion',
    request_row.id::text, 'patient-self', 'application', 'identity-api',
    jsonb_build_object('scheduledFor', scheduled_value,
      'waitingPeriodSeconds', extract(epoch from settings_row.waiting_period)::bigint)
  );

  if settings_row.waiting_period = interval '0' then
    completion := identity.complete_patient_account_deletion(request_row.id, requested_subject);
    if completion = 'completed' then
      return query select 'completed'::text, request_row.id, 'completed'::text, scheduled_value, null::text;
      return;
    end if;
    return query select completion, request_row.id,
      (select state from identity.patient_account_deletion_requests where id = request_row.id),
      scheduled_value,
      (select r.blocked_reason_code from identity.patient_account_deletion_requests r where r.id = request_row.id);
    return;
  end if;
  return query select 'pending'::text, request_row.id, 'pending'::text, scheduled_value, null::text;
end
$$;

create function identity.cancel_my_account_deletion(
  requested_subject text,
  requested_session uuid,
  requested_request_id uuid
) returns table(request_id uuid, request_state text, replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp as $$
#variable_conflict use_column
declare
  patient_id_value uuid;
  account_id_value uuid;
  request_row identity.patient_account_deletion_requests%rowtype;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('patient-account-deletion:' || account_id_value::text, 0));
  select * into request_row from identity.patient_account_deletion_requests r
   where r.id = requested_request_id and r.account_id = account_id_value
     and r.patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'The deletion request is unavailable';
  end if;
  if request_row.state = 'cancelled' then
    return query select request_row.id, 'cancelled'::text, true;
    return;
  end if;
  if request_row.state not in ('awaiting_confirmation', 'pending')
     or (request_row.state = 'pending' and request_row.scheduled_for <= clock_timestamp()) then
    raise exception using errcode = '55000', message = 'ACCOUNT_DELETION_NOT_CANCELLABLE';
  end if;
  update identity.patient_account_deletion_requests
     set state = 'cancelled', cancelled_at = clock_timestamp(),
         updated_at = clock_timestamp(), row_version = row_version + 1
   where id = request_row.id;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient-account-deletion.cancelled', 'success', 'patient-account-deletion',
    request_row.id::text, 'patient-self', 'application', 'identity-api',
    jsonb_build_object('previousState', request_row.state)
  );
  return query select request_row.id, 'cancelled'::text, false;
end
$$;

-- System finalizer for due requests. Concurrent workers skip locked rows.
create function identity.finalize_due_patient_account_deletions(requested_limit integer)
returns table(request_id uuid, outcome text)
language plpgsql security definer
set search_path = pg_catalog, identity, platform, pg_temp as $$
#variable_conflict use_column
declare
  due_id uuid;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'A system lifecycle context is required';
  end if;
  for due_id in
    select request_row.id from identity.patient_account_deletion_requests request_row
     where request_row.state = 'pending' and request_row.scheduled_for <= clock_timestamp()
     order by request_row.scheduled_for, request_row.id
     limit least(greatest(coalesce(requested_limit, 10), 1), 50)
     for update skip locked
  loop
    return query select due_id, identity.complete_patient_account_deletion(due_id, null);
  end loop;
end
$$;

revoke all on function identity.my_account_deletion_status(text, uuid),
  identity.request_my_account_deletion(text, uuid, text),
  identity.confirm_my_account_deletion(text, uuid, uuid, text, text),
  identity.cancel_my_account_deletion(text, uuid, uuid),
  identity.finalize_due_patient_account_deletions(integer) from public;

comment on table identity.patient_account_deletion_requests is
  'Patient login/account deletion lifecycle. Deletion closes the login only; patient identity, NIN binding, clinical, consent, audit, and notification records are retained.';
comment on table platform.record_class_retention_policies is
  'Record-class retention model. Only retain is representable until an erasure policy is approved under DATABASE.md section 15.';
comment on table platform.legal_holds is
  'Active holds block patient account-deletion completion; holds are released, never deleted.';
