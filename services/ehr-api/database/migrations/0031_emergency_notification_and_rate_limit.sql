-- Emergency activation: bounded abuse protection and atomic minimum-necessary notification intent.
-- Existing registration-event foreign-key guarantees remain enforced through
-- event-specific generated references; no ungoverned aggregate is accepted.
alter table identity.outbox_events drop constraint outbox_events_event_type_check;
alter table identity.outbox_events add constraint outbox_events_event_type_check
  check (event_type in ('PatientRegistered', 'PatientIdentifierAdded', 'PatientIdentityResolved', 'EmergencyAccessActivated'));
alter table identity.outbox_events
  add column registration_case_id uuid generated always as
    (case when event_type <> 'EmergencyAccessActivated' then aggregate_id end) stored
    references identity.registration_cases(id) on delete restrict,
  add column emergency_grant_id uuid generated always as
    (case when event_type = 'EmergencyAccessActivated' then aggregate_id end) stored
    references identity.consent_grants(id) on delete restrict;
alter table identity.outbox_events drop constraint outbox_events_aggregate_id_fkey;
alter table identity.outbox_events add constraint emergency_outbox_minimum_necessary
  check (event_type <> 'EmergencyAccessActivated' or (
    aggregate_version = 1
    and payload = jsonb_build_object('consentGrantId', aggregate_id, 'reviewRequired', true)
  ));

create policy identity_outbox_emergency_insert on identity.outbox_events for insert
  with check (
    event_type = 'EmergencyAccessActivated'
    and facility_id = platform.current_facility_id()
    and auth.membership_has_permission(platform.current_actor_subject(),
      platform.current_membership_id(), facility_id, 'identity.break-glass.write')
    and exists (select 1 from identity.consent_grants grant_row
      where grant_row.id = identity.outbox_events.aggregate_id
        and grant_row.patient_id = identity.outbox_events.patient_id
        and grant_row.facility_id = identity.outbox_events.facility_id
        and grant_row.membership_id = platform.current_membership_id()
        and grant_row.account_id = auth.account_id_for_subject(platform.current_actor_subject())
        and grant_row.break_glass and grant_row.scope = 'break_glass'
        and grant_row.purpose_of_use = 'emergency')
  );

create or replace function identity.activate_break_glass(
  requested_hid text,
  requested_reason text,
  requested_duration_minutes integer
)
returns table (
  access_request_id uuid,
  consent_grant_id uuid,
  subject_patient_id uuid,
  grant_status text,
  expires_at timestamptz,
  existing_grant boolean
)
language plpgsql
security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  actor_correlation_id text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_staff_id uuid;
  actor_organization_id uuid;
  patient_id_value uuid;
  request_id_value uuid;
  grant_id_value uuid;
  grant_expires_at timestamptz;
  replayed boolean := false;
