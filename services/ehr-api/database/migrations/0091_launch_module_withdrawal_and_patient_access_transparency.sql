-- The launch module set, the patient-self binding and patient access
-- transparency (decisions D17 and D9, ADR-058). Applied migrations 0001
-- through 0090 are immutable.
--
-- 1. Launch controls (UPLOADS-DEFAULT-ON). 0039 seeded uploads_enabled,
--    outreach_portal_enabled and break_glass_enabled on, and 0084 left them
--    to an operator (P11), because a platform.control_events row needs an
--    acting account. Each of the three is set off here only while it is still
--    exactly as 0039 seeded it (on, version 1, no updating account, the seed
--    reason): a control an administrator has changed keeps the
--    administrator's value. As 0041 did for maintenance_mode, the row records
--    the change (version 2, no updating account, a reason naming 0091) and no
--    control event is written, since there is no actor; the migration ledger
--    records when it ran. An administrator turns a control on again through
--    the audited POST /admin/controls, which writes its event as before.
--    platform.control_settings forces row-level security, whose policies
--    need a platform account, so the migration administrator, which owns the
--    table and is no superuser on RDS, would otherwise update no row: forced
--    security is lifted for this transaction only and restored before any
--    other statement. That takes the table's ACCESS EXCLUSIVE lock first, in
--    the order of a break-glass activation and of the role bootstrap
--    (controls, then identity.outbox_events), and holds it to commit.
--
-- 2. Launch module permissions (MOD-PERM-OCR-OUTREACH, FE-17, FE-15,
--    UPLOADS-DEFAULT-ON). Lab, Pharmacy, OCR and Outreach are not routed in
--    production (D17), break-glass is off (D9) and document uploads are off.
--    0084 withdrew the Lab and Pharmacy writes but kept their reads, so
--    Health-id still offered Laboratory, Pharmacy, Document OCR, Outreach,
--    released Lab results, Extract with OCR, emergency access and the upload
--    card, each answering 404 or failing. Every role loses every lab.*,
--    pharmacy.*, ocr.* and outreach.* permission (ocr_worker's unused
--    ocr.job.process too: the worker commands check its role, not the
--    permission), identity.break-glass.write and ehr.document.write. The
--    routes that need them answer 403 PERMISSION_DENIED before any write,
--    and Health-id hides or disables those surfaces, as it does for any
--    missing permission. The EHR reads, ehr.document.read included, stay.
--    A production database built at launch holds no Lab, Pharmacy, OCR or
--    Outreach data. Re-enabling a module takes its decision, its fixes, a
--    staging acceptance run and a reviewed migration that grants the
--    permissions again (staging opts in the same way) and changes the role
--    assertions with it.
--
-- 3. Patient-self binding (PSELF-RLS). The patient-self policies of 0030 and
--    0084 trusted ehr.patient_self_context, which checked only that the
--    transaction settings were present and fresh: a context naming another
--    patient and a session that does not exist read that patient's
--    completed encounters and signed notes, against 0005's rule that a
--    custom setting is never trusted without a relational check. The same
--    signature is kept, so the three policies are unchanged, and the
--    function becomes SECURITY DEFINER with a pinned search_path. It keeps
--    the setting checks and adds the binding: the named patient must be the
--    one identity.patient_self_session returns for the named subject and
--    session (live, not revoked or expired, current token version, active
--    account and patient, the subject the transaction acts as), and must
--    belong to the named account. A malformed account or session id is
--    refused, not raised. EXECUTE stays with hid_ehr_runtime and the test
--    role (CREATE OR REPLACE keeps the ACL).
--
-- 4. Named grantee (CONSENT-GRANTEE). Approval grants one clinician's
--    membership access, but the patient saw only the facility. The
--    patient's request list gains requester_display_name (the display name
--    of the membership's account) and requester_role (its membership role),
--    and the access history gains requesterDisplayName, requesterRole and
--    truncated: it reads 51 grants, shows the latest 50 and says whether
--    there were more. The list's result type changes, so it and its
--    session-bound wrapper are dropped and recreated; as for 0074, the
--    wrapper's EXECUTE grant returns with the role bootstrap
--    (runtime-grants.sql), so run the bootstrap immediately after the
--    migrations. The staff list is unchanged.
--
-- 5. PIN-use notice (NOTIF-PIN-NOTICE). A PIN verification writes the
--    PatientAccessPinVerified outbox event, whose only consumer is the
--    notification worker, which is off at launch. An AFTER INSERT trigger
--    on identity.outbox_events now places a PATIENT_ACCESS_PIN_USED item in
--    the patient's in-app inbox for that event, as 0037 does for emergency
--    access. A replay writes no event, so it adds no item. The EventBridge
--    rule is unchanged, so an approved worker can also deliver it later.
--
-- Not included: pending access requests still do not lapse
-- (ACCESS-REQ-STALE). A lapse needs request creation (0086), which reuses
-- a pending request, the approval command and both request lists to change
-- together; it is deferred with its risk (ADR-058).
--
-- Locks, in order: platform.control_settings ACCESS EXCLUSIVE (section 1),
-- auth.role_permissions ROW EXCLUSIVE (section 2), the replaced functions
-- (no table lock), and identity.outbox_events SHARE ROW EXCLUSIVE for the
-- trigger (section 5), which waits for in-flight outbox writers and holds
-- new ones until commit. Each waits at most the runner's 5 s lock timeout;
-- a timeout rolls 0091 back whole, and it can be run again.

