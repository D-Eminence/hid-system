\set ON_ERROR_STOP on
-- Invitations to share (0095, B4 P4-P7, S2, S3, D7, D8): the same answer for
-- a registered and an unregistered address (the command reads no workforce
-- table or account); the per-patient and per-address caps; acceptance bound
-- to a verified sign-in email equal to the address and an eligible
-- membership; the patient's confirmation creating the grant; cancel after
-- accept; expiry and its sweep; the guard trigger; idempotency.
-- Rollback-only. Synthetic values only; uuid prefix 95b.
set plpgsql.variable_conflict = error;
begin;

-- 1. The create command reads no workforce table and no account.
do $$
declare body text := (select prosrc from pg_proc
  where oid = 'identity.create_my_share_invitation(text,uuid,text,text,text,text,text,text)'::regprocedure);
begin
  if body ~* '(identity\.staff|staff_facility_memberships|auth\.accounts|account_roles|share_provider_eligible)' then
    raise exception 'create_my_share_invitation must not read a workforce table or an account';
  end if;
end $$;

-- 2. Fixtures: facility A (governed); a doctor whose verified sign-in email is
-- doctor@..., a lab scientist with a verified email lab@..., a doctor with an
-- unverified email unverified@...; patients P1-P6 with a live session each.
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'invitation-test') on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at) values
  ('95b10000-0000-4000-8000-000000000001', 'synthetic:invite:doctor', 'Invite-Doctor@Example.invalid', 'Invite Doctor', 'active', clock_timestamp()),
  ('95b10000-0000-4000-8000-000000000002', 'synthetic:invite:lab', 'invite-lab@example.invalid', 'Invite Lab', 'active', clock_timestamp()),
  ('95b10000-0000-4000-8000-000000000003', 'synthetic:invite:unverified', 'invite-unverified@example.invalid', 'Invite Unverified', 'active', null);
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at)
select ('95b11000-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:invite:p' || n, 'invite-p' || n || '@example.invalid',
  'Invite P' || n, 'active', clock_timestamp() from generate_series(1, 6) n;
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status)
select ('95b20000-0000-4000-8000-00000000000' || n)::uuid, ('95b11000-0000-4000-8000-00000000000' || n)::uuid,
  'HID-QWVP' || chr(64 + n) || chr(64 + n), 'Pat' || chr(96 + n), 'Invite', 'Pat' || chr(96 + n) || ' Invite', 'active'
from generate_series(1, 6) n;
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('95b30000-0000-4000-8000-00000000000' || n)::uuid, ('95b11000-0000-4000-8000-00000000000' || n)::uuid,
  ('95b30000-0000-4000-8000-00000000000' || n)::uuid, md5('invite' || n) || md5('invite' || n), gen_random_uuid(), 1,
  'password', clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
  'patient', ('95b20000-0000-4000-8000-00000000000' || n)::uuid
