-- NIN ownership proof before a Health ID (ADR-062). Applied migrations 0001
-- through 0092 are immutable.
--
-- A QoreID lookup proves only that a NIN exists. From this migration a public
-- enrollment starts at the new state verify_holder and reaches the contact
-- step only after a proof that the person holds the NIN:
--   * registry_phone_otp: a one-time code sent to the phone the NIN registry
--     lists for the NIN, entered on the enrollment (Identity API);
--   * facility_in_person: an in-person check at a participating facility
--     (0094, ADR-063; refused here until that migration).
-- Whether the NIN already has a Health ID is checked only after the proof, so
-- nobody learns it without proving that they hold the NIN.
--
-- 1. identity.public_patient_enrollments: the NIN is no longer unique (each
--    start inserts a row; a proof removes the others), a partial unique index
--    keeps one proven enrollment per NIN, and new holder and desk-code columns
--    with checks that a contact step, a password step or an activation always
--    carries a holder proof.
-- 2. identity.public_patient_enrollment_otps: a purpose column ('contact' or
--    'nin_holder'); a holder code goes to a phone only.
-- 3. Backfill: every enrollment that is not active goes back to verify_holder
--    with its contact cleared and its open codes invalidated ('expired');
--    every active one is marked holder_method 'none_before_0093'.
-- 4. identity.public_patient_holder_events: the append-only send, failure and
--    proof counts behind the holder budgets, written only by the commands
--    below. No runtime role has a table privilege on it.
-- 5. Commands (SECURITY DEFINER, system:auth only):
--    identity.record_public_patient_holder_send, ..._failure and ..._proof.
--    The proof command is the only writer of holder_method, holder_verified_at,
--    holder_challenge_id and holder_verification_id after this migration; the
--    role bootstrap grants the Identity runtime INSERT and UPDATE on the other
--    enrollment columns only.
-- 6. identity.prune_expired_public_patient_enrollments also prunes holder
--    events (send and failure after 31 days, proof after 366 days).
-- 7. identity.activate_public_patient_enrollment (0092's 9-argument command,
--    same signature, owner, search_path and grants) takes the NIN lock before
--    the row lock and requires the holder proof.
--
-- Locks: ACCESS EXCLUSIVE on identity.public_patient_enrollments and
-- identity.public_patient_enrollment_otps for the whole migration (catalog
-- changes, the backfill and the validating scans), each within the runner's
-- 5 s lock timeout; enrollment requests wait. A timeout rolls 0093 back
-- whole, and it can be run again. Forced row-level security is lifted on the
-- two tables for the backfill only, as 0091 did for its control update.

-- 1. Enrollment table.
alter table identity.public_patient_enrollments
  drop constraint public_patient_enrollments_nin_lookup_hmac_key;
create index public_patient_enrollments_nin_idx
  on identity.public_patient_enrollments (nin_lookup_hmac);

alter table identity.public_patient_enrollments
  add column holder_method text,
  add column holder_verified_at timestamptz,
  add column holder_challenge_id uuid,
  add column holder_verification_id uuid,
  add column holder_recipient_hmac char(64),
  add column desk_code_hmac char(64),
  add column desk_code_expires_at timestamptz;

alter table identity.public_patient_enrollments
  drop constraint public_patient_enrollments_state_check,
  add constraint public_patient_enrollments_state_check
    check (state in ('verify_holder', 'verify_contact', 'set_password', 'active')),
  alter column state set default 'verify_holder';

-- 2. Enrollment codes.
alter table identity.public_patient_enrollment_otps
  add column purpose text not null default 'contact',
  add constraint public_patient_enrollment_otps_purpose_check
    check (purpose in ('contact', 'nin_holder')),
  add constraint public_patient_enrollment_otps_holder_phone_check
    check (purpose <> 'nin_holder' or channel = 'phone');

-- 3. Backfill. No pending enrollment carries a holder proof, so each one that
-- is not active starts again at the holder step; an active one was created
-- before holder proofs existed and is marked so.
alter table identity.public_patient_enrollments no force row level security;
alter table identity.public_patient_enrollment_otps no force row level security;

update identity.public_patient_enrollment_otps challenge
   set invalidated_at = clock_timestamp(), invalidation_reason = 'expired'
  from identity.public_patient_enrollments enrollment
 where challenge.enrollment_id = enrollment.id
   and enrollment.state <> 'active'
   and challenge.consumed_at is null
   and challenge.invalidated_at is null;

update identity.public_patient_enrollments
   set state = 'verify_holder', contact_channel = null, contact_hmac = null,
       contact_lookup_hmac = null, contact_ciphertext = null, contact_verified_at = null,
       verified_challenge_id = null, updated_at = clock_timestamp(), row_version = row_version + 1
 where state <> 'active';

