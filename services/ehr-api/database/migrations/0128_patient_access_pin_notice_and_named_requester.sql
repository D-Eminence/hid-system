-- 0128 PIN-use notice and named requester (port of main 0091 sections 4 and
-- 5: NOTIF-PIN-NOTICE and CONSENT-GRANTEE; coordinator's tasks of
-- 17 Nov 2026 on hid-system#258, number booked there). The declaration is
-- signed separately. It needs 0001-0123 applied (0122's PIN payload with its
-- scope, 0123's sealed QA tenant); it uses nothing 0124-0127 add.
--
-- The gap: a health worker who opens a patient's records with the patient's
-- Access PIN gets a grant (0098, 0122: 24 hours, read and write) and writes
-- the PatientAccessPinVerified outbox event, whose only consumer is the
-- notification worker; the patient's in-app inbox shows nothing, and the
-- patient's list of access requests names the facility but not the clinician
-- who asked. Staging differs from main here, so this file is written on
-- staging's bodies, not copied: staging has no
-- identity.list_my_patient_access_requests wrapper (identity-api calls
-- identity.list_my_access_requests() itself), that list has a twelfth column
-- (0104's purpose_of_use), and 0122 added the grant's scope to the PIN event.
--
-- The change:
-- D1 notification.on_identity_pin_outbox_created() and the trigger
--    pin_use_notification_inbox, AFTER INSERT on identity.outbox_events for
--    each row WHEN (new.event_type = 'PatientAccessPinVerified'), as 0037's
--    emergency notice (notification.on_identity_emergency_outbox_created)
--    and main 0091 section 5: it places one PATIENT_ACCESS_PIN_USED item,
--    resource 'consent-grant' and the grant's id, in the patient's inbox
--    through notification.enqueue_patient_inbox_item (0037), which writes
--    nothing for a patient without an active account.
-- D2 The notice names who used the PIN (main put only the grant's id in it):
--    its metadata is consentGrantId, reviewRequired (true), and, read from
--    the grant the PIN created (same transaction), its scope (read_records or
--    write_records, 0122), the clinician's name (identity.staff.full_name of
--    the grant's staff_id, the verified staff name the access history already
--    shows for a share, 0087), the clinician's role at that facility
--    (identity.staff_facility_memberships.membership_role of the grant's
--    membership_id, as main names the requester) and the facility's name. It
--    is a snapshot at the moment of use: a later rename or role change does
--    not rewrite it. A value that cannot be read is left out
--    (jsonb_strip_nulls), never invented.
-- D3 A PIN replay writes no outbox event (0098, kept by 0122 and 0123), and
--    a failed or locked-out attempt writes none, so neither adds an item; a
--    break-glass grant writes EmergencyAccessActivated and keeps 0037's own
--    notice only. The outbox event, its payload rule
--    (identity_outbox_minimum_necessary) and the EventBridge rule are
--    unchanged, so an approved notification worker can still deliver the
--    event too.
-- D4 identity.list_my_access_requests() gains two last columns,
--    requester_name (identity.staff.full_name of the request's staff_id) and
--    requester_role (membership_role of the request's membership at the
--    request's facility), null when either cannot be read; every other
--    column, row, filter, order and limit is 0104's. Its result type
--    changes, so it is dropped and recreated with 0104's owner and EXECUTE
--    for hid_identity_runtime only (here and, unchanged, in
--    runtime-grants.sql). identity-api selects every column and adds
--    requesterName and requesterRole when present; an older image ignores
--    the two columns.
-- D5 Seals: a sealed demo or QA patient's PIN can only be used at its own
--    tenant (0098, 0123), so its notice names that tenant's staff only.
-- D6 SECURITY DEFINER, search_path pg_catalog, pg_temp, every name
--    schema-qualified; the trigger function is owned like 0037's emergency
--    notice (notification.enqueue_patient_inbox_item's owner), revoked from
--    PUBLIC and granted to no role (a trigger needs no EXECUTE to fire).
-- D7 No migration number appears inside either body, so a renumber changes
--    only this file's name, header, messages and the ledgers.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0123 applied (0123's
--    identity.sealed_qa_facility(uuid), and 0122's PIN payload rule naming
--    the scope); 0128 not applied yet (neither the function nor the trigger
--    exists, and the list has twelve columns); the bodies relied on or
--    replaced are the ones 0037 and 0104 left (md5 of pg_proc.prosrc): the
--    enqueue, the emergency notice and the list; the columns read, with
--    their types; the applier owns, or is a member that inherits and may SET
--    ROLE to the owner of, identity.outbox_events and the enqueue function.
-- 1. The notice function and its comment, given to the enqueue's owner when
--    the applier is only a member of it; revoked from PUBLIC.
-- 2. The trigger, under identity.outbox_events' SHARE ROW EXCLUSIVE lock
--    taken NOWAIT and retried every 100 ms for at most 5 seconds (55P03,
--    nothing applied), so the migration never waits holding locks and never
--    queues writers behind a waiting lock.
-- 3. The list (D4), its comment, owner and grants.
-- 4. Post-checks: both functions with this file's bodies (md5), attributes,
--    owners and ACLs; the trigger with this definition, enabled; the list's
--    fourteen columns.
--
-- Locks: SHARE ROW EXCLUSIVE on identity.outbox_events (CREATE TRIGGER),
-- held to commit: it lets readers through and holds new outbox writes (an
-- access request, an emergency, a PIN use) for as long as the transaction
-- lasts, a few milliseconds; ACCESS EXCLUSIVE on the dropped and recreated
-- list function's catalog entry; the catalogs' own locks. No other
-- application table is locked.
--
-- Old services on this schema: identity-api's PIN route is unchanged and now
-- leaves a notice; its list route answers the two new fields only when the
-- image maps them. The website shows an unknown inbox code as a general
-- account update until it has its own words (health, separately). Applied
-- migrations before 0128 are immutable.

-- 0. Preconditions.
do $$
declare
  mismatch text;
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
  outbox_owner oid;
  enqueue_owner oid;
begin
  -- a. 0001-0123 applied.
  if to_regprocedure('identity.sealed_qa_facility(uuid)') is null
     or to_regclass('identity.outbox_events') is null
     or to_regclass('identity.consent_grants') is null
     or to_regclass('identity.access_requests') is null
     or to_regclass('identity.staff') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('identity.facilities') is null
     or to_regclass('notification.inbox_items') is null
     or to_regprocedure('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)') is null
     or to_regprocedure('notification.on_identity_emergency_outbox_created()') is null
     or to_regprocedure('identity.list_my_access_requests()') is null
     or not exists (select 1 from pg_constraint constraint_row
                     where constraint_row.conrelid = 'identity.outbox_events'::regclass
                       and constraint_row.conname = 'identity_outbox_minimum_necessary'
                       and constraint_row.convalidated
                       and pg_get_constraintdef(constraint_row.oid) like
                         '%PatientAccessPinVerified%''scope'', ''write_records''%') then
    raise exception using errcode = '55000', message = '0128: 0001-0123 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regprocedure('notification.on_identity_pin_outbox_created()') is not null
     or exists (select 1 from pg_trigger trigger_row
                 where trigger_row.tgrelid = 'identity.outbox_events'::regclass
                   and trigger_row.tgname = 'pin_use_notification_inbox')
     or (select count(*) from pg_proc proc, unnest(proc.proargmodes) mode
          where proc.oid = 'identity.list_my_access_requests()'::regprocedure and mode = 't') <> 12 then
    raise exception using errcode = '55000', message = '0128: already applied';
  end if;
  -- c. The bodies relied on or replaced, as 0037 and 0104 left them. A
  -- function missing at its signature is a mismatch by itself.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', '0b5689f31a3ce00f9313fe1e55244fad'),
      ('notification.on_identity_emergency_outbox_created()', 'b692cd4b69f7fdb2017f090fce8275b9'),
      ('identity.list_my_access_requests()', '96f146ed41754b227ae4942e2087ca4a'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where proc.oid is null or md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is null
     and pg_get_function_result('identity.list_my_access_requests()'::regprocedure) is distinct from
       'TABLE(access_request_id uuid, facility_id uuid, facility_name text, scope text, reason text, status text, '
       || 'requested_duration_minutes integer, requested_at timestamp with time zone, approved_at timestamp with time zone, '
       || 'denied_at timestamp with time zone, denied_reason text, purpose_of_use text)' then
    mismatch := 'identity.list_my_access_requests() result columns';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0128: a function this migration relies on differs from 0001-0123: %s', mismatch);
  end if;
  -- d. The columns read, with their types and NOT NULLs.
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('identity.outbox_events', 'event_type', 'text', true),
      ('identity.outbox_events', 'aggregate_id', 'uuid', true),
      ('identity.outbox_events', 'patient_id', 'uuid', true),
      ('identity.consent_grants', 'id', 'uuid', true),
      ('identity.consent_grants', 'patient_id', 'uuid', true),
      ('identity.consent_grants', 'staff_id', 'uuid', true),
      ('identity.consent_grants', 'membership_id', 'uuid', true),
      ('identity.consent_grants', 'facility_id', 'uuid', false),
      ('identity.consent_grants', 'scope', 'text', true),
      ('identity.access_requests', 'staff_id', 'uuid', true),
      ('identity.access_requests', 'membership_id', 'uuid', true),
      ('identity.access_requests', 'facility_id', 'uuid', false),
      ('identity.staff', 'id', 'uuid', true),
      ('identity.staff', 'full_name', 'text', true),
      ('identity.staff_facility_memberships', 'id', 'uuid', true),
      ('identity.staff_facility_memberships', 'facility_id', 'uuid', false),
      ('identity.staff_facility_memberships', 'membership_role', 'text', true),
      ('identity.facilities', 'id', 'uuid', true),
      ('identity.facilities', 'name', 'text', true))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = expected.relation_name::regclass
                        and attribute.attname = expected.column_name and not attribute.attisdropped
                        and attribute.atttypid = expected.type_name::regtype
                        and attribute.attnotnull = expected.not_null);
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0128: these columns differ from 0001-0123: %s', mismatch);
  end if;
  -- e. The applier may create the trigger and give the function to its owner.
  outbox_owner := (select relation.relowner from pg_class relation where relation.oid = 'identity.outbox_events'::regclass);
  enqueue_owner := (select proc.proowner from pg_proc proc
                     where proc.oid = 'notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)'::regprocedure);
  if not (pg_has_role(applier, outbox_owner, 'USAGE') and pg_has_role(applier, enqueue_owner, 'USAGE')
          and pg_has_role(applier, enqueue_owner, 'SET')) then
    raise exception using errcode = '42501',
      message = '0128: the applier must own, or inherit and SET ROLE to, the owners of identity.outbox_events and the inbox';
  end if;
end
$$;

-- 1. The notice (D1-D3, D5, D6).
create function notification.on_identity_pin_outbox_created()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  grant_scope text;
  clinician_name text;
  clinician_role text;
  facility_name text;
begin
  if new.event_type = 'PatientAccessPinVerified' then
    select consent.scope, staff.full_name, membership.membership_role, facility.name
      into grant_scope, clinician_name, clinician_role, facility_name
      from identity.consent_grants consent
      left join identity.staff staff on staff.id = consent.staff_id
      left join identity.staff_facility_memberships membership
        on membership.id = consent.membership_id and membership.facility_id = consent.facility_id
      left join identity.facilities facility on facility.id = consent.facility_id
     where consent.id = new.aggregate_id and consent.patient_id = new.patient_id;
    perform notification.enqueue_patient_inbox_item(
      new.patient_id, 'PATIENT_ACCESS_PIN_USED', 'consent-grant', new.aggregate_id,
      jsonb_strip_nulls(jsonb_build_object(
        'consentGrantId', new.aggregate_id, 'reviewRequired', true, 'scope', grant_scope,
        'clinicianName', clinician_name, 'clinicianRole', clinician_role, 'facilityName', facility_name)));
  end if;
  return new;
end
$$;

comment on function notification.on_identity_pin_outbox_created() is
  'Places a PATIENT_ACCESS_PIN_USED item in the patient''s inbox for each PatientAccessPinVerified outbox event, naming the grant''s scope, the clinician who used the PIN, their role at the facility and the facility (a snapshot at the moment of use).';

do $$
declare
  enqueue_owner name := (select pg_get_userbyid(proc.proowner) from pg_proc proc
                          where proc.oid = 'notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)'::regprocedure);
begin
  if (select pg_get_userbyid(proc.proowner) from pg_proc proc
       where proc.oid = 'notification.on_identity_pin_outbox_created()'::regprocedure) <> enqueue_owner then
    execute format('alter function notification.on_identity_pin_outbox_created() owner to %I', enqueue_owner);
  end if;
end
$$;
revoke all on function notification.on_identity_pin_outbox_created() from public;

-- 2. The trigger, behind a NOWAIT lock.
do $$
declare
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table identity.outbox_events in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0128: identity.outbox_events stayed busy for 5 seconds; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$$;
create trigger pin_use_notification_inbox
  after insert on identity.outbox_events
  for each row when (new.event_type = 'PatientAccessPinVerified')
  execute function notification.on_identity_pin_outbox_created();

-- 3. The patient's access requests, naming the requester (D4).
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
  purpose_of_use text,
  requester_name text,
  requester_role text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_account_id uuid := auth.account_id_for_subject(platform.current_actor_subject());
  patient_id_value uuid;
begin
  if actor_account_id is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;
  select patient_row.id into patient_id_value
    from identity.patients patient_row
   where patient_row.account_id = actor_account_id
     and patient_row.status = 'active'
   limit 1;
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Authenticated patient context is required';
  end if;

  return query
  select request_row.id, request_row.facility_id, facility.name,
    request_row.scope, request_row.reason, request_row.status,
    request_row.requested_duration_minutes, request_row.created_at,
    request_row.approved_at, request_row.denied_at, request_row.denied_reason,
    request_row.purpose_of_use,
    requester.full_name, membership.membership_role
    from identity.access_requests request_row
    join identity.facilities facility on facility.id = request_row.facility_id
    left join identity.staff requester on requester.id = request_row.staff_id
    left join identity.staff_facility_memberships membership
      on membership.id = request_row.membership_id and membership.facility_id = request_row.facility_id
   where request_row.patient_id = patient_id_value
     and request_row.break_glass = false
     and request_row.migration_hold_reason is null
   order by request_row.created_at desc, request_row.id desc
   limit 100;
end;
$$;

comment on function identity.list_my_access_requests() is
  'The calling patient''s non-break-glass access requests (newest 100), with the request''s purpose of use and the requesting clinician''s name and role at the facility.';

do $$
declare
  patients_owner name := (select pg_get_userbyid(relation.relowner) from pg_class relation
                           where relation.oid = 'identity.access_requests'::regclass);
begin
  if (select pg_get_userbyid(proc.proowner) from pg_proc proc
       where proc.oid = 'identity.list_my_access_requests()'::regprocedure) <> patients_owner then
    execute format('alter function identity.list_my_access_requests() owner to %I', patients_owner);
  end if;
end
$$;
revoke all on function identity.list_my_access_requests() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.list_my_access_requests() to hid_identity_runtime;
  end if;
end
$$;

-- 4. Post-checks.
do $$
declare
  mismatch text;
begin
  select string_agg(expected.proc, '; ') into mismatch
    from (values
      ('notification.on_identity_pin_outbox_created()', 'a5840c4de43ed19289143d7523291f45', 'trigger'),
      ('identity.list_my_access_requests()', '28c4aec521d366945d3cebe5f00f7aa4', 'record'))
         expected(proc, digest, result_type)
   where not exists (select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                      where proc.oid = to_regprocedure(expected.proc)
                        and md5(proc.prosrc) = expected.digest and language_row.lanname = 'plpgsql'
                        and proc.prosecdef and proc.provolatile = 'v' and not proc.proisstrict
                        and proc.prorettype = expected.result_type::regtype
                        and proc.proconfig = array['search_path=pg_catalog, pg_temp']);
  if mismatch is null and (select count(*) from pg_proc proc, unnest(proc.proargmodes) mode
                            where proc.oid = 'identity.list_my_access_requests()'::regprocedure and mode = 't') <> 14 then
    mismatch := 'identity.list_my_access_requests() columns';
  end if;
  if mismatch is null and not exists (
       select 1 from pg_trigger trigger_row
        where trigger_row.tgrelid = 'identity.outbox_events'::regclass and trigger_row.tgname = 'pin_use_notification_inbox'
          and trigger_row.tgenabled = 'O' and not trigger_row.tgisinternal
          and pg_get_triggerdef(trigger_row.oid) =
            'CREATE TRIGGER pin_use_notification_inbox AFTER INSERT ON identity.outbox_events FOR EACH ROW '
            || 'WHEN ((new.event_type = ''PatientAccessPinVerified''::text)) '
            || 'EXECUTE FUNCTION notification.on_identity_pin_outbox_created()') then
    mismatch := 'the trigger pin_use_notification_inbox';
  end if;
  -- ACLs: the notice function holds only its owner; the list its owner and,
  -- where the role exists, hid_identity_runtime. Nothing for PUBLIC.
  if mismatch is null and exists (
       select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
        where proc.oid in ('notification.on_identity_pin_outbox_created()'::regprocedure,
                           'identity.list_my_access_requests()'::regprocedure)
          and acl.grantee <> proc.proowner
          and (proc.oid = 'notification.on_identity_pin_outbox_created()'::regprocedure
               or acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime')) then
    mismatch := 'an unexpected EXECUTE grant';
  end if;
  if mismatch is null and exists (select 1 from pg_roles where rolname = 'hid_identity_runtime')
     and not has_function_privilege('hid_identity_runtime', 'identity.list_my_access_requests()', 'EXECUTE') then
    mismatch := 'missing hid_identity_runtime EXECUTE on identity.list_my_access_requests()';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0128: not as this file makes it: %s', mismatch);
  end if;
end
$$;