from generate_series(1, 6) n;
insert into identity.organizations (id, name, slug) values
  ('95b40000-0000-4000-8000-000000000001', 'Invitation Org', 'invitation-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('95b41000-0000-4000-8000-000000000001', '95b40000-0000-4000-8000-000000000001', 'Invitation Hospital', 'INV-A',
   'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('95b50000-0000-4000-8000-00000000000' || n)::uuid, ('95b10000-0000-4000-8000-00000000000' || n)::uuid, name,
  'invite-staff-' || n || '@example.invalid', 'verified', role
from (values (1, 'Doctor Invite Okoro', 'doctor'), (2, 'Lab Invite Musa', 'lab'), (3, 'Doctor Invite Unverified', 'doctor'))
  staff_row(n, name, role);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('95b60000-0000-4000-8000-00000000000' || n)::uuid, ('95b50000-0000-4000-8000-00000000000' || n)::uuid,
  ('95b10000-0000-4000-8000-00000000000' || n)::uuid, '95b40000-0000-4000-8000-000000000001',
  '95b41000-0000-4000-8000-000000000001', role, role, true, true
from (values (1, 'doctor'), (2, 'lab'), (3, 'doctor')) m(n, role);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('95b70000-0000-4000-8000-00000000000' || n)::uuid, ('95b10000-0000-4000-8000-00000000000' || n)::uuid, role,
  'facility', ('95b60000-0000-4000-8000-00000000000' || n)::uuid, '95b41000-0000-4000-8000-000000000001', 'Invitation suite role'
from (values (1, 'doctor'), (2, 'lab'), (3, 'doctor')) r(n, role);

create function pg_temp.as_patient(n integer, correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:invite:p' || n, true), set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.as_staff(who text, n integer, correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:invite:' || who, true),
    set_config('app.facility_id', '95b41000-0000-4000-8000-000000000001', true),
    set_config('app.membership_id', '95b60000-0000-4000-8000-00000000000' || n, true),
    set_config('app.purpose_of_use', 'direct-care', true), set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.session(n integer) returns uuid language sql as $$
  select ('95b30000-0000-4000-8000-00000000000' || n)::uuid;
$$;
create function pg_temp.invite(n integer, email text, key text, digest text default repeat('a', 64)) returns text
language plpgsql as $$
declare outcome record;
begin
  select * into outcome from identity.create_my_share_invitation('synthetic:invite:p' || n, pg_temp.session(n), email,
    'Dr Example', 'clinical_review', '7d', key, digest);
  return format('ok %s %s %s send=%s replayed=%s', outcome.invitation_id, outcome.reference, outcome.status,
    outcome.send_email::text, outcome.replayed::text);
exception when others then
  return format('%s %s', sqlstate, sqlerrm);
end $$;
create function pg_temp.try(statement text) returns text language plpgsql as $$
declare answer text;
begin
  execute statement into answer;
  return 'ok ' || coalesce(answer, '');
exception when others then
  return format('%s %s', sqlstate, sqlerrm);
end $$;
grant execute on function pg_temp.as_patient(integer, text), pg_temp.as_staff(text, integer, text),
  pg_temp.session(integer), pg_temp.invite(integer, text, text, text), pg_temp.try(text) to public;

-- 3. Creating: registered and unregistered addresses answer alike; caps.
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'invite-create-01');
do $$
declare
  registered text;
  unregistered text;