update identity.public_patient_enrollments
   set holder_method = 'none_before_0093'
 where state = 'active';

alter table identity.public_patient_enrollments force row level security;
alter table identity.public_patient_enrollment_otps force row level security;

-- Holder and desk-code rules. The checks are null-safe: a null method never
-- passes a rule that requires a proof.
alter table identity.public_patient_enrollments
  add constraint public_patient_enrollments_holder_method_check
    check (holder_method in ('registry_phone_otp', 'facility_in_person', 'none_before_0093')),
  add constraint public_patient_enrollments_holder_verified_check
    check ((holder_verified_at is not null)
      = coalesce(holder_method in ('registry_phone_otp', 'facility_in_person'), false)),
  add constraint public_patient_enrollments_holder_challenge_check
    check ((holder_challenge_id is not null) = (holder_method is not distinct from 'registry_phone_otp')),
  add constraint public_patient_enrollments_holder_verification_check
    check ((holder_verification_id is not null) = (holder_method is not distinct from 'facility_in_person')),
  add constraint public_patient_enrollments_holder_recipient_check
    check ((holder_recipient_hmac is null or holder_recipient_hmac ~ '^[0-9a-f]{64}$')
      and (holder_method is distinct from 'registry_phone_otp' or holder_recipient_hmac is not null)),
  add constraint public_patient_enrollments_holder_proven_check
    check (state not in ('verify_contact', 'set_password')
      or coalesce(holder_method in ('registry_phone_otp', 'facility_in_person'), false)),
  add constraint public_patient_enrollments_holder_active_check
    check (state <> 'active' or holder_method is not null),
  add constraint public_patient_enrollments_holder_legacy_check
    check (holder_method is distinct from 'none_before_0093' or state = 'active'),
  add constraint public_patient_enrollments_holder_unproven_check
    check (state <> 'verify_holder'
      or (holder_method is null and patient_id is null and contact_channel is null)),
  add constraint public_patient_enrollments_desk_code_check
    check ((desk_code_hmac is null or desk_code_hmac ~ '^[0-9a-f]{64}$')
      and ((desk_code_hmac is null) = (desk_code_expires_at is null))),
  add constraint public_patient_enrollments_holder_verification_uq unique (holder_verification_id);

-- One proven, unfinished enrollment per NIN. The proof command removes every
-- other enrollment of the NIN before it sets its own state, so the index
-- never trips on its path.
create unique index public_patient_enrollments_proven_nin_uq
  on identity.public_patient_enrollments (nin_lookup_hmac)
  where state in ('verify_contact', 'set_password');
create unique index public_patient_enrollments_desk_code_uq
  on identity.public_patient_enrollments (desk_code_hmac)
  where desk_code_hmac is not null;

comment on table identity.public_patient_enrollments is
  'Encrypted pending public identity. Starts at verify_holder; reaches the contact step only after a holder proof (ADR-062). Contains no active HID before activation.';
comment on column identity.public_patient_enrollments.holder_method is
  'How the person proved they hold the NIN: registry_phone_otp, facility_in_person, or none_before_0093 for an enrollment activated before 0093. Written only by identity.record_public_patient_holder_proof.';
comment on column identity.public_patient_enrollments.holder_recipient_hmac is
  'HMAC of the normalized registry phone (domain patient-enrollment-holder-phone); the holder code recipient and the phone digest of the holder events.';

-- 4. Holder events.
create table identity.public_patient_holder_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('send', 'failure', 'proof')),
  nin_digest char(64) not null check (nin_digest ~ '^[0-9a-f]{64}$'),
  phone_digest char(64) check (phone_digest is null or phone_digest ~ '^[0-9a-f]{64}$'),
  method text check (method is null or method in ('registry_phone_otp', 'facility_in_person')),
  occurred_at timestamptz not null default clock_timestamp(),
  check (kind = 'proof' or (method = 'registry_phone_otp' and phone_digest is not null)),
  check (kind <> 'proof' or method is not null),
  check (method is distinct from 'registry_phone_otp' or phone_digest is not null)
);
create index public_patient_holder_events_nin_idx
  on identity.public_patient_holder_events (nin_digest, kind, occurred_at);
create index public_patient_holder_events_phone_idx
  on identity.public_patient_holder_events (phone_digest, kind, occurred_at)
  where phone_digest is not null;
create index public_patient_holder_events_age_idx
  on identity.public_patient_holder_events (occurred_at);
