-- 0131 Opening this facility's own patient without a PIN (ID-4, Release A of
-- the Akos EHR plan of 18 November 2026). Written on staging-novu-ci-20261005
-- at afec3f75 with 0130; this file requires 0001-0127 and 0130 applied. 0128
-- (hid-system#264, the PIN-use notice) ships before it and changes nothing
-- this file reads or replaces (it adds a trigger on identity.outbox_events and
-- replaces identity.list_my_access_requests()). The declaration is signed
-- separately (the release integrator's).
--
-- Owner, 18 November 2026 (Q101, recommended answer accepted): staff may
-- open their own facility's patients without a PIN. A patient is this
-- facility's when the patient was registered at this facility's desk, or had
-- a consented visit at this facility in the last 24 months. Doctors, nurses
-- and clinicians only; 24 hours; every opening is in the patient's access
-- history; check-in-only and emergency-only visits do not count. Lab and
-- pharmacy staff never get it (they see their own facility's work items
-- only, never the chart), and neither does the front desk (receptionists
-- hold identity.patient.read, finding F4).
--
-- WHAT IT DOES
--   1. A new permission, identity.patient.open-own-facility, granted to the
--      doctor, clinician and nurse roles only.
--   2. identity.consent_grants: authorization_method may be 'own_facility'
--      (consent_grants_authorization_method_ck replaced), and
--      consent_grants_own_facility_shape_ck holds such a grant to write
--      records for direct care, not break-glass, with no access request and
--      no patient as grantor. No access request is written, so 0104's
--      records-processing cover (an approved request or a PIN, or a patient
--      share) never counts it: no OCR or Migrate cover, unchanged.
--   3. ehr.encounters gains encounters_owner_read: row-level security on it
--      is forced, and identity.own_facility_basis reads this facility's
--      visits for a doctor who holds no grant yet, so the table's owner may
--      read it (0130 does the same for the registration cases). No runtime
--      role is a member of the owner.
--   4. identity.own_facility_basis(patient uuid, facility uuid) (SECURITY
--      DEFINER, STABLE; no EXECUTE for any runtime role): 'registered_here',
--      'visit_here' or null.
--      registered_here: a registration case at this facility for the
--      patient that is
--        - resolved_existing_identity whose checked NIN is the patient's
--          active checked NIN,
--        - approved_new_identity or linked_existing with a NIN case whose
--          checked NIN the case attached to the patient (still active),
--        - approved_new_identity without a NIN (0130) that created the
--          patient (source_system 'hid-desk-registration'), or
--        - linked_existing without a NIN (0130) that the patient then
--          confirmed: a grant the patient gave (approval or Access PIN) to a
--          member of this facility after the link.
--      visit_here: a visit (ehr.encounters) at this facility started in the
--      last 24 months, not cancelled or entered in error, not imported
--      paper records, and started under a grant the patient gave to the
--      member who started it (approval or Access PIN, direct care, not
--      break-glass, active when the visit was created). A visit started
--      under another own-facility grant, under records processing or under
--      nothing the patient gave (a check-in by the desk, EHR-C7) does not
--      count; break-glass can never start a visit (it only reads).
--   5. identity.open_own_facility_patient(requested_hid text,
--      requested_patient_id uuid) (SECURITY DEFINER), for the Identity
--      runtime: exactly one of a Health ID or a patient id; the caller holds
--      identity.patient.open-own-facility at this facility, for direct care,
--      with an active membership. It answers outcome 'not_found' (no active
--      patient with that Health ID or id, or one the facility's seal does
--      not allow), 'refused' (no basis, an active deny directive for this
--      facility, or the patient revoked an own-facility opening here within
--      the last 24 hours), or 'opened' with a 24-hour write grant
--      (authorization_method own_facility), reusing this member's active
--      one. Every call writes one audit row (identity.patient.open-own-facility,
--      success or denied, with the basis or the refusal kind).
--   6. The patient's side: identity.patient_self_access_history gains
--      'basis' on each item ('own-facility', 'pin', 'share', 'approval',
--      'emergency' or 'other'), and an own-facility grant is revocable by the
--      patient; identity.revoke_my_consent_grant accepts it;
--      identity.note_record_access notes it with access kind 'own_facility'
--      ("Your records were opened"), and the notice table's check admits it.
--   7. EXECUTE on 5 for hid_identity_runtime only (here when the role
--      exists, and in runtime-grants.sql).
--
-- Locks: ACCESS EXCLUSIVE on identity.consent_grants (replace a CHECK and add
-- one; one validating scan each) and identity.record_access_notices (replace
-- its CHECK), and on ehr.encounters (CREATE POLICY), held to commit, behind
-- the runner's 5 s lock_timeout (nothing applied when it expires). Writes to
-- these tables wait for that time; reads of ehr.encounters too.
--
-- Old services on this schema: today's identity-api never writes
-- 'own_facility' and never calls the new functions; the patient's history
-- gains one field it ignores. The identity-api of this branch needs this
-- file before it serves POST identity/own-facility-access.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 1-7. As above.
-- 8. Post-checks.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regprocedure('identity.organization_staff_kinds(uuid)') is null
     or to_regprocedure('identity.register_patient_without_nin(uuid, text, text, date, text, text, text, bytea, bytea, text, text, text, text, text)') is null then
    raise exception using errcode = '55000', message = '0131: 0001-0127 and 0130 must be applied first';
  end if;
  if to_regprocedure('identity.open_own_facility_patient(text, uuid)') is not null
     or exists (select 1 from auth.permissions where code = 'identity.patient.open-own-facility') then
    raise exception using errcode = '55000', message = '0131: already applied';
  end if;
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('identity.patient_self_access_history(text,uuid)', '0aef8026c24f923c1612280447f99b66'),
      ('identity.note_record_access(uuid)', '17f848552daf9ce0f38c93b33d2a6e96'),
      ('identity.revoke_my_consent_grant(text,uuid,uuid,text)', '247cc02f4309418c68bca5bfc41b676f'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)', '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('identity.records_processing_direct_care_cover(uuid,text,uuid,uuid,text,timestamp with time zone)', '6928763d3b69f0e4b4acf96a6a255736'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0131: these bodies are not as 0001-0130 left them: ' || mismatch;
  end if;
  if (select md5(pg_get_constraintdef(constraint_row.oid)) from pg_constraint constraint_row
       where constraint_row.conrelid = 'identity.consent_grants'::regclass
         and constraint_row.conname = 'consent_grants_authorization_method_ck') is distinct from 'fa8f9da2a8bc50ecd4a3802caa9af000'
     or (select md5(pg_get_constraintdef(constraint_row.oid)) from pg_constraint constraint_row
       where constraint_row.conrelid = 'identity.record_access_notices'::regclass
         and constraint_row.conname = 'record_access_notices_access_kind_check') is distinct from '0913c063d9f72a1762936da60173d085' then
    raise exception using errcode = '55000', message = '0131: the grant method or notice kind check is not as 0098 and 0095 made it';
  end if;
  if not exists (select 1 from auth.roles where code = 'doctor')
     or not exists (select 1 from auth.roles where code = 'clinician')
     or not exists (select 1 from auth.roles where code = 'nurse') then
    raise exception using errcode = '55000', message = '0131: the doctor, clinician and nurse roles must exist';
  end if;
end
$$;

-- 1. The permission.
insert into auth.permissions (code, description) values
  ('identity.patient.open-own-facility',
   'Open this facility''s own patient (registered at its desk, or a consented visit here in the last 24 months) for 24 hours without a PIN (0131, owner Q101)');
insert into auth.role_permissions (role_code, permission_code)
select role_code, 'identity.patient.open-own-facility'
  from (values ('doctor'), ('clinician'), ('nurse')) granted(role_code);

-- 2. The grant's method.
alter table identity.consent_grants
  drop constraint consent_grants_authorization_method_ck,
  add constraint consent_grants_authorization_method_ck
    check (authorization_method is null or authorization_method in ('patient_access_pin', 'own_facility')),
  add constraint consent_grants_own_facility_shape_ck
    check (authorization_method is distinct from 'own_facility'
      or (scope = 'write_records' and purpose_of_use = 'direct-care' and break_glass = false
          and request_id is null and granted_by_patient_id is null));
create index consent_grants_own_facility_idx
  on identity.consent_grants (patient_id, facility_id, status, expires_at desc)
  where authorization_method = 'own_facility';

alter table identity.record_access_notices
  drop constraint record_access_notices_access_kind_check,
  add constraint record_access_notices_access_kind_check
    check (access_kind in ('standard', 'share', 'pin', 'own_facility'));

-- 3. The visits' owner may read them.
create policy encounters_owner_read on ehr.encounters
  for select
  using (pg_has_role((select relation.relowner from pg_class relation
                       where relation.oid = 'ehr.encounters'::regclass), 'USAGE'));

-- 4. The basis.
create function identity.own_facility_basis(requested_patient_id uuid, requested_facility_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select case
    when exists (
      select 1
        from identity.registration_cases registration
        join identity.patients patient on patient.id = registration.resolved_patient_id
       where registration.facility_id = requested_facility_id
         and registration.resolved_patient_id = requested_patient_id
         and (
           (registration.identity_evidence = 'nin_verified'
            and registration.status = 'resolved_existing_identity'
            and exists (select 1 from identity.patient_identifiers identifier
                         where identifier.patient_id = registration.resolved_patient_id
                           and identifier.identifier_type = 'nin'
                           and identifier.lookup_hmac = registration.nin_lookup_hmac
                           and identifier.verified and identifier.revoked_at is null))
           or (registration.identity_evidence = 'nin_verified'
               and registration.status in ('approved_new_identity', 'linked_existing')
               and exists (select 1 from identity.patient_identifiers identifier
                            where identifier.patient_id = registration.resolved_patient_id
                              and identifier.identifier_type = 'nin'
                              and identifier.registration_case_id = registration.id
                              and identifier.verified and identifier.revoked_at is null))
           or (registration.identity_evidence = 'none'
               and registration.status = 'approved_new_identity'
               and patient.source_system = 'hid-desk-registration')
           or (registration.identity_evidence = 'none'
               and registration.status = 'linked_existing'
               and exists (select 1 from identity.consent_grants grant_row
                            where grant_row.patient_id = registration.resolved_patient_id
                              and grant_row.facility_id = requested_facility_id
                              and grant_row.source_system = 'hid'
                              and grant_row.purpose_of_use = 'direct-care'
                              and not grant_row.break_glass
                              and grant_row.created_at >= registration.updated_at
                              and (grant_row.authorization_method = 'patient_access_pin'
                                   or (grant_row.authorization_method is null
                                       and grant_row.granted_by_patient_id = grant_row.patient_id))))
         ))
      then 'registered_here'
    when exists (
      select 1
        from ehr.encounters encounter
       where encounter.patient_id = requested_patient_id
         and encounter.facility_id = requested_facility_id
         and encounter.started_at >= statement_timestamp() - interval '24 months'
         and encounter.status not in ('cancelled', 'entered_in_error')
         and not encounter.imported_paper_records
         and exists (select 1 from identity.consent_grants grant_row
                      where grant_row.patient_id = encounter.patient_id
                        and grant_row.facility_id = encounter.facility_id
                        and grant_row.membership_id = encounter.created_by_membership_id
                        and grant_row.source_system = 'hid'
                        and grant_row.migration_hold_reason is null
                        and grant_row.purpose_of_use = 'direct-care'
                        and not grant_row.break_glass and grant_row.scope <> 'break_glass'
                        and grant_row.starts_at <= encounter.created_at
                        and grant_row.expires_at > encounter.created_at
                        and (grant_row.revoked_at is null or grant_row.revoked_at > encounter.created_at)
                        and (grant_row.authorization_method = 'patient_access_pin'
                             or (grant_row.authorization_method is null
                                 and grant_row.granted_by_patient_id = grant_row.patient_id))))
      then 'visit_here'
  end
$$;

comment on function identity.own_facility_basis(uuid, uuid) is
  '0131 (ID-4, owner Q101 of 18 November 2026): registered_here (a registration at this facility that created the patient, resolved the patient''s checked NIN, attached its checked NIN, or, without a NIN, was linked and then confirmed by the patient), visit_here (a visit here started in the last 24 months, not cancelled or entered in error, not imported paper records, started under a grant the patient gave to the member who started it), or null. Check-in-only, emergency-only and own-facility-only visits do not count.';
revoke all on function identity.own_facility_basis(uuid, uuid) from public;

-- 5. The command.
create function identity.open_own_facility_patient(requested_hid text, requested_patient_id uuid)
returns table (outcome text, consent_grant_id uuid, subject_patient_id uuid, grant_status text,
  expires_at timestamptz, existing_grant boolean, basis text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  actor_correlation text := platform.current_correlation_id();
  actor_staff uuid;
  actor_organization uuid;
  patient_value uuid;
  basis_value text;
  refusal text;
  grant_value uuid;
  grant_expires timestamptz;
  reused boolean := false;
  grant_minutes constant integer := 1440;
  grant_reason constant text := 'Opened as this facility''s patient';
begin
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
                                           'identity.patient.open-own-facility') then
    raise exception using errcode = '42501', message = 'OWN_FACILITY_ACCESS_NOT_PERMITTED';
  end if;
  if platform.current_purpose_of_use() is distinct from 'direct-care'
     or not exists (select 1 from identity.purpose_of_use_codes where code = 'direct-care' and active) then
    raise exception using errcode = '22023', message = 'OWN_FACILITY_ACCESS_DIRECT_CARE_ONLY';
  end if;
  if (requested_hid is null) = (requested_patient_id is null)
     or (requested_hid is not null and upper(btrim(requested_hid)) !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$') then
    raise exception using errcode = '22023', message = 'OWN_FACILITY_ACCESS_INVALID';
  end if;
  select membership.staff_id, membership.organization_id into actor_staff, actor_organization
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.account_id = actor_account
     and membership.facility_id = actor_facility and membership.active
     and membership.migration_hold_reason is null;
  if actor_staff is null then
    raise exception using errcode = '42501', message = 'OWN_FACILITY_ACCESS_NOT_PERMITTED';
  end if;

  select patient.id into patient_value
    from identity.patients patient
   where patient.status = 'active'
     and ((requested_hid is not null and upper(patient.hid_code) = upper(btrim(requested_hid)))
          or (requested_patient_id is not null and patient.id = requested_patient_id))
     and identity.sealed_demo_facility(actor_facility) = identity.sealed_demo_patient(patient.id)
     and identity.sealed_qa_facility(actor_facility) = identity.sealed_qa_patient(patient.id)
   limit 1;

  if patient_value is null then
    refusal := 'not_found';
  else
    perform pg_advisory_xact_lock(hashtextextended(
      'own-facility-open:' || actor_membership::text || ':' || patient_value::text, 0));
    if exists (
      select 1
        from identity.consent_directives directive
        join identity.consent_directive_versions directive_version
          on directive_version.directive_id = directive.id
         and directive_version.version_no = directive.current_version
       where directive.patient_id = patient_value
         and directive_version.status = 'active'
         and directive_version.provision_type = 'deny'
         and directive_version.starts_at <= clock_timestamp()
         and (directive_version.expires_at is null or directive_version.expires_at > clock_timestamp())
         and (directive_version.facility_id is null or directive_version.facility_id = actor_facility)
         and (cardinality(directive_version.actions) = 0
              or directive_version.actions && array['read_records', 'write_records']::text[])
         and (cardinality(directive_version.purposes) = 0 or 'direct-care' = any (directive_version.purposes))
         and (directive_version.grantee_type = 'all'
              or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = actor_facility)
              or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = actor_organization)
              or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = actor_staff))) then
      refusal := 'deny_directive';
    elsif exists (
      select 1 from identity.consent_grants revoked
       where revoked.patient_id = patient_value and revoked.facility_id = actor_facility
         and revoked.authorization_method = 'own_facility' and revoked.status = 'revoked'
         and revoked.revoked_at > clock_timestamp() - interval '24 hours') then
      refusal := 'revoked_by_patient';
    else
      basis_value := identity.own_facility_basis(patient_value, actor_facility);
      if basis_value is null then
        refusal := 'not_own_facility';
      end if;
    end if;
  end if;

  if refusal is not null then
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
      actor_organization, actor_facility, patient_value, 'identity.patient.open-own-facility', 'denied',
      'patient', patient_value::text, 'direct-care', 'application', 'identity-api',
      jsonb_build_object('refusal', refusal,
        'identifiedBy', case when requested_hid is not null then 'health_id' else 'patient_id' end)
    );
    return query select case when refusal = 'not_found' then 'not_found' else 'refused' end,
      null::uuid, null::uuid, null::text, null::timestamptz, false, null::text;
    return;
  end if;

  select grant_row.id, grant_row.expires_at into grant_value, grant_expires
    from identity.consent_grants grant_row
   where grant_row.patient_id = patient_value and grant_row.account_id = actor_account
     and grant_row.membership_id = actor_membership and grant_row.facility_id = actor_facility
     and grant_row.authorization_method = 'own_facility' and grant_row.status = 'active'
     and grant_row.expires_at > clock_timestamp() and grant_row.migration_hold_reason is null
   order by grant_row.expires_at desc
   limit 1;
  if grant_value is null then
    grant_value := pg_catalog.gen_random_uuid();
    grant_expires := current_timestamp + make_interval(mins => grant_minutes);
    insert into identity.consent_grants (
      id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
      scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass,
      correlation_id, authorization_method
    ) values (
      grant_value, null, patient_value, actor_staff, actor_account, actor_membership, actor_facility,
      'write_records', 'direct-care', 'active', grant_reason, current_timestamp, grant_expires, false,
      actor_correlation, 'own_facility'
    );
  else
    reused := true;
  end if;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, patient_value, 'identity.patient.open-own-facility', 'success',
    'consent-grant', grant_value::text, 'direct-care', 'application', 'identity-api',
    jsonb_build_object('basis', basis_value, 'existing_grant', reused, 'expires_at', grant_expires,
      'scope', 'write_records', 'duration_minutes', grant_minutes,
      'identifiedBy', case when requested_hid is not null then 'health_id' else 'patient_id' end)
  );
  return query select 'opened'::text, grant_value, patient_value, 'active'::text, grant_expires, reused,
    'own-facility'::text;
