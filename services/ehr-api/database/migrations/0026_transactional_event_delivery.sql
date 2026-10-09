-- Reliable at-least-once delivery for the existing domain-owned outboxes.
-- Domain event rows remain immutable. Mutable claims, attempts, and inbox
-- processing state live in the neutral integration schema.

create schema if not exists integration;
revoke all on schema integration from public;

comment on schema integration is
  'Transport-neutral outbox delivery and per-consumer durable inbox state; never owns domain semantics.';

-- Migration 0017 originally constrained every later Lab event aggregate to an
-- imported-evidence row. Later migrations introduced work-item, accession,
-- specimen, execution, and result event types. Replace that obsolete narrow FK
-- with an exact polymorphic command-time reference check.
alter table lab.outbox_events
  drop constraint if exists outbox_events_aggregate_id_fkey;

create or replace function lab.validate_outbox_aggregate_reference()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, lab
as $$
declare
  aggregate_exists boolean := false;
begin
  case
    when new.event_type in ('LabImportedEvidenceCreated', 'LabImportedEvidenceAmended') then
      select exists(select 1 from lab.imported_evidence where id = new.aggregate_id)
        into aggregate_exists;
    when new.event_type = 'LabWorkItemCreated' then
      select exists(select 1 from lab.work_items where id = new.aggregate_id)
        into aggregate_exists;
    when new.event_type = 'LabAccessionCreated' then
      select exists(select 1 from lab.accessions where id = new.aggregate_id)
        into aggregate_exists;
    when new.event_type in ('LabSpecimenCollected', 'LabSpecimenReceived', 'LabSpecimenRejected') then
      select exists(select 1 from lab.specimens where id = new.aggregate_id)
        into aggregate_exists;
    when new.event_type in ('LabTestExecutionStarted', 'LabTestExecutionCompleted') then
      select exists(select 1 from lab.test_executions where id = new.aggregate_id)
        into aggregate_exists;
    when new.event_type in (
      'LabResultEntered', 'LabResultCorrected', 'LabResultVerified',
      'LabResultReleased', 'LabResultAmended', 'LabResultEnteredInError'
    ) then
      select exists(select 1 from lab.results where id = new.aggregate_id)
        into aggregate_exists;
  end case;

  if not aggregate_exists then
    raise exception using
      errcode = '23503',
      message = 'Lab outbox aggregate does not exist for the declared event type';
  end if;
  return new;
end
$$;

create trigger lab_outbox_aggregate_reference
  before insert on lab.outbox_events
  for each row execute function lab.validate_outbox_aggregate_reference();

-- Event payloads are bounded and may not carry the sensitive value classes
-- prohibited for each producer. Recursive validation is repeated by the
-- dispatcher before transport.
alter table ocr.outbox_events add constraint ocr_outbox_payload_delivery_safe
  check (
    octet_length(payload::text) <= 8192
    and not (payload ?| array['rawText', 'extractedText', 'ocrText', 'fullText'])
  );
alter table lab.outbox_events add constraint lab_outbox_payload_delivery_safe
  check (
    octet_length(payload::text) <= 8192
    and not (payload ?| array['resultValue', 'numericValue', 'textValue', 'value'])
  );
alter table pharmacy.outbox_events add constraint pharmacy_outbox_payload_delivery_safe
  check (
    octet_length(payload::text) <= 8192
    and not (payload ?| array[
      'medicationText', 'strengthText', 'doseText', 'frequencyText', 'instructions'
    ])
  );
alter table outreach.outbox_events add constraint outreach_outbox_payload_delivery_safe
  check (
    not (payload ?| array[
      'nin', 'rawNin', 'name', 'email', 'phone', 'dateOfBirth', 'demographics'
    ])
  );

create or replace function integration.reject_outbox_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Domain outbox event envelopes and payloads are immutable';
end
$$;

create trigger identity_outbox_event_immutable
  before update or delete on identity.outbox_events
  for each row execute function integration.reject_outbox_event_mutation();
