-- Resolve only the recipient of the worker's current canonical outbox event.
-- No direct auth/identity SELECT is added to the worker role. Its private
-- command owner is provisioned separately by runtime-grants.sql. A private
-- table-owner helper avoids granting identity/auth SELECT to that command role.
create function integration.verified_notification_recipient(requested_patient_id uuid)
returns table (id uuid, first_name text, last_name text, email text)
language sql stable security definer set search_path = pg_catalog
as $$
  select patient.id,patient.first_name,patient.last_name,account.email
  from identity.patients patient join auth.accounts account on account.id=patient.account_id
  where patient.id=requested_patient_id and patient.status='active'
    and patient.notifications_enabled and account.status='active'
    and account.email is not null and btrim(account.email)<>'' and account.email_verified_at is not null
$$;
revoke all on function integration.verified_notification_recipient(uuid) from public;
create function integration.notification_recipient_for_claim(
  requested_event_id uuid, requested_claim_token uuid, requested_patient_id uuid
) returns table (id uuid, first_name text, last_name text, email text)
language plpgsql security definer
set search_path = pg_catalog
as $$
declare claimed integration.inbox_messages%rowtype;
begin
  if not exists (
    select 1 from integration.inbox_consumers consumer
    where consumer.consumer_name = 'notification-worker-v1' and consumer.enabled
      and consumer.database_role = 'hid_notification_worker'::name
      and pg_has_role(session_user, consumer.database_role, 'member')
  ) then
    raise exception using errcode = '42501', message = 'Notification consumer authorization required';
  end if;
  select * into claimed from integration.inbox_messages inbox
  where inbox.consumer_name = 'notification-worker-v1' and inbox.event_id = requested_event_id
    and inbox.status = 'processing' and inbox.claim_token = requested_claim_token
    and inbox.claim_expires_at > clock_timestamp();
  if not found then
    raise exception using errcode = '55000', message = 'Notification claim is stale or not owned';
  end if;
  return query
    select recipient.id, recipient.first_name, recipient.last_name, recipient.email
    from integration.outbox_envelopes envelope
    cross join lateral integration.verified_notification_recipient(envelope.patient_id) recipient
    where envelope.event_id = requested_event_id and envelope.producer = claimed.producer
      and envelope.event_type = claimed.event_type and envelope.event_version = claimed.event_version
      and envelope.correlation_id = claimed.correlation_id
      and envelope.event_type in ('EmergencyAccessActivated', 'PatientAccessPinVerified',
        'PatientRegistered', 'PatientIdentityResolved', 'OcrPublicationSucceeded',
        'LabResultReleased', 'MedicationDispensed', 'OutreachPatientResolved')
      and envelope.patient_id = requested_patient_id;
end
$$;
revoke all on function integration.notification_recipient_for_claim(uuid,uuid,uuid) from public;
comment on function integration.notification_recipient_for_claim(uuid,uuid,uuid) is
  'Verified email for the active notification-worker claim; no arbitrary patient lookup or customer data in events/logs.';
