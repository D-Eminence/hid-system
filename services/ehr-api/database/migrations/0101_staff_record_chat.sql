-- Staff record chat (ADR-069). Applied migrations before this one are
-- immutable. This file never names its own migration number or its ADR's, so
-- renumbering either at merge changes only names.
--
-- A clinician who may read a patient's record for direct care may ask a
-- question about that patient and get an answer from the Claude API, as the
-- patient can about their own record (0100, ADR-068). The EHR service builds
-- a minimised extract of what that clinician may already read, sends it in
-- one Messages API request and stores the validated answer in the
-- clinician's own history of that patient. This migration adds the staff
-- permission, the staff history and the staff audience of the limit
-- commands. It adds no platform control: record_chat_enabled (0100) pauses
-- both audiences. The EHR flag RECORD_CHAT_STAFF_ENABLED defaults to false.
--
-- 1. The permission ehr.record-chat.use, held by doctor, clinician and nurse
--    (the roles that read notes). The route needs it, and the database
--    checks it again for every staff history row and every lease.
--
-- 2. ehr.staff_record_chat_context(patient): true only in a staff
--    transaction for direct care (a break-glass grant exists only for the
--    purpose emergency, so it never matches) with an active standard consent
--    of the selected membership at the selected facility
--    (ehr.context_allows) and the membership holding ehr.record-chat.use.
--    SECURITY DEFINER, owned by the migration administrator like
--    ehr.record_chat_history_on_hold, and it reads no table of its own: it
--    calls only ehr.context_allows and auth.membership_has_permission.
--
-- 3. The staff history: ehr.staff_record_chat_conversations (one per
--    patient, facility and staff account) and ehr.staff_record_chat_messages.
--    FORCE ROW LEVEL SECURITY; the only policies admit SELECT, INSERT and
--    DELETE to the staff account that owns the row, at the selected
--    facility, while ehr.staff_record_chat_context holds for the patient.
--    No UPDATE policy and no UPDATE privilege. A legal hold
--    (platform.legal_holds, 0064) on the patient or the staff account keeps
--    the history (ehr.staff_record_chat_history_on_hold). Nobody but the
--    staff member who asked reads it: not the patient, not another
--    clinician, not an administrator.
--
-- 4. ehr.reserve_record_chat and ehr.settle_record_chat (0100) are replaced,
--    keeping their signatures, owner and privileges, so the audience 'staff'
--    is accepted: the caller is proved by ehr.staff_record_chat_context, the
--    lease and the counters belong to the staff account, and the
--    proposed defaults are 20 questions an hour and 100 a day per staff
--    account (an open owner decision). The patient audience behaves exactly
--    as in 0100.
--
-- Not included: imported legacy history (never chat evidence, ADR-067), Lab
-- (no Lab policy; Lab results and requests are not staff chat evidence),
-- any embedding, chunk, extraction or vector object (not approved), any
-- retention class or purge command, and any change to a clinical record
-- table's policies: chat reads only what the staff routes already read.
--
-- Locks: the permission rows take row locks on auth.permissions and
-- auth.role_permissions, and the foreign keys take SHARE ROW EXCLUSIVE on
-- identity.patients, auth.accounts and identity.staff_facility_memberships,
-- until the migration commits. Each waits at most the runner's 5 s lock
-- timeout; a timeout rolls this migration back whole, and it can be run again.

-- 1. The permission.
insert into auth.permissions (code, description) values
  ('ehr.record-chat.use',
   'Ask the Claude API a question about one patient the member may read for direct care, with consent (ADR-069)')
on conflict (code) do update set description = excluded.description, active = true;
insert into auth.role_permissions (role_code, permission_code) values
  ('doctor', 'ehr.record-chat.use'),
  ('clinician', 'ehr.record-chat.use'),
  ('nurse', 'ehr.record-chat.use')
on conflict (role_code, permission_code) do nothing;

