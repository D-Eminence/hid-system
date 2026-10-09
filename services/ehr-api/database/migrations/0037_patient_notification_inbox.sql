-- Durable in-app notification inbox owned by Identity.
-- The inbox stores notification codes and non-PHI routing metadata. Message
-- presentation remains a frontend concern and no OTP/clinical content is stored.
create table notification.inbox_items (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.accounts(id) on delete restrict,
  patient_id uuid references identity.patients(id) on delete restrict,
  notification_code text not null check (notification_code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  resource_type text check (resource_type is null or resource_type ~ '^[a-z][a-z0-9._:-]{1,63}$'),
  resource_id uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  read_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create index notification_inbox_account_idx on notification.inbox_items(account_id, created_at desc, id desc);
create index notification_inbox_unread_idx on notification.inbox_items(account_id, created_at desc, id desc)
  where read_at is null;
revoke all on notification.inbox_items from public;
alter default privileges in schema notification revoke all on tables from public;

create or replace function notification.enqueue_patient_inbox_item(
  requested_patient_id uuid,
  requested_code text,
  requested_resource_type text,
  requested_resource_id uuid,
  requested_metadata jsonb
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, notification, identity, auth, pg_temp
as $$
declare
  recipient_account uuid;
  item_id uuid;
begin
  select account_id into recipient_account from identity.patients
    where id = requested_patient_id and status = 'active' and account_id is not null;
  if recipient_account is null then return null; end if;
  insert into notification.inbox_items(account_id,patient_id,notification_code,resource_type,resource_id,metadata)
    values(recipient_account,requested_patient_id,requested_code,requested_resource_type,
      requested_resource_id,coalesce(requested_metadata,'{}'::jsonb))
    returning id into item_id;
  return item_id;
end
$$;
revoke all on function notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb) from public;

create or replace function notification.on_identity_access_request_created()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, notification, pg_temp
as $$
begin
  if new.break_glass = false and new.migration_hold_reason is null then
    perform notification.enqueue_patient_inbox_item(
      new.patient_id, 'ACCESS_REQUEST_RECEIVED', 'access-request', new.id,
      jsonb_build_object('scope', new.scope, 'purposeOfUse', new.purpose_of_use,
        'requestedDurationMinutes', new.requested_duration_minutes));
  end if;
  return new;
end
$$;
revoke all on function notification.on_identity_access_request_created() from public;
create trigger access_request_notification_inbox
  after insert on identity.access_requests
  for each row execute function notification.on_identity_access_request_created();

create or replace function notification.on_identity_emergency_outbox_created()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, notification, pg_temp
as $$
begin
  if new.event_type = 'EmergencyAccessActivated' then
    perform notification.enqueue_patient_inbox_item(
      new.patient_id, 'EMERGENCY_ACCESS_ACTIVATED', 'consent-grant', new.aggregate_id,
      jsonb_build_object('consentGrantId', new.aggregate_id, 'reviewRequired', true));
  end if;
  return new;
end
$$;
revoke all on function notification.on_identity_emergency_outbox_created() from public;
create trigger emergency_notification_inbox
  after insert on identity.outbox_events
  for each row execute function notification.on_identity_emergency_outbox_created();

create or replace function identity.list_my_notification_inbox(requested_limit integer default 50)
returns table(
  id uuid, notification_code text, resource_type text, resource_id uuid,
  metadata jsonb, read_at timestamptz, created_at timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, notification, identity, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  bounded_limit integer := least(greatest(coalesce(requested_limit,50),1),100);
begin
  if actor_account is null then raise exception using errcode='42501', message='PATIENT_SESSION_REQUIRED'; end if;
  return query select item.id,item.notification_code,item.resource_type,item.resource_id,
    item.metadata,item.read_at,item.created_at
  from notification.inbox_items item
  where item.account_id = actor_account
  order by item.created_at desc,item.id desc
  limit bounded_limit;
end
$$;
revoke all on function identity.list_my_notification_inbox(integer) from public;

create or replace function identity.mark_my_notification_read(requested_id uuid)
returns table(id uuid, read_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, notification, identity, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  marked_at timestamptz := clock_timestamp();
begin
  if actor_account is null then raise exception using errcode='42501', message='PATIENT_SESSION_REQUIRED'; end if;
  update notification.inbox_items item set read_at = coalesce(item.read_at, marked_at)
    where item.id = requested_id and item.account_id = actor_account;
  if not found then raise exception using errcode='P0002', message='NOTIFICATION_NOT_FOUND'; end if;
  return query select item.id,item.read_at from notification.inbox_items item where item.id=requested_id;
end
$$;
revoke all on function identity.mark_my_notification_read(uuid) from public;