begin
  registered := pg_temp.invite(1, '  Invite-Doctor@Example.INVALID ', 'invite-key-0000000001');
  unregistered := pg_temp.invite(1, 'nobody-here@example.invalid', 'invite-key-0000000002');
  if regexp_replace(registered, '^ok \S+ [A-Z2-9]{8} ', '') <> 'pending send=true replayed=false'
     or regexp_replace(unregistered, '^ok \S+ [A-Z2-9]{8} ', '') <> 'pending send=true replayed=false' then
    raise exception 'Registered and unregistered answers differ: % / %', registered, unregistered;
  end if;
  perform set_config('hid.invitation', split_part(registered, ' ', 2), true);
  perform set_config('hid.unregistered', split_part(unregistered, ' ', 2), true);
  -- Replay, key reuse, an open invitation to the same address, a bad address.
  -- A replay answers the same invitation and sends nothing again.
  if pg_temp.invite(1, 'invite-doctor@example.invalid', 'invite-key-0000000001')
       <> replace(replace(registered, 'send=true', 'send=false'), 'replayed=false', 'replayed=true') then
    raise exception 'Replay: %', pg_temp.invite(1, 'invite-doctor@example.invalid', 'invite-key-0000000001');
  end if;
  if pg_temp.invite(1, 'other@example.invalid', 'invite-key-0000000001', repeat('b', 64)) <> '55000 IDEMPOTENCY_KEY_REUSED'
     or pg_temp.invite(1, 'invite-doctor@example.invalid', 'invite-key-0000000003') <> '55000 SHARE_INVITATION_ALREADY_OPEN'
     or pg_temp.invite(1, 'no-at-sign.example.invalid', 'invite-key-0000000004') <> '22023 SHARE_INVITATION_EMAIL_INVALID'
     or pg_temp.invite(1, 'two@@example.invalid', 'invite-key-0000000005') <> '22023 SHARE_INVITATION_EMAIL_INVALID'
     or pg_temp.invite(1, 'sp ace@example.invalid', 'invite-key-0000000006') <> '22023 SHARE_INVITATION_EMAIL_INVALID' then
    raise exception 'Refusals differ';
  end if;
  -- 5 new a day: three more succeed, the sixth is P0001.
  for n in 3..5 loop
    if pg_temp.invite(1, 'daily-' || n || '@example.invalid', 'invite-key-00000001' || n || '0') not like 'ok %' then
      raise exception 'Invitation % refused', n;
    end if;
  end loop;
  if pg_temp.invite(1, 'daily-6@example.invalid', 'invite-key-0000000160') <> 'P0001 SHARE_INVITATION_LIMITED' then
    raise exception 'The sixth invitation in a day: %', pg_temp.invite(1, 'daily-6@example.invalid', 'invite-key-0000000160');
  end if;
  -- Another patient's session.
  if pg_temp.invite(2, 'x@example.invalid', 'invite-key-0000000007') not like '42501 %'
     or (select pg_temp.try(format($q$select identity.cancel_my_share_invitation('synthetic:invite:p1', %L, %L)::text$q$,
           pg_temp.session(2), current_setting('hid.invitation')))) not like '42501 %' then
    raise exception 'Session binding';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from audit.events where action = 'identity.share-invitation.create'
              and (details::text ilike '%example%' or details::text ilike '%Dr Example%'))
     or not exists (select 1 from audit.events where action = 'identity.share-invitation.create'
              and resource_id = current_setting('hid.invitation')
              and details = '{"level": "clinical_review", "duration": "7d", "emailSent": true}'::jsonb) then
    raise exception 'The create audit row must carry no address or name';
  end if;
end $$;

-- 3b. 20 open per patient: P3 has 18 open invitations from two days ago.
insert into identity.patient_share_invitations (id, reference, patient_id, invitee_email, level, duration_preset, status,
  created_at, expires_at, delivery_outcome, idempotency_key, request_sha256)
select gen_random_uuid(), 'OPEN' || chr(65 + n / 10) || chr(65 + n % 10) || 'ZZ', '95b20000-0000-4000-8000-000000000003',
  'open-' || n || '@example.invalid', 'view_only', '24h', 'pending', now() - interval '2 days',
  now() - interval '2 days' + interval '30 days', 'sent', 'open-key-' || lpad(n::text, 10, '0'), repeat('c', 64)
from generate_series(1, 18) n;
set local role hid_identity_api_runtime;
select pg_temp.as_patient(3, 'invite-open-01');
do $$
begin
  if pg_temp.invite(3, 'open-19@example.invalid', 'invite-key-0000000319') not like 'ok %'
     or pg_temp.invite(3, 'open-20@example.invalid', 'invite-key-0000000320') not like 'ok %'
     or pg_temp.invite(3, 'open-21@example.invalid', 'invite-key-0000000321') <> '55000 SHARE_INVITATION_TOO_MANY_OPEN' then
    raise exception 'The 21st open invitation must be refused';
  end if;
end $$;
reset role;