begin
  if actor_account_id is null
     or actor_membership_id is null
     or actor_facility_id is null
     or actor_correlation_id is null
     or not auth.membership_has_permission(
       actor_subject, actor_membership_id, actor_facility_id, 'identity.break-glass.write'
     ) then
    raise exception using errcode = '42501', message = 'Authorized break-glass context is required';
  end if;
  if actor_purpose is distinct from 'emergency'
     or not exists (
       select 1 from identity.purpose_of_use_codes purpose
       where purpose.code = 'emergency' and purpose.active
     ) then
    raise exception using errcode = '22023', message = 'Break-glass requires the emergency purpose of use';
  end if;
  if requested_duration_minutes is null or requested_duration_minutes not between 5 and 240 then
    raise exception using errcode = '22023', message = 'Invalid break-glass duration';
  end if;
  if length(coalesce(btrim(requested_reason), '')) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'An explicit break-glass reason is required';
  end if;

  select membership.staff_id, membership.organization_id
    into actor_staff_id, actor_organization_id
  from identity.staff_facility_memberships membership
  where membership.id = actor_membership_id
    and membership.account_id = actor_account_id
    and membership.facility_id = actor_facility_id;
  if actor_staff_id is null then
    raise exception using errcode = '42501', message = 'Exact staff membership is required';
  end if;

  select patient_row.id
    into patient_id_value
  from identity.patients patient_row
  where upper(patient_row.hid_code) = upper(btrim(requested_hid))
    and patient_row.status = 'active'
  limit 1;
  if patient_id_value is null then
    raise exception using errcode = 'P0002', message = 'Patient is not available';
  end if;

  -- Serialize this actor's activation window across patients and facilities.
  perform pg_advisory_xact_lock(hashtextextended(actor_account_id::text || ':emergency-rate', 0));

  perform pg_advisory_xact_lock(hashtextextended(
    patient_id_value::text || ':' || actor_membership_id::text || ':break-glass', 0
  ));

  select grant_row.request_id, grant_row.id, grant_row.expires_at
    into request_id_value, grant_id_value, grant_expires_at
  from identity.consent_grants grant_row
  where grant_row.patient_id = patient_id_value
    and grant_row.account_id = actor_account_id
    and grant_row.membership_id = actor_membership_id
    and grant_row.facility_id = actor_facility_id
    and grant_row.scope = 'break_glass'
    and grant_row.purpose_of_use = 'emergency'
    and grant_row.status = 'active'
    and grant_row.expires_at > clock_timestamp()
    and grant_row.migration_hold_reason is null
  order by grant_row.expires_at desc
  limit 1;

  if grant_id_value is null then
    -- Replays preserve access without consuming another activation. New grants
    -- are bounded to ten per account per rolling hour, including closed grants.
    if (select count(*) from identity.consent_grants recent
        where recent.account_id = actor_account_id and recent.break_glass
          and recent.starts_at > clock_timestamp() - interval '1 hour') >= 10 then
      raise exception using errcode = 'P0001', message = 'Emergency activation rate limit reached';
    end if;
    request_id_value := gen_random_uuid();
    grant_id_value := gen_random_uuid();
    grant_expires_at := clock_timestamp() + make_interval(mins => requested_duration_minutes);

    insert into identity.access_requests (
      id, patient_id, staff_id, membership_id, facility_id, scope,
      purpose_of_use, reason, status, requested_duration_minutes,
      break_glass, approved_at, correlation_id
    ) values (
      request_id_value, patient_id_value, actor_staff_id, actor_membership_id,
      actor_facility_id, 'break_glass', 'emergency', btrim(requested_reason),
      'approved', requested_duration_minutes, true, clock_timestamp(), actor_correlation_id
    );

    insert into identity.consent_grants (
      id, request_id, patient_id, staff_id, account_id, membership_id,
      facility_id, scope, purpose_of_use, status, reason, starts_at,
      expires_at, break_glass, correlation_id
    ) values (
      grant_id_value, request_id_value, patient_id_value, actor_staff_id,
      actor_account_id, actor_membership_id, actor_facility_id, 'break_glass',
      'emergency', 'active', btrim(requested_reason), clock_timestamp(),
      grant_expires_at, true, actor_correlation_id
    );
  else
    replayed := true;
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    actor_membership_id, organization_id, facility_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'staff', actor_subject, actor_account_id,
    actor_membership_id, actor_organization_id, actor_facility_id, patient_id_value,
    case when replayed then 'identity.break-glass.replay' else 'identity.break-glass.activate' end,
    'success', 'consent-grant', grant_id_value::text, 'emergency',
    btrim(requested_reason), 'application', 'identity-api',
    jsonb_build_object(
      'access_request_id', request_id_value,
      'duration_minutes', requested_duration_minutes,
      'expires_at', grant_expires_at,
      'existing_grant', replayed,
      'review_required', true
    )
  );

  if not replayed then
    -- Audit, grant and patient-notification intent commit atomically. No
    -- emergency reason, HID, demographics or record content enters delivery.
    insert into identity.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id, patient_id,
      correlation_id, payload
    ) values (
      'EmergencyAccessActivated', grant_id_value, 1, actor_facility_id,
      patient_id_value, actor_correlation_id,
      jsonb_build_object('consentGrantId', grant_id_value, 'reviewRequired', true)
    );
  end if;

  return query select
    request_id_value, grant_id_value, patient_id_value, 'active'::text,
    grant_expires_at, replayed;
end;
$$;

create or replace view integration.outbox_envelopes
with (security_invoker = true)
as
select
  'identity'::text as producer,
  event_id,
  event_type,
  1::integer as event_version,
  created_at as occurred_at,
  case when event_type = 'EmergencyAccessActivated' then 'identity-consent-grant'
    else 'identity-registration-case' end::text as aggregate_type,
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