end
$$;

comment on function identity.open_own_facility_patient(text, uuid) is
  '0131 (ID-4, owner Q101 of 18 November 2026): a doctor, nurse or clinician opens this facility''s own patient (identity.own_facility_basis) by Health ID or patient id, for direct care, without a PIN: a 24-hour write grant (authorization_method own_facility, no access request, so no records-processing cover), reused while this member''s is active. not_found for no active patient the seal allows; refused for no basis, a deny directive, or a patient revocation here in the last 24 hours. Every call is audited.';
revoke all on function identity.open_own_facility_patient(text, uuid) from public;

-- 6. The patient's side.
create or replace function identity.patient_self_access_history(requested_subject text, requested_session uuid)
returns jsonb
language plpgsql
stable security definer
set search_path = pg_catalog, pg_temp
as $function$
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
      'revocableByPatient',labelled.revocable,
      -- 0131: how the access was given ("Opened as this facility's patient" for own-facility).
      'basis',case when g.break_glass or g.scope='break_glass' then 'emergency'
        when g.authorization_method='own_facility' then 'own-facility'
        when g.authorization_method='patient_access_pin' then 'pin'
        when s.consent_grant_id is not null then 'share'
        when g.granted_by_patient_id is not distinct from patient then 'approval'
        else 'other' end,
      'shareLevel',s.level,'shareDuration',s.duration_preset,
      'clinicianName',case when s.consent_grant_id is not null then st.full_name end) as item, g.created_at, g.id
    from identity.consent_grants g join identity.facilities f on f.id=g.facility_id
    left join identity.patient_consent_shares s on s.consent_grant_id=g.id
    left join identity.staff st on st.id=g.staff_id and s.consent_grant_id is not null
    cross join lateral (select g.status='active' and g.expires_at>statement_timestamp()
        and not g.break_glass and g.scope<>'break_glass'
        and (g.granted_by_patient_id is not distinct from patient
          or g.authorization_method is not distinct from 'patient_access_pin'
          or g.authorization_method is not distinct from 'own_facility') as revocable) labelled
    where g.patient_id=patient order by labelled.revocable desc,g.created_at desc,g.id desc limit 50
  ) entries;
  return result;
