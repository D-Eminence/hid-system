-- Novu receives the patient's verified login email (owner decision of
-- 2026-10-16, ADR-064), behind the worker flag NOVU_SUBSCRIBER_SYNC (off by
-- default, refused in production). The notification worker may learn that
-- address only for the outbox event it holds a live inbox claim on, and never
-- a name. Its login keeps no table privilege on Identity or Auth.
--
-- integration.notification_recipient_for_claim(event, claim token, patient)
-- belongs to the event-delivery technical owner once runtime-grants.sql has
-- moved it in that owner's CREATE window, and only hid_notification_worker
-- may execute it. It checks the worker's consumer authorization and claim as
-- complete_inbox_message does, binds the claim to the outbox envelope
-- (producer, type, version, correlation and patient) and answers from the
-- private helper below.
--
-- integration.notification_recipient_state(patient) stays with the
-- migration administrator, which owns identity.patients and auth.accounts,
-- so it reads them as their owner without BYPASSRLS (identity.patients
-- enables row-level security without forcing it; auth.accounts has none). Only
-- the technical owner may execute it, granted by runtime-grants.sql.
--
-- Both answer one of two rows, with no name:
--   ('email', <verified login email>) for an active patient who has
--     notifications on, whose login is active with a verified, non-blank
--     email;
--   ('withhold', null) otherwise: a phone-only login (0093/0094), an
--     unverified or blank email, no login, a login that is pending_reset,
--     locked, disabled or deleted, a patient who is not active, or
--     notifications off. The worker then clears any email Novu holds before
--     main's in-app trigger, so the opt-out holds after an earlier sync.
-- The claim function answers no row when the claim does not bind an outbox
-- event of that patient with a notification workflow.
--
-- No table, column, policy or role changes. Plain CREATE: a database that ran
-- the PR #8 branch's 0063 (whose functions return names) must be rebuilt or
-- reconciled first, and is refused here.

do $$
begin
  if to_regprocedure('integration.verified_notification_recipient(uuid)') is not null
     or to_regprocedure('integration.notification_recipient_for_claim(uuid,uuid,uuid)') is not null then
    raise exception using errcode = '55000', message = 'BRANCH_0063_NOTIFICATION_RECIPIENT_PRESENT',
      hint = 'Rebuild or reconcile the database (release checklist, migration order) before applying this migration.';
  end if;
end
$$;

create function integration.notification_recipient_state(requested_patient_id uuid)
returns table (delivery text, email text)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(recipient.delivery, 'withhold'), recipient.email
    from (select 1) one
    left join lateral (
      select 'email'::text as delivery, btrim(account.email) as email
        from identity.patients patient
        join auth.accounts account on account.id = patient.account_id
       where patient.id = requested_patient_id
         and patient.status = 'active'
         and patient.notifications_enabled
         and account.status = 'active'
         and account.email_verified_at is not null
         and btrim(coalesce(account.email, '')) <> ''
    ) recipient on true
$$;
revoke all on function integration.notification_recipient_state(uuid) from public;

create function integration.notification_recipient_for_claim(
  requested_event_id uuid,
  requested_claim_token uuid,
  requested_patient_id uuid
) returns table (delivery text, email text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  claimed integration.inbox_messages%rowtype;
begin
  perform integration.assert_inbox_consumer_authorized('notification-worker-v1');
  if not exists (
    select 1 from integration.inbox_consumers consumer
     where consumer.consumer_name = 'notification-worker-v1' and consumer.enabled
       and consumer.database_role = 'hid_notification_worker'::name
  ) then
    raise exception using errcode = '42501', message = 'Notification consumer authorization required';
  end if;
  select * into claimed from integration.inbox_messages inbox
   where inbox.consumer_name = 'notification-worker-v1' and inbox.event_id = requested_event_id
     and inbox.status = 'processing' and inbox.claim_token = requested_claim_token
     and inbox.claim_expires_at > clock_timestamp();
  if not found then
    raise exception using errcode = '55000', message = 'Inbox claim is stale or not owned';
  end if;
  return query
    select state.delivery, state.email
      from integration.outbox_envelopes envelope
     cross join lateral integration.notification_recipient_state(envelope.patient_id) state
     where envelope.event_id = requested_event_id
       and envelope.producer = claimed.producer
       and envelope.event_type = claimed.event_type
       and envelope.event_version = claimed.event_version
       and envelope.correlation_id = claimed.correlation_id
       and envelope.event_type in ('EmergencyAccessActivated', 'PatientAccessPinVerified',
         'PatientRegistered', 'PatientIdentityResolved', 'OcrPublicationSucceeded',
         'LabResultReleased', 'MedicationDispensed', 'OutreachPatientResolved')
       and envelope.patient_id = requested_patient_id;
end
$$;
revoke all on function integration.notification_recipient_for_claim(uuid, uuid, uuid) from public;

comment on function integration.notification_recipient_state(uuid) is
  'Private 0095 helper (ADR-064): email and the verified login email, or withhold; no name. Owned by the table owner; only the event-delivery technical owner executes it.';
comment on function integration.notification_recipient_for_claim(uuid, uuid, uuid) is
  'Notification worker only (ADR-064): the recipient answer for the outbox event of its live inbox claim; no arbitrary patient lookup and no name.';
