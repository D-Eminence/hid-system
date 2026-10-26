-- 0087 Patient grant revocation, access-history labels, and no new inbox
-- items for a deleted login: items 2, 3 and 4 of main's
-- 0066_patient_access_safety.sql (eb9b1ca, first landed as 3490809's 0065),
-- which this branch cannot take by name or number (this branch's 0066 is
-- 0066_patient_chat_history.sql).
--
-- 1. identity.revoke_my_consent_grant(text, uuid, uuid, text) (main 0066
--    lines 329-391): the patient revokes a grant they gave, a patient-approved
--    grant (granted_by_patient_id is the patient, identity.approve_access_request
--    in 0072) or a PIN-derived grant (authorization_method
--    'patient_access_pin', identity.access_patient_with_pin in 0075). A
--    break-glass grant (break_glass, or scope break_glass) and a workforce
--    grant are refused (55000 CONSENT_GRANT_NOT_PATIENT_REVOCABLE). The
--    command resolves the patient through identity.patient_self_session
--    (0030), so it is bound to the caller's own live patient session (as the
--    patient-self reads are since 0083), takes the advisory key
--    'patient-access-pin:' || patient that PIN set, PIN removal (0033) and
--    PIN verification (0075) take, then the grant row, and writes one
--    audit.events row, identity.consent-grant.patient-revoke. A grant already
--    revoked (by the patient, the clinician, PIN removal or support) answers
--    replayed with no write. Main's body, with two changes: break-glass is
--    also recognised by scope, as identity.has_active_consent_grant (0012)
--    does, which matters only for legacy-imported rows; and the audit row's
--    reason is the fixed 'Revoked by the patient'. The facility's audit
--    readers (audit.list_facility_events, 0010) see that the patient revoked,
--    not the patient's own words, which stay on the grant row
--    (consent_grants.revoked_reason, which no service reads).
-- 2. identity.patient_self_access_history(text, uuid) (0030, main 0066 lines
--    393-412): each item gains breakGlass and revocableByPatient. Identity
--    0087's build publishes revocableByPatient as the website's
--    patientRevocable; an Identity build without the revoke route passes the
--    JSON through unchanged, and the website ignores revocableByPatient, so
--    its Revoke button never shows where the route is not served. The limit
--    of 50 now picks the grants the patient can revoke first, so a revocable
--    grant always has its Revoke button however many newer grants exist; the
--    50 chosen are listed newest first, as 0030 lists them. With 50 grants or
--    fewer the list is 0030's, in 0030's order. Every other key and the empty
--    answer {"items":[]} are unchanged.
-- 3. notification.enqueue_patient_inbox_item(...) (0037, main 0066 lines
--    414-440): a patient whose login (auth.accounts) is deleted gets no new
--    inbox item; the function answers NULL, as it already does for an
--    inactive patient or one without a login. Every caller (0037's two
--    triggers, 0084's support opt-out, 0086's order-route notices) already
--    accepts NULL. No path on this branch sets an account to deleted yet.
--
-- Not ported from main's 0066: the session-bound access-request wrappers and
-- the repeat of the 0035 decision commands (this branch's are 0072's), so
-- identity.approve_access_request, identity.deny_access_request and
-- identity.list_my_access_requests and their grants are unchanged.
--
-- Locks: one table lock, a momentary ACCESS SHARE on identity.consent_grants,
-- taken twice and each time released at once: by pg_get_constraintdef in the
-- CHECK precondition, and by the PL/pgSQL validator when it resolves the
-- revoke's identity.consent_grants%rowtype. ACCESS SHARE conflicts only with
-- ACCESS EXCLUSIVE (most DDL, VACUUM FULL, a vacuum truncating the table), so
-- no request waits for this migration; while another session holds ACCESS
-- EXCLUSIVE on the table, the runner's lock_timeout stops the dry run or the
-- apply with nothing applied. No other table is locked: the other catalog
-- reads take no table lock, the bodies are not otherwise checked against
-- tables when created, and the grants change only the function ACLs. 0087
-- never locks platform.control_settings, so 0086's rule for it (one NOWAIT
-- attempt) does not apply. At run time the revoke takes the PIN advisory key,
-- then FOR UPDATE on one grant row, the order PIN removal and PIN change use;
-- it never inserts a grant, so P4b's BEFORE INSERT probation trigger never
-- fires for it, and it refuses a break-glass grant before writing.
--
-- Applied migrations 0001 through 0086 are immutable.

-- 0. Preconditions. The release dry-runs every pending migration in one
-- transaction before applying any, so a refusal here stops the release with
-- nothing changed. These are catalog reads; only pg_get_constraintdef locks a
-- table, a momentary ACCESS SHARE on identity.consent_grants (see Locks).
do $$
declare
  mismatch text;