end;
$function$;

create or replace function identity.revoke_my_consent_grant(requested_subject text, requested_session uuid,
  requested_grant_id uuid, requested_reason text)
returns table(consent_grant_id uuid, grant_status text, revoked_at timestamp with time zone, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $function$
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
  -- 0131: an own-facility opening is the patient's to revoke too.
  if grant_row.break_glass or grant_row.scope = 'break_glass'
     or not (grant_row.granted_by_patient_id is not distinct from patient_id_value
       or grant_row.authorization_method is not distinct from 'patient_access_pin'
       or grant_row.authorization_method is not distinct from 'own_facility') then
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
$function$;

create or replace function identity.note_record_access(requested_consent_grant_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  subject_value text := platform.current_actor_subject();
  membership_value uuid := platform.current_membership_id();
  facility_value uuid := platform.current_facility_id();
  account_id_value uuid;
  grant_row identity.consent_grants%rowtype;
  day_value date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  kind_value text;
  notice_id_value uuid := gen_random_uuid();
  inbox_id_value uuid;
  facility_name_value text;
  recipient_exists boolean;
begin
  select account.id into account_id_value from auth.accounts account where account.subject = subject_value;
  if account_id_value is null or membership_value is null or facility_value is null
     or platform.current_correlation_id() is null then
    return 'not_applicable';
  end if;
  select * into grant_row from identity.consent_grants candidate
   where candidate.id = requested_consent_grant_id and candidate.membership_id = membership_value
     and candidate.facility_id = facility_value and candidate.account_id = account_id_value
     and candidate.status = 'active' and candidate.starts_at <= clock_timestamp()
     and candidate.expires_at > clock_timestamp() and not candidate.break_glass and candidate.scope <> 'break_glass'
     and candidate.migration_hold_reason is null;
  if not found then
    perform identity.share_audit('staff', subject_value, account_id_value, membership_value, facility_value, null,
      'identity.record-access-notice.note', 'denied', 'consent-grant', null, platform.current_purpose_of_use(),
      jsonb_build_object('reason', 'not_applicable'));
    return 'not_applicable';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('record-access-notice:' || grant_row.patient_id::text, 0));
  if exists (select 1 from identity.record_access_notices notice
              where notice.patient_id = grant_row.patient_id and notice.facility_id = facility_value
                and notice.notice_day = day_value) then
    return 'already_noted';
  end if;
  if (select count(*) from identity.record_access_notices notice
       where notice.patient_id = grant_row.patient_id and notice.notice_day = day_value) >= 10 then
    return 'capped';
  end if;
  kind_value := case
    when grant_row.authorization_method = 'patient_access_pin' then 'pin'
    -- 0131: opened as this facility's own patient.
    when grant_row.authorization_method = 'own_facility' then 'own_facility'
    when exists (select 1 from identity.patient_consent_shares share where share.consent_grant_id = grant_row.id)
      then 'share'
    else 'standard' end;
  select facility.name into facility_name_value from identity.facilities facility where facility.id = facility_value;
  inbox_id_value := notification.enqueue_patient_inbox_item(grant_row.patient_id, 'RECORDS_OPENED', 'record-access',
    notice_id_value, jsonb_strip_nulls(jsonb_build_object('facilityName', facility_name_value, 'accessKind', kind_value)));
  recipient_exists := exists (select 1 from integration.verified_notification_recipient(grant_row.patient_id));
  insert into identity.record_access_notices (
    id, patient_id, facility_id, membership_id, consent_grant_id, notice_day, access_kind, first_access_at,
    inbox_item_id, email_status, next_attempt_at
  ) values (
    notice_id_value, grant_row.patient_id, facility_value, membership_value, grant_row.id, day_value, kind_value,
    clock_timestamp(), inbox_id_value, case when recipient_exists then 'pending' else 'not_sent' end,
    case when recipient_exists then clock_timestamp() end
  );
  perform identity.share_audit('staff', subject_value, account_id_value, membership_value, facility_value,
    grant_row.patient_id, 'identity.record-access-notice.note', 'success', 'record-access', notice_id_value,
    platform.current_purpose_of_use(), jsonb_build_object('accessKind', kind_value));
  return 'noted';
end
$function$;

-- 7. Owners and EXECUTE.
do $$
declare
  grant_owner name := (select pg_get_userbyid(proowner) from pg_proc
                        where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
begin
  if grant_owner <> current_user then
    execute format('alter function identity.own_facility_basis(uuid, uuid) owner to %I', grant_owner);
    execute format('alter function identity.open_own_facility_patient(text, uuid) owner to %I', grant_owner);
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.open_own_facility_patient(text, uuid) to hid_identity_runtime;
  end if;
end
$$;

-- 8. Post-checks.
do $$
begin
  if (select array_agg(role_code order by role_code) from auth.role_permissions
       where permission_code = 'identity.patient.open-own-facility') is distinct from array['clinician', 'doctor', 'nurse'] then
    raise exception using errcode = '55000', message = '0131: identity.patient.open-own-facility is not held by exactly doctor, clinician and nurse';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'identity.consent_grants'::regclass
                  and conname = 'consent_grants_own_facility_shape_ck' and convalidated) then
    raise exception using errcode = '55000', message = '0131: consent_grants_own_facility_shape_ck is not valid';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid = 'identity.open_own_facility_patient(text, uuid)'::regprocedure
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime')) then
    raise exception using errcode = '55000', message = '0131: identity.open_own_facility_patient is granted to a role other than hid_identity_runtime';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid = 'identity.own_facility_basis(uuid, uuid)'::regprocedure
                and acl.grantee <> proc.proowner) then
    raise exception using errcode = '55000', message = '0131: identity.own_facility_basis is granted to a role';
  end if;
end
$$;