-- 1. Launch controls.
alter table platform.control_settings no force row level security;

update platform.control_settings setting
   set enabled = false,
       reason = 'Off at launch until its module is enabled by a reviewed decision (0091, D17)',
       row_version = setting.row_version + 1,
       updated_by = null,
       updated_at = clock_timestamp()
 where setting.control_key in ('uploads_enabled', 'outreach_portal_enabled', 'break_glass_enabled')
   and setting.enabled
   and setting.row_version = 1
   and setting.updated_by is null
   and setting.reason = 'Initial platform control state';

alter table platform.control_settings force row level security;

-- 2. Launch module permissions.
delete from auth.role_permissions
 where permission_code like 'lab.%'
    or permission_code like 'pharmacy.%'
    or permission_code like 'ocr.%'
    or permission_code like 'outreach.%'
    or permission_code in ('identity.break-glass.write', 'ehr.document.write');

-- 3. Patient-self binding.
create or replace function ehr.patient_self_context(requested_patient uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  uuid_shape constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  claimed_patient text := nullif(current_setting('app.patient_id', true), '');
  claimed_subject text := nullif(current_setting('app.actor_subject', true), '');
  claimed_account text := nullif(current_setting('app.account_id', true), '');
  claimed_session text := nullif(current_setting('app.session_id', true), '');
  authorized_until text := nullif(current_setting('app.self_authorized_until', true), '');
begin
  if requested_patient is null or claimed_patient is null or claimed_subject is null
     or claimed_account is null or claimed_session is null or authorized_until is null
     or nullif(current_setting('app.correlation_id', true), '') is null
     or current_setting('app.purpose_of_use', true) is distinct from 'patient-self'
     or claimed_patient <> requested_patient::text then
    return false;
  end if;
  if authorized_until::timestamptz <= statement_timestamp() then
    return false;
  end if;
  if claimed_account !~ uuid_shape or claimed_session !~ uuid_shape then
    return false;
  end if;
  return exists (
    select 1
      from identity.patients patient
     where patient.id = requested_patient
       and patient.account_id = claimed_account::uuid
       and patient.id = identity.patient_self_session(claimed_subject, claimed_session::uuid)
  );
end
$$;

revoke all on function ehr.patient_self_context(uuid) from public;
comment on function ehr.patient_self_context(uuid) is
  'True only in a fresh patient-self transaction whose patient, account, subject and live session match identity.patient_self_session (0030, bound 0091).';

-- 4. Named grantee.
drop function identity.list_my_patient_access_requests(text, uuid);
drop function identity.list_my_access_requests();

create function identity.list_my_access_requests()
returns table (
  access_request_id uuid,
  facility_id uuid,
  facility_name text,
  scope text,
  reason text,
  status text,
  requested_duration_minutes integer,
  requested_at timestamptz,
  approved_at timestamptz,
  denied_at timestamptz,
  denied_reason text,
  requester_display_name text,
  requester_role text
)
language plpgsql
security definer
set search_path = identity, auth, platform, pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account_id uuid := auth.account_id_for_subject(platform.current_actor_subject());
  patient_id_value uuid;
begin
  if actor_account_id is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;
  select id into patient_id_value
    from identity.patients
   where account_id = actor_account_id
     and status = 'active'
   limit 1;
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;

  return query
  select request_row.id, request_row.facility_id, facility.name,
    request_row.scope, request_row.reason, request_row.status,
    request_row.requested_duration_minutes, request_row.created_at,
    request_row.approved_at, request_row.denied_at, request_row.denied_reason,
    requester.display_name, membership.membership_role
    from identity.access_requests request_row
    join identity.facilities facility on facility.id = request_row.facility_id
    left join identity.staff_facility_memberships membership
      on membership.id = request_row.membership_id
     and membership.facility_id = request_row.facility_id
    left join auth.accounts requester on requester.id = membership.account_id
   where request_row.patient_id = patient_id_value
     and request_row.break_glass = false
     and request_row.migration_hold_reason is null
   order by request_row.created_at desc, request_row.id desc
   limit 100;
end;
$$;

create function identity.list_my_patient_access_requests(
  requested_subject text,
  requested_session uuid
) returns table (
  access_request_id uuid, facility_id uuid, facility_name text, scope text, reason text,
  status text, requested_duration_minutes integer, requested_at timestamptz,
  approved_at timestamptz, denied_at timestamptz, denied_reason text,
  requester_display_name text, requester_role text
)
language plpgsql security definer
set search_path = pg_catalog, identity, platform, pg_temp as $$
begin
  if identity.patient_self_session(requested_subject, requested_session) is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  return query select * from identity.list_my_access_requests();
end
$$;

revoke all on function identity.list_my_access_requests() from public;
revoke all on function identity.list_my_patient_access_requests(text, uuid) from public;
comment on function identity.list_my_access_requests() is
  'The calling patient''s non-break-glass access requests, each naming the requesting clinician''s display name and role (0066, 0091). Internal: reached through list_my_patient_access_requests.';
comment on function identity.list_my_patient_access_requests(text, uuid) is
  'The patient''s own access requests for a live patient session, naming the requesting clinician and role (0066, 0091).';

create or replace function identity.patient_self_access_history(requested_subject text, requested_session uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare patient uuid; result jsonb;
begin
  patient := identity.patient_self_session(requested_subject,requested_session);
  if patient is null then return null; end if;
  select jsonb_build_object(
      'items', coalesce(jsonb_agg(entries.item order by entries.position)
                          filter (where entries.position <= 50), '[]'::jsonb),
      'truncated', count(*) > 50)
    into result
    from (
      select row_number() over (order by g.created_at desc, g.id desc) as position,
        jsonb_build_object('consentGrantId',g.id,'scope',g.scope,'purpose',g.purpose_of_use,
          'status',case when g.status='active' and g.expires_at<=statement_timestamp() then 'expired' else g.status end,
          'startsAt',g.starts_at,'expiresAt',g.expires_at,'reason',g.reason,'facilityName',f.name,
          'requesterDisplayName',requester.display_name,'requesterRole',membership.membership_role,
          'breakGlass',g.break_glass,
          'patientRevocable', g.status='active' and g.expires_at>statement_timestamp() and not g.break_glass
            and (g.granted_by_patient_id is not distinct from patient
              or g.authorization_method is not distinct from 'patient_access_pin')) as item
        from identity.consent_grants g
        join identity.facilities f on f.id=g.facility_id
        left join identity.staff_facility_memberships membership
          on membership.id=g.membership_id and membership.facility_id=g.facility_id
        left join auth.accounts requester on requester.id=g.account_id
       where g.patient_id=patient
       order by g.created_at desc,g.id desc
       limit 51
    ) entries;
  return result;
end;
$$;

-- 5. PIN-use notice.
create function notification.on_identity_pin_outbox_created()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, notification, pg_temp
as $$
begin
  if new.event_type = 'PatientAccessPinVerified' then
    perform notification.enqueue_patient_inbox_item(
      new.patient_id, 'PATIENT_ACCESS_PIN_USED', 'consent-grant', new.aggregate_id,
      jsonb_build_object('consentGrantId', new.aggregate_id, 'reviewRequired', true));
  end if;
  return new;
end
$$;
revoke all on function notification.on_identity_pin_outbox_created() from public;
comment on function notification.on_identity_pin_outbox_created() is
  'Places a PATIENT_ACCESS_PIN_USED item in the patient inbox for each PatientAccessPinVerified outbox event (0091).';
create trigger pin_use_notification_inbox
  after insert on identity.outbox_events
  for each row when (new.event_type = 'PatientAccessPinVerified')
  execute function notification.on_identity_pin_outbox_created();
