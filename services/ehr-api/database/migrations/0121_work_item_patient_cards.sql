-- 0121 Patient details on this facility's own lab and pharmacy work (owner
-- decision 25 of 2026-11-01, D-Eminence: "all recommended except D5", on the
-- Akos handover backend plan, item 3a; D8: an emergency session sees the
-- patient details with the work; decision 23 of the same evening: labs and
-- pharmacies run as stand-alone products for the whole facility, so their
-- staff cannot rely on the EHR to tell them who the patient is). The
-- declaration is signed separately.
-- Written on 0103 (34d69557) as 0113; released as 0121, after 0120. It
-- relies on one body 0104 replaced: identity.has_active_consent_grant as 0104
-- left it (0108 kept it), so its records-processing cover counts here as it
-- does in the work items' read policy. It uses nothing else 0104-0120 add.
--
-- The gap: a lab or pharmacy work row shows its patient's name, sex, date of
-- birth and Health ID ending only when it came from another facility's order
-- route (C12/C18: ehr.receiving_order_route_cards, 0088, through
-- ehr.order_route_patient_card, 0086). This facility's own work, accepted
-- from its own EHR (order_route_id null), shows a patient id only, so staff
-- at a stand-alone laboratory or pharmacy cannot match a sample or a
-- medicine to the person in front of them. The Lab and Pharmacy runtimes
-- hold no privilege on any Identity table and gain none.
--
-- The change: two new functions, nothing else (no table, column, policy,
-- trigger or existing function changes; C12/C18, whose bodies 0090 and 0091
-- pin, are untouched).
-- D1 lab.work_item_patient_cards(uuid[]) and
--    pharmacy.work_item_patient_cards(uuid[]) answer, for each of the given
--    work items that is this facility's own work and that the session may
--    read, one row: the work item's id and its patient's full_name, gender
--    (as sex), dob and the last 4 characters of hid_code, read from
--    identity.patients, exactly the columns and expressions the route card
--    shows (ehr.order_route_patient_card). Any other id gives no row.
-- D2 A row needs all of: the work item is own work (order_route_id is null;
--    work_items_route_facility_ck then makes its facility the ordering
--    facility); its facility is the session's (platform.current_facility_id());
--    the session's member holds lab.work-item.read (or
--    pharmacy.work-item.read) at that facility
--    (auth.membership_has_permission, the permission the work-list routes
--    require, checked once per call); and the member's consent test for the
--    patient, identity.has_active_consent_grant(patient, subject,
--    membership, facility, 'read_records', the session's purpose of use),
--    which is the own-row branch of the work items' read policy
--    (lab|pharmacy.work_item_allows, 0086 H8). A revoked, expired or held
--    grant, a deny directive, a disabled account or an inactive membership
--    therefore gives no row, as it hides the work row itself.
-- D3 Emergency (owner decision 25, D8): an emergency session with an active
--    reasoned break-glass grant passes the consent test for read_records,
--    exactly as it passes the work items' read policy, so the card is shown
--    whenever the work row itself is shown.
-- D4 At most 200 ids (the work lists answer 200 rows; C12/C18 take 200): a
--    null list or more than 200 raises 22023 WORK_ITEM_PATIENT_CARDS_INVALID.
--    An empty list answers nothing.
-- D5 SECURITY DEFINER, STABLE, plpgsql, not STRICT, search_path pg_catalog,
--    pg_temp with every name schema-qualified, owned by identity.patients'
--    owner (the applier, or, if the applier is a member, given to that
--    owner), so it reads identity.patients as its owner; row-level security
--    there is enabled and not forced, so the owner reads it directly (and,
--    were it forced, patients_staff_read admits exactly the consented
--    patients D2 asks for). The work items force row-level security, so an
--    owner that does not bypass it reads them through their read policies
--    too (the same consent branch D2 tests); an owner that does is held to
--    D2's predicate alone, which is the same rule.
-- D6 Grants, here and in runtime-grants.sql: EXECUTE on the Lab function to
--    hid_lab_runtime and hid_schema_test_runtime, on the Pharmacy function to
--    hid_pharmacy_runtime and hid_schema_test_runtime (when the roles exist;
--    the API logins inherit them); revoked from PUBLIC; nothing to the EHR,
--    Identity, OCR, Outreach or Notification runtimes.
-- D7 No migration number appears inside either body, so a renumber changes
--    only this file's name, header, messages and the ledgers.
-- What the services do with it (lab-api, pharmacy-api, behind their own
-- setting OWN_WORK_PATIENT_CARD_ENABLED, off by default): read it in a
-- savepoint for the own rows they answer, attach the existing optional
-- `patient` to those rows only, and write one lab|pharmacy.work-item.list
-- audit row per patient shown on a list (the access log shows it to the
-- patient as a view); a single work item's read row already names the
-- patient. A failure leaves the rows without a patient.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0103 applied (0103's
--    identity.organization_application_admin_account body the marker, and
--    the tables read); not applied yet (neither function exists); the bodies
--    relied on are the ones 0001-0104 left (md5 of pg_proc.prosrc): the
--    consent test (0104's body) and the membership and permission checks it
--    and D2 call, the four session readers, both work_item_allows
--    (byte-identical bodies, so their attributes and search_paths too) and
--    the route branch they call; the work items' read policies (the only
--    ones a SELECT applies),
--    the own-row CHECK work_items_route_facility_ck on both tables, forced
--    row-level security on both and identity.patients' row-level security
--    not forced; the types and NOT NULLs of the columns read; the applying
--    role is identity.patients' owner or a member that inherits it and may
--    SET ROLE to it, and may create in schemas lab and pharmacy; that owner
--    may create in and use those schemas, use identity, auth and platform,
--    read identity.patients, lab.work_items and pharmacy.work_items, and
--    execute every function D2 and the read policies call (ownership,
--    membership or grant, never a superuser's bypass).
-- 1. The two functions and their comments; given to identity.patients'
--    owner when the applier is only a member of it.
-- 2. Grants (D6).
-- 3. Post-checks: each function exists once with this file's body (md5),
--    that owner, SECURITY DEFINER, STABLE, plpgsql, not STRICT, this
--    search_path, one uuid[] argument and the five result columns; its ACL
--    holds only its owner and section 2's grantees.
--
-- Locks (measured with pg_locks before commit on a 0103 copy): ACCESS SHARE
-- on the schemas lab and pharmacy, on the language plpgsql and on the three
-- granted roles; SHARE UPDATE EXCLUSIVE on each new function (its comment);
-- ACCESS EXCLUSIVE on the session's own temporary schema (section 0's
-- helper); the catalogs' own locks. No lock on any application table is held
-- to commit: a plpgsql body is not planned at CREATE. Section 0 opens
-- lab.work_items and pharmacy.work_items for a moment (pg_get_expr of their
-- policies and CHECKs), so behind a session holding ACCESS EXCLUSIVE on
-- either (DDL) the runner stops after its 5 s lock_timeout with nothing
-- applied; behind ROW EXCLUSIVE on either or on identity.patients (rows being
-- written), and even ACCESS EXCLUSIVE on identity.patients, it applied at
-- once. Nothing calls the functions until a service image with the setting
-- on does.
--
-- Old services on this schema: nothing calls the new functions; today's
-- lab-api and pharmacy-api images answer exactly as before, and so do the
-- new images while OWN_WORK_PATIENT_CARD_ENABLED is off. Applied migrations
-- 0001 through 0120 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0097's, 0099's and 0100's helper).
create function pg_temp.work_item_patient_cards_0121_holds(holder oid, object_owner oid, object_acl aclitem[],
  object_type "char", wanted text)
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
  patients_owner oid;
begin
  -- a. Prerequisites (0001-0103; 0103's gate body is the marker).
  if to_regprocedure('identity.organization_application_admin_account(text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('identity.organization_application_admin_account(text)'))
        is distinct from '186eb4ca420749b8bdb324bdc843bc50'
     or to_regclass('identity.patients') is null
     or to_regclass('lab.work_items') is null
     or to_regclass('pharmacy.work_items') is null then
    raise exception using errcode = '55000', message = '0121: 0001-0103 must be applied first';
  end if;
  -- b. Not applied yet.
  if exists (select 1 from pg_proc proc
              where proc.proname = 'work_item_patient_cards'
                and proc.pronamespace in ('lab'::regnamespace, 'pharmacy'::regnamespace)) then
    raise exception using errcode = '55000', message = '0121: already applied';
  end if;
  -- c. The bodies relied on, as 0001-0104 left them: the consent test
  -- (0012, as 0104 replaced it; 0108 kept it) and the membership (0008) and
  -- permission (0010) checks, the four session readers (0001), both work
  -- items' read-policy functions (0086 H8) and their route branch (0086 H7).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('lab.work_item_allows(uuid,uuid,uuid,text)', 'b710e0c6b66ce87c8c4a059ad435b774'),
      ('pharmacy.work_item_allows(uuid,uuid,uuid,text)', 'b710e0c6b66ce87c8c4a059ad435b774'),
      ('ehr.order_route_allows(uuid,uuid,text)', 'b80c2df6c380f7c7e20d166da94e56d2'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- The two work_item_allows have the same text; their search_paths tell
  -- them apart. The three Identity and Auth checks are SECURITY DEFINER SQL.
  if mismatch is null then
    select string_agg(expected.proc, '; ') into mismatch
      from (values
        ('lab.work_item_allows(uuid,uuid,uuid,text)', '{"search_path=lab, identity, platform, pg_temp"}'),
        ('pharmacy.work_item_allows(uuid,uuid,uuid,text)', '{"search_path=pharmacy, identity, platform, pg_temp"}'),
        ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)',
         '{"search_path=identity, auth, pg_temp"}'),
        ('identity.has_active_membership(text,uuid,uuid)', '{"search_path=identity, auth, pg_temp"}'),
        ('auth.membership_has_permission(text,uuid,uuid,text)', '{"search_path=auth, identity, pg_temp"}'))
           expected(proc, config)
     where not exists (select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                        where proc.oid = to_regprocedure(expected.proc)
                          and language_row.lanname = 'sql' and proc.prosecdef and proc.provolatile = 's'
                          and not proc.proisstrict and proc.prorettype = 'boolean'::regtype
                          and proc.proconfig = expected.config::text[]);
    if mismatch is not null then mismatch := 'attributes of ' || mismatch; end if;
  end if;
  -- The read policies a SELECT of the work items applies (0086), and only
  -- those; the own-row CHECK (0086); row-level security forced on both.
  if mismatch is null
     and ((select count(*) from pg_policy policy_row
            where policy_row.polpermissive and policy_row.polroles = '{0}'::oid[] and policy_row.polcmd = 'r'
              and ((policy_row.polrelid = 'lab.work_items'::regclass and policy_row.polname = 'lab_work_items_read'
                    and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                      = 'lab.work_item_allows(patient_id, facility_id, order_route_id, ''read_records''::text)')
                or (policy_row.polrelid = 'pharmacy.work_items'::regclass
                    and policy_row.polname = 'pharmacy_work_items_read'
                    and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                      = 'pharmacy.work_item_allows(patient_id, facility_id, order_route_id, ''read_records''::text)')))
          <> 2
       or exists (select 1 from pg_policy policy_row
                   where policy_row.polrelid in ('lab.work_items'::regclass, 'pharmacy.work_items'::regclass)
                     and policy_row.polcmd in ('r', '*')
                     and (policy_row.polrelid, policy_row.polname) not in
                           (('lab.work_items'::regclass, 'lab_work_items_read'::name),
                            ('pharmacy.work_items'::regclass, 'pharmacy_work_items_read'::name)))) then
    mismatch := 'the lab.work_items and pharmacy.work_items read policies';
  end if;
  if mismatch is null
     and (select count(*) from pg_constraint constraint_row
           where constraint_row.conrelid in ('lab.work_items'::regclass, 'pharmacy.work_items'::regclass)
             and constraint_row.contype = 'c' and constraint_row.convalidated
             and constraint_row.conname = 'work_items_route_facility_ck'
             and pg_get_constraintdef(constraint_row.oid) =
               'CHECK ((((order_route_id IS NULL) AND (facility_id = ordering_facility_id)) OR '
               || '((order_route_id IS NOT NULL) AND (facility_id <> ordering_facility_id))))') <> 2 then
    mismatch := 'the CHECK work_items_route_facility_ck of lab.work_items and pharmacy.work_items';
  end if;
  if mismatch is null
     and (select count(*) from pg_class relation
           where (relation.oid in ('lab.work_items'::regclass, 'pharmacy.work_items'::regclass)
                  and relation.relrowsecurity and relation.relforcerowsecurity)
              or (relation.oid = 'identity.patients'::regclass
                  and relation.relrowsecurity and not relation.relforcerowsecurity)) <> 3 then
    mismatch := 'row-level security on lab.work_items, pharmacy.work_items (on, forced) or identity.patients (on, not forced)';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0121: an object this migration relies on differs from 0001-0104: %s', mismatch);
  end if;
  -- d. The columns read.
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('identity.patients', 'id', 'uuid', true),
      ('identity.patients', 'full_name', 'text', true),
      ('identity.patients', 'gender', 'text', false),
      ('identity.patients', 'dob', 'date', false),
      ('identity.patients', 'hid_code', 'text', true),
      ('lab.work_items', 'id', 'uuid', true),
      ('lab.work_items', 'patient_id', 'uuid', true),
      ('lab.work_items', 'facility_id', 'uuid', true),
      ('lab.work_items', 'order_route_id', 'uuid', false),
      ('pharmacy.work_items', 'id', 'uuid', true),
      ('pharmacy.work_items', 'patient_id', 'uuid', true),
      ('pharmacy.work_items', 'facility_id', 'uuid', true),
      ('pharmacy.work_items', 'order_route_id', 'uuid', false))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = expected.relation_name::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0121: a column this migration relies on differs from 0001-0103: %s', mismatch);
  end if;
  -- e. Ownership and privileges, never through a superuser's bypass
  -- (production's migrator has none). The new functions will belong to
  -- identity.patients' owner.
  patients_owner := (select relation.relowner from pg_class relation where relation.oid = 'identity.patients'::regclass);
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not %s and may not act as it (INHERIT and SET)', current_user, pg_get_userbyid(patients_owner))
             as what
       where applier <> patients_owner
         and not (pg_has_role(applier, patients_owner, 'USAGE') and pg_has_role(applier, patients_owner, 'SET'))
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(wanted.holder), wanted.privilege, namespace.nspname)
        from (values (applier, 'lab', 'CREATE'), (applier, 'pharmacy', 'CREATE'),
                     (patients_owner, 'lab', 'CREATE'), (patients_owner, 'pharmacy', 'CREATE'),
                     (patients_owner, 'lab', 'USAGE'), (patients_owner, 'pharmacy', 'USAGE'),
                     (patients_owner, 'identity', 'USAGE'), (patients_owner, 'auth', 'USAGE'),
                     (patients_owner, 'platform', 'USAGE')) wanted(holder, schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.work_item_patient_cards_0121_holds(wanted.holder, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks SELECT on %s', pg_get_userbyid(patients_owner), relation.oid::regclass)
        from pg_class relation
       where relation.oid in ('identity.patients'::regclass, 'lab.work_items'::regclass, 'pharmacy.work_items'::regclass)
         and not pg_temp.work_item_patient_cards_0121_holds(patients_owner, relation.relowner, relation.relacl, 'r',
               'SELECT')
      union all
      select format('%s lacks EXECUTE on %s', pg_get_userbyid(patients_owner), proc.oid::regprocedure)
        from (values ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'),
                     ('auth.membership_has_permission(text,uuid,uuid,text)'),
                     ('platform.current_actor_subject()'), ('platform.current_facility_id()'),
                     ('platform.current_membership_id()'), ('platform.current_purpose_of_use()'),
                     ('lab.work_item_allows(uuid,uuid,uuid,text)'),
                     ('pharmacy.work_item_allows(uuid,uuid,uuid,text)')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
       where not pg_temp.work_item_patient_cards_0121_holds(patients_owner, proc.proowner, proc.proacl, 'f',
               'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0121: missing privileges: %s', mismatch);
  end if;
  raise notice '0121: owners checked: identity.patients=%, lab.work_items=%, pharmacy.work_items=%, applier=%',
    pg_get_userbyid(patients_owner),
    (select pg_get_userbyid(relation.relowner) from pg_class relation where relation.oid = 'lab.work_items'::regclass),
    (select pg_get_userbyid(relation.relowner) from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass),
    current_user;
end
$$;

-- 1. The functions (D1-D5).
create function lab.work_item_patient_cards(requested_work_item_ids uuid[])
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
       and identity.has_active_consent_grant(item.patient_id, platform.current_actor_subject(),
             platform.current_membership_id(), item.facility_id, 'read_records', platform.current_purpose_of_use())
     order by item.id;
end;
$$;

comment on function lab.work_item_patient_cards(uuid[]) is
  'The patient (name, sex, date of birth, last 4 of the Health ID) of each given work item that is this facility''s own work (no order route) and that the session''s member may read: lab.work-item.read here and the read consent test of the work items'' read policy (emergency included). At most 200 ids.';

create function pharmacy.work_item_patient_cards(requested_work_item_ids uuid[])
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
       and identity.has_active_consent_grant(item.patient_id, platform.current_actor_subject(),
             platform.current_membership_id(), item.facility_id, 'read_records', platform.current_purpose_of_use())
     order by item.id;
end;
$$;

comment on function pharmacy.work_item_patient_cards(uuid[]) is
  'The patient (name, sex, date of birth, last 4 of the Health ID) of each given work item that is this facility''s own work (no order route) and that the session''s member may read: pharmacy.work-item.read here and the read consent test of the work items'' read policy (emergency included). At most 200 ids.';

-- identity.patients' owner owns both (a no-op when the applier is that owner,
-- as on every database built by one migration login).
do $$
declare
  patients_owner oid := (select relation.relowner from pg_class relation
                          where relation.oid = 'identity.patients'::regclass);
  function_name text;
begin
  foreach function_name in array array['lab.work_item_patient_cards(uuid[])', 'pharmacy.work_item_patient_cards(uuid[])']
  loop
    if (select proc.proowner from pg_proc proc where proc.oid = function_name::regprocedure) <> patients_owner then
      execute format('alter function %s owner to %I', function_name::regprocedure, pg_get_userbyid(patients_owner));
    end if;
  end loop;
end
$$;

-- 2. Grants (here and in runtime-grants.sql).
revoke all on function lab.work_item_patient_cards(uuid[]), pharmacy.work_item_patient_cards(uuid[]) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_lab_runtime') then
    grant execute on function lab.work_item_patient_cards(uuid[]) to hid_lab_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_pharmacy_runtime') then
    grant execute on function pharmacy.work_item_patient_cards(uuid[]) to hid_pharmacy_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function lab.work_item_patient_cards(uuid[]), pharmacy.work_item_patient_cards(uuid[])
      to hid_schema_test_runtime;
  end if;
end
$$;

-- 3. Post-checks (after the grants, so the ACL is the final one).
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: md5=%s owner=%s definer=%s volatile=%s language=%s strict=%s config=%s result=%s '
           || 'arguments=%s columns=%s', proc.oid::regprocedure, md5(proc.prosrc), pg_get_userbyid(proc.proowner),
           proc.prosecdef, proc.provolatile, language_row.lanname, proc.proisstrict, proc.proconfig,
           proc.prorettype::regtype, proc.proargtypes::regtype[], proc.proallargtypes::regtype[]), '; ')
    into mismatch
    from (values ('lab.work_item_patient_cards(uuid[])', '69b1836bb8d9493bdc0d6d7cc5e96515'),
                 ('pharmacy.work_item_patient_cards(uuid[])', '5a944e144033d04f86771a33ef41247b')) expected(proc_name, digest)
    join pg_proc proc on proc.oid = expected.proc_name::regprocedure
    join pg_language language_row on language_row.oid = proc.prolang
   where md5(proc.prosrc) <> expected.digest
      or proc.proowner <> (select relation.relowner from pg_class relation where relation.oid = 'identity.patients'::regclass)
      or not proc.prosecdef or proc.provolatile <> 's' or language_row.lanname <> 'plpgsql' or proc.proisstrict
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]
      or proc.prorettype <> 'record'::regtype or not proc.proretset or proc.pronargs <> 1
      or proc.proargtypes[0] <> 'uuid[]'::regtype
      or proc.proallargtypes is distinct from array['uuid[]', 'uuid', 'text', 'text', 'date', 'text']::regtype[]::oid[]
      or proc.proargmodes is distinct from '{i,t,t,t,t,t}'::"char"[]
      or proc.proargnames is distinct from array['requested_work_item_ids', 'work_item_id', 'patient_full_name',
           'patient_sex', 'patient_date_of_birth', 'patient_health_id_last4'];
  if mismatch is not null
     or (select count(*) from pg_proc proc
          where proc.proname = 'work_item_patient_cards'
            and proc.pronamespace in ('lab'::regnamespace, 'pharmacy'::regnamespace)) <> 2 then
    raise exception using errcode = '55000',
      message = format('0121: the functions are not as this file makes them: %s', coalesce(mismatch, 'count'));
  end if;
  select string_agg(granted.what, '; ') into mismatch
    from (
      select format('%s: %s %s', proc.oid::regprocedure,
               case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end, acl.privilege_type)
             as what
        from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where proc.oid in ('lab.work_item_patient_cards(uuid[])'::regprocedure,
                          'pharmacy.work_item_patient_cards(uuid[])'::regprocedure)
         and acl.grantee <> proc.proowner
         and (acl.grantee = 0 or acl.privilege_type <> 'EXECUTE'
           or pg_get_userbyid(acl.grantee) not in ('hid_schema_test_runtime',
                case when proc.pronamespace = 'lab'::regnamespace then 'hid_lab_runtime' else 'hid_pharmacy_runtime' end))
      union all
      select format('%s: missing %s EXECUTE', expected.proc_name, role_row.rolname)
        from (values ('lab.work_item_patient_cards(uuid[])', 'hid_lab_runtime'),
                     ('lab.work_item_patient_cards(uuid[])', 'hid_schema_test_runtime'),
                     ('pharmacy.work_item_patient_cards(uuid[])', 'hid_pharmacy_runtime'),
                     ('pharmacy.work_item_patient_cards(uuid[])', 'hid_schema_test_runtime')) expected(proc_name, role_name)
        join pg_roles role_row on role_row.rolname = expected.role_name
       where not exists (select 1 from pg_proc proc, aclexplode(proc.proacl) acl
                          where proc.oid = expected.proc_name::regprocedure
                            and acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')) granted;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0121: the functions'' ACLs are not section 2''s: %s', mismatch);
  end if;
end
$$;