create trigger ocr_outbox_event_immutable
  before update or delete on ocr.outbox_events
  for each row execute function integration.reject_outbox_event_mutation();
create trigger lab_outbox_event_immutable
  before update or delete on lab.outbox_events
  for each row execute function integration.reject_outbox_event_mutation();
create trigger pharmacy_outbox_event_immutable
  before update or delete on pharmacy.outbox_events
  for each row execute function integration.reject_outbox_event_mutation();

-- Existing domain outboxes use two historical naming shapes. This invoker-
-- security view provides one immutable versioned envelope without changing
-- producer transactions or copying payloads.
create view integration.outbox_envelopes
with (security_invoker = true)
as
select
  'identity'::text as producer,
  event_id,
  event_type,
  1::integer as event_version,
  created_at as occurred_at,
  'identity-registration-case'::text as aggregate_type,
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
  'ocr'::text,
  id,
  event_type,
  event_version,
  occurred_at,
  'ocr-job'::text,
  aggregate_id,
  aggregate_version,
  correlation_id,
  null::uuid,
  facility_id,
  null::uuid,
  payload,
  published_at,
  attempt_count,
  next_attempt_at,
  null::text
from ocr.outbox_events
union all
select
  'lab'::text,
  id,
  event_type,
  event_version,
  occurred_at,
  case
    when event_type like 'LabImportedEvidence%' then 'lab-imported-evidence'
    when event_type = 'LabWorkItemCreated' then 'lab-work-item'
    when event_type = 'LabAccessionCreated' then 'lab-accession'
    when event_type like 'LabSpecimen%' then 'lab-specimen'
    when event_type like 'LabTestExecution%' then 'lab-test-execution'
    else 'lab-result'
  end,
  aggregate_id,
  aggregate_version,
  correlation_id,
  null::uuid,
  facility_id,
  patient_id,
  payload,
  published_at,
  attempt_count,
  next_attempt_at,
  null::text
from lab.outbox_events
union all
select
  'pharmacy'::text,
  id,
  event_type,
  event_version,
  occurred_at,
  aggregate_type,
  aggregate_id,
  aggregate_version,
  correlation_id,
  null::uuid,
  facility_id,
  patient_id,
  payload,
  published_at,
  attempt_count,
  next_attempt_at,
  null::text
from pharmacy.outbox_events
union all
select
  'outreach'::text,
  event_id,
  event_type,
  1::integer,
  created_at,
  'outreach-registration-case'::text,
  aggregate_id,
  aggregate_version,
  correlation_id,
  null::uuid,
  facility_id,
  patient_id,
  payload,
  published_at,
  attempt_count,
  next_attempt_at,
  last_error_code
from outreach.outbox_events;

create or replace function integration.outbox_envelope_sha256(
  event_producer text,
  stable_event_id uuid,
  versioned_event_type text,
  versioned_event_version integer,
  event_occurred_at timestamptz,
  event_aggregate_type text,
  event_aggregate_id uuid,
  event_aggregate_version bigint,
  event_correlation_id text,
  event_causation_id uuid,
  event_facility_id uuid,
  event_patient_id uuid,
  event_payload jsonb
) returns char(64)
language sql
immutable
set search_path = pg_catalog, public
as $$
  select encode(public.digest(concat_ws(chr(31),
    event_producer,
    stable_event_id::text,
    versioned_event_type,
    versioned_event_version::text,
    extract(epoch from event_occurred_at)::numeric::text,
    event_aggregate_type,
    event_aggregate_id::text,
    event_aggregate_version::text,
    event_correlation_id,
    coalesce(event_causation_id::text, '<null>'),
    coalesce(event_facility_id::text, '<null>'),
    coalesce(event_patient_id::text, '<null>'),
    event_payload::text
  ), 'sha256'), 'hex')::char(64)
$$;