-- 3c. 3 emails a day per address across all patients: P4, P5 and P6 then
-- invite the address P1 invited; the fourth patient's is created unsent.
set local role hid_identity_api_runtime;
do $$
declare answer text;
begin
  perform pg_temp.as_patient(4, 'invite-cap-04');
  if pg_temp.invite(4, 'invite-doctor@example.invalid', 'invite-key-0000000401') not like 'ok % send=true %' then
    raise exception 'The second email to the address must be sent';
  end if;
  perform pg_temp.as_patient(5, 'invite-cap-05');
  if pg_temp.invite(5, 'invite-doctor@example.invalid', 'invite-key-0000000501') not like 'ok % send=true %' then
    raise exception 'The third email to the address must be sent';
  end if;
  perform pg_temp.as_patient(6, 'invite-cap-06');
  answer := pg_temp.invite(6, 'invite-doctor@example.invalid', 'invite-key-0000000601');
  if answer !~ '^ok \S+ [A-Z2-9]{8} pending send=false replayed=false$' then
    raise exception 'Past the cap the invitation is created unsent: %', answer;
  end if;
  if (select item->>'deliveryOutcome' from jsonb_array_elements(
        identity.list_my_share_invitations('synthetic:invite:p6', pg_temp.session(6))->'items') item) <> 'not_confirmed' then
    raise exception 'An unsent invitation reads not_confirmed';
  end if;
end $$;
reset role;

-- 4. The delivery outcome; the list.
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'invite-delivery-01');
select identity.record_my_share_invitation_delivery('synthetic:invite:p1', pg_temp.session(1),
  current_setting('hid.invitation')::uuid, 'accepted', 'novu', null);
select identity.record_my_share_invitation_delivery('synthetic:invite:p1', pg_temp.session(1),
  current_setting('hid.unregistered')::uuid, 'definitive_failure', null, 'http_422');
do $$
declare listed jsonb := identity.list_my_share_invitations('synthetic:invite:p1', pg_temp.session(1));
begin
  if listed->'limits' <> '{"maxOpen": 20, "maxNewPerDay": 5, "remainingToday": 0}'::jsonb
     or jsonb_array_length(listed->'items') <> 5 then
    raise exception 'List: %', listed;
  end if;
  if (select item->>'deliveryOutcome' from jsonb_array_elements(listed->'items') item
       where item->>'invitationId' = current_setting('hid.invitation')) <> 'sent'
     or (select item->>'deliveryOutcome' from jsonb_array_elements(listed->'items') item
       where item->>'invitationId' = current_setting('hid.unregistered')) <> 'not_confirmed'
     or (select item->>'inviteeEmail' from jsonb_array_elements(listed->'items') item
       where item->>'invitationId' = current_setting('hid.invitation')) <> 'invite-doctor@example.invalid'
     or exists (select 1 from jsonb_array_elements(listed->'items') item
                 where item->'offer' <> 'null'::jsonb or item->'consentGrantId' <> 'null'::jsonb) then
    raise exception 'List items: %', listed;
  end if;
  if identity.list_my_share_invitations('synthetic:invite:p1', pg_temp.session(2)) is not null then
    raise exception 'Another session must read nothing';
  end if;
end $$;
reset role;

-- 5. The invitee's side: list, accept.
set local role hid_identity_api_runtime;
select pg_temp.as_staff('doctor', 1, 'invite-staff-01');
do $$
declare listed jsonb := identity.list_share_invitations_for_me();
begin
  -- P1's, P4's and P5's invitations to this address (the account email in
  -- any case); P6's too (unsent, still pending). No patient identity.
  if (listed->>'eligible')::boolean is not true or jsonb_array_length(listed->'items') <> 4
     or listed::text ~ '(HID-|95b20000|Pat[a-f] Invite|invite-p[0-9])' then
    raise exception 'Invitee list: %', listed;
  end if;
  if exists (select 1 from jsonb_array_elements(listed->'items') item
              where (select array_agg(key order by key) from jsonb_object_keys(item) key)
                <> array['createdAt','duration','expiresAt','invitationId','inviteeName','level','reference']) then
    raise exception 'Invitee list keys: %', listed;
  end if;
end $$;
select pg_temp.as_staff('lab', 2, 'invite-staff-02');
do $$
declare listed jsonb := identity.list_share_invitations_for_me();
begin
  if listed <> '{"items": [], "eligible": false}'::jsonb then raise exception 'A lab scientist is not eligible: %', listed; end if;
