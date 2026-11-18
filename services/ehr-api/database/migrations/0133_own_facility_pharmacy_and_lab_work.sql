-- 0133 This facility's own pharmacy and lab work: activated prescriptions go
-- to the hospital's own pharmacy by themselves, and the facility's pharmacy
-- and lab staff work on their own facility's work items without a personal
-- consent grant (ORD-2 of the Akos EHR plan of 18 November 2026, Release A,
-- lane D; it also fixes the plan's finding F2 and Akos item N-4). Written on
-- staging-novu-ci-20261005 at 1f5e2c2a, where 0001-0127 are applied. 0128
-- (hid-system#264) and 0129 (hid-system#266) are booked before this number
-- and replace nothing this file reads or replaces. This file requires
-- 0001-0127 applied. The declaration is signed separately (the release
-- integrator's).
--
-- Owner, 18 November 2026: "activated prescriptions go automatically to the
-- hospital's own pharmacy: YES", and "pharmacy and lab staff get their own
-- facility's work items only, never the chart".
--
-- THE GAP (F2). This facility's own pharmacy and lab work (no order route)
-- is read, and dispensed or worked on, only by a member who personally
-- holds a consent grant for the patient: the work items' read policies
-- (lab|pharmacy.work_item_allows, 0086 H8), the chain tables' policies
-- (lab|pharmacy.context_allows, 0086) and 0124's patient cards all ask the
-- member's own consent. So a prescription sent to the hospital's pharmacy
-- shows the pharmacist "To dispense 0" and a card without a name, and a
-- doctor, who does not hold pharmacy.work-item.accept, cannot send it there.
--
-- WHAT IT DOES
-- D1 identity.facility_work_member_allows(kind, patient, facility, action):
--    true when the session works for this facility's pharmacy ('pharmacy')
--    or laboratory ('lab'): purpose direct-care; the row's facility is the
--    session's; the member holds, at that facility, <kind>.work-item.read
--    and <kind>.order-route.receive (the permission that already lets the
--    pharmacist and the lab scientist work on another facility's orders;
--    held today by the pharmacist and lab roles only, so doctors, nurses,
--    clinicians, receptionists and admins gain nothing from it); the
--    membership is active (auth.membership_has_permission); the patient is
--    active; and no active deny directive of the patient covers this
--    member, facility, action and purpose (the same test as the consent
--    check's). Emergency sessions keep their own rule (break-glass) and do
--    not use this one.
-- D2 lab.work_item_allows and pharmacy.work_item_allows (0086 H8, the work
--    items' read and insert policies) gain one branch: an own work item (no
--    route) passes when D1 allows its patient. This is the item itself.
-- D3 lab.context_allows and pharmacy.context_allows (the chain tables:
--    accessions, specimens, executions, results, events, dispensings,
--    reversals, outbox) gain one branch: D1 allows the patient and the
--    patient has an own work item at this facility. The imported evidence
--    tables use the same function, as they already do for route-backed
--    access (0086); the Lab and Pharmacy APIs still ask Identity's consent
--    before any imported-evidence route, which this file does not change.
-- D4 lab.work_item_patient_cards and pharmacy.work_item_patient_cards (0124)
--    gain the same branch next to the consent test, so the card shows the
--    patient's name on the item the member may now work on.
-- D5 ehr.prescriptions gains two policies for the owner of
--    pharmacy.validate_dispensing only (TO that role; no runtime role is
--    that role or a member of it): the owner may read, and lock FOR SHARE,
--    the source prescription of an own pharmacy work item that D1 lets the
--    session work on (pharmacy.own_work_source_prescription). The
--    dispensing validator (0101) reads the source prescription as its owner;
--    under production's forced row-level security it would otherwise find
--    nothing for a pharmacist without a consent grant and refuse every such
--    dispensing (PRESCRIPTION_SOURCE_NOT_DISPENSABLE). The lock policy's
--    WITH CHECK is false, so it gives no update. No runtime role reads
--    ehr.prescriptions through it: it names the owner only.
-- D6 pharmacy.own_prescription_sends: one row per prescription sent by
--    itself to this facility's pharmacy: the version, patient, facility and
--    encounter, who sent it (the prescriber's account and membership), the
--    state (pending, then sent with the work item), attempts and the last
--    failure's SQLSTATE (no text), and withdrawn_at once the prescription is
--    put on hold, cancelled or entered in error after the send. Row-level
--    security on (not forced), no policy and no grant: only this file's
--    functions read or write it, with ids taken from the rows they checked.
--    No foreign key, so creating it locks none of the tables those ids name
--    (work items, like the rows they name, are never deleted).
-- D7 ehr.send_prescription_to_own_pharmacy(prescription, version) (SECURITY
--    DEFINER), for the EHR runtime, in the activation's own transaction:
--    the session must be direct-care and hold ehr.prescription.write here
--    (else 42501 OWN_PHARMACY_SEND_DENIED). It answers one row (outcome,
--    work item):
--      not_found     no such prescription here that the session may read;
--      not_prescriber the session is not the prescriber (account and
--                    membership): nothing is sent for someone else;
--      not_active    the prescription is not active;
--      changed       it is not at the given version;
--      routed        it has a live route to another facility;
--      already_in_pharmacy  a work item already exists for it (a
--                    pharmacist accepted it, or an earlier send);
--      no_pharmacy   nobody at this facility can work on pharmacy items
--                    (no active member holds pharmacy.work-item.read and
--                    pharmacy.order-route.receive here);
--      sent          the work item was created now;
--      pending       the attempt failed: the send row stays pending with the
--                    failure's SQLSTATE, and nothing else is written.
--    The work item is created exactly as pharmacy-api creates one (0100's
--    validator checks it against the prescription), with accepted_by the
--    prescriber, never a pharmacist, and the fixed reason "Sent
--    automatically when the prescription was activated"; one
--    prescription_accepted event and one PharmacyWorkItemCreated outbox
--    event (acceptedVia auto_send). The attempt runs in a subtransaction,
--    so a failure never undoes the activation; a serialization failure or
--    deadlock is raised, so the caller's retry runs the whole transaction
--    again. A second call for a sent prescription answers already_in_pharmacy
--    and writes nothing. A pending send is tried again by the next call
--    (the prescriber's "Send to pharmacy").
-- D8 ehr.withdraw_own_pharmacy_send(prescription) (SECURITY
--    DEFINER), for the EHR runtime, in the transaction that puts the
--    prescription on hold, cancels it or enters it in error: the same
--    session test as D7; marks the send withdrawn (once) when the
--    prescription, as the session reads it, is no longer active. Dispensing
--    is refused anyway by 0101 (the version or status changed).
-- D9 pharmacy.own_work_access_for(resource, id, action) and
--    lab.own_work_access_for(resource, id, action) (SECURITY DEFINER,
--    STABLE), for their runtimes: the own work item (no route) the
--    resource belongs to, when D1 allows the session on it; else no row.
--    Pharmacy resources: work_item, dispensing; Lab: work_item, accession,
--    specimen, execution, result (as 0086's C16 and C17).
-- D10 pharmacy.own_work_item_states(ids) and lab.own_work_item_bases(ids)
--    (SECURITY DEFINER, STABLE), for their runtimes, at most 200 ids: for
--    each own work item at the session's facility the session may read,
--    the basis ('consent' when the member's consent test passes, else
--    'own-work'), and for Pharmacy whether its send was withdrawn. The APIs
--    write the audit rows of the work list with that basis.
-- D11 Grants, here and in runtime-grants.sql: D7 and D8 to hid_ehr_runtime;
--    D9 and D10 to hid_pharmacy_runtime or hid_lab_runtime; all four to
--    hid_schema_test_runtime; D1, D5's helper and nothing else to nobody
--    (the policy functions run them as their owner). Revoked from PUBLIC.
--    The replaced functions keep their ACLs.
-- D12 No platform control and no new setting (the owner's rule: no new
--    settings unless unavoidable). ehr-api sends when the function exists
--    and answers the send as `pharmacyHandoff`; an older schema answers no
--    pharmacyHandoff and nothing else changes.
--
-- What it does not do: no new role permission (the plan's 0136 decides the
-- role table, still open); doctors still cannot accept into Pharmacy through
-- pharmacy-api; no Lab request is sent by itself (the plan does not ask it);
-- the prescription details of 0125 still need the member's consent (its
-- reader reads the chart's version snapshots), so a pharmacist without a
-- grant sees the item without them; no chart table gains a reader.
--
-- 0. Preconditions (catalog reads only; 55000 or 42501, nothing applied):
--    0001-0127 applied (0127's auth.sso_spent_tokens and 0125's reader are
--    the markers); not applied yet; the bodies replaced are byte for byte
--    the live ones (md5 of pg_proc.prosrc): 0086's work_item_allows and
--    context_allows, 0124's two card functions; the bodies relied on: the
--    consent test (0104's), the membership and permission checks,
--    validate_work_item (0100) and validate_dispensing (0101); one owner
--    owns identity.patients, the work items of both schemas,
--    ehr.prescriptions, the replaced functions and validate_dispensing, and
--    the applier is that owner or may SET ROLE to it.
-- 1. The applier acts as that owner for the rest of this transaction, so
--    every new object is the owner's.
-- 2. D1 and the replaced bodies (D2-D4).
-- 3. D6 and D5.
-- 4. D7-D10.
-- 5. Grants and comments.
-- 6. Post-checks: each new and replaced function's body (md5), owner,
--    SECURITY DEFINER, volatility, search_path and exact ACL; the table and
--    its ACL; the two policies.
--
-- Locks (measured with pg_locks before commit on a 0127 copy): ACCESS
-- EXCLUSIVE on ehr.prescriptions for the two CREATE POLICY statements (held
-- to commit; the runner's 5 s lock_timeout stops it with nothing applied
-- behind a long transaction on prescriptions); the replaced functions'
-- catalog rows; ACCESS SHARE on the tables the new SQL functions read
-- (identity.patients, the consent directives, the memberships and both work
-- items' tables: their bodies are checked at CREATE); the new table takes no
-- lock on existing data. No row is read or written.
--
-- Old services on this schema: today's images call none of the new
-- functions. They gain, through the changed policies, the pharmacist's and
-- lab scientist's view of this facility's own work: today's lab-api and
-- pharmacy-api list it (the list reads under row-level security), while a
-- single item, a dispensing and every chain command still ask Identity's
-- consent in today's images, so they answer as before until the new images
-- (which ask D9 first) are deployed. Applied migrations before 0133 are
-- immutable.

-- 0. Preconditions. Whether holder holds a privilege by ownership,
-- membership or grant (also to PUBLIC), ignoring a superuser's bypass.
create function pg_temp.own_work_0133_holds(holder oid, object_owner oid, object_acl aclitem[], object_type "char",
  wanted text)
returns boolean
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  with recursive held(role_id) as (
    select holder
    union
    select membership.roleid from pg_catalog.pg_auth_members membership join held on membership.member = held.role_id
  )
  select object_owner in (select held.role_id from held)
    or exists (select 1 from pg_catalog.aclexplode(coalesce(object_acl, pg_catalog.acldefault(object_type, object_owner))) acl
                where acl.privilege_type = wanted
                  and (acl.grantee = 0 or acl.grantee in (select held.role_id from held)))
$$;

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
  owner_oid oid;
begin
  -- a. Prerequisites (0001-0127).
  if to_regclass('auth.sso_spent_tokens') is null
     or to_regprocedure('pharmacy.work_item_prescription_details(uuid[])') is null
     or to_regprocedure('pharmacy.work_item_patient_cards(uuid[])') is null
     or to_regclass('pharmacy.work_items') is null or to_regclass('lab.work_items') is null
     or to_regclass('ehr.prescriptions') is null then
    raise exception using errcode = '55000', message = '0133: 0001-0127 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('pharmacy.own_prescription_sends') is not null
     or to_regprocedure('identity.facility_work_member_allows(text,uuid,uuid,text)') is not null then
    raise exception using errcode = '55000', message = '0133: already applied';
  end if;
  -- c. The bodies replaced and relied on.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('lab.work_item_allows(uuid,uuid,uuid,text)', 'b710e0c6b66ce87c8c4a059ad435b774'),
      ('pharmacy.work_item_allows(uuid,uuid,uuid,text)', 'b710e0c6b66ce87c8c4a059ad435b774'),
      ('lab.context_allows(uuid,uuid,text)', '57e689661a6227e34d3bde9562468951'),
      ('pharmacy.context_allows(uuid,uuid,text)', '958a6e5cd2a534d158c82fe399b8f381'),
      ('lab.work_item_patient_cards(uuid[])', '69b1836bb8d9493bdc0d6d7cc5e96515'),
      ('pharmacy.work_item_patient_cards(uuid[])', '5a944e144033d04f86771a33ef41247b'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('ehr.order_route_access_allows(text,uuid,uuid,text)', '175eff453979c964889283a29bb8f34f'),
      ('ehr.order_route_allows(uuid,uuid,text)', 'b80c2df6c380f7c7e20d166da94e56d2'),
      ('pharmacy.validate_work_item()', 'e2411539ee8c95a02dad46c03e24db05'),
      ('pharmacy.validate_dispensing()', '17f7e8897bd2ab240332e4d2c9f757b7'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0133: a function this migration replaces or relies on differs from 0001-0127: %s', mismatch);
  end if;
  -- d. One owner of everything this file replaces or gives a policy.
  owner_oid := (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass);
  select string_agg(objects.what, '; ') into mismatch
    from (
      select relation.oid::regclass::text as what from pg_class relation
       where relation.oid in ('identity.patients'::regclass, 'lab.work_items'::regclass,
                              'ehr.prescriptions'::regclass)
         and relation.relowner <> owner_oid
      union all
      select proc.oid::regprocedure::text from pg_proc proc
       where proc.oid in ('lab.work_item_allows(uuid,uuid,uuid,text)'::regprocedure,
                          'pharmacy.work_item_allows(uuid,uuid,uuid,text)'::regprocedure,
                          'lab.context_allows(uuid,uuid,text)'::regprocedure,
                          'pharmacy.context_allows(uuid,uuid,text)'::regprocedure,
                          'lab.work_item_patient_cards(uuid[])'::regprocedure,
                          'pharmacy.work_item_patient_cards(uuid[])'::regprocedure,
                          'pharmacy.validate_dispensing()'::regprocedure)
         and proc.proowner <> owner_oid) objects;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0133: these are not owned by %s, the owner of pharmacy.work_items: %s',
        pg_get_userbyid(owner_oid), mismatch);
  end if;
  -- e. The applier is that owner or may act as it; the owner may create in
  -- and use the schemas.
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not %s and may not SET ROLE to it', current_user, pg_get_userbyid(owner_oid)) as what
       where applier <> owner_oid and not pg_has_role(applier, owner_oid, 'SET')
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(owner_oid), wanted.privilege, namespace.nspname)
        from (values ('identity', 'CREATE'), ('lab', 'CREATE'), ('pharmacy', 'CREATE'), ('ehr', 'CREATE'), ('identity', 'USAGE'),
                     ('lab', 'USAGE'), ('pharmacy', 'USAGE'), ('ehr', 'USAGE'), ('auth', 'USAGE'),
                     ('platform', 'USAGE')) wanted(schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.own_work_0133_holds(owner_oid, namespace.nspowner, namespace.nspacl, 'n', wanted.privilege)
      union all
      select format('%s lacks %s on %s', pg_get_userbyid(owner_oid), wanted.privilege, relation.oid::regclass)
        from (values ('identity.consent_directives', 'SELECT'), ('identity.consent_directive_versions', 'SELECT'),
                     ('identity.staff_facility_memberships', 'SELECT'), ('auth.accounts', 'SELECT'),
                     ('ehr.order_routes', 'SELECT'), ('pharmacy.work_item_events', 'INSERT'),
                     ('pharmacy.outbox_events', 'INSERT'), ('pharmacy.dispensings', 'SELECT'),
                     ('lab.accessions', 'SELECT'), ('lab.specimens', 'SELECT'), ('lab.test_executions', 'SELECT'),
                     ('lab.results', 'SELECT')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
       where not pg_temp.own_work_0133_holds(owner_oid, relation.relowner, relation.relacl, 'r', wanted.privilege)) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0133: missing privileges: %s', mismatch);
  end if;
  raise notice '0133: owner checked: %, applier=%', pg_get_userbyid(owner_oid), current_user;
end
$$;

-- 1. Act as the owner for the rest of this transaction (a no-op when the
-- applier is the owner, as on every database built by one migration login).
do $$
declare
  owner_name text := (select pg_get_userbyid(relation.relowner) from pg_class relation
                       where relation.oid = 'pharmacy.work_items'::regclass);
begin
  if owner_name <> current_user then
    execute format('set local role %I', owner_name);
  end if;
end
$$;

-- 2. D1.
create function identity.facility_work_member_allows(work_kind text, row_patient_id uuid, row_facility_id uuid,
  requested_action text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(work_kind in ('pharmacy', 'lab'), false)
    and coalesce(requested_action in ('read_records', 'write_records'), false)
    and row_patient_id is not null
    and row_facility_id is not null
    and row_facility_id = platform.current_facility_id()
    and platform.current_purpose_of_use() = 'direct-care'
    and coalesce(auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
          row_facility_id, work_kind || '.work-item.read'), false)
    and coalesce(auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
          row_facility_id, work_kind || '.order-route.receive'), false)
    and exists (select 1 from identity.patients patient
                 where patient.id = row_patient_id and patient.status = 'active')
    and not exists (
      select 1
        from identity.consent_directives directive
        join identity.consent_directive_versions directive_version
          on directive_version.directive_id = directive.id
         and directive_version.version_no = directive.current_version
        join identity.staff_facility_memberships membership
          on membership.id = platform.current_membership_id()
         and membership.facility_id = row_facility_id
       where directive.patient_id = row_patient_id
         and directive_version.status = 'active'
         and directive_version.provision_type = 'deny'
         and directive_version.starts_at <= clock_timestamp()
         and (directive_version.expires_at is null or directive_version.expires_at > clock_timestamp())
         and (directive_version.facility_id is null or directive_version.facility_id = row_facility_id)
         and (cardinality(directive_version.actions) = 0 or requested_action = any(directive_version.actions))
         and (cardinality(directive_version.purposes) = 0 or 'direct-care' = any(directive_version.purposes))
         and (directive_version.grantee_type = 'all'
           or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = row_facility_id)
           or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = membership.organization_id)
           or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = membership.staff_id)))
$$;

-- D2. The work items' policies: 0086's text plus the own-work branch.
create or replace function lab.work_item_allows(row_patient_id uuid, row_facility_id uuid, row_route_id uuid,
  requested_action text)
returns boolean
language sql stable security definer
set search_path = lab, identity, platform, pg_temp
as $$
  select row_facility_id = platform.current_facility_id()
    and (identity.has_active_consent_grant(row_patient_id, platform.current_actor_subject(),
          platform.current_membership_id(), row_facility_id, requested_action, platform.current_purpose_of_use())
      or (row_route_id is not null and ehr.order_route_allows(row_route_id, row_facility_id, requested_action))
      or (row_route_id is null
          and identity.facility_work_member_allows('lab', row_patient_id, row_facility_id, requested_action)))
$$;

create or replace function pharmacy.work_item_allows(row_patient_id uuid, row_facility_id uuid, row_route_id uuid,
  requested_action text)
returns boolean
language sql stable security definer
set search_path = pharmacy, identity, platform, pg_temp
as $$
  select row_facility_id = platform.current_facility_id()
    and (identity.has_active_consent_grant(row_patient_id, platform.current_actor_subject(),
          platform.current_membership_id(), row_facility_id, requested_action, platform.current_purpose_of_use())
      or (row_route_id is not null and ehr.order_route_allows(row_route_id, row_facility_id, requested_action))
      or (row_route_id is null
          and identity.facility_work_member_allows('pharmacy', row_patient_id, row_facility_id, requested_action)))
$$;

-- D3. The chain tables' policies: 0086's text plus the own-work branch.
create or replace function lab.context_allows(row_patient_id uuid,row_facility_id uuid,requested_action text)
returns boolean language sql stable security definer
set search_path = lab,identity,platform,pg_temp as $$
  select row_facility_id=platform.current_facility_id()
    and (identity.has_active_consent_grant(row_patient_id,platform.current_actor_subject(),
      platform.current_membership_id(),row_facility_id,requested_action,platform.current_purpose_of_use())
      or ehr.order_route_access_allows('lab_request',row_patient_id,row_facility_id,requested_action)
      or (identity.facility_work_member_allows('lab',row_patient_id,row_facility_id,requested_action)
          and exists (select 1 from lab.work_items item
                       where item.patient_id=row_patient_id and item.facility_id=row_facility_id
                         and item.order_route_id is null)))
$$;

create or replace function pharmacy.context_allows(
  row_patient_id uuid,
  row_facility_id uuid,
  requested_action text
) returns boolean language sql stable security definer
set search_path = pharmacy, identity, platform, pg_temp as $$
  select row_facility_id = platform.current_facility_id()
    and (identity.has_active_consent_grant(
      row_patient_id,
      platform.current_actor_subject(),
      platform.current_membership_id(),
      row_facility_id,
      requested_action,
      platform.current_purpose_of_use()
    )
      or ehr.order_route_access_allows('prescription', row_patient_id, row_facility_id, requested_action)
      or (identity.facility_work_member_allows('pharmacy', row_patient_id, row_facility_id, requested_action)
          and exists (select 1 from pharmacy.work_items item
                       where item.patient_id = row_patient_id and item.facility_id = row_facility_id
                         and item.order_route_id is null)))
$$;

-- D4. 0124's cards: its text plus the own-work branch.
create or replace function lab.work_item_patient_cards(requested_work_item_ids uuid[])
returns table (
  work_item_id uuid,
  patient_full_name text,
  patient_sex text,
  patient_date_of_birth date,
  patient_health_id_last4 text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
begin
  if requested_work_item_ids is null or cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'WORK_ITEM_PATIENT_CARDS_INVALID';
  end if;
  if session_facility is null
     or not coalesce(auth.membership_has_permission(platform.current_actor_subject(),
          platform.current_membership_id(), session_facility, 'lab.work-item.read'), false) then
    return;
  end if;
  return query
    select item.id, patient.full_name, patient.gender, patient.dob, right(patient.hid_code, 4)
      from lab.work_items item
      join identity.patients patient on patient.id = item.patient_id
     where item.id = any(requested_work_item_ids)
       and item.order_route_id is null
       and item.facility_id = session_facility
       and (identity.has_active_consent_grant(item.patient_id, platform.current_actor_subject(),
              platform.current_membership_id(), item.facility_id, 'read_records', platform.current_purpose_of_use())
         or identity.facility_work_member_allows('lab', item.patient_id, item.facility_id, 'read_records'))
     order by item.id;
end;
$$;

create or replace function pharmacy.work_item_patient_cards(requested_work_item_ids uuid[])
returns table (
  work_item_id uuid,
  patient_full_name text,
  patient_sex text,
  patient_date_of_birth date,
  patient_health_id_last4 text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
begin
  if requested_work_item_ids is null or cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'WORK_ITEM_PATIENT_CARDS_INVALID';
  end if;
  if session_facility is null
     or not coalesce(auth.membership_has_permission(platform.current_actor_subject(),
          platform.current_membership_id(), session_facility, 'pharmacy.work-item.read'), false) then
    return;
  end if;
  return query
    select item.id, patient.full_name, patient.gender, patient.dob, right(patient.hid_code, 4)
      from pharmacy.work_items item
      join identity.patients patient on patient.id = item.patient_id
     where item.id = any(requested_work_item_ids)
       and item.order_route_id is null
       and item.facility_id = session_facility
       and (identity.has_active_consent_grant(item.patient_id, platform.current_actor_subject(),
              platform.current_membership_id(), item.facility_id, 'read_records', platform.current_purpose_of_use())
         or identity.facility_work_member_allows('pharmacy', item.patient_id, item.facility_id, 'read_records'))
     order by item.id;
end;
$$;

-- 3. D6. The sends.
create table pharmacy.own_prescription_sends (
  prescription_id uuid primary key,
  prescription_version bigint not null check (prescription_version > 0),
  patient_id uuid not null,
  facility_id uuid not null,
  encounter_id uuid not null,
  sent_by_account_id uuid not null,
  sent_by_membership_id uuid not null,
  state text not null default 'pending' check (state in ('pending', 'sent')),
  work_item_id uuid unique,
  attempts integer not null default 0 check (attempts between 0 and 1000),
  last_failure_sqlstate text check (last_failure_sqlstate is null or last_failure_sqlstate ~ '^[0-9A-Z]{5}$'),
  created_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  withdrawn_at timestamptz,
  check ((state = 'sent') = (work_item_id is not null and sent_at is not null)),
  check (withdrawn_at is null or state = 'sent')
);
create index own_prescription_sends_facility_idx on pharmacy.own_prescription_sends (facility_id, state, created_at);
alter table pharmacy.own_prescription_sends enable row level security;
revoke all on pharmacy.own_prescription_sends from public;

-- D5. The source prescription of an own pharmacy work item the session may
-- work on (the owner's policies on ehr.prescriptions call it).
create function pharmacy.own_work_source_prescription(row_prescription_id uuid, row_patient_id uuid,
  row_facility_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select identity.facility_work_member_allows('pharmacy', row_patient_id, row_facility_id, 'read_records')
    and exists (select 1 from pharmacy.work_items item
                 where item.source_ehr_prescription_id = row_prescription_id
                   and item.patient_id = row_patient_id
                   and item.facility_id = row_facility_id
                   and item.order_route_id is null)
$$;

do $$
declare
  validator_owner text := (select pg_get_userbyid(proc.proowner) from pg_proc proc
                            where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure);
begin
  execute format('create policy prescriptions_own_pharmacy_source_read on ehr.prescriptions for select to %I '
    || 'using (pharmacy.own_work_source_prescription(id, patient_id, facility_id))', validator_owner);
  execute format('create policy prescriptions_own_pharmacy_source_lock on ehr.prescriptions for update to %I '
    || 'using (pharmacy.own_work_source_prescription(id, patient_id, facility_id)) with check (false)',
    validator_owner);
end
$$;

-- 4. D7. The send.
create function ehr.send_prescription_to_own_pharmacy(requested_prescription_id uuid, requested_version bigint)
returns table (outcome text, work_item_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
  session_account uuid := platform.current_account_id();
  session_membership uuid := platform.current_membership_id();
  session_subject text := platform.current_actor_subject();
  session_correlation text := platform.current_correlation_id();
  fixed_reason constant text := 'Sent automatically when the prescription was activated';
  source ehr.prescriptions%rowtype;
  existing_item uuid;
  send_row pharmacy.own_prescription_sends%rowtype;
  created pharmacy.work_items%rowtype;
  failure_state text;
begin
  if requested_prescription_id is null or requested_version is null or requested_version < 1 then
    raise exception using errcode = '22023', message = 'OWN_PHARMACY_SEND_INVALID';
  end if;
  if session_facility is null or session_account is null or session_membership is null or session_subject is null
     or platform.current_purpose_of_use() is distinct from 'direct-care'
     or not coalesce(auth.membership_has_permission(session_subject, session_membership, session_facility,
          'ehr.prescription.write'), false) then
    raise exception using errcode = '42501', message = 'OWN_PHARMACY_SEND_DENIED';
  end if;
  -- Read as the owner: under forced row-level security only a prescription
  -- the session may read is found.
  select prescription.* into source
    from ehr.prescriptions prescription
   where prescription.id = requested_prescription_id and prescription.facility_id = session_facility;
  if source.id is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if source.created_by is distinct from session_account
     or source.created_by_membership_id is distinct from session_membership then
    return query select 'not_prescriber'::text, null::uuid;
    return;
  end if;
  if source.status is distinct from 'active' then
    return query select 'not_active'::text, null::uuid;
    return;
  end if;
  if source.row_version is distinct from requested_version then
    return query select 'changed'::text, null::uuid;
    return;
  end if;
  if exists (select 1 from ehr.order_routes route
              where route.source_prescription_id = source.id
                and (route.state in ('accepted', 'completed')
                  or (route.state = 'sent' and clock_timestamp() < route.respond_by))) then
    return query select 'routed'::text, null::uuid;
    return;
  end if;
  select item.id into existing_item from pharmacy.work_items item where item.source_ehr_prescription_id = source.id;
  if existing_item is not null then
    return query select 'already_in_pharmacy'::text, existing_item;
    return;
  end if;
  if not exists (
    select 1
      from identity.staff_facility_memberships membership
      join auth.accounts account on account.id = membership.account_id
     where membership.facility_id = session_facility
       and membership.active
       and coalesce(auth.membership_has_permission(account.subject, membership.id, session_facility,
             'pharmacy.work-item.read'), false)
       and coalesce(auth.membership_has_permission(account.subject, membership.id, session_facility,
             'pharmacy.order-route.receive'), false)) then
    return query select 'no_pharmacy'::text, null::uuid;
    return;
  end if;
  insert into pharmacy.own_prescription_sends (prescription_id, prescription_version, patient_id, facility_id,
    encounter_id, sent_by_account_id, sent_by_membership_id)
  values (source.id, source.row_version, source.patient_id, source.facility_id, source.encounter_id, session_account,
    session_membership)
  on conflict (prescription_id) do nothing;
  select send.* into send_row from pharmacy.own_prescription_sends send
   where send.prescription_id = source.id for update;
  if send_row.state = 'sent' then
    return query select 'already_in_pharmacy'::text, send_row.work_item_id;
    return;
  end if;
  begin
    insert into pharmacy.work_items (patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
      source_ehr_prescription_version, source_encounter_id, source_status, medication_code_system, medication_code,
      medication_display, dose_quantity, dose_unit, route_code, frequency, instructions, starts_on, ends_on,
      prescribed_by, prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason, idempotency_key,
      request_sha256, correlation_id)
    values (source.patient_id, source.facility_id, source.facility_id, source.id, source.row_version,
      source.encounter_id, 'active', source.medication_code_system, source.medication_code, source.medication_display,
      source.dose_quantity, source.dose_unit, source.route_code, source.frequency, source.instructions,
      source.starts_on, source.ends_on, source.created_by, source.created_at, session_account, session_membership,
      fixed_reason, 'own-pharmacy-send:' || source.id::text,
      encode(sha256(convert_to('own-pharmacy-send:' || source.id::text || ':' || source.row_version::text, 'UTF8')),
        'hex'),
      session_correlation)
    returning * into created;
    insert into pharmacy.work_item_events (work_item_id, patient_id, facility_id, event_version, event_type, actor_id,
      actor_membership_id, reason, correlation_id)
    values (created.id, created.patient_id, created.facility_id, 1, 'prescription_accepted', session_account,
      session_membership, fixed_reason, session_correlation);
    insert into pharmacy.outbox_events (event_type, aggregate_type, aggregate_id, aggregate_version, facility_id,
      patient_id, correlation_id, payload)
    values ('PharmacyWorkItemCreated', 'pharmacy-work-item', created.id, 1, created.facility_id, created.patient_id,
      session_correlation, jsonb_build_object('workItemId', created.id,
        'sourceEhrPrescriptionId', created.source_ehr_prescription_id,
        'sourceEhrPrescriptionVersion', created.source_ehr_prescription_version, 'status', 'accepted',
        'acceptedVia', 'auto_send'));
    update pharmacy.own_prescription_sends send
       set state = 'sent', work_item_id = created.id, sent_at = clock_timestamp(),
           prescription_version = source.row_version, attempts = least(send.attempts + 1, 1000),
           last_failure_sqlstate = null
     where send.prescription_id = source.id;
  exception
    when serialization_failure or deadlock_detected then
      raise;
    when others then
      get stacked diagnostics failure_state = returned_sqlstate;
      update pharmacy.own_prescription_sends send
         set attempts = least(send.attempts + 1, 1000), prescription_version = source.row_version,
             last_failure_sqlstate = case when failure_state ~ '^[0-9A-Z]{5}$' then failure_state end
       where send.prescription_id = source.id;
      return query select 'pending'::text, null::uuid;
      return;
  end;
  return query select 'sent'::text, created.id;
end;
$$;

-- D8. The withdrawal.
create function ehr.withdraw_own_pharmacy_send(requested_prescription_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
  session_membership uuid := platform.current_membership_id();
  session_subject text := platform.current_actor_subject();
  source_status text;
  marked integer;
begin
  if requested_prescription_id is null then
    raise exception using errcode = '22023', message = 'OWN_PHARMACY_SEND_INVALID';
  end if;
  if session_facility is null or session_membership is null or session_subject is null
     or platform.current_purpose_of_use() is distinct from 'direct-care'
     or not coalesce(auth.membership_has_permission(session_subject, session_membership, session_facility,
          'ehr.prescription.write'), false) then
    raise exception using errcode = '42501', message = 'OWN_PHARMACY_SEND_DENIED';
  end if;
  select prescription.status into source_status
    from ehr.prescriptions prescription
   where prescription.id = requested_prescription_id and prescription.facility_id = session_facility;
  if source_status is null or source_status not in ('on_hold', 'cancelled', 'entered_in_error') then
    return false;
  end if;
  update pharmacy.own_prescription_sends send
     set withdrawn_at = clock_timestamp()
   where send.prescription_id = requested_prescription_id
     and send.facility_id = session_facility
     and send.state = 'sent'
     and send.withdrawn_at is null;
  get diagnostics marked = row_count;
  return marked > 0;
end;
$$;

-- D9. The own work item a Pharmacy or Lab resource belongs to.
create function pharmacy.own_work_access_for(requested_resource_type text, requested_resource_id uuid,
  requested_action text)
returns table (work_item_id uuid)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  item record;
begin
  if not coalesce(requested_resource_type in ('work_item', 'dispensing'), false)
     or not coalesce(requested_action in ('read_records', 'write_records'), false)
     or requested_resource_id is null then
    raise exception using errcode = '22023', message = 'OWN_WORK_ACCESS_INVALID';
  end if;
  if requested_resource_type = 'work_item' then
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from pharmacy.work_items candidate where candidate.id = requested_resource_id;
  else
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from pharmacy.dispensings dispensing
      join pharmacy.work_items candidate on candidate.id = dispensing.work_item_id
     where dispensing.id = requested_resource_id;
  end if;
  if item.id is null or item.order_route_id is not null
     or not identity.facility_work_member_allows('pharmacy', item.patient_id, item.facility_id, requested_action) then
    return;
  end if;
  return query select item.id;
end;
$$;

create function lab.own_work_access_for(requested_resource_type text, requested_resource_id uuid,
  requested_action text)
returns table (work_item_id uuid)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  item record;
begin
  if not coalesce(requested_resource_type in ('work_item', 'accession', 'specimen', 'execution', 'result'), false)
     or not coalesce(requested_action in ('read_records', 'write_records'), false)
     or requested_resource_id is null then
    raise exception using errcode = '22023', message = 'OWN_WORK_ACCESS_INVALID';
  end if;
  if requested_resource_type = 'work_item' then
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from lab.work_items candidate where candidate.id = requested_resource_id;
  elsif requested_resource_type = 'accession' then
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from lab.accessions accession
      join lab.work_items candidate on candidate.id = accession.work_item_id
     where accession.id = requested_resource_id;
  elsif requested_resource_type = 'specimen' then
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from lab.specimens specimen
      join lab.accessions accession on accession.id = specimen.accession_id
      join lab.work_items candidate on candidate.id = accession.work_item_id
     where specimen.id = requested_resource_id;
  elsif requested_resource_type = 'execution' then
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from lab.test_executions execution
      join lab.accessions accession on accession.id = execution.accession_id
      join lab.work_items candidate on candidate.id = accession.work_item_id
     where execution.id = requested_resource_id;
  else
    select candidate.id, candidate.patient_id, candidate.facility_id, candidate.order_route_id into item
      from lab.results result_row
      join lab.test_executions execution on execution.id = result_row.execution_id
      join lab.accessions accession on accession.id = execution.accession_id
      join lab.work_items candidate on candidate.id = accession.work_item_id
     where result_row.id = requested_resource_id;
  end if;
  if item.id is null or item.order_route_id is not null
     or not identity.facility_work_member_allows('lab', item.patient_id, item.facility_id, requested_action) then
    return;
  end if;
  return query select item.id;
end;
$$;

-- D10. Why the session sees each own work item, for the work list's audit rows.
create function pharmacy.own_work_item_states(requested_work_item_ids uuid[])
returns table (work_item_id uuid, basis text, withdrawn boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
begin
  if requested_work_item_ids is null or cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'OWN_WORK_ITEM_STATES_INVALID';
  end if;
  if session_facility is null then
    return;
  end if;
  return query
    select decided.id, decided.basis,
           exists (select 1 from pharmacy.own_prescription_sends send
                    where send.work_item_id = decided.id and send.withdrawn_at is not null)
      from (
        select item.id,
               case
                 when identity.has_active_consent_grant(item.patient_id, platform.current_actor_subject(),
                        platform.current_membership_id(), item.facility_id, 'read_records',
                        platform.current_purpose_of_use()) then 'consent'
                 when identity.facility_work_member_allows('pharmacy', item.patient_id, item.facility_id,
                        'read_records') then 'own-work'
               end as basis
          from pharmacy.work_items item
         where item.id = any(requested_work_item_ids)
           and item.order_route_id is null
           and item.facility_id = session_facility) decided
     where decided.basis is not null
     order by decided.id;
end;
$$;

create function lab.own_work_item_bases(requested_work_item_ids uuid[])
returns table (work_item_id uuid, basis text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  session_facility uuid := platform.current_facility_id();
begin
  if requested_work_item_ids is null or cardinality(requested_work_item_ids) > 200 then
    raise exception using errcode = '22023', message = 'OWN_WORK_ITEM_STATES_INVALID';
  end if;
  if session_facility is null then
    return;
  end if;
  return query
    select decided.id, decided.basis
      from (
        select item.id,
               case
                 when identity.has_active_consent_grant(item.patient_id, platform.current_actor_subject(),
                        platform.current_membership_id(), item.facility_id, 'read_records',
                        platform.current_purpose_of_use()) then 'consent'
                 when identity.facility_work_member_allows('lab', item.patient_id, item.facility_id,
                        'read_records') then 'own-work'
               end as basis
          from lab.work_items item
         where item.id = any(requested_work_item_ids)
           and item.order_route_id is null
           and item.facility_id = session_facility) decided
     where decided.basis is not null
     order by decided.id;
end;
$$;

-- 5. Grants (D11; here and in runtime-grants.sql) and comments.
revoke all on function identity.facility_work_member_allows(text, uuid, uuid, text),
  pharmacy.own_work_source_prescription(uuid, uuid, uuid),
  ehr.send_prescription_to_own_pharmacy(uuid, bigint),
  ehr.withdraw_own_pharmacy_send(uuid),
  pharmacy.own_work_access_for(text, uuid, text),
  lab.own_work_access_for(text, uuid, text),
  pharmacy.own_work_item_states(uuid[]),
  lab.own_work_item_bases(uuid[]) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.send_prescription_to_own_pharmacy(uuid, bigint),
      ehr.withdraw_own_pharmacy_send(uuid) to hid_ehr_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_pharmacy_runtime') then
    grant execute on function pharmacy.own_work_access_for(text, uuid, text),
      pharmacy.own_work_item_states(uuid[]) to hid_pharmacy_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_lab_runtime') then
    grant execute on function lab.own_work_access_for(text, uuid, text), lab.own_work_item_bases(uuid[])
      to hid_lab_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function ehr.send_prescription_to_own_pharmacy(uuid, bigint),
      ehr.withdraw_own_pharmacy_send(uuid), pharmacy.own_work_access_for(text, uuid, text),
      pharmacy.own_work_item_states(uuid[]), lab.own_work_access_for(text, uuid, text),
      lab.own_work_item_bases(uuid[]) to hid_schema_test_runtime;
  end if;
end
$$;

comment on function identity.facility_work_member_allows(text, uuid, uuid, text) is
  '0133 D1: the session works for this facility''s pharmacy or laboratory (direct care, <kind>.work-item.read and <kind>.order-route.receive here), the patient is active and no deny directive covers the member. Called by the work items'' and chain tables'' policies; no runtime role executes it.';
comment on function lab.work_item_allows(uuid, uuid, uuid, text) is
  '0086 H8 with 0133 D2: this facility''s row and the member''s consent, the row''s order route, or (own work, no route) the facility''s lab staff (identity.facility_work_member_allows).';
comment on function pharmacy.work_item_allows(uuid, uuid, uuid, text) is
  '0086 H8 with 0133 D2: this facility''s row and the member''s consent, the row''s order route, or (own work, no route) the facility''s pharmacy staff (identity.facility_work_member_allows).';
comment on function lab.context_allows(uuid, uuid, text) is
  '0086 with 0133 D3: this facility''s row and the member''s consent, route access, or the facility''s lab staff for a patient with own lab work here.';
comment on function pharmacy.context_allows(uuid, uuid, text) is
  '0086 with 0133 D3: this facility''s row and the member''s consent, route access, or the facility''s pharmacy staff for a patient with own pharmacy work here.';
comment on function lab.work_item_patient_cards(uuid[]) is
  'The patient (name, sex, date of birth, last 4 of the Health ID) of each given work item that is this facility''s own work (no order route) and that the session''s member may read: lab.work-item.read here and the read consent test of the work items'' read policy (emergency included), or (0133) the facility''s lab staff. At most 200 ids.';
comment on function pharmacy.work_item_patient_cards(uuid[]) is
  'The patient (name, sex, date of birth, last 4 of the Health ID) of each given work item that is this facility''s own work (no order route) and that the session''s member may read: pharmacy.work-item.read here and the read consent test of the work items'' read policy (emergency included), or (0133) the facility''s pharmacy staff. At most 200 ids.';
comment on table pharmacy.own_prescription_sends is
  '0133 D6: prescriptions sent by themselves to this facility''s own pharmacy when activated: who sent them (the prescriber), pending or sent with the work item, attempts and the last failure''s SQLSTATE, and when they were withdrawn. Only 0133''s functions read or write it.';
comment on function pharmacy.own_work_source_prescription(uuid, uuid, uuid) is
  '0133 D5: the prescription is the source of an own pharmacy work item the session works on as this facility''s pharmacy staff. Used by two ehr.prescriptions policies for the owner of pharmacy.validate_dispensing only.';
comment on function ehr.send_prescription_to_own_pharmacy(uuid, bigint) is
  '0133 D7: sends the prescriber''s active prescription to this facility''s own pharmacy (a work item accepted by the prescriber with the fixed reason), in the caller''s transaction; answers not_found, not_prescriber, not_active, changed, routed, already_in_pharmacy, no_pharmacy, sent or pending.';
comment on function ehr.withdraw_own_pharmacy_send(uuid) is
  '0133 D8: marks a sent prescription withdrawn once it is on hold, cancelled or entered in error.';
comment on function pharmacy.own_work_access_for(text, uuid, text) is
  '0133 D9: the own work item (no route) a work item or dispensing belongs to, when the session works for this facility''s pharmacy.';
comment on function lab.own_work_access_for(text, uuid, text) is
  '0133 D9: the own work item (no route) a work item, accession, specimen, execution or result belongs to, when the session works for this facility''s laboratory.';
comment on function pharmacy.own_work_item_states(uuid[]) is
  '0133 D10: for each own work item here the session may read, consent or own-work, and whether its send was withdrawn. At most 200 ids.';
comment on function lab.own_work_item_bases(uuid[]) is
  '0133 D10: for each own lab work item here the session may read, consent or own-work. At most 200 ids.';

-- 6. Post-checks.
do $$
declare
  mismatch text;
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass);
begin
  select string_agg(format('%s: md5=%s owner=%s definer=%s volatile=%s config=%s', expected.proc_name,
           coalesce(md5(proc.prosrc), 'missing'), pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
           proc.proconfig), '; ')
    into mismatch
    from (values
      ('identity.facility_work_member_allows(text,uuid,uuid,text)', 's', '{"search_path=pg_catalog, pg_temp"}'),
      ('lab.work_item_allows(uuid,uuid,uuid,text)', 's', '{"search_path=lab, identity, platform, pg_temp"}'),
      ('pharmacy.work_item_allows(uuid,uuid,uuid,text)', 's', '{"search_path=pharmacy, identity, platform, pg_temp"}'),
      ('lab.context_allows(uuid,uuid,text)', 's', '{"search_path=lab, identity, platform, pg_temp"}'),
      ('pharmacy.context_allows(uuid,uuid,text)', 's', '{"search_path=pharmacy, identity, platform, pg_temp"}'),
      ('lab.work_item_patient_cards(uuid[])', 's', '{"search_path=pg_catalog, pg_temp"}'),
      ('pharmacy.work_item_patient_cards(uuid[])', 's', '{"search_path=pg_catalog, pg_temp"}'),
      ('pharmacy.own_work_source_prescription(uuid,uuid,uuid)', 's', '{"search_path=pg_catalog, pg_temp"}'),
      ('ehr.send_prescription_to_own_pharmacy(uuid,bigint)', 'v', '{"search_path=pg_catalog, pg_temp"}'),
      ('ehr.withdraw_own_pharmacy_send(uuid)', 'v', '{"search_path=pg_catalog, pg_temp"}'),
      ('pharmacy.own_work_access_for(text,uuid,text)', 's', '{"search_path=pg_catalog, pg_temp"}'),
      ('lab.own_work_access_for(text,uuid,text)', 's', '{"search_path=pg_catalog, pg_temp"}'),
      ('pharmacy.own_work_item_states(uuid[])', 's', '{"search_path=pg_catalog, pg_temp"}'),
      ('lab.own_work_item_bases(uuid[])', 's', '{"search_path=pg_catalog, pg_temp"}'))
         expected(proc_name, volatility, config)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc_name)
   where proc.oid is null or proc.proowner <> owner_oid or not proc.prosecdef or proc.provolatile <> expected.volatility
      or proc.proconfig is distinct from expected.config::text[] or proc.proisstrict;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0133: functions are not as this file makes them: %s', mismatch);
  end if;
  -- Exact ACLs of the new functions: the owner, and section 5's grantees.
  select string_agg(format('%s: %s', proc.oid::regprocedure,
           case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end), '; ') into mismatch
    from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
   where proc.oid in ('identity.facility_work_member_allows(text,uuid,uuid,text)'::regprocedure,
                      'pharmacy.own_work_source_prescription(uuid,uuid,uuid)'::regprocedure,
                      'ehr.send_prescription_to_own_pharmacy(uuid,bigint)'::regprocedure,
                      'ehr.withdraw_own_pharmacy_send(uuid)'::regprocedure,
                      'pharmacy.own_work_access_for(text,uuid,text)'::regprocedure,
                      'lab.own_work_access_for(text,uuid,text)'::regprocedure,
                      'pharmacy.own_work_item_states(uuid[])'::regprocedure,
                      'lab.own_work_item_bases(uuid[])'::regprocedure)
     and acl.grantee <> proc.proowner
     and (acl.grantee = 0 or acl.privilege_type <> 'EXECUTE'
       or pg_get_userbyid(acl.grantee) not in ('hid_schema_test_runtime',
            case
              when proc.proname in ('send_prescription_to_own_pharmacy', 'withdraw_own_pharmacy_send') then 'hid_ehr_runtime'
              when proc.proname in ('own_work_access_for', 'own_work_item_states', 'own_work_item_bases')
                then case when proc.pronamespace = 'lab'::regnamespace then 'hid_lab_runtime'
                          else 'hid_pharmacy_runtime' end
            end)
       or proc.proname in ('facility_work_member_allows', 'own_work_source_prescription'));
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0133: unexpected grants: %s', mismatch);
  end if;
  if (select relation.relacl from pg_class relation
       where relation.oid = 'pharmacy.own_prescription_sends'::regclass) is not null
     and exists (select 1 from pg_class relation, aclexplode(relation.relacl) acl
                  where relation.oid = 'pharmacy.own_prescription_sends'::regclass and acl.grantee <> relation.relowner) then
    raise exception using errcode = '55000', message = '0133: pharmacy.own_prescription_sends has grants';
  end if;
  if (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'ehr.prescriptions'::regclass
         and policy_row.polroles = array[(select proc.proowner from pg_proc proc
                                           where proc.oid = 'pharmacy.validate_dispensing()'::regprocedure)]
         and ((policy_row.polname = 'prescriptions_own_pharmacy_source_read' and policy_row.polcmd = 'r'
               and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                 = 'pharmacy.own_work_source_prescription(id, patient_id, facility_id)')
           or (policy_row.polname = 'prescriptions_own_pharmacy_source_lock' and policy_row.polcmd = 'w'
               and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                 = 'pharmacy.own_work_source_prescription(id, patient_id, facility_id)'
               and pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) = 'false'))) <> 2 then
    raise exception using errcode = '55000', message = '0133: the ehr.prescriptions policies are not section 3''s';
  end if;
end
$$;

reset role;