alter table identity.public_patient_holder_events enable row level security;
alter table identity.public_patient_holder_events force row level security;
create policy public_patient_holder_events_system on identity.public_patient_holder_events for all
  using (platform.current_actor_subject() = 'system:auth')
  with check (platform.current_actor_subject() = 'system:auth');
revoke all on identity.public_patient_holder_events from public;
comment on table identity.public_patient_holder_events is
  'Append-only holder budget events (ADR-062): keyed digests of the NIN and the registry phone, never a NIN, phone or code. Written and counted only by the holder commands.';

-- 5a. A holder code send: checks the send and failure budgets and records the
-- send. Returns false, recording nothing, when a budget is spent. The caller
-- holds the enrollment row (taken after the NIN lock) and has stored
-- holder_recipient_hmac on it in the same transaction.
create function identity.record_public_patient_holder_send(
  requested_enrollment_id uuid, requested_token_hmac char(64), requested_nin_digest char(64),
  sms_daily_limit integer, failures_daily_limit integer, failures_monthly_limit integer
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, identity, platform, public, pg_temp
as $$
declare
  enrollment identity.public_patient_enrollments%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
    or platform.current_correlation_id() is null
    or requested_nin_digest is null or requested_nin_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if sms_daily_limit is null or failures_daily_limit is null or failures_monthly_limit is null
    or sms_daily_limit not between 1 and 50 or failures_daily_limit not between 1 and 100
    or failures_monthly_limit not between failures_daily_limit and 1000 then
    raise exception using errcode = '22023', message = 'PATIENT_HOLDER_LIMIT_INVALID';
  end if;
  select * into enrollment from identity.public_patient_enrollments
    where id = requested_enrollment_id for update;
  if not found or enrollment.token_hmac <> requested_token_hmac
    or enrollment.state <> 'verify_holder' or enrollment.expires_at <= clock_timestamp()
    or enrollment.holder_recipient_hmac is null then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-holder-nin:' || requested_nin_digest, 0));
  perform pg_advisory_xact_lock(hashtextextended('patient-holder-phone:' || enrollment.holder_recipient_hmac, 0));
  if (select count(*) from identity.public_patient_holder_events event
      where event.kind = 'send' and event.phone_digest = enrollment.holder_recipient_hmac
        and event.occurred_at > clock_timestamp() - interval '24 hours') >= sms_daily_limit
    or (select count(*) from identity.public_patient_holder_events event
      where event.kind = 'failure' and event.nin_digest = requested_nin_digest
        and event.occurred_at > clock_timestamp() - interval '24 hours') >= failures_daily_limit
    or (select count(*) from identity.public_patient_holder_events event
      where event.kind = 'failure' and event.nin_digest = requested_nin_digest
        and event.occurred_at > clock_timestamp() - interval '30 days') >= failures_monthly_limit then
    return false;
  end if;
  insert into identity.public_patient_holder_events(kind, nin_digest, phone_digest, method)
    values ('send', requested_nin_digest, enrollment.holder_recipient_hmac, 'registry_phone_otp');
  return true;
end
$$;
revoke all on function identity.record_public_patient_holder_send(uuid,char,char,integer,integer,integer)
  from public;

-- 5b. A wrong holder code: records a failure for the NIN. When a failure
-- budget is reached, writes the route-closed audit event once per window.
-- The caller has counted the attempt on the challenge.
create function identity.record_public_patient_holder_failure(
  requested_enrollment_id uuid, requested_token_hmac char(64), requested_challenge_id uuid,
  requested_nin_digest char(64), failures_daily_limit integer, failures_monthly_limit integer
) returns void
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, public, pg_temp
as $$
declare
  enrollment identity.public_patient_enrollments%rowtype;
  challenge identity.public_patient_enrollment_otps%rowtype;
  closed_window text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
    or platform.current_correlation_id() is null
    or requested_nin_digest is null or requested_nin_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if failures_daily_limit is null or failures_monthly_limit is null
    or failures_daily_limit not between 1 and 100
    or failures_monthly_limit not between failures_daily_limit and 1000 then
    raise exception using errcode = '22023', message = 'PATIENT_HOLDER_LIMIT_INVALID';
  end if;
  select * into enrollment from identity.public_patient_enrollments
    where id = requested_enrollment_id for update;
  if not found or enrollment.token_hmac <> requested_token_hmac
    or enrollment.state <> 'verify_holder' then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  select * into challenge from identity.public_patient_enrollment_otps
    where id = requested_challenge_id and enrollment_id = enrollment.id for update;
  if not found or challenge.purpose <> 'nin_holder' then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-holder-nin:' || requested_nin_digest, 0));
  perform pg_advisory_xact_lock(hashtextextended('patient-holder-phone:' || challenge.recipient_hmac, 0));
  insert into identity.public_patient_holder_events(kind, nin_digest, phone_digest, method)
    values ('failure', requested_nin_digest, challenge.recipient_hmac, 'registry_phone_otp');
  for closed_window in
    select budget.window_name from (values
      ('day'::text, interval '24 hours', failures_daily_limit),
      ('month'::text, interval '30 days', failures_monthly_limit)) budget(window_name, span, max_failures)
    where (select count(*) from identity.public_patient_holder_events event
      where event.kind = 'failure' and event.nin_digest = requested_nin_digest
        and event.occurred_at > clock_timestamp() - budget.span) = budget.max_failures
  loop
    insert into audit.events(correlation_id, actor_type, action, resource_type, resource_id,
      outcome, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'system',
      'identity.public-patient-enrollment.holder-route-closed', 'public-patient-enrollment',
      enrollment.id::text, 'denied', 'patient-self', 'application', 'identity-api',
      jsonb_build_object('ninDigest', requested_nin_digest, 'window', closed_window));
  end loop;
end
$$;
revoke all on function identity.record_public_patient_holder_failure(uuid,char,uuid,char,integer,integer)
  from public;

-- 5c. A holder proof. Lock order, as the 0093 activation: the NIN advisory
-- lock (0092's key), then the enrollment row, then the other enrollments of
-- the NIN in id order, then the holder budget locks. Returns
--   'verified'           the enrollment moves to verify_contact;
--   'existing_identity'  the NIN already has a Health ID: this enrollment and
--                        its codes are deleted and the event audited;
--   'facility_conflict'  an unexpired facility proof holds the NIN (a phone
--                        proof cannot displace it); nothing changes;
--   'route_limited'      the registry phone has proved too many other NINs
--                        this year; nothing changes.
-- 0093 accepts registry_phone_otp only; facility_in_person needs the assisted
-- verification record of 0094 (ADR-063).
create function identity.record_public_patient_holder_proof(
  requested_enrollment_id uuid, requested_token_hmac char(64), requested_method text,
  requested_challenge_id uuid, requested_verification_id uuid, requested_nin_digest char(64),
  distinct_nins_limit integer
) returns text
language plpgsql security definer
set search_path = pg_catalog, identity, migration, audit, platform, public, pg_temp
as $$
declare
  lookup_hmac char(64);
  enrollment identity.public_patient_enrollments%rowtype;
  challenge identity.public_patient_enrollment_otps%rowtype;
  existing_binding text;
  superseded_count integer;
  superseded_methods jsonb;
  contested boolean;
  proved_at timestamptz;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
    or platform.current_correlation_id() is null
    or requested_nin_digest is null or requested_nin_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if requested_method is distinct from 'registry_phone_otp' or requested_verification_id is not null
    or requested_challenge_id is null then
    raise exception using errcode = '22023', message = 'PATIENT_HOLDER_METHOD_UNAVAILABLE';
  end if;
  if distinct_nins_limit is null or distinct_nins_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'PATIENT_HOLDER_LIMIT_INVALID';
  end if;
  -- The NIN lock comes before any row lock (ADR-062).
  select candidate.nin_lookup_hmac into lookup_hmac from identity.public_patient_enrollments candidate
    where candidate.id = requested_enrollment_id;
  if not found then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-nin:' || lookup_hmac, 0));
  select * into enrollment from identity.public_patient_enrollments
    where id = requested_enrollment_id for update;
  if not found or enrollment.token_hmac <> requested_token_hmac
    or enrollment.nin_lookup_hmac <> lookup_hmac
    or enrollment.state <> 'verify_holder' or enrollment.expires_at <= clock_timestamp() then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if not identity.public_patient_enrollment_ready() then
    raise exception using errcode = '55000', message = 'PATIENT_ENROLLMENT_RECONCILIATION_REQUIRED';
  end if;
  select * into challenge from identity.public_patient_enrollment_otps
    where id = requested_challenge_id and enrollment_id = enrollment.id for update;
  if not found or challenge.purpose <> 'nin_holder' or challenge.channel <> 'phone'
    or enrollment.holder_recipient_hmac is null
    or challenge.recipient_hmac <> enrollment.holder_recipient_hmac
    or challenge.consumed_at is not null or challenge.invalidated_at is not null
    or challenge.verified_at is not null
    or challenge.expires_at <= clock_timestamp()
    or challenge.failed_attempts >= challenge.max_attempts
    or challenge.delivery_outcome = 'definitive_failure' then
    raise exception using errcode = '23514', message = 'PATIENT_HOLDER_PROOF_INVALID';
  end if;

  -- The existing-Health-ID check runs only after the proof (ADR-062).
  if identity.public_patient_nin_already_bound(enrollment.nin_lookup_hmac) then
    select coalesce(bound.holder_method, 'other') into existing_binding
      from identity.patient_identifiers identifier
      left join identity.public_patient_enrollments bound on bound.id = identifier.public_enrollment_id
     where identifier.identifier_type = 'nin' and identifier.lookup_hmac = enrollment.nin_lookup_hmac
     order by identifier.created_at limit 1;
    delete from identity.public_patient_enrollment_otps where enrollment_id = enrollment.id;
    delete from identity.public_patient_enrollments where id = enrollment.id;
    insert into audit.events(correlation_id, actor_type, action, resource_type, resource_id,
      outcome, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'system',
      'identity.public-patient-enrollment.existing-identity', 'public-patient-enrollment',
      enrollment.id::text, 'denied', 'patient-self', 'application', 'identity-api',
      jsonb_build_object('method', requested_method, 'ninDigest', requested_nin_digest,
        'existingBinding', coalesce(existing_binding, 'other')));
    return 'existing_identity';
  end if;

  -- Every other unfinished enrollment of this NIN, in id order.
  perform 1 from identity.public_patient_enrollments other
    where other.nin_lookup_hmac = enrollment.nin_lookup_hmac and other.id <> enrollment.id
      and other.state <> 'active'
    order by other.id for update;
  perform pg_advisory_xact_lock(hashtextextended('patient-holder-nin:' || requested_nin_digest, 0));
  perform pg_advisory_xact_lock(hashtextextended('patient-holder-phone:' || enrollment.holder_recipient_hmac, 0));

  -- One registry phone proves at most distinct_nins_limit other NINs a year.
  if (select count(distinct event.nin_digest) from identity.public_patient_holder_events event
      where event.kind = 'proof' and event.method = 'registry_phone_otp'
        and event.phone_digest = enrollment.holder_recipient_hmac
        and event.nin_digest <> requested_nin_digest
        and event.occurred_at > clock_timestamp() - interval '365 days') >= distinct_nins_limit then
    return 'route_limited';
  end if;

  -- An unexpired in-person proof is displaced only by another in-person proof.
  if exists (select 1 from identity.public_patient_enrollments other
    where other.nin_lookup_hmac = enrollment.nin_lookup_hmac and other.id <> enrollment.id
      and other.holder_method = 'facility_in_person'
      and other.state in ('verify_contact', 'set_password')
      and other.expires_at > clock_timestamp()) then
    return 'facility_conflict';
  end if;

  select count(*), coalesce(jsonb_agg(distinct coalesce(other.holder_method, 'unproven')), '[]'::jsonb),
    coalesce(bool_or(other.holder_method is not null and other.holder_method <> requested_method), false)
    into superseded_count, superseded_methods, contested
    from identity.public_patient_enrollments other
   where other.nin_lookup_hmac = enrollment.nin_lookup_hmac and other.id <> enrollment.id
     and other.state <> 'active';
  if superseded_count > 0 then
    delete from identity.public_patient_enrollment_otps challenge_row
      using identity.public_patient_enrollments other
     where challenge_row.enrollment_id = other.id
       and other.nin_lookup_hmac = enrollment.nin_lookup_hmac and other.id <> enrollment.id
       and other.state <> 'active';
    delete from identity.public_patient_enrollments other
     where other.nin_lookup_hmac = enrollment.nin_lookup_hmac and other.id <> enrollment.id
       and other.state <> 'active';
    insert into audit.events(correlation_id, actor_type, action, resource_type, resource_id,
      outcome, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'system',
      case when contested then 'identity.public-patient-enrollment.contested'
        else 'identity.public-patient-enrollment.superseded' end,
      'public-patient-enrollment', enrollment.id::text, 'success', 'patient-self',
      'application', 'identity-api',
      jsonb_build_object('count', superseded_count, 'methods', superseded_methods,
        'ninDigest', requested_nin_digest));
  end if;

  proved_at := clock_timestamp();
  update identity.public_patient_enrollment_otps
     set verified_at = proved_at, consumed_at = proved_at
   where id = challenge.id;
  update identity.public_patient_enrollments
     set holder_method = requested_method, holder_verified_at = proved_at,
         holder_challenge_id = challenge.id, state = 'verify_contact',
         updated_at = proved_at, row_version = row_version + 1
   where id = enrollment.id;
  insert into identity.public_patient_holder_events(kind, nin_digest, phone_digest, method)
    values ('proof', requested_nin_digest, enrollment.holder_recipient_hmac, requested_method);
  insert into audit.events(correlation_id, actor_type, action, resource_type, resource_id,
    outcome, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'system',
    'identity.public-patient-enrollment.holder-verified', 'public-patient-enrollment',
    enrollment.id::text, 'success', 'patient-self', 'application', 'identity-api',
    jsonb_build_object('method', requested_method, 'ninDigest', requested_nin_digest,
      'phoneDigest', enrollment.holder_recipient_hmac));
  return 'verified';
end
$$;
revoke all on function identity.record_public_patient_holder_proof(uuid,char,text,uuid,uuid,char,integer)
  from public;

-- 6. Retention: holder events outlive their enrollments for their windows.
create or replace function identity.prune_expired_public_patient_enrollments()
returns integer language plpgsql security definer
set search_path = pg_catalog, identity, platform, public, pg_temp
as $$
declare removed integer;
begin
  if platform.current_actor_subject() <> 'system:auth' then
    raise exception using errcode='42501', message='PATIENT_ENROLLMENT_DENIED';
  end if;
  delete from identity.public_patient_enrollment_otps challenge
    using identity.public_patient_enrollments enrollment
    where challenge.enrollment_id=enrollment.id and enrollment.state <> 'active'
      and enrollment.expires_at <= clock_timestamp();
  delete from identity.public_patient_enrollments
    where state <> 'active' and expires_at <= clock_timestamp();
  get diagnostics removed = row_count;
  delete from identity.public_patient_enrollment_rates
    where window_started_at < clock_timestamp() - interval '48 hours';
  delete from identity.public_patient_holder_events
    where (kind in ('send', 'failure') and occurred_at < clock_timestamp() - interval '31 days')
       or (kind = 'proof' and occurred_at < clock_timestamp() - interval '366 days');
  return removed;
end
$$;

-- 7. Activation requires the holder proof. Everything else is 0092's, apart
-- from the NIN lock, now taken before the row lock, the contact code's
-- purpose and expiry check, nin_verified_at (the holder proof's time) and the
-- audit event's holderMethod.
create or replace function identity.activate_public_patient_enrollment(
  requested_enrollment_id uuid, requested_token_hmac char(64), requested_profile_json text,
  requested_contact text, requested_hid text, requested_password_hash text,
  requested_contact_lookup_hmac char(64),
  requested_date_of_birth date default null, requested_gender text default null
) returns table (patient_id uuid, hid_code text, account_id uuid, replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, public, pg_temp
as $$
declare
  lookup_hmac char(64);
  enrollment identity.public_patient_enrollments%rowtype;
  profile jsonb;
  new_account uuid;
  new_patient uuid;
  normalized_email text;
  patient_dob date;
  patient_gender text;
  self_reported_fields jsonb := '[]'::jsonb;
begin
  if platform.current_actor_subject() <> 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if not identity.public_patient_enrollment_ready() then
    raise exception using errcode = '55000', message = 'PATIENT_ENROLLMENT_RECONCILIATION_REQUIRED';
  end if;
  -- 0093: the NIN lock before the row lock, the order of the holder proof.
  select candidate.nin_lookup_hmac into lookup_hmac from identity.public_patient_enrollments candidate
    where candidate.id = requested_enrollment_id;
  if not found then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-nin:' || lookup_hmac, 0));
  select * into enrollment from identity.public_patient_enrollments
    where id = requested_enrollment_id for update;
  if not found or enrollment.token_hmac <> requested_token_hmac
    or enrollment.nin_lookup_hmac <> lookup_hmac then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if enrollment.state = 'active' then
    -- N2(b): the HID is shown again for 15 minutes after activation only.
    if enrollment.activated_at is null
      or enrollment.activated_at <= clock_timestamp() - interval '15 minutes' then
      raise exception using errcode = 'P0002', message = 'PATIENT_ENROLLMENT_REPLAY_EXPIRED';
    end if;
    return query select enrollment.patient_id,
      (select patient.hid_code from identity.patients patient where patient.id = enrollment.patient_id),
      enrollment.account_id, true;
    return;
  end if;
  -- N2(c): a contact proof older than 30 minutes is verified again.
  if enrollment.state = 'set_password'
    and enrollment.contact_verified_at <= clock_timestamp() - interval '30 minutes' then
    raise exception using errcode = '23514', message = 'PATIENT_CONTACT_REVERIFY_REQUIRED';
  end if;
  if enrollment.state <> 'set_password' or enrollment.expires_at <= clock_timestamp()
    or enrollment.contact_verified_at is null or enrollment.verified_challenge_id is null
    or enrollment.contact_lookup_hmac is null
    or requested_contact_lookup_hmac is null
    or enrollment.contact_lookup_hmac <> requested_contact_lookup_hmac
    or requested_contact_lookup_hmac !~ '^[0-9a-f]{64}$'
    or requested_hid !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'
    or requested_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$'
    or length(requested_password_hash) not between 64 and 512
    or requested_profile_json is null or length(requested_profile_json) > 1048576
    or encode(public.digest(requested_profile_json, 'sha256'), 'hex') <> enrollment.profile_sha256 then
    raise exception using errcode = '23514', message = 'PATIENT_ENROLLMENT_NOT_READY';
  end if;
  if not exists (select 1 from identity.public_patient_enrollment_otps challenge
    where challenge.id = enrollment.verified_challenge_id and challenge.enrollment_id = enrollment.id
      and challenge.purpose = 'contact'
      and challenge.channel = enrollment.contact_channel
      and challenge.recipient_hmac = enrollment.contact_hmac
      and challenge.verified_at is not null and challenge.verified_at <= challenge.expires_at
      and challenge.consumed_at is not null
      and challenge.invalidated_at is null) then
    raise exception using errcode = '23514', message = 'PATIENT_CONTACT_NOT_VERIFIED';
  end if;
  -- 0093 (ADR-062): a first activation needs a holder proof made before the
  -- contact proof, by a different, consumed code sent to the registry phone.
  if enrollment.holder_method is distinct from 'registry_phone_otp'
    or enrollment.holder_verified_at is null or enrollment.holder_challenge_id is null
    or enrollment.holder_recipient_hmac is null
    or enrollment.holder_challenge_id = enrollment.verified_challenge_id
    or enrollment.holder_verified_at > enrollment.contact_verified_at
    or not exists (select 1 from identity.public_patient_enrollment_otps holder
      where holder.id = enrollment.holder_challenge_id and holder.enrollment_id = enrollment.id
        and holder.purpose = 'nin_holder' and holder.channel = 'phone'
        and holder.recipient_hmac = enrollment.holder_recipient_hmac
        and holder.verified_at is not null and holder.verified_at <= holder.expires_at
        and holder.consumed_at is not null and holder.invalidated_at is null) then
    raise exception using errcode = '23514', message = 'PATIENT_HOLDER_PROOF_INVALID';
  end if;
  profile := requested_profile_json::jsonb;
  if jsonb_typeof(profile) <> 'object' or coalesce(profile->>'nin','') !~ '^[0-9]{11}$'
    or right(profile->>'nin',4) <> enrollment.nin_last4
    or coalesce(profile->>'firstName','') !~ '^[^[:cntrl:]]{1,100}$'
    or coalesce(profile->>'lastName','') !~ '^[^[:cntrl:]]{1,100}$'
    or coalesce(profile->>'providerReference','') <> enrollment.provider_reference then
    raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
  end if;
  -- 0092 (ADR-061): a date of birth or gender the NIN record gives is checked
  -- as before and cannot come from the request; one it lacks must. The format
  -- is checked before the cast, and a date that is not on the calendar is
  -- refused like any other invalid identity, not raised as a cast error.
  if profile->>'dateOfBirth' is not null then
    if profile->>'dateOfBirth' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or requested_date_of_birth is not null then
      raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
    end if;
    begin
      patient_dob := (profile->>'dateOfBirth')::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
    end;
  else
    patient_dob := requested_date_of_birth;
    self_reported_fields := self_reported_fields || '["dateOfBirth"]'::jsonb;
  end if;
  if patient_dob is null or patient_dob < date '1900-01-01' or patient_dob > current_date then
    raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
  end if;
  if profile->>'gender' is not null then
    if requested_gender is not null then
      raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
    end if;
    patient_gender := profile->>'gender';
  else
    patient_gender := requested_gender;
    self_reported_fields := self_reported_fields || '["gender"]'::jsonb;
  end if;
  if patient_gender is null or patient_gender not in ('female','male','intersex','other','unknown') then
    raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
  end if;
  if identity.public_patient_nin_already_bound(enrollment.nin_lookup_hmac) then
    raise exception using errcode = '23505', message = 'PATIENT_NIN_ALREADY_BOUND';
  end if;
  if enrollment.contact_channel = 'email' then
    normalized_email := lower(btrim(requested_contact));
    if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or length(normalized_email) > 254 then
      raise exception using errcode = '22023', message = 'PATIENT_CONTACT_INVALID';
    end if;
  elsif enrollment.contact_channel = 'phone' then
    if requested_contact !~ '^\+[1-9][0-9]{7,14}$' then
      raise exception using errcode = '22023', message = 'PATIENT_CONTACT_INVALID';
    end if;
  else
    raise exception using errcode = '23514', message = 'PATIENT_CONTACT_NOT_VERIFIED';
  end if;
  if identity.public_patient_contact_already_bound(
    enrollment.contact_channel, enrollment.contact_lookup_hmac) then
    raise exception using errcode = '23505', message = 'PATIENT_CONTACT_ALREADY_BOUND';
  end if;
  new_account := gen_random_uuid();
  new_patient := gen_random_uuid();
  -- Set IDs before inserting the canonical patient so FORCE RLS can prove the
  -- exact pending enrollment tuple. All writes commit or roll back together.
  update identity.public_patient_enrollments set account_id = new_account,
    patient_id = new_patient, updated_at = clock_timestamp(), row_version = row_version + 1
    where id = enrollment.id;
  insert into auth.accounts(id,subject,email,display_name,status,password_hash,
    password_algorithm,password_changed_at,email_verified_at,source_system)
  values(new_account,'patient:' || new_account::text,normalized_email,
    btrim(profile->>'firstName') || ' ' || btrim(profile->>'lastName'),
    'active',requested_password_hash,'argon2id',clock_timestamp(),
    case when normalized_email is not null then enrollment.contact_verified_at else null end,
    'hid-public-qoreid-enrollment');
  insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,
    gender,dob,phone_e164_ciphertext,phone_lookup_hmac,email_ciphertext,email_lookup_hmac,
    contact_key_version,source_system,status)
  values(new_patient,new_account,requested_hid,btrim(profile->>'firstName'),btrim(profile->>'lastName'),
    btrim(profile->>'firstName') || ' ' || btrim(profile->>'lastName'),patient_gender,
    patient_dob,
    case when enrollment.contact_channel = 'phone' then enrollment.contact_ciphertext else null end,
    case when enrollment.contact_channel = 'phone' then enrollment.contact_lookup_hmac else null end,
    case when enrollment.contact_channel = 'email' then enrollment.contact_ciphertext else null end,
    case when enrollment.contact_channel = 'email' then enrollment.contact_lookup_hmac else null end,
    enrollment.key_version,'hid-public-qoreid-enrollment','active');
  insert into identity.patient_identifiers(id,patient_id,identifier_type,public_value,verified,source_system)
    values(gen_random_uuid(),new_patient,'hid_code',requested_hid,true,'hid-public-qoreid-enrollment');
  insert into identity.patient_identifiers(id,patient_id,identifier_type,value_ciphertext,lookup_hmac,
    encryption_key_version,display_hint,verified,source_system,verified_at,
    verification_provider,verification_reference,public_enrollment_id)
  values(gen_random_uuid(),new_patient,'nin',enrollment.nin_ciphertext,enrollment.nin_lookup_hmac,
    enrollment.key_version,enrollment.nin_last4,true,'hid-public-qoreid-enrollment',enrollment.created_at,
    'qoreid',enrollment.provider_reference,enrollment.id);
  insert into identity.patient_authoritative_profiles(patient_id,enrollment_id,profile_ciphertext,
    profile_sha256,key_version,provider,provider_reference,verified_at)
  values(new_patient,enrollment.id,enrollment.profile_ciphertext,enrollment.profile_sha256,
    enrollment.key_version,'qoreid',enrollment.provider_reference,enrollment.created_at);
  insert into identity.patient_assurance_states(patient_id,account_id,state,source_system,
    source_reference,verified_provider,contact_verified_at,nin_verified_at)
  values(new_patient,new_account,'NIN_VERIFIED','hid-public-qoreid-enrollment',
    enrollment.id::text,'qoreid',enrollment.contact_verified_at,enrollment.holder_verified_at);
  update identity.public_patient_enrollments set state = 'active', activated_at = clock_timestamp(),
    updated_at = clock_timestamp(), row_version = row_version + 1 where id = enrollment.id;
  insert into audit.events(correlation_id,actor_type,actor_subject,patient_id,
    action,resource_type,resource_id,outcome,purpose_of_use,provenance,source_system,details)
  values(platform.current_correlation_id(),'system',null,new_patient,
    'identity.public-patient-enrollment.activated','patient',new_patient::text,
    'success','patient-self','application','identity-api',
    jsonb_build_object('provider','qoreid','contactChannel',enrollment.contact_channel,
      'selfReportedFields',self_reported_fields,'holderMethod',enrollment.holder_method));
  return query select new_patient, requested_hid, new_account, false;
end
$$;