create table integration.outbox_delivery_state (
  producer text not null check (producer in ('identity', 'ocr', 'lab', 'pharmacy', 'outreach')),
  event_id uuid not null,
  envelope_sha256 char(64) not null,
  occurred_at timestamptz not null,
  state text not null default 'pending' check (state in (
    'pending', 'claimed', 'retry_scheduled', 'delivered', 'failed_terminal'
  )),
  dispatcher_id text,
  claim_token uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 100),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  failed_at timestamptz,
  transport_name text,
  transport_message_id text,
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,79}$'
  ),
  last_error_summary text check (
    last_error_summary is null or length(last_error_summary) between 1 and 500
  ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (producer, event_id),
  check (
    (state = 'claimed') =
    (dispatcher_id is not null and claim_token is not null
      and claimed_at is not null and claim_expires_at is not null)
  ),
  check (state <> 'delivered' or delivered_at is not null),
  check (state <> 'failed_terminal' or failed_at is not null),
  check (claim_expires_at is null or claim_expires_at > claimed_at),
  check (transport_message_id is null or length(transport_message_id) between 1 and 255)
);

create unique index integration_outbox_active_claim_token_idx
  on integration.outbox_delivery_state (claim_token)
  where claim_token is not null;
create index integration_outbox_eligible_idx
  on integration.outbox_delivery_state (state, next_attempt_at, occurred_at, producer, event_id)
  where state in ('pending', 'claimed', 'retry_scheduled');

create table integration.outbox_delivery_attempts (
  attempt_id bigint generated always as identity primary key,
  producer text not null,
  event_id uuid not null,
  attempt_no integer not null check (attempt_no between 1 and 100),
  claim_token uuid not null unique,
  dispatcher_id text not null check (length(dispatcher_id) between 3 and 128),
  started_at timestamptz not null,
  completed_at timestamptz,
  outcome text check (outcome in (
    'delivered', 'retry_scheduled', 'failed_terminal', 'lease_expired'
  )),
  transport_name text,
  transport_message_id text,
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  error_summary text check (error_summary is null or length(error_summary) between 1 and 500),
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  foreign key (producer, event_id)
    references integration.outbox_delivery_state(producer, event_id) on delete restrict,
  unique (producer, event_id, attempt_no),
  check ((completed_at is null) = (outcome is null)),
  check (transport_message_id is null or length(transport_message_id) between 1 and 255)
);

create index integration_outbox_attempt_event_idx
  on integration.outbox_delivery_attempts (producer, event_id, attempt_no desc);