end $$;
-- Not addressed to the lab scientist (another email): 404; an unverified
-- doctor whose email would match nothing: 404.
select pg_temp.as_staff('lab', 2, 'invite-staff-03');
do $$
begin
  if pg_temp.try(format('select status from identity.accept_share_invitation(%L)', current_setting('hid.invitation')))
       <> 'P0002 SHARE_INVITATION_NOT_FOUND' then
    raise exception 'Accept by another address must be 404';
  end if;
end $$;
select pg_temp.as_staff('unverified', 3, 'invite-staff-04');
do $$
begin
  if pg_temp.try(format('select status from identity.accept_share_invitation(%L)', current_setting('hid.invitation')))
       <> 'P0002 SHARE_INVITATION_NOT_FOUND' then
    raise exception 'Accept by an unverified email must be 404';
  end if;
end $$;
reset role;
-- The lab scientist's account takes the invited address (verified): still
-- not eligible, 403.
update auth.accounts set email = 'invite-lab-new@example.invalid' where id = '95b10000-0000-4000-8000-000000000002';
set local role hid_identity_api_runtime;
select pg_temp.as_patient(2, 'invite-lab-01');
select set_config('hid.lab_invitation', split_part(pg_temp.invite(2, 'invite-lab-new@example.invalid', 'invite-key-0000000201'), ' ', 2), true);
select pg_temp.as_staff('lab', 2, 'invite-staff-05');
do $$
begin
  if pg_temp.try(format('select status from identity.accept_share_invitation(%L)', current_setting('hid.lab_invitation')))
       <> '42501 SHARE_PROVIDER_NOT_ELIGIBLE' then
    raise exception 'An ineligible membership must be refused';
  end if;
end $$;
-- Before acceptance the patient cannot confirm.
select pg_temp.as_patient(1, 'invite-confirm-00');
do $$
begin
  if pg_temp.try(format($q$select status from identity.cancel_my_share_invitation('x', %L, %L)$q$, pg_temp.session(1),
       current_setting('hid.invitation'))) not like '42501 %'
     or pg_temp.try(format($q$select consent_grant_id::text from identity.confirm_my_share_invitation('synthetic:invite:p1', %L, %L)$q$,
       pg_temp.session(1), current_setting('hid.invitation'))) <> '55000 SHARE_INVITATION_NOT_ACCEPTED' then
    raise exception 'Confirm before acceptance must be 409';
  end if;
end $$;
select pg_temp.as_staff('doctor', 1, 'invite-staff-06');
do $$
declare accepted record;
begin
  select * into accepted from identity.accept_share_invitation(current_setting('hid.invitation')::uuid);
  if accepted.status <> 'accepted' or accepted.replayed then raise exception 'Accept: %', accepted; end if;
  select * into accepted from identity.accept_share_invitation(current_setting('hid.invitation')::uuid);
  if not accepted.replayed then raise exception 'A second accept replays'; end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from notification.inbox_items where patient_id = '95b20000-0000-4000-8000-000000000001'
                  and notification_code = 'SHARE_INVITATION_ACCEPTED' and resource_type = 'share-invitation'
                  and resource_id = current_setting('hid.invitation')::uuid
                  and metadata = '{"facilityName": "Invitation Hospital"}'::jsonb) then
    raise exception 'SHARE_INVITATION_ACCEPTED was not enqueued as the contract says';
  end if;
end $$;

-- 6. The patient sees the offer, confirms; replay; nothing else changes.
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'invite-confirm-01');
do $$
declare
  offer jsonb;
  confirmed record;
