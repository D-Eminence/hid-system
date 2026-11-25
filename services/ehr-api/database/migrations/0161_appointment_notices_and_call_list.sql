-- 0161 APPT-1 Appointments: the patient's view, notices, reminders and the
-- call list (Release D, the department sprint the owner approved on 25
-- November 2026). Written on staging-novu-ci-20261005 at 95fa1e52 with 0160 of
-- this branch. The number is provisional, given at merge after the files
-- booked before it (0152-0154). It reads nothing 0152-0154 create or change.
-- The declaration in config/production-schema-compatibility.json stays
-- unsigned until the owner signs this file.
--
-- Decision taken at the recommended option, not yet answered by the owner:
-- Q-APPT-3 A (reminders by inbox, web push, email and the printable call list;
-- SMS built but switched off) and Q-APPT-7 A (the call list shows only the
-- phone this facility recorded for the patient: 0114 and 0130's facility
-- contacts; never the sign-in phone).
--
-- What it changes (nothing else):
-- B1 Notices. An AFTER INSERT trigger on ehr.appointment_events (kinds booked,
--    rescheduled and cancelled) calls notification.enqueue_patient_inbox_item
--    (0037) in the same transaction: APPOINTMENT_BOOKED,
--    APPOINTMENT_RESCHEDULED, APPOINTMENT_CANCELLED, resource type
--    appointment, the appointment id, and metadata { facilityName, startsAt }
--    only (never the clinic, clinician, reason or visit type). Web push follows
--    by 0097's poll; no new push trigger. A patient with no account gets
--    nothing (0037 already). No notice for check-in or no-show.
-- B2 Email. ehr.appointment_email_outbox: one row per inbox notice written
--    (B1 and B3). identity-api's notice sender drains it as system:auth, the
--    way it sends the "records were opened" emails (0095):
--    identity.appointment_email_claim leases rows and answers the patient's
--    verified email by 0063's rule (active patient with notices on, active
--    account, verified email; a row without one is closed as skipped), and
--    identity.appointment_email_record records delivered, retry or failed,
--    with one audit row each (notification.appointment-email.send). The email
--    is generic ("There is an update to your appointments. Sign in to Health
--    ID to see it."): no time, clinic, clinician or reason.
--    Not the event pipeline. The contract (APPT-1) planned a producer ehr on
--    integration.outbox_envelopes for the event-dispatcher and the
--    notification-worker. The worker would also need
--    integration.claim_inbox_message and
--    integration.notification_recipient_for_claim to accept the new producer
--    and event, and both are owned by hid_event_delivery_commands (the private
--    command owner runtime-grants.sql sets), so a migration run by the
--    NOSUPERUSER migrator cannot replace them. This path changes no
--    integration object, dispatcher or worker, and locks none of their tables.
-- B3 Reminders. ehr.appointment_send_reminders(batch) for the EHR runtime's
--    system transaction (system:auth): booked appointments that start within
--    the next 24 hours, have no reminder yet and were booked at least 12 hours
--    before their start; only between 07:00 and 21:00 Lagos (otherwise 0).
--    Each gets APPOINTMENT_REMINDER (inbox, then push and email as B1-B2),
--    reminder_sent_at, an SMS outbox row only while the control below is on,
--    and one system audit row (ehr.appointment.reminder) naming the channels.
-- B4 SMS, built but switched off. The control appointment_sms_reminders_enabled
--    is added and seeded OFF (the control_settings key CHECK and
--    platform.control_enabled carry the 11 existing keys plus this one: 0086's
--    rule; 0115 is the last file that set them, both md5-pinned).
--    ehr.appointment_sms_outbox gets a row only while it is on, and only for a
--    patient with a phone this facility recorded.
--    identity.appointment_sms_claim and identity.appointment_sms_record (system
--    actor, Identity runtime) are what identity-api's sender uses, only while
--    the control is on; each send is audited (notification.appointment-sms.send).
--    The fixed message: "Reminder: you have an appointment at {facility} on
--    {day} at {time}." No clinic or reason. Switching it on waits for the SMS
--    budget, the Termii sender ID and the DPO's NDPA notice.
-- B5 ehr.appointment_my_list(patient, when, limit, cursor) for route 12 (the
--    portal's read-only "My appointments"), EXECUTE hid_ehr_runtime: only in the
--    patient's own live session (ehr.patient_self_context, 0083); upcoming
--    (today, Lagos, onward, soonest first) or past (newest first); facility,
--    clinic and clinician names, times, visit type, the booking reason, status;
--    no staff ids, no booking basis. Audited (ehr.appointment.patient-read,
--    patient actor).
-- B6 identity.appointment_call_list(day, clinic, clinician) for route 11,
--    EXECUTE hid_identity_runtime (only Identity holds the contact key): the
--    session facility's booked appointments that day, for a member with
--    ehr.appointment.write, for direct care; each with the newest unerased phone
--    ciphertext this facility recorded for the patient and the registration case
--    it belongs to (the ciphertext's associated data), which identity-api
--    decrypts. No reason, visit type or date of birth. Audited
--    (identity.appointment-call-list.read and one .shown row per patient).
--
-- Locks (measured with pg_locks before commit and compared by the suite),
-- taken first, NOWAIT: ACCESS EXCLUSIVE on platform.control_settings (the
-- CHECK swap, the seed row and FORCE lifted for it, 0115's way; 11 rows);
-- SHARE ROW EXCLUSIVE on ehr.appointment_events (the trigger),
-- ehr.appointments, identity.patients and identity.facilities (the new
-- tables' foreign keys); ACCESS SHARE on identity.patient_facility_contacts,
-- identity.staff and auth.accounts (read by the functions) and auth.permissions
-- (read by the preconditions); ROW EXCLUSIVE on
-- audit.events (one system audit row, platform.control.add, for the control
-- seeded off). Nothing on notification.inbox_items or any integration table at
-- apply time. A Platform control read waits for the file (milliseconds), and so does
-- a request that books, changes or checks in an appointment (only the new
-- ehr-api makes one). The attempt is made 50 times, 100 ms
-- apart; one attempt when this transaction holds an earlier file's locks; then
-- 55P03 beginning "0161: " and ending "run the release again at a quieter
-- time" (the runner's dry-run retry), nothing applied.
--
-- Old images on this schema: nothing calls the new functions, and only the new
-- ehr-api books (so only it makes notices). An old identity-api drains nothing
-- (the emails wait until the new one runs); its Platform controls read the
-- 11 keys as before (platform.control_enabled keeps every answer it gave).
-- The production flag APPOINTMENTS_ENABLED stays off until the owner's go-live.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop B1-B6
-- and the control row, and put the pinned control CHECK and body back.
--
-- The whole file is one statement (do $appt0161$):
-- 0. The locks.
-- 1. Preconditions (55000, nothing applied): 0160 applied; "0161: already
--    applied" or "0161: the schema is not in the reviewed state"; the control
--    CHECK and the bodies it replaces or calls md5-pinned; exactly the 11
--    controls.
-- 2. B1-B6.
-- 3. Post-checks: platform.control_enabled minus its one change is the pinned
--    body, its owner, grants and settings unchanged; the control is off and
--    FORCE is as it was; exactly one audit row (platform.control.add, as the
--    system actor, naming the control key only); grants exactly as
--    runtime-grants.sql.

do $appt0161$
declare
  v_attempt integer := 0;
  v_holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  v_mismatch text;
  v_present integer;
  v_control_md5 constant text := '1d24fbded6edff32d934d319b0135fb2';
  v_control_old constant text := E'    ''outreach_organiser_signup_enabled''\n  ) then';
  v_control_new constant text := E'    ''outreach_organiser_signup_enabled'',''appointment_sms_reminders_enabled''\n  ) then';
  v_control_signature constant text := 'platform.control_enabled(text)';
  v_function_rows_before text;
  v_was_forced boolean;
  v_owner name;
  v_correlation constant text := '0161-appointment-notices-appt1';
begin
  -- 0160's tables are what this file locks first; without them there is nothing to lock (a catalog read only).
  if to_regclass('ehr.appointment_events') is null or to_regclass('ehr.appointments') is null then
    raise exception using errcode = '55000', message = '0161: 0160 must be applied first';
  end if;
  -- 0. The locks, NOWAIT.
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table platform.control_settings in access exclusive mode nowait;
  lock table ehr.appointment_events, ehr.appointments, identity.patients, identity.facilities
    in share row exclusive mode nowait;
  lock table identity.patient_facility_contacts, identity.staff, auth.accounts, auth.permissions
    in access share mode nowait;
  lock table audit.events in row exclusive mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0161: platform.control_settings or a table 0161 reads or writes (the appointments and their '
          || 'history, patients, facilities, facility contacts, staff, accounts, permissions and audit.events) is busy, and this transaction already holds an '
          || 'earlier migration''s locks, so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0161: platform.control_settings or a table 0161 reads or writes (the appointments and their '
          || 'history, patients, facilities, facility contacts, staff, accounts, permissions and audit.events) stayed busy for 5 seconds; nothing applied; run '
          || 'the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if to_regclass('ehr.appointment_events') is null or to_regclass('ehr.appointments') is null
     or to_regprocedure('ehr.appointment_check_in(uuid, bigint, boolean, text, text, text)') is null
     or not exists (select 1 from auth.permissions where code = 'ehr.appointment.write') then
    raise exception using errcode = '55000', message = '0161: 0160 must be applied first';
  end if;
  select count(*) into v_present
    from (values (to_regclass('ehr.appointment_email_outbox')::oid), (to_regclass('ehr.appointment_sms_outbox')::oid),
                 (to_regprocedure('ehr.appointment_send_reminders(integer)')::oid),
                 (to_regprocedure('ehr.appointment_my_list(uuid, text, integer, timestamptz, uuid)')::oid),
                 (to_regprocedure('identity.appointment_call_list(date, uuid, uuid)')::oid),
                 ((select 1::oid where exists (select 1 from pg_constraint
                                                where conrelid = 'platform.control_settings'::regclass
                                                  and conname = 'control_settings_control_key_check'
                                                  and pg_get_constraintdef(oid) like '%appointment_sms_reminders_enabled%'))))
         present(object_id)
   where present.object_id is not null;
  if v_present = 6
     and exists (select 1 from pg_trigger where tgrelid = 'ehr.appointment_events'::regclass
                  and tgname = 'appointment_events_notify') then
    raise exception using errcode = '55000', message = '0161: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from pg_trigger where tgrelid = 'ehr.appointment_events'::regclass
                 and tgname = 'appointment_events_notify') then
    raise exception using errcode = '55000', message = '0161: the schema is not in the reviewed state (part of 0161 is there); nothing applied';
  end if;

  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      (v_control_signature, v_control_md5),
      ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', '0b5689f31a3ce00f9313fe1e55244fad'),
      ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('integration.verified_notification_recipient(uuid)', 'efaab7b01d5773a7a63fbdee7eb18a40'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0161: these bodies are not as 0001-0160 left them: ' || v_mismatch;
  end if;
  if (select md5(pg_get_constraintdef(oid)) from pg_constraint where conrelid = 'platform.control_settings'::regclass
           and conname = 'control_settings_control_key_check')
       is distinct from md5('CHECK ((control_key = ANY (ARRAY[''patient_portal_enabled''::text, ''provider_portal_enabled''::text, ''outreach_portal_enabled''::text, ''maintenance_mode''::text, ''uploads_enabled''::text, ''break_glass_enabled''::text, ''provider_self_service_enabled''::text, ''staff_invitations_enabled''::text, ''cross_facility_orders_enabled''::text, ''cross_facility_route_access_enabled''::text, ''outreach_organiser_signup_enabled''::text])))') then
    raise exception using errcode = '55000', message = '0161: the control key CHECK is not as 0115 left it';
  end if;
  if (select position(v_control_old in prosrc) from pg_proc where oid = v_control_signature::regprocedure) = 0 then
    raise exception using errcode = '55000', message = '0161: a line this file changes is not where 0001-0160 left it';
  end if;
  select string_agg(row(proc.oid, proc.proowner, proc.proacl, obj_description(proc.oid, 'pg_proc'), proc.prosecdef,
                        proc.proconfig, proc.provolatile, proc.proargtypes, proc.prorettype)::text, ';' order by proc.oid)
    into v_function_rows_before
    from pg_proc proc
   where proc.oid = v_control_signature::regprocedure;

  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);

  -- B2. The email outbox (drained by identity-api).
  create table ehr.appointment_email_outbox (
    id uuid primary key default gen_random_uuid(),
    appointment_id uuid not null references ehr.appointments(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    patient_id uuid not null references identity.patients(id) on delete restrict,
    notice_code text not null
      check (notice_code in ('APPOINTMENT_BOOKED', 'APPOINTMENT_RESCHEDULED', 'APPOINTMENT_CANCELLED', 'APPOINTMENT_REMINDER')),
    created_at timestamptz not null default clock_timestamp(),
    state text not null default 'pending' check (state in ('pending', 'claimed', 'sent', 'failed', 'skipped')),
    attempt_count integer not null default 0 check (attempt_count between 0 and 5),
    claimed_by text check (claimed_by is null or length(claimed_by) between 3 and 128),
    claimed_until timestamptz,
    finished_at timestamptz,
    last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,80}$'),
    constraint appointment_email_outbox_claimed_ck
      check ((state = 'claimed') = (claimed_until is not null and claimed_by is not null)),
    constraint appointment_email_outbox_finished_ck
      check ((state in ('sent', 'failed', 'skipped')) = (finished_at is not null))
  );
  create index appointment_email_outbox_pending_idx on ehr.appointment_email_outbox (created_at, id)
    where state in ('pending', 'claimed');
  create index appointment_email_outbox_appointment_idx on ehr.appointment_email_outbox (appointment_id);
  create index appointment_email_outbox_patient_idx on ehr.appointment_email_outbox (patient_id);
  alter table ehr.appointment_email_outbox enable row level security;
  revoke all on ehr.appointment_email_outbox from public;
  comment on table ehr.appointment_email_outbox is
    '0161 (APPT-1): one generic appointment email per inbox notice, drained by identity-api (identity.appointment_email_claim and identity.appointment_email_record) to the patient''s verified email. Ids and the notice code only.';

  -- B4. The control, seeded OFF (0115's way: FORCE lifted only while this file reads and writes the rows, only if
  -- it is on, since the policies admit only platform administrators).
  select relation.relforcerowsecurity into v_was_forced
    from pg_class relation where relation.oid = 'platform.control_settings'::regclass;
  if v_was_forced then
    execute 'alter table platform.control_settings no force row level security';
  end if;
  if (select count(*) from platform.control_settings) <> 11
     or exists (select 1 from platform.control_settings where control_key = 'appointment_sms_reminders_enabled') then
    raise exception using errcode = '55000', message = '0161: platform.control_settings does not hold exactly the 11 controls 0001-0160 seed';
  end if;
  alter table platform.control_settings drop constraint control_settings_control_key_check;
  alter table platform.control_settings add constraint control_settings_control_key_check check (control_key in (
    'patient_portal_enabled', 'provider_portal_enabled', 'outreach_portal_enabled',
    'maintenance_mode', 'uploads_enabled', 'break_glass_enabled',
    'provider_self_service_enabled', 'staff_invitations_enabled',
    'cross_facility_orders_enabled', 'cross_facility_route_access_enabled',
    'outreach_organiser_signup_enabled', 'appointment_sms_reminders_enabled'
  ));
  insert into platform.control_settings (control_key, enabled, reason, updated_by)
  values ('appointment_sms_reminders_enabled', false,
    'Appointment SMS reminders ship off; on only after the SMS budget, the Termii sender ID and the DPO''s notice', null);
  execute replace(pg_get_functiondef(v_control_signature::regprocedure), v_control_old, v_control_new);
  if not exists (select 1 from platform.control_settings where control_key = 'appointment_sms_reminders_enabled' and not enabled)
     or (select count(*) from platform.control_settings) <> 12
     or platform.control_enabled('appointment_sms_reminders_enabled') then
    raise exception using errcode = '55000', message = '0161: post-check failed (the SMS control is not seeded off)';
  end if;
  if v_was_forced then
    execute 'alter table platform.control_settings force row level security';
  end if;
  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  ) values (
    v_correlation, 'system', 'platform.control.add', 'success', 'platform-control',
    'appointment_sms_reminders_enabled', 'healthcare-operations',
    'APPT-1 Appointments (Release D, recommended Q-APPT-3 A): SMS reminders built and switched off', 'migration',
    'hid-0161', jsonb_build_object('controlKey', 'appointment_sms_reminders_enabled', 'enabled', false,
      'migration', '0161', 'decision', 'Q-APPT-3 A (recommended option)'));

  create table ehr.appointment_sms_outbox (
    id uuid primary key default gen_random_uuid(),
    appointment_id uuid not null references ehr.appointments(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    patient_id uuid not null references identity.patients(id) on delete restrict,
    contact_id uuid not null,
    created_at timestamptz not null default clock_timestamp(),
    state text not null default 'pending' check (state in ('pending', 'claimed', 'sent', 'failed')),
    attempt_count integer not null default 0 check (attempt_count between 0 and 5),
    claimed_until timestamptz,
    sent_at timestamptz,
    last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,79}$'),
    constraint appointment_sms_outbox_claimed_ck check ((state = 'claimed') = (claimed_until is not null)),
    constraint appointment_sms_outbox_sent_ck check ((state = 'sent') = (sent_at is not null))
  );
  create unique index appointment_sms_outbox_one_ux on ehr.appointment_sms_outbox (appointment_id);
  create index appointment_sms_outbox_pending_idx on ehr.appointment_sms_outbox (created_at)
    where state in ('pending', 'claimed');
  create index appointment_sms_outbox_patient_idx on ehr.appointment_sms_outbox (patient_id);
  alter table ehr.appointment_sms_outbox enable row level security;
  revoke all on ehr.appointment_sms_outbox from public;
  comment on table ehr.appointment_sms_outbox is
    '0161 (APPT-1): reminder SMS to send, written only while appointment_sms_reminders_enabled is on (seeded off), only for a patient with a phone this facility recorded. identity-api drains it through identity.appointment_sms_claim and identity.appointment_sms_record.';

  -- B1. The notices, in the same transaction as the event.
  create function ehr.appointment_notice(requested_appointment_id uuid, requested_code text, requested_starts_at timestamptz)
  returns boolean
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    appointment_row ehr.appointments%rowtype;
    item uuid;
  begin
    select appointment.* into appointment_row from ehr.appointments appointment where appointment.id = requested_appointment_id;
    item := notification.enqueue_patient_inbox_item(appointment_row.patient_id, requested_code, 'appointment',
      appointment_row.id, jsonb_build_object(
        'facilityName', (select facility.name from identity.facilities facility where facility.id = appointment_row.facility_id),
        'startsAt', to_char(requested_starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    if item is null then
      return false;
    end if;
    insert into ehr.appointment_email_outbox (appointment_id, facility_id, patient_id, notice_code)
    values (appointment_row.id, appointment_row.facility_id, appointment_row.patient_id, requested_code);
    return true;
  end
  $fn$;
  revoke all on function ehr.appointment_notice(uuid, text, timestamptz) from public;
  comment on function ehr.appointment_notice(uuid, text, timestamptz) is
    '0161 (APPT-1): one patient notice: the inbox item (0037; push follows by 0097) and, when one was written, the email outbox row. Metadata facilityName and startsAt only. No role may execute it.';

  create function ehr.appointment_events_notify()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if new.kind = 'booked' then
      perform ehr.appointment_notice(new.appointment_id, 'APPOINTMENT_BOOKED', new.to_starts_at);
    elsif new.kind = 'rescheduled' then
      perform ehr.appointment_notice(new.appointment_id, 'APPOINTMENT_RESCHEDULED', new.to_starts_at);
    elsif new.kind = 'cancelled' then
      perform ehr.appointment_notice(new.appointment_id, 'APPOINTMENT_CANCELLED', new.from_starts_at);
    end if;
    return null;
  end
  $fn$;
  revoke all on function ehr.appointment_events_notify() from public;
  create trigger appointment_events_notify
    after insert on ehr.appointment_events
    for each row when (new.kind in ('booked', 'rescheduled', 'cancelled'))
    execute function ehr.appointment_events_notify();

  -- B3. Reminders.
  create function ehr.appointment_send_reminders(requested_batch integer)
  returns integer
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    due record;
    sent integer := 0;
    lagos_hour integer := extract(hour from (clock_timestamp() at time zone 'Africa/Lagos'))::integer;
    sms_on boolean;
    inboxed boolean;
    contact uuid;
    channels text[];
    correlation text := platform.current_correlation_id();
  begin
    if platform.current_actor_subject() is distinct from 'system:auth' or correlation is null then
      raise exception using errcode = '42501', message = 'APPOINTMENT_REMINDERS_SYSTEM_ONLY';
    end if;
    if requested_batch is null or requested_batch not between 1 and 500 then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    if lagos_hour < 7 or lagos_hour >= 21 then
      return 0;
    end if;
    -- An unreadable control counts as off (fail closed).
    begin
      sms_on := platform.control_enabled('appointment_sms_reminders_enabled');
    exception when others then
      sms_on := false;
    end;
    for due in
      select appointment.id, appointment.facility_id, appointment.patient_id
        from ehr.appointments appointment
       where appointment.status = 'booked' and appointment.reminder_sent_at is null
         and appointment.starts_at > clock_timestamp() and appointment.starts_at <= clock_timestamp() + interval '24 hours'
         and appointment.booked_at <= appointment.starts_at - interval '12 hours'
       order by appointment.starts_at, appointment.id
       limit requested_batch
       for update skip locked
    loop
      channels := array[]::text[];
      inboxed := ehr.appointment_notice(due.id, 'APPOINTMENT_REMINDER',
        (select appointment.starts_at from ehr.appointments appointment where appointment.id = due.id));
      if inboxed then
        channels := channels || array['inbox', 'email'];
      end if;
      if sms_on then
        select facility_contact.id into contact
          from identity.patient_facility_contacts facility_contact
         where facility_contact.patient_id = due.patient_id and facility_contact.facility_id = due.facility_id
           and facility_contact.erased_at is null and facility_contact.phone_ciphertext is not null
         order by facility_contact.created_at desc, facility_contact.id
         limit 1;
        if contact is not null then
          insert into ehr.appointment_sms_outbox (appointment_id, facility_id, patient_id, contact_id)
          values (due.id, due.facility_id, due.patient_id, contact);
          channels := channels || array['sms'];
        end if;
      end if;
      update ehr.appointments appointment set reminder_sent_at = clock_timestamp() where appointment.id = due.id;
      insert into audit.events (correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type,
        resource_id, purpose_of_use, provenance, source_system, details)
      values (correlation, 'system', due.facility_id, due.patient_id, 'ehr.appointment.reminder', 'success',
        'appointment', due.id::text, 'healthcare-operations', 'system', 'ehr-api',
        jsonb_build_object('channels', to_jsonb(channels)));
      sent := sent + 1;
    end loop;
    return sent;
  end
  $fn$;
  comment on function ehr.appointment_send_reminders(integer) is
    '0161 (APPT-1, Q-APPT-3 A): the reminder sweep, as system:auth only, between 07:00 and 21:00 Lagos: booked appointments that start within 24 hours, without a reminder, booked at least 12 hours before their start, at most the batch (1-500). Each gets APPOINTMENT_REMINDER (inbox, push, email), an SMS outbox row only while appointment_sms_reminders_enabled is on, reminder_sent_at, and one system audit row naming the channels. Answers how many.';
  revoke all on function ehr.appointment_send_reminders(integer) from public;

  -- B4. The SMS sender's two calls (identity-api, system:auth, only while the control is on).
  create function identity.appointment_sms_claim(requested_batch integer)
  returns table (sms_id uuid, facility_name text, starts_at timestamptz, registration_case_id uuid,
    phone_ciphertext bytea, key_version text)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  begin
    if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
      raise exception using errcode = '42501', message = 'APPOINTMENT_SMS_SYSTEM_ONLY';
    end if;
    if requested_batch is null or requested_batch not between 1 and 100 then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    -- An unreadable control counts as off (fail closed).
    begin
      if not platform.control_enabled('appointment_sms_reminders_enabled') then
        return;
      end if;
    exception when others then
      return;
    end;
    -- A reminder whose appointment is no longer booked (moved, cancelled, checked in) is closed unsent.
    update ehr.appointment_sms_outbox sms
       set state = 'failed', claimed_until = null, last_error_code = 'APPOINTMENT_NOT_BOOKED'
     where (sms.state = 'pending' or (sms.state = 'claimed' and sms.claimed_until < clock_timestamp()))
       and not exists (select 1 from ehr.appointments appointment
                        where appointment.id = sms.appointment_id and appointment.status = 'booked');
    return query
      with picked as (
        select sms.id from ehr.appointment_sms_outbox sms
         where (sms.state = 'pending' or (sms.state = 'claimed' and sms.claimed_until < clock_timestamp()))
           and sms.attempt_count < 5
         order by sms.created_at, sms.id
         limit requested_batch
         for update skip locked
      ), claimed as (
        update ehr.appointment_sms_outbox sms
           set state = 'claimed', claimed_until = clock_timestamp() + interval '5 minutes',
               attempt_count = sms.attempt_count + 1
          from picked where sms.id = picked.id
        returning sms.id, sms.appointment_id, sms.facility_id, sms.contact_id
      )
      select claimed.id, facility.name, appointment.starts_at, facility_contact.registration_case_id,
             facility_contact.phone_ciphertext, facility_contact.key_version
        from claimed
        join ehr.appointments appointment on appointment.id = claimed.appointment_id and appointment.status = 'booked'
        join identity.facilities facility on facility.id = claimed.facility_id
        join identity.patient_facility_contacts facility_contact
          on facility_contact.id = claimed.contact_id and facility_contact.erased_at is null;
  end
  $fn$;
  comment on function identity.appointment_sms_claim(integer) is
    '0161 (APPT-1): claims up to the batch (1-100) of reminder SMS for identity-api''s sender, as system:auth, only while appointment_sms_reminders_enabled is on (otherwise none). Each with the facility name, the start time and the facility-recorded phone ciphertext and its registration case (the associated data). Lapsed claims come back; at most 5 attempts. A reminder whose appointment is no longer booked is closed unsent (failed, APPOINTMENT_NOT_BOOKED).';
  revoke all on function identity.appointment_sms_claim(integer) from public;

  create function identity.appointment_sms_record(requested_sms_id uuid, requested_outcome text,
    requested_error_code text)
  returns void
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    sms_row ehr.appointment_sms_outbox%rowtype;
  begin
    if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
      raise exception using errcode = '42501', message = 'APPOINTMENT_SMS_SYSTEM_ONLY';
    end if;
    if requested_sms_id is null or requested_outcome not in ('sent', 'failed', 'retry')
       or (requested_error_code is not null and requested_error_code !~ '^[A-Z][A-Z0-9_]{1,79}$') then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    select sms.* into sms_row from ehr.appointment_sms_outbox sms where sms.id = requested_sms_id for update;
    if not found or sms_row.state <> 'claimed' then
      raise exception using errcode = '55000', message = 'APPOINTMENT_SMS_CLAIM_STALE';
    end if;
    update ehr.appointment_sms_outbox sms
       set state = case when requested_outcome = 'sent' then 'sent'
                        when requested_outcome = 'failed' or sms.attempt_count >= 5 then 'failed' else 'pending' end,
           claimed_until = null,
           sent_at = case when requested_outcome = 'sent' then clock_timestamp() end,
           last_error_code = requested_error_code
     where sms.id = requested_sms_id;
    insert into audit.events (correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type,
      resource_id, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'system', sms_row.facility_id, sms_row.patient_id,
      'notification.appointment-sms.send', case when requested_outcome = 'sent' then 'success' else 'failure' end,
      'appointment', sms_row.appointment_id::text, 'healthcare-operations', 'system', 'identity-api',
      jsonb_build_object('outcome', requested_outcome, 'errorCode', requested_error_code, 'attempt', sms_row.attempt_count));
  end
  $fn$;
  comment on function identity.appointment_sms_record(uuid, text, text) is
    '0161 (APPT-1): records one reminder SMS as sent, failed or to retry, as system:auth, with one audit row (notification.appointment-sms.send; never the phone or the message).';
  revoke all on function identity.appointment_sms_record(uuid, text, text) from public;

  -- B2. The email sender's two calls (identity-api, system:auth).
  create function identity.appointment_email_claim(requested_worker text, requested_limit integer,
    requested_lease_seconds integer)
  returns table (email_id uuid, recipient text, notice_code text, attempt_count integer)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  begin
    if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
      raise exception using errcode = '42501', message = 'APPOINTMENT_EMAIL_SYSTEM_ONLY';
    end if;
    if requested_worker is null or length(requested_worker) not between 3 and 128
       or requested_limit is null or requested_limit not between 1 and 50
       or requested_lease_seconds is null or requested_lease_seconds not between 30 and 900 then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    -- A row whose patient has no verified email (0063's rule) is closed as skipped, never sent.
    update ehr.appointment_email_outbox email
       set state = 'skipped', finished_at = clock_timestamp(), claimed_by = null, claimed_until = null,
           last_error_code = 'no_verified_recipient'
     where email.id in (
       select candidate.id from ehr.appointment_email_outbox candidate
        where (candidate.state = 'pending' or (candidate.state = 'claimed' and candidate.claimed_until < clock_timestamp()))
          and not exists (
            select 1 from identity.patients patient join auth.accounts account_row on account_row.id = patient.account_id
             where patient.id = candidate.patient_id and patient.status = 'active' and patient.notifications_enabled
               and account_row.status = 'active' and account_row.email is not null and btrim(account_row.email) <> ''
               and account_row.email_verified_at is not null)
        order by candidate.created_at, candidate.id
        limit requested_limit
        for update skip locked);
    return query
      with picked as (
        select candidate.id from ehr.appointment_email_outbox candidate
         where (candidate.state = 'pending' or (candidate.state = 'claimed' and candidate.claimed_until < clock_timestamp()))
           and candidate.attempt_count < 5
         order by candidate.created_at, candidate.id
         limit requested_limit
         for update skip locked
      ), claimed as (
        update ehr.appointment_email_outbox email
           set state = 'claimed', claimed_by = requested_worker,
               claimed_until = clock_timestamp() + make_interval(secs => requested_lease_seconds),
               attempt_count = email.attempt_count + 1
          from picked where email.id = picked.id
        returning email.id, email.patient_id, email.notice_code, email.attempt_count
      )
      select claimed.id, account_row.email, claimed.notice_code, claimed.attempt_count
        from claimed
        join identity.patients patient on patient.id = claimed.patient_id
        join auth.accounts account_row on account_row.id = patient.account_id;
  end
  $fn$;
  comment on function identity.appointment_email_claim(text, integer, integer) is
    '0161 (APPT-1): leases up to the limit (1-50) of appointment emails for identity-api''s sender, as system:auth, with the patient''s verified email by 0063''s rule; rows without one are closed as skipped. Lapsed leases come back; at most 5 attempts.';
  revoke all on function identity.appointment_email_claim(text, integer, integer) from public;

  create function identity.appointment_email_record(requested_email_id uuid, requested_worker text,
    requested_outcome text, requested_error_code text)
  returns text
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    email_row ehr.appointment_email_outbox%rowtype;
    next_state text;
  begin
    if platform.current_actor_subject() is distinct from 'system:auth' or platform.current_correlation_id() is null then
      raise exception using errcode = '42501', message = 'APPOINTMENT_EMAIL_SYSTEM_ONLY';
    end if;
    if requested_email_id is null or requested_worker is null
       or requested_outcome is null or requested_outcome not in ('delivered', 'retry', 'failed')
       or (requested_error_code is not null and requested_error_code !~ '^[a-z0-9_]{1,80}$') then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    select email.* into email_row from ehr.appointment_email_outbox email where email.id = requested_email_id for update;
    if not found or email_row.state <> 'claimed' or email_row.claimed_by is distinct from requested_worker then
      return 'stale';
    end if;
    next_state := case when requested_outcome = 'delivered' then 'sent'
                       when requested_outcome = 'failed' or email_row.attempt_count >= 5 then 'failed'
                       else 'pending' end;
    update ehr.appointment_email_outbox email
       set state = next_state, claimed_by = null, claimed_until = null,
           finished_at = case when next_state in ('sent', 'failed') then clock_timestamp() end,
           last_error_code = requested_error_code
     where email.id = requested_email_id;
    insert into audit.events (correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type,
      resource_id, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'system', email_row.facility_id, email_row.patient_id,
      'notification.appointment-email.send', case when next_state = 'sent' then 'success' else 'failure' end,
      'appointment', email_row.appointment_id::text, 'healthcare-operations', 'system', 'identity-api',
      jsonb_build_object('notice', email_row.notice_code, 'outcome', requested_outcome, 'state', next_state,
        'errorCode', requested_error_code, 'attempt', email_row.attempt_count));
    return case when next_state = 'sent' then 'delivered' else next_state end;
  end
  $fn$;
  comment on function identity.appointment_email_record(uuid, text, text, text) is
    '0161 (APPT-1): records one leased appointment email as delivered, to retry or failed (at most 5 attempts), as system:auth, with one audit row (notification.appointment-email.send; never the address). Answers delivered, pending, failed or stale.';
  revoke all on function identity.appointment_email_record(uuid, text, text, text) from public;

  -- B5. The patient's own appointments (route 12).
  create function ehr.appointment_my_list(requested_patient_id uuid, requested_when text, requested_limit integer,
    after_starts_at timestamptz, after_id uuid)
  returns table (appointment_id uuid, facility_name text, clinic_name text, department_code text, clinician_name text,
    starts_at timestamptz, ends_at timestamptz, length_minutes integer, visit_type text, reason text, status text,
    has_more boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    found_ids uuid[];
    shown_ids uuid[];
    more boolean;
    upcoming boolean := requested_when = 'upcoming';
  begin
    if requested_patient_id is null or not ehr.patient_self_context(requested_patient_id) then
      raise exception using errcode = '42501', message = 'PATIENT_SESSION_REQUIRED';
    end if;
    if requested_when is null or requested_when not in ('upcoming', 'past')
       or requested_limit is null or requested_limit not between 1 and 50
       or ((after_starts_at is null) <> (after_id is null)) then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    select array_agg(listed.id order by listed.position_no) into found_ids
      from (
        select appointment.id, row_number() over (
                 order by case when upcoming then appointment.starts_at end asc,
                          case when not upcoming then appointment.starts_at end desc,
                          case when upcoming then appointment.id end asc,
                          case when not upcoming then appointment.id end desc) as position_no
          from ehr.appointments appointment
         where appointment.patient_id = requested_patient_id
           and (case when upcoming then appointment.appointment_day >= today else appointment.appointment_day < today end)
           and (after_starts_at is null
                or (upcoming and (appointment.starts_at, appointment.id) > (after_starts_at, after_id))
                or (not upcoming and (appointment.starts_at, appointment.id) < (after_starts_at, after_id)))
         order by case when upcoming then appointment.starts_at end asc,
                  case when not upcoming then appointment.starts_at end desc,
                  case when upcoming then appointment.id end asc,
                  case when not upcoming then appointment.id end desc
         limit requested_limit + 1
      ) listed;
    more := coalesce(cardinality(found_ids), 0) > requested_limit;
    shown_ids := coalesce(found_ids[1:requested_limit], array[]::uuid[]);
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id, action, outcome,
      resource_type, resource_id, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'patient', platform.current_actor_subject(),
      nullif(current_setting('app.account_id', true), '')::uuid, requested_patient_id, 'ehr.appointment.patient-read',
      'success', 'appointment-list', null, 'patient-self', 'application', 'ehr-api',
      jsonb_build_object('when', requested_when, 'resultCount', cardinality(shown_ids), 'hasMore', more,
        'page', after_id is not null));
    return query
      select appointment.id, facility.name, clinic.name, appointment.department_code, staff.full_name,
             appointment.starts_at, appointment.ends_at, appointment.length_minutes, appointment.visit_type,
             appointment.reason, appointment.status, more
        from unnest(shown_ids) with ordinality ordering(id, ord_position)
        join ehr.appointments appointment on appointment.id = ordering.id
        join identity.facilities facility on facility.id = appointment.facility_id
        left join ehr.appointment_clinics clinic on clinic.id = appointment.clinic_id
        left join identity.staff_facility_memberships membership on membership.id = appointment.clinician_membership_id
        left join identity.staff staff on staff.id = membership.staff_id
       order by ordering.ord_position;
  end
  $fn$;
  comment on function ehr.appointment_my_list(uuid, text, integer, timestamptz, uuid) is
    '0161 (APPT-1, Q-APPT-4 A: read only): the signed-in patient''s own appointments at every facility, only in their own live session (ehr.patient_self_context): upcoming (today, Lagos, onward, soonest first) or past (newest first), at most 50 a page. Facility, clinic and clinician names, times, visit type, the booking reason and the status; no staff ids, no booking basis. Audited (ehr.appointment.patient-read, patient actor).';
  revoke all on function ehr.appointment_my_list(uuid, text, integer, timestamptz, uuid) from public;

  -- B6. The printable call list (route 11; Q-APPT-7 A).
  create function identity.appointment_call_list(requested_day date, requested_clinic_id uuid,
    requested_clinician_membership_id uuid)
  returns table (appointment_id uuid, patient_id uuid, starts_at timestamptz, clinic_name text,
    clinician_membership_id uuid, full_name text, health_id_last4 text, registration_case_id uuid,
    phone_ciphertext bytea, key_version text)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor_subject text := platform.current_actor_subject();
    actor_account uuid := auth.account_id_for_subject(actor_subject);
    actor_membership uuid := platform.current_membership_id();
    actor_facility uuid := platform.current_facility_id();
    actor_correlation text := platform.current_correlation_id();
    actor_purpose text := platform.current_purpose_of_use();
    actor_organization uuid;
    shown_ids uuid[];
  begin
    if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
       or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.appointment.write') then
      raise exception using errcode = '42501', message = 'APPOINTMENT_NOT_ALLOWED';
    end if;
    select membership.organization_id into actor_organization
      from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account
       and membership.facility_id = actor_facility and membership.active and membership.migration_hold_reason is null;
    if not found then
      raise exception using errcode = '42501', message = 'APPOINTMENT_NOT_ALLOWED';
    end if;
    if actor_purpose is distinct from 'direct-care' then
      raise exception using errcode = '22023', message = 'APPOINTMENT_DIRECT_CARE_ONLY';
    end if;
    if requested_day is null then
      raise exception using errcode = '22023', message = 'APPOINTMENT_INVALID';
    end if;
    select coalesce(array_agg(listed.id order by listed.starts_at, listed.booked_at, listed.id), array[]::uuid[])
      into shown_ids
      from (select appointment.id, appointment.starts_at, appointment.booked_at
              from ehr.appointments appointment
             where appointment.facility_id = actor_facility and appointment.appointment_day = requested_day
               and appointment.status = 'booked'
               and (requested_clinic_id is null or appointment.clinic_id = requested_clinic_id)
               and (requested_clinician_membership_id is null
                    or appointment.clinician_membership_id = requested_clinician_membership_id)
             order by appointment.starts_at, appointment.booked_at, appointment.id
             limit 500) listed;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (actor_correlation, 'staff', actor_subject, actor_account, actor_membership, actor_organization,
      actor_facility, null, 'identity.appointment-call-list.read', 'success', 'appointment-call-list', null,
      actor_purpose, 'application', 'identity-api',
      jsonb_build_object('day', requested_day, 'clinicId', requested_clinic_id,
        'clinicianMembershipId', requested_clinician_membership_id, 'resultCount', cardinality(shown_ids)));
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    select actor_correlation, 'staff', actor_subject, actor_account, actor_membership, actor_organization,
           actor_facility, appointment.patient_id, 'identity.appointment-call-list.shown', 'success', 'appointment',
           appointment.id::text, actor_purpose, 'application', 'identity-api', '{}'::jsonb
      from unnest(shown_ids) with ordinality ordering(id, ord_position)
      join ehr.appointments appointment on appointment.id = ordering.id
     order by ordering.ord_position;
    return query
      select appointment.id, appointment.patient_id, appointment.starts_at, clinic.name,
             appointment.clinician_membership_id, patient.full_name, right(patient.hid_code, 4),
             facility_contact.registration_case_id, facility_contact.phone_ciphertext, facility_contact.key_version
        from unnest(shown_ids) with ordinality ordering(id, ord_position)
        join ehr.appointments appointment on appointment.id = ordering.id
        join identity.patients patient on patient.id = appointment.patient_id
        left join ehr.appointment_clinics clinic on clinic.id = appointment.clinic_id
        left join lateral (
          select contact_row.registration_case_id, contact_row.phone_ciphertext, contact_row.key_version
            from identity.patient_facility_contacts contact_row
           where contact_row.patient_id = appointment.patient_id and contact_row.facility_id = actor_facility
             and contact_row.erased_at is null and contact_row.phone_ciphertext is not null
           order by contact_row.created_at desc, contact_row.id
           limit 1) facility_contact on true
       order by ordering.ord_position;
  end
  $fn$;
  comment on function identity.appointment_call_list(date, uuid, uuid) is
    '0161 (APPT-1, Q-APPT-7 A): the session facility''s booked appointments on one Lagos day (optionally one clinic or clinician), at most 500, for the printable call list: name, last 4 of the Health ID, time, clinic, clinician id, and the newest unerased phone this facility recorded (ciphertext and its registration case; Identity decrypts). No reason, visit type or date of birth. Needs ehr.appointment.write here, for direct care. Audited (identity.appointment-call-list.read and one .shown row per patient).';
  revoke all on function identity.appointment_call_list(date, uuid, uuid) from public;

  -- Owners and EXECUTE.
  if v_owner <> current_user then
    execute format('alter table ehr.appointment_email_outbox owner to %I', v_owner);
    execute format('alter table ehr.appointment_sms_outbox owner to %I', v_owner);
    execute format('alter function ehr.appointment_notice(uuid, text, timestamptz) owner to %I', v_owner);
    execute format('alter function ehr.appointment_events_notify() owner to %I', v_owner);
    execute format('alter function ehr.appointment_send_reminders(integer) owner to %I', v_owner);
    execute format('alter function ehr.appointment_my_list(uuid, text, integer, timestamptz, uuid) owner to %I', v_owner);
    execute format('alter function identity.appointment_sms_claim(integer) owner to %I', v_owner);
    execute format('alter function identity.appointment_sms_record(uuid, text, text) owner to %I', v_owner);
    execute format('alter function identity.appointment_email_claim(text, integer, integer) owner to %I', v_owner);
    execute format('alter function identity.appointment_email_record(uuid, text, text, text) owner to %I', v_owner);
    execute format('alter function identity.appointment_call_list(date, uuid, uuid) owner to %I', v_owner);
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.appointment_send_reminders(integer),
      ehr.appointment_my_list(uuid, text, integer, timestamptz, uuid) to hid_ehr_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.appointment_call_list(date, uuid, uuid),
      identity.appointment_sms_claim(integer), identity.appointment_sms_record(uuid, text, text),
      identity.appointment_email_claim(text, integer, integer),
      identity.appointment_email_record(uuid, text, text, text) to hid_identity_runtime;
  end if;

  -- 3. Post-checks.
  if (select md5(replace(prosrc, v_control_new, v_control_old)) from pg_proc
        where oid = v_control_signature::regprocedure) is distinct from v_control_md5
     or (select string_agg(row(proc.oid, proc.proowner, proc.proacl, obj_description(proc.oid, 'pg_proc'), proc.prosecdef,
                               proc.proconfig, proc.provolatile, proc.proargtypes, proc.prorettype)::text, ';' order by proc.oid)
           from pg_proc proc where proc.oid = v_control_signature::regprocedure) is distinct from v_function_rows_before then
    raise exception using errcode = '55000', message = '0161: post-check failed (platform.control_enabled is not its pinned body plus 0161''s one key)';
  end if;
  if (select relforcerowsecurity from pg_class where oid = 'platform.control_settings'::regclass)
     is distinct from v_was_forced then
    raise exception using errcode = '55000', message = '0161: post-check failed (platform.control_settings FORCE changed)';
  end if;
  if exists (select 1 from pg_class class_row, lateral aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) acl
              where class_row.oid in ('ehr.appointment_email_outbox'::regclass, 'ehr.appointment_sms_outbox'::regclass)
                and acl.grantee <> class_row.relowner)
     or (select count(*) from pg_class
          where oid in ('ehr.appointment_email_outbox'::regclass, 'ehr.appointment_sms_outbox'::regclass)
            and relrowsecurity) <> 2 then
    raise exception using errcode = '55000', message = '0161: post-check failed (a new table is granted to a role or lacks row-level security)';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in ('ehr.appointment_send_reminders(integer)'::regprocedure,
                                 'ehr.appointment_my_list(uuid, text, integer, timestamptz, uuid)'::regprocedure)
                and acl.grantee <> proc.proowner and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime'))
     or exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in ('identity.appointment_call_list(date, uuid, uuid)'::regprocedure,
                                 'identity.appointment_sms_claim(integer)'::regprocedure,
                                 'identity.appointment_sms_record(uuid, text, text)'::regprocedure,
                                 'identity.appointment_email_claim(text, integer, integer)'::regprocedure,
                                 'identity.appointment_email_record(uuid, text, text, text)'::regprocedure)
                and acl.grantee <> proc.proowner and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime'))
     or exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in ('ehr.appointment_notice(uuid, text, timestamptz)'::regprocedure,
                                 'ehr.appointment_events_notify()'::regprocedure)
                and acl.grantee <> proc.proowner)
     or (select count(*) from pg_proc
          where oid in ('ehr.appointment_send_reminders(integer)'::regprocedure,
                        'ehr.appointment_my_list(uuid, text, integer, timestamptz, uuid)'::regprocedure,
                        'identity.appointment_call_list(date, uuid, uuid)'::regprocedure,
                        'identity.appointment_sms_claim(integer)'::regprocedure,
                        'identity.appointment_sms_record(uuid, text, text)'::regprocedure,
                        'identity.appointment_email_claim(text, integer, integer)'::regprocedure,
                        'identity.appointment_email_record(uuid, text, text, text)'::regprocedure)
            and prosecdef and proconfig = array['search_path=pg_catalog, pg_temp']) <> 7 then
    raise exception using errcode = '55000', message = '0161: post-check failed (the functions'' security or grants)';
  end if;
  if (select count(*) from audit.events where correlation_id = v_correlation) <> 1 then
    raise exception using errcode = '55000', message = '0161: post-check failed (the audit row)';
  end if;
  raise notice '0161: appointment notices (inbox, push, email), reminders, the portal list and the call list installed; SMS reminders built and switched off.';
end
$appt0161$;