begin
  if exists (select 1 from pg_proc proc
              where proc.pronamespace = 'identity'::regnamespace and proc.proname = 'revoke_my_consent_grant') then
    raise exception '0087: identity.revoke_my_consent_grant already exists; this release would collide with it';
  end if;
  -- The two bodies this migration replaces (md5 of pg_proc.prosrc, measured
  -- on 0001-0086: 0030 and 0037 bodies, never replaced since).
  select string_agg(format('%s md5 %s', expected.proc, md5(proc.prosrc)), '; ') into mismatch
    from (values ('identity.patient_self_access_history(text,uuid)'::regprocedure, 'ca6c848749f55e08a5f7a0a60c838293'),
                 ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)'::regprocedure,
                  '662353fa2a411879e4e8d869d54827d5'))
         expected(proc, digest)
    join pg_proc proc on proc.oid = expected.proc
   where md5(proc.prosrc) <> expected.digest;
  if mismatch is not null then
    raise exception '0087: a function this migration replaces has another body than 0030 or 0037 gave it: %', mismatch;
  end if;
  -- The bodies the new command relies on: the live-session binding (0030),
  -- and the three PIN commands that take the same advisory key (0033, 0075).
  select string_agg(format('%s md5 %s', expected.proc, md5(proc.prosrc)), '; ') into mismatch
    from (values ('identity.patient_self_session(text,uuid)'::regprocedure, 'd4c7aeaf25317d0fae794a2764d7d72b'),
                 ('identity.set_my_patient_access_pin(text,uuid,text)'::regprocedure, '78ef55c9025781647ef87e3d76a3e6c3'),
                 ('identity.revoke_my_patient_access_pin(text,uuid)'::regprocedure, 'e3c264f006cad96999a31f506bf03739'),
                 ('identity.access_patient_with_pin(text,text,integer)'::regprocedure, '88c55e2ce17bab0c6ccb4cbe5f9f6723'))
         expected(proc, digest)
    join pg_proc proc on proc.oid = expected.proc
   where md5(proc.prosrc) <> expected.digest;
  if mismatch is not null then
    raise exception '0087: a function the revocation relies on has another body than 0030, 0033 or 0075 gave it: %', mismatch;
  end if;
  -- The grant invariants the revocability rule reads: a grantor is the
  -- patient (0008), a PIN grant is never break-glass (0033), and for this
  -- platform's rows scope break_glass and the flag agree and revoked means
  -- revoked_at (0003).
  select string_agg(expected.definition, '; ') into mismatch
    from (values ('CHECK (((granted_by_patient_id IS NULL) OR (granted_by_patient_id = patient_id)))'),
                 ('CHECK (((authorization_method IS DISTINCT FROM ''patient_access_pin''::text) OR ((scope = ''read_records''::text) AND (purpose_of_use = ''direct-care''::text) AND (break_glass = false))))'),
                 ('CHECK ((((scope = ''break_glass''::text) = break_glass) OR (source_system <> ''hid''::text)))'),
                 ('CHECK ((((status = ''revoked''::text) = (revoked_at IS NOT NULL)) OR (source_system <> ''hid''::text)))'))
         expected(definition)
   where not exists (select 1 from pg_constraint constraint_row
                      where constraint_row.conrelid = 'identity.consent_grants'::regclass
                        and constraint_row.contype = 'c'
                        and pg_get_constraintdef(constraint_row.oid) = expected.definition);
  if mismatch is not null then
    raise exception '0087: identity.consent_grants lacks a check the revocation relies on: %', mismatch;
  end if;
  -- The revoke's UPDATE fires no trigger: the table's only user trigger is
  -- P4b's BEFORE INSERT ... FOR EACH ROW probation trigger (0086).
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'identity.consent_grants'::regclass and not trigger_row.tgisinternal) <> 1
     or not exists (select 1 from pg_trigger trigger_row
                     where trigger_row.tgrelid = 'identity.consent_grants'::regclass
                       and trigger_row.tgname = 'consent_grants_self_service_probation'
                       and trigger_row.tgtype = 7
                       and trigger_row.tgfoid = 'identity.enforce_self_service_break_glass_probation()'::regprocedure) then
    raise exception '0087: identity.consent_grants must have exactly one user trigger, 0086''s BEFORE INSERT probation trigger';
  end if;
end
$$;