create or replace function integration.claim_outbox_events(
  requested_dispatcher_id text,
  requested_batch_size integer,
  requested_lease_seconds integer,
  requested_max_attempts integer
) returns table (
  producer text,
  event_id uuid,
  event_type text,
  event_version integer,
  occurred_at timestamptz,
  aggregate_type text,
  aggregate_id uuid,
  aggregate_version bigint,
  correlation_id text,
  causation_id uuid,
  facility_id uuid,
  patient_id uuid,
  payload jsonb,
  attempt_count integer,
  claim_token uuid,
  claim_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, integration
as $$
declare
  command_now timestamptz := clock_timestamp();
begin
  if requested_dispatcher_id is null
     or length(requested_dispatcher_id) not between 3 and 128
     or requested_dispatcher_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     or requested_batch_size not between 1 and 100
     or requested_lease_seconds not between 5 and 900
     or requested_max_attempts not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Invalid outbox claim request';
  end if;

  insert into integration.outbox_delivery_state (
    producer, event_id, envelope_sha256, occurred_at, state, attempt_count,
    next_attempt_at, delivered_at, last_error_code
  )
  select envelope.producer, envelope.event_id,
    integration.outbox_envelope_sha256(
      envelope.producer, envelope.event_id, envelope.event_type, envelope.event_version,
      envelope.occurred_at, envelope.aggregate_type, envelope.aggregate_id,
      envelope.aggregate_version, envelope.correlation_id, envelope.causation_id,
      envelope.facility_id, envelope.patient_id, envelope.payload
    ), envelope.occurred_at,
    'pending',
    least(envelope.source_attempt_count, 100),
    envelope.source_next_attempt_at,
    envelope.source_published_at,
    envelope.source_last_error_code
  from integration.outbox_envelopes envelope
  where envelope.source_published_at is null
  on conflict on constraint outbox_delivery_state_pkey do nothing;

  update integration.outbox_delivery_attempts attempt
     set completed_at = command_now,
         outcome = 'lease_expired',
         error_code = 'CLAIM_LEASE_EXPIRED',
         error_summary = 'Dispatcher claim expired before delivery state was recorded',
         duration_ms = greatest(0,
           floor(extract(epoch from (command_now - attempt.started_at)) * 1000)::bigint)
    from integration.outbox_delivery_state delivery
   where delivery.state = 'claimed'
     and delivery.claim_expires_at <= command_now
     and attempt.claim_token = delivery.claim_token
     and attempt.completed_at is null;

  update integration.outbox_delivery_state delivery
     set state = 'failed_terminal',
         dispatcher_id = null,
         claim_token = null,
         claimed_at = null,
         claim_expires_at = null,
         failed_at = command_now,
         last_error_code = 'MAX_ATTEMPTS_EXHAUSTED',
         last_error_summary = 'Configured outbox delivery attempt limit was exhausted',
         updated_at = command_now
   where delivery.state in ('pending', 'retry_scheduled', 'claimed')
     and (delivery.state <> 'claimed' or delivery.claim_expires_at <= command_now)
     and delivery.attempt_count >= requested_max_attempts;

  update integration.outbox_delivery_state delivery
     set state = 'failed_terminal',
         dispatcher_id = null,
         claim_token = null,
         claimed_at = null,
         claim_expires_at = null,
         failed_at = command_now,
         last_error_code = 'EVENT_ENVELOPE_MUTATED',
         last_error_summary = 'The immutable source event no longer matches its recorded digest',
         updated_at = command_now
    from integration.outbox_envelopes envelope
   where delivery.producer = envelope.producer
     and delivery.event_id = envelope.event_id
     and delivery.state <> 'delivered'
     and delivery.envelope_sha256 <> integration.outbox_envelope_sha256(
       envelope.producer, envelope.event_id, envelope.event_type, envelope.event_version,
       envelope.occurred_at, envelope.aggregate_type, envelope.aggregate_id,
       envelope.aggregate_version, envelope.correlation_id, envelope.causation_id,
       envelope.facility_id, envelope.patient_id, envelope.payload
     );

  return query
  with eligible as (
    select delivery.producer, delivery.event_id
      from integration.outbox_delivery_state delivery
     where delivery.attempt_count < requested_max_attempts
       and (
         (delivery.state in ('pending', 'retry_scheduled')
           and delivery.next_attempt_at <= command_now)
         or (delivery.state = 'claimed' and delivery.claim_expires_at <= command_now)
       )
     order by delivery.next_attempt_at, delivery.occurred_at,
       delivery.producer, delivery.event_id
     for update of delivery skip locked
     limit requested_batch_size
  ), claimed as (
    update integration.outbox_delivery_state delivery
       set state = 'claimed',
           dispatcher_id = requested_dispatcher_id,
           claim_token = gen_random_uuid(),
           claimed_at = command_now,
           claim_expires_at = command_now + make_interval(secs => requested_lease_seconds),
           attempt_count = delivery.attempt_count + 1,
           last_attempt_at = command_now,
           delivered_at = null,
           failed_at = null,
           updated_at = command_now
      from eligible
     where delivery.producer = eligible.producer
       and delivery.event_id = eligible.event_id
    returning delivery.*
  ), attempt_rows as (
    insert into integration.outbox_delivery_attempts as inserted_attempt (
      producer, event_id, attempt_no, claim_token, dispatcher_id, started_at
    )
    select claimed.producer, claimed.event_id, claimed.attempt_count,
      claimed.claim_token, requested_dispatcher_id, command_now
    from claimed
    returning inserted_attempt.producer, inserted_attempt.event_id
  )
  select envelope.producer, envelope.event_id, envelope.event_type,
    envelope.event_version, envelope.occurred_at, envelope.aggregate_type,
    envelope.aggregate_id, envelope.aggregate_version, envelope.correlation_id,
    envelope.causation_id, envelope.facility_id, envelope.patient_id,
    envelope.payload, claimed.attempt_count, claimed.claim_token,
    claimed.claim_expires_at
  from claimed
  join attempt_rows using (producer, event_id)
  join integration.outbox_envelopes envelope using (producer, event_id)
  order by envelope.occurred_at, envelope.producer, envelope.event_id;
end
$$;

create or replace function integration.record_outbox_delivered(
  event_producer text,
  stable_event_id uuid,
  active_claim_token uuid,
  delivery_transport text,
  accepted_message_id text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, integration
as $$
declare
  delivery integration.outbox_delivery_state%rowtype;
  command_now timestamptz := clock_timestamp();
begin
  if delivery_transport is null or length(delivery_transport) not between 2 and 80
     or accepted_message_id is null or length(accepted_message_id) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'Invalid delivered-event metadata';
  end if;
  select * into delivery
    from integration.outbox_delivery_state
   where producer = event_producer and event_id = stable_event_id
   for update;
  if not found or delivery.state <> 'claimed'
     or delivery.claim_token is distinct from active_claim_token
     or delivery.claim_expires_at <= command_now then
    raise exception using errcode = '55000', message = 'Outbox claim is stale or not owned';
  end if;

  update integration.outbox_delivery_state
     set state = 'delivered', dispatcher_id = null, claim_token = null,
         claimed_at = null, claim_expires_at = null, delivered_at = command_now,
         failed_at = null, transport_name = delivery_transport,
         transport_message_id = accepted_message_id,
         last_error_code = null, last_error_summary = null, updated_at = command_now
   where producer = event_producer and event_id = stable_event_id;
  update integration.outbox_delivery_attempts
     set completed_at = command_now, outcome = 'delivered',
         transport_name = delivery_transport, transport_message_id = accepted_message_id,
         duration_ms = greatest(0,
           floor(extract(epoch from (command_now - started_at)) * 1000)::bigint)
   where claim_token = active_claim_token and completed_at is null;
end
$$;

create or replace function integration.record_outbox_failure(
  event_producer text,
  stable_event_id uuid,
  active_claim_token uuid,
  delivery_transport text,
  failure_code text,
  failure_summary text,
  retryable boolean,
  requested_next_attempt_at timestamptz,
  requested_max_attempts integer
) returns text
language plpgsql
security definer
set search_path = pg_catalog, integration
as $$
declare
  delivery integration.outbox_delivery_state%rowtype;
  command_now timestamptz := clock_timestamp();
  next_state text;
begin
  if delivery_transport is null or length(delivery_transport) not between 2 and 80
     or failure_code is null or failure_code !~ '^[A-Z][A-Z0-9_]{1,79}$'
     or failure_summary is null or length(failure_summary) not between 1 and 500
     or requested_max_attempts not between 1 and 100
     or (retryable and (requested_next_attempt_at is null
       or requested_next_attempt_at < command_now
       or requested_next_attempt_at > command_now + interval '7 days')) then
    raise exception using errcode = '22023', message = 'Invalid outbox failure metadata';
  end if;
  select * into delivery
    from integration.outbox_delivery_state
   where producer = event_producer and event_id = stable_event_id
   for update;
  if not found or delivery.state <> 'claimed'
     or delivery.claim_token is distinct from active_claim_token
     or delivery.claim_expires_at <= command_now then
    raise exception using errcode = '55000', message = 'Outbox claim is stale or not owned';
  end if;

  next_state := case
    when retryable and delivery.attempt_count < requested_max_attempts
      then 'retry_scheduled'
    else 'failed_terminal'
  end;
  update integration.outbox_delivery_state
     set state = next_state, dispatcher_id = null, claim_token = null,
         claimed_at = null, claim_expires_at = null,
         next_attempt_at = case when next_state = 'retry_scheduled'
           then requested_next_attempt_at else next_attempt_at end,
         failed_at = case when next_state = 'failed_terminal' then command_now else null end,
         transport_name = delivery_transport, transport_message_id = null,
         last_error_code = failure_code, last_error_summary = failure_summary,
         updated_at = command_now
   where producer = event_producer and event_id = stable_event_id;
  update integration.outbox_delivery_attempts
     set completed_at = command_now, outcome = next_state,
         transport_name = delivery_transport, error_code = failure_code,
         error_summary = failure_summary,
         duration_ms = greatest(0,
           floor(extract(epoch from (command_now - started_at)) * 1000)::bigint)
   where claim_token = active_claim_token and completed_at is null;
  return next_state;
end
$$;

create or replace function integration.event_delivery_status()
returns table (
  pending_count bigint,
  claimed_count bigint,
  retry_scheduled_count bigint,
  delivered_count bigint,
  terminal_failure_count bigint,
  oldest_pending_age_seconds bigint,
  dispatch_success_count bigint,
  dispatch_failure_count bigint,
  retry_count bigint,
  average_dispatch_latency_ms numeric
)
language sql
volatile
security definer
set search_path = pg_catalog, integration
as $$
  select
    count(*) filter (where state = 'pending'),
    count(*) filter (where state = 'claimed'),
    count(*) filter (where state = 'retry_scheduled'),
    count(*) filter (where state = 'delivered'),
    count(*) filter (where state = 'failed_terminal'),
    coalesce(floor(extract(epoch from (
      clock_timestamp() - min(occurred_at) filter (
        where state in ('pending', 'claimed', 'retry_scheduled')
      )
    )))::bigint, 0),
    (select count(*) from integration.outbox_delivery_attempts where outcome = 'delivered'),
    (select count(*) from integration.outbox_delivery_attempts
      where outcome in ('retry_scheduled', 'failed_terminal', 'lease_expired')),
    (select count(*) from integration.outbox_delivery_attempts where outcome = 'retry_scheduled'),
    coalesce((select round(avg(duration_ms), 2)
      from integration.outbox_delivery_attempts where outcome = 'delivered'), 0)
  from integration.outbox_delivery_state
$$;

create table integration.inbox_messages (
  consumer_name text not null check (
    length(consumer_name) between 3 and 128
    and consumer_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
  ),
  event_id uuid not null,
  producer text not null check (producer in ('identity', 'ocr', 'lab', 'pharmacy', 'outreach')),
  event_type text not null check (event_type ~ '^[A-Z][A-Za-z0-9]{2,127}$'),
  event_version integer not null check (event_version between 1 and 1000),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  payload_sha256 char(64) not null,
  status text not null check (status in (
    'processing', 'processed', 'retry_scheduled', 'failed_terminal'
  )),
  claim_token uuid,
  claimed_by text,
  claim_expires_at timestamptz,
  received_at timestamptz not null default clock_timestamp(),
  attempt_count integer not null default 1 check (attempt_count between 1 and 100),
  processed_at timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,79}$'
  ),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (consumer_name, event_id),
  check (
    (status = 'processing') =
    (claim_token is not null and claimed_by is not null and claim_expires_at is not null)
  ),
  check (status <> 'processed' or processed_at is not null)
);