-- 2. The staff proof.
create function ehr.staff_record_chat_context(requested_patient uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    requested_patient is not null
    and platform.current_purpose_of_use() = 'direct-care'
    and platform.current_account_id() is not null
    and platform.current_membership_id() is not null
    and platform.current_facility_id() is not null
    and ehr.context_allows(requested_patient, platform.current_facility_id(), 'read_records')
    and auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
      platform.current_facility_id(), 'ehr.record-chat.use'),
    false)
$$;
revoke all on function ehr.staff_record_chat_context(uuid) from public;
comment on function ehr.staff_record_chat_context(uuid) is
  'True only for direct care with a standard consent at the selected facility and the membership holding ehr.record-chat.use; never under break-glass (ADR-069).';

-- Whether an active legal hold keeps the staff history of the patient: a hold
-- on the patient or on the staff account of the transaction. Only a staff
-- direct-care transaction is answered; every other caller is told true
-- (held), so the check fails closed inside the delete policies. Stable, so
-- both delete policies of one statement read one snapshot.
create function ehr.staff_record_chat_history_on_hold(requested_patient uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  account uuid := platform.current_account_id();
begin
  if requested_patient is null or account is null or platform.current_membership_id() is null
     or platform.current_purpose_of_use() is distinct from 'direct-care' then
    return true;
  end if;
  return exists (
    select 1 from platform.legal_holds hold
     where hold.released_at is null
       and ((hold.subject_type = 'patient' and hold.subject_id = requested_patient)
         or (hold.subject_type = 'account' and hold.subject_id = account)));
end
$$;
revoke all on function ehr.staff_record_chat_history_on_hold(uuid) from public;
comment on function ehr.staff_record_chat_history_on_hold(uuid) is
  'Whether an active legal hold names the patient or the staff account of a direct-care transaction; true (held) for any other caller (ADR-069).';

-- 3. The staff history.
create table ehr.staff_record_chat_conversations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references identity.patients(id),
  facility_id uuid not null,
  account_id uuid not null,
  membership_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint staff_record_chat_conversations_membership_fk foreign key (membership_id, facility_id, account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint staff_record_chat_conversations_scope_uq unique (patient_id, facility_id, account_id),
  constraint staff_record_chat_conversations_id_scope_uq unique (id, patient_id, facility_id, account_id)
);

create table ehr.staff_record_chat_messages (
  id uuid primary key,
  conversation_id uuid not null,
  patient_id uuid not null,
  facility_id uuid not null,
  account_id uuid not null,
  membership_id uuid not null,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  question text not null check (char_length(question) between 1 and 1000),
  reply jsonb not null check (
    jsonb_typeof(reply) = 'object'
    and reply->>'status' in ('answered', 'no_evidence', 'declined', 'unverified')
    and jsonb_typeof(reply->'answer') = 'string'
    and char_length(reply->>'answer') between 1 and 4000
    and jsonb_typeof(reply->'blocks') = 'array' and jsonb_array_length(reply->'blocks') <= 8
    and jsonb_typeof(reply->'sources') = 'array' and jsonb_array_length(reply->'sources') <= 40
  ),
  source_bindings jsonb not null check (
    jsonb_typeof(source_bindings) = 'array' and jsonb_array_length(source_bindings) <= 40
  ),
  created_at timestamptz not null default clock_timestamp(),
  constraint staff_record_chat_messages_conversation_fk foreign key (conversation_id, patient_id, facility_id, account_id)
    references ehr.staff_record_chat_conversations(id, patient_id, facility_id, account_id) on delete cascade,
  constraint staff_record_chat_messages_membership_fk foreign key (membership_id, facility_id, account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint staff_record_chat_messages_idempotency_uq unique (conversation_id, idempotency_key)
);
create index staff_record_chat_messages_scope_idx
  on ehr.staff_record_chat_messages(patient_id, facility_id, account_id, created_at desc, id desc);

alter table ehr.staff_record_chat_conversations enable row level security;
alter table ehr.staff_record_chat_conversations force row level security;
alter table ehr.staff_record_chat_messages enable row level security;
alter table ehr.staff_record_chat_messages force row level security;

create policy staff_record_chat_conversations_read on ehr.staff_record_chat_conversations for select
  using (facility_id = platform.current_facility_id() and account_id = platform.current_account_id()
    and ehr.staff_record_chat_context(patient_id));
create policy staff_record_chat_conversations_insert on ehr.staff_record_chat_conversations for insert
  with check (facility_id = platform.current_facility_id() and account_id = platform.current_account_id()
    and membership_id = platform.current_membership_id() and ehr.staff_record_chat_context(patient_id));
create policy staff_record_chat_conversations_delete on ehr.staff_record_chat_conversations for delete
  using (facility_id = platform.current_facility_id() and account_id = platform.current_account_id()
    and ehr.staff_record_chat_context(patient_id) and not ehr.staff_record_chat_history_on_hold(patient_id));
create policy staff_record_chat_messages_read on ehr.staff_record_chat_messages for select
  using (facility_id = platform.current_facility_id() and account_id = platform.current_account_id()
    and ehr.staff_record_chat_context(patient_id));
create policy staff_record_chat_messages_insert on ehr.staff_record_chat_messages for insert
  with check (facility_id = platform.current_facility_id() and account_id = platform.current_account_id()
    and membership_id = platform.current_membership_id() and ehr.staff_record_chat_context(patient_id));
create policy staff_record_chat_messages_delete on ehr.staff_record_chat_messages for delete
  using (facility_id = platform.current_facility_id() and account_id = platform.current_account_id()
    and ehr.staff_record_chat_context(patient_id) and not ehr.staff_record_chat_history_on_hold(patient_id));

revoke all on ehr.staff_record_chat_conversations, ehr.staff_record_chat_messages from public;
comment on table ehr.staff_record_chat_conversations is
  'A staff member''s record chat conversation about one patient at one facility; read, written and deleted only by that staff account in a direct-care transaction with consent and ehr.record-chat.use (ADR-069).';
comment on table ehr.staff_record_chat_messages is
  'A staff member''s record chat exchanges about one patient: question, validated reply and server-side source bindings; never updated; retention is an open owner decision, the staff member deletes them unless a legal hold keeps them (ADR-069).';

-- 4. The staff audience of the limit commands. Both keep their signature,
-- owner and privileges (CREATE OR REPLACE); the patient audience is
-- unchanged.
create or replace function ehr.reserve_record_chat(
  requested_audience text, requested_patient uuid, requested_tokens integer, requested_daily_budget bigint
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  hard_ceiling constant bigint := 20000000;
  hourly_max integer;
  daily_max integer;
  now_at timestamptz := statement_timestamp();
  today date := (statement_timestamp() at time zone 'UTC')::date;
  hour_start timestamptz := date_trunc('hour', statement_timestamp(), 'UTC');
  day_start timestamptz := date_trunc('day', statement_timestamp(), 'UTC');
  account uuid;
  counted integer;
  stale record;
  reservation uuid;
begin
  if requested_audience is null or requested_audience not in ('patient', 'staff') then
    raise exception using errcode = '22023', message = 'RECORD_CHAT_AUDIENCE_INVALID';
  end if;
  if requested_tokens is null or requested_tokens not between 1 and 1000000
     or requested_daily_budget is null or requested_daily_budget < 1 then
    raise exception using errcode = '22023', message = 'RECORD_CHAT_RESERVATION_INVALID';
  end if;
  -- The binding proves the caller. A patient: the named patient's own live
  -- session, account and subject, a fresh authorization (0091). Staff
  -- (ADR-069): direct care at the selected facility with a standard consent
  -- and the membership's ehr.record-chat.use, never break-glass
  -- (ehr.staff_record_chat_context).
  if requested_audience = 'patient' then
    if requested_patient is null or not ehr.patient_self_context(requested_patient) then
      raise exception using errcode = '42501', message = 'RECORD_CHAT_PERMISSION_DENIED';
    end if;
    account := current_setting('app.account_id', true)::uuid;
    hourly_max := 10;
    daily_max := 30;
  else
    if requested_patient is null or not ehr.staff_record_chat_context(requested_patient) then
      raise exception using errcode = '42501', message = 'RECORD_CHAT_PERMISSION_DENIED';
    end if;
    account := platform.current_account_id();
    hourly_max := 20;
    daily_max := 100;
  end if;
  -- The kill switch again, in the caller's transaction: a question that read
  -- it on before an administrator turned it off takes no lease, writes no
  -- disclosure audit row and is never sent.
  if not platform.control_enabled('record_chat_enabled') then
    raise exception using errcode = '55000', message = 'RECORD_CHAT_PAUSED';
  end if;

  -- Bounded pruning of operational rows (no PHI): counters older than 48
  -- hours and reservations older than 2 days (settled, or abandoned by an
  -- account that never came back: a 60-second lease that old has long
  -- expired and its day's budget is past), at most 100 each, skipping rows
  -- another call holds.
  delete from ehr.record_chat_usage_counters old
   where old.ctid in (select stale_row.ctid from ehr.record_chat_usage_counters stale_row
     where stale_row.bucket_start < now_at - interval '48 hours'
     order by stale_row.bucket_start limit 100 for update skip locked);
  delete from ehr.record_chat_reservations old
   where old.ctid in (select stale_row.ctid from ehr.record_chat_reservations stale_row
     where stale_row.created_at < now_at - interval '2 days'
     order by stale_row.created_at limit 100 for update skip locked);

  -- The caller's expired lease is settled as expired; its tokens count as
  -- used. A lease another transaction is settling (a late
  -- ehr.settle_record_chat) is skipped, and the budget moves only when this
  -- call's update settled the lease, so no lease is counted twice.
  for stale in
    select lease.id, lease.reserved_tokens, (lease.created_at at time zone 'UTC')::date as lease_day
      from ehr.record_chat_reservations lease
     where lease.audience = requested_audience and lease.account_id = account
       and lease.settled_at is null and lease.expires_at <= now_at
       for update skip locked
  loop
    update ehr.record_chat_reservations lease set settled_at = clock_timestamp(), outcome = 'expired'
     where lease.id = stale.id and lease.settled_at is null;
    if found then
      update ehr.record_chat_daily_budget budget
         set reserved_tokens = greatest(budget.reserved_tokens - stale.reserved_tokens, 0),
             used_tokens = budget.used_tokens + stale.reserved_tokens
       where budget.day = stale.lease_day;
    end if;
  end loop;

  if exists (select 1 from ehr.record_chat_reservations lease
              where lease.audience = requested_audience and lease.account_id = account
                and lease.settled_at is null) then
    raise exception using errcode = 'P4091', message = 'RECORD_CHAT_BUSY';
  end if;

  -- INSERT ... ON CONFLICT is atomic across API replicas. A raised refusal
  -- rolls back the increments and the reservation with it.
  insert into ehr.record_chat_usage_counters as counter
    (audience, account_id, bucket_period, bucket_start, request_count)
  values (requested_audience, account, 'hour', hour_start, 1)
  on conflict (audience, account_id, bucket_period, bucket_start)
  do update set request_count = counter.request_count + 1
  returning counter.request_count into counted;
  if counted > hourly_max then
    raise exception using errcode = 'P4290', message = 'RECORD_CHAT_RATE_LIMITED',
      detail = greatest(1, ceil(extract(epoch from (hour_start + interval '1 hour' - now_at))))::integer::text;
  end if;
  insert into ehr.record_chat_usage_counters as counter
    (audience, account_id, bucket_period, bucket_start, request_count)
  values (requested_audience, account, 'day', day_start, 1)
  on conflict (audience, account_id, bucket_period, bucket_start)
  do update set request_count = counter.request_count + 1
  returning counter.request_count into counted;
  if counted > daily_max then
    raise exception using errcode = 'P4290', message = 'RECORD_CHAT_RATE_LIMITED',
      detail = greatest(1, ceil(extract(epoch from (day_start + interval '1 day' - now_at))))::integer::text;
  end if;

  insert into ehr.record_chat_daily_budget(day) values (today) on conflict (day) do nothing;
  update ehr.record_chat_daily_budget budget
     set reserved_tokens = budget.reserved_tokens + requested_tokens
   where budget.day = today
     and budget.reserved_tokens + budget.used_tokens + requested_tokens
         <= least(requested_daily_budget, hard_ceiling);
  if not found then
    raise exception using errcode = 'P5030', message = 'RECORD_CHAT_BUDGET_EXHAUSTED';
  end if;

  begin
    insert into ehr.record_chat_reservations(audience, account_id, patient_id, reserved_tokens, created_at, expires_at)
    values (requested_audience, account, requested_patient, requested_tokens, now_at, now_at + interval '60 seconds')
    returning id into reservation;
  exception when unique_violation then
    raise exception using errcode = 'P4091', message = 'RECORD_CHAT_BUSY';
  end;
  return reservation;
end
$$;

create or replace function ehr.settle_record_chat(
  requested_reservation uuid, requested_input_tokens integer, requested_output_tokens integer,
  requested_cache_read_tokens integer, requested_cache_write_tokens integer, requested_outcome text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  lease record;
begin
  if requested_outcome is null or requested_outcome not in ('answered', 'no_evidence', 'declined', 'unverified',
       'failed', 'sources_changed', 'conversation_changed')
     or coalesce(requested_input_tokens, 0) not between 0 and 10000000
     or coalesce(requested_output_tokens, 0) not between 0 and 10000000
     or coalesce(requested_cache_read_tokens, 0) not between 0 and 10000000
     or coalesce(requested_cache_write_tokens, 0) not between 0 and 10000000 then
    raise exception using errcode = '22023', message = 'RECORD_CHAT_SETTLEMENT_INVALID';
  end if;
  select reservation.id, reservation.audience, reservation.account_id, reservation.patient_id,
         reservation.reserved_tokens, reservation.settled_at,
         (reservation.created_at at time zone 'UTC')::date as lease_day
    into lease
    from ehr.record_chat_reservations reservation
   where reservation.id = requested_reservation
     for update;
  if not found
     or (lease.audience = 'patient' and not (ehr.patient_self_context(lease.patient_id)
           and lease.account_id is not distinct from current_setting('app.account_id', true)::uuid))
     or (lease.audience = 'staff' and not (ehr.staff_record_chat_context(lease.patient_id)
           and lease.account_id is not distinct from platform.current_account_id()))
     or lease.audience not in ('patient', 'staff') then
    raise exception using errcode = '42501', message = 'RECORD_CHAT_PERMISSION_DENIED';
  end if;
  if lease.settled_at is not null then
    return false;
  end if;
  update ehr.record_chat_reservations reservation
     set settled_at = clock_timestamp(), outcome = requested_outcome,
         input_tokens = coalesce(requested_input_tokens, 0), output_tokens = coalesce(requested_output_tokens, 0),
         cache_read_tokens = coalesce(requested_cache_read_tokens, 0),
         cache_write_tokens = coalesce(requested_cache_write_tokens, 0)
   where reservation.id = lease.id;
  update ehr.record_chat_daily_budget budget
     set reserved_tokens = greatest(budget.reserved_tokens - lease.reserved_tokens, 0),
         used_tokens = budget.used_tokens + coalesce(requested_input_tokens, 0)::bigint
           + coalesce(requested_output_tokens, 0) + coalesce(requested_cache_read_tokens, 0)
           + coalesce(requested_cache_write_tokens, 0)
   where budget.day = lease.lease_day;
  return true;
end
$$;

comment on function ehr.reserve_record_chat(text, uuid, integer, bigint) is
  'Record chat lease for the patient-self caller (10 an hour, 30 a day) or the staff direct-care caller (20 an hour, 100 a day, proposed) while record_chat_enabled is on: one in flight per account, tokens against the daily budget (hard ceiling 20,000,000). 55000 RECORD_CHAT_PAUSED, P4091, P4290 (detail = retry seconds), P5030, 42501.';
comment on function ehr.settle_record_chat(uuid, integer, integer, integer, integer, text) is
  'Settles the caller''s own record chat lease (patient-self or staff direct-care) with the usage reported by the processor; idempotent.';