begin
  select item->'offer' into offer from jsonb_array_elements(identity.list_my_share_invitations('synthetic:invite:p1',
    pg_temp.session(1))->'items') item where item->>'invitationId' = current_setting('hid.invitation');
  if offer <> '{"role": "doctor", "facilityName": "Invitation Hospital", "clinicianName": "Doctor Invite Okoro", "newOnHealthId": false, "organizationName": "Invitation Org"}'::jsonb then
    raise exception 'Offer: %', offer;
  end if;
  select * into confirmed from identity.confirm_my_share_invitation('synthetic:invite:p1', pg_temp.session(1),
    current_setting('hid.invitation')::uuid);
  if confirmed.scope <> 'read_records' or confirmed.level <> 'clinical_review' or confirmed.duration_preset <> '7d'
     or confirmed.expires_at - confirmed.starts_at <> interval '7 days' or confirmed.replayed
     or confirmed.notify_email <> 'invite-doctor@example.invalid' or confirmed.clinician_name <> 'Doctor Invite Okoro' then
    raise exception 'Confirm: %', confirmed;
  end if;
  perform set_config('hid.grant', confirmed.consent_grant_id::text, true);
  select * into confirmed from identity.confirm_my_share_invitation('synthetic:invite:p1', pg_temp.session(1),
    current_setting('hid.invitation')::uuid);
  if not confirmed.replayed or confirmed.consent_grant_id::text <> current_setting('hid.grant') or confirmed.notify_email is not null then
    raise exception 'Confirm replay: %', confirmed;
  end if;
  -- A confirmed invitation is not cancellable.
  if pg_temp.try(format($q$select status from identity.cancel_my_share_invitation('synthetic:invite:p1', %L, %L)$q$,
       pg_temp.session(1), current_setting('hid.invitation'))) <> '55000 SHARE_INVITATION_NOT_CANCELLABLE' then
    raise exception 'A confirmed invitation must not be cancellable';
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from identity.patient_consent_shares where consent_grant_id = current_setting('hid.grant')::uuid
                  and created_via = 'invitation' and invitation_id = current_setting('hid.invitation')::uuid
                  and membership_id = '95b60000-0000-4000-8000-000000000001')
     or not exists (select 1 from identity.consent_grants where id = current_setting('hid.grant')::uuid
                     and granted_by_patient_id = '95b20000-0000-4000-8000-000000000001' and status = 'active'
                     and purpose_of_use = 'direct-care' and scope = 'read_records') then
    raise exception 'The confirmed invitation''s grant is not as P7 writes it';
  end if;
end $$;

-- 7. Cancel after accept (declines the offer); another patient's: 404.
select set_config('hid.p4_invitation', (select id::text from identity.patient_share_invitations
  where patient_id = '95b20000-0000-4000-8000-000000000004'), true);
set local role hid_identity_api_runtime;
select pg_temp.as_staff('doctor', 1, 'invite-staff-09');
select status from identity.accept_share_invitation(current_setting('hid.p4_invitation')::uuid);
select pg_temp.as_patient(1, 'invite-cancel-01');
do $$
begin
  if pg_temp.try(format($q$select status from identity.cancel_my_share_invitation('synthetic:invite:p1', %L, %L)$q$,
       pg_temp.session(1), current_setting('hid.p4_invitation'))) <> 'P0002 SHARE_INVITATION_NOT_FOUND' then
    raise exception 'Another patient''s invitation must be 404';
  end if;
end $$;
select pg_temp.as_patient(4, 'invite-cancel-02');
do $$
declare cancelled record;
begin
  select * into cancelled from identity.cancel_my_share_invitation('synthetic:invite:p4', pg_temp.session(4),
    current_setting('hid.p4_invitation')::uuid);
  if cancelled.status <> 'cancelled' or cancelled.replayed then raise exception 'Cancel after accept: %', cancelled; end if;
  select * into cancelled from identity.cancel_my_share_invitation('synthetic:invite:p4', pg_temp.session(4),
    current_setting('hid.p4_invitation')::uuid);
  if not cancelled.replayed then raise exception 'A second cancel replays'; end if;
  if pg_temp.try(format($q$select consent_grant_id::text from identity.confirm_my_share_invitation('synthetic:invite:p4', %L, %L)$q$,
       pg_temp.session(4), current_setting('hid.p4_invitation'))) <> '55000 SHARE_INVITATION_NOT_ACCEPTED' then
    raise exception 'A cancelled offer cannot be confirmed';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from identity.consent_grants where patient_id = '95b20000-0000-4000-8000-000000000004') then
    raise exception 'A declined offer must give no access';
  end if;