-- Consumer names are security identities, not caller-supplied namespaces.
-- Deployment administrators bind each logical consumer to its NOLOGIN group
-- role; login credentials then inherit that role. No product consumer is
-- invented or registered by this migration.
create table integration.inbox_consumers (
  consumer_name text primary key check (
    length(consumer_name) between 3 and 128
    and consumer_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
  ),
  database_role name not null,
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp()
);

create or replace function integration.assert_inbox_consumer_authorized(
  requested_consumer_name text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, integration
as $$
declare
  bound_role name;
begin
  select consumer.database_role into bound_role
    from integration.inbox_consumers consumer
   where consumer.consumer_name = requested_consumer_name
     and consumer.enabled;
  if not found or not pg_has_role(session_user, bound_role, 'member') then
    raise exception using
      errcode = '42501',
      message = 'Database principal is not authorized for the inbox consumer';
  end if;
end
$$;

create unique index integration_inbox_active_claim_token_idx
  on integration.inbox_messages (claim_token) where claim_token is not null;
create index integration_inbox_retry_idx
  on integration.inbox_messages (consumer_name, status, next_attempt_at, received_at);

create or replace function integration.claim_inbox_message(
  requested_consumer_name text,
  stable_event_id uuid,
  event_producer text,
  versioned_event_type text,
  versioned_event_version integer,
  event_correlation_id text,
  event_payload_sha256 char(64),
  requested_worker_id text,
  requested_lease_seconds integer
) returns table (claim_status text, claim_token uuid, attempt_count integer)
language plpgsql
security definer
set search_path = pg_catalog, integration
as $$
declare
  inbox integration.inbox_messages%rowtype;
  new_claim_token uuid := gen_random_uuid();
  command_now timestamptz := clock_timestamp();
begin
  if requested_consumer_name is null
     or length(requested_consumer_name) not between 3 and 128
     or requested_consumer_name !~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
     or event_producer not in ('identity', 'ocr', 'lab', 'pharmacy', 'outreach')
     or versioned_event_type !~ '^[A-Z][A-Za-z0-9]{2,127}$'
     or versioned_event_version not between 1 and 1000
     or event_correlation_id is null or length(event_correlation_id) not between 8 and 128
     or event_payload_sha256::text !~ '^[0-9a-f]{64}$'
     or requested_worker_id is null or length(requested_worker_id) not between 3 and 128
     or requested_lease_seconds not between 5 and 900 then
    raise exception using errcode = '22023', message = 'Invalid inbox claim request';
  end if;
  perform integration.assert_inbox_consumer_authorized(requested_consumer_name);

  insert into integration.inbox_messages (
    consumer_name, event_id, producer, event_type, event_version,
    correlation_id, payload_sha256, status, claim_token, claimed_by,
    claim_expires_at, received_at, attempt_count, next_attempt_at, updated_at
  ) values (
    requested_consumer_name, stable_event_id, event_producer, versioned_event_type,
    versioned_event_version, event_correlation_id, event_payload_sha256,
    'processing', new_claim_token, requested_worker_id,
    command_now + make_interval(secs => requested_lease_seconds), command_now, 1,
    command_now, command_now
  ) on conflict (consumer_name, event_id) do nothing
  returning * into inbox;

  if found then
    return query select 'claimed'::text, inbox.claim_token, inbox.attempt_count;
    return;
  end if;

  select * into inbox from integration.inbox_messages
   where consumer_name = requested_consumer_name and event_id = stable_event_id
   for update;
  if inbox.producer <> event_producer or inbox.event_type <> versioned_event_type
     or inbox.event_version <> versioned_event_version
     or inbox.correlation_id <> event_correlation_id
     or inbox.payload_sha256 <> event_payload_sha256 then
    raise exception using errcode = '23505', message = 'Inbox event identity conflicts with recorded contract';
  end if;
  if inbox.status = 'processed' then
    return query select 'already_processed'::text, null::uuid, inbox.attempt_count;
    return;
  end if;
  if inbox.status = 'failed_terminal' then
    return query select 'failed_terminal'::text, null::uuid, inbox.attempt_count;
    return;
  end if;
  if inbox.status = 'processing' and inbox.claim_expires_at > command_now then
    return query select 'busy'::text, null::uuid, inbox.attempt_count;
    return;
  end if;
  if inbox.status = 'retry_scheduled' and inbox.next_attempt_at > command_now then
    return query select 'retry_scheduled'::text, null::uuid, inbox.attempt_count;
    return;
  end if;

  update integration.inbox_messages as message
     set status = 'processing', claim_token = new_claim_token,
         claimed_by = requested_worker_id,
         claim_expires_at = command_now + make_interval(secs => requested_lease_seconds),
         attempt_count = message.attempt_count + 1, last_error_code = null,
         updated_at = command_now
   where message.consumer_name = requested_consumer_name
     and message.event_id = stable_event_id
   returning * into inbox;
  return query select 'claimed'::text, inbox.claim_token, inbox.attempt_count;
end
$$;

create or replace function integration.complete_inbox_message(
  requested_consumer_name text,
  stable_event_id uuid,
  active_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = pg_catalog, integration
as $$
declare
  command_now timestamptz := clock_timestamp();
begin
  perform integration.assert_inbox_consumer_authorized(requested_consumer_name);
  update integration.inbox_messages
     set status = 'processed', claim_token = null, claimed_by = null,
         claim_expires_at = null, processed_at = command_now,
         last_error_code = null, updated_at = command_now
   where consumer_name = requested_consumer_name and event_id = stable_event_id
     and status = 'processing' and claim_token = active_claim_token
     and claim_expires_at > command_now;
  if not found then
    raise exception using errcode = '55000', message = 'Inbox claim is stale or not owned';
  end if;
end
$$;

create or replace function integration.fail_inbox_message(
  requested_consumer_name text,
  stable_event_id uuid,
  active_claim_token uuid,
  failure_code text,
  retryable boolean,
  requested_next_attempt_at timestamptz,
  requested_max_attempts integer
) returns text
language plpgsql
security definer
set search_path = pg_catalog, integration
as $$
declare
  inbox integration.inbox_messages%rowtype;
  command_now timestamptz := clock_timestamp();
  next_status text;
begin
  if failure_code is null or failure_code !~ '^[A-Z][A-Z0-9_]{1,79}$'
     or requested_max_attempts not between 1 and 100
     or (retryable and (requested_next_attempt_at is null
       or requested_next_attempt_at < command_now
       or requested_next_attempt_at > command_now + interval '7 days')) then
    raise exception using errcode = '22023', message = 'Invalid inbox failure metadata';
  end if;
  perform integration.assert_inbox_consumer_authorized(requested_consumer_name);
  select * into inbox from integration.inbox_messages
   where consumer_name = requested_consumer_name and event_id = stable_event_id
   for update;
  if not found or inbox.status <> 'processing'
     or inbox.claim_token is distinct from active_claim_token
     or inbox.claim_expires_at <= command_now then
    raise exception using errcode = '55000', message = 'Inbox claim is stale or not owned';
  end if;
  next_status := case when retryable and inbox.attempt_count < requested_max_attempts
    then 'retry_scheduled' else 'failed_terminal' end;
  update integration.inbox_messages
     set status = next_status, claim_token = null, claimed_by = null,
         claim_expires_at = null,
         next_attempt_at = case when next_status = 'retry_scheduled'
           then requested_next_attempt_at else next_attempt_at end,
         last_error_code = failure_code, updated_at = command_now
   where consumer_name = requested_consumer_name and event_id = stable_event_id;
  return next_status;
end
$$;

revoke all on integration.outbox_envelopes,
  integration.outbox_delivery_state,
  integration.outbox_delivery_attempts,
  integration.inbox_consumers,
  integration.inbox_messages from public;
revoke all on all sequences in schema integration from public;
revoke all on all functions in schema integration from public;

comment on view integration.outbox_envelopes is
  'Normalized immutable versioned envelopes from the five active producer outboxes; EHR currently has no outbox producer.';
comment on table integration.outbox_delivery_state is
  'Mutable transport delivery state separate from immutable domain events. Delivered means transport accepted, not consumer processed.';
comment on table integration.outbox_delivery_attempts is
  'PHI-free append-only-safe delivery attempt metadata; provider response bodies are never stored.';
comment on table integration.inbox_messages is
  'Durable per-consumer event deduplication. Business effect and processed marker must share the consumer transaction.';
comment on table integration.inbox_consumers is
  'Administrator-provisioned binding from a logical consumer name to its database group role; intentionally empty until a real consumer exists.';
