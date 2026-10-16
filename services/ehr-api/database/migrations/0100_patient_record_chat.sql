-- Patient record chat (owner decision 1 of 2026-10-16). Applied migrations
-- before this one are immutable. This file never names its own migration
-- number or its ADR's, so renumbering either at merge changes only names.
--
-- A signed-in patient may ask a question about their own released records
-- (PatientRecordRelease in services/ehr-api) and get an answer from the
-- Claude API. The EHR service builds a minimised extract of the records the
-- patient already sees, sends it in one Messages API request and stores the
-- validated answer in the patient's own history. This migration adds the
-- storage, the abuse and cost limits and the runtime kill switch. Every gate
-- is off: the EHR flag RECORD_CHAT_PATIENT_ENABLED defaults to false and the
-- platform control seeded here is false.
--
-- 1. The platform control record_chat_enabled, seeded false: the step-up
--    administrator's runtime kill switch (POST /admin/controls). The
--    control_key CHECK of platform.control_settings, platform.control_enabled
--    and platform.admin_set_control each name the allowed keys, so all three
--    gain the eighth key. The CHECK is matched by content: exactly the seven
--    keys it holds since clinician self sign-up (0098), the six 0039 keys and
--    clinician_signup_enabled, and neither record_chat_enabled nor any other
--    key. Anything else stops this migration (55000) and changes nothing: a
--    migration that added another key must be listed here first, at rebase.
--    Every existing control row and its value is kept, clinician sign-up's
--    included; the CHECK, the read and the command keep every earlier key.
--    platform.control_enabled keeps its technical owner
--    (hid_platform_control_reader, runtime-grants.sql); the migration
--    administrator takes a temporary membership in it only to replace the
--    function, then drops it and checks that neither the owner nor a
--    membership changed. The row is inserted with forced row-level security
--    lifted for this transaction only, as 0091 changed control rows.
--
-- 2. The patient's own history: ehr.patient_chat_conversations (one per
--    patient) and ehr.patient_chat_messages (question, validated reply,
--    server-side source bindings). FORCE ROW LEVEL SECURITY; the only
--    policies admit SELECT, INSERT and DELETE in a fresh patient-self
--    transaction bound to that patient (ehr.patient_self_context, the 0091
--    binding). No UPDATE policy and no UPDATE privilege: a stored exchange
--    is never rewritten. Deleting the conversation deletes its messages.
--    Retention is an open owner decision: there is no expiry, no automatic
--    purge and no retention class; the patient deletes their history
--    (DELETE /api/v1/ehr/me/chat/history) and the service stores at most 50
--    exchanges per patient. A legal hold (platform.legal_holds, 0064) keeps
--    it: the delete policies admit a row only while no active hold names the
--    patient or the patient's account, through
--    ehr.record_chat_history_on_hold, a SECURITY DEFINER check owned by the
--    migration administrator that answers only the patient's own
--    patient-self transaction (true, held, for any other caller). A message's reply has a checked shape (status,
--    answer of 1-4000 characters, at most 8 blocks and 40 sources) and the
--    idempotency key follows the EHR rule (16-128 URL-safe characters),
--    unique per conversation.
--
-- 3. Abuse and cost limits, reached only through two SECURITY DEFINER
--    commands owned by the migration administrator, as 0049's QoreID quota:
--    no runtime role holds any privilege on ehr.record_chat_usage_counters,
--    ehr.record_chat_reservations or ehr.record_chat_daily_budget (forced
--    row-level security, policies that admit only the owner's commands).
--    - ehr.reserve_record_chat(audience, patient, tokens, daily budget)
--      proves the caller with ehr.patient_self_context (patient audience
--      only), reads the kill switch again (55000 RECORD_CHAT_PAUSED: turning
--      it off is atomic with the lease and the disclosure audit row the
--      caller's transaction commits), settles the caller's expired lease
--      (its reserved tokens count as used; a lease another transaction is
--      settling is skipped, and the budget moves only for a lease this call
--      settled, so a late settlement never counts a lease twice), refuses a
--      second unsettled lease of the account (P4091 RECORD_CHAT_BUSY),
--      counts the request against 10 an hour and 30 a day per account
--      (P4290 RECORD_CHAT_RATE_LIMITED, detail = seconds until the bucket
--      resets), and reserves the tokens against the daily budget, capped by
--      a hard ceiling of 20,000,000 (P5030 RECORD_CHAT_BUDGET_EXHAUSTED). A
--      lease lasts 60 seconds. Any refusal rolls back the whole call. At most
--      100 stale counter rows and 100 reservations older than two days
--      (settled, or abandoned by an account that never came back) are pruned
--      per call, skipping rows another call holds; these hold no PHI and no
--      text.
--    - ehr.settle_record_chat(reservation, input, output, cache read, cache
--      write, outcome) is run by the same patient-self binding, moves the
--      reserved tokens to used, and is idempotent (false when already
--      settled).
--    EXECUTE on both goes to hid_ehr_runtime only (runtime-grants.sql).
--
-- Not included: the staff audience and its tables, any embedding, chunk,
-- extraction or vector object, any Lab policy, any permission, any retention
-- class or purge command, any change to platform.legal_holds, and any change
-- to ehr.patient_self_context or to a record table's policies: chat reads
-- only through the patient release.
--
-- Locks, in order: platform.control_settings ACCESS EXCLUSIVE first (section
-- 1, in the order of a break-glass activation and of the role bootstrap),
-- then CREATE TABLE's SHARE ROW EXCLUSIVE on identity.patients for the
-- conversation's foreign key. Every lock is held to the commit and waits at
-- most the runner's 5 s lock timeout; a timeout rolls this migration back
-- whole, and it can be run again.

-- 1. The platform control.
lock table platform.control_settings in access exclusive mode;

do $$
declare
  matching record;
  matched integer := 0;
  constraint_name name;
begin
  for matching in
    select constraint_row.conname, pg_get_constraintdef(constraint_row.oid) as definition,
           array(select key_match[1] from regexp_matches(pg_get_constraintdef(constraint_row.oid),
             '''([a-z_]+)''', 'g') key_match order by 1) as control_keys
      from pg_constraint constraint_row
     where constraint_row.conrelid = 'platform.control_settings'::regclass
       and constraint_row.contype = 'c'
       and pg_get_constraintdef(constraint_row.oid) like '%control_key%'
  loop
    if matching.control_keys = array['break_glass_enabled', 'clinician_signup_enabled', 'maintenance_mode',
         'outreach_portal_enabled', 'patient_portal_enabled', 'provider_portal_enabled', 'uploads_enabled']::text[] then
      matched := matched + 1;
      constraint_name := matching.conname;
    else
      raise exception using errcode = '55000', message = format(
        'the record chat migration expected the seven control keys of 0039 and 0098 and found another control_key check: %s',
        matching.definition);
    end if;
  end loop;
  if matched <> 1 then
    raise exception using errcode = '55000', message = format(
      'the record chat migration expected one control_key check on platform.control_settings, found %s', matched);
  end if;
  execute format('alter table platform.control_settings drop constraint %I', constraint_name);
end
$$;

alter table platform.control_settings add constraint control_settings_control_key_check check (control_key in (
  'patient_portal_enabled', 'provider_portal_enabled', 'outreach_portal_enabled',
  'maintenance_mode', 'uploads_enabled', 'break_glass_enabled', 'clinician_signup_enabled', 'record_chat_enabled'
));

-- platform.control_enabled keeps its technical owner. The membership is taken
-- only when the current user is not the owner and lacks its privileges: a
-- chain migrated before the first role bootstrap owns the function itself,
-- and a superuser has every role's privileges. The owner's plain name is read
-- (pg_get_userbyid): a regrole cast quotes a name that needs quoting.
do $$
declare
  owner_name name;
begin
  select pg_get_userbyid(proc.proowner) into owner_name
    from pg_proc proc where proc.oid = 'platform.control_enabled(text)'::regprocedure;
  perform set_config('hid.record_chat_control_owner', owner_name, true);
  perform set_config('hid.record_chat_owner_grant', '', true);
  if owner_name <> current_user and not pg_has_role(current_user, owner_name, 'USAGE') then
    if not pg_has_role(current_user, owner_name, 'MEMBER WITH ADMIN OPTION') then
      raise exception 'the record chat migration needs ADMIN OPTION on % to replace platform.control_enabled', owner_name;
    end if;
    execute format('grant %I to current_user with inherit true, set false', owner_name);
    perform set_config('hid.record_chat_owner_grant', owner_name, true);
  end if;
end
$$;

-- 0098's body (0040's, with clinician sign-up's key), language, volatility,
-- security and search path, with the new key added. CREATE OR REPLACE keeps
-- the owner and the ACL (EXECUTE to PUBLIC).
create or replace function platform.control_enabled(requested_key text)
returns boolean
language plpgsql
stable
security definer
set search_path=platform,pg_catalog,pg_temp
as $$
declare enabled_state boolean;
begin
  if requested_key not in (
    'patient_portal_enabled','provider_portal_enabled','outreach_portal_enabled',
    'maintenance_mode','uploads_enabled','break_glass_enabled','clinician_signup_enabled','record_chat_enabled'
  ) then
    raise exception using errcode='22023', message='PLATFORM_CONTROL_INVALID';
  end if;

  select enabled into enabled_state
  from platform.control_settings
  where control_key = requested_key;

  if enabled_state is null then
    raise exception using errcode='55000', message='PLATFORM_CONTROL_UNAVAILABLE';
  end if;

  return enabled_state;
end
$$;

do $$
declare
  granted text := nullif(current_setting('hid.record_chat_owner_grant', true), '');
begin
  if granted is not null then
    execute format('revoke %I from current_user', granted);
  end if;
  if (select pg_get_userbyid(proc.proowner) from pg_proc proc
        where proc.oid = 'platform.control_enabled(text)'::regprocedure)
       <> current_setting('hid.record_chat_control_owner')
     or exists (
       select 1 from pg_auth_members membership
        where membership.member = (select role_row.oid from pg_roles role_row where role_row.rolname = current_user)
          and membership.roleid = (select proc.proowner from pg_proc proc
                                    where proc.oid = 'platform.control_enabled(text)'::regprocedure)
          and membership.roleid <> (select role_row.oid from pg_roles role_row where role_row.rolname = current_user)
          and (membership.inherit_option or membership.set_option)) then
    raise exception 'the record chat migration changed the owner of platform.control_enabled or left a temporary membership';
  end if;
end
$$;

-- 0098's body (0071's, with clinician sign-up's key) with the new key. Owned
-- by the migration administrator (the role bootstrap transfers only
-- control_enabled among the control functions).
create or replace function platform.admin_set_control(
 requested_key text, requested_enabled boolean, expected_version bigint, requested_reason text)
returns table(control_key text,enabled boolean,row_version bigint,replayed boolean)
language plpgsql security definer
set search_path=platform,auth,pg_temp
as $$
declare actor uuid:=platform.current_account_id(); current_row platform.control_settings%rowtype;
begin
 if not auth.account_has_platform_permission(actor,'platform.control.manage') then
   raise exception using errcode='42501',message='ADMIN_PERMISSION_DENIED';
 end if;
 if requested_key not in ('patient_portal_enabled','provider_portal_enabled','outreach_portal_enabled','maintenance_mode','uploads_enabled','break_glass_enabled','clinician_signup_enabled','record_chat_enabled')
    or requested_reason is null or length(btrim(requested_reason))<8 then
   raise exception using errcode='22023',message='ADMIN_INVALID_CONTROL';
 end if;
 select * into current_row from platform.control_settings setting
 where setting.control_key=requested_key for update;
 if current_row.row_version<>expected_version then
   raise exception using errcode='40001',message='ADMIN_VERSION_CONFLICT';
 end if;
 if current_row.enabled=requested_enabled then
   return query select current_row.control_key,current_row.enabled,current_row.row_version,true; return;
 end if;
 update platform.control_settings setting set enabled=requested_enabled,reason=btrim(requested_reason),
   row_version=setting.row_version+1,updated_by=actor,updated_at=clock_timestamp()
 where setting.control_key=requested_key returning setting.* into current_row;
 insert into platform.control_events(control_key,previous_enabled,enabled,reason,actor_account_id,correlation_id)
 values(current_row.control_key,not current_row.enabled,current_row.enabled,current_row.reason,actor,platform.current_correlation_id());
 return query select current_row.control_key,current_row.enabled,current_row.row_version,false;
end $$;

-- The seed, as 0091 section 1 changes control rows: forced row-level
-- security is lifted for this transaction only, since its policies need a
-- platform account, and restored before any other table is touched.
alter table platform.control_settings no force row level security;
insert into platform.control_settings (control_key, enabled, reason, updated_by)
values ('record_chat_enabled', false,
  'Off until an administrator turns on patient record chat (record chat decision)', null)
on conflict do nothing;
alter table platform.control_settings force row level security;

-- 2. The patient's own history.
create table ehr.patient_chat_conversations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references identity.patients(id),
  created_at timestamptz not null default clock_timestamp(),
  constraint patient_chat_conversations_patient_uq unique (patient_id),
  constraint patient_chat_conversations_id_patient_uq unique (id, patient_id)
);

create table ehr.patient_chat_messages (
  id uuid primary key,
  conversation_id uuid not null,
  patient_id uuid not null,
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
  constraint patient_chat_messages_conversation_fk foreign key (conversation_id, patient_id)
    references ehr.patient_chat_conversations(id, patient_id) on delete cascade,
  constraint patient_chat_messages_idempotency_uq unique (conversation_id, idempotency_key)
);
create index patient_chat_messages_patient_idx
  on ehr.patient_chat_messages(patient_id, created_at desc, id desc);

-- Whether an active legal hold keeps the patient's history: a hold on the
-- patient or on the account of the patient-self binding. Only that patient's
-- own patient-self transaction is answered; every other caller is told true
-- (held), so the check discloses nothing and fails closed inside the delete
-- policies. Stable, so both delete policies of one statement read one snapshot.
create function ehr.record_chat_history_on_hold(requested_patient uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  account uuid;
begin
  if requested_patient is null or not ehr.patient_self_context(requested_patient) then
    return true;
  end if;
  account := nullif(current_setting('app.account_id', true), '')::uuid;
  return exists (
    select 1 from platform.legal_holds hold
     where hold.released_at is null
       and ((hold.subject_type = 'patient' and hold.subject_id = requested_patient)
         or (hold.subject_type = 'account' and hold.subject_id = account)));
end
$$;
revoke all on function ehr.record_chat_history_on_hold(uuid) from public;

alter table ehr.patient_chat_conversations enable row level security;
alter table ehr.patient_chat_conversations force row level security;
alter table ehr.patient_chat_messages enable row level security;
alter table ehr.patient_chat_messages force row level security;

create policy patient_chat_conversations_self_read on ehr.patient_chat_conversations for select
  using (ehr.patient_self_context(patient_id));
create policy patient_chat_conversations_self_insert on ehr.patient_chat_conversations for insert
  with check (ehr.patient_self_context(patient_id));
create policy patient_chat_conversations_self_delete on ehr.patient_chat_conversations for delete
  using (ehr.patient_self_context(patient_id) and not ehr.record_chat_history_on_hold(patient_id));
create policy patient_chat_messages_self_read on ehr.patient_chat_messages for select
  using (ehr.patient_self_context(patient_id));
create policy patient_chat_messages_self_insert on ehr.patient_chat_messages for insert
  with check (ehr.patient_self_context(patient_id));
create policy patient_chat_messages_self_delete on ehr.patient_chat_messages for delete
  using (ehr.patient_self_context(patient_id) and not ehr.record_chat_history_on_hold(patient_id));

comment on table ehr.patient_chat_conversations is
  'A patient''s own record chat conversation; read, written and deleted only in that patient''s fresh patient-self transaction (record chat).';
comment on table ehr.patient_chat_messages is
  'A patient''s record chat exchanges: question, validated reply and server-side source bindings; never updated; retention is an open owner decision, the patient deletes them unless a legal hold keeps them (record chat).';
comment on function ehr.record_chat_history_on_hold(uuid) is
  'Whether an active legal hold names the patient or the account of the patient-self caller; true (held) for any other caller (record chat).';

-- 3. Abuse and cost limits. These tables hold account and patient ids,
-- counts and token numbers only: no name, contact, address or text.
create table ehr.record_chat_usage_counters (
  audience text not null check (audience in ('patient', 'staff')),
  account_id uuid not null,
  bucket_period text not null check (bucket_period in ('hour', 'day')),
  bucket_start timestamptz not null,
  request_count integer not null check (request_count between 1 and 100000),
  primary key (audience, account_id, bucket_period, bucket_start)
);
create index record_chat_usage_counters_age_idx on ehr.record_chat_usage_counters(bucket_start);

create table ehr.record_chat_reservations (
  id uuid primary key default gen_random_uuid(),
  audience text not null check (audience in ('patient', 'staff')),
  account_id uuid not null,
  patient_id uuid not null,
  reserved_tokens integer not null check (reserved_tokens between 1 and 1000000),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  settled_at timestamptz,
  outcome text check (outcome in ('answered', 'no_evidence', 'declined', 'unverified', 'failed',
    'sources_changed', 'conversation_changed', 'expired')),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  cache_read_tokens integer check (cache_read_tokens >= 0),
  cache_write_tokens integer check (cache_write_tokens >= 0),
  check (expires_at > created_at and expires_at <= created_at + interval '60 seconds'),
  check ((settled_at is null) = (outcome is null))
);
-- One unsettled lease per account and audience: a request in flight.
create unique index record_chat_reservations_in_flight_uq
  on ehr.record_chat_reservations(audience, account_id) where settled_at is null;
create index record_chat_reservations_age_idx on ehr.record_chat_reservations(created_at);

create table ehr.record_chat_daily_budget (
  day date primary key,
  reserved_tokens bigint not null default 0 check (reserved_tokens >= 0),
  used_tokens bigint not null default 0 check (used_tokens >= 0)
);

alter table ehr.record_chat_usage_counters enable row level security;
alter table ehr.record_chat_usage_counters force row level security;
alter table ehr.record_chat_reservations enable row level security;
alter table ehr.record_chat_reservations force row level security;
alter table ehr.record_chat_daily_budget enable row level security;
alter table ehr.record_chat_daily_budget force row level security;
-- The security-definer commands below are the only access path, as for 0049:
-- no application role, the schema-test role included, holds a privilege on
-- these tables, so these policies admit only the owner's commands.
create policy record_chat_usage_command_access on ehr.record_chat_usage_counters
  for all using (true) with check (true);
create policy record_chat_reservation_command_access on ehr.record_chat_reservations
  for all using (true) with check (true);
create policy record_chat_budget_command_access on ehr.record_chat_daily_budget
  for all using (true) with check (true);

create function ehr.reserve_record_chat(
  requested_audience text, requested_patient uuid, requested_tokens integer, requested_daily_budget bigint
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  hard_ceiling constant bigint := 20000000;
  hourly_max constant integer := 10;
  daily_max constant integer := 30;
  now_at timestamptz := statement_timestamp();
  today date := (statement_timestamp() at time zone 'UTC')::date;
  hour_start timestamptz := date_trunc('hour', statement_timestamp(), 'UTC');
  day_start timestamptz := date_trunc('day', statement_timestamp(), 'UTC');
  account uuid;
  counted integer;
  stale record;
  reservation uuid;
begin
  if requested_audience is distinct from 'patient' then
    raise exception using errcode = '22023', message = 'RECORD_CHAT_AUDIENCE_INVALID';
  end if;
  if requested_tokens is null or requested_tokens not between 1 and 1000000
     or requested_daily_budget is null or requested_daily_budget < 1 then
    raise exception using errcode = '22023', message = 'RECORD_CHAT_RESERVATION_INVALID';
  end if;
  -- The patient-self binding proves the caller: the named patient's own live
  -- session, account and subject, a fresh authorization (0091).
  if requested_patient is null or not ehr.patient_self_context(requested_patient) then
    raise exception using errcode = '42501', message = 'RECORD_CHAT_PERMISSION_DENIED';
  end if;
  account := current_setting('app.account_id', true)::uuid;
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

create function ehr.settle_record_chat(
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
  if not found or lease.audience <> 'patient' or not ehr.patient_self_context(lease.patient_id)
     or lease.account_id is distinct from current_setting('app.account_id', true)::uuid then
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

revoke all on function ehr.reserve_record_chat(text, uuid, integer, bigint) from public;
revoke all on function ehr.settle_record_chat(uuid, integer, integer, integer, integer, text) from public;
revoke all on ehr.patient_chat_conversations, ehr.patient_chat_messages, ehr.record_chat_usage_counters,
  ehr.record_chat_reservations, ehr.record_chat_daily_budget from public;

comment on function ehr.reserve_record_chat(text, uuid, integer, bigint) is
  'Record chat lease for the patient-self caller while record_chat_enabled is on: one in flight per account, 10 an hour and 30 a day, tokens against the daily budget (hard ceiling 20,000,000). 55000 RECORD_CHAT_PAUSED, P4091, P4290 (detail = retry seconds), P5030, 42501.';
comment on function ehr.settle_record_chat(uuid, integer, integer, integer, integer, text) is
  'Settles the patient-self caller''s own record chat lease with the usage reported by the processor; idempotent.';