end $$;

-- 8. Expiry: an invitation created 31 days ago, still pending.
insert into identity.patient_share_invitations (id, reference, patient_id, invitee_email, level, duration_preset, status,
  created_at, expires_at, delivery_outcome, idempotency_key, request_sha256) values
  ('95b80000-0000-4000-8000-000000000001', 'EXPRDAAA', '95b20000-0000-4000-8000-000000000005', 'late@example.invalid',
   'view_only', '24h', 'pending', now() - interval '31 days', now() - interval '1 day', 'sent',
   'expired-key-0000000001', repeat('e', 64));
set local role hid_identity_api_runtime;
select pg_temp.as_patient(5, 'invite-expiry-01');
do $$
begin
  if (select item->>'status' from jsonb_array_elements(identity.list_my_share_invitations('synthetic:invite:p5',
        pg_temp.session(5))->'items') item where item->>'invitationId' = '95b80000-0000-4000-8000-000000000001') <> 'expired' then
    raise exception 'A pending invitation past its end reads expired before the sweep';
  end if;
  if pg_temp.try($q$select status from identity.cancel_my_share_invitation('synthetic:invite:p5',
       '95b30000-0000-4000-8000-000000000005', '95b80000-0000-4000-8000-000000000001')$q$)
       <> '55000 SHARE_INVITATION_NOT_CANCELLABLE' then
    raise exception 'An expired invitation is not cancellable';
  end if;
  if pg_temp.try('select identity.expire_share_invitations(10)::text') not like '42501 %' then
    raise exception 'The sweep is system:auth only';
  end if;
end $$;
select set_config('app.actor_subject', 'system:auth', true), set_config('app.correlation_id', 'invite-sweep-01', true);
do $$
begin
  if identity.expire_share_invitations(100) < 1 then raise exception 'The sweep expired nothing'; end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from identity.patient_share_invitations where id = '95b80000-0000-4000-8000-000000000001'
                  and status = 'expired' and expired_at is not null)
     or not exists (select 1 from notification.inbox_items where notification_code = 'SHARE_INVITATION_EXPIRED'
                     and resource_id = '95b80000-0000-4000-8000-000000000001' and metadata = '{}'::jsonb) then
    raise exception 'The sweep must expire and notify';
  end if;
  -- The guard: identity fields never change; closed statuses are terminal; never deleted.
  begin
    update identity.patient_share_invitations set invitee_email = 'changed@example.invalid'
     where id = '95b80000-0000-4000-8000-000000000001';
    raise exception 'guard missed';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    update identity.patient_share_invitations set status = 'pending', expired_at = null
     where id = '95b80000-0000-4000-8000-000000000001';
    raise exception 'guard missed';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from identity.patient_share_invitations where id = '95b80000-0000-4000-8000-000000000001';
    raise exception 'guard missed';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;
-- Accepting an expired invitation: 409.
update auth.accounts set email = 'late@example.invalid' where id = '95b10000-0000-4000-8000-000000000003';
update auth.accounts set email_verified_at = clock_timestamp() where id = '95b10000-0000-4000-8000-000000000003';
set local role hid_identity_api_runtime;
select pg_temp.as_staff('unverified', 3, 'invite-staff-10');
do $$
begin
  if pg_temp.try($q$select status from identity.accept_share_invitation('95b80000-0000-4000-8000-000000000001')$q$)
       <> '55000 SHARE_INVITATION_NOT_PENDING' then
    raise exception 'Accepting an expired invitation must be 409';
  end if;
end $$;
reset role;

rollback;