-- 1. The patient's revocation of a grant they gave (main 0066 lines 329-391).
create function identity.revoke_my_consent_grant(
  requested_subject text,
  requested_session uuid,
  requested_grant_id uuid,
  requested_reason text
) returns table (consent_grant_id uuid, grant_status text, revoked_at timestamptz, replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp as $$
#variable_conflict use_column
declare
  patient_id_value uuid;
  account_id_value uuid;
  grant_row identity.consent_grants%rowtype;
  revoked_at_value timestamptz;
begin
  patient_id_value := identity.patient_self_session(requested_subject, requested_session);
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if length(btrim(coalesce(requested_reason, ''))) not between 3 and 500 then
    raise exception using errcode = '22023', message = 'A revocation reason is required';
  end if;
  select account_id into account_id_value from identity.patients where id = patient_id_value;
  -- Serialize with PIN verification, replacement and removal for this patient.
  perform pg_advisory_xact_lock(hashtextextended('patient-access-pin:' || patient_id_value::text, 0));
  select * into grant_row from identity.consent_grants grant_candidate
   where grant_candidate.id = requested_grant_id and grant_candidate.patient_id = patient_id_value
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'The access grant is unavailable';
  end if;
  if grant_row.break_glass or grant_row.scope = 'break_glass'
     or not (grant_row.granted_by_patient_id is not distinct from patient_id_value
       or grant_row.authorization_method is not distinct from 'patient_access_pin') then
    raise exception using errcode = '55000', message = 'CONSENT_GRANT_NOT_PATIENT_REVOCABLE';
  end if;
  if grant_row.status = 'revoked' then
    return query select grant_row.id, 'revoked'::text, grant_row.revoked_at, true;
    return;
  end if;
  if grant_row.status <> 'active' or grant_row.expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'The access grant is no longer active';
  end if;
  revoked_at_value := clock_timestamp();
  update identity.consent_grants
     set status = 'revoked', revoked_at = revoked_at_value, revoked_by = account_id_value,
         revoked_reason = btrim(requested_reason), updated_at = revoked_at_value,
         row_version = row_version + 1
   where id = grant_row.id;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, patient_id, facility_id,
    action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    grant_row.facility_id, 'identity.consent-grant.patient-revoke', 'success', 'consent-grant',
    grant_row.id::text, 'patient-self', 'Revoked by the patient', 'application', 'identity-api',
    jsonb_build_object('scope', grant_row.scope,
      'authorizationMethod', coalesce(grant_row.authorization_method, 'patient_approval'))
  );
  return query select grant_row.id, 'revoked'::text, revoked_at_value, false;
end
$$;
revoke all on function identity.revoke_my_consent_grant(text, uuid, uuid, text) from public;

-- 2. The access history's labels (main 0066 lines 393-412). Signature,
-- SECURITY DEFINER, STABLE, search_path and result type are 0030's, so
-- CREATE OR REPLACE keeps the owner and the grants (runtime-grants.sql
-- 783-791). revocableByPatient is main's patientRevocable under another
-- name (see the header); breakGlass is main's, also recognised by scope.
-- The limit keeps revocable grants first, then lists the chosen items newest
-- first, as 0030 does.
create or replace function identity.patient_self_access_history(requested_subject text, requested_session uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare patient uuid; result jsonb;
begin
  patient := identity.patient_self_session(requested_subject,requested_session);
  if patient is null then return null; end if;
  select jsonb_build_object('items',coalesce(jsonb_agg(entries.item order by entries.created_at desc,entries.id desc),
      '[]'::jsonb)) into result from (
    select jsonb_build_object('consentGrantId',g.id,'scope',g.scope,'purpose',g.purpose_of_use,
      'status',case when g.status='active' and g.expires_at<=statement_timestamp() then 'expired' else g.status end,
      'startsAt',g.starts_at,'expiresAt',g.expires_at,'reason',g.reason,'facilityName',f.name,
      'breakGlass',g.break_glass or g.scope='break_glass',
      'revocableByPatient',labelled.revocable) as item, g.created_at, g.id
    from identity.consent_grants g join identity.facilities f on f.id=g.facility_id
    cross join lateral (select g.status='active' and g.expires_at>statement_timestamp()
        and not g.break_glass and g.scope<>'break_glass'
        and (g.granted_by_patient_id is not distinct from patient
          or g.authorization_method is not distinct from 'patient_access_pin') as revocable) labelled
    where g.patient_id=patient order by labelled.revocable desc,g.created_at desc,g.id desc limit 50
  ) entries;
  return result;
end;
$$;

-- 3. No new inbox item for a deleted login (main 0066 lines 414-440).
-- Signature, SECURITY DEFINER, search_path and result are 0037's, so CREATE OR
-- REPLACE keeps the owner and the ACL (revoked from PUBLIC, granted to no
-- role; only owner-owned commands and triggers call it).
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
  select patient.account_id into recipient_account
    from identity.patients patient
    join auth.accounts account on account.id = patient.account_id
   where patient.id = requested_patient_id and patient.status = 'active'
     and account.status <> 'deleted';
  if recipient_account is null then return null; end if;
  insert into notification.inbox_items(account_id,patient_id,notification_code,resource_type,resource_id,metadata)
    values(recipient_account,requested_patient_id,requested_code,requested_resource_type,
      requested_resource_id,coalesce(requested_metadata,'{}'::jsonb))
    returning id into item_id;
  return item_id;
end
$$;

-- 4. Grants. The revoke goes to the Identity runtime (hid_identity_api_runtime
-- inherits it) and the schema test runtime, as main grants it
-- (eb9b1ca:services/ehr-api/database/runtime-grants.sql:1669, 1684);
-- runtime-grants.sql carries the same grant. The two replaced functions keep
-- their ACLs.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.revoke_my_consent_grant(text, uuid, uuid, text) to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function identity.revoke_my_consent_grant(text, uuid, uuid, text) to hid_schema_test_runtime;
  end if;
end
$$;
